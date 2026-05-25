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

import type { WebviewTag } from 'electron';
import { BrowserInstance } from '../common/embedBrowserUse/renderer';
import type { BrowserState, TabInfo } from '../common/embedBrowserUse/protocol';
import { getErrorMessage, buildErrorPageScript, type ErrorInfo } from '../common/browserErrors';
import { WINDOW_OPEN_PROXY_SCRIPT, OPENER_BRIDGE_SCRIPT, NOTIFY_POPUP_CLOSED_SCRIPT } from './webviewScripts';

export type { BrowserState, TabInfo };

const HOME_PAGE = 'about:blank';

let nextTabId = 1;

interface BrowserTab {
    id: number;
    title: string;
    url: string;
    webview: WebviewTag | null;
    wrapEl: HTMLElement | null;
    ready: boolean;
    pendingUrl: string | null;
    errorInfo?: ErrorInfo;
    /** 若此 tab 由弹窗产生，记录打开它的父 tab ID */
    openerTabId?: number;
}

/**
 * Browser tab component for OpenDesk.
 * Supports multiple tabs within a single browser panel.
 * All tabs share a persistent partition for cookies/sessions.
 *
 * Extends BrowserInstance from embedBrowserUse so it can be registered
 * with the preload bridge and controlled from the main process.
 */
export class EmbeddedBrowser extends BrowserInstance {
    private container: HTMLElement | null = null;
    private urlInput: HTMLInputElement | null = null;
    private tabBarInner: HTMLElement | null = null;
    private webviewContainer: HTMLElement | null = null;
    private _isFullscreen: boolean = false;

    private tabs: BrowserTab[] = [];
    private activeTabId: number = -1;
    private _currentZoomFactor: number = 1;
    private _removeZoomListener: (() => void) | null = null;
    private _resizeObserver: ResizeObserver | null = null;
    private static readonly VIRTUAL_WIDTH = 1280;
    private static readonly VIRTUAL_HEIGHT = 800;

    /**
     * Resize burst detection — during active window resize we skip ALL
     * DOM work and only apply scaling once after resize has settled.
     * This eliminates the per-frame compositing cost entirely.
     */
    private _pendingResize: { width: number; height: number } | null = null;
    private _resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(container: HTMLElement, id: string = '') {
        super(id);
        this.container = container;
        this._initZoomSync();
        this.init();
    }

    private _initZoomSync(): void {
        const displayAPI = (window as any).displayAPI;
        if (!displayAPI) return;

        displayAPI
            .getScaleFactor()
            .then((factor: number) => {
                this._currentZoomFactor = factor;
            })
            .catch(() => {});

        if (typeof displayAPI.onScaleFactorChanged === 'function') {
            this._removeZoomListener = displayAPI.onScaleFactorChanged((factor: number) => {
                this._currentZoomFactor = factor;
                this._applyZoomToAllWebviews(factor);
            });
        }
    }

    private _applyZoomToAllWebviews(factor: number): void {
        for (const tab of this.tabs) {
            if (tab.ready && tab.webview) {
                try {
                    tab.webview.setZoomFactor(factor);
                } catch {
                    /* not ready */
                }
            }
        }
    }

    private init(): void {
        if (!this.container) return;

        this.container.innerHTML = `
        <style>
            .bw {
                width: 100%; height: 100%;
                display: flex; flex-direction: column;
                background: #fafafa;
                overflow: hidden;
            }

            /* ---- Tab bar ---- */
            .bw-tabbar {
                display: flex; align-items: center;
                background: #f3f4f6;
                border-bottom: 1px solid #e5e7eb;
                flex-shrink: 0;
                min-height: 30px;
                padding: 0;
                gap: 0;
            }
            .bw-tab-add-btn {
                width: 26px; height: 26px;
                border: none; background: #e5e7eb;
                color: #6b7280; cursor: pointer;
                display: flex; align-items: center; justify-content: center;
                flex-shrink: 0;
                border-radius: 6px 6px 0 0;
                margin: 2px 2px 0 1px;
                font-size: 12px;
                transition: all 0.15s;
                order: 9999;
                align-self: flex-end;
            }
            .bw-tab-add-btn:hover { background: #d1d5db; color: #374151; }
            .bw-tab-add-btn:active { background: #c1c5cb; }
            .bw-tabbar-inner {
                display: flex; align-items: center;
                flex: 1; min-width: 0;
                overflow-x: auto;
                overflow-y: hidden;
                scrollbar-width: none;
                gap: 1px;
                padding: 2px 2px 0 0;
            }
            .bw-tabbar-inner::-webkit-scrollbar { display: none; }
            .bw-tab-item {
                display: flex; align-items: center;
                gap: 4px;
                height: 26px;
                padding: 0 6px 0 10px;
                font-size: 11px;
                color: #6b7280;
                background: transparent;
                border: none;
                border-radius: 6px 6px 0 0;
                cursor: pointer;
                white-space: nowrap;
                max-width: 150px;
                min-width: 0;
                flex-shrink: 0;
                transition: all 0.15s;
                position: relative;
            }
            .bw-tab-item:hover { background: #e9eaed; color: #374151; }
            .bw-tab-item.bw-tab-active {
                background: white;
                color: #1f2937;
                font-weight: 500;
                box-shadow: 0 -1px 0 0 #e5e7eb, -1px 0 0 0 #e5e7eb, 1px 0 0 0 #e5e7eb;
            }
            .bw-tab-title {
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                pointer-events: none;
                flex: 1; min-width: 0;
            }
            .bw-tab-close {
                width: 16px; height: 16px;
                border: none; background: transparent;
                color: #9ca3af; cursor: pointer;
                display: flex; align-items: center; justify-content: center;
                border-radius: 3px;
                font-size: 9px;
                flex-shrink: 0;
                opacity: 0;
                transition: all 0.15s;
                padding: 0;
            }
            .bw-tab-item:hover .bw-tab-close,
            .bw-tab-item.bw-tab-active .bw-tab-close { opacity: 1; }
            .bw-tab-close:hover { background: #ddd; color: #374151; }

            /* ---- Toolbar ---- */
            .bw-toolbar {
                display: flex; align-items: center; gap: 3px;
                padding: 4px 6px;
                background: white;
                border-bottom: 1px solid #e5e7eb;
                flex-shrink: 0;
            }
            .bw-btn {
                width: 24px; height: 24px;
                border-radius: 5px; border: none;
                background: transparent;
                cursor: pointer;
                display: flex; align-items: center; justify-content: center;
                transition: all 0.15s; color: #6b7280;
                font-size: 11px; flex-shrink: 0;
            }
            .bw-btn:hover { background: #f3f4f6; color: #374151; }
            .bw-btn:active { background: #e5e7eb; }
            .bw-btn.disabled { opacity: 0.35; cursor: default; pointer-events: none; }
            .bw-url-wrap {
                flex: 1; min-width: 0;
                display: flex; align-items: center;
                background: #f9fafb;
                border: 1px solid #e5e7eb;
                border-radius: 6px;
                padding: 2px 8px; gap: 4px;
                transition: border-color 0.15s, box-shadow 0.15s;
            }
            .bw-url-wrap:focus-within {
                border-color: #93c5fd;
                box-shadow: 0 0 0 2px rgba(59,130,246,0.12);
            }
            .bw-lock { color: #10b981; flex-shrink: 0; font-size: 10px; }
            .bw-url-input {
                flex: 1; min-width: 0;
                border: none; background: transparent; outline: none;
                font-size: 11px; color: #1f2937;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                line-height: 1.4;
            }
            .bw-url-input::placeholder { color: #9ca3af; }

            /* ---- Debug menu (tool menu) ---- */
            .bw-toolbar-right {
                position: relative; display: flex; align-items: center;
            }
            .bw-tool-menu {
                display: none;
                position: absolute;
                top: 100%; right: 0;
                width: 200px;
                background: white;
                border: 1px solid #e5e7eb;
                border-radius: 8px;
                box-shadow: 0 8px 24px rgba(0,0,0,0.12);
                z-index: 200;
                padding: 4px 0;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            }
            .bw-tool-menu.bw-visible { display: block; }
            .bw-tm-item {
                display: flex; align-items: center; gap: 10px;
                padding: 7px 14px;
                font-size: 12px; color: #374151;
                cursor: pointer;
                transition: background 0.1s;
            }
            .bw-tm-item:hover { background: #f3f4f6; }
            .bw-tm-item i { width: 14px; text-align: center; color: #6b7280; font-size: 12px; }
            .bw-tm-label { flex: 1; }

            /* ---- Webview area ---- */
            .bw-webview-container {
                flex: 1; overflow: hidden;
                background: #f0f0f0; position: relative;
                box-shadow: inset 0 2px 6px rgba(0,0,0,0.08);
            }
            .bw-webview-wrap {
                width: 1280px;
                height: 800px;
                position: absolute; top: 0; left: 0;
                transform-origin: top left;
                display: none;
            }
            .bw-webview-wrap.bw-wv-active { display: block; }
            .bw-webview {
                width: 100%; height: 100%; border: none;
            }
            .bw-sep {
                width: 1px; height: 14px;
                background: #e5e7eb; margin: 0 1px; flex-shrink: 0;
            }
        </style>
        <div class="bw">
            <div class="bw-tabbar">
                <div class="bw-tabbar-inner">
                    <button class="bw-tab-add-btn" title="新建标签页"><i class="fas fa-plus"></i></button>
                </div>
            </div>
            <div class="bw-toolbar">
                <button class="bw-btn bw-back-btn" title="后退"><i class="fas fa-chevron-left"></i></button>
                <button class="bw-btn bw-forward-btn" title="前进"><i class="fas fa-chevron-right"></i></button>
                <button class="bw-btn bw-refresh-btn" title="刷新"><i class="fas fa-rotate-right"></i></button>
                <div class="bw-sep"></div>
                <div class="bw-url-wrap">
                    <i class="fas fa-lock bw-lock"></i>
                    <input type="text" class="bw-url-input" placeholder="输入网址或搜索…" value="">
                </div>
                <div class="bw-sep"></div>
                <div class="bw-toolbar-right">
                    <button class="bw-btn bw-menu-btn" title="调试"><i class="fas fa-ellipsis"></i></button>
                    <div class="bw-tool-menu"></div>
                </div>
                <button class="bw-btn bw-fullscreen-btn" title="全屏"><i class="fas fa-expand"></i></button>
            </div>
            <div class="bw-webview-container"></div>
        </div>`;

        this.urlInput = this.container.querySelector('.bw-url-input') as HTMLInputElement;
        this.tabBarInner = this.container.querySelector('.bw-tabbar-inner') as HTMLElement;
        this.webviewContainer = this.container.querySelector('.bw-webview-container') as HTMLElement;

        this.bindToolbarEvents();
        this.bindTabBarEvents();
        this._initViewportScaling();

        this.addTab(HOME_PAGE);
    }

    /**
     * 使用 ResizeObserver 监听 webview 容器尺寸变化，
     * 将所有 webview wrap 缩放到容器宽度，同时保持内部虚拟视口为 1280px。
     */
    private _initViewportScaling(): void {
        if (!this.webviewContainer) return;

        this._disposeViewportScaling();

        this._resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const { width, height } = entry.contentRect;
                // Only record the latest size — zero DOM work during active resize
                this._pendingResize = { width, height };

                if (this._resizeDebounceTimer !== null) {
                    clearTimeout(this._resizeDebounceTimer);
                }

                // Apply scaling only after resize has completely stopped
                this._resizeDebounceTimer = setTimeout(() => {
                    if (this._pendingResize) {
                        this._applyViewportScaling(this._pendingResize.width, this._pendingResize.height);
                        this._pendingResize = null;
                    }
                    this._resizeDebounceTimer = null;
                }, 80);
            }
        });
        this._resizeObserver.observe(this.webviewContainer);
    }

    /**
     * Clean up the ResizeObserver and any pending debounce timers.
     */
    private _disposeViewportScaling(): void {
        if (this._resizeObserver) {
            this._resizeObserver.disconnect();
            this._resizeObserver = null;
        }
        if (this._resizeDebounceTimer !== null) {
            clearTimeout(this._resizeDebounceTimer);
            this._resizeDebounceTimer = null;
        }
        this._pendingResize = null;
    }

    private _applyViewportScaling(containerW: number, containerH: number): void {
        if (!this.webviewContainer || containerW <= 0 || containerH <= 0) return;
        const scaleX = containerW / EmbeddedBrowser.VIRTUAL_WIDTH;
        const scaleY = containerH / EmbeddedBrowser.VIRTUAL_HEIGHT;
        const scale = Math.min(scaleX, scaleY);
        const offsetX = (containerW - EmbeddedBrowser.VIRTUAL_WIDTH * scale) / 2;
        const wraps = this.webviewContainer.querySelectorAll<HTMLElement>('.bw-webview-wrap');
        for (const wrap of wraps) {
            wrap.style.transform = `translate(${offsetX}px, 0px) scale(${scale})`;
            wrap.style.height = `${EmbeddedBrowser.VIRTUAL_HEIGHT}px`;
        }
    }

    // ==== Tab bar events ====

    private bindTabBarEvents(): void {
        if (!this.container) return;

        const addBtn = this.container.querySelector('.bw-tab-add-btn') as HTMLButtonElement;
        addBtn.addEventListener('click', () => this.addTab(HOME_PAGE));

        const tabBarInner = this.tabBarInner;
        if (tabBarInner) {
            tabBarInner.addEventListener(
                'wheel',
                (e: WheelEvent) => {
                    e.preventDefault();
                    tabBarInner.scrollLeft += e.deltaY !== 0 ? e.deltaY : e.deltaX;
                },
                { passive: false }
            );
        }
    }

    // ==== Toolbar events ====

    private bindToolbarEvents(): void {
        if (!this.container || !this.urlInput) return;

        const backBtn = this.container.querySelector('.bw-back-btn') as HTMLButtonElement;
        const forwardBtn = this.container.querySelector('.bw-forward-btn') as HTMLButtonElement;
        const refreshBtn = this.container.querySelector('.bw-refresh-btn') as HTMLButtonElement;
        const fullscreenBtn = this.container.querySelector('.bw-fullscreen-btn') as HTMLButtonElement;
        const menuBtn = this.container.querySelector('.bw-menu-btn') as HTMLButtonElement;
        const toolMenu = this.container.querySelector('.bw-tool-menu') as HTMLElement;

        backBtn.addEventListener('click', () => this.goBack());
        forwardBtn.addEventListener('click', () => this.goForward());
        refreshBtn.addEventListener('click', () => this.refresh());
        fullscreenBtn.addEventListener('click', () => this.toggleFullscreen());

        menuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleToolMenu(toolMenu);
        });

        document.addEventListener('click', (e) => {
            if (!toolMenu.contains(e.target as Node) && !menuBtn.contains(e.target as Node)) {
                toolMenu.classList.remove('bw-visible');
            }
        });

        this.urlInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && !e.isComposing) {
                this.navigateTo(this.urlInput?.value || '');
            }
        });

        this.urlInput.addEventListener('focus', () => {
            this.urlInput?.select();
        });
    }

    private toggleToolMenu(toolMenu: HTMLElement): void {
        if (toolMenu.classList.contains('bw-visible')) {
            toolMenu.classList.remove('bw-visible');
            return;
        }

        toolMenu.innerHTML = `
            <div class="bw-tm-item" data-action="consoleDebug">
                <i class="fas fa-terminal"></i>
                <span class="bw-tm-label">Console</span>
            </div>
            <div class="bw-tm-item" data-action="snapshotDebug">
                <i class="fas fa-sitemap"></i>
                <span class="bw-tm-label">Snapshot</span>
            </div>
        `;

        toolMenu.querySelectorAll('[data-action]').forEach((el) => {
            el.addEventListener('click', () => {
                const action = (el as HTMLElement).dataset.action;
                toolMenu.classList.remove('bw-visible');
                this.handleDebugAction(action!);
            });
        });

        toolMenu.classList.add('bw-visible');
    }

    private handleDebugAction(action: string): void {
        switch (action) {
            case 'consoleDebug':
                void this.openWebviewDevTools();
                break;
            case 'snapshotDebug':
                void this.captureAndSaveSnapshot();
                break;
        }
    }

    private async openWebviewDevTools(): Promise<void> {
        const tab = this.getActiveTab();
        if (!tab?.ready || !tab.webview) return;

        try {
            const wcId = (tab.webview as any).getWebContentsId();
            const browserAPI = (window as any).browserAPI;
            if (browserAPI && typeof browserAPI.openDevTools === 'function') {
                await browserAPI.openDevTools(wcId);
                return;
            }
        } catch {
            /* fallback below */
        }

        try {
            (tab.webview as any).openDevTools();
        } catch {
            /* not available */
        }
    }

    private async captureAndSaveSnapshot(): Promise<void> {
        const tab = this.getActiveTab();
        if (!tab?.ready || !tab.webview) return;

        let webContentsId: number;
        try {
            webContentsId = (tab.webview as any).getWebContentsId();
        } catch {
            return;
        }

        const browserAPI = (window as any).browserAPI;
        if (browserAPI && typeof browserAPI.exportSnapshot === 'function') {
            try {
                await browserAPI.exportSnapshot(webContentsId);
            } catch {
                /* ignore */
            }
        }
    }

    // ==== Tab management ====

    public addTab(url: string = HOME_PAGE, openerTabId?: number): number {
        const tabId = nextTabId++;
        const wrapEl = document.createElement('div');
        wrapEl.className = 'bw-webview-wrap';
        wrapEl.dataset.tabId = String(tabId);

        const wv = document.createElement('webview') as unknown as WebviewTag;
        wv.className = 'bw-webview';
        wv.setAttribute('src', url);
        wv.setAttribute('allowpopups', '');
        wv.setAttribute('partition', 'persist:opendesk-browser');
        wv.setAttribute('webpreferences', 'nodeIntegration=no');
        wrapEl.appendChild(wv as unknown as Node);
        this.webviewContainer?.appendChild(wrapEl);

        // 对新 tab 应用当前容器的缩放比例（水平居中，垂直向上对齐）
        if (this.webviewContainer) {
            const cw = this.webviewContainer.clientWidth;
            const ch = this.webviewContainer.clientHeight;
            if (cw > 0 && ch > 0) {
                const scaleX = cw / EmbeddedBrowser.VIRTUAL_WIDTH;
                const scaleY = ch / EmbeddedBrowser.VIRTUAL_HEIGHT;
                const s = Math.min(scaleX, scaleY);
                const offsetX = (cw - EmbeddedBrowser.VIRTUAL_WIDTH * s) / 2;
                wrapEl.style.transform = `translate(${offsetX}px, 0px) scale(${s})`;
                wrapEl.style.height = `${EmbeddedBrowser.VIRTUAL_HEIGHT}px`;
            }
        }

        const tab: BrowserTab = {
            id: tabId,
            title: this.extractTitle(url),
            url,
            webview: wv,
            wrapEl,
            ready: false,
            pendingUrl: null,
            openerTabId
        };
        this.tabs.push(tab);

        this.setupWebviewForTab(tab);
        this.renderTabBar();
        this.switchToTab(tabId);

        return tabId;
    }

    public closeTab(tabId: number): void {
        const idx = this.tabs.findIndex((t) => t.id === tabId);
        if (idx === -1) return;

        const tab = this.tabs[idx];

        // 通知 opener tab：弹窗已关闭（更新 proxy.closed 并触发事件）
        if (tab.openerTabId != null) {
            this.notifyOpenerPopupClosed(tab.openerTabId, tab.url);
        }

        if (this.tabs.length === 1) {
            const onlyTab = this.tabs[0];
            onlyTab.openerTabId = undefined;
            try {
                (onlyTab.webview as any)?.closeDevTools?.();
            } catch {
                /* ignore */
            }
            if (onlyTab.ready && onlyTab.webview) {
                try {
                    onlyTab.webview.loadURL(HOME_PAGE);
                } catch {
                    /* not ready */
                }
            } else if (onlyTab.webview) {
                onlyTab.webview.setAttribute('src', HOME_PAGE);
            }
            onlyTab.url = HOME_PAGE;
            onlyTab.title = '新标签页';
            this.renderTabBar();
            this.syncUrlBar();
            return;
        }

        try {
            (tab.webview as any)?.closeDevTools?.();
        } catch {
            /* ignore */
        }
        tab.wrapEl?.remove();
        this.tabs.splice(idx, 1);

        if (this.activeTabId === tabId) {
            const newIdx = Math.min(idx, this.tabs.length - 1);
            this.switchToTab(this.tabs[newIdx].id);
        }
        this.renderTabBar();
    }

    public switchToTab(tabId: number): void {
        const tab = this.tabs.find((t) => t.id === tabId);
        if (!tab) return;

        this.activeTabId = tabId;

        for (const t of this.tabs) {
            t.wrapEl?.classList.toggle('bw-wv-active', t.id === tabId);
        }

        this.syncUrlBar();
        this.syncNavButtons();
        this.renderTabBar();
    }

    public listTabs(): TabInfo[] {
        return this.tabs.map((t) => ({
            id: t.id,
            title: t.title,
            url: t.url,
            active: t.id === this.activeTabId
        }));
    }

    private getActiveTab(): BrowserTab | undefined {
        return this.tabs.find((t) => t.id === this.activeTabId);
    }

    private getActiveWebview(): WebviewTag | null {
        return this.getActiveTab()?.webview ?? null;
    }

    // ==== Tab bar rendering ====

    private renderTabBar(): void {
        if (!this.tabBarInner) return;

        // 保存添加按钮的引用
        const addBtn = this.tabBarInner.querySelector('.bw-tab-add-btn');

        this.tabBarInner.innerHTML = '';
        for (const tab of this.tabs) {
            const el = document.createElement('div');
            el.className = 'bw-tab-item' + (tab.id === this.activeTabId ? ' bw-tab-active' : '');
            el.dataset.tabId = String(tab.id);

            const titleSpan = document.createElement('span');
            titleSpan.className = 'bw-tab-title';
            titleSpan.textContent = tab.title || '新标签页';
            titleSpan.title = tab.url;
            el.appendChild(titleSpan);

            const closeBtn = document.createElement('button');
            closeBtn.className = 'bw-tab-close';
            closeBtn.innerHTML = '<i class="fas fa-xmark"></i>';
            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.closeTab(tab.id);
            });
            el.appendChild(closeBtn);

            el.addEventListener('click', () => this.switchToTab(tab.id));
            this.tabBarInner!.appendChild(el);
        }

        // 重新添加添加按钮（如果存在）
        if (addBtn) {
            this.tabBarInner.appendChild(addBtn);
        }

        this.scrollActiveTabIntoView();
    }

    private scrollActiveTabIntoView(): void {
        if (!this.tabBarInner) return;
        const activeEl = this.tabBarInner.querySelector('.bw-tab-active') as HTMLElement;
        if (activeEl) {
            activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
        }
    }

    // ==== Webview setup per tab ====

    private setupWebviewForTab(tab: BrowserTab): void {
        const wv = tab.webview;
        if (!wv) return;

        wv.addEventListener('dom-ready', () => {
            tab.ready = true;
            this.syncNavButtons();
            if (this._currentZoomFactor !== 1) {
                try {
                    wv.setZoomFactor(this._currentZoomFactor);
                } catch {
                    /* ignore */
                }
            }
            if (tab.pendingUrl) {
                const url = tab.pendingUrl;
                tab.pendingUrl = null;
                try {
                    wv.loadURL(url);
                } catch {
                    wv.src = url;
                }
            }
            // 覆盖 guest 页面的 window.open，使其在弹窗被 Electron 拦截时
            // 返回一个模拟的 window 对象，让调用方认为弹窗正常打开。
            this.injectWindowOpenProxy(wv);
            // 若此 tab 是由弹窗产生的，注入 window.opener 桥接
            this.injectOpenerBridge(tab);
        });

        // 当 guest 页面调用 window.close()（如 OAuth 授权完成后自动关闭弹窗），
        // Electron webview 会触发 close 事件，此时自动关闭对应 tab。
        wv.addEventListener('close', () => {
            this.closeTab(tab.id);
        });

        // 拦截 window.open / target="_blank" 等打开新窗口的行为，
        // 改为在当前浏览器面板中开新标签页，
        // 避免 PiP 模式下弹出独立窗口导致用户体验割裂。
        const onPopupBlocked = (event: Event) => {
            const detail = (event as CustomEvent).detail;
            if (!detail || !detail.url) return;
            const wcId = detail.webContentsId;
            // 确认是本 tab 的 webview 发起的弹窗
            // 注意：不能检查 tab.ready，因为同步 <script> 中的
            // window.open 可能在 dom-ready 之前触发，此时 tab.ready 仍为 false
            if (tab.webview) {
                try {
                    const myId = (tab.webview as any).getWebContentsId();
                    if (myId === wcId) {
                        this.addTab(detail.url, tab.id);
                    }
                } catch {
                    /* ignore */
                }
            }
        };
        window.addEventListener('browser-popup-blocked', onPopupBlocked);

        // 备用机制：main process 检测到 webview guest 调用 window.close() 后
        // 通过 IPC 通知 renderer 关闭 tab（兜底 webview close 事件未触发的情况）
        const onWebviewCloseRequested = (event: Event) => {
            const detail = (event as CustomEvent).detail;
            if (!detail) return;
            const wcId = detail.webContentsId;
            if (tab.ready && tab.webview) {
                try {
                    const myId = (tab.webview as any).getWebContentsId();
                    if (myId === wcId) {
                        this.closeTab(tab.id);
                    }
                } catch {
                    /* ignore */
                }
            }
        };
        window.addEventListener('browser-webview-close-requested', onWebviewCloseRequested);

        wv.addEventListener('did-navigate', (event: any) => {
            // 成功导航时清除错误状态
            if (tab.errorInfo) {
                tab.errorInfo = undefined;
            }
            tab.url = event.url;
            this.updateTabTitle(tab);
            if (tab.id === this.activeTabId) this.syncUrlBar();
            if (tab.ready) this.syncNavButtons();
            // 新页面加载后重新注入 window.open proxy 和 opener 桥接
            this.injectWindowOpenProxy(wv);
            this.injectOpenerBridge(tab);
        });

        wv.addEventListener('did-navigate-in-page', (event: any) => {
            tab.url = event.url;
            if (tab.id === this.activeTabId) this.syncUrlBar();
            if (tab.ready) this.syncNavButtons();
        });

        wv.addEventListener('page-title-updated', (event: any) => {
            tab.title = event.title || this.extractTitle(tab.url);
            this.renderTabBar();
        });

        wv.addEventListener('did-finish-load', () => {
            if (tab.errorInfo) {
                tab.errorInfo = undefined;
            }
            if (tab.ready) this.syncNavButtons();
            // 页面完全加载后再次注入，确保 SSO 重定向后的页面也被覆盖
            this.injectWindowOpenProxy(wv);
            this.injectOpenerBridge(tab);
        });

        // 监听弹窗 tab 中通过 console.log 转发的信号：
        // - opener.postMessage → 分发到父 tab
        // - window.close() → 关闭当前 tab
        // - opener.location.reload → 刷新父 tab
        wv.addEventListener('console-message', (event: any) => {
            if (tab.openerTabId == null) return;
            const msg: string = event.message;
            if (!msg) return;
            if (msg === '__openDesk_window_close__') {
                this.closeTab(tab.id);
                return;
            }
            if (msg === '__openDesk_opener_reload__') {
                const openerTab = this.tabs.find((t) => t.id === tab.openerTabId);
                if (openerTab?.webview && openerTab.ready) {
                    try {
                        openerTab.webview.reload();
                    } catch {
                        /* ignore */
                    }
                }
                return;
            }
            if (msg.startsWith('__openDesk_opener_postMessage__:')) {
                try {
                    const payload = JSON.parse(msg.slice('__openDesk_opener_postMessage__:'.length));
                    this.deliverOpenerMessage(tab.openerTabId, payload.data, payload.origin);
                } catch {
                    /* ignore parse errors */
                }
            }
        });

        // 监听父 tab 中 proxy.focus() / proxy.close() 的信号，
        // 切换到对应的 popup tab 或关闭它
        wv.addEventListener('console-message', (event: any) => {
            const msg: string = event.message;
            if (!msg) return;
            if (msg.startsWith('__openDesk_popup_focus__:')) {
                // 找到由本 tab 打开的最新 popup tab 并切换过去
                const childTab = this.tabs.find((t) => t.openerTabId === tab.id);
                if (childTab) {
                    this.switchToTab(childTab.id);
                }
                return;
            }
            if (msg.startsWith('__openDesk_popup_close__:')) {
                const childTab = this.tabs.find((t) => t.openerTabId === tab.id);
                if (childTab) {
                    this.closeTab(childTab.id);
                }
            }
        });

        wv.addEventListener('did-fail-load', (event: any) => {
            const { errorCode, errorDescription, validatedURL, isMainFrame } = event;
            // 忽略子资源加载失败和非真正的错误
            if (!isMainFrame) return;
            if (errorCode === -3) return; // ERR_ABORTED：用户主动导航中断

            const userMessage = getErrorMessage(errorDescription);
            tab.errorInfo = {
                code: errorCode,
                description: errorDescription,
                url: validatedURL || tab.url,
                userMessage
            };

            // 更新 tab 标题显示错误
            tab.title = this.extractTitle(validatedURL || tab.url) + ' - 加载失败';
            this.renderTabBar();

            // 将自定义错误页面注入 webview 内部，CDP snapshot 可直接读取
            this.injectErrorPage(tab);

            // 同步地址栏显示失败的 URL
            if (tab.id === this.activeTabId) this.syncUrlBar();
        });
    }

    /**
     * 在 webview guest 中覆盖 window.open，使 Electron deny 弹窗时
     * 仍返回一个模拟 window 对象（而非 null），让页面逻辑正常运行。
     * proxy.closed 会在弹窗 tab 关闭时被外部通过 notifyOpenerPopupClosed 更新。
     */
    private injectWindowOpenProxy(wv: WebviewTag): void {
        wv.executeJavaScript(WINDOW_OPEN_PROXY_SCRIPT).catch(() => {
            /* ignore */
        });
    }

    /**
     * 在弹窗 tab 中注入 window.opener 桥接和 window.close() 覆盖，
     * 使得 SSO 页面可以通过 window.opener.postMessage() 向父 tab 发送消息，
     * 并且 window.close() 能正常关闭 tab（绕过 Chromium 对非 script-opened 窗口的限制）。
     */
    private injectOpenerBridge(tab: BrowserTab): void {
        const wv = tab.webview;
        if (!wv || tab.openerTabId == null) return;
        wv.executeJavaScript(OPENER_BRIDGE_SCRIPT).catch(() => {
            /* ignore */
        });
    }

    /**
     * 当弹窗 tab 关闭时，通知 opener tab 更新 proxy.closed 并分发事件
     */
    private notifyOpenerPopupClosed(openerTabId: number, _popupUrl: string): void {
        const openerTab = this.tabs.find((t) => t.id === openerTabId);
        if (!openerTab || !openerTab.webview || !openerTab.ready) return;
        openerTab.webview.executeJavaScript(NOTIFY_POPUP_CLOSED_SCRIPT).catch(() => {
            /* ignore */
        });
    }

    /**
     * 将弹窗 tab 中 window.opener.postMessage 的内容
     * 作为 MessageEvent 分发到 opener tab 的 window
     */
    private deliverOpenerMessage(openerTabId: number, data: unknown, origin: string): void {
        const openerTab = this.tabs.find((t) => t.id === openerTabId);
        if (!openerTab || !openerTab.webview || !openerTab.ready) return;
        const safeData = JSON.stringify(data);
        const safeOrigin = JSON.stringify(origin || '');
        const script = `(function() {
            window.dispatchEvent(new MessageEvent('message', {
                data: ${safeData},
                origin: ${safeOrigin},
                source: null
            }));
        })()`;
        openerTab.webview.executeJavaScript(script).catch(() => {
            /* ignore */
        });
    }

    private updateTabTitle(tab: BrowserTab): void {
        try {
            tab.webview
                ?.executeJavaScript('document.title')
                .then((title: string) => {
                    if (title) {
                        tab.title = title;
                        this.renderTabBar();
                    }
                })
                .catch(() => {
                    /* ignore */
                });
        } catch {
            /* ignore */
        }
    }

    private extractTitle(url: string): string {
        if (!url || url === 'about:blank') return '新标签页';
        try {
            const u = new URL(url);
            return u.hostname || url;
        } catch {
            return url.slice(0, 30);
        }
    }

    // ==== Sync helpers ====

    private syncUrlBar(): void {
        const tab = this.getActiveTab();
        if (this.urlInput && tab) {
            this.urlInput.value = tab.url || '';
        }
    }

    private syncNavButtons(): void {
        if (!this.container) return;
        const tab = this.getActiveTab();
        let canBack = false;
        let canForward = false;
        if (tab?.ready && tab.webview) {
            try {
                canBack = tab.webview.canGoBack();
                canForward = tab.webview.canGoForward();
            } catch {
                /* webview not yet attached */
            }
        }

        const backBtn = this.container.querySelector('.bw-back-btn') as HTMLButtonElement;
        const forwardBtn = this.container.querySelector('.bw-forward-btn') as HTMLButtonElement;
        if (backBtn) backBtn.classList.toggle('disabled', !canBack);
        if (forwardBtn) forwardBtn.classList.toggle('disabled', !canForward);
    }

    // ==== Error page injection ====

    /**
     * 将自定义错误页面注入 webview 内部。
     * 通过 executeJavaScript 替换 chrome-error:// 页面的 DOM 内容，
     * URL 保持 chrome-error:// 不变，embedBrowserUse 的 readPageInfo() 可直接读取错误信息。
     * 错误页面使用 Chromium 标准的 #main-message 和 .error-code 元素，
     * 使得 embedBrowserUse 无需任何修改即可兼容。
     */
    private injectErrorPage(tab: BrowserTab): void {
        if (!tab.webview || !tab.errorInfo) return;
        const script = buildErrorPageScript(tab.errorInfo);
        try {
            tab.webview.executeJavaScript(script);
        } catch {
            /* webview not ready */
        }
    }

    // ==== Public API (called by user UI AND by agent tools via IPC) ====

    public navigateTo(url: string): void {
        const tab = this.getActiveTab();
        if (!tab || !tab.webview) return;
        const targetUrl = this.normalizeUrl(url.trim());
        if (!targetUrl) return;
        // 用户主动导航时清除错误状态
        if (tab.errorInfo) {
            tab.errorInfo = undefined;
        }
        if (tab.ready) {
            try {
                tab.webview.loadURL(targetUrl);
            } catch {
                tab.webview.src = targetUrl;
            }
        } else {
            tab.pendingUrl = targetUrl;
        }
        tab.url = targetUrl;
        this.syncUrlBar();
    }

    /**
     * Normalize user input into a valid URL.
     * - empty / whitespace-only → null (skip navigation)
     * - already has scheme (http/https/about/file/data) → keep as-is
     * - looks like a domain (contains dot, no spaces) → prepend https://
     * - otherwise → treat as search query (not implemented, just prepend https://)
     */
    private normalizeUrl(raw: string): string | null {
        if (!raw) return null;
        if (/^(https?|about|file|data):/.test(raw)) return raw;
        if (/^[^\s]+\.[^\s]+/.test(raw)) return `https://${raw}`;
        return `https://${raw}`;
    }

    public goBack(): void {
        const tab = this.getActiveTab();
        if (tab?.ready && tab.webview) {
            try {
                if (tab.webview.canGoBack()) tab.webview.goBack();
            } catch {
                /* not ready */
            }
        }
    }

    public goForward(): void {
        const tab = this.getActiveTab();
        if (tab?.ready && tab.webview) {
            try {
                if (tab.webview.canGoForward()) tab.webview.goForward();
            } catch {
                /* not ready */
            }
        }
    }

    public refresh(): void {
        const tab = this.getActiveTab();
        if (tab?.ready && tab.webview) {
            if (tab.errorInfo) {
                tab.errorInfo = undefined;
            }
            try {
                tab.webview.reload();
            } catch {
                /* not ready */
            }
        }
    }

    public goHome(): void {
        this.navigateTo(HOME_PAGE);
    }

    public toggleFullscreen(): void {
        this._isFullscreen = !this._isFullscreen;
        const event = new CustomEvent('browser-fullscreen-toggle', {
            detail: { isFullscreen: this._isFullscreen }
        });
        this.container?.dispatchEvent(event);
    }

    public getCurrentUrl(): string {
        return this.getActiveTab()?.url ?? '';
    }

    public getState(): BrowserState {
        const tab = this.getActiveTab();
        let canBack = false;
        let canForward = false;
        if (tab?.ready && tab.webview) {
            try {
                canBack = tab.webview.canGoBack();
                canForward = tab.webview.canGoForward();
            } catch {
                /* not ready */
            }
        }
        return {
            currentUrl: tab?.url ?? '',
            canGoBack: canBack,
            canGoForward: canForward,
            isFullscreen: this._isFullscreen
        };
    }

    public executeJavaScript(script: string): Promise<any> {
        const tab = this.getActiveTab();
        if (!tab?.webview) return Promise.reject('Webview not initialized');
        if (!tab.ready) return Promise.reject('Webview not ready yet');
        return tab.webview.executeJavaScript(script);
    }

    /**
     * Return the active tab's webview webContentsId.
     * Used by main process to attach CDP debugger to the guest webContents.
     */
    public getWebContentsId(): number | null {
        const tab = this.getActiveTab();
        if (!tab?.webview || !tab.ready) return null;
        try {
            return (tab.webview as any).getWebContentsId();
        } catch {
            return null;
        }
    }

    /**
     * Capture a screenshot of the active tab as a data URL (PNG).
     * Uses main-process IPC to capture via webContents.capturePage(),
     * which works even when the webview's parent element is display:none.
     */
    public async capturePage(): Promise<string | null> {
        const tab = this.getActiveTab();
        if (!tab?.webview || !tab.ready) return null;
        const currentUrl = tab.url || '';
        if (!currentUrl || currentUrl === 'about:blank') return null;
        try {
            const wcId = (tab.webview as any).getWebContentsId();
            if (wcId == null) return null;
            const browserAPI = (window as any).browserAPI;
            if (browserAPI && typeof browserAPI.captureScreenshot === 'function') {
                return await browserAPI.captureScreenshot(wcId);
            }
            return null;
        } catch {
            return null;
        }
    }

    public getTabCount(): number {
        return this.tabs.length;
    }

    public getActiveTabTitle(): string {
        const tab = this.getActiveTab();
        return tab?.title || '';
    }

    public getActiveTabUrl(): string {
        const tab = this.getActiveTab();
        return tab?.url || '';
    }

    public destroy(): void {
        this._disposeViewportScaling();
        if (this._removeZoomListener) {
            this._removeZoomListener();
            this._removeZoomListener = null;
        }
        for (const tab of this.tabs) {
            try {
                (tab.webview as any)?.closeDevTools?.();
            } catch {
                /* ignore */
            }
            tab.wrapEl?.remove();
            tab.webview = null;
            tab.wrapEl = null;
        }
        this.tabs = [];
        this.container = null;
        this.urlInput = null;
        this.tabBarInner = null;
        this.webviewContainer = null;
    }
}
