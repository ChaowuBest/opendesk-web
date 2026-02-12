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
 * Skills 应用 Worker：在 Worker 线程中执行 list/refresh/getSkillsDirectory/addFromPath/addFromZip/addFromUrl/delete/searchRegistry/installFromRegistry。
 * 写操作完成后通过 skillsRegistryChanged 通知主进程同步 SkillRegistry（主进程 getToolsets 依赖之）。
 */

import { parentPort } from 'worker_threads';
import { BaseWorker } from '../../base.js';
import { SkillRegistry } from '../skillregistry.js';
import { RegistryAdapters } from '../registry-adapters.js';

function notifyMainSync() {
    parentPort?.postMessage({ type: 'skillsRegistryChanged' });
}

class SkillsWorker extends BaseWorker {
  constructor(appDataDirectory) {
    super('skills', appDataDirectory);
  }

  async initialize() {
    // 可选：在 Worker 内预加载技能列表，与主进程无强依赖
  }

  list() {
    return SkillRegistry.listSkills();
  }

  refresh() {
    const { toolsets, errors } = SkillRegistry.refresh();
    return { count: toolsets.length, errors };
  }

  getSkillsDirectory() {
    return SkillRegistry.getSkillsDirectory();
  }

  addFromPath(sourcePath) {
    const result = SkillRegistry.addSkillFromPath(sourcePath);
    if (!result.success) throw new Error(result.error);
    notifyMainSync();
    return { name: result.name };
  }

  addFromZip(zipPath, skillRelPath) {
    const opts = skillRelPath ? { skillRelPath } : {};
    const result = SkillRegistry.addSkillFromZipPath(zipPath, opts);
    if (!result.success) throw new Error(result.error);
    notifyMainSync();
    return { name: result.name };
  }

  async addFromUrl(url) {
    const result = await SkillRegistry.addSkillFromUrl(url);
    if (!result.success) throw new Error(result.error);
    notifyMainSync();
    return { name: result.name };
  }

  delete(skillId) {
    const result = SkillRegistry.deleteSkill(skillId);
    if (!result.success) throw new Error(result.error);
    notifyMainSync();
  }

  /** 从第三方 Registry 搜索技能：skill0 | skillsmp | clawhub。SkillsMP API Key 从 this.config 读取（由 worker 初始化与主进程保存设置时的 applicationConfigChanged 写入）。 */
  async searchRegistry(registryId, query = '', page = 1, limit = 20) {
    const opts = { query: String(query || ''), page: Number(page) || 1, limit: Number(limit) || 20 };
    if (registryId === 'skillsmp') {
      opts.apiKey = (this.config?.skillsmp_api_key || '').trim();
    }
    return RegistryAdapters.searchRegistry(registryId, opts);
  }

  /** 从 Registry 安装技能（installUrl 为 GitHub tree URL、zip URL 或 clawhub:slug、clawhub:slug@version） */
  async installFromRegistry(installUrl) {
    if (!installUrl || typeof installUrl !== 'string') {
      throw new Error('无效的安装 URL');
    }
    const method = RegistryAdapters.getInstallMethod(installUrl);
    let result;
    if (method === 'clawhub') {
      const parsed = RegistryAdapters.parseClawHubInstallUrl(installUrl);
      if (!parsed) throw new Error('无效的 ClawHub installUrl，应为 clawhub:slug 或 clawhub:slug@version');
      result = await SkillRegistry.addSkillFromClawHubSlug(parsed.slug, parsed.version);
    } else if (method === 'github') {
      result = await SkillRegistry.addSkillFromGitHubUrl(installUrl);
    } else {
      result = await SkillRegistry.addSkillFromUrl(installUrl);
    }
    if (!result.success) throw new Error(result.error);
    notifyMainSync();
    return { name: result.name };
  }
}

export default SkillsWorker;
