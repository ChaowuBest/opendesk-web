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

export interface HookRegistrationOptions {
    priority?: number;
    phase?: string;
}

type BeforeFinishTurnRegistration =
    | BeforeFinishTurnCallback
    | {
          callback: BeforeFinishTurnCallback;
          priority: number;
          phase?: string;
          scope: 'task' | 'global';
          order: number;
      };

function normalizeBeforeFinishRegistration(
    item: BeforeFinishTurnRegistration,
    scope: 'task' | 'global',
    fallbackOrder: number
): {
    callback: BeforeFinishTurnCallback;
    priority: number;
    phase?: string;
    scope: 'task' | 'global';
    order: number;
} {
    if (typeof item === 'function') {
        return { callback: item, priority: 500, scope, order: fallbackOrder };
    }
    return {
        callback: item.callback,
        priority: typeof item.priority === 'number' ? item.priority : 500,
        phase: item.phase,
        scope: item.scope ?? scope,
        order: typeof item.order === 'number' ? item.order : fallbackOrder
    };
}

function sortBeforeFinishRegistrations(
    registrations: Array<{
        callback: BeforeFinishTurnCallback;
        priority: number;
        phase?: string;
        scope: 'task' | 'global';
        order: number;
    }>
) {
    return registrations.sort((left, right) => {
        if (left.priority !== right.priority) return left.priority - right.priority;
        if (left.scope !== right.scope) return left.scope === 'task' ? -1 : 1;
        return left.order - right.order;
    });
}

/** 全局钩子注册表，与 TaskHooks 钩子种类一致；由 TaskHooks 内部在任务级之后调用，顺序为任务级 → 全局 */
export class HookRegistry {
    static beforeFinishTurnCallbacks: BeforeFinishTurnRegistration[] = [];
    static afterFinishTurnCallbacks: AfterFinishTurnCallback[] = [];
    static beforeTaskStartCallbacks: BeforeTaskStartCallback[] = [];
    static onTaskReviewCallbacks: OnTaskReviewCallback[] = [];
    static onTaskRevertCallbacks: OnTaskRevertCallback[] = [];
    static afterParseToolcallCallbacks: AfterParseToolcallCallback[] = [];
    static beforeToolCallCallbacks: BeforeToolCallCallback[] = [];
    static afterToolCallCallbacks: AfterToolCallCallback[] = [];
    static beforeTurnStartCallbacks: BeforeTurnStartCallback[] = [];
    static afterProcessCompletionCallbacks: AfterProcessCompletionCallback[] = [];
    static beforeToolcallCreatedCallbacks: BeforeToolcallCreatedCallback[] = [];

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
    static beforeFinishTurn(callback: BeforeFinishTurnCallback, options: HookRegistrationOptions = {}): void {
        this.beforeFinishTurnCallbacks.push({
            callback,
            priority: options.priority ?? 500,
            phase: options.phase,
            scope: 'global',
            order: this.beforeFinishTurnCallbacks.length
        });
    }

    /**
     * 注册 `afterFinishTurn` 钩子（纯通知，无返回值）。
     *
     * 触发时机：turn 已经确定结束之后，在清理 / 状态切换之前触发。
     * 回调签名：`(task: TaskState) => void | Promise<void>`
     *
     * 典型用途：记录日志、统计、触发后续异步任务（如会话记忆提取）。
     */
    static afterFinishTurn(callback: AfterFinishTurnCallback): void {
        this.afterFinishTurnCallbacks.push(callback);
    }

    /**
     * 注册 `beforeTaskStart` 钩子（纯通知，无返回值）。
     *
     * 触发时机：任务即将首次开始执行时（system prompt 已设置，用户消息提交之前）。
     * 回调签名：`(task: TaskState) => void | Promise<void>`
     *
     * 典型用途：在任务开始前注入额外的系统消息或进行初始化配置。
     */
    static beforeTaskStart(callback: BeforeTaskStartCallback): void {
        this.beforeTaskStartCallbacks.push(callback);
    }

    /**
     * 注册 `onTaskReview` 钩子。
     *
     * 触发时机：用户手动触发"审查任务"操作时。
     * 回调签名：`(task: TaskState, start_message_index: number) => boolean | void | Promise<boolean | void>`
     * - 返回 `true` 表示该钩子已启动了审查流程（如 review agent）。
     *
     * 典型用途：为任务提供自动审查 / 代码审查能力。
     */
    static onTaskReview(callback: OnTaskReviewCallback): void {
        this.onTaskReviewCallbacks.push(callback);
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
    static onTaskRevert(callback: OnTaskRevertCallback): void {
        this.onTaskRevertCallbacks.push(callback);
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
    static afterParseToolcall(callback: AfterParseToolcallCallback): void {
        this.afterParseToolcallCallbacks.push(callback);
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
    static beforeToolCall(callback: BeforeToolCallCallback): void {
        this.beforeToolCallCallbacks.push(callback);
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
    static afterToolCall(callback: AfterToolCallCallback): void {
        this.afterToolCallCallbacks.push(callback);
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
    static beforeTurnStart(callback: BeforeTurnStartCallback): void {
        this.beforeTurnStartCallbacks.push(callback);
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
    static afterProcessCompletion(callback: AfterProcessCompletionCallback): void {
        this.afterProcessCompletionCallbacks.push(callback);
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
    static beforeToolcallCreated(callback: BeforeToolcallCreatedCallback): void {
        this.beforeToolcallCreatedCallbacks.push(callback);
    }

    static async checkBeforeFinishTurn(
        task: TaskState,
        modelRequestOptions?: LLMRequestOptions
    ): Promise<FinishTurnFeedback> {
        const callbacks = sortBeforeFinishRegistrations(
            this.beforeFinishTurnCallbacks.map((item, index) =>
                normalizeBeforeFinishRegistration(item, 'global', index)
            )
        );
        for (const entry of callbacks) {
            try {
                const feedback = await entry.callback(task, modelRequestOptions);
                if (feedback.operation === 'reject') {
                    return feedback;
                }
            } catch (err) {
                logger.error('HookRegistry.checkBeforeFinishTurn: callback error', err);
            }
        }
        return { operation: 'finish' };
    }

    static async noticeAfterFinishTurn(task: TaskState): Promise<void> {
        for (const callback of this.afterFinishTurnCallbacks) {
            try {
                await callback(task);
            } catch (err) {
                logger.error('HookRegistry.noticeAfterFinishTurn: callback error', err);
            }
        }
    }

    static async noticeBeforeTaskStart(task: TaskState): Promise<void> {
        for (const callback of this.beforeTaskStartCallbacks) {
            try {
                await callback(task);
            } catch (err) {
                logger.error('HookRegistry.noticeBeforeTaskStart: callback error', err);
            }
        }
    }

    static async noticeTaskReview(task: TaskState, start_message_index: number): Promise<boolean> {
        let started = false;
        for (const callback of this.onTaskReviewCallbacks) {
            try {
                started = (await callback(task, start_message_index)) === true || started;
            } catch (err) {
                logger.error('HookRegistry.noticeTaskReview: callback error', err);
            }
        }
        return started;
    }

    static async noticeTaskRevert(task: TaskState): Promise<void> {
        for (const callback of this.onTaskRevertCallbacks) {
            try {
                await callback(task);
            } catch (err) {
                logger.error('HookRegistry.noticeTaskRevert: callback error', err);
            }
        }
    }

    static async checkAfterParseToolcall(task: TaskState, tool_call: ToolCall): Promise<ParseToolcallFeedback> {
        for (const callback of this.afterParseToolcallCallbacks) {
            try {
                const feedback = await callback(task, tool_call);
                if (feedback.operation === 'reject') {
                    return feedback;
                }
            } catch (err) {
                logger.error('HookRegistry.checkAfterParseToolcall: callback error', err);
            }
        }
        return { operation: 'finish' };
    }

    static async checkBeforeToolCall(task: TaskState, tool_call: ToolCall): Promise<BeforeToolCallFeedback> {
        for (const callback of this.beforeToolCallCallbacks) {
            try {
                const feedback = await callback(task, tool_call);
                if (feedback.operation === 'deny') {
                    return feedback;
                }
            } catch (err) {
                logger.error('HookRegistry.checkBeforeToolCall: callback error', err);
            }
        }
        return { operation: 'allow' };
    }

    static async noticeAfterToolCall(task: TaskState, tool_call: ToolCall): Promise<void> {
        for (const callback of this.afterToolCallCallbacks) {
            try {
                await callback(task, tool_call);
            } catch (err) {
                logger.error('HookRegistry.noticeAfterToolCall: callback error', err);
            }
        }
    }

    static async noticeBeforeTurnStart(task: TaskState): Promise<void> {
        for (const callback of this.beforeTurnStartCallbacks) {
            try {
                await callback(task);
            } catch (err) {
                logger.error('HookRegistry.noticeBeforeTurnStart: callback error', err);
            }
        }
    }

    static async noticeAfterProcessCompletion(task: TaskState, assistantMessage: AssistantMessage): Promise<void> {
        for (const callback of this.afterProcessCompletionCallbacks) {
            try {
                await callback(task, assistantMessage);
            } catch (err) {
                logger.error('HookRegistry.noticeAfterProcessCompletion: callback error', err);
            }
        }
    }

    static async checkBeforeToolcallCreated(
        task: TaskState,
        assistantMessage: AssistantMessage,
        chunkHasNewToolCall: boolean,
        requestToolCalls: readonly ToolCall[]
    ): Promise<BeforeToolcallCreatedFeedback> {
        for (const callback of this.beforeToolcallCreatedCallbacks) {
            try {
                const feedback = await callback(task, assistantMessage, chunkHasNewToolCall, requestToolCalls);
                if (feedback.operation === 'reject') {
                    return feedback;
                }
            } catch (err) {
                logger.error('HookRegistry.checkBeforeToolcallCreated: callback error', err);
            }
        }
        return { operation: 'accept' };
    }
}

export class TaskHooks {
    beforeFinishTurnCallbacks: BeforeFinishTurnRegistration[] = [];
    afterFinishTurnCallbacks: AfterFinishTurnCallback[] = [];
    beforeTaskStartCallbacks: BeforeTaskStartCallback[] = [];
    onTaskReviewCallbacks: OnTaskReviewCallback[] = [];
    onTaskRevertCallbacks: OnTaskRevertCallback[] = [];
    afterParseToolcallCallbacks: AfterParseToolcallCallback[] = [];
    beforeToolCallCallbacks: BeforeToolCallCallback[] = [];
    afterToolCallCallbacks: AfterToolCallCallback[] = [];
    beforeTurnStartCallbacks: BeforeTurnStartCallback[] = [];
    afterProcessCompletionCallbacks: AfterProcessCompletionCallback[] = [];
    beforeToolcallCreatedCallbacks: BeforeToolcallCreatedCallback[] = [];

    constructor() {}

    /** @see HookRegistry.beforeFinishTurn */
    beforeFinishTurn(callback: BeforeFinishTurnCallback, options: HookRegistrationOptions = {}) {
        this.beforeFinishTurnCallbacks.push({
            callback,
            priority: options.priority ?? 500,
            phase: options.phase,
            scope: 'task',
            order: this.beforeFinishTurnCallbacks.length
        });
    }

    /** @see HookRegistry.afterFinishTurn */
    afterFinishTurn(callback: AfterFinishTurnCallback) {
        this.afterFinishTurnCallbacks.push(callback);
    }

    /** @see HookRegistry.beforeTaskStart */
    beforeTaskStart(callback: BeforeTaskStartCallback) {
        this.beforeTaskStartCallbacks.push(callback);
    }

    /** @see HookRegistry.onTaskReview */
    onTaskReview(callback: OnTaskReviewCallback) {
        this.onTaskReviewCallbacks.push(callback);
    }

    /** @see HookRegistry.onTaskRevert */
    onTaskRevert(callback: OnTaskRevertCallback) {
        this.onTaskRevertCallbacks.push(callback);
    }

    /** @see HookRegistry.afterParseToolcall */
    afterParseToolcall(callback: AfterParseToolcallCallback) {
        this.afterParseToolcallCallbacks.push(callback);
    }

    /** @see HookRegistry.beforeToolCall */
    beforeToolCall(callback: BeforeToolCallCallback) {
        this.beforeToolCallCallbacks.push(callback);
    }

    /** @see HookRegistry.afterToolCall */
    afterToolCall(callback: AfterToolCallCallback) {
        this.afterToolCallCallbacks.push(callback);
    }

    /** @see HookRegistry.beforeTurnStart */
    beforeTurnStart(callback: BeforeTurnStartCallback) {
        this.beforeTurnStartCallbacks.push(callback);
    }

    /** @see HookRegistry.afterProcessCompletion */
    afterProcessCompletion(callback: AfterProcessCompletionCallback) {
        this.afterProcessCompletionCallbacks.push(callback);
    }

    /** @see HookRegistry.beforeToolcallCreated */
    beforeToolcallCreated(callback: BeforeToolcallCreatedCallback) {
        this.beforeToolcallCreatedCallbacks.push(callback);
    }

    async checkBeforeFinishTurn(task: TaskState, modelRequestOptions?: LLMRequestOptions): Promise<FinishTurnFeedback> {
        const taskCallbacks = this.beforeFinishTurnCallbacks.map((item, index) =>
            normalizeBeforeFinishRegistration(item, 'task', index)
        );
        const globalOffset = taskCallbacks.length;
        const globalCallbacks = HookRegistry.beforeFinishTurnCallbacks.map((item, index) =>
            normalizeBeforeFinishRegistration(item, 'global', globalOffset + index)
        );
        const callbacks = sortBeforeFinishRegistrations([...taskCallbacks, ...globalCallbacks]);
        for (const entry of callbacks) {
            try {
                const feedback = await entry.callback(task, modelRequestOptions);
                if (feedback.operation === 'reject') {
                    return feedback;
                }
            } catch (err) {
                logger.error('TaskHooks.checkBeforeFinishTurn: callback error', err);
            }
        }
        return { operation: 'finish' };
    }

    async noticeAfterFinishTurn(task: TaskState): Promise<void> {
        for (const callback of this.afterFinishTurnCallbacks) {
            try {
                await callback(task);
            } catch (err) {
                logger.error('TaskHooks.noticeAfterFinishTurn: callback error', err);
            }
        }
        await HookRegistry.noticeAfterFinishTurn(task);
    }

    async noticeBeforeTaskStart(task: TaskState): Promise<void> {
        for (const callback of this.beforeTaskStartCallbacks) {
            try {
                await callback(task);
            } catch (err) {
                logger.error('TaskHooks.noticeBeforeTaskStart: callback error', err);
            }
        }
        await HookRegistry.noticeBeforeTaskStart(task);
    }

    async noticeTaskReview(task: TaskState, start_message_index: number): Promise<boolean> {
        let started = false;
        for (const callback of this.onTaskReviewCallbacks) {
            try {
                started = (await callback(task, start_message_index)) === true || started;
            } catch (err) {
                logger.error('TaskHooks.noticeTaskReview: callback error', err);
            }
        }
        return (await HookRegistry.noticeTaskReview(task, start_message_index)) || started;
    }

    async noticeTaskRevert(task: TaskState): Promise<void> {
        for (const callback of this.onTaskRevertCallbacks) {
            try {
                await callback(task);
            } catch (err) {
                logger.error('TaskHooks.noticeTaskRevert: callback error', err);
            }
        }
        await HookRegistry.noticeTaskRevert(task);
    }

    async checkAfterParseToolcall(task: TaskState, tool_call: ToolCall): Promise<ParseToolcallFeedback> {
        // afterParseToolcall 在流式解析期间每个 tool call 参数完成时触发，
        // 不创建 span 以避免噪声
        for (const callback of this.afterParseToolcallCallbacks) {
            try {
                const feedback = await callback(task, tool_call);
                if (feedback.operation === 'reject') {
                    return feedback;
                }
            } catch (err) {
                logger.error('TaskHooks.checkAfterParseToolcall: callback error', err);
            }
        }
        return HookRegistry.checkAfterParseToolcall(task, tool_call);
    }

    async checkBeforeToolCall(task: TaskState, tool_call: ToolCall): Promise<BeforeToolCallFeedback> {
        for (const callback of this.beforeToolCallCallbacks) {
            try {
                const feedback = await callback(task, tool_call);
                if (feedback.operation === 'deny') {
                    return feedback;
                }
            } catch (err) {
                logger.error('TaskHooks.checkBeforeToolCall: callback error', err);
            }
        }
        return HookRegistry.checkBeforeToolCall(task, tool_call);
    }

    async noticeAfterToolCall(task: TaskState, tool_call: ToolCall): Promise<void> {
        for (const callback of this.afterToolCallCallbacks) {
            try {
                await callback(task, tool_call);
            } catch (err) {
                logger.error('TaskHooks.noticeAfterToolCall: callback error', err);
            }
        }
        await HookRegistry.noticeAfterToolCall(task, tool_call);
    }

    async noticeBeforeTurnStart(task: TaskState): Promise<void> {
        for (const callback of this.beforeTurnStartCallbacks) {
            try {
                await callback(task);
            } catch (err) {
                logger.error('TaskHooks.noticeBeforeTurnStart: callback error', err);
            }
        }
        await HookRegistry.noticeBeforeTurnStart(task);
    }

    async noticeAfterProcessCompletion(task: TaskState, assistantMessage: AssistantMessage): Promise<void> {
        for (const callback of this.afterProcessCompletionCallbacks) {
            try {
                await callback(task, assistantMessage);
            } catch (err) {
                logger.error('TaskHooks.noticeAfterProcessCompletion: callback error', err);
            }
        }
        await HookRegistry.noticeAfterProcessCompletion(task, assistantMessage);
    }

    async checkBeforeToolcallCreated(
        task: TaskState,
        assistantMessage: AssistantMessage,
        chunkHasNewToolCall: boolean,
        requestToolCalls: readonly ToolCall[]
    ): Promise<BeforeToolcallCreatedFeedback> {
        // beforeToolcallCreated 在流式输出中每个 chunk 都会触发一次，不创建 span 以避免噪声
        for (const callback of this.beforeToolcallCreatedCallbacks) {
            try {
                const feedback = await callback(task, assistantMessage, chunkHasNewToolCall, requestToolCalls);
                if (feedback.operation === 'reject') {
                    return feedback;
                }
            } catch (err) {
                logger.error('TaskHooks.checkBeforeToolcallCreated: callback error', err);
            }
        }
        return HookRegistry.checkBeforeToolcallCreated(task, assistantMessage, chunkHasNewToolCall, requestToolCalls);
    }
}
