/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import { getPlatform } from '../../../../platforms/base.js';
import { SkillRegistryBase, type SearchOptions, type SearchResult } from './base.js';

const MATRIX_BASE = 'https://matrix.openharmony.cn';
const REQUEST_TIMEOUT = 30000;

export class MatrixRegistry extends SkillRegistryBase {
    readonly id = 'matrix';
    readonly label = 'Matrix Skill';
    readonly icon = '🔷';
    readonly iconClass = 'matrix';

    override get slogan(): string {
        return '用技能，让你的Agent无所不能';
    }

    async search(opts: SearchOptions = {}): Promise<SearchResult> {
        const { query = '', page = 1, limit = 30 } = opts;

        try {
            const body: Record<string, any> = {
                pageNum: page,
                pageSize: limit,
                statusList: ['2', '3']
            };
            const trimmed = query.trim();
            if (trimmed) body.keyword = trimmed;

            const res = await getPlatform().fetch(`${MATRIX_BASE}/api/registry/skill/skills`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                    'User-Agent': 'OpenDesk/1.0'
                },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(REQUEST_TIMEOUT)
            });

            if (!res.ok) throw new Error(`Matrix API 请求失败: ${res.status}`);
            const data = await res.json();

            const records = data?.data?.list || data?.data?.records || [];
            const total = data?.data?.count || data?.data?.total || records.length;

            const skills = records.map((s: any) => {
                const ownerName = s.owner?.cnName || s.owner?.enName || s.owner?.account || '';
                const cats = Array.isArray(s.categoryList)
                    ? s.categoryList
                          .map((c: any) => c.cnName || c.enName || '')
                          .filter(Boolean)
                          .join(', ')
                    : '';
                return {
                    id: s.enName || String(s.id || ''),
                    name: s.enName || s.name || '',
                    description: s.description || s.name || '',
                    author: ownerName || cats,
                    source: 'matrix' as const,
                    installUrl: `${this.installPrefix}${s.enName || ''}`,
                    stars: s.favor ?? 0,
                    downloads: s.download ?? s.apiDownload ?? 0,
                    canInstall: !!s.enName
                };
            });

            return {
                skills,
                total,
                hasMore: page * limit < total,
                message: skills.length > 0 ? `显示 ${skills.length} / ${total} 个结果` : undefined
            };
        } catch (e: any) {
            if (e.name === 'AbortError' || e.name === 'TimeoutError') {
                return { skills: [], total: 0, hasMore: false, message: 'Matrix Skill 请求超时，请稍后重试' };
            }
            return {
                skills: [],
                total: 0,
                hasMore: false,
                message: `Matrix Skill 搜索失败: ${e.message || '未知错误'}`
            };
        }
    }
}
