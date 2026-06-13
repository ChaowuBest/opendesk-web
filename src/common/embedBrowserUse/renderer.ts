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
 * embedBrowserUse — Renderer-side browser instance abstraction.
 *
 * BrowserInstance is the abstract base class that concrete browser
 * implementations (e.g. EmbeddedBrowser) extend. It defines the full
 * API surface for browser control and provides `register()` to hook
 * into the preload bridge so the main process can drive the instance.
 *
 * This file runs in the renderer process. It MUST NOT import Node.js APIs.
 */

import type { BrowserState, TabInfo, BrowserBridgeAPI, BrowserFocusOptions } from './protocol';

/**
 * Abstract base class for an embedded browser instance.
 *
 * Each instance has a unique `id` (typically a taskId) and exposes
 * methods for navigation, tab management, script execution, and state
 * retrieval. Concrete subclasses implement the actual webview handling.
 */
export abstract class BrowserInstance {
    public readonly id: string;

    constructor(id: string) {
        this.id = id;
    }

    // ---- Navigation ----

    abstract navigateTo(url: string): void;
    abstract goBack(): void;
    abstract goForward(): void;
    abstract refresh(): void;
    abstract goHome(): void;

    // ---- State ----

    abstract getState(): BrowserState;
    abstract getCurrentUrl(): string;

    // ---- Script Execution ----

    abstract executeJavaScript(script: string): Promise<unknown>;

    // ---- WebContents & Screenshot ----

    abstract getWebContentsId(): number | null;
    abstract capturePage(): Promise<string | null>;

    /**
     * Optional hook for adapters that can explicitly focus their active guest
     * webview before keyboard input. The default keeps older adapters working.
     */
    focusActiveWebview(_options?: BrowserFocusOptions): boolean {
        return false;
    }

    // ---- Tab Management ----

    abstract listTabs(): TabInfo[];
    abstract addTab(url?: string): number;
    abstract closeTab(tabId: number): void;
    abstract switchToTab(tabId: number): void;

    // ---- Lifecycle ----

    abstract destroy(): void;

    // ---- Bridge Registration ----

    /**
     * Register this instance with the preload bridge API so that
     * IPC calls from the main process are dispatched to this instance's
     * methods.
     *
     * The bridge API object is typically `window.browserAPI` created by
     * `defineBrowserBridge()` in the preload script.
     */
    register(bridgeAPI: BrowserBridgeAPI & { _registerInstance?: (id: string, inst: BrowserInstance) => void }): void {
        if (typeof bridgeAPI._registerInstance === 'function') {
            bridgeAPI._registerInstance(this.id, this);
        }
    }

    /**
     * Unregister this instance from the bridge API.
     */
    unregister(bridgeAPI: BrowserBridgeAPI & { _unregisterInstance?: (id: string) => void }): void {
        if (typeof bridgeAPI._unregisterInstance === 'function') {
            bridgeAPI._unregisterInstance(this.id);
        }
    }
}

export type { BrowserState, TabInfo, BrowserFocusOptions } from './protocol';
