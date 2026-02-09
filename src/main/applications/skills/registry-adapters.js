/**
 * 第三方 Skill Registry 适配器：skill0、skillsmp、clawhub
 * 统一搜索接口，返回 { id, name, description, author, source, installUrl, stars? }
 * installUrl 用于 SkillRegistry.addSkillFromGitHubUrl 或 addSkillFromUrl
 */

const SKILL0_BASE = 'https://skill0.io';
const SKILLSMP_BASE = 'https://skillsmp.com';
const CLAWHUB_BASE = 'https://clawhub.ai';

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

/**
 * skillsmp 搜索（需 API Key，可选）
 * @param {Object} opts - { query: string, page?: number, limit?: number, apiKey?: string }
 * @returns {Promise<{ skills: RegistrySkill[], total?: number, hasMore?: boolean }>}
 */
async function searchSkillsMP(opts = {}) {
  const { query = '', page = 1, limit = 20, apiKey } = opts;
  if (!apiKey || !apiKey.trim()) {
    throw new Error('SkillsMP 需配置 API Key。请在 FillipDesk「设置」→ 应用配置 → Skills 中填写并保存后重试。获取 Key：https://skillsmp.com/auth/login');
  }
  const params = new URLSearchParams({ q: query.trim() || 'skill', page: String(page), limit: String(limit) });
  const url = `${SKILLSMP_BASE}/api/v1/skills/search?${params}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey.trim()}` },
      signal: controller.signal
    });
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === 'AbortError') {
      throw new Error('SkillsMP 请求超时，请检查网络或稍后重试');
    }
    throw new Error(e?.message || 'SkillsMP 网络请求失败');
  }
  clearTimeout(timeoutId);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    if (res.status === 401) {
      throw new Error(err?.error?.message || 'API Key 无效或已过期');
    }
    throw new Error(err?.error?.message || `SkillsMP 请求失败: ${res.status}`);
  }
  const data = await res.json();
  // SkillsMP 实际返回: data.data.skills、data.data.pagination.total（见 skillsmp-mcp-server）
  const items = Array.isArray(data)
    ? data
    : (data.data?.skills ?? data.data?.items ?? data.data ?? data.items ?? data.skills ?? data.results ?? []);
  const list = Array.isArray(items) ? items : [];
  const total = data.data?.pagination?.total ?? data.data?.total ?? data.total ?? list.length;
  const skills = list.map((s) => {
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
  });
  return {
    skills,
    total,
    hasMore: (page * limit) < (total ?? 0)
  };
}

/**
 * ClawHub 暂无公开 API，返回空结果并提示
 * @param {Object} opts
 * @returns {Promise<{ skills: RegistrySkill[], total?: number, hasMore?: boolean, message?: string }>}
 */
async function searchClawHub(opts = {}) {
  return {
    skills: [],
    total: 0,
    hasMore: false,
    message: 'ClawHub 暂未提供公开 API，请前往 https://clawhub.ai/skills 浏览并手动安装'
  };
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
 * 判断 installUrl 是否为 GitHub tree URL，从而选择安装方式
 * @param {string} installUrl
 * @returns {'github' | 'zip'}
 */
function getInstallMethod(installUrl) {
  if (!installUrl || typeof installUrl !== 'string') return 'zip';
  return installUrl.includes('github.com') && installUrl.includes('/tree/') ? 'github' : 'zip';
}

export const RegistryAdapters = {
  searchSkill0,
  searchSkillsMP,
  searchClawHub,
  searchRegistry,
  getInstallMethod
};
