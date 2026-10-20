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
import { t } from '../locale/index.js';
import chalk from 'chalk';
import { z } from 'zod';
import { getPlatform } from '../../../../platforms/base.js';

const DOUBAO_SEARCH_URL = 'https://open.feedcoopapi.com/search_api/web_search';
const FETCH_TIMEOUT_MS = 30000;
const DEFAULT_RESULT_COUNT = 10;
const MAX_RESULT_COUNT = 50;
/** 豆包搜索限制 query 为 1~100 个字符 */
const MAX_QUERY_LENGTH = 100;

interface DoubaoWebResult {
    Title?: string;
    Url?: string;
    Snippet?: string;
    Summary?: string;
    SiteName?: string;
    PublishTime?: string | null;
}

interface DoubaoSearchData {
    ResultCount?: number;
    WebResults?: DoubaoWebResult[];
}

interface DoubaoSearchResponse {
    Result?: DoubaoSearchData;
}

const DoubaoSearchArgsSchema = z.object({
    query: z.string().describe('搜索关键词'),
    count: z.number().optional().describe('期望返回的搜索结果数量，默认为10，最大50')
});

export class DoubaoSearchTool extends BaseTool<typeof DoubaoSearchArgsSchema> {
    private apiKey: string;

    constructor(apiKey: string) {
        super(
            'doubaoSearch',
            '使用豆包搜索引擎搜索网页信息，由字节跳动豆包搜索提供，返回结构化的搜索结果',
            DoubaoSearchArgsSchema,
            undefined,
            { 'zh-CN': '搜索 (豆包)', 'en-US': 'Search (Doubao)' }
        );
        this.apiKey = apiKey;
        this.setExecutor(this.search.bind(this));
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const query = toolcall.args_object?.['query'] as string | undefined;
        return renderSearchToolCall({
            icon: 'fas fa-magnifying-glass',
            title: t('search.doubao.name'),
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
            title: '搜索 (豆包)',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async search(args: z.output<typeof DoubaoSearchArgsSchema>): Promise<string> {
        const { query, count } = args;

        if (!query || query.trim().length === 0) {
            throw new Error('搜索关键词不能为空');
        }

        const maxResults = Math.min(count ?? DEFAULT_RESULT_COUNT, MAX_RESULT_COUNT);
        const trimmedQuery = Array.from(query.trim()).slice(0, MAX_QUERY_LENGTH).join('');

        const data = await this.fetchDoubaoApi(trimmedQuery, maxResults);
        const results = data.Result?.WebResults ?? [];

        if (results.length === 0) {
            return `未找到与 "${trimmedQuery}" 相关的搜索结果。`;
        }

        return this.formatResults(trimmedQuery, results);
    }

    private async fetchDoubaoApi(query: string, count: number): Promise<DoubaoSearchResponse> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        const fetchOptions: {
            method: string;
            headers: Record<string, string>;
            body: string;
            signal: AbortSignal;
        } = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.apiKey}`
            },
            body: JSON.stringify({
                Query: query,
                SearchType: 'web',
                Count: count
            }),
            signal: controller.signal
        };

        try {
            const response = await getPlatform().fetch(DOUBAO_SEARCH_URL, fetchOptions);

            if (!response.ok) {
                const errorData = (await response.json().catch(() => ({}))) as {
                    ResponseMetadata?: { Error?: { Code?: string; Message?: string } };
                    message?: string;
                };
                const msg =
                    errorData.ResponseMetadata?.Error?.Message ||
                    errorData.ResponseMetadata?.Error?.Code ||
                    errorData.message ||
                    response.statusText;
                throw new Error(`豆包搜索 API 请求失败，HTTP ${response.status}: ${msg}`);
            }

            return (await response.json()) as DoubaoSearchResponse;
        } catch (err: any) {
            if (err.name === 'AbortError') {
                throw new Error(`豆包搜索请求超时 (${FETCH_TIMEOUT_MS / 1000}秒)`);
            }
            throw err;
        } finally {
            clearTimeout(timer);
        }
    }

    private formatResults(query: string, results: DoubaoWebResult[]): string {
        let output = `## 豆包搜索结果\n`;
        output += `**搜索词**: ${query}\n`;
        output += `**结果数量**: ${results.length}\n\n`;

        for (const item of results) {
            output += `- 搜索结果： ${item.Title || ''}\n`;
            if (item.Url) {
                output += `  - url: ${item.Url}\n`;
            }
            const summary = item.Summary || item.Snippet;
            if (summary) {
                output += `  - 摘要: <summary>${summary}</summary>\n`;
            }
            if (item.SiteName) {
                output += `  - 站点: ${item.SiteName}\n`;
            }
            if (item.PublishTime) {
                output += `  - 发布时间: ${item.PublishTime}\n`;
            }
        }

        return output;
    }
}
