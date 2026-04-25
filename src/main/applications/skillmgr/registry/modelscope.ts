/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import { SkillRegistryBase, type SearchOptions, type SearchResult } from './base.js';

const BASE_URL = 'https://www.modelscope.cn';
const SKILLS_LIST_ENDPOINT = `${BASE_URL}/api/v1/dolphin/skills`;
const REQUEST_TIMEOUT = 30000;

export class ModelScopeRegistry extends SkillRegistryBase {
    readonly id = 'modelscope';
    readonly label = 'ModelScope';
    readonly icon = '🔮';
    readonly iconClass = 'modelscope';

    private async initCookies(): Promise<void> {
        try {
            await fetch(`${BASE_URL}/skills`, { signal: AbortSignal.timeout(10000) });
        } catch {
            // best-effort cookie init
        }
    }

    private async fetchSkills(body: Record<string, any>): Promise<Response> {
        return fetch(SKILLS_LIST_ENDPOINT, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) OpenDesk/1.0'
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT)
        });
    }

    async search(opts: SearchOptions = {}): Promise<SearchResult> {
        const { query = '', page = 1, limit = 20 } = opts;
        const body = {
            PageSize: limit,
            PageNumber: page,
            Query: query.trim(),
            Sort: 'DownloadCount',
            Criterion: []
        };

        try {
            let res: Response;
            try {
                res = await this.fetchSkills(body);
            } catch {
                await this.initCookies();
                res = await this.fetchSkills(body);
            }

            if (!res.ok) throw new Error(`ModelScope API 请求失败: ${res.status}`);

            const data = await res.json();
            if (data.Code !== 200) {
                throw new Error(data.Message || 'ModelScope API 返回错误');
            }

            const skillList = data.Data?.SkillList || [];
            const totalCount = data.Data?.TotalCount || 0;

            const skills = skillList.map((s: any) => ({
                id: s.Name || '',
                name: s.DisplayName || s.Name || '',
                description: s.DescriptionEn || s.Description || '',
                author: s.Owner || s.SourceDeveloper || '',
                source: 'modelscope' as const,
                installUrl: `${this.installPrefix}${s.Name || ''}`,
                stars: s.SourceStar || 0,
                canInstall: true
            }));

            return {
                skills,
                total: totalCount,
                hasMore: page * limit < totalCount,
                message: skills.length > 0 ? `显示 ${skills.length} / ${totalCount} 个结果` : undefined
            };
        } catch (e: any) {
            if (e.name === 'AbortError' || e.name === 'TimeoutError') {
                return { skills: [], total: 0, hasMore: false, message: 'ModelScope 搜索超时，请稍后重试' };
            }
            return { skills: [], total: 0, hasMore: false, message: `ModelScope 搜索失败: ${e.message || '未知错误'}` };
        }
    }
}
