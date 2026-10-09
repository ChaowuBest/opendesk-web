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
import { getPlatform } from '../../../../platforms/base.js';
import { parseHTML } from 'linkedom';

const FETCH_TIMEOUT_MS = 30000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_RESULT_COUNT = 15;

const DUCKDUCKGO_HTML_URL = 'https://html.duckduckgo.com/html/';

const DUCKDUCKGO_HEADERS: Record<string, string> = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
    Connection: 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Cache-Control': 'max-age=0'
};

interface DuckDuckGoSearchResult {
    title: string;
    url: string;
    snippet: string;
}

const DuckDuckGoSearchArgsSchema = z.object({
    query: z.string().describe('搜索关键词'),
    region: z
        .enum(['cn-zh', 'us-en', 'uk-en', 'de-de', 'fr-fr', 'jp-jp'])
        .optional()
        .describe(
            '搜索区域/语言，默认为us-en。可选值：cn-zh(中国中文)、us-en(美国英文)、uk-en(英国英文)、de-de(德国德文)、fr-fr(法国法文)、jp-jp(日本日文)'
        ),
    count: z.number().optional().describe('期望返回的搜索结果数量，默认为15')
});

export class DuckDuckGoSearchTool extends BaseTool<typeof DuckDuckGoSearchArgsSchema> {
    constructor() {
        super(
            'duckduckgoSearch',
            '使用DuckDuckGo搜索引擎搜索网页信息，返回搜索结果的标题、URL和摘要。无需API密钥，注重隐私保护，适合作为后备搜索方案',
            DuckDuckGoSearchArgsSchema,
            undefined,
            { 'zh-CN': '搜索 (DuckDuckGo)', 'en-US': 'Search (DuckDuckGo)' }
        );

        this.setExecutor(this.search.bind(this));
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const query = toolcall.args_object?.['query'] as string | undefined;
        return renderSearchToolCall({
            icon: 'fas fa-magnifying-glass',
            title: t('search.duckduckgo.name'),
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

        const region = toolcall.args_object?.['region'];
        if (region && region !== 'us-en') {
            body.push(chalk.dim('区域: ') + chalk.yellow(String(region)));
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

        return new Card({
            icon: '🔍',
            title: '搜索 (DuckDuckGo)',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    // ───────────────────── 主入口 ─────────────────────

    private async search(args: z.output<typeof DuckDuckGoSearchArgsSchema>): Promise<string> {
        const { query, count, region } = args;
        const maxResults = count ?? DEFAULT_RESULT_COUNT;

        if (!query || query.trim().length === 0) {
            throw new Error('搜索关键词不能为空');
        }

        const html = await this.fetchDuckDuckGoPage(query, region ?? 'us-en');
        const results = this.parseSearchResults(html, maxResults);

        if (results.length === 0) {
            const challengeDetected = this.isChallengeOrError(html);
            if (challengeDetected) {
                throw new Error(
                    'DuckDuckGo 返回了验证页面，无法获取搜索结果。这可能是由于请求频率过高导致的，请稍后重试。'
                );
            }
            return `未找到与 "${query}" 相关的搜索结果。`;
        }

        return this.formatResults(query, results);
    }

    // ───────────────────── HTTP 请求 ─────────────────────

    private async fetchDuckDuckGoPage(query: string, region: string): Promise<string> {
        // DuckDuckGo HTML 版本的搜索参数
        // q: 搜索词
        // kl: 区域/语言设置 (如 us-en, cn-zh 等)
        const params = new URLSearchParams();
        params.set('q', query);
        params.set('kl', region);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        try {
            const fetchOptions: {
                method: string;
                headers: Record<string, string>;
                signal: AbortSignal;
            } = {
                method: 'GET',
                headers: DUCKDUCKGO_HEADERS,
                signal: controller.signal
            };

            const response = await getPlatform().fetch(`${DUCKDUCKGO_HTML_URL}?${params.toString()}`, fetchOptions);

            if (!response.ok) {
                throw new Error(`DuckDuckGo 请求失败，HTTP 状态码: ${response.status}`);
            }

            return await this.readResponseBody(response);
        } catch (err: any) {
            if (err.name === 'AbortError') {
                throw new Error(`DuckDuckGo 搜索请求超时 (${FETCH_TIMEOUT_MS / 1000}秒)`);
            }
            throw err;
        } finally {
            clearTimeout(timer);
        }
    }

    private async readResponseBody(response: Response): Promise<string> {
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

    private parseSearchResults(html: string, maxResults: number): DuckDuckGoSearchResult[] {
        const { document } = parseHTML(html);
        const results: DuckDuckGoSearchResult[] = [];

        // DuckDuckGo HTML 版本的结果在 class="result" 的 div 中
        // 每个结果包含在 class="result__body" 中
        const items = document.querySelectorAll('.result');
        for (const item of items) {
            if (results.length >= maxResults) break;

            const result = this.extractResultFromElement(item);
            if (result) {
                results.push(result);
            }
        }

        return results;
    }

    private extractResultFromElement(element: any): DuckDuckGoSearchResult | null {
        // 标题和链接在 class="result__a" 的 a 标签中
        const linkEl = element.querySelector('.result__a');
        if (!linkEl) return null;

        const url = linkEl.getAttribute('href') ?? '';
        if (!url || url.startsWith('javascript:') || url === '#') return null;

        // DuckDuckGo 使用重定向 URL (uddg 参数包含真实 URL)
        const realUrl = this.extractRealUrl(url);

        const title = (linkEl.textContent ?? '').trim();
        if (!title) return null;

        // 摘要在 class="result__snippet" 的 a 标签中
        const snippetEl = element.querySelector('.result__snippet');
        const snippet = snippetEl ? (snippetEl.textContent ?? '').trim() : '';

        return { title, url: realUrl, snippet };
    }

    /**
     * 从 DuckDuckGo 重定向 URL 中提取真实的 URL
     * DuckDuckGo 的链接格式类似: //duckduckgo.com/l/?uddg=真实URL&rut=...
     */
    private extractRealUrl(redirectUrl: string): string {
        try {
            // 处理相对协议 URL
            let url = redirectUrl;
            if (url.startsWith('//')) {
                url = 'https:' + url;
            }

            // 解析重定向 URL 中的 uddg 参数
            const urlObj = new URL(url);
            const uddg = urlObj.searchParams.get('uddg');
            if (uddg) {
                return decodeURIComponent(uddg);
            }

            // 如果不是重定向 URL，直接返回原始 URL
            return redirectUrl;
        } catch {
            return redirectUrl;
        }
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
            'type the characters you see',
            'rate limited',
            'too many requests'
        ];
        return indicators.some((s) => lower.includes(s));
    }

    // ───────────────────── 结果格式化 ─────────────────────

    private formatResults(query: string, results: DuckDuckGoSearchResult[]): string {
        let output = `## DuckDuckGo 搜索结果\n`;
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
