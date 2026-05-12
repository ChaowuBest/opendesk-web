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
import { renderSearchToolCall } from './render';
import { t } from '../../../../locale/index.js';
import chalk from 'chalk';
import { z } from 'zod';
import { fetch } from 'undici';
import { parseStringPromise } from 'xml2js';

const FETCH_TIMEOUT_MS = 10000;
const DEFAULT_RESULT_COUNT = 10;
const ARXIV_API_URL = 'http://export.arxiv.org/api/query';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

interface ArxivSearchResult {
    id: string;
    title: string;
    authors: string[];
    summary: string;
    published: string;
    updated: string;
    link: string;
    categories: string[];
}

const ArxivSearchArgsSchema = z.object({
    query: z
        .string()
        .describe(
            '搜索关键词，可以使用arxiv的搜索语法，如标题搜索：ti:keyword，摘要搜索：abs:keyword，作者搜索：au:name，分类搜索：cat:cs.AI等'
        ),
    count: z.number().optional().describe('期望返回的搜索结果数量，默认为10'),
    start: z.number().optional().describe('搜索结果的起始偏移量，用于分页，默认为0'),
    sort_by: z
        .enum(['relevance', 'lastUpdatedDate', 'submittedDate'])
        .optional()
        .describe(
            '排序方式：relevance（相关性）、lastUpdatedDate（最后更新日期）、submittedDate（提交日期），默认为relevance'
        ),
    sort_order: z
        .enum(['ascending', 'descending'])
        .optional()
        .describe('排序顺序：ascending（升序）、descending（降序），默认为descending')
});

export class ArxivSearchTool extends BaseTool<typeof ArxivSearchArgsSchema> {
    constructor() {
        super(
            'arxivSearch',
            '使用arXiv API搜索学术论文，返回论文的标题、作者、摘要、发布日期等信息。无需API密钥，支持多种搜索语法。',
            ArxivSearchArgsSchema
        );

        this.setExecutor(this.search.bind(this));
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const query = toolcall.args_object?.['query'] as string | undefined;
        return renderSearchToolCall({
            icon: 'fas fa-graduation-cap',
            title: t('search.arxiv.name'),
            toolcall,
            query,
            resultCountExtractor: (result) => {
                const match = result.match(/\*\*结果数量\*\*:\s*(\d+)/);
                return match ? `${match[1]} 篇论文` : null;
            }
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
                body.push(chalk.dim('  找到 ') + chalk.white(match[1]) + chalk.dim(' 篇论文'));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(toolcall.result, width - 10)));
        }

        return new Card({
            icon: '📄',
            title: 'arXiv论文搜索',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    // ───────────────────── 主入口 ─────────────────────

    private async search(args: z.output<typeof ArxivSearchArgsSchema>): Promise<string> {
        const { query, count, start, sort_by, sort_order } = args;
        const maxResults = count ?? DEFAULT_RESULT_COUNT;
        const startIndex = start ?? 0;
        const sortBy = sort_by ?? 'relevance';
        const sortOrder = sort_order ?? 'descending';

        if (!query || query.trim().length === 0) {
            throw new Error('搜索关键词不能为空');
        }

        const xml = await this.fetchArxivResults(query, maxResults, startIndex, sortBy, sortOrder);
        const results = await this.parseSearchResults(xml);

        if (results.length === 0) {
            return `未找到与 "${query}" 相关的arXiv论文。`;
        }

        return this.formatResults(query, results);
    }

    // ───────────────────── HTTP 请求 ─────────────────────

    private async fetchArxivResults(
        query: string,
        maxResults: number,
        start: number,
        sortBy: string,
        sortOrder: string
    ): Promise<string> {
        const url = new URL(ARXIV_API_URL);
        url.searchParams.set('search_query', query);
        url.searchParams.set('start', start.toString());
        url.searchParams.set('max_results', maxResults.toString());
        url.searchParams.set('sortBy', sortBy);
        url.searchParams.set('sortOrder', sortOrder);

        let lastError: Error | null = null;

        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

            try {
                const response = await fetch(url.toString(), {
                    method: 'GET',
                    redirect: 'follow',
                    signal: controller.signal
                });

                if (!response.ok) {
                    throw new Error(`arXiv 请求失败，HTTP 状态码: ${response.status}`);
                }

                const text = await response.text();
                clearTimeout(timer);
                return text;
            } catch (err: any) {
                clearTimeout(timer);
                lastError = err;

                if (attempt < MAX_RETRIES - 1) {
                    console.warn(
                        `arXiv 请求失败 (尝试 ${attempt + 1}/${MAX_RETRIES})，${RETRY_DELAY_MS / 1000}秒后重试:`,
                        err.message
                    );
                    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
                }
            }
        }

        if (lastError?.name === 'AbortError') {
            throw new Error(`arXiv 搜索请求超时 (${FETCH_TIMEOUT_MS / 1000}秒)`);
        }
        throw lastError || new Error('arXiv 请求失败');
    }

    // ───────────────────── XML 解析 ─────────────────────

    private async parseSearchResults(xml: string): Promise<ArxivSearchResult[]> {
        const results: ArxivSearchResult[] = [];

        try {
            const parsed = await parseStringPromise(xml, { explicitArray: false });
            const feed = parsed.feed;
            const entries = Array.isArray(feed.entry) ? feed.entry : [feed.entry];

            for (const entry of entries) {
                if (!entry) continue;

                const result: ArxivSearchResult = {
                    id: entry.id || '',
                    title: (entry.title || '').trim(),
                    authors: Array.isArray(entry.author)
                        ? entry.author.map((a: any) => a.name || '').filter(Boolean)
                        : [(entry.author?.name || '').trim()].filter(Boolean),
                    summary: (entry.summary || '').trim(),
                    published: entry.published || '',
                    updated: entry.updated || '',
                    link: entry.id || '',
                    categories: Array.isArray(entry.category)
                        ? entry.category.map((c: any) => c.$?.term || '').filter(Boolean)
                        : [entry.category?.$?.term || ''].filter(Boolean)
                };

                if (result.title && result.link) {
                    results.push(result);
                }
            }
        } catch (error) {
            console.error('解析arXiv XML失败:', error);
            throw new Error('解析arXiv搜索结果失败');
        }

        return results;
    }

    // ───────────────────── 结果格式化 ─────────────────────

    private formatResults(query: string, results: ArxivSearchResult[]): string {
        let output = `## arXiv 论文搜索结果\n`;
        output += `**搜索词**: ${query}\n`;
        output += `**结果数量**: ${results.length}\n\n`;

        for (const item of results) {
            output += `- 论文标题： ${item.title}\n`;
            output += `  - 作者: ${item.authors.join(', ')}\n`;
            output += `  - 发布日期: ${item.published}\n`;
            output += `  - 更新日期: ${item.updated}\n`;
            output += `  - 分类: ${item.categories.join(', ')}\n`;
            output += `  - 链接: ${item.link}\n`;
            if (item.summary) {
                output += `  - 摘要: <summary>${item.summary}</summary>\n`;
            }
            output += '\n';
        }

        return output;
    }
}
