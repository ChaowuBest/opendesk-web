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

const SETTING_CHANGED_CHANNEL = 'setting:changed';

type SettingChangedIPCListener = (event: unknown, data: unknown) => void;

interface SettingChangedIPC {
    on(channel: string, listener: SettingChangedIPCListener): unknown;
}

export interface SettingChangedDispatcher {
    subscribe(callback: (setting: unknown) => void): () => void;
}

/**
 * 主窗口启动时十余个组件（各翻译器/特性开关）都会通过 settingAPI.onSettingChanged
 * 订阅设置广播。若每个订阅者都直接在 ipcRenderer 上挂 listener，数量会超过 Node
 * EventEmitter 默认上限（10），每次启动都触发 MaxListenersExceededWarning。
 * 这里收敛为单个 IPC listener + 内部回调表，订阅数量不再受该上限约束。
 */
export function createSettingChangedDispatcher(ipc: SettingChangedIPC): SettingChangedDispatcher {
    const callbacks = new Set<(setting: unknown) => void>();
    ipc.on(SETTING_CHANGED_CHANNEL, (_event, data) => {
        for (const callback of callbacks) {
            callback(data);
        }
    });
    return {
        subscribe: (callback) => {
            callbacks.add(callback);
            return () => {
                callbacks.delete(callback);
            };
        }
    };
}
