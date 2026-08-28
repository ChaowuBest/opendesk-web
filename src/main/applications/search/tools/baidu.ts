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

import { SearchPresentationTool } from './presentation.js';
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

const BAIDU_SEARCH_URL = 'https://www.baidu.com/s';

const BAIDU_HEADERS_DESKTOP: Record<string, string> = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
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

/** 移动端 UA，用于桌面版被反爬封锁时的降级方案 */
const BAIDU_HEADERS_MOBILE: Record<string, string> = {
    'User-Agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9'
};

interface BaiduSearchResult {
    title: string;
    url: string;
    snippet: string;
}

const BaiduSearchArgsSchema = z.object({
    query: z.string().describe('搜索关键词'),
    count: z.number().optional().describe('期望返回的搜索结果数量，默认为15')
});

export class BaiduSearchTool extends SearchPresentationTool<typeof BaiduSearchArgsSchema> {
    constructor() {
        super(
            'baiduSearch',
            '使用百度搜索引擎搜索网页信息，返回搜索结果的标题、URL和摘要。无需API密钥，自动过滤广告结果',
            BaiduSearchArgsSchema
        );
        this.setExecutor(this.search.bind(this));
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const query = toolcall.args_object?.['query'] as string | undefined;
        return renderSearchToolCall({
            icon: 'fas fa-magnifying-glass',
            title: t('search.baidu.name'),
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

        return new Card({
            icon: '🔍',
            title: '搜索 (百度)',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    // ───────────────────── 主入口 ─────────────────────

    private async search(args: z.output<typeof BaiduSearchArgsSchema>): Promise<string> {
        const { query, count } = args;
        const maxResults = count ?? DEFAULT_RESULT_COUNT;

        if (!query || query.trim().length === 0) {
            throw new Error('搜索关键词不能为空');
        }

        const { html, isMobile } = await this.fetchBaiduPage(query);
        const results = this.parseSearchResults(html, maxResults, isMobile);

        if (results.length === 0) {
            return `未找到与 "${query}" 相关的搜索结果。`;
        }

        return this.formatResults(query, results);
    }

    // ───────────────────── HTTP 请求 ─────────────────────

    private async fetchBaiduPage(query: string): Promise<{ html: string; isMobile: boolean }> {
        const url = new URL(BAIDU_SEARCH_URL);
        url.searchParams.set('wd', query);
        url.searchParams.set('rn', String(DEFAULT_RESULT_COUNT));
        url.searchParams.set('ie', 'utf-8');

        // 策略1：桌面版 UA，结果质量最好（含真实 URL、可过滤广告）
        try {
            const html = await this.doFetch(url.toString(), BAIDU_HEADERS_DESKTOP);
            if (!this.isChallengeOrError(html)) {
                return { html, isMobile: false };
            }
        } catch {
            // 桌面版请求失败，尝试移动版
        }

        // 策略2：移动版 UA，作为反爬封锁时的降级方案
        const html = await this.doFetch(url.toString(), BAIDU_HEADERS_MOBILE);
        if (this.isChallengeOrError(html)) {
            throw new Error(
                '百度返回了安全验证页面，无法获取搜索结果。这可能是由于请求频率过高或网络环境导致，请稍后重试。'
            );
        }
        return { html, isMobile: true };
    }

    private async doFetch(url: string, headers: Record<string, string>): Promise<string> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        try {
            const response = await getPlatform().fetch(url, {
                method: 'GET',
                redirect: 'follow',
                headers,
                signal: controller.signal
            });

            if (!response.ok) {
                throw new Error(`百度请求失败，HTTP 状态码: ${response.status}`);
            }

            return await this.readResponseBody(response);
        } catch (err: any) {
            if (err.name === 'AbortError') {
                throw new Error(`百度搜索请求超时 (${FETCH_TIMEOUT_MS / 1000}秒)`);
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

    private parseSearchResults(html: string, maxResults: number, isMobile: boolean): BaiduSearchResult[] {
        if (isMobile) {
            return this.parseMobileResults(html, maxResults);
        }
        return this.parseDesktopResults(html, maxResults);
    }

    /**
     * 解析桌面版百度搜索结果（div.c-container）
     */
    private parseDesktopResults(html: string, maxResults: number): BaiduSearchResult[] {
        const { document } = parseHTML(html);
        const results: BaiduSearchResult[] = [];

        let items = document.querySelectorAll('div.c-container');
        if (items.length === 0) {
            items = document.querySelectorAll('div.result.c-container');
        }
        if (items.length === 0) {
            items = document.querySelectorAll('div[class*="c-container"]');
        }

        for (const item of items) {
            if (results.length >= maxResults) break;
            if (this.isAdResult(item)) continue;

            const result = this.extractDesktopResult(item);
            if (result) results.push(result);
        }

        return results;
    }

    /**
     * 解析移动版百度搜索结果（div.c-result > article）
     */
    private parseMobileResults(html: string, maxResults: number): BaiduSearchResult[] {
        const { document } = parseHTML(html);
        const results: BaiduSearchResult[] = [];

        // 移动版结果在 article 元素中
        const articles = document.querySelectorAll('article');
        for (const art of articles) {
            if (results.length >= maxResults) break;

            // 跳过商品/品牌推荐等特殊卡片
            const text = (art.textContent || '') as string;
            if (text.includes('商品排行') || text.includes('品牌排行') || text.includes('商品推荐')) {
                continue;
            }

            const h3 = art.querySelector('h3');
            const linkEl = h3 ? h3.querySelector('a') : art.querySelector('a');
            if (!linkEl) continue;

            const title = ((h3?.textContent ?? linkEl.textContent ?? '') as string).trim();
            if (!title || title.length < 5) continue;

            const url = (linkEl.getAttribute('href') ?? '') as string;
            if (!url || url.startsWith('javascript:')) continue;

            // 移动版摘要：查找 p 标签
            let snippet = '';
            const paras = art.querySelectorAll('p');
            for (const p of paras) {
                if (h3 && h3.contains(p)) continue;
                const t = ((p.textContent ?? '') as string).trim();
                if (t.length > 15 && t.length < 400) {
                    snippet = t;
                    break;
                }
            }

            results.push({ title, url, snippet });
        }

        return results;
    }

    /**
     * 判断结果是否为广告/推广
     */
    private isAdResult(element: any): boolean {
        const html = (element.innerHTML || '') as string;

        // 检查包含推广标记的类名
        const adClassIndicators = ['ec-tuiguang', 'ecfc-tuiguang', 'c-tips-title', 'result-tuiguang', 'ec_wise_ad'];
        for (const indicator of adClassIndicators) {
            if (html.includes(indicator)) return true;
        }

        // 检查文本中的"广告"/"推广"标记
        const adTags = element.querySelectorAll('span');
        for (const span of adTags) {
            const text = ((span.textContent ?? '') as string).trim();
            if (text === '广告' || text === '推广' || text === '商业推广') return true;
        }

        // 检查链接中的百度广告追踪参数
        const links = element.querySelectorAll('a');
        for (const a of links) {
            const href = (a.getAttribute('href') ?? '') as string;
            if (href.includes('e_cc') || href.includes('e_swhat')) return true;
        }

        return false;
    }

    private extractDesktopResult(element: any): BaiduSearchResult | null {
        // 标题在 h3 标签内的链接中
        const h3 = element.querySelector('h3');
        const linkEl = h3?.querySelector('a');

        if (!linkEl) return null;

        // 优先使用 data-landurl（真实 URL），回退到 href
        const url = (linkEl.getAttribute('data-landurl') ?? linkEl.getAttribute('href') ?? '') as string;
        if (!url || url.startsWith('javascript:') || url === '#') return null;

        const title = ((h3?.textContent ?? '') as string).trim();
        if (!title) return null;

        const snippet = this.extractSnippet(element, h3);

        return { title, url, snippet };
    }

    /**
     * 从结果容器中提取摘要文本。
     * 查找容器内（排除标题 h3 区域）最长的文本 span。
     */
    private extractSnippet(element: any, h3: any): string {
        const spans = element.querySelectorAll('span');
        let best = '';

        for (const span of spans) {
            // 跳过标题区域内的 span
            if (h3 && h3.contains(span)) continue;
            const text = ((span.textContent ?? '') as string).trim();
            // 选择最长的有意义文本（20-500 字符）
            if (text.length > 20 && text.length > best.length && text.length < 500) {
                best = text;
            }
        }

        return best;
    }

    // ───────────────────── 验证检测 ─────────────────────

    private isChallengeOrError(html: string): boolean {
        const lower = html.toLowerCase();
        const indicators = [
            '百度安全验证',
            '请输入验证码',
            '安全验证',
            '访问验证',
            '异常流量',
            'captcha',
            '网络不给力，请稍后重试',
            '您的行为被检测为异常'
        ];
        return indicators.some((s) => lower.includes(s));
    }

    // ───────────────────── 结果格式化 ─────────────────────

    private formatResults(query: string, results: BaiduSearchResult[]): string {
        let output = `## 百度搜索结果\n`;
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
