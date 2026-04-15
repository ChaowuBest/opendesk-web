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
 * 第三方 Skill Registry 适配器：skill0、skillsmp、clawhub、matrix
 * 统一搜索接口，返回 { id, name, description, author, source, installUrl, stars? }
 * installUrl 用于上层安装器统一处理（下载/解压/CLI）后再从目录安装
 */

import { spawn } from 'child_process';

const SKILL0_BASE = 'https://skill0.io';
const SKILLSMP_BASE = 'https://skillsmp.com';
const CLAWHUB_BASE = 'https://clawhub.ai';
/** 通过 slug 安装时的 installUrl 前缀，格式 clawhub:slug 或 clawhub:slug@version */
const CLAWHUB_INSTALL_PREFIX = 'clawhub:';
/** 通过 Matrix CLI 安装时的 installUrl 前缀，格式 matrix:enName */
const MATRIX_INSTALL_PREFIX = 'matrix:';

/**
 * @typedef {Object} RegistrySkill
 * @property {string} id - 唯一标识
 * @property {string} name - 技能名称
 * @property {string} description - 描述
 * @property {string} [author] - 作者
 * @property {string} source - 来源：skill0 | skillsmp | clawhub | matrix
 * @property {string} installUrl - 安装用的 URL（GitHub tree 或 zip 或 matrix:enName 等）
 * @property {number} [stars] - 星标数
 * @property {boolean} canInstall - 是否可直接安装
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
 * ClawHub 搜索：通过 npx clawhub@latest search <query> --limit <n> 实现。
 * 输出格式：slug  描述  (分数)
 * @param {Object} opts - { query: string, page?: number, limit?: number }
 * @returns {Promise<{ skills: RegistrySkill[], total?: number, hasMore?: boolean, message?: string }>}
 */
async function searchClawHub(opts = {}) {
    const { query = '', page = 1, limit = 20 } = opts;
    const safeQuery = query.trim() || 'skill';

    const run = () =>
        new Promise((resolve, reject) => {
            const child = spawn('npx', ['clawhub@latest', 'search', safeQuery, '--limit', String(limit)], {
                shell: process.platform === 'win32',
                stdio: ['ignore', 'pipe', 'pipe']
            });
            let stdout = '';
            let stderr = '';
            child.stdout?.on('data', (ch) => {
                stdout += ch;
            });
            child.stderr?.on('data', (ch) => {
                stderr += ch;
            });
            child.on('error', (err) => reject(err));
            child.on('close', (code) => resolve({ code, stdout, stderr }));
        });

    try {
        const { code, stdout, stderr } = await run();
        if (code !== 0) {
            throw new Error((stderr || '').trim() || `ClawHub CLI 退出码 ${code}`);
        }
        const lines = stdout.split(/\r?\n/);
        const skills = [];
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('-') || trimmed.startsWith('*')) continue;
            // 格式：slug  描述  (分数)
            const match = trimmed.match(/^([^\s]+)\s+(.+?)\s+\((\d+\.?\d*)\)$/);
            if (match) {
                const [, slug, description, scoreStr] = match;
                skills.push({
                    id: slug,
                    name: slug,
                    description: description.trim(),
                    author: '',
                    source: 'clawhub',
                    installUrl: `${CLAWHUB_INSTALL_PREFIX}${slug}`,
                    stars: 0,
                    score: parseFloat(scoreStr) || 0,
                    canInstall: true
                });
            }
        }
        const total = skills.length;
        return {
            skills,
            total,
            hasMore: false,
            message: skills.length > 0 ? `显示 ${skills.length} / ${skills.length} 个结果` : undefined
        };
    } catch (e) {
        return {
            skills: [],
            total: 0,
            hasMore: false,
            message: `ClawHub 搜索失败: ${e.message || '未知错误'}`
        };
    }
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
 * Matrix Skill 搜索：通过 Matrix CLI 搜索并解析表格输出。
 * @param {Object} opts - { query: string, page?: number, limit?: number }
 * @returns {Promise<{ skills: RegistrySkill[], total?: number, hasMore?: boolean, message?: string }>}
 */
async function searchMatrix(opts = {}) {
    const { query = '', page = 1, limit = 20 } = opts;
    const safeQuery = query.trim() || 'skill';

    const run = () =>
        new Promise((resolve, reject) => {
            const child = spawn('npx', ['@matrixopenharmony/matrix-cli', 'skill', 'search', safeQuery], {
                shell: process.platform === 'win32',
                stdio: ['ignore', 'pipe', 'pipe']
            });
            let stdout = '';
            let stderr = '';
            child.stdout?.on('data', (ch) => {
                stdout += ch;
            });
            child.stderr?.on('data', (ch) => {
                stderr += ch;
            });
            child.on('error', (err) => reject(err));
            child.on('close', (code) => resolve({ code, stdout, stderr }));
        });

    try {
        const { code, stdout, stderr } = await run();
        if (code !== 0) {
            throw new Error((stderr || '').trim() || `Matrix CLI 退出码 ${code}`);
        }
        const lines = stdout.split(/\r?\n/);
        const skills = [];
        let foundCount = 0;
        let showedHint = '';
        for (const line of lines) {
            const countMatch = line.match(/找到\s+(\d+)\s+个技能/);
            if (countMatch) {
                foundCount = parseInt(countMatch[1], 10) || 0;
            }
            const hintMatch = line.match(/ℹ\s+显示\s+(\d+)\s+\/\s+(\d+)\s+个结果/);
            if (hintMatch) {
                showedHint = `显示 ${hintMatch[1]} / ${hintMatch[2]} 个结果`;
            }
            if (!line.includes('|')) continue;
            const parts = line.split('|').map((s) => s.trim());
            // 表格行格式：| 英文名称 | 描述 | 标签 |
            if (parts.length >= 4 && parts[1] && parts[1] !== '英文名称' && !parts[1].startsWith('-')) {
                const enName = parts[1];
                const description = parts[2] || '';
                const tag = parts[3] || '';
                skills.push({
                    id: enName,
                    name: enName,
                    description,
                    author: tag,
                    source: 'matrix',
                    installUrl: `${MATRIX_INSTALL_PREFIX}${enName}`,
                    stars: 0,
                    canInstall: true
                });
            }
        }
        const total = foundCount || skills.length;
        const message = showedHint || undefined;
        // 由于 Matrix CLI 不支持分页参数，只做前端截断模拟分页
        const start = (page - 1) * limit;
        const paged = skills.slice(start, start + limit);
        return {
            skills: paged,
            total,
            hasMore: start + limit < total,
            message
        };
    } catch (e) {
        return {
            skills: [],
            total: 0,
            hasMore: false,
            message: `Matrix Skill 搜索失败: ${e.message || '未知错误'}`
        };
    }
}

/**
 * 解析 matrix:enName 格式的 installUrl
 * @param {string} installUrl
 * @returns {{ slug: string } | null}
 */
function parseMatrixInstallUrl(installUrl) {
    if (!installUrl || typeof installUrl !== 'string' || !installUrl.startsWith(MATRIX_INSTALL_PREFIX)) {
        return null;
    }
    const rest = installUrl.slice(MATRIX_INSTALL_PREFIX.length).trim();
    if (!rest) return null;
    return { slug: rest };
}

/**
 * 根据 registryId 调用对应搜索
 * @param {string} registryId - skill0 | skillsmp | clawhub | matrix
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
        case 'matrix':
            return searchMatrix(opts);
        default:
            throw new Error(`未知 Registry: ${registryId}`);
    }
}

/**
 * 判断 installUrl 的安装方式：clawhub:slug | matrix:enName | github tree | zip
 * @param {string} installUrl
 * @returns {'clawhub' | 'matrix' | 'github' | 'zip'}
 */
function getInstallMethod(installUrl) {
    if (!installUrl || typeof installUrl !== 'string') return 'zip';
    if (installUrl.startsWith(CLAWHUB_INSTALL_PREFIX)) return 'clawhub';
    if (installUrl.startsWith(MATRIX_INSTALL_PREFIX)) return 'matrix';
    return installUrl.includes('github.com') && installUrl.includes('/tree/') ? 'github' : 'zip';
}

export const RegistryAdapters = {
    searchSkill0,
    searchSkillsMP,
    searchClawHub,
    searchMatrix,
    searchRegistry,
    getInstallMethod,
    parseClawHubInstallUrl,
    parseMatrixInstallUrl,
    CLAWHUB_INSTALL_PREFIX,
    MATRIX_INSTALL_PREFIX
};
