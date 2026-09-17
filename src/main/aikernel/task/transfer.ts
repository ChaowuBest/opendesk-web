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

import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import type { TaskManagerState } from './manager.js';
import type { TaskState } from '../states/tasks.js';
import { deserializeTaskData } from './serializer.js';
import { Setting } from '../../utils/setting.js';
import { AgentRegistry } from '../agents/registry.js';
import {
    normalizeImportedTask,
    writeTaskBundle,
    TaskTransferError,
    TASK_BUNDLE_LIMITS,
    type TaskImportEntry,
    type TaskJson
} from '../../utils/task-bundle.js';

export async function importTaskEntries(
    entries: TaskImportEntry[],
    selectedIds: string[],
    manager: TaskManagerState,
    workspace: string
): Promise<number> {
    const selected = new Set(selectedIds);
    if (!selected.size || selectedIds.some((id) => !entries.some((entry) => entry.id === id)))
        throw new TaskTransferError('invalidTask');
    const pending = entries.filter((entry) => selected.has(entry.id));
    const ids = new Map(pending.map((entry) => [entry.id, randomUUID()]));
    const tasks: TaskState[] = [];
    try {
        for (const entry of pending) {
            const json = normalizeImportedTask(entry.json, ids, workspace);
            if (json.model && !Setting.getInstance().getModelInstance(json.model, 'chat')) delete json.model;
            if (json.agentId && !AgentRegistry.resolveAgentReference(json.agentId)) json.agentId = null;
            tasks.push(deserializeTaskData(json, manager));
            await setImmediate();
        }
    } catch {
        throw new TaskTransferError('invalidTask');
    }
    try {
        await manager.commitImportedTasks(tasks);
    } catch {
        throw new TaskTransferError('writeFailed');
    }
    return tasks.length;
}

export async function exportTaskBundle(
    manager: TaskManagerState,
    selectedIds: string[],
    filePath: string
): Promise<number> {
    if (
        !Array.isArray(selectedIds) ||
        !selectedIds.length ||
        selectedIds.some((id) => !manager.tasks.some((task) => task.task_id === id))
    ) {
        throw new TaskTransferError('invalidTask');
    }
    const selected = new Set(selectedIds);
    for (let changed = true; changed;) {
        changed = false;
        for (const task of manager.tasks) {
            if (task.parent_id && selected.has(task.parent_id) && !selected.has(task.task_id)) {
                selected.add(task.task_id);
                changed = true;
            }
        }
    }
    if (selected.size > TASK_BUNDLE_LIMITS.tasks) throw new TaskTransferError('tooLarge');
    function* snapshots(): Generator<TaskJson> {
        for (const id of selected) {
            const task = manager.tasks.find((item) => item.task_id === id);
            if (!task) throw new TaskTransferError('invalidTask');
            task.ensureLoaded();
            if (task._corrupted) throw new TaskTransferError('invalidTask');
            yield task.toJSON();
        }
    }
    await writeTaskBundle(filePath, snapshots());
    return selected.size;
}
