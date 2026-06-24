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
 * 维护 pending 状态以支持任务切换后恢复审批面板：
 * renderer 可通过 exitPlanMode:getPending 查询当前活跃请求。
 *
 * 注意：使用 createRequire 延迟加载 electron，避免 worker 线程中
 * 静态 import 导致 electron 模块不可用而崩溃（尤其在 OpenHarmony 平台）。
 */

import type { ExitPlanModeProvider, ExitPlanModeResponse, ExitPlanModeAction } from './exitPlanMode.js';
import { logger } from '../../utils/logger.js';
import { safeSendToWebContents } from '../../utils/electron-ipc.js';
import { electron } from '../../../utils/electron.js';

interface PendingRequest {
    requestId: string;
    planContent: string;
    planFilePath: string;
}

let _ipcHandleRegistered = false;
let _pendingRequest: PendingRequest | null = null;

export class ElectronExitPlanModeProvider implements ExitPlanModeProvider {
    private modeSwitcher: ((modeId: string) => Promise<void>) | null = null;

    constructor() {
        this.ensureIpcHandle();
    }

    setModeSwitcher(fn: (modeId: string) => Promise<void>): void {
        this.modeSwitcher = fn;
    }

    private ensureIpcHandle(): void {
        if (_ipcHandleRegistered) return;
        _ipcHandleRegistered = true;

        const { ipcMain } = electron();
        ipcMain.handle('exitPlanMode:getPending', () => {
            if (!_pendingRequest) return { status: 'ok', data: null };
            return {
                status: 'ok',
                data: {
                    requestId: _pendingRequest.requestId,
                    planContent: _pendingRequest.planContent,
                    planFilePath: _pendingRequest.planFilePath
                }
            };
        });
    }

    async promptAndSwitch(
        planContent: string,
        planFilePath: string,
        _taskId?: string,
        _taskName?: string
    ): Promise<ExitPlanModeResponse> {
        try {
            this.ensureIpcHandle();

            const { BrowserWindow, ipcMain, Notification } = electron();

            const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) || null;
            if (!win) {
                logger.warn('ElectronExitPlanModeProvider: no window available, returning continue-editing');
                return { action: 'continue-editing' };
            }

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

            _pendingRequest = { requestId, planContent, planFilePath };

            const response = await new Promise<ExitPlanModeResponse>((resolve) => {
                const timeoutMs = 600_000; // 10 分钟
                let settled = false;

                const cleanup = () => {
                    ipcMain.removeAllListeners('exitPlanMode:response');
                    _pendingRequest = null;
                };

                const timer = setTimeout(() => {
                    if (!settled) {
                        settled = true;
                        cleanup();
                        if (!win.isDestroyed()) {
                            safeSendToWebContents(win.webContents, 'exitPlanMode:dismiss', requestId);
                        }
                        logger.warn(`ExitPlanMode prompt timed out for request ${requestId}`);
                        resolve({ action: 'continue-editing' });
                    }
                }, timeoutMs);

                const handler = (_event: any, respRequestId: string, respData: any) => {
                    if (respRequestId !== requestId) return;
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    cleanup();

                    const action = (respData?.action ?? 'continue-editing') as ExitPlanModeAction;
                    resolve({ action });
                };

                ipcMain.on('exitPlanMode:response', handler);

                safeSendToWebContents(win.webContents, 'exitPlanMode:request', requestId, {
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
