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
import { loadPoolSkill } from './pool.js';
import { loadAnalysisResultVisualizerSkill } from './analysis-result-visualizer.js';

export class BuiltinApplication extends BaseApplication {
    constructor() {
        super('builtin', '内置功能', false);
    }

    async getSkills(): Promise<Skill[]> {
        const skills: Skill[] = [];
        skills.push(loadPoolSkill());
        skills.push(loadAnalysisResultVisualizerSkill());

        return skills;
    }
}
