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
 * Electron 环境下的 AskUserProvider 实现。
 *
 * 通过 IPC 将问题请求发送到 renderer 的 ask-user-prompt 组件展示，
 * 等待用户在内嵌面板中做出选择后回传结果。
 */

import type { AskUserRequest, AskUserResponse, AskUserProvider } from './tools.js';
import { logger } from '../../utils/logger.js';
import { safeSendToWebContents } from '../../utils/electron-ipc.js';
import { electron } from '../../../utils/electron.js';

export class ElectronAskUserProvider implements AskUserProvider {
    isPrompting?(): boolean {
        return false;
    }

    async prompt(request: AskUserRequest): Promise<AskUserResponse> {
        try {
            const { BrowserWindow, ipcMain, Notification } = electron();
            const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) || null;
            if (!win) {
                logger.warn('ElectronAskUserProvider: no window available, returning cancelled');
                return { answers: {}, cancelled: true };
            }

            if (Notification.isSupported()) {
                const notification = new Notification({
                    title: 'OpenDesk - 需要您的输入',
                    body: request.questions[0]?.question ?? '请在应用内回答问题',
                    silent: false
                });
                notification.show();
                notification.on('click', () => {
                    if (!win.isDestroyed()) {
                        win.show();
                        win.focus();
                    }
                });
            }

            return new Promise<AskUserResponse>((resolve) => {
                const timeoutMs = 600_000; // 10 分钟
                let settled = false;

                const cleanup = () => {
                    ipcMain.removeAllListeners('askUser:response');
                };

                const timer = setTimeout(() => {
                    if (!settled) {
                        settled = true;
                        cleanup();
                        if (!win.isDestroyed()) {
                            safeSendToWebContents(win.webContents, 'askUser:dismiss', request.requestId);
                        }
                        logger.warn(`AskUser prompt timed out for request ${request.requestId}`);
                        resolve({ answers: {}, cancelled: true });
                    }
                }, timeoutMs);

                const handler = (_event: any, respRequestId: string, response: any) => {
                    if (respRequestId !== request.requestId) return;
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    cleanup();
                    resolve({
                        answers: response.answers ?? {},
                        cancelled: response.cancelled ?? false
                    });
                };

                ipcMain.on('askUser:response', handler);

                safeSendToWebContents(win.webContents, 'askUser:request', request.requestId, {
                    questions: request.questions,
                    taskId: request.taskId,
                    taskName: request.taskName
                });
            });
        } catch (err) {
            logger.warn(`ElectronAskUserProvider failed: ${err}`);
            return { answers: {}, cancelled: true };
        }
    }
}
