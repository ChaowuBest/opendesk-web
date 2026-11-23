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

/**
 * 会话附属信息（待办列表、文件变更）到 opencode Todo / SnapshotFileDiff 的转换。
 */

import * as diff from 'diff';
import type { SnapshotFileDiff, Todo } from '@opencode-ai/sdk/v2/types';
import type { ReadonlyTaskTodos } from '../../aikernel/todos/task-todos.js';
import { getTaskChangesFromTask, type FileChanges } from '../../aikernel/task/changes.js';
import type { TaskState } from '../../aikernel/states/tasks.js';

/** OpenDesk 的待办没有优先级；opencode 要求该字段，统一为 medium */
const DEFAULT_TODO_PRIORITY = 'medium';

export function toOpenCodeTodos(todos: ReadonlyTaskTodos): Todo[] {
    return todos.map(
        (todo) =>
            ({
                content: todo.title || todo.content,
                status: todo.status,
                priority: DEFAULT_TODO_PRIORITY
            }) satisfies Todo
    );
}

type TaskMessage = TaskState['chat_context']['messages'][number];

/** 整个会话或某一轮（messages）的文件变更 */
export function getOpenCodeSessionDiff(task: TaskState, messages?: readonly TaskMessage[]): SnapshotFileDiff[] {
    return getTaskChangesFromTask(task, messages).files.map(toOpenCodeFileDiff);
}

function toOpenCodeFileDiff(file: FileChanges): SnapshotFileDiff {
    const hunks = file.changes.flatMap((change) => change.hunks);
    const patch = diff.formatPatch({
        oldFileName: file.filePath,
        newFileName: file.filePath,
        oldHeader: '',
        newHeader: '',
        hunks: hunks.map((hunk) => ({
            oldStart: hunk.oldStart,
            oldLines: hunk.oldLines,
            newStart: hunk.newStart,
            newLines: hunk.newLines,
            lines: hunk.lines.map(
                (line) => (line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ') + line.content
            )
        }))
    });
    // 变更前内容为空（如 writeFile 新建文件）时所有块都从空文件开始
    const added = file.totalRemoved === 0 && hunks.length > 0 && hunks.every((hunk) => hunk.oldLines === 0);
    return {
        file: file.filePath,
        patch,
        additions: file.totalAdded,
        deletions: file.totalRemoved,
        status: added ? 'added' : 'modified'
    } satisfies SnapshotFileDiff;
}

/**
 * 找到 messageID 对应的可见用户消息，返回该轮的消息（到下一条可见用户消息为止）。
 * internal 用户消息（提醒、内部 prompt）不在协议中出现，也不作为轮次边界。
 */
export function getTurnMessages(
    messages: readonly TaskMessage[],
    isTargetUserMessage: (message: TaskMessage, index: number) => boolean
): TaskMessage[] | undefined {
    const isVisibleUser = (message: TaskMessage) =>
        message.role === 'user' && (message as { internal?: boolean }).internal !== true;
    const start = messages.findIndex((message, index) => isVisibleUser(message) && isTargetUserMessage(message, index));
    if (start === -1) return undefined;
    const next = messages.findIndex((message, index) => index > start && isVisibleUser(message));
    return messages.slice(start + 1, next === -1 ? messages.length : next);
}
