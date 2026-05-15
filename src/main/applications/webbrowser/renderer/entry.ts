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

const SEARCH_ENGINE = 'https://www.bing.com/search?q=';

let nextTabId = 1;

interface BrowserTab {
    id: number;
    title: string;
    url: string;
    webview: WebviewTag | null;
    wrapEl: HTMLElement | null;
    ready: boolean;
    pendingUrl: string | null;
    isHomePage: boolean;
}

class WebBrowserEntryWidget extends HTMLElement {
    private urlInput: HTMLInputElement | null = null;
    private tabBarInner: HTMLElement | null = null;
    private webviewContainer: HTMLElement | null = null;
    private homePageContainer: HTMLElement | null = null;

    private tabs: BrowserTab[] = [];
    private activeTabId: number = -1;
    private _currentZoomFactor: number = 1;
    private _removeZoomListener: (() => void) | null = null;

    connectedCallback() {
        this.render();
        this.addTab();
    }

    disconnectedCallback() {
        if (this._removeZoomListener) {
            this._removeZoomListener();
            this._removeZoomListener = null;
        }
        for (const tab of this.tabs) {
            tab.wrapEl?.remove();
            tab.webview = null;
            tab.wrapEl = null;
        }
        this.tabs = [];
    }

    private render(): void {
        this.innerHTML = `
        <style>
            .wb {
                width: 100%; height: 100%;
                display: flex; flex-direction: column;
                background: #fafafa;
                overflow: hidden;
            }

            /* ---- Tab bar ---- */
            .wb-tabbar {
                display: flex; align-items: flex-end;
                background: #f5f5f5;
                border-bottom: 1px solid #e5e7eb;
                flex-shrink: 0;
                min-height: 36px;
                padding: 0;
                gap: 0;
            }
            .wb-tab-add-btn {
                width: 28px; height: 28px;
                border: none; background: transparent;
                color: #6b7280; cursor: pointer;
                display: flex; align-items: center; justify-content: center;
                flex-shrink: 0;
                border-radius: 5px;
                margin: 0 2px 4px 3px;
                font-size: 12px;
                transition: all 0.15s;
            }
            .wb-tab-add-btn:hover { background: #e5e7eb; color: #374151; }
            .wb-tab-add-btn:active { background: #d1d5db; }
            .wb-tabbar-inner {
                display: flex; align-items: flex-end;
                flex: 1; min-width: 0;
                overflow-x: auto;
                overflow-y: hidden;
                scrollbar-width: none;
                gap: 1px;
                padding: 0 2px 0 0;
            }
            .wb-tabbar-inner::-webkit-scrollbar { display: none; }
            /* 右侧留出空间避让窗口控制按钮（4 个按钮 × 40px = 160px + 余量） */
            .wb-tabbar-spacer {
                flex-shrink: 0;
                width: 168px;
            }
            .wb-tab-item {
                box-sizing: border-box;
                display: flex; align-items: center;
                gap: 4px;
                height: 32px;
                padding: 0 6px 0 10px;
                font-size: 12px;
                color: #6b7280;
                background: transparent;
                border: 1px solid transparent;
                border-bottom: none;
                border-radius: 8px 8px 0 0;
                cursor: pointer;
                white-space: nowrap;
                max-width: 200px;
                min-width: 0;
                flex-shrink: 0;
                transition: all 0.15s;
                position: relative;
                margin-bottom: -1px;
            }
            .wb-tab-item:hover { background: #e9eaed; color: #374151; }
            .wb-tab-item.wb-tab-active {
                background: white;
                color: #1f2937;
                font-weight: 500;
                border-color: #e5e7eb;
                border-bottom: 1px solid white;
                z-index: 1;
            }
            .wb-tab-title {
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                pointer-events: none;
                flex: 1; min-width: 0;
            }
            .wb-tab-close {
                width: 18px; height: 18px;
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
            .wb-tab-item:hover .wb-tab-close,
            .wb-tab-item.wb-tab-active .wb-tab-close { opacity: 1; }
            .wb-tab-close:hover { background: #ddd; color: #374151; }

            /* ---- Toolbar ---- */
            .wb-toolbar {
                display: flex; align-items: center; gap: 4px;
                padding: 5px 8px;
                background: white;
                border-bottom: 1px solid #e5e7eb;
                flex-shrink: 0;
            }
            .wb-btn {
                width: 28px; height: 28px;
                border-radius: 6px; border: none;
                background: transparent;
                cursor: pointer;
                display: flex; align-items: center; justify-content: center;
                transition: all 0.15s; color: #6b7280;
                font-size: 12px; flex-shrink: 0;
            }
            .wb-btn:hover { background: #f3f4f6; color: #374151; }
            .wb-btn:active { background: #e5e7eb; }
            .wb-btn.disabled { opacity: 0.35; cursor: default; pointer-events: none; }
            .wb-url-wrap {
                flex: 1; min-width: 0;
                display: flex; align-items: center;
                background: #f3f4f6;
                border: 1px solid #e5e7eb;
                border-radius: 8px;
                padding: 4px 10px; gap: 6px;
                height: 32px;
                transition: border-color 0.15s, box-shadow 0.15s;
            }
            .wb-url-wrap:focus-within {
                border-color: #93c5fd;
                box-shadow: 0 0 0 2px rgba(59,130,246,0.12);
                background: white;
            }
            .wb-lock { color: #10b981; flex-shrink: 0; font-size: 11px; }
            .wb-url-input {
                flex: 1; min-width: 0;
                border: none; background: transparent; outline: none;
                font-size: 13px; color: #1f2937;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                line-height: 1.4;
            }
            .wb-url-input::placeholder { color: #9ca3af; }
            .wb-sep {
                width: 1px; height: 16px;
                background: #e5e7eb; margin: 0 2px; flex-shrink: 0;
            }

            /* ---- Webview area ---- */
            .wb-webview-container {
                flex: 1; overflow: hidden;
                position: relative;
            }
            .wb-webview-wrap {
                width: 100%;
                height: 100%;
                position: absolute; top: 0; left: 0;
                display: none;
            }
            .wb-webview-wrap.wb-wv-active { display: block; }
            .wb-webview {
                width: 100%; height: 100%; border: none;
            }

            /* ---- Home page ---- */
            .wb-homepage {
                position: absolute; top: 0; left: 0;
                width: 100%; height: 100%;
                display: flex; flex-direction: column;
                align-items: center; justify-content: center;
                background: #f8f9fb;
                z-index: 1;
            }
            .wb-homepage.wb-hidden { display: none; }
            .wb-homepage-title {
                font-size: 28px;
                font-weight: 600;
                color: #374151;
                margin-bottom: 28px;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                letter-spacing: -0.5px;
            }
            .wb-homepage-search {
                display: flex; align-items: center;
                width: 560px; max-width: 90%;
                height: 48px;
                background: white;
                border: 1px solid #e0e2e6;
                border-radius: 24px;
                padding: 0 20px;
                box-shadow: 0 2px 8px rgba(0,0,0,0.04);
                transition: box-shadow 0.2s, border-color 0.2s;
            }
            .wb-homepage-search:focus-within {
                border-color: #93c5fd;
                box-shadow: 0 4px 16px rgba(59,130,246,0.1);
            }
            .wb-homepage-search-icon {
                color: #9ca3af; margin-right: 12px; font-size: 15px; flex-shrink: 0;
            }
            .wb-homepage-search-input {
                flex: 1; border: none; outline: none; background: transparent;
                font-size: 15px; color: #1f2937;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            }
            .wb-homepage-search-input::placeholder { color: #b0b3b8; }
            .wb-homepage-shortcuts {
                display: flex; gap: 16px; margin-top: 36px; flex-wrap: wrap;
                justify-content: center; max-width: 560px;
            }
            .wb-homepage-shortcut {
                display: flex; flex-direction: column; align-items: center;
                gap: 6px; cursor: pointer; padding: 10px 14px;
                border-radius: 12px; transition: background 0.15s;
                text-decoration: none;
            }
            .wb-homepage-shortcut:hover { background: #f0f1f3; }
            .wb-homepage-shortcut-icon {
                width: 44px; height: 44px;
                border-radius: 12px; background: white;
                border: 1px solid #e5e7eb;
                display: flex; align-items: center; justify-content: center;
                font-size: 18px; color: #6b7280;
            }
            .wb-homepage-shortcut-label {
                font-size: 11px; color: #6b7280;
                max-width: 64px; text-align: center;
                overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
            }
        </style>
        <div class="wb">
            <div class="wb-tabbar">
                <button class="wb-tab-add-btn" title="新建标签页"><i class="fas fa-plus"></i></button>
                <div class="wb-tabbar-inner"></div>
                <div class="wb-tabbar-spacer"></div>
            </div>
            <div class="wb-toolbar">
                <button class="wb-btn wb-back-btn" title="后退"><i class="fas fa-chevron-left"></i></button>
                <button class="wb-btn wb-forward-btn" title="前进"><i class="fas fa-chevron-right"></i></button>
                <button class="wb-btn wb-refresh-btn" title="刷新"><i class="fas fa-rotate-right"></i></button>
                <div class="wb-sep"></div>
                <div class="wb-url-wrap">
                    <i class="fas fa-lock wb-lock" style="display:none"></i>
                    <input type="text" class="wb-url-input" placeholder="搜索或输入网址…" value="">
                </div>
                <div class="wb-sep"></div>
                <button class="wb-btn wb-home-btn" title="主页"><i class="fas fa-house"></i></button>
            </div>
            <div class="wb-webview-container">
                <div class="wb-homepage" id="wb-homepage">
                    <div class="wb-homepage-title">OpenDesk 浏览器</div>
                    <div class="wb-homepage-search">
                        <i class="fas fa-magnifying-glass wb-homepage-search-icon"></i>
                        <input type="text" class="wb-homepage-search-input" placeholder="搜索内容…" autofocus>
                    </div>
                    <div class="wb-homepage-shortcuts">
                        <a class="wb-homepage-shortcut" data-url="https://www.google.com">
                            <div class="wb-homepage-shortcut-icon"><i class="fab fa-google"></i></div>
                            <div class="wb-homepage-shortcut-label">Google</div>
                        </a>
                        <a class="wb-homepage-shortcut" data-url="https://github.com">
                            <div class="wb-homepage-shortcut-icon"><i class="fab fa-github"></i></div>
                            <div class="wb-homepage-shortcut-label">GitHub</div>
                        </a>
                        <a class="wb-homepage-shortcut" data-url="https://www.bing.com">
                            <div class="wb-homepage-shortcut-icon"><i class="fab fa-microsoft"></i></div>
                            <div class="wb-homepage-shortcut-label">Bing</div>
                        </a>
                        <a class="wb-homepage-shortcut" data-url="https://www.baidu.com">
                            <div class="wb-homepage-shortcut-icon"><i class="fas fa-b"></i></div>
                            <div class="wb-homepage-shortcut-label">百度</div>
                        </a>
                    </div>
                </div>
            </div>
        </div>`;

        this.urlInput = this.querySelector('.wb-url-input') as HTMLInputElement;
        this.tabBarInner = this.querySelector('.wb-tabbar-inner') as HTMLElement;
        this.webviewContainer = this.querySelector('.wb-webview-container') as HTMLElement;
        this.homePageContainer = this.querySelector('#wb-homepage') as HTMLElement;

        this._initZoomSync();
        this.bindToolbarEvents();
        this.bindTabBarEvents();
        this.bindHomePageEvents();
    }

    // ---- Zoom sync ----

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

    // ---- Tab bar events ----

    private bindTabBarEvents(): void {
        const addBtn = this.querySelector('.wb-tab-add-btn') as HTMLButtonElement;
        addBtn.addEventListener('click', () => this.addTab());

        if (this.tabBarInner) {
            this.tabBarInner.addEventListener(
                'wheel',
                (e: WheelEvent) => {
                    e.preventDefault();
                    this.tabBarInner!.scrollLeft += e.deltaY !== 0 ? e.deltaY : e.deltaX;
                },
                { passive: false }
            );
        }
    }

    // ---- Toolbar events ----

    private bindToolbarEvents(): void {
        if (!this.urlInput) return;

        const backBtn = this.querySelector('.wb-back-btn') as HTMLButtonElement;
        const forwardBtn = this.querySelector('.wb-forward-btn') as HTMLButtonElement;
        const refreshBtn = this.querySelector('.wb-refresh-btn') as HTMLButtonElement;
        const homeBtn = this.querySelector('.wb-home-btn') as HTMLButtonElement;

        backBtn.addEventListener('click', () => this.goBack());
        forwardBtn.addEventListener('click', () => this.goForward());
        refreshBtn.addEventListener('click', () => this.refresh());
        homeBtn.addEventListener('click', () => this.goHome());

        this.urlInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.navigateTo(this.urlInput?.value || '');
            }
        });

        this.urlInput.addEventListener('focus', () => {
            this.urlInput?.select();
        });
    }

    // ---- Home page events ----

    private bindHomePageEvents(): void {
        const searchInput = this.querySelector('.wb-homepage-search-input') as HTMLInputElement;
        searchInput?.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && searchInput.value.trim()) {
                const query = searchInput.value.trim();
                this.navigateTo(query);
                searchInput.value = '';
            }
        });

        const shortcuts = this.querySelectorAll('.wb-homepage-shortcut');
        for (const shortcut of shortcuts) {
            shortcut.addEventListener('click', (e) => {
                e.preventDefault();
                const url = (shortcut as HTMLElement).dataset.url;
                if (url) this.navigateTo(url);
            });
        }
    }

    // ---- Tab management ----

    public addTab(url?: string): number {
        const isHome = !url;
        const tabId = nextTabId++;

        const tab: BrowserTab = {
            id: tabId,
            title: '新标签页',
            url: url || '',
            webview: null,
            wrapEl: null,
            ready: false,
            pendingUrl: null,
            isHomePage: isHome
        };

        if (!isHome) {
            this.createWebviewForTab(tab, url!);
        }

        this.tabs.push(tab);
        this.renderTabBar();
        this.switchToTab(tabId);
        return tabId;
    }

    private createWebviewForTab(tab: BrowserTab, url: string): void {
        const wrapEl = document.createElement('div');
        wrapEl.className = 'wb-webview-wrap';
        wrapEl.dataset.tabId = String(tab.id);

        const wv = document.createElement('webview') as unknown as WebviewTag;
        wv.className = 'wb-webview';
        wv.setAttribute('src', url);
        wv.setAttribute('allowpopups', '');
        wv.setAttribute('webpreferences', 'contextIsolation=yes,nodeIntegration=no');
        wrapEl.appendChild(wv as unknown as Node);
        this.webviewContainer?.appendChild(wrapEl);

        tab.webview = wv;
        tab.wrapEl = wrapEl;
        tab.isHomePage = false;

        this.setupWebviewForTab(tab);
    }

    private ensureTabHasWebview(tab: BrowserTab, url: string): void {
        if (tab.webview) return;
        this.createWebviewForTab(tab, url);
        if (tab.id === this.activeTabId) {
            tab.wrapEl?.classList.add('wb-wv-active');
        }
    }

    public closeTab(tabId: number): void {
        const idx = this.tabs.findIndex((t) => t.id === tabId);
        if (idx === -1) return;

        if (this.tabs.length === 1) {
            const onlyTab = this.tabs[0];
            if (onlyTab.webview) {
                onlyTab.wrapEl?.remove();
                onlyTab.webview = null;
                onlyTab.wrapEl = null;
            }
            onlyTab.url = '';
            onlyTab.title = '新标签页';
            onlyTab.isHomePage = true;
            onlyTab.ready = false;
            this.renderTabBar();
            this.syncUrlBar();
            this.updateHomePageVisibility();
            return;
        }

        const tab = this.tabs[idx];
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
            t.wrapEl?.classList.toggle('wb-wv-active', t.id === tabId);
        }

        this.syncUrlBar();
        this.syncNavButtons();
        this.updateHomePageVisibility();
        this.renderTabBar();
    }

    private getActiveTab(): BrowserTab | undefined {
        return this.tabs.find((t) => t.id === this.activeTabId);
    }

    // ---- Tab bar rendering ----

    private renderTabBar(): void {
        if (!this.tabBarInner) return;

        this.tabBarInner.innerHTML = '';
        for (const tab of this.tabs) {
            const el = document.createElement('div');
            el.className = 'wb-tab-item' + (tab.id === this.activeTabId ? ' wb-tab-active' : '');
            el.dataset.tabId = String(tab.id);

            const titleSpan = document.createElement('span');
            titleSpan.className = 'wb-tab-title';
            titleSpan.textContent = tab.title || '新标签页';
            titleSpan.title = tab.url || '新标签页';
            el.appendChild(titleSpan);

            const closeBtn = document.createElement('button');
            closeBtn.className = 'wb-tab-close';
            closeBtn.innerHTML = '<i class="fas fa-xmark"></i>';
            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.closeTab(tab.id);
            });
            el.appendChild(closeBtn);

            el.addEventListener('click', () => this.switchToTab(tab.id));
            this.tabBarInner!.appendChild(el);
        }

        this.scrollActiveTabIntoView();
    }

    private scrollActiveTabIntoView(): void {
        if (!this.tabBarInner) return;
        const activeEl = this.tabBarInner.querySelector('.wb-tab-active') as HTMLElement;
        if (activeEl) {
            activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
        }
    }

    // ---- Webview setup per tab ----

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
        });

        const onPopupBlocked = (event: Event) => {
            const detail = (event as CustomEvent).detail;
            if (!detail || !detail.url) return;
            const wcId = detail.webContentsId;
            if (tab.ready && tab.webview) {
                try {
                    const myId = (tab.webview as any).getWebContentsId();
                    if (myId === wcId) {
                        this.addTab(detail.url);
                    }
                } catch {
                    /* ignore */
                }
            }
        };
        window.addEventListener('browser-popup-blocked', onPopupBlocked);

        wv.addEventListener('did-navigate', (event: any) => {
            tab.url = event.url;
            this.updateTabTitle(tab);
            if (tab.id === this.activeTabId) {
                this.syncUrlBar();
                this.updateLockIcon(tab.url);
            }
            if (tab.ready) this.syncNavButtons();
        });

        wv.addEventListener('did-navigate-in-page', (event: any) => {
            tab.url = event.url;
            if (tab.id === this.activeTabId) {
                this.syncUrlBar();
                this.updateLockIcon(tab.url);
            }
            if (tab.ready) this.syncNavButtons();
        });

        wv.addEventListener('page-title-updated', (event: any) => {
            tab.title = event.title || this.extractTitle(tab.url);
            this.renderTabBar();
        });

        wv.addEventListener('did-finish-load', () => {
            if (tab.ready) this.syncNavButtons();
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
                .catch(() => {});
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

    // ---- Home page visibility ----

    private updateHomePageVisibility(): void {
        const tab = this.getActiveTab();
        if (!this.homePageContainer) return;
        if (tab?.isHomePage) {
            this.homePageContainer.classList.remove('wb-hidden');
            // 自动聚焦搜索框
            setTimeout(() => {
                const searchInput = this.homePageContainer?.querySelector(
                    '.wb-homepage-search-input'
                ) as HTMLInputElement;
                searchInput?.focus();
            }, 50);
        } else {
            this.homePageContainer.classList.add('wb-hidden');
        }
    }

    // ---- Sync helpers ----

    private syncUrlBar(): void {
        const tab = this.getActiveTab();
        if (this.urlInput && tab) {
            this.urlInput.value = tab.isHomePage ? '' : tab.url || '';
            this.updateLockIcon(tab.isHomePage ? '' : tab.url);
        }
    }

    private updateLockIcon(url: string): void {
        const lockIcon = this.querySelector('.wb-lock') as HTMLElement;
        if (!lockIcon) return;
        if (url && url.startsWith('https://')) {
            lockIcon.style.display = '';
        } else {
            lockIcon.style.display = 'none';
        }
    }

    private syncNavButtons(): void {
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

        const backBtn = this.querySelector('.wb-back-btn') as HTMLButtonElement;
        const forwardBtn = this.querySelector('.wb-forward-btn') as HTMLButtonElement;
        if (backBtn) backBtn.classList.toggle('disabled', !canBack);
        if (forwardBtn) forwardBtn.classList.toggle('disabled', !canForward);
    }

    // ---- Navigation ----

    public navigateTo(input: string): void {
        const raw = input.trim();
        if (!raw) return;

        const tab = this.getActiveTab();
        if (!tab) return;

        const targetUrl = this.normalizeUrl(raw);
        if (!targetUrl) return;

        const wasCreated = !tab.webview;
        // 如果当前 tab 还是主页，需要创建 webview
        this.ensureTabHasWebview(tab, targetUrl);

        tab.isHomePage = false;
        tab.url = targetUrl;

        if (!wasCreated) {
            if (tab.ready && tab.webview) {
                try {
                    tab.webview.loadURL(targetUrl);
                } catch {
                    tab.webview.src = targetUrl;
                }
            } else if (tab.webview) {
                tab.pendingUrl = targetUrl;
            }
        }

        this.syncUrlBar();
        this.updateHomePageVisibility();
    }

    /**
     * 将用户输入规范化为有效 URL：
     * - 已有协议 → 保持不变
     * - 看起来像域名（含点号且无空格）→ 添加 https://
     * - 其他 → 作为搜索关键词
     */
    private normalizeUrl(raw: string): string | null {
        if (!raw) return null;
        if (/^(https?|about|file|data):/.test(raw)) return raw;
        if (/^[^\s]+\.[^\s]+$/.test(raw) && !raw.includes(' ')) return `https://${raw}`;
        return SEARCH_ENGINE + encodeURIComponent(raw);
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
            try {
                tab.webview.reload();
            } catch {
                /* not ready */
            }
        }
    }

    public focusUrlBar(): void {
        this.urlInput?.focus();
        this.urlInput?.select();
    }

    public closeActiveTab(): void {
        if (this.activeTabId >= 0) {
            this.closeTab(this.activeTabId);
        }
    }

    public goHome(): void {
        const tab = this.getActiveTab();
        if (!tab) return;

        // 回到主页状态
        if (tab.webview) {
            tab.wrapEl?.classList.remove('wb-wv-active');
        }
        tab.isHomePage = true;
        tab.url = '';
        tab.title = '新标签页';
        this.syncUrlBar();
        this.syncNavButtons();
        this.updateHomePageVisibility();
        this.renderTabBar();
    }
}

customElements.define('webbrowser-entry-widget', WebBrowserEntryWidget);
