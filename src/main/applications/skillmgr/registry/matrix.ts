/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import { getPlatform } from '../../../../platforms/base.js';
import { SkillRegistryBase, type RegistryFilterDef, type SearchOptions, type SearchResult } from './base.js';

const MATRIX_BASE = 'https://matrix.openharmony.cn';
const REQUEST_TIMEOUT = 30000;

const HARMONY_PC_CATEGORY = '鸿蒙PC';

/** Matrix 上 OpenHarmonyPC 组织的 ID，对应 https://matrix.openharmony.cn/#/skillSquare?org=OpenHarmonyPC */
const MATRIX_ORG_ID = '6a0a7153656ab744ab860fb4';

const MATRIX_FILTERS: RegistryFilterDef[] = [
    {
        id: 'harmony_pc',
        labelOn: '鸿蒙PC兼容技能',
        labelOff: '所有技能',
        categoryValue: HARMONY_PC_CATEGORY,
        apiTagIds: ['69cbb330d91c6e543991815d']
    }
];

export class MatrixRegistry extends SkillRegistryBase {
    readonly id = 'matrix';
    readonly label = 'Matrix Skill';
    readonly icon = '🔷';
    readonly iconClass = 'matrix';

    override get slogan(): string {
        return '用技能，让你的Agent无所不能';
    }

    override get filters(): RegistryFilterDef[] {
        return MATRIX_FILTERS;
    }

    async search(opts: SearchOptions = {}): Promise<SearchResult> {
        const { query = '', page = 1, limit = 30, categoryFilter } = opts;

        try {
            const body: Record<string, any> = {
                pageNum: page,
                pageSize: limit,
                statusList: ['2', '3']
            };
            const trimmed = query.trim();
            if (trimmed) body.keyword = trimmed;

            // 服务端 tag + 组织过滤：比客户端过滤更精准，分页、计数都正确
            if (categoryFilter) {
                const filterDef = MATRIX_FILTERS.find((f) => f.categoryValue === categoryFilter);
                if (filterDef?.apiTagIds && filterDef.apiTagIds.length > 0) {
                    body.tagIds = filterDef.apiTagIds;
                    body.orgId = MATRIX_ORG_ID;
                }
            }

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
                const catNames: string[] = Array.isArray(s.categoryList)
                    ? s.categoryList.map((c: any) => c.cnName || c.enName || '').filter(Boolean)
                    : [];
                const tagNames: string[] = Array.isArray(s.tags)
                    ? s.tags.map((t: any) => t.name || t.enName || '').filter(Boolean)
                    : [];
                const allCatNames = [...new Set([...catNames, ...tagNames])];
                const cats = catNames.join(', ');
                return {
                    id: s.enName || String(s.id || ''),
                    name: s.name || s.enName || '',
                    description: s.description || s.name || '',
                    author: ownerName || cats,
                    source: 'matrix' as const,
                    installUrl: `${this.installPrefix}${s.enName || ''}`,
                    stars: s.favor ?? 0,
                    downloads: s.download ?? s.apiDownload ?? 0,
                    canInstall: !!s.enName,
                    categories: allCatNames
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
