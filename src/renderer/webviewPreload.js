/**
 * Webview Preload — window.open Proxy Injection
 *
 * 此 preload 在 webview guest 页面任何脚本执行之前运行。
 * 配合 contextIsolation=yes，通过同步主上下文执行 patch window.open，
 * 确保页面的同步 <script> 块中调用 window.open 时已返回 proxy 而非 null。
 *
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import { BROWSER_FOCUS_TRAP_SCRIPT, WINDOW_OPEN_PROXY_SCRIPT } from './webviewScripts.js';
import { contextBridge, ipcRenderer, webFrame } from 'electron';
import { installCredentialFormSupport } from './browserCredentials.js';

// Keep page hooks in the page world; never expose the credential IPC bridge there.
for (const script of [WINDOW_OPEN_PROXY_SCRIPT, BROWSER_FOCUS_TRAP_SCRIPT]) {
    if (typeof contextBridge.executeInMainWorld === 'function') {
        contextBridge.executeInMainWorld({ func: new Function(script) });
    } else {
        // Older platform Electron builds do not provide the synchronous bridge API.
        void webFrame.executeJavaScript(script).catch(() => {});
    }
}

if (process.isMainFrame) {
    installCredentialFormSupport({
        list: () => ipcRenderer.invoke('browser-credentials:list'),
        fill: (requestId, username) => ipcRenderer.invoke('browser-credentials:fill', { requestId, username }),
        save: (candidate) => ipcRenderer.invoke('browser-credentials:save', candidate)
    });
}
