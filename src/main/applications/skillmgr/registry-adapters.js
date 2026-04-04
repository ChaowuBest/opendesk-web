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

/**
 * 第三方 Skill Registry 适配器：skill0、skillsmp、clawhub
 * 统一搜索接口，返回 { id, name, description, author, source, installUrl, stars? }
 * installUrl 用于 SkillRegistry.addSkillFromGitHubUrl 或 addSkillFromUrl
 */

const SKILL0_BASE = 'https://skill0.io';
const SKILLSMP_BASE = 'https://skillsmp.com';
const CLAWHUB_BASE = 'https://clawhub.ai';
/** 通过 slug 安装时的 installUrl 前缀，格式 clawhub:slug 或 clawhub:slug@version */
const CLAWHUB_INSTALL_PREFIX = 'clawhub:';

/**
 * @typedef {Object} RegistrySkill
 * @property {string} id - 唯一标识
 * @property {string} name - 技能名称
 * @property {string} description - 描述
 * @property {string} [author] - 作者
 * @property {string} source - 来源：skill0 | skillsmp | clawhub
 * @property {string} installUrl - 安装用的 URL（GitHub tree 或 zip）
 * @property {number} [stars] - 星标数
 */

/**
 * skill0 搜索
 * @param {Object} opts - { query: string, page?: number, limit?: number }
 * @returns {Promise<{ skills: RegistrySkill[], total?: number, hasMore?: boolean }>}
 */
async function searchSkill0(opts = {}) {
    const { query = '', page = 1, limit = 20 } = opts;
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (query.trim()) params.set('search', query.trim());
    const url = `${SKILL0_BASE}/api/skills?${params}`;
    const res = await fetch(url);
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

const SKILLSMP_FALLBACK_THRESHOLD = 0;

function mapSkillsMPSkill(s) {
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

async function fetchSkillsMP(endpoint, opts = {}) {
    const { query = '', page = 1, limit = 20, apiKey, timeout = 15000 } = opts;
    if (!apiKey || !apiKey.trim()) {
        throw new Error(
            'SkillsMP 需配置 API Key。请在 FillipDesk「设置」→ 应用配置 → Skills 中填写并保存后重试。获取 Key：https://skillsmp.com/auth/login'
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
        const res = await fetch(url, {
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
        return { skills: list.map(mapSkillsMPSkill), total, hasMore: page * limit < (total ?? 0) };
    } catch (e) {
        clearTimeout(timeoutId);
        if (e.name === 'AbortError') throw new Error('SkillsMP 请求超时，请检查网络或稍后重试');
        throw e;
    }
}

async function searchSkillsMP(opts = {}) {
    const { query, page, limit, apiKey } = opts;
    const result = await fetchSkillsMP('search', { query, page, limit, apiKey });
    if (result.skills.length <= SKILLSMP_FALLBACK_THRESHOLD) {
        try {
            const aiResult = await fetchSkillsMP('ai-search', {
                query,
                limit,
                apiKey,
                timeout: 30000
            });
            if (aiResult.skills.length > 0) {
                return {
                    ...aiResult,
                    hasMore: false,
                    message: '普通搜索无结果，已使用 AI 语义搜索补充'
                };
            }
        } catch (_) {}
    }
    return result;
}

/**
 * ClawHub 搜索：尝试公开 API；若无则返回空并提示。技能安装通过 installUrl = clawhub:slug 或 clawhub:slug@version 由 worker 调 clawhub CLI 安装。
 * @param {Object} opts - { query: string, page?: number, limit?: number }
 * @returns {Promise<{ skills: RegistrySkill[], total?: number, hasMore?: boolean, message?: string }>}
 */
async function searchClawHub(opts = {}) {
    const { query = '', page = 1, limit = 20 } = opts;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    try {
        const params = new URLSearchParams();
        if (query.trim()) params.set('q', query.trim());
        params.set('limit', String(limit));
        params.set('offset', String((page - 1) * limit));
        const url = `${CLAWHUB_BASE}/api/skills?${params}`;
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const rawList = Array.isArray(data) ? data : (data.skills ?? data.data ?? data.items ?? []);
        const skills = rawList.map((s) => {
            const slug = s.slug ?? s.id ?? s.name ?? '';
            const version = s.version ?? s.latestVersion;
            const installUrl = slug
                ? version
                    ? `${CLAWHUB_INSTALL_PREFIX}${slug}@${version}`
                    : `${CLAWHUB_INSTALL_PREFIX}${slug}`
                : '';
            return {
                id: slug || s.id || s.name,
                name: s.name ?? s.title ?? slug ?? '',
                description: s.description ?? s.summary ?? '',
                author: s.author?.name ?? s.author ?? s.owner ?? '',
                source: 'clawhub',
                installUrl,
                stars: s.stars ?? s.stargazersCount ?? 0,
                canInstall: !!slug
            };
        });
        const total = data.total ?? data.pagination?.total ?? skills.length;
        return {
            skills,
            total,
            hasMore: page * limit < (total ?? 0)
        };
    } catch (_) {
        clearTimeout(timeoutId);
    }
    return {
        skills: [],
        total: 0,
        hasMore: false,
        message:
            'ClawHub 暂未提供公开搜索 API。请在上方输入框中输入技能 slug（如 my-skill）或 my-skill@1.2.3，点击「按 slug 安装」。需已安装 clawhub CLI：npm i -g clawhub'
    };
}

/**
 * 解析 clawhub:slug 或 clawhub:slug@version 格式的 installUrl
 * @param {string} installUrl
 * @returns {{ slug: string, version?: string } | null}
 */
function parseClawHubInstallUrl(installUrl) {
    if (!installUrl || typeof installUrl !== 'string' || !installUrl.startsWith(CLAWHUB_INSTALL_PREFIX)) {
        return null;
    }
    const rest = installUrl.slice(CLAWHUB_INSTALL_PREFIX.length).trim();
    if (!rest) return null;
    const at = rest.indexOf('@');
    if (at === -1) return { slug: rest };
    return { slug: rest.slice(0, at), version: rest.slice(at + 1).trim() || undefined };
}

/**
 * 根据 registryId 调用对应搜索
 * @param {string} registryId - skill0 | skillsmp | clawhub
 * @param {Object} opts - { query, page, limit, apiKey? }
 */
async function searchRegistry(registryId, opts = {}) {
    switch (registryId) {
        case 'skill0':
            return searchSkill0(opts);
        case 'skillsmp':
            return searchSkillsMP(opts);
        case 'clawhub':
            return searchClawHub(opts);
        default:
            throw new Error(`未知 Registry: ${registryId}`);
    }
}

/**
 * 判断 installUrl 的安装方式：clawhub:slug | github tree | zip
 * @param {string} installUrl
 * @returns {'clawhub' | 'github' | 'zip'}
 */
function getInstallMethod(installUrl) {
    if (!installUrl || typeof installUrl !== 'string') return 'zip';
    if (installUrl.startsWith(CLAWHUB_INSTALL_PREFIX)) return 'clawhub';
    return installUrl.includes('github.com') && installUrl.includes('/tree/') ? 'github' : 'zip';
}

export const RegistryAdapters = {
    searchSkill0,
    searchSkillsMP,
    searchClawHub,
    searchRegistry,
    getInstallMethod,
    parseClawHubInstallUrl,
    CLAWHUB_INSTALL_PREFIX
};
