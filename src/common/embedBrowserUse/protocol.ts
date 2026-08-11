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
 * embedBrowserUse — IPC protocol definitions.
 *
 * This file is imported by renderer, preload, AND main process code.
 * It MUST NOT depend on any Node.js or Electron APIs.
 */

// ---------------------------------------------------------------------------
// IPC Channel Names
// ---------------------------------------------------------------------------

const CHANNEL_PREFIX = 'embedBrowser';

export const Channels = {
    navigate: `${CHANNEL_PREFIX}:navigate`,
    getState: `${CHANNEL_PREFIX}:getState`,
    executeScript: `${CHANNEL_PREFIX}:executeScript`,
    goBack: `${CHANNEL_PREFIX}:goBack`,
    goForward: `${CHANNEL_PREFIX}:goForward`,
    refresh: `${CHANNEL_PREFIX}:refresh`,
    captureScreenshot: `${CHANNEL_PREFIX}:captureScreenshot`,
    listTabs: `${CHANNEL_PREFIX}:listTabs`,
    addTab: `${CHANNEL_PREFIX}:addTab`,
    closeTab: `${CHANNEL_PREFIX}:closeTab`,
    switchTab: `${CHANNEL_PREFIX}:switchTab`,
    getWebContentsId: `${CHANNEL_PREFIX}:getWebContentsId`,
    openDevTools: `${CHANNEL_PREFIX}:openDevTools`,
    exportSnapshot: `${CHANNEL_PREFIX}:exportSnapshot`,
    /** main → renderer push */
    popupBlocked: `${CHANNEL_PREFIX}:popup-blocked`,
    /** main → renderer: webview guest 调用 window.close() */
    webviewCloseRequested: `${CHANNEL_PREFIX}:webview-close-requested`,
    /** main → renderer: 下载状态更新 */
    downloadUpdate: `${CHANNEL_PREFIX}:download-update`
} as const;

export type ChannelName = (typeof Channels)[keyof typeof Channels];

// ---------------------------------------------------------------------------
// Shared Types
// ---------------------------------------------------------------------------

export interface BrowserState {
    currentUrl: string;
    canGoBack: boolean;
    canGoForward: boolean;
}

export interface TabInfo {
    id: number;
    title: string;
    url: string;
    active: boolean;
}

export interface PageSnapshot {
    url: string;
    title: string;
    viewport: { width: number; height: number };
    scroll: { x: number; y: number };
    ariaSnapshot: string;
}

// ---------------------------------------------------------------------------
// IPC Response Envelope
// ---------------------------------------------------------------------------

export interface IPCResponse<T = unknown> {
    status: 'ok' | 'error';
    data?: T;
    message?: string;
}

// ---------------------------------------------------------------------------
// Bridge API — the shape exposed on `window[apiName]` by defineBrowserBridge
// ---------------------------------------------------------------------------

export interface BrowserBridgeAPI {
    navigate(instanceId: string, url: string): Promise<unknown>;
    getState(instanceId: string): Promise<BrowserState>;
    executeScript(instanceId: string, script: string): Promise<unknown>;
    goBack(instanceId: string): Promise<unknown>;
    goForward(instanceId: string): Promise<unknown>;
    refresh(instanceId: string): Promise<unknown>;
    captureScreenshot(webContentsId: number): Promise<string | null>;
    listTabs(instanceId: string): Promise<TabInfo[]>;
    addTab(instanceId: string, url: string): Promise<number>;
    closeTab(instanceId: string, tabId: number): Promise<void>;
    switchTab(instanceId: string, tabId: number): Promise<void>;
    getWebContentsId(instanceId: string): Promise<number | null>;
    focusActiveWebview(instanceId: string): Promise<boolean>;
    openDevTools(webContentsId: number): Promise<unknown>;
    exportSnapshot(webContentsId: number): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Instance Callbacks — used by BrowserInstance.register()
// ---------------------------------------------------------------------------

export interface BrowserInstanceCallbacks {
    navigateTo(url: string): void;
    getState(): BrowserState;
    executeJavaScript(script: string): Promise<unknown>;
    goBack(): void;
    goForward(): void;
    refresh(): void;
    capturePage(): Promise<string | null>;
    listTabs(): TabInfo[];
    addTab(url: string): number;
    closeTab(tabId: number): void;
    switchToTab(tabId: number): void;
    getWebContentsId(): number | null;
    focusActiveWebview?(): boolean;
}
