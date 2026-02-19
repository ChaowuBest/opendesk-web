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
import { BaseToolset } from '../../agents/tool';
import { z } from 'zod';
import { WebFetchTool } from './tools/webfetch';
import { BingSearchTool } from './tools/bing';
import { BraveSearchTool } from './tools/brave';
import { ExaSearchTool } from './tools/exa';

class SearchApplication extends BaseApplication {
    constructor() {
        super('search', '融合搜索');
    }

    static getConfigSchema() {
        return z.object({
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

    async getToolsets() {
        const exa_search = this.getConfig()?.exa_search;
        const brave_search = this.getConfig()?.brave_search;
        const toolset = new BaseToolset('search');
        const hasExaApi = exa_search?.enabled && exa_search?.api_key !== '';
        const hasBraveApi = brave_search?.enabled && brave_search?.api_key !== '';

        if (hasBraveApi) {
            toolset.addTool(new BraveSearchTool(brave_search?.api_key));
        }
        if (hasExaApi) {
            toolset.addTool(new ExaSearchTool(exa_search?.api_key));
        }
        if (!hasBraveApi && !hasExaApi) {
            toolset.addTool(new BingSearchTool());
        }
        toolset.addTool(new WebFetchTool());
        return [toolset];
    }
}

export { SearchApplication };
