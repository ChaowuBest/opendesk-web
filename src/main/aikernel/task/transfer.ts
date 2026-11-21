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
import { readFile } from 'node:fs/promises';
import type { TaskManagerState } from './manager.js';
import type { TaskState } from '../states/tasks.js';
import { deserializeTaskData } from './serializer.js';
import { Setting } from '../../utils/setting.js';
import { AgentRegistry } from '../agents/registry.js';
import {
    normalizeImportedTask,
    writeTaskBundle,
    TaskTransferError,
    type TaskImportEntry
} from '../../utils/task-bundle.js';

export async function importTaskEntries(
    entries: TaskImportEntry[],
    selectedIds: string[],
    manager: TaskManagerState,
    workspace: string
): Promise<number> {
    const selected = new Set(selectedIds);
    const pending = entries.filter((entry) => selected.has(entry.id));
    if (!selected.size || pending.length !== selected.size) throw new TaskTransferError('invalidTask');
    const ids = new Map(pending.map((entry) => [entry.id, randomUUID()]));
    async function* prepareTasks(): AsyncGenerator<TaskState> {
        for (const entry of pending) {
            const source = await entry.readJson();
            try {
                const json = normalizeImportedTask(source, ids, workspace);
                if (json.model && !Setting.getInstance().getModelInstance(json.model, 'chat')) delete json.model;
                // 只清掉真正不存在的 Agent：应用被插件禁用不等于 Agent 失效，绑定应当保留
                if (json.agentId && !AgentRegistry.hasRegisteredAgent(json.agentId)) json.agentId = null;
                yield deserializeTaskData(json, manager);
            } catch (error) {
                throw new TaskTransferError('invalidTask', error, 'prepareTasks');
            }
        }
    }
    const maxAttempts = 6;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            await manager.commitImportedTasks(prepareTasks());
            break;
        } catch (error) {
            if (!(error instanceof TaskTransferError)) throw new TaskTransferError('writeFailed', error);
            if (!error.retryable || attempt === maxAttempts - 1) throw error;
            // The failed attempt has fully rolled back. Reuse the prepared IDs and
            // yield between attempts so the UI and other task updates can continue.
            await new Promise<void>((resolve) => setTimeout(resolve, Math.min(50 * 2 ** attempt, 400)));
        }
    }
    return pending.length;
}

export async function exportTaskBundle(
    manager: TaskManagerState,
    selectedIds: string[],
    filePath: string
): Promise<number> {
    const byId = new Map(manager.tasks.map((task) => [task.task_id, task]));
    if (!Array.isArray(selectedIds) || !selectedIds.length || selectedIds.some((id) => !byId.has(id))) {
        throw new TaskTransferError('invalidTask');
    }
    const children = new Map<string, string[]>();
    for (const { task_id, parent_id } of manager.tasks) {
        if (!parent_id) continue;
        const siblings = children.get(parent_id) ?? [];
        if (!children.has(parent_id)) children.set(parent_id, siblings);
        siblings.push(task_id);
    }
    const selected = new Set(selectedIds);
    // Set iteration visits children added during traversal, once per task.
    for (const id of selected) {
        for (const child of children.get(id) ?? []) selected.add(child);
    }
    await writeTaskBundle(filePath, selected, async (id) => {
        const task = byId.get(id)!;
        if (task._corrupted) throw new TaskTransferError('invalidTask');
        if (!task._fullyLoaded && task._lazyFilePath) {
            try {
                const json = JSON.parse(await readFile(task._lazyFilePath, 'utf8'));
                if (task._corrupted || json.task_id !== id) throw new TaskTransferError('invalidTask');
                if (!task._fullyLoaded) return deserializeTaskData(json, manager).toJSON();
            } catch (error) {
                throw new TaskTransferError('invalidTask', error);
            }
        }
        return task.toJSON();
    });
    return selected.size;
}
