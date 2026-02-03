import { BaseApplication, BaseGUIConfig } from '../base.js';
import { z } from 'zod';
import path from 'path';
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
    return SkillRegistry.refresh();
  }
}

export { SkillsApplication };
