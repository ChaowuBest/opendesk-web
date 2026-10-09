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
import { renderSearchToolCall, extractExaResultCount } from './render';
import { t } from '../../../../locale/index.js';
import chalk from 'chalk';
import { z } from 'zod';
import { getPlatform } from '../../../../platforms/base.js';

const EXA_API_URL = 'https://api.exa.ai/search';
const FETCH_TIMEOUT_MS = 30000;
const DEFAULT_RESULT_COUNT = 15;

interface ExaSearchResult {
    title: string;
    url: string;
    summary?: string;
}

interface ExaSearchResponse {
    results: ExaSearchResult[];
}

const ExaSearchArgsSchema = z.object({
    query: z.string().describe('搜索关键词')
});

export class ExaSearchTool extends BaseTool<typeof ExaSearchArgsSchema> {
    private apiKey: string;

    constructor(apiKey: string) {
        super(
            'ExaSearch',
            '使用Exa搜索引擎搜索网页信息，返回搜索结果的标题、URL和摘要',
            ExaSearchArgsSchema,
            undefined,
            { 'zh-CN': '搜索 (Exa)', 'en-US': 'Search (Exa)' }
        );
        this.apiKey = apiKey;
        this.setExecutor(this.search.bind(this));
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const query = toolcall.args_object?.['query'] as string | undefined;
        return renderSearchToolCall({
            icon: 'fas fa-magnifying-glass',
            title: t('search.exa.name'),
            toolcall,
            query,
            resultCountExtractor: extractExaResultCount
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
            const match = toolcall.result.match(/总计找到\s*(\d+)\s*条结果/);
            if (match) {
                body.push(chalk.dim('  找到 ') + chalk.white(match[1]) + chalk.dim(' 条结果'));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(toolcall.result, width - 10)));
        }

        return new Card({
            icon: '🔍',
            title: '搜索 (Exa)',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async search(args: z.output<typeof ExaSearchArgsSchema>): Promise<string> {
        const { query } = args;

        if (!query || query.trim().length === 0) {
            throw new Error('搜索关键词不能为空');
        }

        const data = await this.fetchExaApi(query);
        const results = data.results ?? [];

        if (results.length === 0) {
            return `未找到与 "${query}" 相关的搜索结果。`;
        }

        return this.formatResults(results);
    }

    private async fetchExaApi(query: string): Promise<ExaSearchResponse> {
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
                'x-api-key': this.apiKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                query,
                numResults: DEFAULT_RESULT_COUNT,
                type: 'auto',
                contents: { summary: true }
            }),
            signal: controller.signal
        };

        try {
            const response = await getPlatform().fetch(EXA_API_URL, fetchOptions);

            if (!response.ok) {
                const errorData = (await response.json().catch(() => ({}))) as Record<string, string>;
                const msg = errorData.message || errorData.error || response.statusText;
                throw new Error(`Exa API 请求失败，HTTP ${response.status}: ${msg}`);
            }

            return (await response.json()) as ExaSearchResponse;
        } catch (err: any) {
            if (err.name === 'AbortError') {
                throw new Error(`Exa Search 请求超时 (${FETCH_TIMEOUT_MS / 1000}秒)`);
            }
            throw err;
        } finally {
            clearTimeout(timer);
        }
    }

    private formatResults(results: ExaSearchResult[]): string {
        let output = `总计找到 ${results.length} 条结果：\n\n`;

        for (const item of results) {
            output += `- 搜索结果： ${item.title}\n`;
            output += `  - url: ${item.url}\n`;
            if (item.summary) {
                output += `  - 摘要: <summary>${item.summary}</summary>\n`;
            }
        }

        return output;
    }
}
