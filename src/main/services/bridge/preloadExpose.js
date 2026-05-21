/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import { contextBridge, ipcRenderer } from 'electron';
import { IpcChannels, RENDERER_BRIDGE_GLOBAL } from './constants.js';

/**
 * 渲染进程：暴露 window[RENDERER_BRIDGE_GLOBAL]（仅 OpenHarmony）
 * @returns {boolean} 是否已暴露
 */
export function exposeNativeBridge() {
    if (process.platform !== 'openharmony') {
        return false;
    }

    const api = {
        ping: (message) => ipcRenderer.invoke(IpcChannels.PING, message),
        speechInit: () => ipcRenderer.invoke(IpcChannels.SPEECH_INIT),
        speechStart: () => ipcRenderer.invoke(IpcChannels.SPEECH_START),
        speechStop: () => ipcRenderer.invoke(IpcChannels.SPEECH_STOP),
        speechRelease: () => ipcRenderer.invoke(IpcChannels.SPEECH_RELEASE)
    };

    contextBridge.exposeInMainWorld(RENDERER_BRIDGE_GLOBAL, api);
    return true;
}
