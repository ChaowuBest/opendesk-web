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
import { Setting } from '../../utils/setting.js';
import { LLM } from '../../aikernel/llm.js';
import { getLocale } from '../../../locale/index.js';
import { accountBackendRegistry } from './backend-registry.js';
import { getAccountRuntime } from './factory.js';
import { registerAccountAPIHandlers } from './ipc.js';
import type { AccountSession } from './types.js';
import { refreshBuiltinModels } from './model-provider.js';

export function registerElectronAccountIntegration(): void {
    const broadcast = (channel: string, payload: unknown): void => {
        for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) {
                safeSendToWebContents(win.webContents, channel, payload);
            }
        }
    };

    const publishSessionChanged = (session: AccountSession | null): void => {
        // 会话变化（登录/登出/刷新 token/插件重载）会影响内置模型凭据的可用性：
        // 先清理 adapter 缓存并推送会话，让登录态 UI 立即切换；
        // 内置模型目录依赖新会话换取到的 relay 凭据，必须重新拉取并持久化，
        // 因此设置快照要等拉取完成后再推送，否则 renderer 会拿到空模型列表。
        try {
            LLM.clearAdapterCache();
        } catch {
            // aikernel 未初始化等场景忽略
        }
        broadcast('account:sessionChanged', session);
        void (async () => {
            // 内置模型落盘时 Setting 会自行广播 setting:changed（含 resolved_locale），
            // 因此只在没有提交成功时才补一次快照，避免 renderer 每次登录都收到两遍。
            if (await refreshBuiltinModels()) return;
            let snapshot: unknown = null;
            try {
                snapshot = {
                    ...Setting.getInstance().getData(),
                    resolved_locale: getLocale()
                };
            } catch {
                // 设置不可用时跳过快照广播
            }
            if (snapshot) {
                broadcast('setting:changed', snapshot);
            }
        })();
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
