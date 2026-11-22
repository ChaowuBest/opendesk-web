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
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { TaskManagerState } from '../aikernel/task/manager.js';
import type * as TaskTransfer from '../aikernel/task/transfer.js';
import {
    readTaskImportFile,
    TaskTransferError,
    type TaskImportEntry,
    type TaskImportPreview as TaskImportSnapshot
} from './task-bundle.js';
import { logger } from './logger.js';
import { t } from '../../locale/index.js';

export interface TaskTransferHost {
    pickImportFile(): Promise<{ filePath: string; release?: () => Promise<void> } | null>;
    saveExportFile(
        defaultName: string,
        write: (filePath: string) => Promise<number>
    ): Promise<{ count: number; filePath: string } | null>;
}
export type TaskTransferResult<T> = { status: 'ok'; data: T } | { status: 'error'; message: string };
/** IPC 返回体：task-bundle 的 TaskImportPreview 是持有临时快照的内部对象，这里只回传可展示的部分。 */
export interface TaskImportPreviewResult {
    token: string;
    workspace: string;
    entries: Omit<TaskImportEntry, 'readJson'>[];
}
export interface TaskExportResult {
    count: number;
    filePath: string;
}
export interface TaskTransferService {
    previewTaskImport(): Promise<TaskTransferResult<TaskImportPreviewResult | null>>;
    discardTaskImport(token: unknown): Promise<TaskTransferResult<void>>;
    importTaskBundle(token: unknown, selectedIds: unknown, workspace: unknown): Promise<TaskTransferResult<number>>;
    exportTaskBundle(selectedIds: unknown): Promise<TaskTransferResult<TaskExportResult | null>>;
    /** 宿主退出时丢弃未消费的导入快照：关闭压缩包句柄并删除临时目录，可重复调用。 */
    dispose(): Promise<void>;
}
/** The host owns document access; tokens, validation and mutations share the same implementation. */
export function createTaskTransferService(deps: {
    getManager(): TaskManagerState;
    getWorkspace(): string;
    host: TaskTransferHost;
    transfer: Pick<typeof TaskTransfer, 'exportTaskBundle' | 'importTaskEntries'>;
}): TaskTransferService {
    let preview: { token: string; snapshot: TaskImportSnapshot } | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    let busy = false;
    const discard = async () => {
        const previous = preview;
        preview = undefined;
        clearTimeout(expiry);
        await previous?.snapshot
            .dispose()
            .catch((error) => logger.warn('Could not remove task import snapshot', error));
    };
    const run = async <T>(
        name: keyof TaskTransferService,
        action: () => Promise<T>
    ): Promise<TaskTransferResult<T>> => {
        if (busy) {
            return { status: 'error', message: t('taskTransfer.error.expired') };
        }
        try {
            busy = true;
            return { status: 'ok', data: await action() };
        } catch (error) {
            const code = error instanceof TaskTransferError ? error.code : 'writeFailed';
            const diagnostic = formatDiagnostic(error, name);
            const cause = error instanceof Error ? error.cause : undefined;
            logger.warn(
                `Task transfer ${name} failed: ${diagnostic || String(error)}\n${cause instanceof Error ? cause.stack : error instanceof Error ? error.stack : ''}`
            );
            return {
                status: 'error',
                message: t(
                    name === 'importTaskBundle' && code === 'writeFailed'
                        ? 'taskTransfer.error.importWriteFailed'
                        : `taskTransfer.error.${code}`
                )
            };
        } finally {
            busy = false;
        }
    };
    return {
        previewTaskImport: () =>
            run('previewTaskImport', async () => {
                await discard();
                const selected = await deps.host.pickImportFile();
                if (!selected) return null;
                let snapshot: TaskImportSnapshot;
                try {
                    snapshot = await readTaskImportFile(selected.filePath);
                } finally {
                    await selected.release?.();
                }
                const token = randomUUID();
                preview = { token, snapshot };
                expiry = setTimeout(() => void discard(), 10 * 60 * 1000);
                expiry.unref();
                return {
                    token,
                    workspace: deps.getWorkspace(),
                    entries: snapshot.entries.map(({ readJson: _readJson, ...entry }) => entry)
                };
            }),
        discardTaskImport: (token) =>
            run('discardTaskImport', async () => {
                if (preview?.token === token) await discard();
            }),
        importTaskBundle: (token, selectedIds, workspace) =>
            run('importTaskBundle', async () => {
                if (!preview || token !== preview.token) throw new TaskTransferError('expired');
                // IPC payloads still need runtime validation despite the public TypeScript signatures.
                if (!Array.isArray(selectedIds) || selectedIds.some((id) => typeof id !== 'string'))
                    throw new TaskTransferError('invalidTask');
                if (
                    typeof workspace !== 'string' ||
                    !path.isAbsolute(workspace) ||
                    !(await stat(workspace).catch(() => null))?.isDirectory()
                )
                    throw new TaskTransferError('invalidWorkspace');
                const prepared = preview;
                clearTimeout(expiry);
                try {
                    const count = await deps.transfer.importTaskEntries(
                        prepared.snapshot.entries,
                        selectedIds,
                        deps.getManager(),
                        workspace,
                        // v2 bundle 的随包 artifacts 在任务提交成功后还原（best-effort）
                        { restoreArtifacts: prepared.snapshot.restoreArtifacts }
                    );
                    await discard();
                    return count;
                } catch (error) {
                    // Keep the same snapshot and selections available for a corrected retry.
                    expiry = setTimeout(() => void discard(), 10 * 60 * 1000);
                    expiry.unref();
                    throw error;
                }
            }),
        exportTaskBundle: (selectedIds) =>
            run('exportTaskBundle', async () => {
                if (
                    !Array.isArray(selectedIds) ||
                    !selectedIds.length ||
                    selectedIds.some((id) => typeof id !== 'string')
                )
                    throw new TaskTransferError('invalidTask');
                return deps.host.saveExportFile(
                    `OpenDesk-tasks-${new Date().toISOString().slice(0, 10)}.zip`,
                    (filePath) => deps.transfer.exportTaskBundle(deps.getManager(), selectedIds, filePath)
                );
            }),
        // 进程退出不等待异步清理完成：快照目录的删除是 best-effort，但句柄必须尽早释放。
        dispose: () => discard()
    };
}

function formatDiagnostic(error: unknown, operation: string): string {
    const transfer = error instanceof TaskTransferError ? error : undefined;
    if (transfer && transfer.cause === undefined) return '';
    const stage = transfer?.stage ?? (operation === 'previewTaskImport' ? 'readImportFile' : undefined);
    const lines: string[] = [];
    if (stage) lines.push(`${t('taskTransfer.diagnostic.stage')}: ${t(`taskTransfer.stage.${stage}`)}`);
    let current: unknown = transfer?.cause ?? error;
    for (let depth = 0; depth < 5 && current !== undefined; depth++) {
        const detail = current as NodeJS.ErrnoException & { cause?: unknown };
        lines.push([detail?.code, detail?.syscall, detail?.message ?? String(current)].filter(Boolean).join(' | '));
        current = detail?.cause;
    }
    if (transfer?.filePath) lines.push(`${t('taskTransfer.diagnostic.path')}: ${transfer.filePath}`);
    return lines.join('\n');
}
