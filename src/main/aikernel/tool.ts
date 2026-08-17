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
import type { TaskState } from './states/tasks';
import type { PermissionRequest } from './security/permission';
import { zhCn } from '../../locale/zh-cn.js';
import { enUs } from '../../locale/en-us.js';
import { resolvePreferredLocale } from '../../common/locale.js';
import type { ToolResultWriter } from './types/index.js';

const validationTranslations: Record<string, Record<string, string>> = {
    'zh-CN': zhCn,
    'en-US': enUs
};

function getToolValidationLocale(): string {
    const navigatorLanguages =
        typeof globalThis.navigator !== 'undefined' && Array.isArray(globalThis.navigator.languages)
            ? [...globalThis.navigator.languages]
            : [];
    const intlLocale = Intl.DateTimeFormat().resolvedOptions().locale;
    return resolvePreferredLocale([...navigatorLanguages, intlLocale]);
}

function translateToolValidation(key: string, params?: Record<string, string | number>): string {
    const locale = getToolValidationLocale();
    let text = validationTranslations[locale]?.[key] ?? validationTranslations['zh-CN']?.[key] ?? key;
    if (params) {
        for (const [k, v] of Object.entries(params)) {
            text = text.replace(new RegExp(`\\$\\{${k}\\}`, 'g'), String(v));
        }
    }
    return text;
}

function formatToolValidationError(error: z.ZodError): string {
    const details = error.issues
        .map((issue) => {
            const path = issue.path.length > 0 ? issue.path.map((part) => String(part)).join('.') : '<root>';
            const reasonKey = `tool.validation.reason.${issue.code}`;
            const reason = translateToolValidation(reasonKey);
            return `${path}: ${reason === reasonKey ? issue.code : reason}`;
        })
        .join('; ');
    return translateToolValidation('tool.validation.invalidArgs', { details });
}

/**
 * 递归剥离 ZodOptional / ZodDefault / ZodNullable / ZodCatch / ZodReadonly 等包装层，
 * 返回最内层的核心类型（如 ZodBoolean、ZodNumber）。
 */
function unwrapZodType(schema: z.ZodType): z.ZodType {
    let current: z.ZodType = schema;
    while (
        current instanceof z.ZodOptional ||
        current instanceof z.ZodDefault ||
        current instanceof z.ZodNullable ||
        current instanceof z.ZodCatch ||
        current instanceof z.ZodReadonly
    ) {
        current = (current as z.ZodOptional<z.ZodType> | z.ZodDefault<z.ZodType>).unwrap();
    }
    return current;
}

/**
 * 部分模型会将 boolean / number 参数输出为字符串（如 "false"、"0"），
 * 导致 Zod 校验失败。此函数根据 schema 的期望类型做入口处强制转换，
 * 使下游 safeParse 和工具执行逻辑无需重复处理此问题。
 */
function coerceScalarArgs(params: z.ZodType, args: unknown): unknown {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
        return args;
    }
    if (!(params instanceof z.ZodObject)) {
        return args;
    }
    const shape = params.shape;
    const result: Record<string, unknown> = { ...(args as Record<string, unknown>) };
    let modified = false;
    for (const [key, fieldSchema] of Object.entries(shape)) {
        if (!(key in result)) continue;
        const value = result[key];
        if (typeof value !== 'string') continue;
        const innerType = unwrapZodType(fieldSchema as z.ZodType);
        if (innerType instanceof z.ZodBoolean) {
            if (value === 'true') {
                result[key] = true;
                modified = true;
            } else if (value === 'false') {
                result[key] = false;
                modified = true;
            }
        } else if (innerType instanceof z.ZodNumber) {
            const trimmed = value.trim();
            if (trimmed !== '' && !isNaN(Number(trimmed))) {
                result[key] = Number(trimmed);
                modified = true;
            }
        }
    }
    return modified ? result : args;
}

export type ToolArgsValidationResult<T extends z.ZodType> =
    | {
          success: true;
          data: z.output<T>;
      }
    | {
          success: false;
          error: string;
      };

export class ToolResult implements ToolResultWriter {
    status: 'running' | 'success' | 'error' = 'running';
    result: string = '';
    result_object?: object;

    updatedCallback?: (result: ToolResult) => void;

    static fromStringResponse(response: string): ToolResult {
        const result = new ToolResult();
        result.status = 'success';
        result.result = response;
        return result;
    }

    private safeInvokeCallback() {
        if (!this.updatedCallback) return;
        try {
            const ret = this.updatedCallback(this);
            // updatedCallback 可能是 async 函数，捕获返回的 rejected promise
            if (ret && typeof (ret as any).catch === 'function') {
                (ret as any).catch((err: unknown) => {
                    console.warn(
                        `[ToolResult] updatedCallback async error: ${err instanceof Error ? err.stack || err.message : err}`
                    );
                });
            }
        } catch (err) {
            console.warn(
                `[ToolResult] updatedCallback error: ${err instanceof Error ? err.stack || err.message : err}`
            );
        }
    }

    attachResult(chunk: string) {
        this.result += chunk;
        this.safeInvokeCallback();
    }

    updateResult(result: string) {
        this.result = result;
        this.safeInvokeCallback();
    }

    updateResultObject(result_object: object) {
        this.result_object = result_object;
        this.safeInvokeCallback();
    }
}

export class BaseTool<T extends z.ZodType> {
    name: string;
    description: string;
    params: T;
    /**
     * 限定工具仅向指定 Agent 暴露。
     * undefined 表示不限定；空数组表示不向任何 Agent 暴露。
     */
    agentIds?: readonly string[];
    executor?: (args: z.output<T>, taskState?: TaskState) => Promise<string>;
    universalExecutor?: (args: z.output<T>, result: ToolResult, taskState?: TaskState) => Promise<void>;
    /**
     * 标记此工具是否需要串行执行。
     * 为 true 时，同一批次中的多个此类工具调用将按顺序执行，避免并发写入同一文件导致竞态条件。
     */
    serialExecution: boolean = false;

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
            agentIds: this.agentIds
        };
    }

    static fromJSON(jsonObject: Record<string, any>) {
        const tool = new BaseTool(
            jsonObject['name'],
            jsonObject['description'],
            z.fromJSONSchema(jsonObject['params'])
        );
        tool.agentIds = Array.isArray(jsonObject['agentIds']) ? jsonObject['agentIds'] : undefined;
        return tool;
    }

    /**
     * 停止工具的执行。子类可重写此方法以实现清理逻辑（如终止子进程）。
     * 默认空实现，调用方无需检查是否重写。
     */
    async stop(): Promise<void> {}

    /**
     * 声明本工具在执行给定参数时所需的权限。
     * 子类应重写此方法来声明具体的权限需求（如文件读写路径）。
     * 默认返回空数组表示不需要特殊权限。
     *
     * @param args 本次调用的参数
     * @param taskState 当前任务状态（可用于获取工作空间等上下文）
     * @returns 所需权限列表
     */
    getDeclaredPermissions(args: z.output<T>, taskState?: TaskState): PermissionRequest[] {
        return [];
    }

    /**
     * 判断工具在当前任务上下文中是否可用。
     * 默认始终可用；子类可重写以实现按任务/模式动态屏蔽（如 exitPlanMode 仅在 Plan 模式可用）。
     *
     * @param taskState 当前任务状态（可为 undefined）
     */
    isAvailable(_taskState?: TaskState): boolean | Promise<boolean> {
        return true;
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
    setUniversalExecutor(
        universalExecutor: (args: z.output<T>, result: ToolResult, taskState?: TaskState) => Promise<void>
    ): ThisType<T> {
        this.universalExecutor = universalExecutor;
        return this;
    }

    /**
     * 执行工具
     */
    validateArgs(args: unknown): ToolArgsValidationResult<T> {
        const coercedArgs = coerceScalarArgs(this.params, args);
        if (coercedArgs !== args) {
            console.warn(`[tool] "${this.name}": coerced string args to expected scalar types before validation`);
        }
        const parsedArgs = this.params.safeParse(coercedArgs);
        if (!parsedArgs.success) {
            return {
                success: false,
                error: formatToolValidationError(parsedArgs.error)
            };
        }
        return {
            success: true,
            data: parsedArgs.data
        };
    }

    async execute(
        args: z.output<T>,
        updatedCallback?: (result: ToolResult) => void,
        taskState?: TaskState
    ): Promise<ToolResult> {
        const parsedArgs = this.validateArgs(args);
        if (!parsedArgs.success) {
            const result = new ToolResult();
            result.status = 'error';
            result.result = parsedArgs.error;
            return result;
        }

        if (this.universalExecutor) {
            const result = new ToolResult();
            result.updatedCallback = updatedCallback;
            return await this.universalExecutor(parsedArgs.data, result, taskState)
                .then(() => {
                    result.status = 'success';
                    return result;
                })
                .catch((err) => {
                    result.status = 'error';
                    result.result = err.message;
                    return result;
                });
        } else if (this.executor) {
            const result = new ToolResult();
            return await this.executor(parsedArgs.data, taskState)
                .then((stringResult) => {
                    result.status = 'success';
                    result.result = stringResult;
                    return result;
                })
                .catch((err) => {
                    result.status = 'error';
                    result.result = err.message;
                    return result;
                });
        } else {
            throw new Error(`executor of tool ${this.name} hasn't been set yet`);
        }
    }
}

export class BaseToolset<T extends BaseTool<any> = BaseTool<any>> {
    name: string;
    tools: Map<string, T> = new Map();

    constructor(name: string) {
        this.name = name;
    }

    /**
     * Add multiple tools to the toolset
     */
    addTools(...tools: T[]) {
        for (const tool of tools) {
            this.addTool(tool);
        }
    }

    /**
     * Add a tool to the toolset
     */
    addTool(tool: T) {
        this.tools.set(tool.name, tool);
    }

    getTools(): Map<string, T> {
        return this.tools;
    }

    hasTool(name: string): boolean {
        return this.tools.has(name);
    }

    /**
     * Get a tool by name
     */
    getTool(name: string): T | undefined {
        return this.tools.get(name);
    }

    async callTool(toolName: string, args: object, taskState?: TaskState): Promise<ToolResult> {
        const tool = this.getTool(toolName);
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
            })
        };
    }

    static fromJSON(jsonObject: Record<string, any>) {
        const toolset = new BaseToolset(jsonObject['name']);
        for (const tool of jsonObject['tools']) {
            toolset.addTool(BaseTool.fromJSON(tool));
        }
        return toolset;
    }
}

/**
 * 可主动取消的交互工具基类。
 * askUser / exitPlanMode 等阻塞式交互工具在等待用户操作时可被主动取消，
 * 因此必须实现 cancelCurrent。
 */
export abstract class InteractiveTool<T extends z.ZodType> extends BaseTool<T> {
    /** 取消当前等待中的交互提示。 */
    abstract cancelCurrent(): void;
}

/**
 * 交互工具集：其包含的工具均为 InteractiveTool，保证可统一调用 cancelCurrent。
 */
export class InteractiveToolset extends BaseToolset<InteractiveTool<any>> {
    constructor(name: string) {
        super(name);
    }

    /** 取消当前等待中的所有交互提示（askUser / exitPlanMode）。 */
    cancelAll(): void {
        for (const tool of this.tools.values()) {
            tool.cancelCurrent();
        }
    }
}

/**
 * 工具集提供者接口
 * 用于解耦 aikernel 与 applications 层，由外部实现具体的工具集提供逻辑
 */
export interface ToolsetProvider {
    listAvailableToolsets(taskState?: TaskState): Promise<BaseToolset[]>;
}

export class EmptyToolsetProvider implements ToolsetProvider {
    async listAvailableToolsets(): Promise<BaseToolset[]> {
        return [];
    }
}
