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

import { createIpcChannelDispatcher, type IpcOnOff } from './ipcChannelDispatcher.js';

const SETTING_CHANGED_CHANNEL = 'setting:changed';

export interface SettingChangedDispatcher {
    subscribe(callback: (setting: unknown) => void): () => void;
}

/**
 * 主窗口启动时十余个组件（各翻译器/特性开关）都会通过 settingAPI.onSettingChanged
 * 订阅设置广播。若每个订阅者都直接在 ipcRenderer 上挂 listener，数量会超过 Node
 * EventEmitter 默认上限（10），每次启动都触发 MaxListenersExceededWarning。
 *
 * 「一通道 → 多订阅者」的通用实现只有 ipcChannelDispatcher 一份，这里只是给
 * setting:changed 通道起个专属名字；不要另写一份分发器。
 */
export function createSettingChangedDispatcher(ipc: IpcOnOff): SettingChangedDispatcher {
    return createIpcChannelDispatcher(ipc, SETTING_CHANGED_CHANNEL);
}
