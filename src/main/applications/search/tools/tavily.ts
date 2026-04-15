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
import { fetch, ProxyAgent, type Dispatcher } from 'undici';

const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';
const FETCH_TIMEOUT_MS = 30000;
const DEFAULT_RESULT_COUNT = 10;
const MAX_RESULT_COUNT = 20;

interface TavilySearchResult {
    title: string;
    url: string;
    content: string;
    score: number;
    raw_content?: string;
}

interface TavilySearchResponse {
    results: TavilySearchResult[];
    query: string;
    response_time?: number;
    images?: string[];
    follow_up_questions?: string[];
}

const TavilySearchArgsSchema = z.object({
    query: z.string().describe('搜索关键词'),
    count: z.number().optional().describe('期望返回的搜索结果数量，默认为10，最大20'),
    search_depth: z
        .enum(['basic', 'advanced'])
        .optional()
        .describe('搜索深度: basic=基础搜索(更快), advanced=深度搜索(更全面)'),
    include_raw_content: z.boolean().optional().describe('是否包含原始页面内容，默认false'),
    include_images: z.boolean().optional().describe('是否在结果中包含相关图片链接，默认false'),
    include_answer: z.boolean().optional().describe('是否生成问题的简短答案，默认false')
});

export class TavilySearchTool extends BaseTool<typeof TavilySearchArgsSchema> {
    private apiKey: string;

    constructor(apiKey: string) {
        super(
            'tavilySearch',
            '使用Tavily搜索引擎搜索网页信息，专为AI设计的搜索API，返回优化过的搜索结果。支持深度搜索和答案生成功能',
            TavilySearchArgsSchema
        );
        this.apiKey = apiKey;
        this.setExecutor(this.search.bind(this));
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
            title: '搜索 (Tavily)',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async search(args: z.output<typeof TavilySearchArgsSchema>): Promise<string> {
        const { query, count, search_depth, include_raw_content, include_images, include_answer } = args;
        const maxResults = Math.min(count ?? DEFAULT_RESULT_COUNT, MAX_RESULT_COUNT);

        if (!query || query.trim().length === 0) {
            throw new Error('搜索关键词不能为空');
        }

        const data = await this.fetchTavilyApi(
            query,
            maxResults,
            search_depth,
            include_raw_content,
            include_images,
            include_answer
        );
        const results = data.results ?? [];

        if (results.length === 0) {
            return `未找到与 "${query}" 相关的搜索结果。`;
        }

        return this.formatResults(query, results, data);
    }

    private async fetchTavilyApi(
        query: string,
        count: number,
        search_depth?: 'basic' | 'advanced',
        include_raw_content?: boolean,
        include_images?: boolean,
        include_answer?: boolean
    ): Promise<TavilySearchResponse> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        const requestBody: Record<string, any> = {
            query,
            max_results: count,
            search_depth: search_depth ?? 'basic',
            include_raw_content: include_raw_content ?? false,
            include_images: include_images ?? false,
            include_answer: include_answer ?? false
        };

        const fetchOptions: {
            method: string;
            headers: Record<string, string>;
            body: string;
            signal: AbortSignal;
            dispatcher?: Dispatcher;
        } = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.apiKey}`
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal
        };

        const proxyUrl =
            process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
        if (proxyUrl) {
            fetchOptions.dispatcher = new ProxyAgent(proxyUrl);
        }

        try {
            const response = await fetch(TAVILY_SEARCH_URL, fetchOptions);

            if (!response.ok) {
                const errorText = await response.text().catch(() => '');
                throw new Error(
                    `Tavily Search API 请求失败，HTTP ${response.status}: ${errorText || response.statusText}`
                );
            }

            return (await response.json()) as TavilySearchResponse;
        } catch (err: any) {
            if (err.name === 'AbortError') {
                throw new Error(`Tavily Search 请求超时 (${FETCH_TIMEOUT_MS / 1000}秒)`);
            }
            throw err;
        } finally {
            clearTimeout(timer);
        }
    }

    private formatResults(query: string, results: TavilySearchResult[], response: TavilySearchResponse): string {
        let output = `## Tavily 搜索结果\n`;
        output += `**搜索词**: ${query}\n`;
        output += `**结果数量**: ${results.length}\n`;
        if (response.response_time) {
            output += `**响应时间**: ${response.response_time}ms\n`;
        }
        output += '\n';

        for (const item of results) {
            output += `- 搜索结果： ${item.title}\n`;
            output += `  - url: ${item.url}\n`;
            if (item.content) {
                output += `  - 摘要: <summary>${item.content}</summary>\n`;
            }
            if (item.raw_content) {
                // 限制原始内容长度，避免输出过长
                const truncatedRaw =
                    item.raw_content.length > 500 ? item.raw_content.substring(0, 500) + '...' : item.raw_content;
                output += `  - 原始内容: <raw>${truncatedRaw}</raw>\n`;
            }
            output += `  - 相关度: ${(item.score * 100).toFixed(1)}%\n`;
        }

        if (response.follow_up_questions && response.follow_up_questions.length > 0) {
            output += '\n**相关问题**:\n';
            for (const question of response.follow_up_questions) {
                output += `- ${question}\n`;
            }
        }

        return output;
    }
}
