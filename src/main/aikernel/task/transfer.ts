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
import fs from 'node:fs';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { TaskManagerState } from './manager.js';
import type { TaskState } from '../states/tasks.js';
import { deserializeTaskData } from './serializer.js';
import { Setting, getTaskArtifactDirectory } from '../../utils/setting.js';
import { AgentRegistry } from '../agents/registry.js';
import { logger } from '../../utils/logger.js';
import {
    normalizeImportedTask,
    writeTaskBundle,
    TaskTransferError,
    type TaskBundleArtifactFile,
    type TaskBundleArtifactsRestoreResult,
    type TaskImportEntry
} from '../../utils/task-bundle.js';

/**
 * 枚举任务产物目录 `artifacts/<taskId>/`（外置原图、工具结果原文、session memory 等）
 * 的全部文件，转成 bundle 条目。目录不存在（无产物）返回空数组；条目名一律正斜杠。
 *
 * 只有 ENOENT（确实没有产物）按空处理：其他错误（EACCES/EMFILE 等）必须上抛——
 * 静默当成"无产物"会产出一个 v1 包，而任务 JSON 里已压缩条目的原始 result 已被
 * 序列化剥离，导入端既无 artifacts 也无 result，原文永久丢失。
 */
async function collectTaskArtifactFiles(taskId: string): Promise<TaskBundleArtifactFile[]> {
    const taskArtifactDirectory = getTaskArtifactDirectory(taskId, false);
    let dirents;
    try {
        dirents = await fs.promises.readdir(taskArtifactDirectory, { withFileTypes: true, recursive: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
            return [];
        }
        throw new TaskTransferError('invalidTask', error);
    }
    const files: TaskBundleArtifactFile[] = [];
    for (const dirent of dirents) {
        if (!dirent.isFile()) continue;
        const diskPath = path.join(dirent.parentPath, dirent.name);
        const relative = path.relative(taskArtifactDirectory, diskPath);
        files.push({
            entryName: ['artifacts', taskId, ...relative.split(path.sep)].join('/'),
            diskPath
        });
    }
    return files;
}

export async function importTaskEntries(
    entries: TaskImportEntry[],
    selectedIds: string[],
    manager: TaskManagerState,
    workspace: string,
    options: {
        restoreArtifacts?: (ids: ReadonlyMap<string, string>) => Promise<TaskBundleArtifactsRestoreResult>;
    } = {}
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
                if (json.agentId && !AgentRegistry.resolveAgentReference(json.agentId)) json.agentId = null;
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
    if (options.restoreArtifacts) {
        // 任务提交成功后还原随包 artifacts（best-effort）：单文件失败只影响该文件的
        // 原文/原图可恢复性，下游有缩略图/替代文本降级路径，不使导入回滚。
        // 这里必须整段吞错：任务已 commit，若此处的意外异常冒泡成导入失败，
        // UI 会用同一快照重试导入（task-transfer-service 专门保留了 snapshot），
        // 从而产生重复任务。
        try {
            const summary = await options.restoreArtifacts(ids);
            if (summary.failed > 0) {
                logger.warn(`task import: ${summary.failed} artifact file(s) failed to restore`);
            }
        } catch (error) {
            logger.warn(`task import: artifact restore failed after commit: ${error}`);
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
    // 随包携带任务产物（issue #341 阶段三）：外置原图 + 已压缩工具结果原文等随 zip 走，
    // 导入端还原到新任务命名空间；无产物时 bundle 维持 v1 兼容。
    const artifactFiles: TaskBundleArtifactFile[] = [];
    for (const id of selected) {
        artifactFiles.push(...(await collectTaskArtifactFiles(id)));
    }
    await writeTaskBundle(
        filePath,
        selected,
        async (id) => {
            const task = byId.get(id)!;
            if (task._corrupted) throw new TaskTransferError('invalidTask');
            if (!task._fullyLoaded && task._lazyFilePath) {
                try {
                    const fileJson = JSON.parse(await readFile(task._lazyFilePath, 'utf8'));
                    if (task._corrupted || fileJson.task_id !== id) throw new TaskTransferError('invalidTask');
                    if (!task._fullyLoaded) return deserializeTaskData(fileJson, manager).toJSON();
                } catch (error) {
                    throw new TaskTransferError('invalidTask', error);
                }
            }
            // 导出仅保留缩略图 + externalized 标记（不回填原图）：回填需要深拷贝任务图
            // + 全量读盘，对大任务会直接 OOM（issue #341）；原图字节由 bundle 的 artifacts
            // 条目携带，导入端按新任务 id 还原（见 collectTaskArtifactFiles / restoreTaskBundleArtifacts）。
            return task.toJSON();
        },
        artifactFiles
    );
    return selected.size;
}
