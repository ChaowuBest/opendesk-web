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
import { BaseTool, BaseToolset } from '../../aikernel/tool';
import { z } from 'zod';
import { WebFetchTool } from './tools/webfetch';
import { BingSearchTool } from './tools/bing';
import { BraveSearchTool } from './tools/brave';
import { ExaSearchTool } from './tools/exa';
import { Setting } from '../../utils/setting.js';
import { Skill } from '../../aikernel/skill.js';
import { ConfigureSearchTool, ListSearchToolsTool, ToggleSearchToolTool } from './tools';
import { MANAGE_SEARCH_TOOLS_SKILL } from './skills';

class SearchApplication extends BaseApplication {
    constructor() {
        super('search', '融合搜索', false);
    }

    static getConfigSchema() {
        return z.object({
            bing_search: z.object({
                enabled: z.boolean().default(true).describe('是否启用Bing搜索'),
            }).optional(),
            exa_search: z.object({
                api_key: z.string().default('').describe('ExaSearch的API密钥'),
                enabled: z.boolean().default(false).describe('是否启用ExaSearch'),
            }).optional(),
            brave_search: z.object({
                api_key: z.string().default('').describe('Brave Search的API密钥'),
                enabled: z.boolean().default(false).describe('是否启用Brave Search'),
            }).optional(),
        });
    }

    /**
     * 配置搜索工具
     */
    async configureSearchTool(id: string, updates: { api_key?: string; enabled?: boolean }): Promise<void> {
        const setting = Setting.getInstance();
        const fullData = JSON.parse(JSON.stringify(setting.data));
        if (!fullData.applications) fullData.applications = {};
        if (!fullData.applications[this.bundleName]) fullData.applications[this.bundleName] = {};

        if (id === 'exa') {
            if (!fullData.applications[this.bundleName].exa_search) {
                fullData.applications[this.bundleName].exa_search = { api_key: '', enabled: false };
            }
            if (updates.api_key !== undefined) {
                fullData.applications[this.bundleName].exa_search.api_key = updates.api_key;
            }
            if (updates.enabled !== undefined) {
                fullData.applications[this.bundleName].exa_search.enabled = updates.enabled;
            }
        } else if (id === 'brave') {
            if (!fullData.applications[this.bundleName].brave_search) {
                fullData.applications[this.bundleName].brave_search = { api_key: '', enabled: false };
            }
            if (updates.api_key !== undefined) {
                fullData.applications[this.bundleName].brave_search.api_key = updates.api_key;
            }
            if (updates.enabled !== undefined) {
                fullData.applications[this.bundleName].brave_search.enabled = updates.enabled;
            }
        } else if (id === 'bing') {
            if (!fullData.applications[this.bundleName].bing_search) {
                fullData.applications[this.bundleName].bing_search = { enabled: true };
            }
            if (updates.enabled !== undefined) {
                fullData.applications[this.bundleName].bing_search.enabled = updates.enabled;
            }
        }

        setting.setData(fullData);
        this.sendEventToSubscribers('toolsUpdated');
    }

    /**
     * 切换搜索工具启用状态
     */
    async toggleSearchTool(id: string, enabled: boolean): Promise<void> {
        await this.configureSearchTool(id, { enabled });
    }

    /**
     * 获取搜索工具列表
     */
    public getSearchToolsFromConfig(): Array<{ id: string; name: string; type: string; enabled: boolean; api_key?: string; description?: string; canDisable?: boolean }> {
        const config: any = this.getConfig();
        return [
            { id: 'bing', name: 'Bing 搜索', type: 'bing', enabled: config?.bing_search?.enabled !== false, description: '免费的网页搜索引擎', canDisable: true },
            { id: 'brave', name: 'Brave 搜索', type: 'brave', enabled: !!config?.brave_search?.enabled, api_key: config?.brave_search?.api_key, description: '隐私优先的搜索引擎', canDisable: true },
            { id: 'exa', name: 'Exa 搜索', type: 'exa', enabled: !!config?.exa_search?.enabled, api_key: config?.exa_search?.api_key, description: 'AI驱动的搜索引擎', canDisable: true },
        ];
    }

    async getToolsets() {
        const config: any = this.getConfig();
        const exa_search = config?.exa_search;
        const brave_search = config?.brave_search;
        const bing_enabled = config?.bing_search?.enabled !== false;
        const toolset = new BaseToolset('search');
        const hasExaApi = exa_search?.enabled && exa_search?.api_key !== '';
        const hasBraveApi = brave_search?.enabled && brave_search?.api_key !== '';

        if (hasBraveApi) {
            toolset.addTool(new BraveSearchTool(brave_search?.api_key));
        }
        if (hasExaApi) {
            toolset.addTool(new ExaSearchTool(exa_search?.api_key));
        }
        // 只有当没有启用其他API搜索工具且Bing搜索启用时才添加Bing搜索
        if (!hasBraveApi && !hasExaApi && bing_enabled) {
            toolset.addTool(new BingSearchTool());
        }
        // WebFetch总是添加，不管理
        toolset.addTool(new WebFetchTool());
        return [toolset];
    }

    async getSkills(): Promise<Skill[]> {
        let searchManageSkill = Skill.parseMd(MANAGE_SEARCH_TOOLS_SKILL);
        let searchManageToolset = new BaseToolset('search-manage');

        searchManageToolset.addTool(new ConfigureSearchTool(this));
        searchManageToolset.addTool(new ListSearchToolsTool(this));
        searchManageToolset.addTool(new ToggleSearchToolTool(this));
        searchManageSkill.toolsets = [searchManageToolset];
        return [searchManageSkill];
    }
}

export { SearchApplication };
