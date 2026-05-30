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
import { BaseAcademicSearchEngine, type AcademicEngineArgs, type AcademicPaper } from './baseAcademicEngine';

const FETCH_TIMEOUT_MS = 15000;
const DEFAULT_RESULT_COUNT = 10;
const DBLP_API_URL = 'https://dblp.org/search/publ/api';

export class DblpSearchTool extends BaseAcademicSearchEngine {
    protected engineName = 'DBLP';
    protected guiIcon = 'fas fa-database';
    protected cliIcon = '📚';

    constructor() {
        super('dblpSearch', '使用DBLP API搜索计算机科学领域的学术论文。返回论文的标题、作者、年份、会议/期刊等信息。');
    }

    // ───────────────────── 搜索实现 ─────────────────────

    protected async doSearch(args: AcademicEngineArgs): Promise<string> {
        const maxResults = args.count ?? DEFAULT_RESULT_COUNT;
        const startIndex = args.start ?? 0;
        // DBLP API 不支持 sort_by / sort_order，忽略

        const json = await this.fetchDblpResults(args.query, maxResults, startIndex);
        const results = this.parseSearchResults(json);

        if (results.length === 0) {
            return `未找到与 "${args.query}" 相关的DBLP论文。`;
        }

        return this.formatResults(args.query, results);
    }

    // ───────────────────── HTTP 请求 ─────────────────────

    private async fetchDblpResults(query: string, maxResults: number, start: number): Promise<any> {
        const url = new URL(DBLP_API_URL);
        url.searchParams.set('q', query);
        url.searchParams.set('format', 'json');
        url.searchParams.set('h', Math.min(maxResults, 1000).toString());
        url.searchParams.set('f', start.toString());
        url.searchParams.set('c', '0');

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        try {
            const response = await getPlatform().fetch(url.toString(), {
                method: 'GET',
                redirect: 'follow',
                signal: controller.signal
            });

            if (!response.ok) {
                throw new Error(`DBLP 请求失败，HTTP 状态码: ${response.status}`);
            }

            return await response.json();
        } catch (err: any) {
            if (err.name === 'AbortError') {
                throw new Error(`DBLP 搜索请求超时 (${FETCH_TIMEOUT_MS / 1000}秒)`);
            }
            throw err;
        } finally {
            clearTimeout(timer);
        }
    }

    // ───────────────────── JSON 解析 ─────────────────────

    private parseSearchResults(json: any): AcademicPaper[] {
        const results: AcademicPaper[] = [];
        const hits = json?.result?.hits?.hit;

        if (!hits) return results;

        const hitList = Array.isArray(hits) ? hits : [hits];

        for (const hit of hitList) {
            const info = hit?.info;
            if (!info) continue;

            const authors = info.authors?.author;
            const authorList: string[] = authors
                ? (Array.isArray(authors) ? authors : [authors]).map((a: any) =>
                      typeof a === 'string' ? a : a?.text || ''
                  )
                : [];

            results.push({
                title: BaseAcademicSearchEngine.safeStr(info.title),
                authors: authorList.filter(Boolean),
                year: BaseAcademicSearchEngine.safeStr(info.year),
                venue: BaseAcademicSearchEngine.safeStr(info.venue),
                doi: BaseAcademicSearchEngine.safeStr(info.doi),
                url: BaseAcademicSearchEngine.safeStr(info.url)
            });
        }

        return results;
    }
}
