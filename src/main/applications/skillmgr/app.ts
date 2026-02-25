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

import { BaseApplication, BaseWorker } from '../base.js';
import { z } from 'zod';
import { logger } from '../../utils/logger.js';
import { SkillRegistry } from './skillregistry.js';
import { Skill } from '../../aikernel/skill.js';
import SkillsWorker from './service/worker.js';


/**
 * 本地 Agent Skills 子应用：以 Anthropic Agent Skills 标准管理端侧技能，并对外提供 toolsets 供主进程对话调用
 */
export class SkillMgrApplication extends BaseApplication {
    constructor() {
        super('skillmgr', 'Skills');
    }

    static getWorkerClass(): typeof BaseWorker | undefined {
        return SkillsWorker;
    }

    static getConfigSchema(): z.ZodObject<any> {
        return z.object({
            enabled: z.boolean().describe('是否启用技能').default(false),
            skillsmp_api_key: z.string()
                .optional()
                .describe('SkillsMP API Key（可选，用于从 skillsmp.com 搜索技能）')
        });
    }

    /**
     * 获取应用提供的 Skills，应用注册时会被调用
     */
    async getSkills(): Promise<Skill[]> {
        if (this.getConfig()?.enabled === true) {
            return SkillRegistry.listSkills().map(skill => new Skill(
                {
                    name: String(skill.name),
                    description: String(skill.description),
                },
                SkillRegistry.getSkillBody(skill.id)?.body || '',
            ));
        }

        return [];
    }

    /**
     * 配置变化时：刷新 skills 并重新注册到 aikernel
     */
    onConfigChanged(): void {
        super.onConfigChanged();
        logger.info('[skillmgr] config changed, refreshing skills...');
        if (this.getConfig()?.enabled === true) {
            // 重新加载 skills（会自动注册到 aikernel）
            SkillRegistry.refresh();
        }
    }

    getSkillsDirectory(): string {
        return SkillRegistry.getSkillsDirectory();
    }

    getBundledSkillsDirectory(): string {
        return SkillRegistry.getBundledSkillsDirectory();
    }

    listSkills() {
        return SkillRegistry.listSkills();
    }

    clearSkills() {

    }

    refresh() {
        const { toolsets, errors } = SkillRegistry.refresh();
        return { count: toolsets.length, errors };
    }

}