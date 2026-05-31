/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 *
 * 原生桥 preload 侧：把 IPC 通道封装为 window[RENDERER_BRIDGE_GLOBAL]，供渲染进程调用。
 * 该层与具体系统平台无关，仅转发能力通道；是否暴露由 isNativeBridgePlatform 统一判断。
 */

import { contextBridge, ipcRenderer } from 'electron';
import { IpcChannels, RENDERER_BRIDGE_GLOBAL, isNativeBridgePlatform } from './constants.js';

/**
 * 渲染进程：在支持原生桥的系统平台上暴露 window[RENDERER_BRIDGE_GLOBAL]。
 * @returns 是否已暴露
 */
export function exposeNativeBridge(): boolean {
    if (!isNativeBridgePlatform(process.platform)) {
        return false;
    }

    const api = {
        ping: (message: string) => ipcRenderer.invoke(IpcChannels.PING, message),
        speechInit: () => ipcRenderer.invoke(IpcChannels.SPEECH_INIT),
        speechStart: () => ipcRenderer.invoke(IpcChannels.SPEECH_START),
        speechPeek: () => ipcRenderer.invoke(IpcChannels.SPEECH_PEEK),
        speechStop: () => ipcRenderer.invoke(IpcChannels.SPEECH_STOP),
        speechRelease: () => ipcRenderer.invoke(IpcChannels.SPEECH_RELEASE)
    };

    contextBridge.exposeInMainWorld(RENDERER_BRIDGE_GLOBAL, api);
    return true;
}
