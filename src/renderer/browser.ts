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
 * Browser tab component for OpenDesk
 * Each task owns its own browser instance (1:1 binding).
 * Agent tools control the browser via IPC: main → renderer → EmbeddedBrowser.
 */

export interface BrowserState {
    currentUrl: string;
    canGoBack: boolean;
    canGoForward: boolean;
    isFullscreen: boolean;
}

export class EmbeddedBrowser {
    private container: HTMLElement | null = null;
    private webview: Electron.WebviewTag | null = null;
    private urlInput: HTMLInputElement | null = null;
    private _currentUrl: string = 'https://www.baidu.com';
    private _canGoBack: boolean = false;
    private _canGoForward: boolean = false;
    private _isFullscreen: boolean = false;

    constructor(container: HTMLElement) {
        this.container = container;
        this.init();
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
            .bw-webview-wrap {
                flex: 1; overflow: hidden;
                background: white; position: relative;
            }
            .bw-webview {
                width: 100%; height: 100%; border: none;
            }
            .bw-sep {
                width: 1px; height: 14px;
                background: #e5e7eb; margin: 0 1px; flex-shrink: 0;
            }
        </style>
        <div class="bw">
            <div class="bw-toolbar">
                <button class="bw-btn bw-back-btn" title="后退"><i class="fas fa-chevron-left"></i></button>
                <button class="bw-btn bw-forward-btn" title="前进"><i class="fas fa-chevron-right"></i></button>
                <button class="bw-btn bw-refresh-btn" title="刷新"><i class="fas fa-rotate-right"></i></button>
                <div class="bw-sep"></div>
                <div class="bw-url-wrap">
                    <i class="fas fa-lock bw-lock"></i>
                    <input type="text" class="bw-url-input" placeholder="输入网址或搜索…" value="https://www.baidu.com">
                </div>
                <div class="bw-sep"></div>
                <button class="bw-btn bw-home-btn" title="主页"><i class="fas fa-house"></i></button>
                <button class="bw-btn bw-fullscreen-btn" title="全屏"><i class="fas fa-expand"></i></button>
            </div>
            <div class="bw-webview-wrap">
                <webview class="bw-webview" src="https://www.baidu.com"
                    webpreferences="contextIsolation=yes,nodeIntegration=no"></webview>
            </div>
        </div>`;

        this.webview = this.container.querySelector('.bw-webview') as Electron.WebviewTag;
        this.urlInput = this.container.querySelector('.bw-url-input') as HTMLInputElement;

        this.bindEvents();
        this.setupWebview();
    }

    private bindEvents(): void {
        if (!this.container || !this.webview || !this.urlInput) return;

        const backBtn = this.container.querySelector('.bw-back-btn') as HTMLButtonElement;
        const forwardBtn = this.container.querySelector('.bw-forward-btn') as HTMLButtonElement;
        const refreshBtn = this.container.querySelector('.bw-refresh-btn') as HTMLButtonElement;
        const fullscreenBtn = this.container.querySelector('.bw-fullscreen-btn') as HTMLButtonElement;
        const homeBtn = this.container.querySelector('.bw-home-btn') as HTMLButtonElement;

        backBtn.addEventListener('click', () => this.goBack());
        forwardBtn.addEventListener('click', () => this.goForward());
        refreshBtn.addEventListener('click', () => this.refresh());
        fullscreenBtn.addEventListener('click', () => this.toggleFullscreen());
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

    private setupWebview(): void {
        if (!this.webview) return;

        this.webview.addEventListener('did-navigate', (event: any) => {
            this._currentUrl = event.url;
            if (this.urlInput) this.urlInput.value = event.url;
            this._syncNavButtons();
        });

        this.webview.addEventListener('did-navigate-in-page', (event: any) => {
            this._currentUrl = event.url;
            if (this.urlInput) this.urlInput.value = event.url;
            this._syncNavButtons();
        });

        this.webview.addEventListener('did-finish-load', () => {
            this._syncNavButtons();
        });
    }

    private _syncNavButtons(): void {
        if (!this.container || !this.webview) return;
        this._canGoBack = this.webview.canGoBack();
        this._canGoForward = this.webview.canGoForward();

        const backBtn = this.container.querySelector('.bw-back-btn') as HTMLButtonElement;
        const forwardBtn = this.container.querySelector('.bw-forward-btn') as HTMLButtonElement;
        backBtn.classList.toggle('disabled', !this._canGoBack);
        forwardBtn.classList.toggle('disabled', !this._canGoForward);
    }

    // ---- Public API (called by user UI AND by agent tools via IPC) ----

    public navigateTo(url: string): void {
        if (!this.webview) return;
        let targetUrl = url.trim();
        if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
            if (targetUrl.includes('.') && !targetUrl.includes(' ')) {
                targetUrl = 'https://' + targetUrl;
            } else {
                targetUrl = 'https://www.baidu.com/s?wd=' + encodeURIComponent(targetUrl);
            }
        }
        this.webview.src = targetUrl;
    }

    public goBack(): void {
        if (!this.webview || !this.webview.canGoBack()) return;
        this.webview.goBack();
    }

    public goForward(): void {
        if (!this.webview || !this.webview.canGoForward()) return;
        this.webview.goForward();
    }

    public refresh(): void {
        if (!this.webview) return;
        this.webview.reload();
    }

    public goHome(): void {
        this.navigateTo('https://www.baidu.com');
    }

    public toggleFullscreen(): void {
        this._isFullscreen = !this._isFullscreen;
        const event = new CustomEvent('browser-fullscreen-toggle', {
            detail: { isFullscreen: this._isFullscreen }
        });
        this.container?.dispatchEvent(event);
    }

    public getCurrentUrl(): string {
        return this._currentUrl;
    }

    public getState(): BrowserState {
        return {
            currentUrl: this._currentUrl,
            canGoBack: this._canGoBack,
            canGoForward: this._canGoForward,
            isFullscreen: this._isFullscreen
        };
    }

    public executeJavaScript(script: string): Promise<any> {
        if (!this.webview) return Promise.reject('Webview not initialized');
        return this.webview.executeJavaScript(script);
    }

    public destroy(): void {
        this.container = null;
        this.webview = null;
        this.urlInput = null;
    }
}
