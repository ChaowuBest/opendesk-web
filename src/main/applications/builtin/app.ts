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

import { Skill } from '../../aikernel/skill.js';
import { BaseApplication } from '../base.js';
import { t } from './locale/index.js';
import { loadPoolSkill } from './pool.js';
import { loadUseHarmonySkill } from './skills/use-harmony/skill.js';
import { skillRegistry } from '../skillmgr/utils/skill-registry.js';
import {
    getBuiltinSkillsDirectory,
    isBuiltinSkillAvailableOnPlatform,
    listBuiltinSkillDirectories
} from '../skillmgr/builtin-skills.js';
import { ReadableDirectoryRegistry } from '../../aikernel/security/enforcer.js';
import { getPlatform } from '../../../platforms/base.js';
import { logger } from '../../utils/logger.js';

export class BuiltinApplication extends BaseApplication {
    constructor() {
        super('builtin', false);
    }

    getName(): string {
        return t('app.name');
    }

    async getSkills(): Promise<Skill[]> {
        const skills: Skill[] = [];
        skills.push(loadPoolSkill());
        skills.push(loadUseHarmonySkill());
        skills.push(...this.loadBuiltinResourcesSkills());

        return skills;
    }

    /**
     * 加载随安装包分发的内置技能（resources/skills 下的 SKILL.md 目录）。
     * 解析与校验复用 skillmgr 的 SkillRegistry；技能文件为只读分发内容，
     * 仅由 builtin 应用提供，不进入 skillmgr 注册表（避免技能中心与自动补全重复）。
     */
    private loadBuiltinResourcesSkills(): Skill[] {
        const skillDirs = listBuiltinSkillDirectories();
        if (skillDirs.length === 0) return [];

        // 注册为全局可读，确保各模式下 agent 都能读取技能目录中的资源文件
        const builtinDir = getBuiltinSkillsDirectory();
        if (builtinDir) {
            ReadableDirectoryRegistry.getInstance().register(builtinDir);
        }

        const skills: Skill[] = [];
        const platformName = getPlatform().getName();
        for (const skillDir of skillDirs) {
            const result = skillRegistry._loadSkillFromDir(skillDir);
            if (!result.success) {
                logger.warn(`[builtin] 跳过内置技能 ${skillDir} - ${result.error}`);
                continue;
            }
            // 按 skillmgr 的平台配置过滤：限定平台的技能只在对应平台注入
            if (!isBuiltinSkillAvailableOnPlatform(String(result.frontmatter?.name ?? ''), platformName)) {
                continue;
            }
            const skill = new Skill({ ...result.frontmatter }, result.body || '', result.skillDir);
            skill.readOnly = true;
            skills.push(skill);
        }
        return skills;
    }
}
