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

import { z } from 'zod';
import { ToolCall } from './messages';
import type { TaskState } from '../states/tasks';


export class ToolResult {
    status: 'running' | 'success' | 'error' = 'running';
    result: string = '';
    result_object?: object;

    updatedCallback?: (result: ToolResult) => void;

    static fromStringResponse(response: string): ToolResult {
        let result = new ToolResult();
        result.status = 'success';
        result.result = response;
        return result;
    }

    attachResult(chunk: string) {
        this.result += chunk;
        if (this.updatedCallback) {
            this.updatedCallback(this);
        }
    }

    updateResult(result: string) {
        this.result = result;
        if (this.updatedCallback) {
            this.updatedCallback(this);
        }
    }

    updateResultObject(result_object: object) {
        this.result_object = result_object;
        if (this.updatedCallback) {
            this.updatedCallback(this);
        }
    }
}

export class BaseTool<T extends z.ZodType> {
    name: string;
    description: string;
    params: T;
    executor?: ((args: z.output<T>, taskState?: TaskState) => Promise<string>);
    universalExecutor?: ((args: z.output<T>, result: ToolResult, taskState?: TaskState) => Promise<void>);

    constructor(name: string, description: string, params: T) {
        this.name = name;
        this.description = description;
        this.params = params;
        this.executor = undefined;
    }

    toJSON() {
        return {
            name: this.name,
            description: this.description,
            params: this.params.toJSONSchema(),
        };
    }

    static fromJSON(jsonObject: Record<string, any>) {
        let tool = new BaseTool(
            jsonObject['name'],
            jsonObject['description'],
            z.fromJSONSchema(jsonObject['params'])
        );
        return tool;
    }

    /**
     * 自定义的工具调用结果渲染函数，如果返回 undefined，则不渲染工具调用
     */
    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        return undefined;
    }

    /**
     * 自定义的工具调用结果渲染函数，用于在命令行中渲染工具调用。
     * 返回 string[] 表示渲染后的行，返回 undefined 则使用默认渲染。
     */
    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        return undefined;
    }

    /**
     * 设置工具的执行函数
     */
    setExecutor(executor: (args: z.output<T>, taskState?: TaskState) => Promise<string>): ThisType<T> {
        this.executor = executor;
        return this;
    }

    /**
     * 设置工具的通用执行函数，如果设置，则优先使用通用执行函数，否则使用普通执行函数
     */
    setUniversalExecutor(universalExecutor: (args: z.output<T>, result: ToolResult, taskState?: TaskState) => Promise<void>): ThisType<T> {
        this.universalExecutor = universalExecutor;
        return this;
    }

    /**
     * 执行工具
     */
    async execute(args: z.output<T>, updatedCallback?: (result: ToolResult) => void, taskState?: TaskState): Promise<ToolResult> {
        if (this.universalExecutor) {
            let result = new ToolResult();
            result.updatedCallback = updatedCallback;
            return await this.universalExecutor(args, result, taskState).then(() => {
                result.status = 'success';
                return result;
            }).catch((err) => {
                result.status = 'error';
                result.result = err.message;
                return result;
            });
        } else if (this.executor) {
            let result = new ToolResult();
            return await this.executor(args, taskState).then((stringResult) => {
                result.status = 'success';
                result.result = stringResult;
                return result;
            }).catch((err) => {
                result.status = 'error';
                result.result = err.message;
                return result;
            });
        } else {
            throw new Error(`executor of tool ${this.name} hasn't been set yet`);
        }
    }
}

export class BaseToolset {
    name: string;
    tools: Map<string, BaseTool<any>> = new Map();

    constructor(name: string) {
        this.name = name;
    }

    /**
     * Add multiple tools to the toolset
     */
    addTools(...tools: BaseTool<any>[]) {
        for (const tool of tools) {
            this.addTool(tool);
        }
    }

    /**
     * Add a tool to the toolset
     */
    addTool(tool: BaseTool<any>) {
        this.tools.set(tool.name, tool);
    }

    getTools(): Map<string, BaseTool<z.ZodType>> {
        return this.tools;
    }

    hasTool(name: string): boolean {
        return this.tools.has(name);
    }

    /**
     * Get a tool by name
     */
    getTool(name: string): BaseTool<any> | undefined {
        return this.tools.get(name);
    }

    async callTool(toolName: string, args: object, taskState?: TaskState): Promise<ToolResult> {
        let tool = this.getTool(toolName);
        if (tool === undefined) {
            throw new Error(`tool ${toolName} not found`);
        }
        return await tool.execute(args, undefined, taskState);
    }

    toJSON() {
        return {
            name: this.name,
            tools: Array.from(this.tools.values()).map((tool) => {
                return tool.toJSON();
            }),
        };
    }

    static fromJSON(jsonObject: Record<string, any>) {
        let toolset = new BaseToolset(jsonObject['name']);
        for (let tool of jsonObject['tools']) {
            toolset.addTool(BaseTool.fromJSON(tool));
        }
        return toolset;
    }
}
