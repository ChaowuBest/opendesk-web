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

const API_BASE = 'https://api.skillhub.tencent.com';
const SKILLS_ENDPOINT = `${API_BASE}/api/skills`;
const REQUEST_TIMEOUT = 30000;
const MAX_PAGE_SIZE = 100;

/**
 * SkillHub 技能注册表（原 skillmgr/registry/skillhub.ts 的实现，经 registry capability 贡献）。
 * @param {{ fetch: typeof fetch }} registryApi 宿主注入的 registry 能力（fetch 继承代理配置）
 */
export function createSkillHubRegistryDefinition(registryApi) {
    function mapSkill(s) {
        return {
            id: s.slug || s.name || '',
            name: s.name || s.slug || '',
            description: s.description || s.description_zh || '',
            author: s.ownerName || '',
            source: 'skillhub',
            installUrl: `skillhub:${s.slug || s.name || ''}`,
            stars: s.stars || 0,
            downloads: s.downloads ?? s.downloadCount ?? s.download_count ?? 0,
            canInstall: true
        };
    }

    async function fetchPage(page, pageSize, query) {
        const params = new URLSearchParams({
            page: String(page),
            pageSize: String(pageSize),
            sortBy: 'downloads'
        });
        if (query) params.set('search', query);

        const res = await registryApi.fetch(`${SKILLS_ENDPOINT}?${params}`, {
            headers: { Accept: 'application/json', 'User-Agent': 'OpenDesk/1.0' },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT)
        });
        if (!res.ok) throw new Error(`SkillHub API 请求失败: ${res.status}`);

        const data = await res.json();
        if (data.code !== 0) throw new Error(data.message || 'SkillHub API 返回错误');
        return { skills: data.data?.skills || [], total: data.data?.total || 0 };
    }

    return {
        id: 'skillhub',
        label: 'SkillHub',
        icon: '💎',
        iconClass: 'skillhub',
        slogan: '专为中国用户优化的Skills社区',

        async search(opts = {}) {
            const { query = '', page = 1, limit = 20 } = opts;
            const trimmedQuery = query.trim();

            try {
                if (!trimmedQuery) {
                    const safeLimit = Math.min(limit, MAX_PAGE_SIZE);
                    const { skills: raw, total } = await fetchPage(page, safeLimit, undefined);
                    const skills = raw.map((s) => mapSkill(s));
                    return {
                        skills,
                        total,
                        hasMore: page * limit < total,
                        message: skills.length > 0 ? `显示 ${skills.length} / ${total} 个结果` : undefined
                    };
                }

                const fetchSize = Math.min(Math.max(limit * 3, 50), MAX_PAGE_SIZE);
                const { skills: raw } = await fetchPage(1, fetchSize, trimmedQuery);

                const tokens = trimmedQuery
                    .toLowerCase()
                    .split(/\s+/)
                    .filter((t) => t.length > 0);
                const filtered = raw.filter((s) => {
                    const name = (s.name || '').toLowerCase();
                    const slug = (s.slug || '').toLowerCase();
                    const desc = (s.description || '').toLowerCase();
                    const descZh = (s.description_zh || '').toLowerCase();
                    const tags = Array.isArray(s.tags) ? s.tags.join(' ').toLowerCase() : '';
                    const combined = `${name} ${slug} ${desc} ${descZh} ${tags}`;
                    return tokens.every((token) => combined.includes(token));
                });

                const serverSideWorked = filtered.length > 0 || raw.length < fetchSize;
                if (!serverSideWorked) {
                    return {
                        skills: [],
                        total: 0,
                        hasMore: false,
                        message: `未找到匹配"${trimmedQuery}"的技能`
                    };
                }

                const start = (page - 1) * limit;
                const paged = filtered.slice(start, start + limit);
                const skills = paged.map((s) => mapSkill(s));

                return {
                    skills,
                    total: filtered.length,
                    hasMore: start + limit < filtered.length,
                    message:
                        skills.length > 0
                            ? `显示 ${skills.length} / ${filtered.length} 个结果`
                            : `未找到匹配"${trimmedQuery}"的技能`
                };
            } catch (e) {
                if (e.name === 'AbortError' || e.name === 'TimeoutError') {
                    return { skills: [], total: 0, hasMore: false, message: 'SkillHub 搜索超时，请稍后重试' };
                }
                return {
                    skills: [],
                    total: 0,
                    hasMore: false,
                    message: `SkillHub 搜索失败: ${e.message || '未知错误'}`
                };
            }
        }
    };
}
