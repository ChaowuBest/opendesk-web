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

const CLAWHUB_BASE = 'https://wry-manatee-359.convex.site';
const REQUEST_TIMEOUT = 30000;

/** 发布者 handle：下载接口在 slug 撞名（多个发布者使用同一 slug）时要求 ownerHandle 消歧 */
function resolveOwnerHandle(s) {
    if (typeof s?.ownerHandle === 'string' && s.ownerHandle) return s.ownerHandle;
    if (s?.owner && typeof s.owner === 'object' && typeof s.owner.handle === 'string') return s.owner.handle;
    return '';
}

/**
 * ClawHub 技能注册表（原 skillmgr/registry/clawhub.ts 的实现，经 registry capability 贡献）。
 * @param {{ fetch: typeof fetch }} registryApi 宿主注入的 registry 能力（fetch 继承代理配置）
 */
export function createClawHubRegistryDefinition(registryApi) {
    function mapItem(s) {
        const stats = s.stats || {};
        const authorRaw = s.ownerHandle || s.ownerName || s.owner || '';
        const author = typeof authorRaw === 'string' ? authorRaw : authorRaw.displayName || authorRaw.handle || '';
        const slug = s.slug || s.name || '';
        const ownerHandle = resolveOwnerHandle(s);
        return {
            id: slug,
            name: s.displayName || s.slug || s.name || '',
            description: s.summary || s.description || '',
            author,
            source: 'clawhub',
            installUrl: `clawhub:${ownerHandle ? `${ownerHandle}/` : ''}${slug}`,
            stars: stats.stars ?? s.totalStars ?? s.stars ?? 0,
            score: s.score ?? 0,
            downloads: stats.downloads ?? stats.installsAllTime ?? s.totalDownloads ?? 0,
            canInstall: !!slug
        };
    }

    return {
        id: 'clawhub',
        label: 'ClawHub',
        icon: '🐾',
        iconClass: 'clawhub',
        slogan: '社区驱动，探索无限技能',

        async search(opts = {}) {
            const { query = '', limit = 30, cursor } = opts;
            const trimmedQuery = query.trim();

            try {
                if (trimmedQuery) {
                    const params = new URLSearchParams({
                        q: trimmedQuery,
                        limit: String(Math.min(limit, 100))
                    });
                    const res = await registryApi.fetch(`${CLAWHUB_BASE}/api/v1/search?${params}`, {
                        headers: { Accept: 'application/json', 'User-Agent': 'OpenDesk/1.0' },
                        signal: AbortSignal.timeout(REQUEST_TIMEOUT)
                    });
                    if (!res.ok) throw new Error(`ClawHub 搜索请求失败: ${res.status}`);
                    const data = await res.json();
                    const results = Array.isArray(data.results) ? data.results : [];
                    const skills = results.map((r) => mapItem(r));
                    return {
                        skills,
                        total: skills.length,
                        hasMore: false,
                        message: skills.length > 0 ? `共 ${skills.length} 个搜索结果` : undefined
                    };
                }

                const params = new URLSearchParams({
                    sort: 'downloads',
                    limit: String(Math.min(limit, 100))
                });
                if (cursor) params.set('cursor', cursor);

                const res = await registryApi.fetch(`${CLAWHUB_BASE}/api/v1/skills?${params}`, {
                    headers: { Accept: 'application/json', 'User-Agent': 'OpenDesk/1.0' },
                    signal: AbortSignal.timeout(REQUEST_TIMEOUT)
                });
                if (!res.ok) throw new Error(`ClawHub 列表请求失败: ${res.status}`);
                const data = await res.json();
                const items = Array.isArray(data.items) ? data.items : [];
                const skills = items.map((s) => mapItem(s));

                return {
                    skills,
                    total: skills.length,
                    hasMore: !!data.nextCursor,
                    nextCursor: data.nextCursor || undefined,
                    message: skills.length > 0 ? `共 ${skills.length} 个结果` : undefined
                };
            } catch (e) {
                if (e.name === 'AbortError' || e.name === 'TimeoutError') {
                    return { skills: [], total: 0, hasMore: false, message: 'ClawHub 请求超时，请稍后重试' };
                }
                return {
                    skills: [],
                    total: 0,
                    hasMore: false,
                    message: `ClawHub 搜索失败: ${e.message || '未知错误'}`
                };
            }
        }
    };
}
