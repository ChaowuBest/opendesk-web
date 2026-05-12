/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import { BaseTool } from '../../../aikernel/tool';
import { ToolCall } from '../../../aikernel/messages';
import { Card } from '../../../tui/components/card';
import { statusDisplay, truncText } from '../../../tui/components/toolcall';
import { renderSearchToolCall, extractResultCount } from './render';
import { t } from '../../../../locale/index.js';
import chalk from 'chalk';
import { z } from 'zod';
import { fetch } from 'undici';
import { parseHTML } from 'linkedom';

const FETCH_TIMEOUT_MS = 30000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_RESULT_COUNT = 15;

const BING_SEARCH_URL = 'https://www.bing.com/search';

const BING_HEADERS: Record<string, string> = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    Connection: 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24", "Microsoft Edge";v="131"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Cache-Control': 'max-age=0'
};

interface BingSearchResult {
    title: string;
    url: string;
    snippet: string;
}

const BingSearchArgsSchema = z.object({
    query: z.string().describe('搜索关键词'),
    lang: z
        .enum(['zh', 'en'])
        .optional()
        .describe('搜索语言：(zh=中文，en=英文)，默认为zh。如果指定为en则使用Bing全球版，搜索结果将以英文为主'),
    count: z.number().optional().describe('期望返回的搜索结果数量，默认为15')
});

export class BingSearchTool extends BaseTool<typeof BingSearchArgsSchema> {
    constructor() {
        super(
            'bingSearch',
            '使用Bing搜索引擎搜索网页信息，返回搜索结果的标题、URL和摘要。无需API密钥，适合作为后备搜索方案',
            BingSearchArgsSchema
        );

        this.setExecutor(this.search.bind(this));
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const query = toolcall.args_object?.['query'] as string | undefined;
        return renderSearchToolCall({
            icon: 'fas fa-magnifying-glass',
            title: t('search.bing.name'),
            toolcall,
            query,
            resultCountExtractor: extractResultCount
        });
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const query = toolcall.args_object?.['query'];
        const body: string[] = [];

        if (query) {
            body.push(chalk.dim('关键词: ') + chalk.cyan(`"${truncText(String(query), width - 16)}"`));
        }

        if (toolcall.status === 'running') {
            body.push(chalk.dim('  ⏳ 搜索中…'));
        } else if (toolcall.status === 'success' && toolcall.result) {
            const match = toolcall.result.match(/\*\*结果数量\*\*:\s*(\d+)/);
            if (match) {
                body.push(chalk.dim('  找到 ') + chalk.white(match[1]) + chalk.dim(' 条结果'));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(toolcall.result, width - 10)));
        }

        let title = '搜索 (Bing)';
        if (toolcall.args_object?.['lang'] === 'en') {
            title = '搜索 (Bing 全球版)';
        }
        return new Card({
            icon: '🔍',
            title: title,
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    // ───────────────────── 主入口 ─────────────────────

    private async search(args: z.output<typeof BingSearchArgsSchema>): Promise<string> {
        const { query, count } = args;
        const maxResults = count ?? DEFAULT_RESULT_COUNT;

        if (!query || query.trim().length === 0) {
            throw new Error('搜索关键词不能为空');
        }

        const html = await this.fetchBingPage(query, args.lang ?? 'zh');
        const results = this.parseSearchResults(html, maxResults);

        if (results.length === 0) {
            const challengeDetected = this.isChallengeOrError(html);
            if (challengeDetected) {
                throw new Error('Bing 返回了验证页面，无法获取搜索结果。这可能是由于请求频率过高导致的，请稍后重试。');
            }
            return `未找到与 "${query}" 相关的搜索结果。`;
        }

        return this.formatResults(query, results);
    }

    // ───────────────────── HTTP 请求 ─────────────────────

    private async fetchBingPage(query: string, lang: 'zh' | 'en' = 'zh'): Promise<string> {
        const url = new URL(BING_SEARCH_URL);
        url.searchParams.set('q', query);

        /**
         * ensearch = 0 -- 国内版
         * ensearch = 1 -- 国际版
         */
        url.searchParams.set('ensearch', lang === 'en' ? '1' : '0');

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        try {
            const response = await fetch(url.toString(), {
                method: 'GET',
                redirect: 'follow',
                headers: BING_HEADERS,
                signal: controller.signal
            });

            if (!response.ok) {
                throw new Error(`Bing 请求失败，HTTP 状态码: ${response.status}`);
            }

            return await this.readResponseBody(response);
        } catch (err: any) {
            if (err.name === 'AbortError') {
                throw new Error(`Bing 搜索请求超时 (${FETCH_TIMEOUT_MS / 1000}秒)`);
            }
            throw err;
        } finally {
            clearTimeout(timer);
        }
    }

    private async readResponseBody(response: Awaited<ReturnType<typeof fetch>>): Promise<string> {
        const reader = response.body?.getReader();
        if (!reader) return '';

        const decoder = new TextDecoder('utf-8', { fatal: false });
        let result = '';
        let totalBytes = 0;

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                totalBytes += value.byteLength;
                if (totalBytes > MAX_RESPONSE_BYTES) {
                    const remaining = MAX_RESPONSE_BYTES - (totalBytes - value.byteLength);
                    if (remaining > 0) {
                        result += decoder.decode(value.slice(0, remaining), { stream: false });
                    }
                    break;
                }
                result += decoder.decode(value, { stream: true });
            }
        } finally {
            reader.releaseLock();
        }

        return result;
    }

    // ───────────────────── HTML 解析 ─────────────────────

    private parseSearchResults(html: string, maxResults: number): BingSearchResult[] {
        const { document } = parseHTML(html);
        const results: BingSearchResult[] = [];

        const items = document.querySelectorAll('li.b_algo');
        for (const item of items) {
            if (results.length >= maxResults) break;

            const result = this.extractResultFromElement(item);
            if (result) {
                results.push(result);
            }
        }

        return results;
    }

    private extractResultFromElement(element: any): BingSearchResult | null {
        const h2 = element.querySelector('h2');
        const linkEl = h2?.querySelector('a');

        if (!linkEl) return null;

        const url = linkEl.getAttribute('href') ?? '';
        if (!url || url.startsWith('javascript:') || url === '#') return null;

        const title = (h2?.textContent ?? '').trim();
        if (!title) return null;

        const snippet = this.extractSnippet(element);

        return { title, url, snippet };
    }

    /**
     * 尝试从多个可能的选择器中提取摘要文本。
     * Bing 的 HTML 结构可能随时间变化，因此按优先级尝试多个选择器。
     */
    private extractSnippet(element: any): string {
        const selectors = ['p.b_lineclamp2', 'p.b_lineclamp3', 'p.b_lineclamp4', '.b_caption p', '.b_algoSlug', 'p'];

        for (const selector of selectors) {
            const el = element.querySelector(selector);
            if (el) {
                const text = (el.textContent ?? '').trim();
                if (text.length > 0) return text;
            }
        }

        return '';
    }

    // ───────────────────── 验证检测 ─────────────────────

    private isChallengeOrError(html: string): boolean {
        const lower = html.toLowerCase();
        const indicators = [
            'captcha',
            'are you a robot',
            'verify you are human',
            'unusual traffic',
            'automated requests',
            'blocked',
            'sorry, we need to make sure',
            'type the characters you see'
        ];
        return indicators.some((s) => lower.includes(s));
    }

    // ───────────────────── 结果格式化 ─────────────────────

    private formatResults(query: string, results: BingSearchResult[]): string {
        let output = `## Bing 搜索结果\n`;
        output += `**搜索词**: ${query}\n`;
        output += `**结果数量**: ${results.length}\n\n`;

        for (const item of results) {
            output += `- 搜索结果： ${item.title}\n`;
            output += `  - url: ${item.url}\n`;
            if (item.snippet) {
                output += `  - 摘要: <summary>${item.snippet}</summary>\n`;
            }
        }

        return output;
    }
}
