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
import {
    WINDOW_OPEN_PROXY_SCRIPT,
    OPENER_BRIDGE_SCRIPT,
    NOTIFY_POPUP_CLOSED_SCRIPT,
    NAV_INTERCEPT_CONSOLE_PREFIX
} from './webviewScripts';
import { createRendererTranslator } from './locale.js';
import { showConfirmModal, showInfoModal } from './components/confirmModal.js';
import {
    createBrowserHintPanel,
    fetchBrowserHintsForPage,
    type BrowserHintPanelHandle
} from './components/browserHintPanel.js';
// 注册 <content-loading-view> 加载中组件，用于页面加载反馈
import './components/loading.js';

export type { BrowserState, TabInfo };

export interface BrowserRestoreState {
    tabs: Array<{ url: string; title: string }>;
    activeIndex: number;
}

const HOME_PAGE = 'about:blank';
const fallbackT = createRendererTranslator();
// 页面加载指示器的延迟显示时间：快速加载的页面不闪烁 loading 遮罩
const LOADING_OVERLAY_DELAY_MS = 300;

function browserT(key: string): string {
    const runtimeTranslator = (window as any).__odT;
    return typeof runtimeTranslator === 'function' ? runtimeTranslator(key) : fallbackT(key);
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
    errorInfo?: ErrorInfo;
    /** 若此 tab 由弹窗产生，记录打开它的父 tab ID */
    openerTabId?: number;
    /** 加载指示器延迟显示的定时器句柄 */
    loadingTimer?: ReturnType<typeof setTimeout> | null;
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
    private _isPreviewMode: boolean = false;

    private tabs: BrowserTab[] = [];
    private activeTabId: number = -1;
    private _currentZoomFactor: number = 1;
    private _removeZoomListener: (() => void) | null = null;
    private _resizeObserver: ResizeObserver | null = null;
    private readonly _restoreState?: BrowserRestoreState;
    private static readonly VIRTUAL_WIDTH = 1280;
    private static readonly VIRTUAL_HEIGHT = 800;
    /** 画中画模式下固定视口高度（16:9，即 1280x720），避免窄高容器把截图拉长 */
    private static readonly VIEWPORT_FIXED_HEIGHT = 720;
    /** 画中画显示时固定视口为 16:9；侧边栏展开恢复正常自适应 */
    private _fixedViewport = false;

    // 页面提示（Browser Hints）面板状态
    private hintPanel: BrowserHintPanelHandle | null = null;
    private _hintRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    private _hintSeq: number = 0;
    private _lastHintKey: string = '';

    /**
     * Resize burst detection — during active window resize we skip ALL
     * DOM work and only apply scaling once after resize has settled.
     * This eliminates the per-frame compositing cost entirely.
     */
    private _pendingResize: { width: number; height: number } | null = null;
    private _resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly _focusTrapKeydown = (event: KeyboardEvent) => this.handleFocusTrapKeydown(event);

    constructor(container: HTMLElement, id: string = '', restoreState?: BrowserRestoreState) {
        super(id);
        this.container = container;
        this._restoreState = restoreState;
        this.container.setAttribute('data-od-browser-focus-scope', '');
        this._initZoomSync();
        this._initVisibilityHandler();
        this.init();
        this.container.addEventListener('keydown', this._focusTrapKeydown);
    }

    /**
     * 监听窗口可见性变化，隐藏时降低 webview 刷新率以省电。
     */
    private _initVisibilityHandler(): void {
        const ipcRenderer = (window as any).__ipcRenderer;
        if (!ipcRenderer) return;

        const onVisibilityChanged = (_event: any, visible: boolean) => {
            for (const tab of this.tabs) {
                if (!tab.webview) continue;
                try {
                    if (visible) {
                        // 恢复渲染：设置正帧率
                        tab.webview.setWindowOpenHandler(null);
                    } else {
                        // 隐藏时不做额外操作，浏览器 webview 已关闭 backgroundThrottling 保持全速渲染
                    }
                } catch {
                    /* ignore */
                }
            }
        };

        // 通过 DOM custom event 方式接收，避免直接依赖 ipcRenderer
        window.addEventListener('openDesk:visibilityChanged', ((e: CustomEvent) => {
            onVisibilityChanged(null, e.detail);
        }) as EventListener);
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
        if (!this.container) return [];
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
        return Array.from(this.container.querySelectorAll<HTMLElement>(selector)).filter((el) =>
            this.isFocusableElement(el)
        );
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

            /* ---- Tab bar (macOS pill style) ---- */
            .bw-tabbar {
                display: flex; align-items: center;
                background: #f3f4f6;
                border-bottom: 1px solid #e5e7eb;
                flex-shrink: 0;
                min-height: 36px;
                padding: 2px 8px 2px 2px;
                gap: 0;
            }
            .bw-tabbar-inner {
                display: flex; align-items: center;
                /* flex: 0 1 auto：标签未满时收缩为内容宽度，让加号紧跟最后一个标签；
                   满溢时被压到可用宽度上限触发横向滚动，加号锁定在最右侧 */
                flex: 0 1 auto; min-width: 0;
                overflow-x: auto;
                overflow-y: hidden;
                scrollbar-width: none;
                gap: 4px;
                padding: 4px 8px;
            }
            .bw-tabbar-inner::-webkit-scrollbar { display: none; }
            .bw-tab-item {
                display: flex; align-items: center;
                gap: 4px;
                height: 26px;
                padding: 0 10px;
                font-size: var(--fs-md);
                color: #6b7280;
                background: transparent;
                border: none;
                border-radius: 8px;
                cursor: pointer;
                white-space: nowrap;
                max-width: 150px;
                min-width: 60px;
                flex-shrink: 0;
                transition: all 0.15s;
                position: relative;
                justify-content: center;
            }
            .bw-tab-item:hover { background: rgba(0,0,0,0.05); color: #374151; }
            .bw-tab-item.bw-tab-active {
                background: white;
                color: #1f2937;
                font-weight: 500;
                box-shadow: 0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04);
            }
            /* 非选中标签之间的竖线分隔 */
            .bw-tab-item:not(.bw-tab-active):not(:first-child)::before {
                content: '';
                position: absolute;
                left: 0;
                top: 50%;
                transform: translateY(-50%);
                width: 1px;
                height: 14px;
                background: #d1d5db;
            }
            .bw-tab-title {
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                pointer-events: none;
                flex: 1; min-width: 0;
                text-align: center;
            }
            .bw-tab-close {
                width: 16px; height: 16px;
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
            .bw-tab-item:hover .bw-tab-close,
            .bw-tab-item.bw-tab-active .bw-tab-close { opacity: 0.7; }
            .bw-tab-close:hover { background: rgba(0,0,0,0.1); color: #333; opacity: 1 !important; }
            .bw-tab-add-btn {
                width: 26px; height: 26px;
                border: none; background: #e5e7eb;
                color: #6b7280; cursor: pointer;
                display: flex; align-items: center; justify-content: center;
                flex-shrink: 0;
                border-radius: 8px;
                margin-left: 8px;
                font-size: var(--fs-md);
                transition: all 0.15s;
            }
            .bw-tab-add-btn:hover { background: #d1d5db; color: #374151; }
            .bw-tab-add-btn:active { background: #c1c5cb; }

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
                font-size: var(--fs-sm); flex-shrink: 0;
            }
            .bw-btn:hover { background: #f3f4f6; color: #374151; }
            .bw-btn:active { background: #e5e7eb; }
            .bw-btn.disabled { opacity: 0.35; cursor: default; pointer-events: none; }
            .bw-exit-preview-btn {
                width: auto;
                padding: 0 6px;
                gap: 4px;
            }
            .bw-exit-preview-label {
                font-size: var(--fs-sm);
                white-space: nowrap;
            }
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
            .bw-lock { color: #10b981; flex-shrink: 0; font-size: var(--fs-xs); }
            .bw-url-input {
                flex: 1; min-width: 0;
                border: none; background: transparent; outline: none;
                font-size: var(--fs-sm); color: #1f2937;
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
                width: 260px;
                background: white;
                border: 1px solid #e5e7eb;
                border-radius: 10px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.12);
                z-index: 200;
                padding: 6px 0;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            }
            .bw-tool-menu.bw-visible { display: block; }
            .bw-tm-item {
                display: flex; align-items: center; gap: 10px;
                padding: 8px 16px;
                font-size: var(--fs-base); color: #374151;
                cursor: pointer;
                transition: background 0.1s;
            }
            .bw-tm-item:hover { background: #f3f4f6; }
            .bw-tm-item i { width: 16px; text-align: center; color: #6b7280; font-size: var(--fs-base); }
            .bw-tm-label { flex: 1; }
            .bw-tm-shortcut { color: #9ca3af; font-size: var(--fs-sm); }
            .bw-tm-divider {
                height: 1px; background: #f0f0f0; margin: 4px 0;
            }
            .bw-tm-zoom-row {
                display: flex; align-items: center; gap: 6px;
                padding: 6px 16px;
                font-size: var(--fs-base); color: #374151;
            }
            .bw-tm-zoom-row i { width: 16px; text-align: center; color: #6b7280; font-size: var(--fs-base); }
            .bw-tm-zoom-label { flex: 1; }
            .bw-tm-zoom-controls {
                display: flex; align-items: center; gap: 4px;
            }
            .bw-tm-zoom-btn {
                width: 24px; height: 24px; border-radius: 4px;
                border: 1px solid #e5e7eb; background: white;
                cursor: pointer; display: flex; align-items: center; justify-content: center;
                font-size: var(--fs-sm); color: #6b7280;
                transition: background 0.1s;
            }
            .bw-tm-zoom-btn:hover { background: #f3f4f6; }
            .bw-tm-zoom-val { font-size: var(--fs-md); min-width: 36px; text-align: center; }

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
            .bw-loading-overlay {
                position: absolute; top: 0; left: 0;
                width: 100%; height: 100%;
                display: flex; align-items: center; justify-content: center;
                background: #ffffff;
                z-index: 10;
                pointer-events: none;
                animation: bw-loading-fade-in 0.2s ease;
            }
            @keyframes bw-loading-fade-in {
                from { opacity: 0; }
                to { opacity: 1; }
            }
            .bw-sep {
                width: 1px; height: 14px;
                background: #e5e7eb; margin: 0 1px; flex-shrink: 0;
            }

            /* ---- Dark mode ---- */
            :host([data-theme="dark"]) .bw {
                background: #1e1e1e !important;
            }
            :host([data-theme="dark"]) .bw-tabbar {
                background: #252526 !important;
                border-bottom-color: rgba(255, 255, 255, 0.12) !important;
            }
            :host([data-theme="dark"]) .bw-tab-item {
                color: #ababab !important;
            }
            :host([data-theme="dark"]) .bw-tab-item:hover {
                background: rgba(255, 255, 255, 0.08) !important;
                color: #cccccc !important;
            }
            :host([data-theme="dark"]) .bw-tab-item.bw-tab-active {
                background: #1e1e1e !important;
                color: #e4e4e4 !important;
                box-shadow: 0 1px 3px rgba(0,0,0,0.35), 0 1px 2px rgba(0,0,0,0.2) !important;
            }
            :host([data-theme="dark"]) .bw-tab-item:not(.bw-tab-active):not(:first-child)::before {
                background: rgba(255, 255, 255, 0.1) !important;
            }
            :host([data-theme="dark"]) .bw-tab-close {
                color: #787878 !important;
            }
            :host([data-theme="dark"]) .bw-tab-close:hover {
                background: rgba(255, 255, 255, 0.12) !important;
                color: #cccccc !important;
            }
            :host([data-theme="dark"]) .bw-tab-add-btn {
                background: #333333 !important;
                color: #ababab !important;
            }
            :host([data-theme="dark"]) .bw-tab-add-btn:hover {
                background: #3f3f46 !important;
                color: #cccccc !important;
            }
            :host([data-theme="dark"]) .bw-tab-add-btn:active {
                background: #4a4a4d !important;
            }
            :host([data-theme="dark"]) .bw-toolbar {
                background: #252526 !important;
                border-bottom-color: rgba(255, 255, 255, 0.12) !important;
            }
            :host([data-theme="dark"]) .bw-btn {
                color: #ababab !important;
            }
            :host([data-theme="dark"]) .bw-btn:hover {
                background: #333333 !important;
                color: #cccccc !important;
            }
            :host([data-theme="dark"]) .bw-btn:active {
                background: #3f3f46 !important;
            }
            :host([data-theme="dark"]) .bw-url-wrap {
                background: #1e1e1e !important;
                border-color: rgba(255, 255, 255, 0.12) !important;
            }
            :host([data-theme="dark"]) .bw-url-wrap:focus-within {
                border-color: #93c5fd !important;
                box-shadow: 0 0 0 2px rgba(59,130,246,0.2) !important;
            }
            :host([data-theme="dark"]) .bw-url-input {
                color: #cccccc !important;
            }
            :host([data-theme="dark"]) .bw-url-input::placeholder {
                color: #787878 !important;
            }
            :host([data-theme="dark"]) .bw-tool-menu {
                background: #252526 !important;
                border-color: rgba(255, 255, 255, 0.12) !important;
                box-shadow: 0 8px 24px rgba(0,0,0,0.5) !important;
            }
            :host([data-theme="dark"]) .bw-tm-item {
                color: #cccccc !important;
            }
            :host([data-theme="dark"]) .bw-tm-item:hover {
                background: #333333 !important;
            }
            :host([data-theme="dark"]) .bw-tm-item i {
                color: #ababab !important;
            }
            :host([data-theme="dark"]) .bw-tm-shortcut {
                color: #777777 !important;
            }
            :host([data-theme="dark"]) .bw-tm-divider {
                background: rgba(255, 255, 255, 0.1) !important;
            }
            :host([data-theme="dark"]) .bw-tm-zoom-row {
                color: #cccccc !important;
            }
            :host([data-theme="dark"]) .bw-tm-zoom-row i {
                color: #ababab !important;
            }
            :host([data-theme="dark"]) .bw-tm-zoom-btn {
                background: #3c3c3c !important;
                border-color: rgba(255, 255, 255, 0.12) !important;
                color: #cccccc !important;
            }
            :host([data-theme="dark"]) .bw-tm-zoom-btn:hover {
                background: #4a4a4a !important;
            }
            :host([data-theme="dark"]) .bw-tm-zoom-val {
                color: #cccccc !important;
            }
            :host([data-theme="dark"]) .bw-webview-container {
                background: #1e1e1e !important;
                box-shadow: inset 0 2px 6px rgba(0,0,0,0.3) !important;
            }
            :host([data-theme="dark"]) .bw-loading-overlay {
                background: #1e1e1e !important;
            }
            :host([data-theme="dark"]) .bw-sep {
                background: rgba(255, 255, 255, 0.12) !important;
            }
        </style>
        <div class="bw">
            <div class="bw-tabbar">
                <div class="bw-tabbar-inner"></div>
                <button class="bw-tab-add-btn" title="新建标签页"><i class="fas fa-plus"></i></button>
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
                <div class="bw-hint-slot"></div>
                <div class="bw-sep"></div>
                <div class="bw-toolbar-right">
                    <button class="bw-btn bw-menu-btn" title="工具菜单"><i class="fas fa-ellipsis"></i></button>
                    <div class="bw-tool-menu"></div>
                </div>
                <button class="bw-btn bw-exit-preview-btn" title="${browserT('renderer.browser.exitPreview')}" style="display:none;"><i class="fas fa-compress"></i><span class="bw-exit-preview-label">${browserT('renderer.browser.exitPreview')}</span></button>
            </div>
            <div class="bw-webview-container"></div>
        </div>`;

        this.urlInput = this.container.querySelector('.bw-url-input') as HTMLInputElement;
        this.tabBarInner = this.container.querySelector('.bw-tabbar-inner') as HTMLElement;
        this.webviewContainer = this.container.querySelector('.bw-webview-container') as HTMLElement;

        // 地址栏右侧的页面提示（Browser Hints）入口
        const hintSlot = this.container.querySelector('.bw-hint-slot') as HTMLElement;
        this.hintPanel = createBrowserHintPanel({
            labels: {
                title: browserT('renderer.browser.pageHints'),
                emptyText: browserT('renderer.browser.pageHintsEmpty'),
                textSection: browserT('renderer.browser.pageHintsTextSection'),
                actionSection: browserT('renderer.browser.pageHintsActionSection'),
                argsSection: browserT('renderer.browser.pageHintsArgs')
            },
            buttonClass: 'bw-btn'
        });
        hintSlot.appendChild(this.hintPanel.root);

        this.bindToolbarEvents();
        this.bindTabBarEvents();
        this._initViewportScaling();

        const restorableTabs = this._restoreState?.tabs.filter((tab) => typeof tab.url === 'string' && tab.url) ?? [];
        if (restorableTabs.length === 0) {
            this.addTab(HOME_PAGE);
            return;
        }

        const restoredIds = restorableTabs.map((restoredTab) => {
            const tabId = this.addTab(restoredTab.url);
            const tab = this.tabs.find((candidate) => candidate.id === tabId);
            if (tab && restoredTab.title) tab.title = restoredTab.title;
            return tabId;
        });
        const activeIndex = Math.min(Math.max(this._restoreState?.activeIndex ?? 0, 0), restoredIds.length - 1);
        this.switchToTab(restoredIds[activeIndex]);
        this.renderTabBar();
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
        const scale = containerW / EmbeddedBrowser.VIRTUAL_WIDTH;
        // 画中画模式固定视口高度（16:9），保证截图宽高比不随容器变化；
        // 正常模式高度自适应容器（宽度固定缩放，高度自适应）
        const virtualHeight = this._fixedViewport ? EmbeddedBrowser.VIEWPORT_FIXED_HEIGHT : containerH / scale;
        const wraps = this.webviewContainer.querySelectorAll<HTMLElement>('.bw-webview-wrap');
        for (const wrap of wraps) {
            wrap.style.transform = `scale(${scale})`;
            wrap.style.height = `${virtualHeight}px`;
        }
    }

    /**
     * 切换 webview 视口模式。
     * 画中画模式固定视口为 16:9，避免侧边栏窄高容器导致截图被拉长；
     * 恢复正常模式时视口高度重新自适应容器。
     */
    public setViewportFixed(fixed: boolean): void {
        if (this._fixedViewport === fixed) return;
        this._fixedViewport = fixed;
        if (!this.webviewContainer) return;
        const cw = this.webviewContainer.clientWidth;
        const ch = this.webviewContainer.clientHeight;
        if (cw > 0 && ch > 0) {
            this._applyViewportScaling(cw, ch);
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
        const exitPreviewBtn = this.container.querySelector('.bw-exit-preview-btn') as HTMLButtonElement;
        const menuBtn = this.container.querySelector('.bw-menu-btn') as HTMLButtonElement;
        const toolMenu = this.container.querySelector('.bw-tool-menu') as HTMLElement;

        backBtn.addEventListener('click', () => this.goBack());
        forwardBtn.addEventListener('click', () => this.goForward());
        refreshBtn.addEventListener('click', () => this.refresh());
        exitPreviewBtn.addEventListener('click', () => {
            this.container?.dispatchEvent(new CustomEvent('browser-exit-preview'));
        });

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

        const zoomPct = Math.round(this._currentZoomFactor * 100);

        toolMenu.innerHTML = `
            <div class="bw-tm-zoom-row">
                <i class="fas fa-magnifying-glass-plus"></i>
                <span class="bw-tm-zoom-label">缩放</span>
                <div class="bw-tm-zoom-controls">
                    <button class="bw-tm-zoom-btn" data-action="zoomOut"><i class="fas fa-minus"></i></button>
                    <span class="bw-tm-zoom-val">${zoomPct}%</span>
                    <button class="bw-tm-zoom-btn" data-action="zoomIn"><i class="fas fa-plus"></i></button>
                </div>
            </div>
            <div class="bw-tm-divider"></div>
            <div class="bw-tm-item" data-action="screenshot">
                <i class="fas fa-camera"></i>
                <span class="bw-tm-label">截图</span>
            </div>
            <div class="bw-tm-item" data-action="print">
                <i class="fas fa-print"></i>
                <span class="bw-tm-label">打印…</span>
                <span class="bw-tm-shortcut">⌘P</span>
            </div>
            <div class="bw-tm-divider"></div>
            <div class="bw-tm-item" data-action="consoleDebug">
                <i class="fas fa-terminal"></i>
                <span class="bw-tm-label">开发者工具</span>
            </div>
            <div class="bw-tm-item" data-action="snapshotDebug">
                <i class="fas fa-sitemap"></i>
                <span class="bw-tm-label">导出快照</span>
            </div>
            <div class="bw-tm-divider"></div>
            <div class="bw-tm-item" data-action="clearPasswords">
                <i class="fas fa-key"></i>
                <span class="bw-tm-label">${browserT('credentials.clear')}</span>
            </div>
        `;

        toolMenu.querySelectorAll('[data-action]').forEach((el) => {
            el.addEventListener('click', () => {
                const action = (el as HTMLElement).dataset.action;
                // zoom actions keep menu open
                if (action !== 'zoomIn' && action !== 'zoomOut') {
                    toolMenu.classList.remove('bw-visible');
                }
                void this.handleToolMenuAction(action!);
            });
        });

        toolMenu.classList.add('bw-visible');
    }

    private async handleToolMenuAction(action: string): Promise<void> {
        switch (action) {
            case 'zoomIn':
                this._currentZoomFactor = Math.min(this._currentZoomFactor + 0.1, 3);
                this._applyZoomToAllWebviews(this._currentZoomFactor);
                this._updateZoomDisplay();
                break;
            case 'zoomOut':
                this._currentZoomFactor = Math.max(this._currentZoomFactor - 0.1, 0.25);
                this._applyZoomToAllWebviews(this._currentZoomFactor);
                this._updateZoomDisplay();
                break;
            case 'screenshot':
                void this.capturePage();
                break;
            case 'print':
                this._printPage();
                break;
            case 'consoleDebug':
                void this.openWebviewDevTools();
                break;
            case 'snapshotDebug':
                void this.captureAndSaveSnapshot();
                break;
            case 'clearPasswords':
                await this.clearSavedPasswords();
                break;
        }
    }

    private async clearSavedPasswords(): Promise<void> {
        const confirmed = await showConfirmModal({
            title: browserT('credentials.clear'),
            message: browserT('credentials.clearConfirm'),
            confirmText: browserT('credentials.clear'),
            cancelText: browserT('credentials.cancelUpdate'),
            variant: 'danger'
        });
        if (!confirmed) return;
        let success = false;
        try {
            const result = await (window as any).applicationRegistryAPI.callMainWorld('browser', 'clearAutofillData');
            success = result?.success === true;
        } catch {
            // Show the localized failure below; never present a failed clear as success.
        }
        await showInfoModal({
            title: browserT('credentials.clear'),
            message: browserT(success ? 'credentials.cleared' : 'credentials.clearFailed'),
            confirmText: browserT('credentials.ok'),
            variant: success ? 'success' : 'warn'
        });
    }

    private _updateZoomDisplay(): void {
        const valEl = this.container?.querySelector('.bw-tm-zoom-val');
        if (valEl) valEl.textContent = `${Math.round(this._currentZoomFactor * 100)}%`;
    }

    private _printPage(): void {
        const tab = this.getActiveTab();
        if (tab?.ready && tab.webview) {
            try {
                (tab.webview as any).print();
            } catch {
                /* ignore */
            }
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
        wv.setAttribute('tabindex', '0');
        wv.setAttribute('allowpopups', '');
        wv.setAttribute('partition', 'persist:opendesk-browser');
        wv.setAttribute('webpreferences', 'nodeIntegration=no,autofill=yes,backgroundThrottling=no');
        wrapEl.appendChild(wv as unknown as Node);
        this.webviewContainer?.appendChild(wrapEl);

        // 新 tab 默认静音，只有切换激活时才取消静音
        try {
            wv.setAudioMuted(true);
        } catch {
            /* ignore */
        }

        // 对新 tab 应用当前容器的缩放比例（宽度固定缩放，画中画模式下高度固定 16:9）
        if (this.webviewContainer) {
            const cw = this.webviewContainer.clientWidth;
            const ch = this.webviewContainer.clientHeight;
            if (cw > 0 && ch > 0) {
                const s = cw / EmbeddedBrowser.VIRTUAL_WIDTH;
                const virtualHeight = this._fixedViewport ? EmbeddedBrowser.VIEWPORT_FIXED_HEIGHT : ch / s;
                wrapEl.style.transform = `scale(${s})`;
                wrapEl.style.height = `${virtualHeight}px`;
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
        this.onTabsChanged?.();

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
            this.onTabsChanged?.();
            return;
        }

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
        this.onTabsChanged?.();
    }

    public switchToTab(tabId: number): void {
        const tab = this.tabs.find((t) => t.id === tabId);
        if (!tab) return;

        // 离开旧 tab：静音以节省音频资源
        const oldTab = this.getActiveTab();
        if (oldTab && oldTab.id !== tabId && oldTab.webview) {
            try {
                oldTab.webview.setAudioMuted(true);
            } catch {
                /* ignore */
            }
        }

        this.activeTabId = tabId;

        // 激活新 tab：恢复音频
        if (tab.webview) {
            try {
                tab.webview.setAudioMuted(false);
            } catch {
                /* ignore */
            }
        }

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

    /**
     * 检查是否有活跃内容的标签页（非 about:blank）。
     * 当所有标签页都已关闭或只剩 about:blank 时返回 false。
     */
    public hasActiveContent(): boolean {
        return this.tabs.some((t) => t.url !== HOME_PAGE);
    }

    /** 标签页状态变更回调（新增/关闭/导航），用于通知外部更新活跃状态 */
    public onTabsChanged: (() => void) | null = null;

    private getActiveTab(): BrowserTab | undefined {
        return this.tabs.find((t) => t.id === this.activeTabId);
    }

    private getActiveWebview(): WebviewTag | null {
        return this.getActiveTab()?.webview ?? null;
    }

    // ==== Tab bar rendering ====

    private renderTabBar(): void {
        if (!this.tabBarInner) return;

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
            // 导航 commit 后页面内容已开始渲染，立即撤掉加载遮罩，
            // 避免把已经显示出来的部分内容盖住（did-stop-loading 要等全部资源完成）
            this.hideTabLoading(tab);
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
            this.onTabsChanged?.();
        });

        wv.addEventListener('did-navigate-in-page', (event: any) => {
            // 页内导航发生在已渲染的文档内，同样立即撤掉加载遮罩
            this.hideTabLoading(tab);
            tab.url = event.url;
            if (tab.id === this.activeTabId) this.syncUrlBar();
            if (tab.ready) this.syncNavButtons();
            this.onTabsChanged?.();
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
     * 延迟显示加载中遮罩：加载开始后 LOADING_OVERLAY_DELAY_MS 内完成的
     * 页面不会闪烁遮罩，慢页面则会在旧内容上叠加明确的加载反馈。
     */
    private showTabLoading(tab: BrowserTab): void {
        if (tab.loadingTimer != null) return;
        tab.loadingTimer = setTimeout(() => {
            tab.loadingTimer = null;
            const wrap = tab.wrapEl;
            if (!wrap || wrap.querySelector('.bw-loading-overlay')) return;
            const overlay = document.createElement('div');
            overlay.className = 'bw-loading-overlay';
            const loadingView = document.createElement('content-loading-view');
            loadingView.setAttribute('data-message', browserT('renderer.browser.loadingPage'));
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
        tab.wrapEl?.querySelector('.bw-loading-overlay')?.remove();
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
        this.scheduleHintsRefresh();
    }

    // ==== 页面提示（Browser Hints）====

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

    public navigateTo(url: string, targetTab?: BrowserTab): void {
        // 指定 targetTab 时对指定 tab 导航（导航拦截信令可能来自后台 tab），
        // 否则对当前活跃 tab 导航；UI 同步仍基于活跃 tab。
        const tab = targetTab ?? this.getActiveTab();
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
     * - local absolute path (starts with / or drive letter) → prepend file://
     * - looks like a domain (contains dot, no spaces) → prepend https://
     * - otherwise → treat as search query (not implemented, just prepend https://)
     */
    private normalizeUrl(raw: string): string | null {
        if (!raw) return null;
        if (/^(https?|about|file|data):/.test(raw)) return raw;
        if (/^\//.test(raw)) return `file://${raw}`;
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

    public setPreviewMode(active: boolean): void {
        if (this._isPreviewMode === active) return;
        this._isPreviewMode = active;
        const btn = this.container?.querySelector('.bw-exit-preview-btn') as HTMLElement | null;
        if (btn) {
            btn.style.display = active ? '' : 'none';
        }
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
            canGoForward: canForward
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
     * Focus the active guest webview so browser-managed keyboard behavior
     * such as Tab focus traversal is routed to the page, not the OpenDesk UI.
     */
    public focusActiveWebview(): boolean {
        const tab = this.getActiveTab();
        if (!tab?.webview || !tab.ready) return false;
        try {
            (tab.webview as unknown as HTMLElement).focus({ preventScroll: true });
            return true;
        } catch {
            return false;
        }
    }

    /** Return focus ownership without changing it. */
    public hasActiveWebviewFocus(): boolean {
        const tab = this.getActiveTab();
        if (!tab?.webview || !tab.ready) return false;
        let active: Element | null = document.activeElement;
        while (active?.shadowRoot?.activeElement) {
            active = active.shadowRoot.activeElement;
        }
        return active === tab.webview || (tab.webview as unknown as HTMLElement).matches(':focus');
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

    /** Serializable tab state retained while an idle physical WebView is recycled. */
    public getSessionState(): BrowserRestoreState {
        const activeIndex = this.tabs.findIndex((tab) => tab.id === this.activeTabId);
        return {
            tabs: this.tabs.map((tab) => ({ url: tab.url, title: tab.title })),
            activeIndex: activeIndex >= 0 ? activeIndex : 0
        };
    }

    public destroy(): void {
        this.container?.removeAttribute('data-od-browser-focus-scope');
        this.container?.removeEventListener('keydown', this._focusTrapKeydown);
        this._disposeViewportScaling();
        if (this._removeZoomListener) {
            this._removeZoomListener();
            this._removeZoomListener = null;
        }
        // 清理页面提示面板与防抖定时器
        if (this._hintRefreshTimer !== null) {
            clearTimeout(this._hintRefreshTimer);
            this._hintRefreshTimer = null;
        }
        this.hintPanel?.destroy();
        this.hintPanel = null;
        for (const tab of this.tabs) {
            this.hideTabLoading(tab);
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
