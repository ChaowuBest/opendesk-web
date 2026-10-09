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

const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';
const FETCH_TIMEOUT_MS = 30000;
const DEFAULT_RESULT_COUNT = 15;
const MAX_RESULT_COUNT = 20;

interface BraveWebResult {
    title: string;
    url: string;
    description: string;
    extra_snippets?: string[];
}

interface BraveSearchResponse {
    type: string;
    query: {
        original: string;
        more_results_available?: boolean;
    };
    web?: {
        type: string;
        results: BraveWebResult[];
    };
}

const BraveSearchArgsSchema = z.object({
    query: z.string().describe('搜索关键词'),
    count: z.number().optional().describe('期望返回的搜索结果数量，默认为15，最大20'),
    country: z.string().optional().describe('目标国家的2字符代码，如 US、CN、DE 等'),
    freshness: z
        .enum(['pd', 'pw', 'pm', 'py'])
        .optional()
        .describe('时效过滤: pd=24小时内, pw=7天内, pm=31天内, py=1年内')
});

export class BraveSearchTool extends BaseTool<typeof BraveSearchArgsSchema> {
    private apiKey: string;

    constructor(apiKey: string) {
        super(
            'braveSearch',
            '使用Brave搜索引擎搜索网页信息，返回搜索结果的标题、URL和摘要。基于Brave独立网络索引，覆盖超过300亿个网页',
            BraveSearchArgsSchema,
            undefined,
            { 'zh-CN': '搜索 (Brave)', 'en-US': 'Search (Brave)' }
        );
        this.apiKey = apiKey;
        this.setExecutor(this.search.bind(this));
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const query = toolcall.args_object?.['query'] as string | undefined;
        return renderSearchToolCall({
            icon: 'fas fa-magnifying-glass',
            title: t('search.brave.name'),
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
            title: '搜索 (Brave)',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async search(args: z.output<typeof BraveSearchArgsSchema>): Promise<string> {
        const { query, count, country, freshness } = args;
        const maxResults = Math.min(count ?? DEFAULT_RESULT_COUNT, MAX_RESULT_COUNT);

        if (!query || query.trim().length === 0) {
            throw new Error('搜索关键词不能为空');
        }

        const data = await this.fetchBraveApi(query, maxResults, country, freshness);
        const results = data.web?.results ?? [];

        if (results.length === 0) {
            return `未找到与 "${query}" 相关的搜索结果。`;
        }

        return this.formatResults(query, results);
    }

    private async fetchBraveApi(
        query: string,
        count: number,
        country?: string,
        freshness?: string
    ): Promise<BraveSearchResponse> {
        const url = new URL(BRAVE_SEARCH_URL);
        url.searchParams.set('q', query);
        url.searchParams.set('count', String(count));
        url.searchParams.set('extra_snippets', 'true');

        if (country) {
            url.searchParams.set('country', country);
        }
        if (freshness) {
            url.searchParams.set('freshness', freshness);
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        const fetchOptions: {
            method: string;
            headers: Record<string, string>;
            signal: AbortSignal;
        } = {
            method: 'GET',
            headers: {
                Accept: 'application/json',
                'X-Subscription-Token': this.apiKey
            },
            signal: controller.signal
        };

        try {
            const response = await getPlatform().fetch(url.toString(), fetchOptions);

            if (!response.ok) {
                const errorText = await response.text().catch(() => '');
                throw new Error(
                    `Brave Search API 请求失败，HTTP ${response.status}: ${errorText || response.statusText}`
                );
            }

            return (await response.json()) as BraveSearchResponse;
        } catch (err: any) {
            if (err.name === 'AbortError') {
                throw new Error(`Brave Search 请求超时 (${FETCH_TIMEOUT_MS / 1000}秒)`);
            }
            throw err;
        } finally {
            clearTimeout(timer);
        }
    }

    private formatResults(query: string, results: BraveWebResult[]): string {
        let output = `## Brave 搜索结果\n`;
        output += `**搜索词**: ${query}\n`;
        output += `**结果数量**: ${results.length}\n\n`;

        for (const item of results) {
            output += `- 搜索结果： ${item.title}\n`;
            output += `  - url: ${item.url}\n`;
            if (item.description) {
                const cleanDesc = item.description.replace(/<\/?strong>/g, '');
                output += `  - 摘要: <summary>${cleanDesc}</summary>\n`;
            }
            if (item.extra_snippets && item.extra_snippets.length > 0) {
                for (const snippet of item.extra_snippets) {
                    const cleanSnippet = snippet.replace(/<\/?strong>/g, '');
                    output += `  - 补充摘要: <summary>${cleanSnippet}</summary>\n`;
                }
            }
        }

        return output;
    }
}
