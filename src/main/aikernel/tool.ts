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
import type { ToolCall } from './messages.js';
import type { TaskState } from './states/tasks';
import type { PermissionRequest } from './security/permission';
import { zhCn } from '../../locale/zh-cn.js';
import { enUs } from '../../locale/en-us.js';
import { resolvePreferredLocale, type SupportedLocale } from '../../common/locale.js';
import type { ToolDisplayName } from '../../common/tool-display-name.js';
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

/** 按指定语言翻译工具显示名词条；词条缺失时回退 zh-CN，再回退 key 本身。 */
function translateToolDisplayNameKey(key: string, locale: SupportedLocale): string {
    return validationTranslations[locale]?.[key] ?? validationTranslations['zh-CN']?.[key] ?? key;
}

/**
 * 从已存在的 locale 词条构建双语显示名。
 * 仅当 zh-CN / en-US 词条都存在时返回 Record，否则返回 undefined（避免单语名被误用为双语）。
 */
function buildDisplayNameFromKey(key: string | undefined): ToolDisplayName | undefined {
    if (!key) return undefined;
    const zh = validationTranslations['zh-CN']?.[key];
    const en = validationTranslations['en-US']?.[key];
    if (zh && en) return { 'zh-CN': zh, 'en-US': en };
    return undefined;
}

function formatToolValidationError(error: z.ZodError, args?: unknown): string {
    const details = error.issues
        .map((issue) => {
            const path = issue.path.length > 0 ? issue.path.map((part) => String(part)).join('.') : '<root>';
            const reasonKey = `tool.validation.reason.${issue.code}`;
            const reason = translateToolValidation(reasonKey);
            return `${path}: ${reason === reasonKey ? issue.code : reason}`;
        })
        .join('; ');
    // 回显实际收到的顶层字段，让模型能对照发现漏传的字段（如 CallSkillTool 漏掉 toolName）并自我纠正
    const receivedFields = args && typeof args === 'object' && !Array.isArray(args) ? Object.keys(args).join(', ') : '';
    const fullDetails = receivedFields
        ? `${details}; ${translateToolValidation('tool.validation.receivedArgs', { fields: receivedFields })}`
        : details;
    return translateToolValidation('tool.validation.invalidArgs', { details: fullDetails });
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
          /**
           * true 表示参数在通过校验前经过了自动修复（如 CallSkillTool 的平铺参数还原）。
           * 调用方（processToolCall）据此把规范化参数回写 args_string，修复即回写。
           */
          repaired?: boolean;
      }
    | {
          success: false;
          error: string;
      };

/** Host-only instructions contributed by a tool that is available to the model. */
export interface ToolSystemPromptContribution {
    /** Stable identifier used to replace equivalent instructions from another tool instance. */
    id: string;
    content: string;
}

export class ToolResult implements ToolResultWriter {
    status: 'running' | 'success' | 'error' = 'running';
    result: string = '';
    result_object?: object;
    /**
     * 终端 live 输出增量（已剥离 ANSI 的纯文本）：终端执行器的 tick 推送在更新
     * result 的同时携带本次新增尾部；渲染端用它做无解析的文本追加。
     */
    outputDelta?: string;
    /** true 时 outputDelta 携带全量文本（缓冲截断/重置），渲染端需整体重写输出区。 */
    outputReset?: boolean;

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
    /** Locale key for the tool's canonical user-facing name. */
    displayNameKey?: string;
    /**
     * 工具的用户可见显示名：单语言字符串，或按语言代码（'zh-CN' / 'en-US'）映射的多语言名称。
     * 未显式声明时由 getDisplayName() 回退为协议名，getResolvedDisplayName() 会继续兼容 displayNameKey 词条。
     */
    displayName?: ToolDisplayName;
    description: string;
    params: T;
    /**
     * 限定工具仅向指定 Agent 暴露。
     * undefined 表示不限定；空数组表示不向任何 Agent 暴露。
     */
    agentIds?: readonly string[];
    executor?: (args: z.output<T>, taskState?: TaskState, toolCall?: ToolCall) => Promise<string>;
    universalExecutor?: (
        args: z.output<T>,
        result: ToolResult,
        taskState?: TaskState,
        toolCall?: ToolCall
    ) => Promise<void>;
    /**
     * 标记此工具是否需要串行执行。
     * 为 true 时，同一批次中的多个此类工具调用将按顺序执行，避免并发写入同一文件导致竞态条件。
     */
    serialExecution: boolean = false;
    /** 允许工具在错误状态下保留自定义渲染；默认继续使用统一错误卡片。 */
    renderToolCallOnError: boolean = false;
    /** getJsonSchema 的实例级缓存及对应生成时的 params 引用（引用变更即失效） */
    private jsonSchemaCache?: Record<string, any>;
    private jsonSchemaCacheSource?: z.ZodType;

    constructor(name: string, description: string, params: T, displayNameKey?: string, displayName?: ToolDisplayName) {
        this.name = name;
        this.displayNameKey = displayNameKey;
        this.displayName = displayName;
        this.description = description;
        this.params = params;
        this.executor = undefined;
    }

    /**
     * 获取工具自描述的显示名：单语言字符串或按语言映射的多语言名称。
     * 未显式声明时回退为协议名（tool.name），保证任何工具都有可展示的名称。
     */
    getDisplayName(): ToolDisplayName {
        if (this.displayName !== undefined) return this.displayName;
        return this.name;
    }

    /**
     * 按指定语言解析工具的用户可见名称：
     * 显式 displayName（string / Record）优先，其次兼容旧的 displayNameKey 词条，最后回退协议名。
     * main 侧渲染路径（如 ToolCall.getResolvedToolDisplayName）会显式传入当前运行语言；
     * 缺省时按环境检测（navigator/Intl），以便 renderer 侧复用本方法时不引入 main 进程依赖。
     *
     * @param locale 目标语言（'zh-CN' / 'en-US'）
     */
    getResolvedDisplayName(locale?: SupportedLocale): string {
        const resolvedLocale: SupportedLocale = locale ?? getToolValidationLocale();
        if (typeof this.displayName === 'string') {
            const literal = this.displayName.trim();
            if (literal) return literal;
        } else if (this.displayName !== null && typeof this.displayName === 'object') {
            const map = this.displayName;
            for (const candidate of [resolvedLocale, 'zh-CN', 'en-US']) {
                const value = map[candidate];
                if (typeof value === 'string' && value.trim()) return value.trim();
            }
            const first = Object.values(map)[0];
            if (typeof first === 'string' && first.trim()) return first.trim();
        }
        const key = typeof this.displayNameKey === 'string' ? this.displayNameKey.trim() : '';
        if (key) {
            const translated = translateToolDisplayNameKey(key, resolvedLocale);
            if (translated && translated !== key) return translated;
        }
        return this.name;
    }

    /**
     * 获取 params 的 JSON Schema（工具实例级缓存）。
     * toJSONSchema 是全量递归计算，校验/权限声明/上下文统计等高频路径反复调用开销大；
     * 按 params 引用失效，params 被替换（如 setParams）后自动重新生成。
     * 返回的是所有调用方共享的同一缓存对象，调用方不得原地修改（如增删字段、改写 required），
     * 否则会污染缓存并泄漏到其它消费方（模型适配器、权限推断、上下文统计、UI 展示等）。
     */
    getJsonSchema(): Record<string, any> {
        if (this.jsonSchemaCache === undefined || this.jsonSchemaCacheSource !== this.params) {
            this.jsonSchemaCache = this.params.toJSONSchema() as Record<string, any>;
            this.jsonSchemaCacheSource = this.params;
        }
        return this.jsonSchemaCache;
    }

    toJSON() {
        return {
            name: this.name,
            displayNameKey: this.displayNameKey,
            displayName: this.displayName,
            description: this.description,
            params: this.getJsonSchema(),
            agentIds: this.agentIds
        };
    }

    static fromJSON(jsonObject: Record<string, any>) {
        const tool = new BaseTool(
            jsonObject['name'],
            jsonObject['description'],
            z.fromJSONSchema(jsonObject['params']),
            jsonObject['displayNameKey'],
            jsonObject['displayName']
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
     * Return model instructions that are only relevant while this tool is exposed.
     * Contributions are not serialized with renderer-provided tools to prevent UI code
     * from injecting system instructions.
     */
    getSystemPromptContribution(_taskState?: TaskState): ToolSystemPromptContribution | undefined {
        return undefined;
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
     * 当前工具调用是否正在等待用户关注。
     * 返回 true 时，极简模式会在运行期间保留工具的自定义渲染。
     * 返回 false 表示明确不需要关注；返回 undefined 则交由 ToolCall 的兼容推断处理。
     */
    requiresUserAttention(_toolcall: ToolCall): boolean | undefined {
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
        universalExecutor: (
            args: z.output<T>,
            result: ToolResult,
            taskState?: TaskState,
            toolCall?: ToolCall
        ) => Promise<void>
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
                error: formatToolValidationError(parsedArgs.error, coercedArgs)
            };
        }
        return {
            success: true,
            data: parsedArgs.data
        };
    }

    /** 在校验完成后、调用执行器前转换参数；默认保持校验结果不变。 */
    protected prepareArgsForExecution(args: z.output<T>): z.output<T> {
        return args;
    }

    async execute(
        args: z.output<T>,
        updatedCallback?: (result: ToolResult) => void,
        taskState?: TaskState,
        toolCall?: ToolCall
    ): Promise<ToolResult> {
        const parsedArgs = this.validateArgs(args);
        if (!parsedArgs.success) {
            const result = new ToolResult();
            result.status = 'error';
            result.result = parsedArgs.error;
            return result;
        }
        const executionArgs = this.prepareArgsForExecution(parsedArgs.data);

        if (this.universalExecutor) {
            const result = new ToolResult();
            result.updatedCallback = updatedCallback;
            return await this.universalExecutor(executionArgs, result, taskState, toolCall)
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
            return await this.executor(executionArgs, taskState, toolCall)
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
        // 显式 displayName 优先；仅当工具声明了 displayNameKey 而未声明显示名时，
        // 从该双语词条构建（兼容插件等动态工具传入 locale key 的场景）。
        tool.displayName ??= buildDisplayNameFromKey(tool.displayNameKey);
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
