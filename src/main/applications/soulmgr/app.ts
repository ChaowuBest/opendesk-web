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

import { BaseApplication } from '../base.js';
import { Skill } from '../../aikernel/skill.js';
import { BaseToolset } from '../../aikernel/tool.js';
import { SoulRegistry, type SoulData } from './soulregistry.js';
import { MANAGE_SOULS_SKILL } from './skills.js';
import {
    ListSoulsTool,
    GetSoulTool,
    CreateSoulTool,
    UpdateSoulTool,
    DeleteSoulTool,
    SwitchSoulTool,
    ResetDefaultSoulTool,
} from './tools.js';


export class SoulMgrApplication extends BaseApplication {

    constructor() {
        super('soulmgr', '人设管理', false);
        SoulRegistry.initialize(this.getDataDirectory())
    }

    private async getRegistry(): Promise<SoulRegistry> {
        const instance = SoulRegistry.getInstance();
        if (instance) return instance;
        const dataDir = this.getDataDirectory();
        return SoulRegistry.initialize(dataDir);
    }

    async getSkills(): Promise<Skill[]> {
        const skill = Skill.parseMd(MANAGE_SOULS_SKILL);
        const toolset = new BaseToolset('manage-souls');

        toolset.addTool(new ListSoulsTool(this));
        toolset.addTool(new GetSoulTool(this));
        toolset.addTool(new CreateSoulTool(this));
        toolset.addTool(new UpdateSoulTool(this));
        toolset.addTool(new DeleteSoulTool(this));
        toolset.addTool(new SwitchSoulTool(this));
        toolset.addTool(new ResetDefaultSoulTool(this));

        skill.toolsets = [toolset];
        return [skill];
    }

    async ensureRegistry(): Promise<void> {
        await this.getRegistry();
    }

    listSouls() {
        return SoulRegistry.getInstance()?.listSouls() ?? [];
    }

    getSoul(uid: string): SoulData | null {
        return SoulRegistry.getInstance()?.getSoul(uid) ?? null;
    }

    createSoul(name: string, description: string, body: string, author?: string) {
        const registry = SoulRegistry.getInstance();
        if (!registry) return { success: false, error: 'registry not initialized' };
        return registry.createSoul(name, description, body, author);
    }

    updateSoul(uid: string, updates: { name?: string; description?: string; body?: string }) {
        const registry = SoulRegistry.getInstance();
        if (!registry) return { success: false, error: 'registry not initialized' };
        return registry.updateSoul(uid, updates);
    }

    deleteSoul(uid: string) {
        const registry = SoulRegistry.getInstance();
        if (!registry) return { success: false, error: 'registry not initialized' };
        return registry.deleteSoul(uid);
    }

    switchSoul(uid: string) {
        const registry = SoulRegistry.getInstance();
        if (!registry) return { success: false, error: 'registry not initialized' };
        return registry.switchSoul(uid);
    }

    resetDefaultSoul() {
        const registry = SoulRegistry.getInstance();
        if (!registry) return { success: false, error: 'registry not initialized' };
        return registry.resetDefaultSoul();
    }
}
