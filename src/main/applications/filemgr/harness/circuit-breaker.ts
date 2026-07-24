/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 *
 * 文件管理应用的电路断路器 —— 通过全局钩子注册，检测文件操作相关的循环行为。
 * 在 filemgr 应用启动时导入本模块即可自动注册。
 */

import { HookRegistry } from '../../../aikernel/hooks.js';
import type { TaskState } from '../../../aikernel/states/tasks.js';
import type { ToolCall } from '../../../aikernel/messages.js';
import { logger } from '../../../utils/logger.js';

// ==================== 电路断路器（per-task） ====================

class TurnCircuitBreaker {
    private _editHistory = new Map<string, number>();
    private readonly _editThreshold = 2;

    private _unchangedCount: number = 0;
    private readonly _unchangedThreshold = 3;

    reset(): void {
        this._editHistory.clear();
        this._unchangedCount = 0;
    }

    checkEditFile(filePath: string, oldString: string): string | undefined {
        const key = `${filePath}::${oldString}`;
        const count = (this._editHistory.get(key) ?? 0) + 1;
        this._editHistory.set(key, count);

        if (count >= this._editThreshold) {
            return (
                `[系统] 检测到你对 \`${filePath}\` 已连续 ${count} 次执行相同编辑，` +
                '可能已陷入循环。请检查该修改是否已经完成，不要重复执行。'
            );
        }

        return undefined;
    }

    noteReadFileUnchanged(filePath: string): string | undefined {
        this._unchangedCount++;
        if (this._unchangedCount >= this._unchangedThreshold) {
            this._unchangedCount = 0;
            return (
                `[系统] \`${filePath}\` 已连续 ${this._unchangedThreshold} 次未变化，` +
                '请复用之前的读取结果继续推进，不要再重复读取。'
            );
        }
        return undefined;
    }

    noteReadFileChanged(): void {
        this._unchangedCount = 0;
    }

    /** 读取文件后清除该文件的编辑历史，避免 edit → read → edit 被误判为循环 */
    clearEditsForFile(filePath: string): void {
        const prefix = `${filePath}::`;
        for (const key of this._editHistory.keys()) {
            if (key.startsWith(prefix)) {
                this._editHistory.delete(key);
            }
        }
    }
}

// ==================== per-task 状态 + 全局钩子 ====================

const taskBreakers = new WeakMap<TaskState, TurnCircuitBreaker>();

function getBreaker(task: TaskState): TurnCircuitBreaker {
    let breaker = taskBreakers.get(task);
    if (!breaker) {
        breaker = new TurnCircuitBreaker();
        taskBreakers.set(task, breaker);
    }
    return breaker;
}

// --- beforeTurnStart：重置该任务的熔断器 ---

HookRegistry.beforeTurnStart((task: TaskState) => {
    getBreaker(task).reset();
});

// --- beforeToolCall：检测 editFile 重复 ---

HookRegistry.beforeToolCall((task: TaskState, tool_call: ToolCall) => {
    if (tool_call.tool_name !== 'filemgr-editFile') return { operation: 'allow' as const };

    const args = tool_call.args_object as { filePath?: string; oldString?: string } | undefined;
    if (!args?.filePath || !args?.oldString) return { operation: 'allow' as const };

    const msg = getBreaker(task).checkEditFile(args.filePath, args.oldString);
    if (msg) {
        logger.warn(`[circuit-breaker] editFile loop detected for task ${task.task_id}: ${args.filePath}`);
        return { operation: 'deny' as const, message: msg };
    }

    return { operation: 'allow' as const };
});

// --- afterToolCall：检测 readFile file_unchanged 连续 ---

HookRegistry.afterToolCall((task: TaskState, tool_call: ToolCall) => {
    if (tool_call.tool_name !== 'filemgr-readFile' || !tool_call.result) return;

    // 读取文件后清除该文件的编辑历史，避免 edit -> read -> edit 被误判为循环
    const args = tool_call.args_object as { file_path?: string } | undefined;
    if (args?.file_path) {
        getBreaker(task).clearEditsForFile(args.file_path);
    }

    try {
        const parsed = JSON.parse(tool_call.result);
        if (parsed.type !== 'file_unchanged') {
            getBreaker(task).noteReadFileChanged();
            return;
        }
        const msg = getBreaker(task).noteReadFileUnchanged(parsed.file?.filePath ?? '');
        if (msg) {
            logger.warn(`[circuit-breaker] readFile unchanged loop detected for task ${task.task_id}`);
            task.appendInternalUserMessage(msg);
        }
    } catch {
        getBreaker(task).noteReadFileChanged();
    }
});
