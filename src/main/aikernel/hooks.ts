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

import type { TaskState } from "./states/tasks";
import type { ToolCall } from "./messages.js";


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
 *   - 执行前：参数校验、审计、改写等（beforeToolCall）
 *   - 执行后：将超长结果落盘并替换为摘要、观测等（afterToolCall，可改写 tool_call.result）
 * 3. 所以我们允许在全局或任务中挂载 beforeToolCall 和 afterToolCall 两种钩子
 ******************************************************************************/

type FinishTurnFeedback =
      { operation: 'finish' }
    | { operation: 'reject', message: string }
;

type BeforeFinishTurnCallback = ((task: TaskState) => Promise<FinishTurnFeedback>);

type AfterFinishTurnCallback = ((task: TaskState) => void);

type BeforeToolCallCallback = (task: TaskState, tool_call: ToolCall) => void | Promise<void>;

type AfterToolCallCallback = (task: TaskState, tool_call: ToolCall) => void | Promise<void>;

/** 全局钩子注册表，与 TaskHooks 钩子种类一致；由 TaskHooks 内部在任务级之后调用，顺序为任务级 → 全局 */
export class HookRegistry {
    static beforeFinishTurnCallbacks: BeforeFinishTurnCallback[] = [];
    static afterFinishTurnCallbacks: AfterFinishTurnCallback[] = [];
    static beforeToolCallCallbacks: BeforeToolCallCallback[] = [];
    static afterToolCallCallbacks: AfterToolCallCallback[] = [];

    static beforeFinishTurn(callback: BeforeFinishTurnCallback): void {
        this.beforeFinishTurnCallbacks.push(callback);
    }

    static afterFinishTurn(callback: AfterFinishTurnCallback): void {
        this.afterFinishTurnCallbacks.push(callback);
    }

    static beforeToolCall(callback: BeforeToolCallCallback): void {
        this.beforeToolCallCallbacks.push(callback);
    }

    static afterToolCall(callback: AfterToolCallCallback): void {
        this.afterToolCallCallbacks.push(callback);
    }

    static async checkBeforeFinishTurn(task: TaskState): Promise<FinishTurnFeedback> {
        for (const callback of this.beforeFinishTurnCallbacks) {
            const feedback = await callback(task);
            if (feedback.operation === 'reject') {
                return feedback;
            }
        }
        return { operation: 'finish' };
    }

    static noticeAfterFinishTurn(task: TaskState): void {
        for (const callback of this.afterFinishTurnCallbacks) {
            callback(task);
        }
    }

    static async checkBeforeToolCall(task: TaskState, tool_call: ToolCall): Promise<void> {
        for (const callback of this.beforeToolCallCallbacks) {
            await callback(task, tool_call);
        }
    }

    static async noticeAfterToolCall(task: TaskState, tool_call: ToolCall): Promise<void> {
        for (const callback of this.afterToolCallCallbacks) {
            await callback(task, tool_call);
        }
    }
}

export class TaskHooks {

    beforeFinishTurnCallbacks: BeforeFinishTurnCallback[] = [];
    afterFinishTurnCallbacks: AfterFinishTurnCallback[] = [];
    beforeToolCallCallbacks: BeforeToolCallCallback[] = [];
    afterToolCallCallbacks: AfterToolCallCallback[] = [];

    constructor() { }

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

    beforeToolCall(callback: BeforeToolCallCallback) {
        this.beforeToolCallCallbacks.push(callback);
    }

    afterToolCall(callback: AfterToolCallCallback) {
        this.afterToolCallCallbacks.push(callback);
    }

    async checkBeforeFinishTurn(task: TaskState): Promise<FinishTurnFeedback> {
        for (const callback of this.beforeFinishTurnCallbacks) {
            const feedback = await callback(task);
            if (feedback.operation === 'reject') {
                return feedback;
            }
        }
        return HookRegistry.checkBeforeFinishTurn(task);
    }

    noticeAfterFinishTurn(task: TaskState): void {
        for (const callback of this.afterFinishTurnCallbacks) {
            callback(task);
        }
        HookRegistry.noticeAfterFinishTurn(task);
    }

    async checkBeforeToolCall(task: TaskState, tool_call: ToolCall): Promise<void> {
        for (const callback of this.beforeToolCallCallbacks) {
            await callback(task, tool_call);
        }
        await HookRegistry.checkBeforeToolCall(task, tool_call);
    }

    async noticeAfterToolCall(task: TaskState, tool_call: ToolCall): Promise<void> {
        for (const callback of this.afterToolCallCallbacks) {
            await callback(task, tool_call);
        }
        await HookRegistry.noticeAfterToolCall(task, tool_call);
    }
}