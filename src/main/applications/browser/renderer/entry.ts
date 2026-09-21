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

import { BrowserTools } from '../../../../renderer/browser/browserTools.js';
import { BROWSER_TOOLS_CSS } from '../../../../renderer/browser/browserToolsStyles.js';
import {
    loadHistory,
    saveHistory,
    loadBookmarks,
    saveBookmarks,
    generateId,
    MAX_HISTORY_ITEMS,
    type HistoryEntry,
    type BookmarkEntry
} from '../../../../renderer/browser/browserData.js';
import { createBrowserToolMenu, type BrowserToolMenuHandle } from '../../../../renderer/components/browserToolMenu.js';
import type { WebviewTag } from 'electron';
import { getErrorMessage, buildErrorPageScript, type ErrorInfo } from '../../../../common/browserErrors';
import {
    createBrowserHintPanel,
    fetchBrowserHintsForPage,
    type BrowserHintPanelHandle
} from '../../../../renderer/components/browserHintPanel.js';
import { createRendererTranslator, resolveRendererLocale } from '../../../../renderer/locale.js';
import { createTranslatorForBrowser } from '../locale/renderer.js';
// 注册 <content-loading-view> 加载中组件，用于页面加载反馈
import '../../../../renderer/components/loading.js';
import {
    WINDOW_OPEN_PROXY_SCRIPT,
    OPENER_BRIDGE_SCRIPT,
    NOTIFY_POPUP_CLOSED_SCRIPT,
    NAV_INTERCEPT_CONSOLE_PREFIX
} from '../../../../renderer/webviewScripts';

const SEARCH_ENGINE = 'https://www.bing.com/search?q=';
const MAX_SUGGESTIONS = 8;
// 页面加载指示器的延迟显示时间：快速加载的页面不闪烁 loading 遮罩
const LOADING_OVERLAY_DELAY_MS = 300;

// 与任务级浏览器一致：优先用主窗口注入的运行时翻译器，失败时回退到本地语言包
function browserT(key: string): string {
    const runtimeTranslator = (window as any).__odT;
    return typeof runtimeTranslator === 'function' ? runtimeTranslator(key) : createRendererTranslator()(key);
}

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
    internalUrl?: string;
    errorInfo?: ErrorInfo;
    lastActiveTime?: number;
    /** 若此 tab 由弹窗产生，记录打开它的父 tab ID */
    openerTabId?: number;
    /** 加载指示器延迟显示的定时器句柄 */
    loadingTimer?: ReturnType<typeof setTimeout> | null;
}

class BrowserEntryWidget extends HTMLElement {
    private _t = createTranslatorForBrowser();
    private _locale: string | undefined = undefined;
    private _settingUnsubscribe: (() => void) | null = null;
    private urlInput: HTMLInputElement | null = null;
    private tabBarInner: HTMLElement | null = null;
    private webviewContainer: HTMLElement | null = null;
    private homePageContainer: HTMLElement | null = null;
    private suggestionsEl: HTMLElement | null = null;
    private bookmarkBarEl: HTMLElement | null = null;
    private browserTools: BrowserTools | null = null;
    private toolMenu: BrowserToolMenuHandle | null = null;
    private get historyPanelEl(): HTMLElement | null {
        return this.browserTools?.historyPanelEl ?? null;
    }
    private get bookmarkMgrEl(): HTMLElement | null {
        return this.browserTools?.bookmarkMgrEl ?? null;
    }
    private get downloadPanelEl(): HTMLElement | null {
        return this.browserTools?.downloadPanelEl ?? null;
    }

    private tabs: BrowserTab[] = [];
    private activeTabId: number = -1;
    private _currentZoomFactor: number = 1;
    private _removeZoomListener: (() => void) | null = null;
    private _cleanupTimers: Map<number, ReturnType<typeof setTimeout>> = new Map();
    private static readonly CLEANUP_DELAY_MS = 900_000; // 15 minutes
    private _cachedUserAgent: string = '';
    private _initialized = false;
    private _pendingOpenUrls: string[] = [];

    // 页面提示（Browser Hints）面板状态
    private hintPanel: BrowserHintPanelHandle | null = null;
    private _hintRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    private _hintSeq: number = 0;
    private _lastHintKey: string = '';

    private history: HistoryEntry[] = [];
    private bookmarks: BookmarkEntry[] = [];

    private _selectedSuggestionIdx: number = -1;
    private _dismissTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly _focusTrapKeydown = (event: KeyboardEvent) => this.handleFocusTrapKeydown(event);

    async connectedCallback() {
        this._initialized = false;
        // 先加载语言设置再渲染，避免首帧出现错误语言
        let setting;
        try {
            setting = await window.settingAPI?.loadSettingObject?.();
        } catch {
            setting = undefined;
        }
        this._applyLocaleSetting(setting);
        // 等待设置加载期间元素可能已被移除，避免对脱离 DOM 的元素继续渲染
        if (!this.isConnected) return;
        this._subscribeLocaleChanges();
        this.history = loadHistory();
        this.bookmarks = loadBookmarks();
        this.setAttribute('data-od-browser-focus-scope', '');
        this.addEventListener('keydown', this._focusTrapKeydown);
        this.render();
        this.addTab('opendesk://homepage/');
        this._initialized = true;
        for (const url of this._pendingOpenUrls.splice(0)) {
            this.addTab(url);
        }

        // 加载浏览器配置（User Agent 等）
        this._loadBrowserConfig();
    }

    disconnectedCallback() {
        this.browserTools?.destroy();
        this.browserTools = null;
        this.toolMenu?.destroy();
        this.toolMenu = null;
        this._initialized = false;
        if (this._settingUnsubscribe) {
            this._settingUnsubscribe();
            this._settingUnsubscribe = null;
        }
        this.removeAttribute('data-od-browser-focus-scope');
        this.removeEventListener('keydown', this._focusTrapKeydown);

        // 清理页面提示面板与防抖定时器
        if (this._hintRefreshTimer !== null) {
            clearTimeout(this._hintRefreshTimer);
            this._hintRefreshTimer = null;
        }
        this.hintPanel?.destroy();
        this.hintPanel = null;

        // 清理所有定时器
        for (const timer of this._cleanupTimers.values()) {
            clearTimeout(timer);
        }
        this._cleanupTimers.clear();

        if (this._removeZoomListener) {
            this._removeZoomListener();
            this._removeZoomListener = null;
        }
        for (const tab of this.tabs) {
            this.hideTabLoading(tab);
            tab.wrapEl?.remove();
            tab.webview = null;
            tab.wrapEl = null;
        }
        this.tabs = [];
    }

    // =====================================================================
    //  RENDER
    // =====================================================================

    private render(): void {
        this.innerHTML = `
        <style>
            :root { --fs-2xs: 9px; --fs-xs: 10px; --fs-sm: 11px; --fs-md: 12px; --fs-base: 13px; --fs-lg: 14px; --fs-xl: 16px; --icon-xs: 8px; --icon-sm: 10px; --icon-md: 12px; --icon-lg: 13px; }
            .wb {
                width: 100%; height: 100%;
                display: flex; flex-direction: column;
                background: #fafafa;
                overflow: hidden;
            }

            /* 顶部留白——避让窗口拖拽层及控制按钮 */
            .wb-drag-pad {
                flex-shrink: 0;
                height: 32px;
                background: #f5f5f5;
            }

            /* ---- Tab bar (macOS pill style) ---- */
            .wb-tabbar {
                display: flex; align-items: center;
                background: #f3f4f6;
                border-bottom: 1px solid #e5e7eb;
                flex-shrink: 0;
                min-height: 42px;
                padding: 0px 10px 0px 5px;
                gap: 0;
            }
            .wb-tabbar-inner {
                display: flex; align-items: center;
                flex: 1; min-width: 0;
                overflow-x: auto;
                overflow-y: hidden;
                scrollbar-width: none;
                gap: 0;
            }
            .wb-tabbar-inner::-webkit-scrollbar { display: none; }
            .wb-tab-item {
                margin: 3px;
                box-sizing: border-box;
                display: flex; align-items: center;
                gap: 6px;
                height: 30px;
                padding: 0 12px;
                font-size: var(--fs-base);
                color: #6b7280;
                background: transparent;
                border: none;
                border-radius: 10px;
                cursor: pointer;
                white-space: nowrap;
                max-width: 200px;
                min-width: 80px;
                flex-shrink: 0;
                transition: all 0.15s;
                position: relative;
                justify-content: center;
            }
            .wb-tab-item:hover { background: rgba(0,0,0,0.05); color: #374151; }
            .wb-tab-item.wb-tab-active {
                background: white;
                color: #1f2937;
                font-weight: 500;
                box-shadow: 0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04);
            }
            /* 非选中标签之间的竖线分隔（上下留白） */
            .wb-tab-item:not(.wb-tab-active):not(:first-child)::before {
                content: '';
                position: absolute;
                left: 0;
                top: 50%;
                transform: translateY(-50%);
                width: 1px;
                height: 16px;
                background: #d1d5db;
            }
            .wb-tab-title {
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                pointer-events: none;
                flex: 1; min-width: 0;
                text-align: center;
            }
            .wb-tab-close {
                width: 18px; height: 18px;
                border: none; background: transparent;
                color: #9ca3af; cursor: pointer;
                display: flex; align-items: center; justify-content: center;
                border-radius: 50%;
                font-size: var(--fs-xs);
                flex-shrink: 0;
                opacity: 0;
                transition: all 0.15s;
                padding: 0;
                margin-left: 2px;
            }
            .wb-tab-item:hover .wb-tab-close,
            .wb-tab-item.wb-tab-active .wb-tab-close { opacity: 0.7; }
            .wb-tab-close:hover { background: rgba(0,0,0,0.1); color: #333; opacity: 1 !important; }
            .wb-tab-add-btn {
                width: 28px; height: 28px;
                border: none; background: #e5e7eb;
                color: #6b7280; cursor: pointer;
                display: flex; align-items: center; justify-content: center;
                flex-shrink: 0;
                border-radius: 8px;
                margin-left: 8px;
                font-size: var(--fs-base);
                transition: all 0.15s;
            }
            .wb-tab-add-btn:hover { background: #d1d5db; color: #374151; }
            .wb-tab-add-btn:active { background: #c1c5cb; }
            /* 深色模式取值与任务级浏览器（bw-tab-add-btn）保持一致 */
            html[data-theme='dark'] .wb-tab-add-btn {
                background: #333333;
                color: #ababab;
            }
            html[data-theme='dark'] .wb-tab-add-btn:hover {
                background: #3f3f46;
                color: #cccccc;
            }
            html[data-theme='dark'] .wb-tab-add-btn:active { background: #4a4a4f; }

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
                font-size: var(--fs-md); flex-shrink: 0;
            }
            .wb-btn:hover { background: #f3f4f6; color: #374151; }
            .wb-btn:active { background: #e5e7eb; }
            .wb-btn.disabled { opacity: 0.35; cursor: default; pointer-events: none; }
            .wb-btn.wb-star-active { color: #f59e0b; }
            .wb-url-wrap {
                flex: 1; min-width: 0;
                display: flex; align-items: center;
                background: #f3f4f6;
                border: 1px solid #e5e7eb;
                border-radius: 8px;
                padding: 4px 10px; gap: 6px;
                height: 32px;
                transition: border-color 0.15s, box-shadow 0.15s;
                position: relative;
            }
            .wb-url-wrap:focus-within {
                border-color: #93c5fd;
                box-shadow: 0 0 0 2px rgba(59,130,246,0.12);
                background: white;
            }
            .wb-lock { color: #10b981; flex-shrink: 0; font-size: var(--fs-sm); }
            .wb-url-input {
                flex: 1; min-width: 0;
                border: none; background: transparent; outline: none;
                font-size: var(--fs-base); color: #1f2937;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                line-height: 1.4;
            }
            .wb-url-input::placeholder { color: #9ca3af; }
            .wb-sep {
                width: 1px; height: 16px;
                background: #e5e7eb; margin: 0 2px; flex-shrink: 0;
            }

            /* ---- URL suggestions dropdown ---- */
            .wb-suggestions {
                display: none;
                position: absolute;
                top: 100%; left: 0; right: 0;
                margin-top: 4px;
                background: white;
                border: 1px solid #e5e7eb;
                border-radius: 8px;
                box-shadow: 0 4px 16px rgba(0,0,0,0.1);
                z-index: 100;
                max-height: 320px;
                overflow-y: auto;
            }
            .wb-suggestions.wb-visible { display: block; }
            .wb-suggestion-item {
                display: flex; align-items: center; gap: 8px;
                padding: 7px 12px;
                cursor: pointer;
                font-size: var(--fs-base); color: #374151;
                transition: background 0.1s;
            }
            .wb-suggestion-item:first-child { border-radius: 8px 8px 0 0; }
            .wb-suggestion-item:last-child { border-radius: 0 0 8px 8px; }
            .wb-suggestion-item:hover,
            .wb-suggestion-item.wb-sg-active { background: #f3f4f6; }
            .wb-sg-icon { color: #9ca3af; font-size: var(--fs-sm); flex-shrink: 0; width: 16px; text-align: center; }
            .wb-sg-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .wb-sg-url { color: #9ca3af; font-size: var(--fs-sm); max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 0; }
            /* 深色模式：地址栏建议下拉（浏览器应用为 light DOM，html 携带 data-theme） */
            html[data-theme='dark'] .wb-suggestions {
                background: #252526;
                border-color: rgba(255, 255, 255, 0.12);
                box-shadow: 0 4px 16px rgba(0,0,0,0.4);
            }
            html[data-theme='dark'] .wb-suggestion-item { color: #cccccc; }
            html[data-theme='dark'] .wb-suggestion-item:hover,
            html[data-theme='dark'] .wb-suggestion-item.wb-sg-active { background: #2f2f31; }
            html[data-theme='dark'] .wb-sg-icon,
            html[data-theme='dark'] .wb-sg-url { color: #8a8a8a; }
            /* 滚动条：按 docs/specifications/scrollbar_specification.md 二级（Compact）规格 */
            .wb-suggestions::-webkit-scrollbar { width: 4px; }
            .wb-suggestions::-webkit-scrollbar-track { background: transparent; }
            .wb-suggestions::-webkit-scrollbar-thumb {
                background: #d1d5db;
                border-radius: 2px;
            }
            html[data-theme='dark'] .wb-suggestions::-webkit-scrollbar-thumb {
                background: rgba(255, 255, 255, 0.18) !important;
            }
            html[data-theme='dark'] .wb-suggestions::-webkit-scrollbar-thumb:hover {
                background: rgba(255, 255, 255, 0.28) !important;
            }

            /* ---- Bookmark bar ---- */
            .wb-bookmark-bar {
                display: flex; align-items: center; gap: 2px;
                padding: 3px 8px;
                background: #fafafa;
                border-bottom: 1px solid #f0f0f0;
                flex-shrink: 0;
                min-height: 28px;
                overflow-x: auto;
                scrollbar-width: none;
            }
            .wb-bookmark-bar::-webkit-scrollbar { display: none; }
            .wb-bm-item {
                display: flex; align-items: center; gap: 4px;
                padding: 3px 8px;
                border-radius: 4px;
                font-size: var(--fs-md); color: #4b5563;
                cursor: pointer;
                white-space: nowrap;
                transition: background 0.12s;
                flex-shrink: 0;
                max-width: 160px;
            }
            .wb-bm-item:hover { background: #e5e7eb; }
            .wb-bm-item i { font-size: var(--fs-xs); color: #9ca3af; }
            .wb-bm-item-label { overflow: hidden; text-overflow: ellipsis; }
            .wb-bm-empty {
                font-size: var(--fs-md); color: #9ca3af; padding: 3px 8px;
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
                contain: layout style paint;
            }
            .wb-webview-wrap.wb-wv-active { display: block; }
            .wb-webview {
                width: 100%; height: 100%; border: none;
            }
            .wb-loading-overlay {
                position: absolute; top: 0; left: 0;
                width: 100%; height: 100%;
                display: flex; align-items: center; justify-content: center;
                background: var(--od-bg-elevated, #ffffff);
                z-index: 10;
                pointer-events: none;
                animation: wb-loading-fade-in 0.2s ease;
            }
            @keyframes wb-loading-fade-in {
                from { opacity: 0; }
                to { opacity: 1; }
            }

            /* ---- Home page (legacy container, hidden by default now) ---- */
            .wb-homepage {
                position: absolute; top: 0; left: 0;
                width: 100%; height: 100%;
                display: none;
                z-index: 1;
            }
            .wb-homepage.wb-hidden { display: none; }

            /* ---- New Homepage (internal page) ---- */
            .wb-hp {
                width: 100%; height: 100%;
                display: flex; flex-direction: column;
                align-items: center;
                background: white;
                overflow-y: auto;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            }
            .wb-hp-hero {
                display: flex; flex-direction: column;
                align-items: center;
                padding-top: min(18vh, 140px);
                width: 100%;
            }
            .wb-hp-greeting {
                font-size: 26px;
                font-weight: 600;
                color: #1f2937;
                margin-bottom: 24px;
                letter-spacing: -0.3px;
            }
            .wb-hp-search-wrap {
                display: flex; align-items: center;
                width: 580px; max-width: 88%;
                height: 46px;
                background: #f5f6f8;
                border: 1px solid transparent;
                border-radius: 23px;
                padding: 0 18px;
                transition: all 0.2s;
            }
            .wb-hp-search-wrap:focus-within {
                background: white;
                border-color: #bfdbfe;
                box-shadow: 0 2px 12px rgba(59,130,246,0.08);
            }
            .wb-hp-search-icon {
                color: #9ca3af; margin-right: 10px; font-size: var(--fs-lg); flex-shrink: 0;
            }
            .wb-hp-search-input {
                flex: 1; border: none; outline: none; background: transparent;
                font-size: var(--fs-lg); color: #1f2937;
                font-family: inherit;
            }
            .wb-hp-search-input::placeholder { color: #b0b3b8; }
            .wb-hp-section {
                width: 580px; max-width: 88%;
                margin-top: 36px;
            }
            .wb-hp-section-title {
                font-size: var(--fs-md); font-weight: 600;
                color: #9ca3af; text-transform: uppercase;
                letter-spacing: 0.5px;
                margin-bottom: 12px; padding-left: 4px;
            }
            .wb-hp-grid {
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
                gap: 10px;
            }
            .wb-hp-tile {
                display: flex; flex-direction: column;
                align-items: center; gap: 8px;
                padding: 14px 8px 12px;
                border-radius: 12px;
                cursor: pointer;
                transition: background 0.15s;
                text-decoration: none;
            }
            .wb-hp-tile:hover { background: #f5f6f8; }
            .wb-hp-tile-icon {
                width: 42px; height: 42px;
                border-radius: 12px;
                display: flex; align-items: center; justify-content: center;
                font-size: 18px;
                background: #f0f1f3;
                color: white;
                overflow: hidden;
                flex-shrink: 0;
            }
            .wb-hp-tile-icon img {
                width: 24px; height: 24px;
                object-fit: contain;
            }
            .wb-hp-tile-label {
                font-size: var(--fs-sm); color: #6b7280;
                max-width: 90px; text-align: center;
                overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
                line-height: 1.3;
            }

            /* ---- Tool menu anchor (relative positioning) ---- */
            .wb-toolbar-right {
                position: relative;
                display: flex; align-items: center; gap: 4px;
                flex-shrink: 0;
            }

            ${BROWSER_TOOLS_CSS}
        </style>
        <div class="wb">
            <div class="wb-drag-pad"></div>
            <div class="wb-tabbar">
                <div class="wb-tabbar-inner"></div>
                <button class="wb-tab-add-btn" title="${this._t('renderer.browser.tab.new')}"><i class="fas fa-plus"></i></button>
            </div>
            <div class="wb-toolbar">
                <button class="wb-btn wb-back-btn" title="${this._t('renderer.browser.toolbar.back')}"><i class="fas fa-chevron-left"></i></button>
                <button class="wb-btn wb-forward-btn" title="${this._t('renderer.browser.toolbar.forward')}"><i class="fas fa-chevron-right"></i></button>
                <button class="wb-btn wb-refresh-btn" title="${this._t('renderer.browser.toolbar.refresh')}"><i class="fas fa-rotate-right"></i></button>
                <div class="wb-sep"></div>
                <div class="wb-url-wrap">
                    <i class="fas fa-lock wb-lock" style="display:none"></i>
                    <input type="text" class="wb-url-input" placeholder="${this._t('renderer.browser.toolbar.urlPlaceholder')}" value="" autocomplete="off">
                    <div class="wb-suggestions"></div>
                </div>
                <div class="wb-hint-slot"></div>
                <button class="wb-btn wb-star-btn" title="${this._t('renderer.browser.toolbar.star')}"><i class="fas fa-star"></i></button>
                <div class="wb-sep"></div>
                <button class="wb-btn wb-home-btn" title="${this._t('renderer.browser.toolbar.home')}"><i class="fas fa-house"></i></button>
                <div class="wb-toolbar-right">
                    <button class="wb-btn wb-menu-btn" title="${this._t('renderer.browser.toolbar.menu')}"><i class="fas fa-ellipsis"></i></button>
                    <div class="wb-tool-menu"></div>
                </div>
            </div>
            <div class="wb-bookmark-bar"></div>
            <div class="wb-webview-container">
                <div class="wb-homepage wb-hidden" id="wb-homepage"></div>
            </div>
        </div>`;

        this.urlInput = this.querySelector('.wb-url-input') as HTMLInputElement;
        this.tabBarInner = this.querySelector('.wb-tabbar-inner') as HTMLElement;
        this.webviewContainer = this.querySelector('.wb-webview-container') as HTMLElement;
        this.homePageContainer = this.querySelector('#wb-homepage') as HTMLElement;
        this.suggestionsEl = this.querySelector('.wb-suggestions') as HTMLElement;
        this.bookmarkBarEl = this.querySelector('.wb-bookmark-bar') as HTMLElement;

        // 地址栏右侧的页面提示（Browser Hints）入口
        const hintSlot = this.querySelector('.wb-hint-slot') as HTMLElement;
        this.hintPanel = createBrowserHintPanel({
            labels: {
                title: browserT('renderer.browser.pageHints'),
                emptyText: browserT('renderer.browser.pageHintsEmpty'),
                textSection: browserT('renderer.browser.pageHintsTextSection'),
                actionSection: browserT('renderer.browser.pageHintsActionSection'),
                argsSection: browserT('renderer.browser.pageHintsArgs')
            },
            buttonClass: 'wb-btn'
        });
        hintSlot.appendChild(this.hintPanel.root);

        this._initZoomSync();
        this.bindToolbarEvents();
        this.bindTabBarEvents();
        this.bindHomePageEvents();
        this.bindUrlSuggestions();
        this.bindToolMenu();
        this.renderBookmarkBar();
    }

    private _applyLocaleSetting(setting?: { locale?: string; resolved_locale?: string }) {
        this._locale = resolveRendererLocale(setting);
        this._t = createTranslatorForBrowser(setting);
    }

    /* 语言设置变化时就地刷新可见文案。
       render() 会重建整个 shell（含已打开标签页的 webview），因此这里绝不整体重渲染：
       仅更新工具栏提示与书签栏；面板/工具菜单在下次打开时自然使用新语言，若当前
       打开中则立即按新语言重绘 */
    private _subscribeLocaleChanges() {
        if (this._settingUnsubscribe) return;
        const unsubscribe = window.settingAPI?.onSettingChanged?.((setting: any) => {
            if (!this.isConnected) return;
            if (resolveRendererLocale(setting) === this._locale) return;
            this._applyLocaleSetting(setting);
            this._refreshToolbarLocaleTexts();
            this.renderBookmarkBar();
            if (this.historyPanelEl?.classList.contains('wb-visible')) {
                const filter = (this.historyPanelEl.querySelector('.wb-panel-search') as HTMLInputElement)?.value ?? '';
                this.renderHistoryPanel(filter);
            }
            if (this.bookmarkMgrEl?.classList.contains('wb-visible')) {
                const filter = (this.bookmarkMgrEl.querySelector('.wb-panel-search') as HTMLInputElement)?.value ?? '';
                this.renderBookmarkManager(filter);
            }
            if (this.downloadPanelEl?.classList.contains('wb-visible')) {
                this.renderDownloadPanel();
            }
            this.toolMenu?.refresh();
        });
        if (typeof unsubscribe === 'function') {
            this._settingUnsubscribe = unsubscribe;
        }
    }

    private _refreshToolbarLocaleTexts() {
        const set = (selector: string, title: string) => {
            this.querySelector(selector)?.setAttribute('title', title);
        };
        set('.wb-tab-add-btn', this._t('renderer.browser.tab.new'));
        set('.wb-back-btn', this._t('renderer.browser.toolbar.back'));
        set('.wb-forward-btn', this._t('renderer.browser.toolbar.forward'));
        set('.wb-refresh-btn', this._t('renderer.browser.toolbar.refresh'));
        set('.wb-star-btn', this._t('renderer.browser.toolbar.star'));
        set('.wb-home-btn', this._t('renderer.browser.toolbar.home'));
        set('.wb-menu-btn', this._t('renderer.browser.toolbar.menu'));
        this.urlInput?.setAttribute('placeholder', this._t('renderer.browser.toolbar.urlPlaceholder'));
    }

    private handleFocusTrapKeydown(event: KeyboardEvent): void {
        if (event.defaultPrevented || event.key !== 'Tab' || event.ctrlKey || event.metaKey || event.altKey) {
            return;
        }

        const focusables = this.getFocusableElements();
        if (focusables.length === 0) {
            event.preventDefault();
            return;
        }

        const active = document.activeElement as HTMLElement | null;
        let index = active ? focusables.indexOf(active) : -1;
        if (index < 0 && active) {
            index = focusables.findIndex((el) => el === active || el.contains(active));
        }
        if (index < 0) return;

        let next: HTMLElement | null = null;
        if (focusables.length === 1) {
            next = focusables[0];
        } else if (event.shiftKey && index <= 0) {
            next = focusables[focusables.length - 1];
        } else if (!event.shiftKey && index >= focusables.length - 1) {
            next = focusables[0];
        }

        if (!next) return;
        event.preventDefault();
        event.stopPropagation();
        this.focusElement(next);
    }

    private getFocusableElements(): HTMLElement[] {
        const selector = [
            'a[href]',
            'area[href]',
            'button',
            'input',
            'select',
            'textarea',
            'iframe',
            'webview',
            '[contenteditable="true"]',
            '[tabindex]'
        ].join(',');
        return Array.from(this.querySelectorAll<HTMLElement>(selector)).filter((el) => this.isFocusableElement(el));
    }

    private isFocusableElement(el: HTMLElement): boolean {
        if (el.closest('[hidden],[inert]')) return false;
        if ((el as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).disabled)
            return false;
        if (el.getAttribute('aria-disabled') === 'true') return false;
        if (el instanceof HTMLInputElement && el.type.toLowerCase() === 'hidden') return false;
        if (el.tabIndex < 0) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        return el.getClientRects().length > 0;
    }

    private focusElement(el: HTMLElement): void {
        try {
            el.focus({ preventScroll: true });
        } catch {
            el.focus();
        }
    }

    // =====================================================================
    //  ZOOM SYNC
    // =====================================================================

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
                this.toolMenu?.updateZoom();
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

    // =====================================================================
    //  TAB BAR EVENTS
    // =====================================================================

    private bindTabBarEvents(): void {
        const addBtn = this.querySelector('.wb-tab-add-btn') as HTMLButtonElement;
        addBtn.addEventListener('click', () => this.addTab('opendesk://homepage/'));

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

    // =====================================================================
    //  TOOLBAR EVENTS
    // =====================================================================

    private bindToolbarEvents(): void {
        if (!this.urlInput) return;

        const backBtn = this.querySelector('.wb-back-btn') as HTMLButtonElement;
        const forwardBtn = this.querySelector('.wb-forward-btn') as HTMLButtonElement;
        const refreshBtn = this.querySelector('.wb-refresh-btn') as HTMLButtonElement;
        const homeBtn = this.querySelector('.wb-home-btn') as HTMLButtonElement;
        const starBtn = this.querySelector('.wb-star-btn') as HTMLButtonElement;

        backBtn.addEventListener('click', () => this.goBack());
        forwardBtn.addEventListener('click', () => this.goForward());
        refreshBtn.addEventListener('click', () => this.refresh());
        homeBtn.addEventListener('click', () => this.goHome());
        starBtn.addEventListener('click', () => this.toggleBookmark());

        this.urlInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.isComposing) {
                const sugItems = this.suggestionsEl?.querySelectorAll('.wb-suggestion-item');
                if (this._selectedSuggestionIdx >= 0 && sugItems && sugItems[this._selectedSuggestionIdx]) {
                    (sugItems[this._selectedSuggestionIdx] as HTMLElement).click();
                } else {
                    this.navigateTo(this.urlInput?.value || '');
                }
                this.hideSuggestions();
            } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                this.navigateSuggestions(e.key === 'ArrowDown' ? 1 : -1);
            } else if (e.key === 'Escape') {
                this.hideSuggestions();
            }
        });

        this.urlInput.addEventListener('focus', () => {
            this.urlInput?.select();
        });
    }

    // =====================================================================
    //  URL SUGGESTIONS (history-based autocomplete)
    // =====================================================================

    private bindUrlSuggestions(): void {
        if (!this.urlInput || !this.suggestionsEl) return;

        this.urlInput.addEventListener('input', () => {
            const query = this.urlInput?.value?.trim() || '';
            if (query.length === 0) {
                this.hideSuggestions();
                return;
            }
            this.showSuggestions(query);
        });

        this.urlInput.addEventListener('focus', () => {
            const query = this.urlInput?.value?.trim() || '';
            if (query.length > 0) {
                this.showSuggestions(query);
            }
        });

        this.urlInput.addEventListener('blur', () => {
            this._dismissTimer = setTimeout(() => this.hideSuggestions(), 150);
        });
    }

    private showSuggestions(query: string): void {
        if (!this.suggestionsEl) return;
        const lq = query.toLowerCase();

        const dedupSet = new Set<string>();
        const matches: { url: string; title: string; isBookmark: boolean }[] = [];

        for (const bm of this.bookmarks) {
            if (bm.url.toLowerCase().includes(lq) || bm.title.toLowerCase().includes(lq)) {
                if (!dedupSet.has(bm.url)) {
                    dedupSet.add(bm.url);
                    matches.push({ url: bm.url, title: bm.title, isBookmark: true });
                }
            }
            if (matches.length >= MAX_SUGGESTIONS) break;
        }

        if (matches.length < MAX_SUGGESTIONS) {
            const seen = new Set<string>();
            for (const h of this.history) {
                if (seen.has(h.url)) continue;
                seen.add(h.url);
                if (dedupSet.has(h.url)) continue;
                if (h.url.toLowerCase().includes(lq) || h.title.toLowerCase().includes(lq)) {
                    matches.push({ url: h.url, title: h.title, isBookmark: false });
                    if (matches.length >= MAX_SUGGESTIONS) break;
                }
            }
        }

        if (matches.length === 0) {
            this.hideSuggestions();
            return;
        }

        this._selectedSuggestionIdx = -1;
        this.suggestionsEl.innerHTML = '';
        for (const m of matches) {
            const el = document.createElement('div');
            el.className = 'wb-suggestion-item';
            el.innerHTML = `<span class="wb-sg-icon"><i class="fas ${m.isBookmark ? 'fa-star' : 'fa-clock-rotate-left'}"></i></span>
                <span class="wb-sg-title">${this.escapeHtml(m.title || m.url)}</span>
                <span class="wb-sg-url">${this.escapeHtml(m.url)}</span>`;
            el.addEventListener('mousedown', (e) => {
                e.preventDefault();
                if (this._dismissTimer) {
                    clearTimeout(this._dismissTimer);
                    this._dismissTimer = null;
                }
                this.navigateTo(m.url);
                this.hideSuggestions();
            });
            this.suggestionsEl.appendChild(el);
        }
        this.suggestionsEl.classList.add('wb-visible');
    }

    private hideSuggestions(): void {
        this.suggestionsEl?.classList.remove('wb-visible');
        this._selectedSuggestionIdx = -1;
    }

    private navigateSuggestions(delta: number): void {
        if (!this.suggestionsEl) return;
        const items = this.suggestionsEl.querySelectorAll('.wb-suggestion-item');
        if (items.length === 0) return;

        items.forEach((it) => it.classList.remove('wb-sg-active'));
        this._selectedSuggestionIdx += delta;
        if (this._selectedSuggestionIdx < 0) this._selectedSuggestionIdx = items.length - 1;
        if (this._selectedSuggestionIdx >= items.length) this._selectedSuggestionIdx = 0;
        items[this._selectedSuggestionIdx].classList.add('wb-sg-active');

        const url = items[this._selectedSuggestionIdx].querySelector('.wb-sg-url')?.textContent || '';
        if (this.urlInput && url) {
            this.urlInput.value = url;
        }
    }

    // =====================================================================
    //  TOOL MENU
    // =====================================================================

    private bindToolMenu(): void {
        const button = this.querySelector<HTMLButtonElement>('.wb-menu-btn');
        const menu = this.querySelector<HTMLElement>('.wb-tool-menu');
        if (!button || !menu) return;
        this.toolMenu?.destroy();
        this.browserTools?.destroy();
        this.browserTools = new BrowserTools({
            container: this.webviewContainer!,
            t: (key, params) => this._t(key, params),
            navigateTo: (url) => this.navigateTo(url),
            addTab: (url) => this.addTab(url),
            getWebview: () => (this.getActiveTab()?.ready ? this.getActiveWebview() : null),
            getUserAgent: () => this._cachedUserAgent,
            setUserAgent: (value) => {
                this._cachedUserAgent = value;
            },
            closeMenu: () => this.closeToolMenu(),
            onHistoryChanged: () => {
                this.history = loadHistory();
                this._refreshHistoryViews();
            },
            onBookmarksChanged: () => {
                this.bookmarks = loadBookmarks();
                this.renderBookmarkBar();
                this.syncStarButton();
            }
        });
        this.toolMenu = createBrowserToolMenu({
            button,
            menu,
            t: (key) => createRendererTranslator(this._locale)(key),
            getZoom: () => this._currentZoomFactor,
            setZoom: (factor) => {
                this._currentZoomFactor = factor;
                this._applyZoomToAllWebviews(factor);
            },
            onOpen: () => this.closeAllPanels(),
            onAction: (action) => this.browserTools!.handleAction(action)
        });
    }

    private closeToolMenu(): void {
        this.toolMenu?.close();
    }

    // ---- 辅助方法：调用主进程 browser 应用方法 ----

    private async _loadBrowserConfig(): Promise<void> {
        try {
            const registryAPI = (window as any).applicationRegistryAPI;
            if (!registryAPI?.callMainWorld) return;
            const config = await registryAPI.callMainWorld('browser', 'getConfig');
            if (config && typeof config.userAgent === 'string') {
                this._cachedUserAgent = config.userAgent;
            }
        } catch {
            /* ignore, use default */
        }
    }

    private clearBrowsingData(): void {
        this.browserTools?.clearBrowsingData();
    }

    // =====================================================================
    //  HISTORY
    // =====================================================================

    private addToHistory(url: string, title: string): void {
        if (!url || url === 'about:blank') return;
        this.history.unshift({ url, title: title || url, timestamp: Date.now() });
        if (this.history.length > MAX_HISTORY_ITEMS) {
            this.history.length = MAX_HISTORY_ITEMS;
        }
        saveHistory(this.history);
    }

    private _refreshHistoryViews(): void {
        // Re-render the side panel if visible
        if (this.historyPanelEl?.classList.contains('wb-visible')) {
            const searchInput = this.historyPanelEl.querySelector('.wb-panel-search') as HTMLInputElement;
            this.renderHistoryPanel(searchInput?.value?.trim() || '');
        }

        // Re-render any open internal history tabs
        for (const tab of this.tabs) {
            if (tab.internalUrl?.startsWith('opendesk://history') && tab.wrapEl) {
                const searchInput = tab.wrapEl.querySelector('.wb-hist-search') as HTMLInputElement;
                this.renderHistoryInternalPage(tab.wrapEl, searchInput?.value?.trim());
            }
        }
    }

    private openHistoryPanel(): void {
        this.browserTools?.openHistoryPanel();
    }

    private renderHistoryPanel(filter: string): void {
        this.browserTools?.renderHistoryPanel(filter);
    }

    // =====================================================================
    //  BOOKMARKS
    // =====================================================================

    private isBookmarked(url: string): boolean {
        return this.bookmarks.some((b) => b.url === url);
    }

    private toggleBookmark(): void {
        const tab = this.getActiveTab();
        if (!tab || tab.isHomePage || !tab.url) return;

        const existing = this.bookmarks.findIndex((b) => b.url === tab.url);
        if (existing >= 0) {
            this.bookmarks.splice(existing, 1);
        } else {
            this.bookmarks.push({
                id: generateId(),
                url: tab.url,
                title: tab.title || tab.url,
                createdAt: Date.now()
            });
        }
        saveBookmarks(this.bookmarks);
        this.syncStarButton();
        this.renderBookmarkBar();
    }

    private syncStarButton(): void {
        const starBtn = this.querySelector('.wb-star-btn');
        const tab = this.getActiveTab();
        if (!starBtn || !tab) return;
        starBtn.classList.toggle('wb-star-active', !tab.isHomePage && this.isBookmarked(tab.url));
    }

    private renderBookmarkBar(): void {
        if (!this.bookmarkBarEl) return;

        // Always allow right-click on the bookmark bar (for empty area)
        this.bookmarkBarEl.oncontextmenu = (e: MouseEvent) => {
            if ((e.target as HTMLElement).closest('.wb-bm-item')) return;
            e.preventDefault();
            this.showBookmarkBarContextMenu(e);
        };

        const rootItems = this.bookmarks.filter((b) => !b.parentId);

        if (rootItems.length === 0) {
            this.bookmarkBarEl.innerHTML =
                '<span class="wb-bm-empty">' + this._t('renderer.browser.bar.emptyHint') + '</span>';
            return;
        }
        this.bookmarkBarEl.innerHTML = '';
        for (const bm of rootItems) {
            const el = document.createElement('div');
            el.className = 'wb-bm-item';
            if (bm.isFolder) {
                el.title = bm.title;
                el.innerHTML = `<i class="fas fa-folder"></i><span class="wb-bm-item-label">${this.escapeHtml(bm.title)}</span>`;
                el.addEventListener('click', () => this.showFolderDropdown(bm, el));
            } else {
                el.title = bm.url;
                el.innerHTML = `<i class="fas fa-star"></i><span class="wb-bm-item-label">${this.escapeHtml(bm.title || bm.url)}</span>`;
                el.addEventListener('click', () => this.navigateTo(bm.url));
            }
            el.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.showBookmarkContextMenu(bm, e);
            });
            this.bookmarkBarEl.appendChild(el);
        }
    }

    private showFolderDropdown(folder: BookmarkEntry, anchor: HTMLElement): void {
        const existing = this.querySelector('.wb-bm-folder-dropdown') as HTMLElement;
        existing?.remove();

        const children = this.bookmarks.filter((b) => b.parentId === folder.id && !b.isFolder);
        if (children.length === 0) return;

        const rect = anchor.getBoundingClientRect();
        const dropdown = document.createElement('div');
        dropdown.className = 'wb-bm-folder-dropdown od-browser-menu';
        dropdown.style.cssText = `position:fixed;top:${rect.bottom + 2}px;left:${rect.left}px;
            right:auto;width:auto;background:var(--od-bg-elevated);border:1px solid var(--od-border-strong);border-radius:8px;
            box-shadow:0 4px 16px rgba(0,0,0,0.12);z-index:300;padding:4px 0;min-width:180px;max-width:320px;`;

        for (const child of children) {
            const item = document.createElement('div');
            item.className = 'bm-item';
            item.innerHTML = `<i class="fas fa-star" style="color:#f59e0b"></i><span class="bm-label" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this.escapeHtml(child.title || child.url)}</span>`;
            item.addEventListener('click', () => {
                dropdown.remove();
                this.navigateTo(child.url);
            });
            dropdown.appendChild(item);
        }

        this.appendChild(dropdown);
        const dismiss = () => {
            dropdown.remove();
            document.removeEventListener('click', dismiss);
        };
        setTimeout(() => document.addEventListener('click', dismiss), 0);
    }

    private showBookmarkBarContextMenu(e: MouseEvent): void {
        const existing = this.querySelector('.wb-bm-ctx') as HTMLElement;
        existing?.remove();

        const menu = document.createElement('div');
        menu.className = 'wb-bm-ctx od-browser-menu';
        menu.style.cssText = `position:fixed;top:${e.clientY}px;left:${e.clientX}px;
            right:auto;width:auto;background:var(--od-bg-elevated);border:1px solid var(--od-border-strong);border-radius:8px;
            box-shadow:0 4px 16px rgba(0,0,0,0.12);z-index:300;padding:4px 0;min-width:160px;`;

        menu.innerHTML = `
            <div class="bm-item" data-ctx="addFolder">
                <i class="fas fa-folder-plus"></i>
                <span class="bm-label">${this._t('renderer.browser.fav.addFolder')}</span>
            </div>
            <div class="bm-divider"></div>
            <div class="bm-item" data-ctx="manage">
                <i class="fas fa-gear"></i>
                <span class="bm-label">${this._t('renderer.browser.fav.manage')}</span>
            </div>
        `;

        menu.querySelectorAll('[data-ctx]').forEach((item) => {
            item.addEventListener('click', () => {
                const act = (item as HTMLElement).dataset.ctx;
                menu.remove();
                if (act === 'addFolder') this.addBookmarkFolder();
                else if (act === 'manage') this.openInternalPage('opendesk://favorites/');
            });
        });

        this.appendChild(menu);
        const dismiss = () => {
            menu.remove();
            document.removeEventListener('click', dismiss);
        };
        setTimeout(() => document.addEventListener('click', dismiss), 0);
    }

    private showBookmarkContextMenu(bm: BookmarkEntry, e: MouseEvent): void {
        const existing = this.querySelector('.wb-bm-ctx') as HTMLElement;
        existing?.remove();

        const menu = document.createElement('div');
        menu.className = 'wb-bm-ctx od-browser-menu';
        menu.style.cssText = `position:fixed;top:${e.clientY}px;left:${e.clientX}px;
            right:auto;width:auto;background:var(--od-bg-elevated);border:1px solid var(--od-border-strong);border-radius:8px;
            box-shadow:0 4px 16px rgba(0,0,0,0.12);z-index:300;padding:4px 0;min-width:160px;`;

        const items: string[] = [];
        if (!bm.isFolder) {
            items.push(`
                <div class="bm-item" data-ctx="open">
                    <i class="fas fa-arrow-up-right-from-square"></i>
                    <span class="bm-label">${this._t('renderer.browser.fav.open')}</span>
                </div>
                <div class="bm-item" data-ctx="openNewTab">
                    <i class="fas fa-plus"></i>
                    <span class="bm-label">${this._t('renderer.browser.fav.openInNewTab')}</span>
                </div>
                <div class="bm-divider"></div>`);
        }
        items.push(`
            <div class="bm-item" data-ctx="rename">
                <i class="fas fa-pen"></i>
                <span class="bm-label">${this._t('renderer.browser.modal.edit')}</span>
            </div>
            <div class="bm-item" data-ctx="delete">
                <i class="fas fa-trash-can"></i>
                <span class="bm-label">${this._t('renderer.browser.modal.delete')}</span>
            </div>
            <div class="bm-divider"></div>
            <div class="bm-item" data-ctx="addFolder">
                <i class="fas fa-folder-plus"></i>
                <span class="bm-label">${this._t('renderer.browser.fav.addFolder')}</span>
            </div>
            <div class="bm-divider"></div>
            <div class="bm-item" data-ctx="manage">
                <i class="fas fa-gear"></i>
                <span class="bm-label">${this._t('renderer.browser.fav.manage')}</span>
            </div>`);
        menu.innerHTML = items.join('');

        menu.querySelectorAll('[data-ctx]').forEach((item) => {
            item.addEventListener('click', () => {
                const act = (item as HTMLElement).dataset.ctx;
                menu.remove();
                if (act === 'open') this.navigateTo(bm.url);
                else if (act === 'openNewTab') this.addTab(bm.url);
                else if (act === 'rename') this.renameBookmarkInline(bm);
                else if (act === 'delete') {
                    // Also delete children if it's a folder
                    if (bm.isFolder) {
                        this.bookmarks = this.bookmarks.filter((b) => b.id !== bm.id && b.parentId !== bm.id);
                    } else {
                        this.bookmarks = this.bookmarks.filter((b) => b.id !== bm.id);
                    }
                    saveBookmarks(this.bookmarks);
                    this.renderBookmarkBar();
                } else if (act === 'addFolder') {
                    this.addBookmarkFolder();
                } else if (act === 'manage') {
                    this.openInternalPage('opendesk://favorites/');
                }
            });
        });

        this.appendChild(menu);
        const dismiss = () => {
            menu.remove();
            document.removeEventListener('click', dismiss);
        };
        setTimeout(() => document.addEventListener('click', dismiss), 0);
    }

    private renameBookmarkInline(bm: BookmarkEntry): void {
        const bmItem = Array.from(this.bookmarkBarEl?.children || []).find(
            (el) => (el as HTMLElement).title === bm.url
        ) as HTMLElement | undefined;
        if (!bmItem) return;

        const labelEl = bmItem.querySelector('.wb-bm-item-label') as HTMLElement;
        if (!labelEl) return;

        const input = document.createElement('input');
        input.className = 'wb-bm-edit-input';
        input.value = bm.title;
        input.style.width = '100px';
        labelEl.replaceWith(input);
        input.focus();
        input.select();

        const commit = () => {
            const newTitle = input.value.trim() || bm.url;
            bm.title = newTitle;
            saveBookmarks(this.bookmarks);
            this.renderBookmarkBar();
        };
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.isComposing) {
                e.preventDefault();
                commit();
            }
            if (e.key === 'Escape') {
                this.renderBookmarkBar();
            }
        });
    }

    private addBookmarkFolder(parentId?: string): void {
        const name = prompt(this._t('renderer.browser.fav.newFolderPrompt'));
        if (!name?.trim()) return;
        this.bookmarks.push({
            id: generateId(),
            url: '',
            title: name.trim(),
            createdAt: Date.now(),
            parentId: parentId,
            isFolder: true
        });
        saveBookmarks(this.bookmarks);
        this.renderBookmarkBar();
    }

    private openBookmarkManager(): void {
        this.browserTools?.openBookmarkManager();
    }

    private renderBookmarkManager(filter: string): void {
        this.browserTools?.renderBookmarkManager(filter);
    }

    // =====================================================================
    //  PANELS UTIL
    // =====================================================================

    private closeAllPanels(): void {
        this.browserTools?.closeAllPanels();
    }

    // =====================================================================
    //  DOWNLOAD PANEL
    // =====================================================================

    private toggleDownloadPanel(): void {
        this.browserTools?.toggleDownloadPanel();
    }

    private renderDownloadPanel(): void {
        this.browserTools?.renderDownloadPanel();
    }

    // =====================================================================
    //  HOME PAGE EVENTS
    // =====================================================================

    private bindHomePageEvents(): void {
        // Homepage events are now handled inside renderHomepageInternal
    }

    // =====================================================================
    //  TAB MANAGEMENT
    // =====================================================================

    /** 外部宿主可在组件初始化前调用；URL 会在内部容器就绪后按顺序打开。 */
    public openUrl(url: string): void {
        const target = url.trim();
        if (!target) return;
        if (!this._initialized) {
            this._pendingOpenUrls.push(target);
            return;
        }
        this.addTab(target);
    }

    public addTab(url?: string, openerTabId?: number): number {
        const isInternal = url?.startsWith('opendesk://');
        const isHome = !url && !isInternal;
        const tabId = nextTabId++;

        const tab: BrowserTab = {
            id: tabId,
            title: isInternal ? this.getInternalPageTitle(url!) : this._t('renderer.browser.tab.new'),
            url: url || '',
            webview: null,
            wrapEl: null,
            ready: false,
            pendingUrl: null,
            isHomePage: isHome,
            internalUrl: isInternal ? url : undefined,
            openerTabId
        };

        if (isInternal) {
            this.createInternalPageForTab(tab);
        } else if (!isHome) {
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
        wv.setAttribute('tabindex', '0');
        wv.setAttribute('allowpopups', '');
        wv.setAttribute('partition', 'persist:opendesk-browser');
        wv.setAttribute('webpreferences', 'nodeIntegration=no,autofill=yes');
        if (this._cachedUserAgent) {
            wv.setAttribute('useragent', this._cachedUserAgent);
        }
        wrapEl.appendChild(wv as unknown as Node);
        this.webviewContainer?.appendChild(wrapEl);

        tab.webview = wv;
        tab.wrapEl = wrapEl;
        tab.isHomePage = false;

        this.setupWebviewForTab(tab);
    }

    private ensureTabHasWebview(tab: BrowserTab, url: string): void {
        if (tab.webview) return;

        // Clean up internal page wrapper if present
        if (tab.wrapEl && tab.internalUrl) {
            tab.wrapEl.remove();
            tab.wrapEl = null;
        }
        tab.internalUrl = undefined;

        this.createWebviewForTab(tab, url);
        if (tab.id === this.activeTabId) {
            tab.wrapEl?.classList.add('wb-wv-active');
        }
    }

    public closeTab(tabId: number): void {
        const idx = this.tabs.findIndex((t) => t.id === tabId);
        if (idx === -1) return;

        const closingTab = this.tabs[idx];

        // 通知 opener tab：弹窗已关闭（更新 proxy.closed 并触发事件）
        if (closingTab.openerTabId != null) {
            this.notifyOpenerPopupClosed(closingTab.openerTabId, closingTab.url);
        }

        // 清理定时器
        const timer = this._cleanupTimers.get(tabId);
        if (timer) {
            clearTimeout(timer);
            this._cleanupTimers.delete(tabId);
        }

        if (this.tabs.length === 1) {
            const onlyTab = this.tabs[0];
            this.hideTabLoading(onlyTab);
            try {
                (onlyTab.webview as any)?.closeDevTools?.();
            } catch {
                /* ignore */
            }
            if (onlyTab.webview) {
                onlyTab.wrapEl?.remove();
                onlyTab.webview = null;
                onlyTab.wrapEl = null;
            } else if (onlyTab.wrapEl) {
                onlyTab.wrapEl.remove();
                onlyTab.wrapEl = null;
            }
            onlyTab.url = 'opendesk://homepage/';
            onlyTab.title = this._t('renderer.browser.tab.new');
            onlyTab.isHomePage = false;
            onlyTab.internalUrl = 'opendesk://homepage/';
            onlyTab.ready = false;

            this.createInternalPageForTab(onlyTab);
            onlyTab.wrapEl?.classList.add('wb-wv-active');

            this.renderTabBar();
            this.syncUrlBar();
            this.syncStarButton();
            this.updateHomePageVisibility();
            return;
        }

        const tab = this.tabs[idx];
        this.hideTabLoading(tab);
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
        if (tabId !== this.activeTabId) this.browserTools?.closeAllPanels();
        const tab = this.tabs.find((t) => t.id === tabId);
        if (!tab) return;

        // 取消新标签的清理定时器（如果有）
        const existingTimer = this._cleanupTimers.get(tabId);
        if (existingTimer) {
            clearTimeout(existingTimer);
            this._cleanupTimers.delete(tabId);
        }

        // 确保新标签有 webview（懒加载）
        if (!tab.webview && !tab.isHomePage && !tab.internalUrl && tab.url) {
            this.createWebviewForTab(tab, tab.url);
        }

        // 更新活跃时间
        tab.lastActiveTime = Date.now();

        // 记录旧标签ID，用于启动清理定时器
        const prevTabId = this.activeTabId;

        this.activeTabId = tabId;

        for (const t of this.tabs) {
            t.wrapEl?.classList.toggle('wb-wv-active', t.id === tabId);
        }

        // 为旧标签启动延迟清理定时器
        if (prevTabId !== tabId && prevTabId !== -1) {
            const prevTab = this.tabs.find((t) => t.id === prevTabId);
            if (prevTab && prevTab.webview && prevTab.lastActiveTime) {
                this.scheduleWebviewCleanup(prevTab);
            }
        }

        this.syncUrlBar();
        this.syncNavButtons();
        this.syncStarButton();
        this.updateHomePageVisibility();
        this.renderTabBar();
    }

    private scheduleWebviewCleanup(tab: BrowserTab): void {
        const existing = this._cleanupTimers.get(tab.id);
        if (existing) clearTimeout(existing);

        const timer = setTimeout(() => {
            this._cleanupTimers.delete(tab.id);
            // 只有当前不是活跃标签才销毁
            if (tab.webview && tab.id !== this.activeTabId) {
                try {
                    (tab.webview as any).closeDevTools?.();
                } catch {
                    /* ignore */
                }
                tab.webview.remove();
                tab.webview = null;
                tab.wrapEl?.remove();
                tab.wrapEl = null;
                tab.ready = false;
            }
        }, BrowserEntryWidget.CLEANUP_DELAY_MS);
        this._cleanupTimers.set(tab.id, timer);
    }

    private getActiveTab(): BrowserTab | undefined {
        return this.tabs.find((t) => t.id === this.activeTabId);
    }

    private getActiveWebview(): WebviewTag | null {
        return this.getActiveTab()?.webview ?? null;
    }

    /**
     * Focus the active guest webview so browser-managed keyboard behavior stays
     * in the page instead of falling through to the OpenDesk application UI.
     */
    public focusActiveWebview(): boolean {
        const webview = this.getActiveWebview();
        if (!webview) return false;
        try {
            (webview as unknown as HTMLElement).focus({ preventScroll: true });
            return true;
        } catch {
            return false;
        }
    }

    // =====================================================================
    //  TAB BAR RENDERING
    // =====================================================================

    private renderTabBar(): void {
        if (!this.tabBarInner) return;

        this.tabBarInner.innerHTML = '';
        for (const tab of this.tabs) {
            const el = document.createElement('div');
            el.className = 'wb-tab-item' + (tab.id === this.activeTabId ? ' wb-tab-active' : '');
            el.dataset.tabId = String(tab.id);

            const titleSpan = document.createElement('span');
            titleSpan.className = 'wb-tab-title';
            titleSpan.textContent = tab.title || this._t('renderer.browser.tab.new');
            titleSpan.title = tab.url || this._t('renderer.browser.tab.new');
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

    // =====================================================================
    //  WEBVIEW SETUP PER TAB
    // =====================================================================

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

        // 慢加载页面在导航 commit 前会一直停留在旧页面上，这里在主框架导航
        // 开始时显示加载中遮罩给出反馈。不用 did-start-loading：它对 iframe
        // 等子框架加载也会触发，广告轮换等周期性子框架刷新会让已加载完的
        // 页面反复闪现加载遮罩；同文档导航（pushState/hash）也不需要遮罩。
        wv.addEventListener('did-start-navigation', (event: any) => {
            if (event.isMainFrame && !event.isInPlace) {
                this.showTabLoading(tab);
            }
        });
        wv.addEventListener('did-stop-loading', () => {
            this.hideTabLoading(tab);
        });

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
            // 导航 commit 后页面内容已开始渲染，立即撤掉加载遮罩，
            // 避免把已经显示出来的部分内容盖住（did-stop-loading 要等全部资源完成）
            this.hideTabLoading(tab);
            // 成功导航时清除错误状态
            if (tab.errorInfo) {
                tab.errorInfo = undefined;
            }
            tab.url = event.url;
            this.updateTabTitle(tab);
            this.addToHistory(event.url, tab.title);
            if (tab.id === this.activeTabId) {
                this.syncUrlBar();
                this.updateLockIcon(tab.url);
                this.syncStarButton();
            }
            if (tab.ready) this.syncNavButtons();
            // 新页面加载后重新注入 window.open proxy 和 opener 桥接
            this.injectWindowOpenProxy(wv);
            this.injectOpenerBridge(tab);
        });

        wv.addEventListener('did-navigate-in-page', (event: any) => {
            // 页内导航发生在已渲染的文档内，同样立即撤掉加载遮罩
            this.hideTabLoading(tab);
            tab.url = event.url;
            if (tab.id === this.activeTabId) {
                this.syncUrlBar();
                this.updateLockIcon(tab.url);
                this.syncStarButton();
            }
            if (tab.ready) this.syncNavButtons();
        });

        wv.addEventListener('page-title-updated', (event: any) => {
            tab.title = event.title || this.extractTitle(tab.url);
            this.renderTabBar();
            /* Also update the history entry title for the most recent matching URL */
            if (tab.url && event.title) {
                const hEntry = this.history.find((h) => h.url === tab.url);
                if (hEntry) {
                    hEntry.title = event.title;
                    saveHistory(this.history);
                }
            }
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
                return;
            }
            // 导航劫持 workaround：guest 内同窗口导航被框架层静默中止，
            // 页面脚本将导航转为信令，这里对来源 tab 用 loadURL 完成。
            if (msg.startsWith(NAV_INTERCEPT_CONSOLE_PREFIX)) {
                const url = msg.slice(NAV_INTERCEPT_CONSOLE_PREFIX.length);
                if (url && /^https?:\/\//.test(url)) {
                    this.navigateTo(url, tab);
                }
            }
        });

        wv.addEventListener('did-fail-load', (event: any) => {
            const { errorCode, errorDescription, validatedURL, isMainFrame } = event;
            // 忽略子资源加载失败和非真正的错误
            if (!isMainFrame) return;
            // 无论何种失败（含 ERR_ABORTED 主动中断），加载都不会再 commit，撤掉遮罩
            this.hideTabLoading(tab);
            if (errorCode === -3) return; // ERR_ABORTED：用户主动导航中断

            const userMessage = getErrorMessage(errorDescription);
            tab.errorInfo = {
                code: errorCode,
                description: errorDescription,
                url: validatedURL || tab.url,
                userMessage
            };

            // 更新 tab 标题显示错误
            tab.title = this.extractTitle(validatedURL || tab.url) + this._t('renderer.browser.tab.loadFailedSuffix');
            this.renderTabBar();

            // 显示错误覆盖层
            this.injectErrorPage(tab);

            // 同步地址栏显示失败的 URL
            if (tab.id === this.activeTabId) {
                this.syncUrlBar();
                this.syncStarButton();
            }
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
     * 延迟显示加载中遮罩：加载开始后 LOADING_OVERLAY_DELAY_MS 内完成的
     * 页面不会闪烁遮罩，慢页面则会在旧内容上叠加明确的加载反馈。
     */
    private showTabLoading(tab: BrowserTab): void {
        if (tab.loadingTimer != null) return;
        tab.loadingTimer = setTimeout(() => {
            tab.loadingTimer = null;
            const wrap = tab.wrapEl;
            if (!wrap || wrap.querySelector('.wb-loading-overlay')) return;
            const overlay = document.createElement('div');
            overlay.className = 'wb-loading-overlay';
            const loadingView = document.createElement('content-loading-view');
            loadingView.setAttribute('data-message', this._t('renderer.browser.loading'));
            overlay.appendChild(loadingView);
            wrap.appendChild(overlay);
        }, LOADING_OVERLAY_DELAY_MS);
    }

    /** 取消未触发的加载遮罩定时器并移除已显示的遮罩 */
    private hideTabLoading(tab: BrowserTab): void {
        if (tab.loadingTimer != null) {
            clearTimeout(tab.loadingTimer);
            tab.loadingTimer = null;
        }
        tab.wrapEl?.querySelector('.wb-loading-overlay')?.remove();
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
     * 当弹窗 tab 关闭时，通知 opener tab 更新 proxy.closed
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
                .catch(() => {});
        } catch {
            /* ignore */
        }
    }

    private extractTitle(url: string): string {
        if (!url || url === 'about:blank') return this._t('renderer.browser.tab.new');
        try {
            const u = new URL(url);
            return u.hostname || url;
        } catch {
            return url.slice(0, 30);
        }
    }

    // =====================================================================
    //  HOME PAGE VISIBILITY
    // =====================================================================

    private updateHomePageVisibility(): void {
        // Legacy homepage container is no longer used;
        // homepage is now rendered as an internal page in the tab's wrapEl.
        this.homePageContainer?.classList.add('wb-hidden');
    }

    // =====================================================================
    //  SYNC HELPERS
    // =====================================================================

    private syncUrlBar(): void {
        const tab = this.getActiveTab();
        if (this.urlInput && tab) {
            if (tab.internalUrl === 'opendesk://homepage/') {
                this.urlInput.value = '';
            } else if (tab.internalUrl) {
                this.urlInput.value = tab.internalUrl;
            } else {
                this.urlInput.value = tab.isHomePage ? '' : tab.url || '';
            }
            this.updateLockIcon(tab.internalUrl ? '' : tab.isHomePage ? '' : tab.url);
        }
        this.scheduleHintsRefresh();
    }

    // =====================================================================
    //  页面提示（Browser Hints）
    // =====================================================================

    /**
     * 延迟刷新地址栏的页面提示：导航过程 URL 可能连续变化，
     * 防抖后只对最终页面发起一次 hint 匹配。
     */
    private scheduleHintsRefresh(): void {
        if (this._hintRefreshTimer !== null) {
            clearTimeout(this._hintRefreshTimer);
        }
        this._hintRefreshTimer = setTimeout(() => {
            this._hintRefreshTimer = null;
            void this.refreshHints();
        }, 250);
    }

    private async refreshHints(): Promise<void> {
        const seq = ++this._hintSeq;
        const tab = this.getActiveTab();
        const url = tab?.url || '';
        // hint 的 pattern 只对 http(s) 页面有意义，内部页与空白页直接清空
        if (!/^https?:/i.test(url)) {
            this._lastHintKey = '';
            this.hintPanel?.setHints([]);
            return;
        }
        const key = `${tab?.id ?? ''}|${url}`;
        if (key === this._lastHintKey) return;

        let webContentsId: number | undefined;
        try {
            webContentsId = (tab?.webview as any)?.getWebContentsId();
        } catch {
            webContentsId = undefined;
        }

        try {
            const hints = await fetchBrowserHintsForPage({ url, title: tab?.title, webContentsId });
            if (seq !== this._hintSeq) return;
            this._lastHintKey = key;
            this.hintPanel?.setHints(hints);
        } catch {
            // hint 属于附加信息：拉取失败按无提示处理，等待下次导航再重试
            if (seq !== this._hintSeq) return;
            this.hintPanel?.setHints([]);
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

    // =====================================================================
    //  NAVIGATION
    // =====================================================================

    public navigateTo(input: string, targetTab?: BrowserTab): void {
        const raw = input.trim();
        if (!raw) return;

        // 指定 targetTab 时对指定 tab 导航（导航拦截信令可能来自后台 tab），
        // 否则对当前活跃 tab 导航；UI 同步仍基于活跃 tab。
        const tab = targetTab ?? this.getActiveTab();
        if (!tab) return;

        const targetUrl = this.normalizeUrl(raw);
        if (!targetUrl) return;

        // 用户主动导航时清除错误状态
        if (tab.errorInfo) {
            tab.errorInfo = undefined;
        }

        // Handle opendesk:// internal pages
        if (targetUrl.startsWith('opendesk://')) {
            this.openInternalPage(targetUrl);
            return;
        }

        const wasCreated = !tab.webview;
        // 如果当前 tab 还是主页，需要创建 webview
        this.ensureTabHasWebview(tab, targetUrl);

        tab.isHomePage = false;
        tab.internalUrl = undefined;
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
        this.syncStarButton();
        this.updateHomePageVisibility();
    }

    /**
     * 将用户输入规范化为有效 URL：
     * - 已有协议 → 保持不变
     * - 本地绝对路径（以 / 开头）→ 添加 file://
     * - 看起来像域名（含点号且无空格）→ 添加 https://
     * - 其他 → 作为搜索关键词
     */
    private normalizeUrl(raw: string): string | null {
        if (!raw) return null;
        if (/^opendesk:\/\//.test(raw)) return raw;
        if (/^(https?|about|file|data):/.test(raw)) return raw;
        if (/^\//.test(raw)) return `file://${raw}`;
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

        // If already on homepage, do nothing
        if (tab.internalUrl === 'opendesk://homepage/') return;

        tab.isHomePage = false;
        tab.internalUrl = 'opendesk://homepage/';
        tab.url = 'opendesk://homepage/';
        tab.title = this._t('renderer.browser.tab.new');
        tab.errorInfo = undefined;
        tab.pendingUrl = null;
        tab.ready = false;

        // 彻底销毁当前 webview 及其 wrapper。主页 DOM 会整体覆写 wrapEl 内容，
        // 若保留 tab.webview 的脏引用，后续 navigateTo 会对已脱离文档的
        // webview 调 loadURL，表现为地址栏更新但页面不导航。
        this.hideTabLoading(tab);
        try {
            (tab.webview as any)?.closeDevTools?.();
        } catch {
            /* ignore */
        }
        if (tab.wrapEl) {
            tab.wrapEl.remove();
            tab.wrapEl = null;
        }
        tab.webview = null;

        this.createInternalPageForTab(tab);
        tab.wrapEl?.classList.add('wb-wv-active');

        this.syncUrlBar();
        this.syncNavButtons();
        this.syncStarButton();
        this.updateHomePageVisibility();
        this.renderTabBar();
    }

    // =====================================================================
    //  INTERNAL PAGES (opendesk://)
    // =====================================================================

    private getInternalPageTitle(url: string): string {
        if (url.startsWith('opendesk://favorites')) return this._t('renderer.browser.fav.manageTitle');
        if (url.startsWith('opendesk://history')) return this._t('renderer.browser.history.title');
        if (url.startsWith('opendesk://homepage')) return this._t('renderer.browser.tab.new');
        return 'OpenDesk';
    }

    private openInternalPage(url: string): void {
        // Homepage tabs are not deduplicated — each new tab gets its own
        if (url !== 'opendesk://homepage/') {
            const existing = this.tabs.find((t) => t.internalUrl === url);
            if (existing) {
                this.switchToTab(existing.id);
                return;
            }
        }
        this.addTab(url);
    }

    private createInternalPageForTab(tab: BrowserTab): void {
        const wrapEl = document.createElement('div');
        wrapEl.className = 'wb-webview-wrap';
        wrapEl.dataset.tabId = String(tab.id);
        this.webviewContainer?.appendChild(wrapEl);
        tab.wrapEl = wrapEl;
        tab.isHomePage = false;

        this.renderInternalPage(tab);
    }

    private renderInternalPage(tab: BrowserTab): void {
        if (!tab.wrapEl || !tab.internalUrl) return;
        tab.wrapEl.innerHTML = '';

        if (tab.internalUrl.startsWith('opendesk://favorites')) {
            this.renderFavoritesPage(tab.wrapEl);
        } else if (tab.internalUrl.startsWith('opendesk://history')) {
            this.renderHistoryInternalPage(tab.wrapEl);
        } else if (tab.internalUrl.startsWith('opendesk://homepage')) {
            this.renderHomepageInternal(tab.wrapEl, tab);
        } else if (tab.internalUrl.startsWith('opendesk://browser-settings')) {
            this.renderBrowserSettingsPage(tab.wrapEl);
        } else {
            tab.wrapEl.innerHTML =
                '<div class="wb-internal-page"><div class="wb-internal-header"><span class="wb-internal-title">' +
                this._t('renderer.browser.internal.pageNotFound') +
                '</span></div></div>';
        }
    }

    // ---- Homepage ----

    private renderHomepageInternal(container: HTMLElement, tab: BrowserTab): void {
        // Compute top sites from history
        const domainVisits = new Map<string, { count: number; title: string; url: string }>();
        for (const h of this.history) {
            try {
                const u = new URL(h.url);
                const domain = u.hostname;
                const existing = domainVisits.get(domain);
                if (existing) {
                    existing.count++;
                    if (!existing.title || existing.title === domain) existing.title = h.title || domain;
                } else {
                    domainVisits.set(domain, { count: 1, title: h.title || domain, url: u.origin });
                }
            } catch {
                /* skip invalid */
            }
        }

        const topSites = [...domainVisits.entries()]
            .sort((a, b) => b[1].count - a[1].count)
            .slice(0, 5)
            .map(([domain, info]) => ({ domain, ...info }));

        // Palette of soft background colors for site tiles
        const tileColors = ['#e0f2fe', '#fce7f3', '#d1fae5', '#fef3c7', '#ede9fe', '#fee2e2', '#dbeafe', '#f0fdf4'];

        const greeting = this.getGreeting();

        const topSitesHtml =
            topSites.length > 0
                ? topSites
                      .map((s, i) => {
                          const bgColor = tileColors[i % tileColors.length];
                          const initial = s.domain
                              .replace(/^www\./, '')
                              .charAt(0)
                              .toUpperCase();
                          const faviconUrl = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(s.domain)}&sz=64`;
                          return `<div class="wb-hp-tile" data-url="${this.escapeAttr(s.url)}" title="${this.escapeAttr(s.domain)}">
                    <div class="wb-hp-tile-icon" style="background:${bgColor}">
                        <img src="${faviconUrl}" onerror="this.style.display='none';this.parentElement.textContent='${initial}';this.parentElement.style.color='#6b7280';this.parentElement.style.fontSize='18px';this.parentElement.style.fontWeight='600'">
                    </div>
                    <span class="wb-hp-tile-label">${this.escapeHtml(s.title || s.domain)}</span>
                </div>`;
                      })
                      .join('')
                : '';

        container.innerHTML = `<div class="wb-hp">
            <div class="wb-hp-hero">
                <div class="wb-hp-greeting">${this.escapeHtml(greeting)}</div>
                <div class="wb-hp-search-wrap">
                    <i class="fas fa-magnifying-glass wb-hp-search-icon"></i>
                    <input type="text" class="wb-hp-search-input" placeholder="${this._t('renderer.browser.newtab.searchPlaceholder')}" autofocus>
                </div>
            </div>
            ${
                topSitesHtml
                    ? `<div class="wb-hp-section">
                <div class="wb-hp-section-title">${this._t('renderer.browser.newtab.topSites')}</div>
                <div class="wb-hp-grid">${topSitesHtml}</div>
            </div>`
                    : ''
            }
        </div>`;

        // Bind search
        const searchInput = container.querySelector('.wb-hp-search-input') as HTMLInputElement;
        searchInput?.addEventListener('keydown', (e) => {
            // 检测 isComposing，避免输入法选字时误触发导航
            if (e.key === 'Enter' && !e.isComposing && searchInput.value.trim()) {
                e.preventDefault();
                this.navigateTo(searchInput.value.trim());
            }
        });
        // 使用 requestAnimationFrame 确保焦点设置更可靠
        requestAnimationFrame(() => {
            requestAnimationFrame(() => searchInput?.focus());
        });

        // Bind tiles
        container.querySelectorAll('.wb-hp-tile').forEach((el) => {
            el.addEventListener('click', () => {
                const url = (el as HTMLElement).dataset.url;
                if (url) this.navigateTo(url);
            });
        });
    }

    private getGreeting(): string {
        const hour = new Date().getHours();
        if (hour < 6) return this._t('renderer.browser.newtab.greeting.night');
        if (hour < 12) return this._t('renderer.browser.newtab.greeting.morning');
        if (hour < 14) return this._t('renderer.browser.newtab.greeting.noon');
        if (hour < 18) return this._t('renderer.browser.newtab.greeting.afternoon');
        return this._t('renderer.browser.newtab.greeting.evening');
    }

    // ---- Favorites management page ----

    private renderFavoritesPage(container: HTMLElement, selectedFolderId?: string, searchFilter?: string): void {
        this.browserTools?.renderFavoritesPage(container, selectedFolderId, searchFilter);
    }

    // ---- History management page ----

    private renderHistoryInternalPage(container: HTMLElement, searchFilter?: string): void {
        this.browserTools?.renderHistoryInternalPage(container, searchFilter);
    }

    // =====================================================================
    //  ERROR PAGE INJECTION
    // =====================================================================

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

    // =====================================================================
    //  UTILITY
    // =====================================================================

    // ---- Browser Settings Page ----

    private renderBrowserSettingsPage(container: HTMLElement): void {
        this.browserTools?.renderBrowserSettingsPage(container);
    }

    private escapeHtml(str: string): string {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    private escapeAttr(str: string): string {
        return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
}

customElements.define('browser-entry-widget', BrowserEntryWidget);
