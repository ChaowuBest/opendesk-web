import { z } from '../../assets/scripts/zod.min.js';

export { z };

export class Tool {
    constructor(name, description) {
        this.name = name;
        this.description = description;
        this.params = z.object({});
    }

    /**
     * 设置工具描述
     * @param {string} description 工具描述
     * @returns {Tool} 工具
     */
    description(description) {
        this.description = description;
        return this;
    }
}

export class Toolset {
    constructor(name) {
        this.name = name;
        /** @type {Map<string, Tool>} */
        this.tools = new Map();
    }

    /**
     * 创建工具
     * @param {string} name 工具名称
     * @param {string} description 工具描述
     * @returns {Tool} 工具
     */
    createTool(name, description) {
        let tool = new Tool(name, description);
        this.tools.set(tool.name, tool);
        return tool;
    }

    /**
     * 获取或创建工具
     * @param {string} name 工具名称
     * @returns {Tool} 工具
     */
    getOrCreateTool(name) {
        if (this.tools.has(name)) {
            return this.tools.get(name);
        }

        return this.createTool(name, "");
    }

    getTools() {
        return this.tools;
    }

    toJSON() {
        return {
            name: this.name,
            tools: Array.from(this.tools.values()).map((tool) => {
                return {
                    name: tool.name,
                    description: tool.description,
                    params: tool.params.toJSONSchema(),
                };
            }),
        };
    }
}