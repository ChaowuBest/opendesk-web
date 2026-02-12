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

import { BaseApplication } from "../base.js";
import { BaseTool, BaseToolset } from "../../agents/tool";
import { z } from 'zod';
import { Exa } from 'exa-js';


class ExaSearchTool extends BaseTool {
    constructor(api_key) {
        super('ExaSearch', 'Search the web using ExaSearch', z.object({
            query: z.string(),
        }));
        this.api_key = api_key;
        this.setExecutor(this.search);
    }

    async search(args) {
        const exa = new Exa(this.api_key);
        const searchResults = await exa.search(args.query, {
            numResults: 15,
            type: 'auto',
            contents: {
                summary: true
            }
        });

        let result = `总计找到 ${searchResults.results.length} 条结果：\n\n`;
        for (let item of searchResults.results) {
            result += `- 搜索结果： ${item.title}\n`;
            result += `  - url: ${item.url}\n`;
            result += `  - 摘要: <summary>${item.summary}</summary>\n`;
        }

        return result;
    }
}


class SearchApplication extends BaseApplication {
    constructor() {
        super('search', '融合搜索');
    }

    static getConfigSchema() {
        return z.object({
            exa_search: z.object({
                api_key: z.string().default('').describe('ExaSearch的API密钥'),
                enabled: z.boolean().default(false).describe('是否启用ExaSearch'),
            }).optional()
        });
    }

    async getToolsets() {
        const exa_search = this.getConfig()?.exa_search;
        const toolset = new BaseToolset('search');
        if (exa_search?.enabled && exa_search?.api_key !== '') {
            toolset.addTool(new ExaSearchTool(exa_search?.api_key));
        }
        return [toolset];
    }
}

export { SearchApplication };