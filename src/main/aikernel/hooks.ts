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

import type { TaskState } from './states/tasks';
import type { ToolCall } from './messages.js';
import { logger } from '../utils/logger';

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

type FinishTurnFeedback = { operation: 'finish' } | { operation: 'reject'; message: string };

type ParseToolcallFeedback = { operation: 'finish' } | { operation: 'reject'; message: string };

export type BeforeToolCallFeedback =
    | { operation: 'allow'; extra?: Record<string, unknown> }
    | { operation: 'deny'; message: string; extra?: Record<string, unknown> };

type BeforeFinishTurnCallback = (task: TaskState) => Promise<FinishTurnFeedback>;

type AfterFinishTurnCallback = (task: TaskState) => void | Promise<void>;

type BeforeTaskStartCallback = (task: TaskState) => void | Promise<void>;

type OnTaskReviewCallback = (task: TaskState, start_message_index: number) => boolean | void | Promise<boolean | void>;

type AfterParseToolcallCallback = (task: TaskState, tool_call: ToolCall) => Promise<ParseToolcallFeedback>;

type BeforeToolCallCallback = (
    task: TaskState,
    tool_call: ToolCall
) => BeforeToolCallFeedback | Promise<BeforeToolCallFeedback>;

type AfterToolCallCallback = (task: TaskState, tool_call: ToolCall) => void | Promise<void>;

/** 全局钩子注册表，与 TaskHooks 钩子种类一致；由 TaskHooks 内部在任务级之后调用，顺序为任务级 → 全局 */
export class HookRegistry {
    static beforeFinishTurnCallbacks: BeforeFinishTurnCallback[] = [];
    static afterFinishTurnCallbacks: AfterFinishTurnCallback[] = [];
    static beforeTaskStartCallbacks: BeforeTaskStartCallback[] = [];
    static onTaskReviewCallbacks: OnTaskReviewCallback[] = [];
    static afterParseToolcallCallbacks: AfterParseToolcallCallback[] = [];
    static beforeToolCallCallbacks: BeforeToolCallCallback[] = [];
    static afterToolCallCallbacks: AfterToolCallCallback[] = [];

    static beforeFinishTurn(callback: BeforeFinishTurnCallback): void {
        this.beforeFinishTurnCallbacks.push(callback);
    }

    static afterFinishTurn(callback: AfterFinishTurnCallback): void {
        this.afterFinishTurnCallbacks.push(callback);
    }

    static beforeTaskStart(callback: BeforeTaskStartCallback): void {
        this.beforeTaskStartCallbacks.push(callback);
    }

    static onTaskReview(callback: OnTaskReviewCallback): void {
        this.onTaskReviewCallbacks.push(callback);
    }

    static afterParseToolcall(callback: AfterParseToolcallCallback): void {
        this.afterParseToolcallCallbacks.push(callback);
    }

    static beforeToolCall(callback: BeforeToolCallCallback): void {
        this.beforeToolCallCallbacks.push(callback);
    }

    static afterToolCall(callback: AfterToolCallCallback): void {
        this.afterToolCallCallbacks.push(callback);
    }

    static async checkBeforeFinishTurn(task: TaskState): Promise<FinishTurnFeedback> {
        for (const callback of this.beforeFinishTurnCallbacks) {
            try {
                const feedback = await callback(task);
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
}

export class TaskHooks {
    beforeFinishTurnCallbacks: BeforeFinishTurnCallback[] = [];
    afterFinishTurnCallbacks: AfterFinishTurnCallback[] = [];
    beforeTaskStartCallbacks: BeforeTaskStartCallback[] = [];
    onTaskReviewCallbacks: OnTaskReviewCallback[] = [];
    afterParseToolcallCallbacks: AfterParseToolcallCallback[] = [];
    beforeToolCallCallbacks: BeforeToolCallCallback[] = [];
    afterToolCallCallbacks: AfterToolCallCallback[] = [];

    constructor() {}

    /**
     * 注册一个在轮次结束前需要执行的回调函数
     * @param callback
     */
    beforeFinishTurn(callback: BeforeFinishTurnCallback) {
        this.beforeFinishTurnCallbacks.push(callback);
    }

    afterFinishTurn(callback: AfterFinishTurnCallback) {
        this.afterFinishTurnCallbacks.push(callback);
    }

    beforeTaskStart(callback: BeforeTaskStartCallback) {
        this.beforeTaskStartCallbacks.push(callback);
    }

    onTaskReview(callback: OnTaskReviewCallback) {
        this.onTaskReviewCallbacks.push(callback);
    }

    afterParseToolcall(callback: AfterParseToolcallCallback) {
        this.afterParseToolcallCallbacks.push(callback);
    }

    beforeToolCall(callback: BeforeToolCallCallback) {
        this.beforeToolCallCallbacks.push(callback);
    }

    afterToolCall(callback: AfterToolCallCallback) {
        this.afterToolCallCallbacks.push(callback);
    }

    async checkBeforeFinishTurn(task: TaskState): Promise<FinishTurnFeedback> {
        for (const callback of this.beforeFinishTurnCallbacks) {
            try {
                const feedback = await callback(task);
                if (feedback.operation === 'reject') {
                    return feedback;
                }
            } catch (err) {
                logger.error('TaskHooks.checkBeforeFinishTurn: callback error', err);
            }
        }
        return HookRegistry.checkBeforeFinishTurn(task);
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

    async checkAfterParseToolcall(task: TaskState, tool_call: ToolCall): Promise<ParseToolcallFeedback> {
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
}
