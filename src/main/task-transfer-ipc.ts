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

import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { TaskManagerState } from './aikernel/task/manager.js';
import {
    exportTaskBundle,
    importTaskEntries,
    prepareTaskImport,
    type PreparedTaskEntry
} from './aikernel/task/transfer.js';
import { TaskTransferError } from './utils/task-bundle.js';
import { Setting } from './utils/setting.js';
import { logger } from './utils/logger.js';
import { t } from '../locale/index.js';

export function registerTaskTransferHandlers(manager: TaskManagerState, getWindow: () => BrowserWindow | null): void {
    let preview: { token: string; entries: PreparedTaskEntry[] } | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    let busy = false;
    const discard = () => {
        preview = undefined;
        clearTimeout(expiry);
    };
    const handle = (name: string, action: (event: IpcMainInvokeEvent, ...args: any[]) => Promise<unknown>) => {
        ipcMain.handle(`taskManager:${name}`, async (event, ...args) => {
            if (event.sender !== getWindow()?.webContents || busy) {
                return { status: 'error', message: t('taskTransfer.error.expired') };
            }
            try {
                busy = true;
                return { status: 'ok', data: await action(event, ...args) };
            } catch (error) {
                logger.warn(`Task transfer ${name} failed`, error);
                const code = error instanceof TaskTransferError ? error.code : 'writeFailed';
                return { status: 'error', message: t(`taskTransfer.error.${code}`) };
            } finally {
                busy = false;
            }
        });
    };
    const progress = (event: IpcMainInvokeEvent, operationId: string) => (done: number, total: number) => {
        if (!event.sender.isDestroyed())
            event.sender.send('taskManager:transferProgress', { operationId, done, total });
    };
    handle('previewTaskImport', async () => {
        discard();
        const selected = await dialog.showOpenDialog(getWindow()!, {
            title: t('taskTransfer.import'),
            properties: ['openFile'],
            filters: [{ name: t('taskTransfer.files'), extensions: ['zip', 'json'] }]
        });
        if (selected.canceled || !selected.filePaths.length) return null;
        const entries = await prepareTaskImport(selected.filePaths[0], manager);
        const token = randomUUID();
        const workspace = Setting.getInstance().getEffectiveWorkspace();
        preview = { token, entries };
        expiry = setTimeout(discard, 10 * 60 * 1000);
        expiry.unref();
        return {
            token,
            workspace,
            entries: entries.map(({ json: _json, fingerprint: _fingerprint, ...entry }) => entry)
        };
    });
    handle('discardTaskImport', async (_event, token: unknown) => {
        if (preview?.token === token) discard();
    });
    handle(
        'importTaskBundle',
        async (event, token: unknown, selectedIds: unknown, operationId: string, workspace: unknown) => {
            if (!preview || token !== preview.token) throw new TaskTransferError('expired');
            if (!Array.isArray(selectedIds) || selectedIds.some((id) => typeof id !== 'string'))
                throw new TaskTransferError('invalidTask');
            if (
                typeof workspace !== 'string' ||
                !path.isAbsolute(workspace) ||
                !(await stat(workspace).catch(() => null))?.isDirectory()
            )
                throw new TaskTransferError('invalidWorkspace');
            const prepared = preview;
            discard();
            return importTaskEntries(prepared.entries, selectedIds, manager, workspace, progress(event, operationId));
        }
    );
    handle('exportTaskBundle', async (event, selectedIds: unknown, operationId: string) => {
        if (!Array.isArray(selectedIds) || !selectedIds.length || selectedIds.some((id) => typeof id !== 'string'))
            throw new TaskTransferError('invalidTask');
        const selected = await dialog.showSaveDialog(getWindow()!, {
            title: t('taskTransfer.export'),
            defaultPath: `OpenDesk-tasks-${new Date().toISOString().slice(0, 10)}.zip`,
            filters: [{ name: t('taskTransfer.bundle'), extensions: ['zip'] }]
        });
        if (selected.canceled || !selected.filePath) return null;
        const count = await exportTaskBundle(manager, selectedIds, selected.filePath, progress(event, operationId));
        return { count, filePath: selected.filePath };
    });
}
