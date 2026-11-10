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

import { app, dialog, ipcMain, type BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { TaskManagerState } from '../aikernel/task/manager.js';
import type * as TaskTransfer from '../aikernel/task/transfer.js';
import { readTaskImportFile, TaskTransferError, type TaskImportPreview } from './task-bundle.js';
import { Setting } from './setting.js';
import { logger } from './logger.js';
import { t } from '../../locale/index.js';

export function registerTaskTransferHandlers(
    manager: TaskManagerState,
    getWindow: () => BrowserWindow | null,
    { exportTaskBundle, importTaskEntries }: typeof TaskTransfer
): void {
    let preview: (TaskImportPreview & { token: string }) | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    let busy = false;
    const discard = async () => {
        const previous = preview;
        preview = undefined;
        clearTimeout(expiry);
        await previous?.dispose().catch((error) => logger.warn('Could not remove task import snapshot', error));
    };
    const startExpiry = () => {
        expiry = setTimeout(() => void discard(), 10 * 60 * 1000);
        expiry.unref();
    };
    const handle = (name: string, action: (...args: any[]) => Promise<unknown>) => {
        ipcMain.handle(`taskManager:${name}`, async (event, ...args) => {
            if (event.sender !== getWindow()?.webContents || busy) {
                return { status: 'error', message: t('taskTransfer.error.expired') };
            }
            try {
                busy = true;
                return { status: 'ok', data: await action(...args) };
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
        });
    };
    handle('previewTaskImport', async () => {
        await discard();
        const selected = await dialog.showOpenDialog(getWindow()!, {
            title: t('taskTransfer.import'),
            properties: ['openFile'],
            filters: [{ name: t('taskTransfer.files'), extensions: ['zip', 'json'] }]
        });
        if (selected.canceled || !selected.filePaths.length) return null;
        const workspace = Setting.getInstance().getEffectiveWorkspace();
        const token = randomUUID();
        const prepared = await readTaskImportFile(selected.filePaths[0]);
        preview = { token, ...prepared };
        startExpiry();
        return {
            token,
            workspace,
            entries: prepared.entries.map(({ readJson: _readJson, ...entry }) => entry)
        };
    });
    handle('discardTaskImport', async (token: unknown) => {
        if (preview?.token === token) await discard();
    });
    handle('importTaskBundle', async (token: unknown, selectedIds: unknown, workspace: unknown) => {
        if (!preview || token !== preview.token) throw new TaskTransferError('expired');
        if (!Array.isArray(selectedIds) || selectedIds.some((id) => typeof id !== 'string'))
            throw new TaskTransferError('invalidTask');
        if (
            typeof workspace !== 'string' ||
            !path.isAbsolute(workspace) ||
            !(await stat(workspace).catch(() => null))?.isDirectory()
        )
            throw new TaskTransferError('invalidWorkspace');
        if (!preview || token !== preview.token) throw new TaskTransferError('expired');
        const prepared = preview;
        clearTimeout(expiry);
        try {
            const count = await importTaskEntries(prepared.entries, selectedIds, manager, workspace);
            await discard();
            return count;
        } catch (error) {
            // Keep the same snapshot and selections available for a corrected retry.
            startExpiry();
            throw error;
        }
    });
    handle('exportTaskBundle', async (selectedIds: unknown) => {
        if (!Array.isArray(selectedIds) || !selectedIds.length || selectedIds.some((id) => typeof id !== 'string'))
            throw new TaskTransferError('invalidTask');
        const selected = await dialog.showSaveDialog(getWindow()!, {
            title: t('taskTransfer.export'),
            defaultPath: `OpenDesk-tasks-${new Date().toISOString().slice(0, 10)}.zip`,
            filters: [{ name: t('taskTransfer.bundle'), extensions: ['zip'] }]
        });
        if (selected.canceled || !selected.filePath) return null;
        const count = await exportTaskBundle(manager, selectedIds, selected.filePath);
        return { count, filePath: selected.filePath };
    });
    app.once('will-quit', () => void discard());
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
