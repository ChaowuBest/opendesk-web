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
        return `Exa搜索 ${args.query}`
    }

    async execute(args) {
        const exa = new Exa(this.api_key);
        const results = await exa.search(args.query, { text: true});
        console.info('execute', results)
        return JSON.stringify(results);
    }
}


class SearchApplication extends BaseApplication {
    constructor() {
        super('fillipdesk.search');
    }

    getConfigSchema() {
        return z.object({
            exa_search_api_key: z.string().default(''),
        });
    }

    getTools() {
        /** @type {BaseTool[]} */
        let tools = [];
        const config = this.getConfig();
        /** @type {string} */
        const exa_key = config.exa_search_api_key.trim();
        if (exa_key !== '') {
            tools.push(new ExaSearchTool(exa_key));
        }
        return tools;
    }
}

module.exports = { SearchApplication }