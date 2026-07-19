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
import { SkillRegistryBase, type SearchOptions, type SearchResult } from './base.js';

const BASE_URL = 'https://www.modelscope.cn';
const SKILLS_LIST_ENDPOINT = `${BASE_URL}/api/v1/dolphin/skills`;
const REQUEST_TIMEOUT = 30000;

export class ModelScopeRegistry extends SkillRegistryBase {
    readonly id = 'modelscope';
    readonly label = 'ModelScope';
    readonly icon = '🔮';
    readonly iconClass = 'modelscope';

    override get slogan(): string {
        return '汇聚社区技能组件，定义模型无限可能';
    }

    private async initCookies(): Promise<void> {
        try {
            await getPlatform().fetch(`${BASE_URL}/skills`, { signal: AbortSignal.timeout(10000) });
        } catch {
            // best-effort cookie init
        }
    }

    private async fetchSkills(body: Record<string, any>): Promise<Response> {
        return getPlatform().fetch(SKILLS_LIST_ENDPOINT, {
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

            const skills = skillList.map((s: any) => {
                const sourceUrl = (s.SourceURL || '').trim();
                const isGitHubTree = sourceUrl.includes('github.com') && sourceUrl.includes('/tree/');
                const isGitHubRepo = !isGitHubTree && /github\.com\/[^/]+\/[^/]+/.test(sourceUrl);
                let installUrl: string;
                if (isGitHubTree) {
                    installUrl = sourceUrl;
                } else if (isGitHubRepo) {
                    installUrl = sourceUrl.replace(/\/+$/, '') + '/tree/main';
                } else {
                    installUrl = `${this.installPrefix}${s.Owner ? s.Owner + '/' : ''}${s.Name || ''}`;
                }
                return {
                    id: s.Name || '',
                    name: s.DisplayName || s.Name || '',
                    description: s.DescriptionEn || s.Description || '',
                    author: s.Path?.replace(/^@/, '') || s.SourceDeveloper || s.Owner || '',
                    source: 'modelscope' as const,
                    installUrl,
                    stars: s.SourceStar || 0,
                    downloads: s.DownloadCount ?? 0,
                    canInstall: !!(isGitHubTree || isGitHubRepo || (s.Owner && s.Name))
                };
            });

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
