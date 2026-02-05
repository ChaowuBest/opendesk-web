import { BaseApplication, BaseGUIConfig } from '../base.js';
import { z } from 'zod';
import path from 'path';
import { BrowserWindow, dialog } from 'electron';
import { SkillRegistry } from './skillregistry.js';

const __dirname = import.meta.dirname;

/**
 * 本地 Agent Skills 子应用：以 Anthropic Agent Skills 标准管理端侧技能，并对外提供 toolsets 供主进程对话调用
 */
class SkillsApplication extends BaseApplication {
  constructor() {
    super('skills', 'Skills');
  }

  static getConfigSchema() {
    return z.object({
        enabled: z.boolean().describe('是否启用技能').default(false)
    });
  }

  getGUIConfig() {
    return new BaseGUIConfig(
      [path.join(__dirname, 'renderer', 'entry.js')],
      'skills-entry-widget',
      '/applications/skills/icon.png'
    );
  }

  async getToolsets() {
    if (this.getConfig()?.enabled === true) {
        return SkillRegistry.getToolsets();
    } else {
        return [];
    }
  }

  getSkillsDirectory() {
    return SkillRegistry.getSkillsDirectory();
  }

  getBundledSkillsDirectory() {
    return SkillRegistry.getBundledSkillsDirectory();
  }

  listSkills() {
    return SkillRegistry.listSkills();
  }

  refresh() {
    const { toolsets, errors } = SkillRegistry.refresh();
    return { count: toolsets.length, errors };
  }

  /** 仅此二项需主进程 dialog，供渲染进程 applicationAPI.callMainWorld 调用 */
  async pickDirectory() {
    const win = BrowserWindow.getFocusedWindow();
    const { canceled, filePaths } = await dialog.showOpenDialog(win || null, {
      properties: ['openDirectory'],
      title: '选择技能目录（须含 SKILL.md）'
    });
    if (canceled || !filePaths?.length) return null;
    return filePaths[0];
  }

  /** 供渲染进程 applicationAPI.callMainWorld 调用 */
  async pickZip() {
    const win = BrowserWindow.getFocusedWindow();
    const { canceled, filePaths } = await dialog.showOpenDialog(win || null, {
      properties: ['openFile'],
      title: '选择技能压缩包',
      filters: [{ name: 'ZIP', extensions: ['zip'] }]
    });
    if (canceled || !filePaths?.length) return null;
    return filePaths[0];
  }
}

export { SkillsApplication };
