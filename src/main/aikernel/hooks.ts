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

import type { TaskState } from './states/tasks.js';
import type { ToolCall, AssistantMessage } from './messages.js';
import type { LLMRequestOptions } from './llm.js';
import { logger } from '../utils/logger.js';

/******************************************************************************
 * Finish Turn Callbacks
 * ------------------------
 * 1. 所谓一个 turn，指的是从发给 agent 一次消息，然后 agent 循环执行工具，反馈结果，直到
 *    这次消息的完整回复过程完成的完整循环；
 * 2. 在很多场景下，对于 turn 结束我们有一定的要求。比如：
 *   - 如果还有未完成的待办事项，应当继续处理直到完成
 *   - 有的情况下系统会要求任务以特定的工具结束
 *   - ......
 * 3. 所以我们允许在任务中挂在 beforeFinishTurn 和 afterFinishTurn 两种钩子，前者主要
 *    用于对 turn 结束的操作进行阻断，强行继续等有状态操作，后者主要用于观测等操作
 ******************************************************************************/

/******************************************************************************
 * Tool Call Callbacks
 * ------------------------
 * 1. 所谓一次工具调用，指的是从发起对某工具的调用，到真正执行工具、将结果写回
 *    tool_call.result 的完整过程；
 * 2. 在很多场景下，对工具调用前后我们有一定的要求。比如：
 *   - 执行前：参数校验、审计、安全拦截等（beforeToolCall）
 *   - 执行后：将超长结果落盘并替换为摘要、观测等（afterToolCall，可改写 tool_call.result）
 * 3. 所以我们允许在全局或任务中挂载 beforeToolCall 和 afterToolCall 两种钩子
 * 4. beforeToolCall 返回 deny 时：阻止该工具执行，将 message 写回 tool_call.result；
 *    返回 allow 时：继续正常执行。
 ******************************************************************************/

/******************************************************************************
 * Parse Tool Call Callbacks
 * ------------------------
 * 1. 在模型流式输出过程中，每当一个工具调用的参数解析完成（下一个工具调用到达、
 *    流结束、或检测到 partial object），立即调用 afterParseToolcall 钩子；
 * 2. 钩子返回 reject 时：丢弃该工具调用并终止当前流式解析；
 *    返回 finish 时：保留该工具调用，继续正常流程。
 * 3. 即使有工具调用被 reject，已经成功解析的前置工具调用仍会正常执行。
 ******************************************************************************/

/******************************************************************************
 * Before Toolcall Created Callbacks
 * ----------------------------------
 * 1. 在模型流式输出过程中，每次 chunk 到达后在 mergeChunk 之前触发
 *    （此时新工具调用尚未追加到 assistant message）；
 * 2. 钩子返回 accept 时：继续正常流式解析并合并当前 chunk；
 *    返回 reject 时：不合并当前 chunk，跳出流式解析循环，
 *    进入工具调用执行阶段。
 * 3. 典型用途：工具调用数量限制、重复工具调用检测（模型死循环检测）等。
 ******************************************************************************/

/******************************************************************************
 * Hooks 调度模型
 * ------------------------
 * 1. Hooks 类支持多级继承，通过 parent 链形成父子关系。
 * 2. 调度时先按 priority 升序执行本层全部钩子，再递交给 parent 继续执行。
 *    priority 越小越先执行，相同 priority 按注册顺序执行。
 * 3. check 类钩子（返回 reject/deny 的）会在第一次拒绝时短路返回；
 *    notice 类钩子（无返回值的）始终全部执行。
 * 4. 系统中存在一个全局实例 GlobalHooks，每个任务通过 createChildHooks()
 *    创建任务级钩子实例，其 parent 指向 GlobalHooks。
 ******************************************************************************/

type FinishTurnFeedback = { operation: 'finish' } | { operation: 'reject'; message: string };

type BeforeToolcallCreatedFeedback = { operation: 'accept' } | { operation: 'reject'; message: string };

type ParseToolcallFeedback = { operation: 'finish' } | { operation: 'reject'; message: string };

export type BeforeToolCallFeedback =
    | { operation: 'allow'; extra?: Record<string, unknown> }
    | { operation: 'deny'; message: string; extra?: Record<string, unknown> };

type BeforeFinishTurnCallback = (
    task: TaskState,
    modelRequestOptions?: LLMRequestOptions
) => Promise<FinishTurnFeedback>;

type AfterFinishTurnCallback = (task: TaskState) => void | Promise<void>;

type BeforeTaskStartCallback = (task: TaskState) => void | Promise<void>;

type OnTaskReviewCallback = (task: TaskState, start_message_index: number) => boolean | void | Promise<boolean | void>;

type OnTaskRevertCallback = (task: TaskState) => void | Promise<void>;

type AfterParseToolcallCallback = (task: TaskState, tool_call: ToolCall) => Promise<ParseToolcallFeedback>;

type BeforeToolCallCallback = (
    task: TaskState,
    tool_call: ToolCall
) => BeforeToolCallFeedback | Promise<BeforeToolCallFeedback>;

type AfterToolCallCallback = (task: TaskState, tool_call: ToolCall) => void | Promise<void>;

type BeforeTurnStartCallback = (task: TaskState) => void | Promise<void>;

type AfterProcessCompletionCallback = (task: TaskState, assistantMessage: AssistantMessage) => void | Promise<void>;

type BeforeToolcallCreatedCallback = (
    task: TaskState,
    assistantMessage: AssistantMessage,
    chunkHasNewToolCall: boolean,
    requestToolCalls: readonly ToolCall[]
) => Promise<BeforeToolcallCreatedFeedback>;

/** 钩子注册选项；priority 范围 [0, 65535]，缺省为 0；priority 越小越先执行 */
export interface HookOptions {
    priority?: number;
}

/** 钩子条目：包含 callback 与解析后的 options */
export interface Hook<CallbackTy> {
    callback: CallbackTy;
    options: Required<HookOptions>;
}

const MAX_HOOK_PRIORITY = 65535;

/** 解析 HookOptions，做范围校验；越界时截断到 [0, 65535] 并记录警告 */
function resolveHookOptions(options?: HookOptions): Required<HookOptions> {
    let priority = options?.priority ?? 0;
    if (!Number.isInteger(priority) || priority < 0 || priority > MAX_HOOK_PRIORITY) {
        logger.warn(`Hook priority ${priority} is out of range [0, ${MAX_HOOK_PRIORITY}], clamping to valid range`);
        if (!Number.isFinite(priority)) {
            priority = 0;
        } else {
            priority = Math.trunc(priority);
            priority = Math.max(0, Math.min(MAX_HOOK_PRIORITY, priority));
        }
    }
    return { priority };
}

/** 将钩子数组按 priority 升序排序（稳定排序：相同 priority 保持注册顺序） */
function sortHooks<T>(hooks: Hook<T>[]): Hook<T>[] {
    return [...hooks].sort((a, b) => a.options.priority - b.options.priority);
}

/**
 * 钩子容器：支持多级继承关系。
 *
 * - 调度时先按 priority 升序执行本层全部钩子，再递交给 parent 继续执行。
 * - priority 越小越先执行，相同 priority 按注册顺序执行。
 * - check 类钩子在第一次拒绝时短路返回；notice 类钩子始终全部执行。
 *
 * 全局唯一实例 GlobalHooks 通过 Hooks.createGlobal() 创建；
 * 任务级钩子通过 GlobalHooks.createChildHooks() 创建，其 parent 指向 GlobalHooks。
 */
export class Hooks {
    private readonly parent: Hooks | undefined;

    beforeFinishTurnHooks: Hook<BeforeFinishTurnCallback>[] = [];
    afterFinishTurnHooks: Hook<AfterFinishTurnCallback>[] = [];
    beforeTaskStartHooks: Hook<BeforeTaskStartCallback>[] = [];
    onTaskReviewHooks: Hook<OnTaskReviewCallback>[] = [];
    onTaskRevertHooks: Hook<OnTaskRevertCallback>[] = [];
    afterParseToolcallHooks: Hook<AfterParseToolcallCallback>[] = [];
    beforeToolCallHooks: Hook<BeforeToolCallCallback>[] = [];
    afterToolCallHooks: Hook<AfterToolCallCallback>[] = [];
    beforeTurnStartHooks: Hook<BeforeTurnStartCallback>[] = [];
    afterProcessCompletionHooks: Hook<AfterProcessCompletionCallback>[] = [];
    beforeToolcallCreatedHooks: Hook<BeforeToolcallCreatedCallback>[] = [];

    private constructor(parent?: Hooks) {
        this.parent = parent;
    }

    /** 创建全局 Hooks 实例（无 parent） */
    static createGlobal(): Hooks {
        return new Hooks(undefined);
    }

    /** 创建一个子 Hooks 实例，其 parent 指向当前实例 */
    createChildHooks(): Hooks {
        return new Hooks(this);
    }

    /**
     * 注册 `beforeFinishTurn` 钩子。
     *
     * 触发时机：一个 turn 的所有工具调用执行完毕后，系统准备结束该 turn 时触发。
     * 回调签名：`(task: TaskState) => Promise<{ operation: 'finish' | 'reject', message?: string }>`
     * - 返回 `finish`：允许 turn 正常结束。
     * - 返回 `reject`：阻止 turn 结束，系统会用 `message` 作为新的用户消息重新发起一轮模型调用。
     *
     * 典型用途：确保任务以特定工具结尾（如 attemptCompletion），或检测未完成的待办事项强制继续。
     */
    beforeFinishTurn(callback: BeforeFinishTurnCallback, options?: HookOptions): void {
        this.beforeFinishTurnHooks.push({ callback, options: resolveHookOptions(options) });
    }

    /**
     * 注册 `afterFinishTurn` 钩子（纯通知，无返回值）。
     *
     * 触发时机：turn 已经确定结束之后，在清理 / 状态切换之前触发。
     * 回调签名：`(task: TaskState) => void | Promise<void>`
     *
     * 典型用途：记录日志、统计、触发后续异步任务（如会话记忆提取）。
     */
    afterFinishTurn(callback: AfterFinishTurnCallback, options?: HookOptions): void {
        this.afterFinishTurnHooks.push({ callback, options: resolveHookOptions(options) });
    }

    /**
     * 注册 `beforeTaskStart` 钩子（纯通知，无返回值）。
     *
     * 触发时机：任务即将首次开始执行时（system prompt 已设置，用户消息提交之前）。
     * 回调签名：`(task: TaskState) => void | Promise<void>`
     *
     * 典型用途：在任务开始前注入额外的系统消息或进行初始化配置。
     */
    beforeTaskStart(callback: BeforeTaskStartCallback, options?: HookOptions): void {
        this.beforeTaskStartHooks.push({ callback, options: resolveHookOptions(options) });
    }

    /**
     * 注册 `onTaskReview` 钩子。
     *
     * 触发时机：任务达到空闲回顾阈值，或用户手动触发"审查任务"操作时。
     * 回调签名：`(task: TaskState, start_message_index: number) => boolean | void | Promise<boolean | void>`
     * - 返回 `true` 表示该钩子已接受审查请求，审查流程可能已启动或正在排队。
     *
     * 典型用途：为任务提供自动审查 / 代码审查能力。
     */
    onTaskReview(callback: OnTaskReviewCallback, options?: HookOptions): void {
        this.onTaskReviewHooks.push({ callback, options: resolveHookOptions(options) });
    }

    /**
     * 注册 `onTaskRevert` 钩子（纯通知，无返回值）。
     *
     * 触发时机：任务发生回退时（用户通过 GUI "回退到这里" / "从这里继续" 或 CLI /undo 操作）。
     * 回调签名：`(task: TaskState) => void | Promise<void>`
     * 钩子在回退完成后触发，此时 task 已回退到目标用户消息处。
     *
     * 典型用途：清理回退相关的临时状态、记录审计日志。
     */
    onTaskRevert(callback: OnTaskRevertCallback, options?: HookOptions): void {
        this.onTaskRevertHooks.push({ callback, options: resolveHookOptions(options) });
    }

    /**
     * 注册 `afterParseToolcall` 钩子。
     *
     * 触发时机：模型流式输出中，每当一个工具调用的参数 JSON 解析完成时触发
     * （下一个工具调用到达、流结束、或检测到 partial object 时）。
     * 回调签名：`(task: TaskState, tool_call: ToolCall) => Promise<{ operation: 'finish' | 'reject', message: string }>`
     * - 返回 `finish`：保留该工具调用，继续正常流程。
     * - 返回 `reject`：丢弃该工具调用并终止当前流式解析。
     *
     * 注意：即使有工具调用被 reject，已经成功解析的前置工具调用仍会正常执行。
     *
     * 典型用途：安全审查、参数合规性校验、在解析阶段提前拦截高风险工具调用。
     */
    afterParseToolcall(callback: AfterParseToolcallCallback, options?: HookOptions): void {
        this.afterParseToolcallHooks.push({ callback, options: resolveHookOptions(options) });
    }

    /**
     * 注册 `beforeToolCall` 钩子。
     *
     * 触发时机：每个工具调用**执行之前**（权限检查通过后，`tool.execute()` 之前）。
     * 回调签名：`(task: TaskState, tool_call: ToolCall) => { operation: 'allow' | 'deny', message?: string }`
     * - 返回 `allow`：继续执行该工具。
     * - 返回 `deny`：阻止执行，`message` 会写入 `tool_call.result` 作为错误信息返回给模型。
     *
     * 典型用途：安全拦截（AgentGate）、循环检测（电路断路器）、参数审计。
     */
    beforeToolCall(callback: BeforeToolCallCallback, options?: HookOptions): void {
        this.beforeToolCallHooks.push({ callback, options: resolveHookOptions(options) });
    }

    /**
     * 注册 `afterToolCall` 钩子（纯通知，无返回值）。
     *
     * 触发时机：每个工具调用**执行完成后**（无论成功或失败），在 `freezeRenderResult` 之前触发。
     * 回调签名：`(task: TaskState, tool_call: ToolCall) => void | Promise<void>`
     * 此时 `tool_call.status`、`tool_call.result`、`tool_call.result_object` 均已就绪，
     * 钩子可以读取或改写它们（如将超长结果落盘并替换为摘要）。
     *
     * 典型用途：结果后处理（摘要、索引）、观测（性能埋点）、循环检测（readFile unchanged 计数）。
     */
    afterToolCall(callback: AfterToolCallCallback, options?: HookOptions): void {
        this.afterToolCallHooks.push({ callback, options: resolveHookOptions(options) });
    }

    /** 按裸工具名或带 bundle 前缀的工具名注册钩子。 */
    registerToolHook(
        toolName: string,
        hooks: {
            beforeToolCall?: BeforeToolCallCallback;
            afterToolCall?: AfterToolCallCallback;
        },
        options?: HookOptions
    ): void {
        const matches = (name: string) => name === toolName || name.endsWith(`-${toolName}`);
        if (hooks.beforeToolCall) {
            const callback = hooks.beforeToolCall;
            this.beforeToolCall(async (task, toolCall) => {
                if (!matches(toolCall.tool_name)) {
                    return { operation: 'allow' };
                }
                return callback(task, toolCall);
            }, options);
        }
        if (hooks.afterToolCall) {
            const callback = hooks.afterToolCall;
            this.afterToolCall(async (task, toolCall) => {
                if (matches(toolCall.tool_name)) {
                    await callback(task, toolCall);
                }
            }, options);
        }
    }

    /**
     * 注册 `beforeTurnStart` 钩子（纯通知，无返回值）。
     *
     * 触发时机：每个新 turn 的**最开始**，在 `processCompletion()` 第一次调用之前触发。
     * 同一个 turn 内只会触发一次。适合在此处重置 per-turn 状态。
     * 回调签名：`(task: TaskState) => void | Promise<void>`
     *
     * 典型用途：重置轮次内的计数器、熔断器状态、性能计时器等。
     */
    beforeTurnStart(callback: BeforeTurnStartCallback, options?: HookOptions): void {
        this.beforeTurnStartHooks.push({ callback, options: resolveHookOptions(options) });
    }

    /**
     * 注册 `afterProcessCompletion` 钩子（纯通知，无返回值）。
     *
     * 触发时机：每次 `processCompletion()` 返回后，**在工具调用执行之前**触发。
     * 也就是说，模型刚刚完成了一轮思考（reasoning + text + tool_calls），
     * 钩子可以检查模型的输出质量或状态。
     * 回调签名：`(task: TaskState, assistantMessage: AssistantMessage) => void | Promise<void>`
     *
     * `assistantMessage` 是模型刚生成的消息，包含 reasoning、text 和 tool_call parts。
     * 钩子可以通过 `task.appendInternalUserMessage()` 向上下文注入提示来引导下一轮模型行为。
     *
     * 典型用途：检测 reasoning 重复（电路断路器）、输出质量检查、自动纠偏提示注入。
     */
    afterProcessCompletion(callback: AfterProcessCompletionCallback, options?: HookOptions): void {
        this.afterProcessCompletionHooks.push({ callback, options: resolveHookOptions(options) });
    }

    /**
     * 注册 `beforeToolcallCreated` 钩子。
     *
     * 触发时机：模型流式输出中，每次 chunk 到达后在 mergeChunk 之前触发
     * （新工具调用尚未追加到 assistant message）。
     * 回调签名：
     * `(task, assistantMessage, chunkHasNewToolCall, requestToolCalls) => Promise<{ operation: 'accept' | 'reject', ... }>`
     * `requestToolCalls` 仅包含本次 `processCompletion` 中已合并的工具调用。
     * - 返回 `accept`：继续正常流式解析并合并当前 chunk。
     * - 返回 `reject`：不合并当前 chunk，跳出流式解析循环，进入工具调用执行阶段。
     *
     * 典型用途：工具调用数量限制、重复工具调用检测（模型死循环）。
     */
    beforeToolcallCreated(callback: BeforeToolcallCreatedCallback, options?: HookOptions): void {
        this.beforeToolcallCreatedHooks.push({ callback, options: resolveHookOptions(options) });
    }

    async checkBeforeFinishTurn(task: TaskState, modelRequestOptions?: LLMRequestOptions): Promise<FinishTurnFeedback> {
        for (const hook of sortHooks(this.beforeFinishTurnHooks)) {
            try {
                const feedback = await hook.callback(task, modelRequestOptions);
                if (feedback.operation === 'reject') {
                    return feedback;
                }
            } catch (err) {
                logger.error('Hooks.checkBeforeFinishTurn: callback error', err);
            }
        }
        if (this.parent) {
            return this.parent.checkBeforeFinishTurn(task, modelRequestOptions);
        }
        return { operation: 'finish' };
    }

    async noticeAfterFinishTurn(task: TaskState): Promise<void> {
        for (const hook of sortHooks(this.afterFinishTurnHooks)) {
            try {
                await hook.callback(task);
            } catch (err) {
                logger.error('Hooks.noticeAfterFinishTurn: callback error', err);
            }
        }
        if (this.parent) {
            await this.parent.noticeAfterFinishTurn(task);
        }
    }

    async noticeBeforeTaskStart(task: TaskState): Promise<void> {
        for (const hook of sortHooks(this.beforeTaskStartHooks)) {
            try {
                await hook.callback(task);
            } catch (err) {
                logger.error('Hooks.noticeBeforeTaskStart: callback error', err);
            }
        }
        if (this.parent) {
            await this.parent.noticeBeforeTaskStart(task);
        }
    }

    async noticeTaskReview(task: TaskState, start_message_index: number): Promise<boolean> {
        let started = false;
        for (const hook of sortHooks(this.onTaskReviewHooks)) {
            try {
                started = (await hook.callback(task, start_message_index)) === true || started;
            } catch (err) {
                logger.error('Hooks.noticeTaskReview: callback error', err);
            }
        }
        if (this.parent) {
            const parentStarted = await this.parent.noticeTaskReview(task, start_message_index);
            return parentStarted || started;
        }
        return started;
    }

    async noticeTaskRevert(task: TaskState): Promise<void> {
        for (const hook of sortHooks(this.onTaskRevertHooks)) {
            try {
                await hook.callback(task);
            } catch (err) {
                logger.error('Hooks.noticeTaskRevert: callback error', err);
            }
        }
        if (this.parent) {
            await this.parent.noticeTaskRevert(task);
        }
    }

    async checkAfterParseToolcall(task: TaskState, tool_call: ToolCall): Promise<ParseToolcallFeedback> {
        // afterParseToolcall 在流式解析期间每个 tool call 参数完成时触发，
        // 不创建 span 以避免噪声
        for (const hook of sortHooks(this.afterParseToolcallHooks)) {
            try {
                const feedback = await hook.callback(task, tool_call);
                if (feedback.operation === 'reject') {
                    return feedback;
                }
            } catch (err) {
                logger.error('Hooks.checkAfterParseToolcall: callback error', err);
            }
        }
        if (this.parent) {
            return this.parent.checkAfterParseToolcall(task, tool_call);
        }
        return { operation: 'finish' };
    }

    async checkBeforeToolCall(task: TaskState, tool_call: ToolCall): Promise<BeforeToolCallFeedback> {
        for (const hook of sortHooks(this.beforeToolCallHooks)) {
            try {
                const feedback = await hook.callback(task, tool_call);
                if (feedback.operation === 'deny') {
                    return feedback;
                }
            } catch (err) {
                logger.error('Hooks.checkBeforeToolCall: callback error', err);
            }
        }
        if (this.parent) {
            return this.parent.checkBeforeToolCall(task, tool_call);
        }
        return { operation: 'allow' };
    }

    async noticeAfterToolCall(task: TaskState, tool_call: ToolCall): Promise<void> {
        for (const hook of sortHooks(this.afterToolCallHooks)) {
            try {
                await hook.callback(task, tool_call);
            } catch (err) {
                logger.error('Hooks.noticeAfterToolCall: callback error', err);
            }
        }
        if (this.parent) {
            await this.parent.noticeAfterToolCall(task, tool_call);
        }
    }

    async noticeBeforeTurnStart(task: TaskState): Promise<void> {
        for (const hook of sortHooks(this.beforeTurnStartHooks)) {
            try {
                await hook.callback(task);
            } catch (err) {
                logger.error('Hooks.noticeBeforeTurnStart: callback error', err);
            }
        }
        if (this.parent) {
            await this.parent.noticeBeforeTurnStart(task);
        }
    }

    async noticeAfterProcessCompletion(task: TaskState, assistantMessage: AssistantMessage): Promise<void> {
        for (const hook of sortHooks(this.afterProcessCompletionHooks)) {
            try {
                await hook.callback(task, assistantMessage);
            } catch (err) {
                logger.error('Hooks.noticeAfterProcessCompletion: callback error', err);
            }
        }
        if (this.parent) {
            await this.parent.noticeAfterProcessCompletion(task, assistantMessage);
        }
    }

    async checkBeforeToolcallCreated(
        task: TaskState,
        assistantMessage: AssistantMessage,
        chunkHasNewToolCall: boolean,
        requestToolCalls: readonly ToolCall[]
    ): Promise<BeforeToolcallCreatedFeedback> {
        // beforeToolcallCreated 在流式输出中每个 chunk 都会触发一次，不创建 span 以避免噪声
        for (const hook of sortHooks(this.beforeToolcallCreatedHooks)) {
            try {
                const feedback = await hook.callback(task, assistantMessage, chunkHasNewToolCall, requestToolCalls);
                if (feedback.operation === 'reject') {
                    return feedback;
                }
            } catch (err) {
                logger.error('Hooks.checkBeforeToolcallCreated: callback error', err);
            }
        }
        if (this.parent) {
            return this.parent.checkBeforeToolcallCreated(
                task,
                assistantMessage,
                chunkHasNewToolCall,
                requestToolCalls
            );
        }
        return { operation: 'accept' };
    }
}

/** 全局钩子实例；任务级钩子通过 GlobalHooks.createChildHooks() 创建 */
export const GlobalHooks = Hooks.createGlobal();
