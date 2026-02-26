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
import chalk from 'chalk';
import { z } from 'zod';
import { fetch } from 'undici';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 50000;
const FETCH_TIMEOUT_MS = 30000;
const MIN_CONTENT_LENGTH = 500;
const MIN_EXTRACTION_RATIO = 0.01;

/**
 * 域名黑名单：匹配到的域名将直接拒绝抓取，避免在反爬严格的站点上浪费时间。
 * 匹配逻辑：URL 的 hostname 以列表中的某项结尾即命中（支持子域名）。
 */
const BLOCKED_DOMAINS: string[] = [
    'zhihu.com',
];

const DEFAULT_USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const BROWSER_HEADERS: Record<string, string> = {
    'User-Agent': DEFAULT_USER_AGENT,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Cache-Control': 'max-age=0',
};

const WebFetchArgsSchema = z.object({
    url: z.string().describe('要获取内容的网页URL地址'),
});

/**
 * 抓取结果
 */
interface FetchResult {
    content: string;
    strategy: string;
}

export class WebFetchTool extends BaseTool<typeof WebFetchArgsSchema> {
    private turndownService: TurndownService;

    constructor() {
        super(
            'webFetch',
            '从指定URL获取网页内容，并将其转换为结构化的Markdown格式返回。适用于阅读网页文章、文档、博客等场景',
            WebFetchArgsSchema,
        );

        this.turndownService = this.createTurndownService();
        this.setExecutor(this.fetchPage.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const url = toolcall.args_object?.['url'];
        const body: string[] = [];

        if (url) {
            body.push(chalk.underline.blueBright(truncText(String(url), width - 8)));
        }

        if (toolcall.status === 'running') {
            body.push(chalk.dim('  ⏳ 正在获取…'));
        } else if (toolcall.status === 'success' && toolcall.result) {
            const chars = toolcall.result.length;
            const strategyMatch = toolcall.result.match(/\*\*获取方式\*\*:\s*(.+)/);
            const strategy = strategyMatch ? strategyMatch[1].trim() : '';
            let info = chalk.dim('  获取到 ') + chalk.white(chars.toLocaleString()) + chalk.dim(' 字符');
            if (strategy) {
                info += chalk.dim(' · ') + chalk.dim(strategy);
            }
            body.push(info);
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(toolcall.result, width - 10)));
        }

        return new Card({ icon: '🌐', title: '网页获取', status: statusDisplay(toolcall.status), body }).render(width);
    }

    // ───────────────────── Turndown 配置 ─────────────────────

    private createTurndownService(): TurndownService {
        const service = new TurndownService({
            headingStyle: 'atx',
            codeBlockStyle: 'fenced',
            bulletListMarker: '-',
            strongDelimiter: '**',
            emDelimiter: '_',
        });

        service.remove(['script', 'style', 'noscript', 'iframe', 'object', 'embed']);
        service.keep(['table', 'thead', 'tbody', 'tr', 'th', 'td']);

        service.addRule('cleanImage', {
            filter: 'img',
            replacement: (_content, node) => {
                const el = node as unknown as HTMLImageElement;
                const alt = el.getAttribute('alt') || '';
                const src = el.getAttribute('src') || '';
                if (!src) return '';
                return `![${alt}](${src})`;
            },
        });

        service.addRule('cleanLink', {
            filter: 'a',
            replacement: (content, node) => {
                const el = node as unknown as HTMLAnchorElement;
                const href = el.getAttribute('href') || '';
                const trimmed = content.trim();
                if (!href || !trimmed) return trimmed;
                if (href.startsWith('javascript:') || href === '#') return trimmed;
                return `[${trimmed}](${href})`;
            },
        });

        return service;
    }

    // ───────────────────── 主入口 ─────────────────────

    private async fetchPage(args: z.output<typeof WebFetchArgsSchema>): Promise<string> {
        const { url } = args;

        let parsedUrl: URL;
        try {
            parsedUrl = new URL(url);
        } catch {
            throw new Error(`无效的URL: ${url}`);
        }

        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
            throw new Error(`不支持的协议: ${parsedUrl.protocol}，仅支持 http 和 https`);
        }

        const hostname = parsedUrl.hostname.toLowerCase();
        const blockedDomain = BLOCKED_DOMAINS.find(
            d => hostname === d || hostname.endsWith('.' + d),
        );
        if (blockedDomain) {
            throw new Error(
                `域名 ${blockedDomain} 在黑名单中，不支持对该网站进行抓取。` +
                '该网站具有严格的反爬虫策略，抓取将无法获取有效内容。' +
                '请尝试从其他来源获取相关信息。',
            );
        }

        // 策略1: 直接获取 + Readability 提取
        const directResult = await this.tryDirectFetch(url);
        if (directResult) {
            return this.formatOutput(url, directResult);
        }

        // 策略2: 通过 Jina Reader 获取（免费无需 Key 的在线解析服务，可处理 SPA 和部分反爬页面）
        const jinaResult = await this.tryJinaReader(url);
        if (jinaResult) {
            return this.formatOutput(url, jinaResult);
        }

        // 策略3: 回退到直接获取的 meta 标签信息
        const metaResult = await this.tryMetaExtraction(url);
        if (metaResult) {
            return this.formatOutput(url, metaResult);
        }

        throw new Error(
            `无法获取 ${url} 的有效内容。可能的原因：\n` +
            '1. 网站使用了反爬虫保护（如 Cloudflare JS 验证）\n' +
            '2. 页面内容完全由 JavaScript 动态渲染\n' +
            '3. 网站需要登录或特殊授权',
        );
    }

    // ───────────────────── 策略1: 直接获取 ─────────────────────

    private async tryDirectFetch(url: string): Promise<FetchResult | null> {
        try {
            const response = await this.doFetch(url, BROWSER_HEADERS);

            if (!response.ok) {
                return null;
            }

            const contentType = response.headers.get('content-type') || '';
            const body = await this.readResponseBody(response);

            if (!body || body.length < 50) {
                return null;
            }

            // 服务器直接返回了 Markdown
            if (contentType.includes('text/markdown')) {
                return { content: this.truncate(body), strategy: 'Markdown by server' };
            }

            // 非 HTML 的文本类型直接返回
            if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
                if (contentType.includes('text/') || contentType.includes('application/json') || contentType.includes('application/xml')) {
                    return { content: this.truncate(body), strategy: '文本内容' };
                }
                return null;
            }

            // 检测反爬虫挑战页面
            if (this.isAntiBot(body)) {
                return null;
            }

            // HTML → Readability → Markdown
            const markdown = this.htmlToMarkdown(body, url);
            if (!markdown || markdown.length < MIN_CONTENT_LENGTH) {
                return null;
            }

            // 检测 SPA 骨架：HTML 很大但提取出的内容极少（如 632KB HTML → 236字符 Markdown）
            const extractionRatio = markdown.length / body.length;
            if (extractionRatio < MIN_EXTRACTION_RATIO && body.length > 10000) {
                return null;
            }

            return { content: markdown, strategy: '直接获取' };
        } catch {
            return null;
        }
    }

    // ───────────────────── 策略2: Jina Reader ─────────────────────

    private async tryJinaReader(url: string): Promise<FetchResult | null> {
        try {
            const jinaUrl = `https://r.jina.ai/${url}`;
            const response = await this.doFetch(jinaUrl, {
                'Accept': 'text/markdown',
                'User-Agent': DEFAULT_USER_AGENT,
            });

            if (!response.ok) {
                return null;
            }

            const text = await this.readResponseBody(response);
            if (!text || text.length < MIN_CONTENT_LENGTH) {
                return null;
            }

            // Jina Reader 在遇到反爬时会返回 Warning + 挑战页内容，检测并丢弃
            if (text.includes('Target URL returned error 403') || text.includes('requiring CAPTCHA')) {
                return null;
            }

            return { content: this.truncate(text), strategy: 'Jina Reader' };
        } catch {
            return null;
        }
    }

    // ───────────────────── 策略3: Meta 标签提取 ─────────────────────

    private async tryMetaExtraction(url: string): Promise<FetchResult | null> {
        try {
            const response = await this.doFetch(url, BROWSER_HEADERS);
            const body = await this.readResponseBody(response);
            if (!body) return null;

            // 如果整个页面都是反爬虫挑战，meta 信息也没有价值
            if (this.isAntiBot(body)) return null;

            const { document } = parseHTML(body);
            const info: string[] = [];

            const title =
                this.getMeta(document, 'og:title') ||
                document.querySelector('title')?.textContent?.trim();
            if (title && !this.isAntiBotTitle(title)) info.push(`# ${title}`);

            const desc =
                this.getMeta(document, 'og:description') ||
                this.getMetaByName(document, 'description');
            if (desc) info.push(desc);

            const siteName = this.getMeta(document, 'og:site_name');
            if (siteName) info.push(`**站点**: ${siteName}`);

            const ogImage = this.getMeta(document, 'og:image');
            if (ogImage) info.push(`![preview](${ogImage})`);

            const keywords = this.getMetaByName(document, 'keywords');
            if (keywords) info.push(`**关键词**: ${keywords}`);

            if (info.length === 0) return null;

            const content = info.join('\n\n') + '\n\n---\n_注意：仅从页面 meta 标签中提取到上述有限信息，页面的完整内容无法通过纯 HTTP 请求获取。_';
            return { content, strategy: 'Meta 标签提取' };
        } catch {
            return null;
        }
    }

    // ───────────────────── HTTP 请求 ─────────────────────

    private async doFetch(url: string, headers: Record<string, string>): Promise<Awaited<ReturnType<typeof fetch>>> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        try {
            return await fetch(url, {
                method: 'GET',
                redirect: 'follow',
                headers,
                signal: controller.signal,
            });
        } catch (err: any) {
            if (err.name === 'AbortError') {
                throw new Error(`请求超时 (${FETCH_TIMEOUT_MS / 1000}秒)`);
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

    // ───────────────────── 反爬检测 ─────────────────────

    private isAntiBot(html: string): boolean {
        const lower = html.toLowerCase();
        const indicators = [
            'just a moment',
            'checking your browser',
            'verify you are human',
            'enable javascript and cookies',
            'cloudflare',
            'cf-browser-verification',
            'challenge-platform',
            'ddos-guard',
            'sucuri',
            'incapsula',
        ];
        const matchCount = indicators.filter(s => lower.includes(s)).length;
        return matchCount >= 2;
    }

    private isAntiBotTitle(title: string): boolean {
        const lower = title.toLowerCase();
        const bogus = [
            'just a moment', 'checking your browser', 'please wait',
            'attention required', 'access denied', 'security check',
            'one more step', 'verify you are human',
        ];
        return bogus.some(s => lower.includes(s));
    }

    // ───────────────────── HTML → Markdown ─────────────────────

    private htmlToMarkdown(html: string, _url: string): string {
        const { document } = parseHTML(html);

        // 仅移除不可见元素，让 Readability 自行决定如何处理 nav/header/footer
        for (const tag of ['script', 'style', 'noscript', 'iframe']) {
            document.querySelectorAll(tag).forEach((el: Element) => el.remove());
        }

        const reader = new Readability(document as unknown as Document, {
            charThreshold: 100,
        });
        const article = reader.parse();

        let title = '';
        let markdownContent = '';

        if (article && article.content) {
            title = article.title || '';
            markdownContent = this.turndownService.turndown(article.content);

            const meta: string[] = [];
            if (article.byline) meta.push(`**作者**: ${article.byline}`);
            if (article.publishedTime) meta.push(`**发布时间**: ${article.publishedTime}`);
            if (article.excerpt) meta.push(`**摘要**: ${article.excerpt}`);

            if (meta.length > 0) {
                markdownContent = meta.join('\n') + '\n\n---\n\n' + markdownContent;
            }
        }

        // Readability 对非文章页面（搜索结果、列表页等）效果差，内容太少时使用 body fallback
        if (!markdownContent || markdownContent.length < MIN_CONTENT_LENGTH) {
            const fallbackMd = this.bodyFallbackExtraction(html);
            if (fallbackMd && fallbackMd.length > markdownContent.length) {
                markdownContent = fallbackMd;
                if (!title) {
                    const { document: doc } = parseHTML(html);
                    title = doc.querySelector('title')?.textContent?.trim() || '';
                }
            }
        }

        markdownContent = this.cleanMarkdown(markdownContent);

        if (title && !markdownContent.includes(`# ${title}`)) {
            markdownContent = `# ${title}\n\n${markdownContent}`;
        }

        return this.truncate(markdownContent);
    }

    /**
     * 当 Readability 无法有效提取内容时，从 DOM 主容器直接转换。
     * 重新解析 HTML（因 Readability 会修改 DOM），优先取 <main>、#__next 等容器。
     */
    private bodyFallbackExtraction(html: string): string {
        const { document } = parseHTML(html);

        for (const tag of ['script', 'style', 'noscript', 'iframe']) {
            document.querySelectorAll(tag).forEach((el: Element) => el.remove());
        }

        const adSelectors = [
            '.sidebar', '.advertisement', '.ads', '.ad',
            '.cookie-banner', '.popup', '.modal',
            '[role="complementary"]',
        ];
        for (const sel of adSelectors) {
            try {
                document.querySelectorAll(sel).forEach((el: Element) => el.remove());
            } catch { /* linkedom 可能不支持某些选择器 */ }
        }

        const mainEl =
            document.querySelector('main') ||
            document.querySelector('[role="main"]') ||
            document.querySelector('#__next') ||
            document.querySelector('#app') ||
            document.querySelector('#root') ||
            document.querySelector('body');

        if (!mainEl) return '';

        return this.turndownService.turndown(mainEl.innerHTML);
    }

    // ───────────────────── 工具函数 ─────────────────────

    private getMeta(document: any, property: string): string {
        const el = document.querySelector(`meta[property="${property}"]`);
        return el?.getAttribute('content')?.trim() || '';
    }

    private getMetaByName(document: any, name: string): string {
        const el = document.querySelector(`meta[name="${name}"]`);
        return el?.getAttribute('content')?.trim() || '';
    }

    private cleanMarkdown(md: string): string {
        return md
            .replace(/\n{3,}/g, '\n\n')
            .replace(/^\s+$/gm, '')
            .replace(/\[([^\]]*)\]\(\s*\)/g, '$1')
            .replace(/!\[\]\(\s*\)/g, '')
            .trim();
    }

    private truncate(text: string): string {
        if (text.length <= MAX_OUTPUT_CHARS) return text;
        const truncated = text.slice(0, MAX_OUTPUT_CHARS);
        const lastNewline = truncated.lastIndexOf('\n');
        const cutPoint = lastNewline > MAX_OUTPUT_CHARS * 0.8 ? lastNewline : MAX_OUTPUT_CHARS;
        return truncated.slice(0, cutPoint) + '\n\n---\n[内容已截断，原文共 ' + text.length + ' 个字符]';
    }

    private formatOutput(url: string, result: FetchResult): string {
        let output = `## 网页内容\n`;
        output += `**来源**: ${url}\n`;
        output += `**获取方式**: ${result.strategy}\n\n`;
        output += result.content;
        return output;
    }
}
