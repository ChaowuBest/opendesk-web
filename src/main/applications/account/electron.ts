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

import { BrowserWindow, ipcMain } from 'electron';
import { safeSendToWebContents } from '../../utils/electron-ipc.js';
import { accountBackendRegistry } from './backend-registry.js';
import { getAccountRuntime } from './factory.js';
import { registerAccountAPIHandlers } from './ipc.js';
import type { AccountSession } from './types.js';

export function registerElectronAccountIntegration(): void {
    const publishSessionChanged = (session: AccountSession | null): void => {
        for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) {
                safeSendToWebContents(win.webContents, 'account:sessionChanged', session);
            }
        }
    };
    registerAccountAPIHandlers({
        ipc: ipcMain,
        runtime: getAccountRuntime(),
        publishSessionChanged
    });

    // 插件后端注册晚于窗口创建（启动时序）：后端激活后主动推送一次当前会话，
    // 让已完成初始化的 renderer 面板恢复登录态；后端注销（插件重载）时推送 null。
    const runtime = getAccountRuntime();
    accountBackendRegistry.onBackendsChanged(() => {
        try {
            publishSessionChanged(runtime.getService().getSession());
        } catch {
            publishSessionChanged(null);
        }
    });
}
