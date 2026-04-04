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
import { BaseToolset } from '../../aikernel/tool';
import { Skill } from '../../aikernel/skill';
import { z } from 'zod';
import { KnowledgeBaseProvider } from './base';
import { ZhipuKnowledgeBaseProvider } from './providers/zhipu';
import { MANAGE_KNOWLEDGEBASE_SKILL, OPERATE_KNOWLEDGEBASE_SKILL } from './skills';
import {
    ListLibraryProvidersTool,
    ConfigureLibraryProviderTool,
    ToggleLibraryProviderTool,
    CreateKnowledgeBaseTool,
    DeleteKnowledgeBaseTool
} from './tools/manage';
import {
    ListKnowledgeBasesTool,
    RetrieveFromKnowledgeBaseTool,
    AskKnowledgeBaseTool,
    AddFilesToKnowledgeBaseTool
} from './tools/knowledge';

const KnowledgeBaseApplicationConfigSchema = z.object({
    zhipu: z
        .object({
            api_key: z.string().default('').describe('智谱AI API密钥'),
            enabled: z.boolean().default(false).describe('是否启用智谱AI知识库')
        })
        .optional()
});

type KnowledgeBaseConfig = z.output<typeof KnowledgeBaseApplicationConfigSchema>;

export class KnowledgeBaseApplication extends BaseApplication {
    private providers: Map<string, KnowledgeBaseProvider> = new Map();

    constructor() {
        super('knowledgebase', '知识库', false);
        this.initProviders();
    }

    static getConfigSchema() {
        return KnowledgeBaseApplicationConfigSchema;
    }

    private initProviders() {
        this.providers.set('zhipu', new ZhipuKnowledgeBaseProvider());
    }

    private syncProvidersFromConfig() {
        const config = this.getConfig() as KnowledgeBaseConfig | undefined;
        const zhipu = this.providers.get('zhipu') as ZhipuKnowledgeBaseProvider | undefined;
        if (zhipu && config?.zhipu) {
            zhipu.setApiKey(config.zhipu.api_key || '');
        }
    }

    getProvider(id: string): KnowledgeBaseProvider | undefined {
        this.syncProvidersFromConfig();
        return this.providers.get(id);
    }

    getEnabledProviders(): KnowledgeBaseProvider[] {
        this.syncProvidersFromConfig();
        const config = this.getConfig() as KnowledgeBaseConfig | undefined;
        const result: KnowledgeBaseProvider[] = [];
        for (const [id, provider] of this.providers) {
            const providerConfig = config?.[id as keyof KnowledgeBaseConfig] as { enabled?: boolean } | undefined;
            if (providerConfig?.enabled && provider.isConfigured()) {
                result.push(provider);
            }
        }
        return result;
    }

    getProviderStatusList(): {
        id: string;
        name: string;
        description: string;
        enabled: boolean;
        has_api_key: boolean;
    }[] {
        const config = this.getConfig() as KnowledgeBaseConfig | undefined;
        const result: {
            id: string;
            name: string;
            description: string;
            enabled: boolean;
            has_api_key: boolean;
        }[] = [];
        for (const [id, provider] of this.providers) {
            const providerConfig = config?.[id as keyof KnowledgeBaseConfig] as
                | { enabled?: boolean; api_key?: string }
                | undefined;
            result.push({
                id: provider.id,
                name: provider.name,
                description: provider.description,
                enabled: !!providerConfig?.enabled,
                has_api_key: !!(providerConfig?.api_key && providerConfig.api_key.length > 0)
            });
        }
        return result;
    }

    configureProvider(id: string, updates: { api_key?: string; enabled?: boolean }) {
        const provider = this.providers.get(id);
        if (!provider) throw new Error(`知识库服务商 "${id}" 不存在`);

        const config: any = this.getConfig() ?? {};
        if (!config[id]) {
            config[id] = { api_key: '', enabled: false };
        }
        if (updates.api_key !== undefined) {
            config[id].api_key = updates.api_key;
        }
        if (updates.enabled !== undefined) {
            config[id].enabled = updates.enabled;
        }
        this.setConfig(config);
        this.syncProvidersFromConfig();
    }

    getConfig(): KnowledgeBaseConfig | undefined {
        return super.getConfig() as KnowledgeBaseConfig | undefined;
    }

    async getSkills(): Promise<Skill[]> {
        const manageSkill = Skill.parseMd(MANAGE_KNOWLEDGEBASE_SKILL);
        const manageToolset = new BaseToolset('knowledgebase-manage');
        manageToolset.addTool(new ListLibraryProvidersTool(this));
        manageToolset.addTool(new ConfigureLibraryProviderTool(this));
        manageToolset.addTool(new ToggleLibraryProviderTool(this));
        manageToolset.addTool(new CreateKnowledgeBaseTool(this));
        manageToolset.addTool(new DeleteKnowledgeBaseTool(this));
        manageSkill.toolsets = [manageToolset];

        const operateSkill = Skill.parseMd(OPERATE_KNOWLEDGEBASE_SKILL);
        const operateToolset = new BaseToolset('knowledgebase-operate');
        operateToolset.addTool(new ListKnowledgeBasesTool(this));
        operateToolset.addTool(new RetrieveFromKnowledgeBaseTool(this));
        operateToolset.addTool(new AskKnowledgeBaseTool(this));
        operateToolset.addTool(new AddFilesToKnowledgeBaseTool(this));
        operateSkill.toolsets = [operateToolset];

        return [manageSkill, operateSkill];
    }
}
