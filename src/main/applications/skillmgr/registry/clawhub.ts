/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import { getPlatform } from '../../../../platforms/base.js';
import { SkillRegistryBase, type SearchOptions, type SearchResult } from './base.js';

const CLAWHUB_BASE = 'https://wry-manatee-359.convex.site';
const REQUEST_TIMEOUT = 30000;

export class ClawHubRegistry extends SkillRegistryBase {
    readonly id = 'clawhub';
    readonly label = 'ClawHub';
    readonly icon = '🐾';
    readonly iconClass = 'clawhub';

    override get slogan(): string {
        return '社区驱动，探索无限技能';
    }

    private mapItem(s: any): ReturnType<typeof Object> {
        const stats = s.stats || {};
        const authorRaw = s.ownerHandle || s.ownerName || s.owner || '';
        const author = typeof authorRaw === 'string' ? authorRaw : authorRaw.displayName || authorRaw.handle || '';
        return {
            id: s.slug || s.name || '',
            name: s.displayName || s.slug || s.name || '',
            description: s.summary || s.description || '',
            author,
            source: 'clawhub' as const,
            installUrl: `${this.installPrefix}${s.slug || s.name || ''}`,
            stars: stats.stars ?? s.totalStars ?? s.stars ?? 0,
            score: s.score ?? 0,
            downloads: stats.downloads ?? stats.installsAllTime ?? s.totalDownloads ?? 0,
            canInstall: !!(s.slug || s.name)
        };
    }

    async search(opts: SearchOptions = {}): Promise<SearchResult> {
        const { query = '', limit = 30, cursor } = opts;
        const trimmedQuery = query.trim();

        try {
            if (trimmedQuery) {
                const params = new URLSearchParams({
                    q: trimmedQuery,
                    limit: String(Math.min(limit, 100))
                });
                const res = await getPlatform().fetch(`${CLAWHUB_BASE}/api/v1/search?${params}`, {
                    headers: { Accept: 'application/json', 'User-Agent': 'OpenDesk/1.0' },
                    signal: AbortSignal.timeout(REQUEST_TIMEOUT)
                });
                if (!res.ok) throw new Error(`ClawHub 搜索请求失败: ${res.status}`);
                const data = await res.json();
                const results = Array.isArray(data.results) ? data.results : [];
                const skills = results.map((r: any) => this.mapItem(r));
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

            const res = await getPlatform().fetch(`${CLAWHUB_BASE}/api/v1/skills?${params}`, {
                headers: { Accept: 'application/json', 'User-Agent': 'OpenDesk/1.0' },
                signal: AbortSignal.timeout(REQUEST_TIMEOUT)
            });
            if (!res.ok) throw new Error(`ClawHub 列表请求失败: ${res.status}`);
            const data = await res.json();
            const items = Array.isArray(data.items) ? data.items : [];
            const skills = items.map((s: any) => this.mapItem(s));

            return {
                skills,
                total: skills.length,
                hasMore: !!data.nextCursor,
                nextCursor: data.nextCursor || undefined,
                message: skills.length > 0 ? `共 ${skills.length} 个结果` : undefined
            };
        } catch (e: any) {
            if (e.name === 'AbortError' || e.name === 'TimeoutError') {
                return { skills: [], total: 0, hasMore: false, message: 'ClawHub 请求超时，请稍后重试' };
            }
            return { skills: [], total: 0, hasMore: false, message: `ClawHub 搜索失败: ${e.message || '未知错误'}` };
        }
    }
}
