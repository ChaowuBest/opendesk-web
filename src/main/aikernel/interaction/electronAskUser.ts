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
import { broadcastToAllWindows } from '../../utils/electron-ipc.js';
import { electron } from '../../../utils/electron.js';

interface PendingPrompt {
    requestId: string;
    resolve: (response: AskUserResponse) => void;
    timer: ReturnType<typeof setTimeout> | null;
    handler: ((event: unknown, respRequestId: string, response: unknown) => void) | null;
    settled: boolean;
}

export class ElectronAskUserProvider implements AskUserProvider {
    /**
     * 同时等待用户响应的所有请求。
     * 模型在单个 turn 内可能并行发起多个 askUser 调用，单 pending 会被后一个覆盖，
     * 导致旧请求的 ipcMain 监听器与定时器泄漏、promise 永不 resolve。
     */
    private pendingPrompts: PendingPrompt[] = [];

    isPrompting(): boolean {
        return this.pendingPrompts.length > 0;
    }

    cancelCurrent(): void {
        if (this.pendingPrompts.length === 0) return;
        const pendingList = this.pendingPrompts;
        this.pendingPrompts = [];
        for (const pending of pendingList) {
            this.settle(pending, { answers: {}, cancelled: true }, true);
        }
    }

    /**
     * 结束一次提问：清理定时器与监听器并 resolve。
     * 使用 removeListener（而非 removeAllListeners）保证并发的多个任务互不影响。
     */
    private settle(pending: PendingPrompt, response: AskUserResponse, dismiss: boolean): void {
        if (pending.settled) return;
        pending.settled = true;
        if (pending.timer) clearTimeout(pending.timer);
        const index = this.pendingPrompts.indexOf(pending);
        if (index >= 0) {
            this.pendingPrompts.splice(index, 1);
        }
        try {
            const { ipcMain } = electron();
            if (pending.handler) {
                ipcMain.removeListener('askUser:response', pending.handler);
            }
            if (dismiss) {
                // 广播到所有窗口：主窗口不一定是 getAllWindows() 的第一个（常驻悬浮窗可能排在前面）
                broadcastToAllWindows('askUser:dismiss', pending.requestId);
            }
        } catch (err) {
            logger.warn(`ElectronAskUserProvider.settle failed: ${err}`);
        }
        pending.resolve(response);
    }

    async prompt(request: AskUserRequest): Promise<AskUserResponse> {
        try {
            const { BrowserWindow, ipcMain, Notification } = electron();
            const windows = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
            if (windows.length === 0) {
                logger.warn('ElectronAskUserProvider: no window available, returning cancelled');
                return { answers: {}, cancelled: true };
            }
            // 仅用于系统通知点击时聚焦窗口，面板请求本身走广播
            const win = windows[0];

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
                const pending: PendingPrompt = {
                    requestId: request.requestId,
                    resolve,
                    timer: null,
                    handler: null,
                    settled: false
                };

                const timer = setTimeout(() => {
                    if (pending.settled) return;
                    logger.warn(`AskUser prompt timed out for request ${request.requestId}`);
                    this.settle(pending, { answers: {}, cancelled: true }, true);
                }, 600_000); // 10 分钟

                const handler = (_event: unknown, respRequestId: string, response: unknown) => {
                    if (respRequestId !== request.requestId) return;
                    if (pending.settled) return;
                    const data = (response ?? {}) as { answers?: Record<string, string[]>; cancelled?: boolean };
                    this.settle(pending, { answers: data.answers ?? {}, cancelled: data.cancelled ?? false }, false);
                };

                pending.timer = timer;
                pending.handler = handler;
                this.pendingPrompts.push(pending);

                ipcMain.on('askUser:response', handler);

                // 事件广播模式：请求发给所有窗口，由挂载了 ask-user-prompt 组件的窗口展示；
                // requestId 匹配保证多窗口响应幂等，未加载组件的窗口（如任务状态浮窗）不受影响。
                broadcastToAllWindows('askUser:request', request.requestId, {
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
