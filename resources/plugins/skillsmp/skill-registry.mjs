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

const SKILLSMP_BASE = 'https://skillsmp.com';
const SKILLSMP_FALLBACK_THRESHOLD = 0;

function mapSkill(s) {
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
        source: 'skillsmp',
        installUrl,
        stars: s.stars ?? s.stargazers_count ?? 0,
        canInstall: !!installUrl
    };
}

/**
 * SkillsMP 技能注册表（原 skillmgr/registry/skillsmp.ts 的实现，经 registry capability 贡献）。
 * 依赖 API Key（宿主从应用配置读取后经 options.apiKey 注入）；guiHidden: 不在 GUI 市场展示。
 * @param {{ fetch: typeof fetch }} registryApi 宿主注入的 registry 能力（fetch 继承代理配置）
 */
export function createSkillsMPRegistryDefinition(registryApi) {
    async function fetchEndpoint(endpoint, opts = {}) {
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
            const res = await registryApi.fetch(url, {
                headers: { Authorization: `Bearer ${apiKey.trim()}` },
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                if (res.status === 401) throw new Error(err?.error?.message || 'API Key 无效或已过期');
                throw new Error(err?.error?.message || `SkillsMP 请求失败: ${res.status}`);
            }
            const data = await res.json();
            let items = [];
            if (endpoint === 'ai-search' && Array.isArray(data.data?.data)) {
                items = data.data.data.map((item) => item.skill).filter(Boolean);
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
        } catch (e) {
            clearTimeout(timeoutId);
            if (e.name === 'AbortError') throw new Error('SkillsMP 请求超时，请检查网络或稍后重试');
            throw e;
        }
    }

    return {
        id: 'skillsmp',
        label: 'SkillsMP',
        icon: '🏪',
        iconClass: 'skillsmp',
        guiHidden: true,

        async search(opts = {}) {
            const result = await fetchEndpoint('search', opts);
            if (result.skills.length <= SKILLSMP_FALLBACK_THRESHOLD) {
                try {
                    const aiResult = await fetchEndpoint('ai-search', { ...opts, timeout: 30000 });
                    if (aiResult.skills.length > 0) {
                        return { ...aiResult, hasMore: false, message: '普通搜索无结果，已使用 AI 语义搜索补充' };
                    }
                } catch {
                    // AI 语义搜索兜底失败时保持普通搜索结果
                }
            }
            return result;
        }
    };
}
