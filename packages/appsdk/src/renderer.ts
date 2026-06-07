import { z } from 'zod';

export { z };

export interface OpenDeskRendererAppAPI {
    getApplicationInfo(): Promise<unknown>;
    getManifest(): Promise<unknown>;
    getTheme(): Promise<string | null>;
    onThemeChanged(callback: (theme: string) => void): () => void;
}

export function getOpenDeskAppAPI(): OpenDeskRendererAppAPI | null {
    return (globalThis as any).opendeskAppAPI ?? null;
}

export class BaseTool<T extends z.ZodType = z.ZodType> {
    name: string;
    description: string;
    params: T;
    private executor?: (args: z.output<T>, taskState?: any) => Promise<string>;

    constructor(name: string, description: string, params: T) {
        this.name = name;
        this.description = description;
        this.params = params;
    }

    setExecutor(executor: (args: z.output<T>, taskState?: any) => Promise<string>): this {
        this.executor = executor;
        return this;
    }

    setParams(params: T): this {
        this.params = params;
        return this;
    }

    async execute(args: z.output<T>, taskState?: any): Promise<string> {
        if (!this.executor) {
            throw new Error(`executor of tool ${this.name} hasn't been set yet`);
        }
        return await this.executor(args, taskState);
    }

    toJSON(): object {
        return {
            name: this.name,
            description: this.description,
            params: this.params.toJSONSchema()
        };
    }
}

export class BaseToolset {
    name: string;
    tools: Map<string, BaseTool<any>>;

    constructor(name: string) {
        this.name = name;
        this.tools = new Map();
    }

    addTool(tool: BaseTool<any>): void {
        this.tools.set(tool.name, tool);
    }

    addTools(...tools: BaseTool<any>[]): void {
        for (const tool of tools) {
            this.addTool(tool);
        }
    }

    async callTool(toolName: string, args: object, taskState?: any): Promise<string> {
        const tool = this.tools.get(toolName);
        if (!tool) {
            throw new Error(`tool ${toolName} not found`);
        }
        return await tool.execute(args, taskState);
    }

    toJSON(): object {
        return {
            name: this.name,
            tools: Array.from(this.tools.values()).map((tool) => tool.toJSON())
        };
    }
}

export class AgentOperableHTMLElement extends HTMLElement {
    getToolset(): RendererToolset | null {
        return null;
    }

    getAgentInstruct(): string | null {
        return null;
    }
}

export class RendererTool<T extends z.ZodType = z.ZodType> extends BaseTool<T> {}

export class RendererToolset extends BaseToolset {}

export function defineOpenDeskApp(tagName: string, elementClass: CustomElementConstructor): void {
    if (!customElements.get(tagName)) {
        customElements.define(tagName, elementClass);
    }
}
