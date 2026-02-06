/**
 * Skill Registry 适配器：skill0
 * 统一搜索接口，返回 { id, name, description, author, source, installUrl, stars? }
 * installUrl 用于 SkillRegistry.addSkillFromGitHubUrl 或 addSkillFromUrl
 */

const SKILL0_BASE = 'https://skill0.io';

/**
 * @typedef {Object} RegistrySkill
 * @property {string} id - 唯一标识
 * @property {string} name - 技能名称
 * @property {string} description - 描述
 * @property {string} [author] - 作者
 * @property {string} source - 来源：skill0
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
 * 根据 registryId 调用对应搜索（当前仅支持 skill0）
 * @param {string} registryId - skill0
 * @param {Object} opts - { query, page, limit }
 */
async function searchRegistry(registryId, opts = {}) {
  return searchSkill0(opts);
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
  searchRegistry,
  getInstallMethod
};
