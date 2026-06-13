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
 * embedBrowserUse — Preload bridge definition.
 *
 * Call `defineBrowserBridge("browserAPI", contextBridge, ipcRenderer)` in your
 * preload script to expose `window.browserAPI` with IPC methods and instance
 * registration support.
 *
 * NOTE: This file is designed to be usable from plain-JS preload scripts.
 * The consuming preload can either import this directly (if bundled) or
 * inline the equivalent logic. The channel names are kept in sync with
 * protocol.ts via the `Channels` constant.
 */

import { Channels } from './protocol';
import type { BrowserInstance } from './renderer';

/**
 * Expose a browser bridge API on `window[apiName]` via Electron's
 * contextBridge. The bridge forwards IPC calls to the main process and
 * provides instance registration so the main process can invoke methods
 * on renderer-side BrowserInstance objects.
 *
 * @param apiName   - The global name to expose (e.g. "browserAPI")
 * @param contextBridge - Electron's contextBridge module
 * @param ipcRenderer   - Electron's ipcRenderer module
 */
export function defineBrowserBridge(
    apiName: string,
    contextBridge: { exposeInMainWorld: (name: string, api: Record<string, unknown>) => void },
    ipcRenderer: {
        invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
        on: (channel: string, listener: (...args: unknown[]) => void) => void;
    }
): void {
    // Registry of renderer-side BrowserInstance objects, keyed by instance id
    const instances = new Map<string, BrowserInstance>();

    /** Unwrap the standard { status, data, message } envelope. */
    const unwrap = async (resultPromise: Promise<unknown>): Promise<unknown> => {
        const result = (await resultPromise) as { status: string; data?: unknown; message?: string };
        if (result.status !== 'ok') {
            throw new Error(result.message || 'Browser IPC call failed');
        }
        return result.data;
    };

    /** Unwrap but return null on error (for screenshot). */
    const unwrapOrNull = async (resultPromise: Promise<unknown>): Promise<unknown> => {
        const result = (await resultPromise) as { status: string; data?: unknown };
        if (result.status !== 'ok') return null;
        return result.data;
    };

    const api: Record<string, unknown> = {
        // ---- IPC forwarding methods ----

        navigate: async (instanceId: string, url: string) => {
            return unwrap(ipcRenderer.invoke(Channels.navigate, instanceId, url));
        },
        getState: async (instanceId: string) => {
            return unwrap(ipcRenderer.invoke(Channels.getState, instanceId));
        },
        executeScript: async (instanceId: string, script: string) => {
            return unwrap(ipcRenderer.invoke(Channels.executeScript, instanceId, script));
        },
        goBack: async (instanceId: string) => {
            return unwrap(ipcRenderer.invoke(Channels.goBack, instanceId));
        },
        goForward: async (instanceId: string) => {
            return unwrap(ipcRenderer.invoke(Channels.goForward, instanceId));
        },
        refresh: async (instanceId: string) => {
            return unwrap(ipcRenderer.invoke(Channels.refresh, instanceId));
        },
        captureScreenshot: async (webContentsId: number) => {
            return unwrapOrNull(ipcRenderer.invoke(Channels.captureScreenshot, webContentsId));
        },
        listTabs: async (instanceId: string) => {
            return unwrap(ipcRenderer.invoke(Channels.listTabs, instanceId));
        },
        addTab: async (instanceId: string, url: string) => {
            return unwrap(ipcRenderer.invoke(Channels.addTab, instanceId, url));
        },
        closeTab: async (instanceId: string, tabId: number) => {
            return unwrap(ipcRenderer.invoke(Channels.closeTab, instanceId, tabId));
        },
        switchTab: async (instanceId: string, tabId: number) => {
            return unwrap(ipcRenderer.invoke(Channels.switchTab, instanceId, tabId));
        },
        getWebContentsId: async (instanceId: string) => {
            return unwrap(ipcRenderer.invoke(Channels.getWebContentsId, instanceId));
        },
        focusActiveWebview: async (instanceId: string) => {
            const inst = instances.get(instanceId);
            return inst ? inst.focusActiveWebview() : false;
        },
        openDevTools: async (webContentsId: number) => {
            return unwrap(ipcRenderer.invoke(Channels.openDevTools, webContentsId));
        },
        exportSnapshot: async (webContentsId: number) => {
            return unwrap(ipcRenderer.invoke(Channels.exportSnapshot, webContentsId));
        },

        // ---- Instance registration (used by BrowserInstance.register()) ----

        _registerInstance: (id: string, inst: BrowserInstance) => {
            instances.set(id, inst);
        },
        _unregisterInstance: (id: string) => {
            instances.delete(id);
        },
        _getInstance: (id: string): BrowserInstance | undefined => {
            return instances.get(id);
        }
    };

    try {
        contextBridge.exposeInMainWorld(apiName, api);
    } catch (err) {
        const msg = String(err?.message ?? err);
        if (/existing property|already been registered/i.test(msg)) {
            return;
        }
        throw err;
    }

    // Forward popup-blocked events from main → renderer as DOM CustomEvents
    ipcRenderer.on(Channels.popupBlocked, (...args: unknown[]) => {
        // ipcRenderer.on callback: (event, url, webContentsId)
        const url = args[1] as string;
        const webContentsId = args[2] as number;
        window.dispatchEvent(new CustomEvent('browser-popup-blocked', { detail: { url, webContentsId } }));
    });

    // Forward webview-close-requested events (guest 调用 window.close())
    ipcRenderer.on(Channels.webviewCloseRequested, (...args: unknown[]) => {
        // ipcRenderer.on callback: (event, webContentsId)
        const webContentsId = args[1] as number;
        window.dispatchEvent(new CustomEvent('browser-webview-close-requested', { detail: { webContentsId } }));
    });

    // Forward download-update events (下载进度 / 状态变更)
    ipcRenderer.on(Channels.downloadUpdate, (...args: unknown[]) => {
        // ipcRenderer.on callback: (event, downloadData)
        const data = args[1] as Record<string, unknown>;
        window.dispatchEvent(new CustomEvent('browser-download-update', { detail: data }));
    });
}
