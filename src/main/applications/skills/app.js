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

import { BaseApplication } from '../base';
import { z } from 'zod';
import path from 'path';
import { SkillRegistry } from './skillregistry.js';
import SkillsWorker from './service/worker.js';

const __dirname = import.meta.dirname;

/**
 * 本地 Agent Skills 子应用：以 Anthropic Agent Skills 标准管理端侧技能，并对外提供 toolsets 供主进程对话调用
 */
class SkillsApplication extends BaseApplication {
  constructor() {
    super('skills', 'Skills');
  }

  static getWorkerClass() {
    return SkillsWorker;
  }

  static getConfigSchema() {
    return z.object({
        enabled: z.boolean().describe('是否启用技能').default(false),
        skillsmp_api_key: z.string().optional().describe('SkillsMP API Key（可选，用于从 skillsmp.com 搜索技能）')
    });
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
}

export { SkillsApplication };
