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

const MATRIX_BASE = 'https://matrix.openharmony.cn';
const REQUEST_TIMEOUT = 30000;

const HARMONY_PC_CATEGORY = '鸿蒙PC';

/** Matrix 上 OpenHarmonyPC 组织的 ID，对应 https://matrix.openharmony.cn/#/skillSquare?org=OpenHarmonyPC */
const MATRIX_ORG_ID = '6a0a7153656ab744ab860fb4';

const MATRIX_FILTERS = [
    {
        id: 'harmony_pc',
        labelOn: '鸿蒙PC兼容技能',
        labelOff: '所有技能',
        categoryValue: HARMONY_PC_CATEGORY,
        apiTagIds: ['69cbb330d91c6e543991815d'],
        // 鸿蒙PC 兼容技能只在鸿蒙平台有意义，其他平台不下发该筛选器
        platforms: ['openharmony']
    }
];

/**
 * Matrix 技能注册表（原 skillmgr/registry/matrix.ts 的实现，经 registry capability 贡献）。
 * @param {{ fetch: typeof fetch }} registryApi 宿主注入的 registry 能力（fetch 继承代理配置）
 */
export function createMatrixSkillRegistryDefinition(registryApi) {
    return {
        id: 'matrix',
        label: 'Matrix Skill',
        icon: '🔷',
        iconClass: 'matrix',
        slogan: '用技能，让你的Agent无所不能',
        filters: MATRIX_FILTERS,

        async search(opts = {}) {
            const { query = '', page = 1, limit = 30, categoryFilter } = opts;

            try {
                const body = {
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

                const res = await registryApi.fetch(`${MATRIX_BASE}/api/registry/skill/skills`, {
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

                const skills = records.map((s) => {
                    const ownerName = s.owner?.cnName || s.owner?.enName || s.owner?.account || '';
                    const catNames = Array.isArray(s.categoryList)
                        ? s.categoryList.map((c) => c.cnName || c.enName || '').filter(Boolean)
                        : [];
                    const tagNames = Array.isArray(s.tags)
                        ? s.tags.map((t) => t.name || t.enName || '').filter(Boolean)
                        : [];
                    const allCatNames = [...new Set([...catNames, ...tagNames])];
                    const cats = catNames.join(', ');
                    return {
                        id: s.enName || String(s.id || ''),
                        name: s.name || s.enName || '',
                        description: s.description || s.name || '',
                        author: ownerName || cats,
                        source: 'matrix',
                        installUrl: `matrix:${s.enName || ''}`,
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
            } catch (e) {
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
    };
}
