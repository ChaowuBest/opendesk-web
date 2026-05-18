/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import { getPlatform } from '../../../../platforms/base.js';
import { SkillRegistryBase, type SearchOptions, type SearchResult } from './base.js';

const SKILLSMP_BASE = 'https://skillsmp.com';
const SKILLSMP_FALLBACK_THRESHOLD = 0;

function mapSkill(s: any) {
    const repo = s.repository || s.repo || s.github?.url || s.githubUrl || '';
    let installUrl = '';
    if (typeof repo === 'string' && repo.includes('github.com')) {
        installUrl = repo.replace('/blob/', '/tree/');
        if (!installUrl.includes('/tree/')) {
            installUrl = repo + (repo.endsWith('/') ? '' : '/') + 'tree/main';
        }
    } else if (s.downloadUrl || s.zipUrl) {
        installUrl = s.downloadUrl || s.zipUrl;
    }
    return {
        id: s.id || s.slug || s.name || '',
        name: s.name || s.title || s.id || '',
        description: s.description || '',
        author: s.author?.login ?? s.author ?? s.owner ?? '',
        source: 'skillsmp' as const,
        installUrl,
        stars: s.stars ?? s.stargazers_count ?? 0,
        canInstall: !!installUrl
    };
}

export class SkillsMPRegistry extends SkillRegistryBase {
    readonly id = 'skillsmp';
    readonly label = 'SkillsMP';
    readonly icon = '🏪';
    readonly iconClass = 'skillsmp';

    parseInstallUrl(_installUrl: string): { slug: string; version?: string } | null {
        return null;
    }

    private async fetchEndpoint(endpoint: string, opts: SearchOptions & { timeout?: number } = {}) {
        const { query = '', page = 1, limit = 20, apiKey, timeout = 15000 } = opts;
        if (!apiKey?.trim()) {
            throw new Error(
                'SkillsMP 需配置 API Key。请在 OpenDesk「设置」→ 应用配置 → Skills 中填写并保存后重试。获取 Key：https://skillsmp.com/auth/login'
            );
        }
        const params = new URLSearchParams({
            q: query.trim() || 'skill',
            limit: String(Math.min(limit, 100))
        });
        if (endpoint === 'search') params.set('page', String(page));

        const url = `${SKILLSMP_BASE}/api/v1/skills/${endpoint}?${params}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);
        try {
            const res = await getPlatform().fetch(url, {
                headers: { Authorization: `Bearer ${apiKey.trim()}` },
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                if (res.status === 401) throw new Error((err as any)?.error?.message || 'API Key 无效或已过期');
                throw new Error((err as any)?.error?.message || `SkillsMP 请求失败: ${res.status}`);
            }
            const data = await res.json();
            let items: any[] = [];
            if (endpoint === 'ai-search' && Array.isArray(data.data?.data)) {
                items = data.data.data.map((item: any) => item.skill).filter(Boolean);
            } else if (Array.isArray(data.data?.skills)) {
                items = data.data.skills;
            } else if (Array.isArray(data.data)) {
                items = data.data;
            } else if (Array.isArray(data)) {
                items = data;
            } else {
                items = data.items ?? data.results ?? [];
            }
            const list = Array.isArray(items) ? items : [];
            const total = data.data?.pagination?.total ?? data.data?.total ?? data.total ?? list.length;
            return { skills: list.map(mapSkill), total, hasMore: page * limit < (total ?? 0) };
        } catch (e: any) {
            clearTimeout(timeoutId);
            if (e.name === 'AbortError') throw new Error('SkillsMP 请求超时，请检查网络或稍后重试');
            throw e;
        }
    }

    async search(opts: SearchOptions = {}): Promise<SearchResult> {
        const result = await this.fetchEndpoint('search', opts);
        if (result.skills.length <= SKILLSMP_FALLBACK_THRESHOLD) {
            try {
                const aiResult = await this.fetchEndpoint('ai-search', { ...opts, timeout: 30000 });
                if (aiResult.skills.length > 0) {
                    return { ...aiResult, hasMore: false, message: '普通搜索无结果，已使用 AI 语义搜索补充' };
                }
            } catch {}
        }
        return result;
    }
}
