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

import { getPlatform } from '../../../../platforms/base.js';
import { parseStringPromise } from 'xml2js';
import { BaseAcademicSearchEngine, type AcademicEngineArgs, type AcademicPaper } from './baseAcademicEngine';

const FETCH_TIMEOUT_MS = 30000;
const DEFAULT_RESULT_COUNT = 10;
const ARXIV_API_URL = 'http://export.arxiv.org/api/query';
const MIN_REQUEST_INTERVAL_MS = 3000;

let lastRequestTime = 0;

export class ArxivSearchTool extends BaseAcademicSearchEngine {
    protected engineName = 'arXiv';
    protected guiIcon = 'fas fa-graduation-cap';
    protected cliIcon = '📄';

    constructor() {
        super(
            'arxivSearch',
            '使用arXiv API搜索学术论文，返回论文的标题、作者、摘要、发布日期等信息。无需API密钥，支持多种搜索语法。'
        );
    }

    // ───────────────────── 搜索实现 ─────────────────────

    protected async doSearch(args: AcademicEngineArgs): Promise<string> {
        const maxResults = args.count ?? DEFAULT_RESULT_COUNT;
        const startIndex = args.start ?? 0;
        const sortBy = args.sort_by ?? 'relevance';
        const sortOrder = args.sort_order ?? 'descending';

        // arXiv API 要求请求间隔至少 3 秒
        const now = Date.now();
        const elapsed = now - lastRequestTime;
        if (elapsed < MIN_REQUEST_INTERVAL_MS) {
            await new Promise((resolve) => setTimeout(resolve, MIN_REQUEST_INTERVAL_MS - elapsed));
        }
        lastRequestTime = Date.now();

        const xml = await this.fetchArxivResults(args.query, maxResults, startIndex, sortBy, sortOrder);
        const results = await this.parseSearchResults(xml);

        if (results.length === 0) {
            return `未找到与 "${args.query}" 相关的arXiv论文。`;
        }

        return this.formatResults(args.query, results);
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

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        try {
            const response = await getPlatform().fetch(url.toString(), {
                method: 'GET',
                redirect: 'follow',
                signal: controller.signal
            });

            if (!response.ok) {
                if (response.status === 429) {
                    await new Promise((resolve) => setTimeout(resolve, MIN_REQUEST_INTERVAL_MS));
                    throw new Error('arXiv 请求频率超限，请稍后重试');
                }
                throw new Error(`arXiv 请求失败，HTTP 状态码: ${response.status}`);
            }

            return await response.text();
        } catch (err: any) {
            if (err.name === 'AbortError') {
                throw new Error(`arXiv 搜索请求超时 (${FETCH_TIMEOUT_MS / 1000}秒)`);
            }
            throw err;
        } finally {
            clearTimeout(timer);
        }
    }

    // ───────────────────── XML 解析 ─────────────────────

    private async parseSearchResults(xml: string): Promise<AcademicPaper[]> {
        const results: AcademicPaper[] = [];

        try {
            const parsed = await parseStringPromise(xml, { explicitArray: false });
            const feed = parsed.feed;
            const entries = Array.isArray(feed.entry) ? feed.entry : [feed.entry];

            for (const entry of entries) {
                if (!entry) continue;

                const paper: AcademicPaper = {
                    title: (entry.title || '').trim(),
                    authors: Array.isArray(entry.author)
                        ? entry.author.map((a: any) => a.name || '').filter(Boolean)
                        : [(entry.author?.name || '').trim()].filter(Boolean),
                    summary: (entry.summary || '').trim(),
                    published: entry.published || '',
                    updated: entry.updated || '',
                    url: entry.id || '',
                    categories: Array.isArray(entry.category)
                        ? entry.category.map((c: any) => c.$?.term || '').filter(Boolean)
                        : [entry.category?.$?.term || ''].filter(Boolean),
                    year: '',
                    venue: '',
                    doi: ''
                };

                if (paper.title && paper.url) {
                    // 从 published 日期中提取年份
                    if (paper.published) {
                        const yearMatch = paper.published.match(/^(\d{4})/);
                        if (yearMatch) paper.year = yearMatch[1];
                    }
                    results.push(paper);
                }
            }
        } catch (error) {
            console.error('解析arXiv XML失败:', error);
            throw new Error('解析arXiv搜索结果失败');
        }

        return results;
    }
}
