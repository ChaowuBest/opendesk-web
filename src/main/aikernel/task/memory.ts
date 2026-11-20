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

import type { TaskState } from '../states/tasks.js';

export type TaskMemoryReleaseResult =
    { status: 'ok'; data: { released: boolean } } | { status: 'error'; message: string };

/** Release a task without loading it; rendered-memory caches remain owned by the host. */
export function releaseTaskMemory(
    taskId: unknown,
    tasks: readonly Pick<TaskState, 'task_id' | 'unload'>[],
    clearRenderedMemory: (taskId: string) => void
): TaskMemoryReleaseResult {
    if (typeof taskId !== 'string') {
        // Internal argument-validation message, retained from the existing IPC contract.
        return { status: 'error', message: 'taskId must be a string' };
    }
    // getTask() would call ensureLoaded() and load the memory that we intend to release.
    const task = tasks.find((candidate) => candidate.task_id === taskId);
    if (!task) {
        // Closing a view can race with deleting its task; releasing a missing task is idempotent.
        return { status: 'ok', data: { released: false } };
    }
    clearRenderedMemory(taskId);
    return { status: 'ok', data: { released: task.unload() } };
}
