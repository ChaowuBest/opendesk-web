const { BaseApplication } = require("../base");
const { BaseTool } = require("../../agents/tool");
const { z } = require("zod");
const { Exa } = require('exa-js');


class ExaSearchTool extends BaseTool {
    constructor(api_key) {
        super('ExaSearch', 'Search the web using ExaSearch', z.object({
            query: z.string(),
        }));
        this.api_key = api_key;
    }

    async getTitle(args) {
        return `搜索 ${args.query}`
    }

    async execute(args) {
        const exa = new Exa(this.api_key);
        const results = await exa.search(args.query, {
            numResults: 15,
            type: 'auto',
            contents: {
                summary: true
            }
        });

        let result = "总计找到 ${results.results.length} 条结果：\n\n";
        for (let result of results.results) {
            result += `- 搜索结果： ${result.title}\n`;
            result += `  - url: ${result.url}\n`;
            result += `  - 摘要: <summary>${result.summary}</summary>\n`;
        }
        return result;
    }
}


class SearchApplication extends BaseApplication {
    constructor() {
        super('search');
    }

    getConfigSchema() {
        return z.object({
            exa_search_api_key: z.string().default(''),
        });
    }

    getTools() {
        const config = this.getConfig();
        if (config === undefined) {
            return [];
        }

        let tools = [];
        const exa_key = config.exa_search_api_key.trim();
        if (exa_key !== '') {
            tools.push(new ExaSearchTool(exa_key));
        }
        return tools;
    }
}

module.exports = { SearchApplication }