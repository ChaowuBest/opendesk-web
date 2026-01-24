export class BaseTool {
    /**
     * @param {string} name 工具的名称
     * @param {string} description 工具的描述
     * @param {import('zod').ZodSchema | null} params 工具的参数
     */
    constructor(name, description, params = null) {
        /** @type {string} */
        this.name = name;
        /** @type {string} */
        this.description = description;
        /** @type {object | null} */
        if (params !== null) {
            this.params = params.toJSONSchema();
        } else {
            this.params = null;
        }

        this.executor = null;
    }

    toJSON() {
        return {
            name: this.name,
            description: this.description,
            params: this.params,
        };
    }

    static fromJSON(object) {
        let tool = new BaseTool(object.name, object.description, null);
        tool.params = object.params;
        return tool;
    }

    /**
     * 自定义的工具调用结果渲染函数，如果返回 undefined，则不渲染工具调用
     * @param {ToolCall} toolcall 工具调用
     * @returns {string | undefined} 工具调用的渲染结果(如有)
     */
    renderToolCall(toolcall) {
        return undefined;
    }

    /**
     * Set the executor of the tool
     * @param {(args: z.output<this.params>) => Promise<string>} executor 工具的执行器
     * @returns {BaseTool} 工具
     */
    setExecutor(executor) {
        this.executor = executor;
        return this;
    }

    /**
     * 执行工具
     * @param {z.output<this.params>} args 工具的参数
     * @returns {Promise<string>} 工具的执行结果
     */
    async execute(args) {
        if (this.executor === null) {
            throw new Error('executor not set');
        }
        return this.executor(args);
    }
}

export class BaseToolset {
    constructor(name) {
        this.name = name;
        /** @type {Map<string, Tool>} */
        this.tools = new Map();
    }

    /**
     * Add multiple tools to the toolset
     * @param {BaseTool[]} tools
     */
    addTools(...tools) {
        for (const tool of tools) {
            this.addTool(tool);
        }
    }

    /**
     * Add a tool to the toolset
     * @param {BaseTool} tool
     */
    addTool(tool) {
        this.tools.set(tool.name, tool);
    }

    getTools() {
        return this.tools;
    }

    hasTool(name) {
        return this.tools.has(name);
    }

    /**
     * Get a tool by name
     * @param {string} name
     * @returns {BaseTool | undefined}
     */
    getTool(name) {
        return this.tools.get(name);
    }

    async callTool(toolName, args) {
        console.info('callTool', this);
        let tool = this.getTool(toolName);
        if (tool === undefined) {
            throw new Error(`tool ${toolName} not found`);
        }
        return await tool.execute(args);
    }

    toJSON() {
        return {
            name: this.name,
            tools: Array.from(this.tools.values()).map((tool) => {
                return tool.toJSON();
            }),
        };
    }

    static fromJSON(object) {
        let toolset = new BaseToolset(object.name);
        for (let tool of object.tools) {
            toolset.addTool(BaseTool.fromJSON(tool));
        }
        return toolset;
    }
}
