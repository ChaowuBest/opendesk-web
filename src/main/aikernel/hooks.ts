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

type FinishTurnFeedback =
      { operation: 'finish' }
    | { operation: 'reject', message: string }
;

type BeforeFinishTurnCallback = ((task: TaskState) => Promise<FinishTurnFeedback>);

type AfterFinishTurnCallback = ((task: TaskState) => void);

export class TaskHooks {

    beforeFinishTurnCallbacks: BeforeFinishTurnCallback[] = [];
    afterFinishTurnCallbacks: AfterFinishTurnCallback[] = [];

    constructor() { }

    /**
     * 注册一个在轮次结束前需要执行的回调函数
     * @param callback
     */
    beforeFinishTurn(callback: BeforeFinishTurnCallback) {
        this.beforeFinishTurnCallbacks.push(callback);
    }

    async checkBeforeFinishTurn(task: TaskState): Promise<FinishTurnFeedback> {
        for (const callback of this.beforeFinishTurnCallbacks) {
            let feedback = await callback(task);
            if (feedback.operation == 'reject') {
                return feedback;
            }
        }
        return { operation: 'finish' };
    }

    noticeAfterFinishTurn(task: TaskState): void {
        for (const callback of this.afterFinishTurnCallbacks) {
            callback(task);
        }
    }
}