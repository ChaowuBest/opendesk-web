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
import type { TaskManagerState } from '../aikernel/task/manager.js';
import type * as TaskTransfer from '../aikernel/task/transfer.js';
import { createTaskTransferService, type TaskTransferService } from './task-transfer-service.js';
import { Setting } from './setting.js';
import { t } from '../../locale/index.js';

export function registerTaskTransferHandlers(
    manager: TaskManagerState,
    getWindow: () => BrowserWindow | null,
    transfer: typeof TaskTransfer
): void {
    const service = createTaskTransferService({
        getManager: () => manager,
        getWorkspace: () => Setting.getInstance().getEffectiveWorkspace(),
        transfer,
        host: {
            async pickImportFile() {
                const selected = await dialog.showOpenDialog(getWindow()!, {
                    title: t('taskTransfer.import'),
                    properties: ['openFile'],
                    filters: [{ name: t('taskTransfer.files'), extensions: ['zip', 'json'] }]
                });
                return selected.canceled || !selected.filePaths.length ? null : { filePath: selected.filePaths[0] };
            },
            async saveExportFile(defaultName, write) {
                const selected = await dialog.showSaveDialog(getWindow()!, {
                    title: t('taskTransfer.export'),
                    defaultPath: defaultName,
                    filters: [{ name: t('taskTransfer.bundle'), extensions: ['zip'] }]
                });
                if (selected.canceled || !selected.filePath) return null;
                const count = await write(selected.filePath);
                return { count, filePath: selected.filePath };
            }
        }
    });
    const handle = <Name extends keyof TaskTransferService>(name: Name) => {
        ipcMain.handle(`taskManager:${name}`, async (event, ...args: unknown[]) => {
            if (event.sender !== getWindow()?.webContents) {
                return { status: 'error', message: t('taskTransfer.error.expired') };
            }
            return Reflect.apply(service[name], service, args);
        });
    };
    handle('previewTaskImport');
    handle('discardTaskImport');
    handle('importTaskBundle');
    handle('exportTaskBundle');
    // 导入预览快照持有压缩包句柄与临时目录，进程退出时需要主动释放：
    // 10 分钟过期定时器不会再触发，否则退出后会残留临时文件。
    app.once('will-quit', () => void service.dispose());
}
