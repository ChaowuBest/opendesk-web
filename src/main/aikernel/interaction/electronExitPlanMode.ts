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
 * Electron 环境下的 ExitPlanModeProvider 实现。
 *
 * 通过 IPC 将计划审批请求发送到 renderer 展示，
 * 等待用户选择执行模式后回传结果并切换模式。
 *
 * 每个 provider 实例（对应一个任务）独立维护自身的 pending 状态，
 * 并通过按 taskId 索引的注册表支持任务切换后恢复审批面板：
 * renderer 可通过 exitPlanMode:getPending 查询指定任务的活跃请求。
 *
 * 注意：使用 createRequire 延迟加载 electron，避免 worker 线程中
 * 静态 import 导致 electron 模块不可用而崩溃（尤其在 OpenHarmony 平台）。
 */

import type { ExitPlanModeProvider, ExitPlanModeResponse, ExitPlanModeAction } from './exitPlanMode.js';
import { logger } from '../../utils/logger.js';
import { broadcastToAllWindows } from '../../utils/electron-ipc.js';
import { electron } from '../../../utils/electron.js';

interface PendingRequest {
    requestId: string;
    planContent: string;
    planFilePath: string;
}

interface PendingPrompt extends PendingRequest {
    taskId: string;
    resolve: (response: ExitPlanModeResponse) => void;
    timer: ReturnType<typeof setTimeout> | null;
    handler: ((event: unknown, respRequestId: string, respData: unknown) => void) | null;
    settled: boolean;
}

let _ipcHandleRegistered = false;
// 按 taskId 维护当前活跃的审批请求，供 renderer 通过 exitPlanMode:getPending 恢复面板。
const _pendingByTaskId = new Map<string, PendingPrompt>();

export class ElectronExitPlanModeProvider implements ExitPlanModeProvider {
    private modeSwitcher: ((modeId: string) => Promise<void>) | null = null;
    private pending: PendingPrompt | null = null;

    constructor() {
        this.ensureIpcHandle();
    }

    setModeSwitcher(fn: (modeId: string) => Promise<void>): void {
        this.modeSwitcher = fn;
    }

    cancelCurrent(): void {
        if (!this.pending) return;
        this.settle(this.pending, { action: 'continue-editing' }, true);
    }

    /**
     * 结束一次审批请求：清理定时器与监听器、注销注册表条目并 resolve。
     * 使用 removeListener（而非 removeAllListeners）保证并发的多个任务互不影响。
     */
    private settle(pending: PendingPrompt, response: ExitPlanModeResponse, dismiss: boolean): void {
        if (pending.settled) return;
        pending.settled = true;
        if (pending.timer) clearTimeout(pending.timer);
        if (this.pending === pending) {
            this.pending = null;
        }
        if (_pendingByTaskId.get(pending.taskId) === pending) {
            _pendingByTaskId.delete(pending.taskId);
        }
        try {
            const { ipcMain } = electron();
            if (pending.handler) {
                ipcMain.removeListener('exitPlanMode:response', pending.handler);
            }
            if (dismiss) {
                broadcastToAllWindows('exitPlanMode:dismiss', pending.requestId);
            }
        } catch (err) {
            logger.warn(`ElectronExitPlanModeProvider.settle failed: ${err}`);
        }
        pending.resolve(response);
    }

    private ensureIpcHandle(): void {
        if (_ipcHandleRegistered) return;
        _ipcHandleRegistered = true;

        const { ipcMain } = electron();
        ipcMain.handle('exitPlanMode:getPending', (_event, taskId?: string) => {
            const pending = taskId ? _pendingByTaskId.get(taskId) : Array.from(_pendingByTaskId.values()).at(-1);
            if (!pending) return { status: 'ok', data: null };
            return {
                status: 'ok',
                data: {
                    requestId: pending.requestId,
                    planContent: pending.planContent,
                    planFilePath: pending.planFilePath
                }
            };
        });
    }

    async promptAndSwitch(
        planContent: string,
        planFilePath: string,
        taskId?: string,
        _taskName?: string
    ): Promise<ExitPlanModeResponse> {
        try {
            this.ensureIpcHandle();

            const { BrowserWindow, ipcMain, Notification } = electron();

            const windows = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
            if (windows.length === 0) {
                logger.warn('ElectronExitPlanModeProvider: no window available, returning continue-editing');
                return { action: 'continue-editing' };
            }
            // 仅用于系统通知点击时聚焦窗口，面板请求本身走广播
            const win = windows[0];

            if (Notification.isSupported()) {
                const notification = new Notification({
                    title: 'OpenDesk - 计划审批',
                    body: '请在应用内审批实施计划',
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

            const requestId = `exitPlan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const pendingTaskId = taskId || requestId;

            const response = await new Promise<ExitPlanModeResponse>((resolve) => {
                const pending: PendingPrompt = {
                    requestId,
                    planContent,
                    planFilePath,
                    taskId: pendingTaskId,
                    resolve,
                    timer: null,
                    handler: null,
                    settled: false
                };

                const timer = setTimeout(() => {
                    if (pending.settled) return;
                    logger.warn(`ExitPlanMode prompt timed out for request ${requestId}`);
                    this.settle(pending, { action: 'continue-editing' }, true);
                }, 600_000); // 10 分钟

                const handler = (_event: unknown, respRequestId: string, respData: unknown) => {
                    if (respRequestId !== requestId) return;
                    if (pending.settled) return;
                    const action = ((respData as { action?: string })?.action ??
                        'continue-editing') as ExitPlanModeAction;
                    this.settle(pending, { action }, false);
                };

                pending.timer = timer;
                pending.handler = handler;
                this.pending = pending;
                _pendingByTaskId.set(pendingTaskId, pending);

                ipcMain.on('exitPlanMode:response', handler);

                broadcastToAllWindows('exitPlanMode:request', requestId, {
                    planContent,
                    planFilePath
                });
            });

            if (response.action === 'execute-standard' && this.modeSwitcher) {
                await this.modeSwitcher('standard');
            } else if (response.action === 'execute-solo' && this.modeSwitcher) {
                await this.modeSwitcher('solo');
            }

            return response;
        } catch (err) {
            logger.warn(`ElectronExitPlanModeProvider failed: ${err}`);
            return { action: 'continue-editing' };
        }
    }
}
