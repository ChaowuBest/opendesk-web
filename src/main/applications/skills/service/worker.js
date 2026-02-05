/**
 * Skills 应用 Worker：在 Worker 线程中执行 list/refresh/getSkillsDirectory/addFromPath/addFromZip/addFromUrl/delete。
 * 写操作完成后通过 skillsRegistryChanged 通知主进程同步 SkillRegistry（主进程 getToolsets 依赖之）。
 */

import { parentPort } from 'worker_threads';
import { BaseWorker } from '../../base.js';
import { SkillRegistry } from '../skillregistry.js';

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

  addFromZip(zipPath) {
    const result = SkillRegistry.addSkillFromZipPath(zipPath);
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
}

export default SkillsWorker;
