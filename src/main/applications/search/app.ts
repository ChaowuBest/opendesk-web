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
import { DuckDuckGoSearchTool } from './tools/duckduckgo';
import { BraveSearchTool } from './tools/brave';
import { TavilySearchTool } from './tools/tavily';
import { BochaSearchTool } from './tools/bocha';
import { ExaSearchTool } from './tools/exa';
import { ArxivSearchTool } from './tools/arxiv';
import { ConfigureSearchTool, ListSearchToolsTool, ToggleSearchToolTool } from './tools/manage';
import { Setting } from '../../utils/setting.js';
import { Skill } from '../../aikernel/skill.js';
import { MANAGE_SEARCH_TOOLS_SKILL } from './skills';


const SearchApplicationConfigSchema = z.object({
    bing_search: z.object({
        enabled: z.boolean().default(true).describe('是否启用Bing搜索'),
    }).optional(),
    duckduckgo_search: z.object({
        enabled: z.boolean().default(true).describe('是否启用DuckDuckGo搜索'),
    }).optional(),
    exa_search: z.object({
        api_key: z.string().default('').describe('ExaSearch的API密钥'),
        enabled: z.boolean().default(false).describe('是否启用ExaSearch'),
    }).optional(),
    brave_search: z.object({
        api_key: z.string().default('').describe('Brave Search的API密钥'),
        enabled: z.boolean().default(false).describe('是否启用Brave Search'),
    }).optional(),
    tavily_search: z.object({
        api_key: z.string().default('').describe('Tavily Search的API密钥'),
        enabled: z.boolean().default(false).describe('是否启用Tavily Search'),
    }).optional(),
    bocha_search: z.object({
        api_key: z.string().default('').describe('博查 Search的API密钥'),
        enabled: z.boolean().default(false).describe('是否启用博查 Search'),
    }).optional(),
    arxiv_search: z.object({
        enabled: z.boolean().default(true).describe('是否启用arXiv搜索'),
    }).optional(),
});

export class SearchApplication extends BaseApplication {
    constructor() {
        super('search', '融合搜索', false);
    }

    static getConfigSchema() {
        return SearchApplicationConfigSchema;
    }

    /**
     * 配置搜索工具
     */
    async configureSearchTool(id: string, updates: { api_key?: string; enabled?: boolean }): Promise<void> {
        const config = this.getConfig() ?? {};

        if (id === 'exa') {
            config.exa_search = { api_key: updates.api_key ?? '', enabled: updates.enabled ?? false };
        } else if (id === 'brave') {
            config.brave_search = { api_key: updates.api_key ?? '', enabled: updates.enabled ?? false };
        } else if (id === 'tavily') {
            config.tavily_search = { api_key: updates.api_key ?? '', enabled: updates.enabled ?? false };
        } else if (id === 'bocha') {
            config.bocha_search = { api_key: updates.api_key ?? '', enabled: updates.enabled ?? false };
        } else if (id === 'bing') {
            config.bing_search = { enabled: updates.enabled ?? false };
        } else if (id === 'duckduckgo') {
            config.duckduckgo_search = { enabled: updates.enabled ?? false };
        } else if (id === 'arxiv') {
            config.arxiv_search = { enabled: updates.enabled ?? false };
        }

        this.setConfig(config);
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
            { id: 'duckduckgo', name: 'DuckDuckGo 搜索', type: 'duckduckgo', enabled: config?.duckduckgo_search?.enabled !== false, description: '注重隐私的免费搜索引擎', canDisable: true },
            { id: 'brave', name: 'Brave 搜索', type: 'brave', enabled: !!config?.brave_search?.enabled, api_key: config?.brave_search?.api_key, description: '隐私优先的搜索引擎', canDisable: true },
            { id: 'tavily', name: 'Tavily 搜索', type: 'tavily', enabled: !!config?.tavily_search?.enabled, api_key: config?.tavily_search?.api_key, description: '专为AI设计的搜索引擎', canDisable: true },
            { id: 'bocha', name: '博查搜索', type: 'bocha', enabled: !!config?.bocha_search?.enabled, api_key: config?.bocha_search?.api_key, description: '专为AI设计的中文搜索引擎', canDisable: true },
            { id: 'exa', name: 'Exa 搜索', type: 'exa', enabled: !!config?.exa_search?.enabled, api_key: config?.exa_search?.api_key, description: 'AI驱动的搜索引擎', canDisable: true },
            { id: 'arxiv', name: 'arXiv 搜索', type: 'arxiv', enabled: config?.arxiv_search?.enabled !== false, description: '学术论文搜索引擎', canDisable: true },
        ];
    }

    getConfig(): z.output<typeof SearchApplicationConfigSchema> | undefined {
        return super.getConfig();
    }

    async getToolsets() {
        const config = this.getConfig();
        const toolset = new BaseToolset('search');

        const hasExaApi = config?.exa_search?.enabled && config.exa_search.api_key !== '';
        const hasBraveApi = config?.brave_search?.enabled && config.brave_search.api_key !== '';
        const hasTavilyApi = config?.tavily_search?.enabled && config.tavily_search.api_key !== '';
        const hasBochaApi = config?.bocha_search?.enabled && config.bocha_search.api_key !== '';
        const hasBingApi = config?.bing_search?.enabled;
        const hasDuckDuckGoApi = config?.duckduckgo_search?.enabled !== false;
        const hasArxivApi = config?.arxiv_search?.enabled !== false;

        if (hasBraveApi) {
            toolset.addTool(new BraveSearchTool(config.brave_search!.api_key));
        }
        if (hasTavilyApi) {
            toolset.addTool(new TavilySearchTool(config.tavily_search!.api_key));
        }
        if (hasBochaApi) {
            toolset.addTool(new BochaSearchTool(config.bocha_search!.api_key));
        }
        if (hasExaApi) {
            toolset.addTool(new ExaSearchTool(config.exa_search!.api_key));
        }
        if (hasBingApi) {
            toolset.addTool(new BingSearchTool());
        }
        if (hasDuckDuckGoApi) {
            toolset.addTool(new DuckDuckGoSearchTool());
        }
        if (hasArxivApi) {
            toolset.addTool(new ArxivSearchTool());
        }

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
