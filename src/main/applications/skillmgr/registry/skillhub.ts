/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import { SkillRegistryBase, type SearchOptions, type SearchResult } from './base.js';

const API_BASE = 'https://api.skillhub.tencent.com';
const SKILLS_ENDPOINT = `${API_BASE}/api/skills`;
const REQUEST_TIMEOUT = 30000;
const MAX_PAGE_SIZE = 100;

export class SkillHubRegistry extends SkillRegistryBase {
    readonly id = 'skillhub';
    readonly label = 'SkillHub';
    readonly icon = '💎';
    readonly iconClass = 'skillhub';

    override get slogan(): string {
        return '专为中国用户优化的Skills社区';
    }

    private mapSkill(s: any) {
        return {
            id: s.slug || s.name || '',
            name: s.name || s.slug || '',
            description: s.description || s.description_zh || '',
            author: s.ownerName || '',
            source: 'skillhub' as const,
            installUrl: `${this.installPrefix}${s.slug || s.name || ''}`,
            stars: s.stars || 0,
            downloads: s.downloads ?? s.downloadCount ?? s.download_count ?? 0,
            canInstall: true
        };
    }

    private async fetchPage(page: number, pageSize: number, query?: string) {
        const params = new URLSearchParams({
            page: String(page),
            pageSize: String(pageSize),
            sortBy: 'downloads'
        });
        if (query) params.set('search', query);

        const res = await fetch(`${SKILLS_ENDPOINT}?${params}`, {
            headers: { Accept: 'application/json', 'User-Agent': 'OpenDesk/1.0' },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT)
        });
        if (!res.ok) throw new Error(`SkillHub API 请求失败: ${res.status}`);

        const data = await res.json();
        if (data.code !== 0) throw new Error(data.message || 'SkillHub API 返回错误');
        return { skills: data.data?.skills || [], total: data.data?.total || 0 };
    }

    async search(opts: SearchOptions = {}): Promise<SearchResult> {
        const { query = '', page = 1, limit = 20 } = opts;
        const trimmedQuery = query.trim();

        try {
            if (!trimmedQuery) {
                const safeLimit = Math.min(limit, MAX_PAGE_SIZE);
                const { skills: raw, total } = await this.fetchPage(page, safeLimit, undefined);
                const skills = raw.map((s: any) => this.mapSkill(s));
                return {
                    skills,
                    total,
                    hasMore: page * limit < total,
                    message: skills.length > 0 ? `显示 ${skills.length} / ${total} 个结果` : undefined
                };
            }

            const fetchSize = Math.min(Math.max(limit * 3, 50), MAX_PAGE_SIZE);
            const { skills: raw, total } = await this.fetchPage(1, fetchSize, trimmedQuery);

            const q = trimmedQuery.toLowerCase();
            const filtered = raw.filter((s: any) => {
                const name = (s.name || '').toLowerCase();
                const slug = (s.slug || '').toLowerCase();
                const desc = (s.description || '').toLowerCase();
                const descZh = (s.description_zh || '').toLowerCase();
                const tags = Array.isArray(s.tags) ? s.tags.join(' ').toLowerCase() : '';
                return (
                    name.includes(q) || slug.includes(q) || desc.includes(q) || descZh.includes(q) || tags.includes(q)
                );
            });

            const serverSideWorked = filtered.length > 0 || raw.length < fetchSize;
            const resultSkills = serverSideWorked ? filtered : raw;

            const start = (page - 1) * limit;
            const paged = resultSkills.slice(start, start + limit);
            const skills = paged.map((s: any) => this.mapSkill(s));

            return {
                skills,
                total: serverSideWorked ? filtered.length : total,
                hasMore: start + limit < resultSkills.length,
                message:
                    skills.length > 0
                        ? `显示 ${skills.length} / ${serverSideWorked ? filtered.length : total} 个结果`
                        : undefined
            };
        } catch (e: any) {
            if (e.name === 'AbortError' || e.name === 'TimeoutError') {
                return { skills: [], total: 0, hasMore: false, message: 'SkillHub 搜索超时，请稍后重试' };
            }
            return { skills: [], total: 0, hasMore: false, message: `SkillHub 搜索失败: ${e.message || '未知错误'}` };
        }
    }
}
