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

const BOCHA_SEARCH_URL = 'https://api.bocha.cn/v1/web-search';
const FETCH_TIMEOUT_MS = 30000;
const DEFAULT_RESULT_COUNT = 10;
const MAX_RESULT_COUNT = 50;

interface BochaWebPageValue {
    id?: string;
    name: string;
    url: string;
    displayUrl?: string;
    snippet?: string;
    summary?: string;
    siteName?: string;
    siteIcon?: string;
    datePublished?: string;
    dateLastCrawled?: string;
    cachedPageUrl?: string;
    language?: string;
    isFamilyFriendly?: boolean;
    isNavigational?: boolean;
}

interface BochaImageValue {
    name?: string;
    thumbnailUrl?: string;
    datePublished?: string;
    contentUrl?: string;
    hostPageUrl?: string;
    width?: number;
    height?: number;
}

interface BochaVideoValue {
    name?: string;
    description?: string;
    thumbnailUrl?: string;
    contentUrl?: string;
    hostPageUrl?: string;
    duration?: string;
    datePublished?: string;
    viewCount?: number;
}

interface BochaWebPages {
    webSearchUrl?: string;
    totalEstimatedMatches?: number;
    value: BochaWebPageValue[];
    someResultsRemoved?: boolean;
}

interface BochaImages {
    value: BochaImageValue[];
}

interface BochaVideos {
    value: BochaVideoValue[];
}

interface BochaSearchData {
    _type?: string;
    queryContext?: {
        originalQuery?: string;
    };
    webPages?: BochaWebPages;
    images?: BochaImages;
    videos?: BochaVideos;
}

interface BochaSearchResponse {
    code: number;
    log_id?: string;
    msg?: string;
    data?: BochaSearchData;
}

const BochaSearchArgsSchema = z.object({
    query: z.string().describe('搜索关键词'),
    count: z.number().optional().describe('期望返回的搜索结果数量，默认为10，最大50'),
    summary: z.boolean().optional().describe('是否生成文本摘要，默认false'),
    freshness: z
        .enum(['noLimit', 'oneDay', 'oneWeek', 'oneMonth', 'oneYear'])
        .optional()
        .describe('搜索时间范围: noLimit=不限(默认), oneDay=一天内, oneWeek=一周内, oneMonth=一个月内, oneYear=一年内'),
    include: z.string().optional().describe('指定搜索的网站范围，多个域名使用|或,分隔'),
    exclude: z.string().optional().describe('排除搜索的网站范围，多个域名使用|或,分隔')
});

export class BochaSearchTool extends BaseTool<typeof BochaSearchArgsSchema> {
    private apiKey: string;

    constructor(apiKey: string) {
        super(
            'bochaSearch',
            '使用博查搜索引擎搜索网页信息，专为AI设计的中文搜索API，返回优化过的搜索结果。支持摘要生成和时间范围筛选功能',
            BochaSearchArgsSchema,
            undefined,
            { 'zh-CN': '搜索 (博查)', 'en-US': 'Search (Bocha)' }
        );
        this.apiKey = apiKey;
        this.setExecutor(this.search.bind(this));
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const query = toolcall.args_object?.['query'] as string | undefined;
        return renderSearchToolCall({
            icon: 'fas fa-magnifying-glass',
            title: t('search.bocha.name'),
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
            title: '搜索 (博查)',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async search(args: z.output<typeof BochaSearchArgsSchema>): Promise<string> {
        const { query, count, summary, freshness, include, exclude } = args;
        const maxResults = Math.min(count ?? DEFAULT_RESULT_COUNT, MAX_RESULT_COUNT);

        if (!query || query.trim().length === 0) {
            throw new Error('搜索关键词不能为空');
        }

        const response = await this.fetchBochaApi(query, maxResults, summary, freshness, include, exclude);

        if (response.code !== 200) {
            throw new Error(`博查搜索API错误: ${response.msg || `HTTP ${response.code}`}`);
        }

        const data = response.data;
        if (!data?.webPages?.value || data.webPages.value.length === 0) {
            return `未找到与 "${query}" 相关的搜索结果。`;
        }

        return this.formatResults(query, data);
    }

    private async fetchBochaApi(
        query: string,
        count: number,
        summary?: boolean,
        freshness?: 'noLimit' | 'oneDay' | 'oneWeek' | 'oneMonth' | 'oneYear',
        include?: string,
        exclude?: string
    ): Promise<BochaSearchResponse> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        const requestBody: Record<string, any> = {
            query,
            count,
            summary: summary ?? false
        };

        if (freshness) {
            requestBody.freshness = freshness;
        }
        if (include) {
            requestBody.include = include;
        }
        if (exclude) {
            requestBody.exclude = exclude;
        }

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
            body: JSON.stringify(requestBody),
            signal: controller.signal
        };

        try {
            const response = await getPlatform().fetch(BOCHA_SEARCH_URL, fetchOptions);

            if (!response.ok) {
                const errorText = await response.text().catch(() => '');
                throw new Error(
                    `博查 Search API 请求失败，HTTP ${response.status}: ${errorText || response.statusText}`
                );
            }

            return (await response.json()) as BochaSearchResponse;
        } catch (err: any) {
            if (err.name === 'AbortError') {
                throw new Error(`博查 Search 请求超时 (${FETCH_TIMEOUT_MS / 1000}秒)`);
            }
            throw err;
        } finally {
            clearTimeout(timer);
        }
    }

    private formatResults(query: string, data: BochaSearchData): string {
        let output = `## 博查搜索结果\n`;
        output += `**搜索词**: ${query}\n`;

        const webPages = data.webPages;
        const results = webPages?.value ?? [];

        output += `**结果数量**: ${results.length}\n`;
        if (webPages?.totalEstimatedMatches) {
            output += `**总匹配数**: ${webPages.totalEstimatedMatches.toLocaleString()}\n`;
        }
        output += '\n';

        // 网页搜索结果
        if (results.length > 0) {
            output += '### 网页结果\n';
            for (const item of results) {
                output += `- 搜索结果： ${item.name}\n`;
                output += `  - url: ${item.url}\n`;
                if (item.siteName) {
                    output += `  - 来源: ${item.siteName}\n`;
                }
                if (item.snippet) {
                    output += `  - 摘要: <summary>${item.snippet}</summary>\n`;
                }
                if (item.summary) {
                    // 限制摘要长度，避免输出过长
                    const truncatedSummary =
                        item.summary.length > 500 ? item.summary.substring(0, 500) + '...' : item.summary;
                    output += `  - 内容摘要: <content>${truncatedSummary}</content>\n`;
                }
                if (item.datePublished) {
                    output += `  - 发布时间: ${item.datePublished}\n`;
                }
            }
        }

        // 图片结果
        const images = data.images?.value ?? [];
        if (images.length > 0) {
            output += '\n### 相关图片\n';
            for (const img of images.slice(0, 5)) {
                // 最多显示5张图片
                if (img.thumbnailUrl) {
                    output += `- 图片: ${img.name || '相关图片'}\n`;
                    output += `  - 缩略图: ${img.thumbnailUrl}\n`;
                    if (img.hostPageUrl) {
                        output += `  - 来源页面: ${img.hostPageUrl}\n`;
                    }
                }
            }
        }

        // 视频结果
        const videos = data.videos?.value ?? [];
        if (videos.length > 0) {
            output += '\n### 相关视频\n';
            for (const video of videos.slice(0, 3)) {
                // 最多显示3个视频
                if (video.name) {
                    output += `- 视频: ${video.name}\n`;
                    if (video.description) {
                        output += `  - 描述: ${video.description}\n`;
                    }
                    if (video.hostPageUrl) {
                        output += `  - 链接: ${video.hostPageUrl}\n`;
                    }
                    if (video.duration) {
                        output += `  - 时长: ${video.duration}\n`;
                    }
                }
            }
        }

        return output;
    }
}
