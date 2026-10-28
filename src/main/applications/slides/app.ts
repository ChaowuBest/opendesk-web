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

import type { Skill } from '../../aikernel/skill.js';
import type { BaseToolset } from '../../aikernel/tool.js';
import { BaseApplication } from '../base.js';
import { getSlidesCapabilityProvider } from './provider.js';
import { buildSlidesSkill, createSlidesToolset } from './skill.js';
import { t } from './locale/index.js';

export class SlidesApplication extends BaseApplication {
    constructor() {
        super('slides', false);
    }

    getName(): string {
        return t('app.name');
    }

    async getSkills(): Promise<Skill[]> {
        const provider = getSlidesCapabilityProvider();
        if (!(await provider.isProgramAvailable())) return [];
        return [buildSlidesSkill()];
    }

    async getToolsets(): Promise<BaseToolset[]> {
        const provider = getSlidesCapabilityProvider();
        if (!(await provider.isProgramAvailable())) return [];
        return [
            createSlidesToolset(
                provider.executeProgram.bind(provider),
                provider.openPresentation.bind(provider)
            )
        ];
    }
}
