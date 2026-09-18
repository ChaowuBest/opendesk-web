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

const SKILL0_BASE = 'https://skill0.io';

/**
 * skill0.io 技能注册表（原 skillmgr/registry/skill0.ts 的实现，经 registry capability 贡献）。
 * guiHidden: 仅 agent 工具与 TUI 可用，不在 GUI 市场展示（与迁移前 GUI 行为一致）。
 * @param {{ fetch: typeof fetch }} registryApi 宿主注入的 registry 能力（fetch 继承代理配置）
 */
export function createSkill0RegistryDefinition(registryApi) {
    return {
        id: 'skill0',
        label: 'skill0.io',
        icon: '📦',
        iconClass: 'skill0',
        guiHidden: true,

        async search(opts = {}) {
            const { query = '', page = 1, limit = 20 } = opts;
            const params = new URLSearchParams({ page: String(page), limit: String(limit) });
            if (query.trim()) params.set('search', query.trim());

            const res = await registryApi.fetch(`${SKILL0_BASE}/api/skills?${params}`);
            if (!res.ok) throw new Error(`skill0 请求失败: ${res.status}`);

            const data = await res.json();
            const skills = (data.skills || []).map((s) => {
                const githubUrl = s.githubUrl || '';
                const canInstall = githubUrl.startsWith('https://github.com/');
                return {
                    id: s.id || s.name,
                    name: s.name || s.id || '',
                    description: s.description || '',
                    author: s.author || '',
                    source: 'skill0',
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
    };
}
