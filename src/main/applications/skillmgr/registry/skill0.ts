/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import { SkillRegistryBase, type SearchOptions, type SearchResult } from './base.js';

const SKILL0_BASE = 'https://skill0.io';

export class Skill0Registry extends SkillRegistryBase {
    readonly id = 'skill0';
    readonly label = 'skill0.io';
    readonly icon = '📦';
    readonly iconClass = 'skill0';

    parseInstallUrl(_installUrl: string): { slug: string; version?: string } | null {
        return null;
    }

    async search(opts: SearchOptions = {}): Promise<SearchResult> {
        const { query = '', page = 1, limit = 20 } = opts;
        const params = new URLSearchParams({ page: String(page), limit: String(limit) });
        if (query.trim()) params.set('search', query.trim());

        const res = await fetch(`${SKILL0_BASE}/api/skills?${params}`);
        if (!res.ok) throw new Error(`skill0 请求失败: ${res.status}`);

        const data = await res.json();
        const skills = (data.skills || []).map((s: any) => {
            const githubUrl = s.githubUrl || '';
            const canInstall = githubUrl.startsWith('https://github.com/');
            return {
                id: s.id || s.name,
                name: s.name || s.id || '',
                description: s.description || '',
                author: s.author || '',
                source: 'skill0' as const,
                installUrl: canInstall ? githubUrl : '',
                stars: s.stars ?? 0,
                canInstall
            };
        });
        const pagination = data.pagination || {};
        return {
            skills,
            total: pagination.total,
            hasMore: !!pagination.hasNext
        };
    }
}
