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
import { deserializeTaskData } from './serializer.js';
import { Setting } from '../../utils/setting.js';
import { AgentRegistry } from '../agents/registry.js';
import { logger } from '../../utils/logger.js';
import {
    normalizeImportedTask,
    readTaskImportFile,
    taskFingerprint,
    writeTaskBundle,
    TaskTransferError,
    TASK_BUNDLE_LIMITS,
    type TaskImportEntry,
    type TaskJson
} from '../../utils/task-bundle.js';

export type TransferProgress = (done: number, total: number) => void;
export type PreparedTaskEntry = TaskImportEntry & { duplicate: boolean };
export interface TaskImportResult {
    imported: { sourceId: string; taskId: string; name: string }[];
    failed: { sourceId: string; name: string; error: string }[];
    skipped: number;
}

export async function prepareTaskImport(filePath: string, manager: TaskManagerState): Promise<PreparedTaskEntry[]> {
    const entries = await readTaskImportFile(filePath);
    return entries.map((entry) => {
        const previous = manager.tasks.some((task) => {
            if (task.import_metadata?.source_id !== entry.id || task.import_metadata?.fingerprint !== entry.fingerprint)
                return false;
            task.ensureLoaded();
            return !task._corrupted;
        });
        const original = !entry.error && manager.tasks.find((task) => task.task_id === entry.id);
        let sameOriginal = false;
        if (original) {
            original.ensureLoaded();
            sameOriginal = !original._corrupted && taskFingerprint(original.toJSON()) === entry.fingerprint;
        }
        return { ...entry, duplicate: previous || sameOriginal };
    });
}

export async function importTaskEntries(
    entries: PreparedTaskEntry[],
    selectedIds: string[],
    manager: TaskManagerState,
    workspace: string,
    progress: TransferProgress = () => {}
): Promise<TaskImportResult> {
    const selected = new Set(selectedIds);
    if (
        !selected.size ||
        selectedIds.some((id) => typeof id !== 'string' || !entries.some((entry) => entry.id === id))
    ) {
        throw new TaskTransferError('invalidTask');
    }
    const pending = entries.filter((entry) => selected.has(entry.id));
    const ids = new Map(pending.map((entry) => [entry.id, randomUUID()]));
    const result: TaskImportResult = { imported: [], failed: [], skipped: entries.length - pending.length };
    // Connected selected parent/child tasks commit together, so a failed child
    // cannot leave a partially imported family or references to another local task.
    while (pending.length) {
        const group = [pending.shift()!];
        for (let changed = true; changed;) {
            changed = false;
            for (let i = pending.length - 1; i >= 0; i--) {
                if (group.some((entry) => entry.parentId === pending[i].id || pending[i].parentId === entry.id)) {
                    group.push(...pending.splice(i, 1));
                    changed = true;
                }
            }
        }
        let phase: 'invalidTask' | 'writeFailed' = 'invalidTask';
        try {
            const tasks = group.map((entry) => {
                if (!entry.json || entry.error) throw new TaskTransferError('invalidTask');
                const json = normalizeImportedTask(entry.json, ids, workspace);
                if (json.model && !Setting.getInstance().getModelInstance(json.model, 'chat')) delete json.model;
                if (json.agentId && !AgentRegistry.resolveAgentReference(json.agentId)) json.agentId = null;
                const task = deserializeTaskData(json, manager);
                task._dirty = true;
                return task;
            });
            phase = 'writeFailed';
            await manager.commitImportedTasks(tasks);
            result.imported.push(
                ...group.map((entry) => ({ sourceId: entry.id, taskId: ids.get(entry.id)!, name: entry.name }))
            );
        } catch (error) {
            logger.warn('Task import group failed', error);
            result.failed.push(...group.map((entry) => ({ sourceId: entry.id, name: entry.name, error: phase })));
        }
        progress(result.imported.length + result.failed.length, selected.size);
        await setImmediate();
    }
    return result;
}

export async function exportTaskBundle(
    manager: TaskManagerState,
    selectedIds: string[],
    filePath: string,
    progress: TransferProgress = () => {}
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
    const snapshots: TaskJson[] = [];
    if (selected.size > TASK_BUNDLE_LIMITS.tasks) throw new TaskTransferError('tooLarge');
    let totalBytes = 0;
    for (const id of selected) {
        const task = manager.tasks.find((item) => item.task_id === id);
        if (!task) throw new TaskTransferError('invalidTask');
        task.ensureLoaded();
        if (task._corrupted) throw new TaskTransferError('invalidTask');
        // Freeze immediately: running tasks may change while later tasks load.
        const serialized = JSON.stringify(task.toJSON(), null, 4);
        const byteLength = Buffer.byteLength(serialized);
        totalBytes += byteLength;
        if (byteLength > TASK_BUNDLE_LIMITS.taskBytes || totalBytes > TASK_BUNDLE_LIMITS.totalBytes)
            throw new TaskTransferError('tooLarge');
        snapshots.push(JSON.parse(serialized));
        progress(snapshots.length, selected.size);
        await setImmediate();
    }
    await writeTaskBundle(filePath, snapshots);
    return selected.size;
}
