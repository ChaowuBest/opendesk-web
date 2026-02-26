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
import { BaseToolset } from '../../aikernel/tool.js';
import SkillsWorker from './service/worker.js';
import { MANAGE_SKILLS_SKILL } from './skills.js';
import {
    AddSkillFromPathTool,
    AddSkillFromUrlTool,
    AddSkillFromGitHubUrlTool,
    ListSkillsTool,
    DeleteSkillTool,
    RefreshSkillsTool,
    GetSkillsDirectoryTool
} from './tools.js';


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

    async getSkills(): Promise<Skill[]> {
        const skills: Skill[] = [];

        if (this.getConfig()?.enabled === true) {
            skills.push(...SkillRegistry.listSkills().map(skill => new Skill(
                {
                    name: String(skill.name),
                    description: String(skill.description),
                },
                SkillRegistry.getSkillBody(skill.id)?.body || '',
            )));
        }

        const manageSkillsSkill = Skill.parseMd(MANAGE_SKILLS_SKILL);
        const manageSkillsToolset = new BaseToolset('manage-skills');

        manageSkillsToolset.addTool(new AddSkillFromPathTool(this));
        manageSkillsToolset.addTool(new AddSkillFromUrlTool(this));
        manageSkillsToolset.addTool(new AddSkillFromGitHubUrlTool(this));
        manageSkillsToolset.addTool(new ListSkillsTool(this));
        manageSkillsToolset.addTool(new DeleteSkillTool(this));
        manageSkillsToolset.addTool(new RefreshSkillsTool(this));
        manageSkillsToolset.addTool(new GetSkillsDirectoryTool(this));

        manageSkillsSkill.toolsets = [manageSkillsToolset];
        skills.push(manageSkillsSkill);

        return skills;
    }

    onConfigChanged(): void {
        super.onConfigChanged();
        logger.info('[skillmgr] config changed, refreshing skills...');
        if (this.getConfig()?.enabled === true) {
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

    addSkillFromPath(sourcePath: string) {
        return SkillRegistry.addSkillFromPath(sourcePath);
    }

    addSkillFromUrl(url: string) {
        return SkillRegistry.addSkillFromUrl(url);
    }

    addSkillFromGitHubUrl(githubUrl: string) {
        return SkillRegistry.addSkillFromGitHubUrl(githubUrl);
    }

    deleteSkill(skillId: string) {
        return SkillRegistry.deleteSkill(skillId);
    }

    clearSkills() {

    }

    refresh() {
        const { toolsets, errors } = SkillRegistry.refresh();
        return { count: toolsets.length, errors };
    }
}