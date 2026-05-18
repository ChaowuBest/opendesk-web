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
import { getErrorMessage, buildErrorPageScript, type ErrorInfo } from '../../../../common/browserErrors';

const SEARCH_ENGINE = 'https://www.bing.com/search?q=';
const STORAGE_KEY_HISTORY = 'opendesk-browser-history';
const STORAGE_KEY_BOOKMARKS = 'opendesk-browser-bookmarks';
const MAX_HISTORY_ITEMS = 2000;
const MAX_SUGGESTIONS = 8;

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
}

interface HistoryEntry {
    url: string;
    title: string;
    timestamp: number;
}

interface BookmarkEntry {
    id: string;
    url: string;
    title: string;
    createdAt: number;
    parentId?: string;
    isFolder?: boolean;
}

// ---- Persistence helpers ----

function loadHistory(): HistoryEntry[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY_HISTORY);
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
}

function saveHistory(entries: HistoryEntry[]): void {
    try {
        localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(entries.slice(0, MAX_HISTORY_ITEMS)));
    } catch {
        /* quota exceeded – best-effort */
    }
}

function loadBookmarks(): BookmarkEntry[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY_BOOKMARKS);
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
}

function saveBookmarks(entries: BookmarkEntry[]): void {
    try {
        localStorage.setItem(STORAGE_KEY_BOOKMARKS, JSON.stringify(entries));
    } catch {
        /* quota exceeded */
    }
}

function generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

class BrowserEntryWidget extends HTMLElement {
    private urlInput: HTMLInputElement | null = null;
    private tabBarInner: HTMLElement | null = null;
    private webviewContainer: HTMLElement | null = null;
    private homePageContainer: HTMLElement | null = null;
    private suggestionsEl: HTMLElement | null = null;
    private bookmarkBarEl: HTMLElement | null = null;
    private toolMenuEl: HTMLElement | null = null;
    private historyPanelEl: HTMLElement | null = null;
    private bookmarkMgrEl: HTMLElement | null = null;

    private tabs: BrowserTab[] = [];
    private activeTabId: number = -1;
    private _currentZoomFactor: number = 1;
    private _removeZoomListener: (() => void) | null = null;
    private _cleanupTimers: Map<number, ReturnType<typeof setTimeout>> = new Map();
    private static readonly CLEANUP_DELAY_MS = 900_000; // 15 minutes

    private history: HistoryEntry[] = [];
    private bookmarks: BookmarkEntry[] = [];
    private _selectedSuggestionIdx: number = -1;
    private _dismissTimer: ReturnType<typeof setTimeout> | null = null;

    connectedCallback() {
        this.history = loadHistory();
        this.bookmarks = loadBookmarks();
        this.render();
        this.addTab('opendesk://homepage/');

        window.addEventListener('opendesk-history-changed', () => {
            this.history = loadHistory();
            this._refreshHistoryViews();
        });
    }

    disconnectedCallback() {
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
                font-size: 13px; color: #374151;
                transition: background 0.1s;
            }
            .wb-suggestion-item:first-child { border-radius: 8px 8px 0 0; }
            .wb-suggestion-item:last-child { border-radius: 0 0 8px 8px; }
            .wb-suggestion-item:hover,
            .wb-suggestion-item.wb-sg-active { background: #f3f4f6; }
            .wb-sg-icon { color: #9ca3af; font-size: 11px; flex-shrink: 0; width: 16px; text-align: center; }
            .wb-sg-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .wb-sg-url { color: #9ca3af; font-size: 11px; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 0; }

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
                font-size: 12px; color: #4b5563;
                cursor: pointer;
                white-space: nowrap;
                transition: background 0.12s;
                flex-shrink: 0;
                max-width: 160px;
            }
            .wb-bm-item:hover { background: #e5e7eb; }
            .wb-bm-item i { font-size: 10px; color: #9ca3af; }
            .wb-bm-item-label { overflow: hidden; text-overflow: ellipsis; }
            .wb-bm-empty {
                font-size: 12px; color: #9ca3af; padding: 3px 8px;
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
                color: #9ca3af; margin-right: 10px; font-size: 14px; flex-shrink: 0;
            }
            .wb-hp-search-input {
                flex: 1; border: none; outline: none; background: transparent;
                font-size: 14px; color: #1f2937;
                font-family: inherit;
            }
            .wb-hp-search-input::placeholder { color: #b0b3b8; }
            .wb-hp-section {
                width: 580px; max-width: 88%;
                margin-top: 36px;
            }
            .wb-hp-section-title {
                font-size: 12px; font-weight: 600;
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
                font-size: 11px; color: #6b7280;
                max-width: 90px; text-align: center;
                overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
                line-height: 1.3;
            }

            /* ---- Tool menu (Edge-style) ---- */
            .wb-tool-menu {
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
            .wb-tool-menu.wb-visible { display: block; }
            .wb-tm-item {
                display: flex; align-items: center; gap: 10px;
                padding: 8px 16px;
                font-size: 13px; color: #374151;
                cursor: pointer;
                transition: background 0.1s;
            }
            .wb-tm-item:hover { background: #f3f4f6; }
            .wb-tm-item i { width: 16px; text-align: center; color: #6b7280; font-size: 13px; }
            .wb-tm-label { flex: 1; }
            .wb-tm-shortcut { color: #9ca3af; font-size: 11px; }
            .wb-tm-divider {
                height: 1px; background: #f0f0f0; margin: 4px 0;
            }
            .wb-tm-zoom-row {
                display: flex; align-items: center; gap: 6px;
                padding: 6px 16px;
                font-size: 13px; color: #374151;
            }
            .wb-tm-zoom-row i { width: 16px; text-align: center; color: #6b7280; font-size: 13px; }
            .wb-tm-zoom-label { flex: 1; }
            .wb-tm-zoom-controls {
                display: flex; align-items: center; gap: 4px;
            }
            .wb-tm-zoom-btn {
                width: 24px; height: 24px; border-radius: 4px;
                border: 1px solid #e5e7eb; background: white;
                cursor: pointer; display: flex; align-items: center; justify-content: center;
                font-size: 11px; color: #6b7280;
                transition: background 0.1s;
            }
            .wb-tm-zoom-btn:hover { background: #f3f4f6; }
            .wb-tm-zoom-val { font-size: 12px; min-width: 36px; text-align: center; }

            /* ---- Tool menu anchor (relative positioning) ---- */
            .wb-toolbar-right {
                position: relative;
                display: flex; align-items: center; gap: 4px;
                flex-shrink: 0;
            }

            /* ---- History / Bookmark management panels ---- */
            .wb-panel-overlay {
                display: none;
                position: absolute; top: 0; right: 0;
                width: 380px; height: 100%;
                background: white;
                border-left: 1px solid #e5e7eb;
                box-shadow: -4px 0 16px rgba(0,0,0,0.06);
                z-index: 50;
                flex-direction: column;
            }
            .wb-panel-overlay.wb-visible { display: flex; }
            .wb-panel-header {
                display: flex; align-items: center; gap: 8px;
                padding: 12px 16px;
                border-bottom: 1px solid #f0f0f0;
                flex-shrink: 0;
            }
            .wb-panel-header-title {
                flex: 1; font-size: 15px; font-weight: 600; color: #1f2937;
            }
            .wb-panel-close {
                width: 28px; height: 28px; border: none; background: transparent;
                border-radius: 6px; cursor: pointer; color: #6b7280;
                display: flex; align-items: center; justify-content: center;
                transition: background 0.12s;
            }
            .wb-panel-close:hover { background: #f3f4f6; }
            .wb-panel-search {
                margin: 8px 16px; padding: 6px 10px;
                border: 1px solid #e5e7eb; border-radius: 6px;
                font-size: 13px; outline: none;
                transition: border-color 0.15s;
            }
            .wb-panel-search:focus { border-color: #93c5fd; }
            .wb-panel-body {
                flex: 1; overflow-y: auto; padding: 4px 0;
            }
            .wb-panel-empty {
                text-align: center; color: #9ca3af; padding: 32px 16px; font-size: 13px;
            }

            /* History items */
            .wb-history-item {
                display: flex; align-items: center; gap: 8px;
                padding: 8px 16px;
                cursor: pointer;
                transition: background 0.1s;
            }
            .wb-history-item:hover { background: #f9fafb; }
            .wb-hi-icon { color: #9ca3af; font-size: 11px; flex-shrink: 0; }
            .wb-hi-content { flex: 1; min-width: 0; }
            .wb-hi-title { font-size: 13px; color: #374151; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .wb-hi-url { font-size: 11px; color: #9ca3af; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .wb-hi-time { font-size: 11px; color: #b0b3b8; flex-shrink: 0; }
            .wb-hi-delete {
                width: 22px; height: 22px; border: none; background: transparent;
                border-radius: 4px; cursor: pointer; color: #d1d5db;
                display: flex; align-items: center; justify-content: center;
                opacity: 0; transition: all 0.12s; font-size: 10px;
            }
            .wb-history-item:hover .wb-hi-delete { opacity: 1; }
            .wb-hi-delete:hover { background: #fee2e2; color: #ef4444; }

            /* Bookmark management items */
            .wb-bm-mgr-item {
                display: flex; align-items: center; gap: 8px;
                padding: 8px 16px;
                cursor: pointer;
                transition: background 0.1s;
            }
            .wb-bm-mgr-item:hover { background: #f9fafb; }
            .wb-bm-mgr-icon { color: #f59e0b; font-size: 11px; flex-shrink: 0; }
            .wb-bm-mgr-content { flex: 1; min-width: 0; }
            .wb-bm-mgr-title { font-size: 13px; color: #374151; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .wb-bm-mgr-url { font-size: 11px; color: #9ca3af; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .wb-bm-mgr-actions {
                display: flex; gap: 2px; opacity: 0; transition: opacity 0.12s;
            }
            .wb-bm-mgr-item:hover .wb-bm-mgr-actions { opacity: 1; }
            .wb-bm-mgr-btn {
                width: 22px; height: 22px; border: none; background: transparent;
                border-radius: 4px; cursor: pointer; color: #9ca3af;
                display: flex; align-items: center; justify-content: center;
                font-size: 10px; transition: all 0.12s;
            }
            .wb-bm-mgr-btn:hover { background: #f3f4f6; color: #374151; }
            .wb-bm-mgr-btn.wb-bm-delete:hover { background: #fee2e2; color: #ef4444; }

            /* Inline edit input for bookmark rename */
            .wb-bm-edit-input {
                border: 1px solid #93c5fd; border-radius: 4px;
                padding: 2px 6px; font-size: 13px; outline: none;
                width: 100%;
            }

            /* ---- Clear history button ---- */
            .wb-panel-footer {
                padding: 8px 16px;
                border-top: 1px solid #f0f0f0;
                flex-shrink: 0;
            }
            .wb-clear-btn {
                width: 100%; padding: 6px 0;
                border: 1px solid #e5e7eb; border-radius: 6px;
                background: white; cursor: pointer;
                font-size: 13px; color: #ef4444;
                transition: background 0.12s;
            }
            .wb-clear-btn:hover { background: #fef2f2; }

            /* ---- Internal pages (opendesk://) ---- */
            .wb-internal-page {
                width: 100%; height: 100%;
                display: flex; flex-direction: column;
                background: #f8f9fb;
                overflow: hidden;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            }
            .wb-internal-header {
                padding: 20px 24px 16px;
                flex-shrink: 0;
                display: flex; align-items: center; gap: 12px;
                border-bottom: 1px solid #e5e7eb;
                background: white;
            }
            .wb-internal-header-icon { font-size: 20px; color: #6b7280; }
            .wb-internal-title {
                font-size: 20px; font-weight: 600; color: #1f2937;
                flex: 1;
            }

            /* Favorites management page */
            .wb-fav-layout {
                flex: 1; display: flex; overflow: hidden;
            }
            .wb-fav-tree {
                width: 260px; flex-shrink: 0;
                border-right: 1px solid #e5e7eb;
                display: flex; flex-direction: column;
                background: white;
            }
            .wb-fav-tree-search {
                margin: 8px 12px; padding: 6px 10px;
                border: 1px solid #e5e7eb; border-radius: 6px;
                font-size: 13px; outline: none;
                transition: border-color 0.15s;
            }
            .wb-fav-tree-search:focus { border-color: #93c5fd; }
            .wb-fav-tree-body {
                flex: 1; overflow-y: auto; padding: 4px 0;
            }
            .wb-fav-tree-item {
                display: flex; align-items: center; gap: 6px;
                padding: 7px 12px 7px 16px;
                cursor: pointer;
                font-size: 13px; color: #374151;
                transition: background 0.1s;
            }
            .wb-fav-tree-item:hover { background: #f3f4f6; }
            .wb-fav-tree-item.wb-selected { background: #eff6ff; color: #1d4ed8; font-weight: 500; }
            .wb-fav-tree-item i { width: 16px; text-align: center; font-size: 12px; color: #9ca3af; flex-shrink: 0; }
            .wb-fav-tree-item.wb-selected i { color: #3b82f6; }
            .wb-fav-tree-item-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .wb-fav-tree-item-count { font-size: 11px; color: #9ca3af; flex-shrink: 0; }
            .wb-fav-tree-item.wb-indent { padding-left: 32px; }

            .wb-fav-detail {
                flex: 1; display: flex; flex-direction: column;
                overflow: hidden; background: #fafafa;
            }
            .wb-fav-detail-header {
                display: flex; align-items: center; gap: 8px;
                padding: 12px 16px;
                border-bottom: 1px solid #f0f0f0;
                flex-shrink: 0;
                background: white;
            }
            .wb-fav-detail-title { font-size: 14px; font-weight: 500; color: #374151; flex: 1; }
            .wb-fav-detail-body {
                flex: 1; overflow-y: auto; padding: 8px 0;
            }
            .wb-fav-detail-item {
                display: flex; align-items: center; gap: 10px;
                padding: 10px 16px; margin: 0 8px;
                cursor: pointer; border-radius: 6px;
                transition: background 0.1s;
            }
            .wb-fav-detail-item:hover { background: white; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
            .wb-fav-detail-icon { color: #f59e0b; font-size: 12px; flex-shrink: 0; }
            .wb-fav-detail-icon.wb-folder-icon { color: #6b7280; }
            .wb-fav-detail-content { flex: 1; min-width: 0; }
            .wb-fav-detail-name { font-size: 13px; color: #374151; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .wb-fav-detail-url { font-size: 11px; color: #9ca3af; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .wb-fav-detail-actions {
                display: flex; gap: 2px; opacity: 0; transition: opacity 0.12s;
            }
            .wb-fav-detail-item:hover .wb-fav-detail-actions { opacity: 1; }
            .wb-fav-detail-btn {
                width: 26px; height: 26px; border: none; background: transparent;
                border-radius: 4px; cursor: pointer; color: #9ca3af;
                display: flex; align-items: center; justify-content: center;
                font-size: 11px; transition: all 0.12s;
            }
            .wb-fav-detail-btn:hover { background: #f3f4f6; color: #374151; }
            .wb-fav-detail-btn.wb-del:hover { background: #fee2e2; color: #ef4444; }
            .wb-fav-detail-empty {
                text-align: center; color: #9ca3af; padding: 48px 16px; font-size: 13px;
            }

            /* History management page */
            .wb-hist-layout {
                flex: 1; display: flex; flex-direction: column;
                overflow: hidden;
            }
            .wb-hist-toolbar {
                display: flex; align-items: center; gap: 8px;
                padding: 12px 24px;
                flex-shrink: 0;
            }
            .wb-hist-search {
                flex: 1; padding: 8px 12px;
                border: 1px solid #e5e7eb; border-radius: 8px;
                font-size: 13px; outline: none;
                background: white;
                transition: border-color 0.15s, box-shadow 0.15s;
            }
            .wb-hist-search:focus { border-color: #93c5fd; box-shadow: 0 0 0 2px rgba(59,130,246,0.08); }
            .wb-hist-clear-btn {
                padding: 8px 16px; border: 1px solid #e5e7eb; border-radius: 8px;
                background: white; cursor: pointer; font-size: 13px; color: #ef4444;
                transition: background 0.12s; flex-shrink: 0;
            }
            .wb-hist-clear-btn:hover { background: #fef2f2; }
            .wb-hist-body {
                flex: 1; overflow-y: auto; padding: 0 16px 16px;
            }
            .wb-hist-date-group { margin-bottom: 16px; }
            .wb-hist-date-label {
                font-size: 13px; font-weight: 600; color: #374151;
                padding: 8px 8px 4px; position: sticky; top: 0;
                background: #f8f9fb; z-index: 1;
            }
            .wb-hist-item {
                display: flex; align-items: center; gap: 10px;
                padding: 10px 8px; margin: 0 0 1px;
                cursor: pointer; border-radius: 6px;
                transition: background 0.1s;
            }
            .wb-hist-item:hover { background: white; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
            .wb-hist-item-icon { color: #9ca3af; font-size: 11px; flex-shrink: 0; }
            .wb-hist-item-content { flex: 1; min-width: 0; }
            .wb-hist-item-title { font-size: 13px; color: #374151; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .wb-hist-item-url { font-size: 11px; color: #9ca3af; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .wb-hist-item-time { font-size: 11px; color: #b0b3b8; flex-shrink: 0; }
            .wb-hist-item-del {
                width: 24px; height: 24px; border: none; background: transparent;
                border-radius: 4px; cursor: pointer; color: #d1d5db;
                display: flex; align-items: center; justify-content: center;
                opacity: 0; transition: all 0.12s; font-size: 10px;
            }
            .wb-hist-item:hover .wb-hist-item-del { opacity: 1; }
            .wb-hist-item-del:hover { background: #fee2e2; color: #ef4444; }
            .wb-hist-empty {
                text-align: center; color: #9ca3af; padding: 48px 16px; font-size: 13px;
            }

            /* Panel manage button */
            .wb-panel-manage-btn {
                padding: 4px 10px; border: 1px solid #e5e7eb; border-radius: 5px;
                background: white; cursor: pointer; font-size: 12px; color: #6b7280;
                transition: all 0.12s; flex-shrink: 0;
            }
            .wb-panel-manage-btn:hover { background: #f3f4f6; color: #374151; }
        </style>
        <div class="wb">
            <div class="wb-drag-pad"></div>
            <div class="wb-tabbar">
                <button class="wb-tab-add-btn" title="新建标签页"><i class="fas fa-plus"></i></button>
                <div class="wb-tabbar-inner"></div>
            </div>
            <div class="wb-toolbar">
                <button class="wb-btn wb-back-btn" title="后退"><i class="fas fa-chevron-left"></i></button>
                <button class="wb-btn wb-forward-btn" title="前进"><i class="fas fa-chevron-right"></i></button>
                <button class="wb-btn wb-refresh-btn" title="刷新"><i class="fas fa-rotate-right"></i></button>
                <div class="wb-sep"></div>
                <div class="wb-url-wrap">
                    <i class="fas fa-lock wb-lock" style="display:none"></i>
                    <input type="text" class="wb-url-input" placeholder="搜索或输入网址…" value="" autocomplete="off">
                    <div class="wb-suggestions"></div>
                </div>
                <button class="wb-btn wb-star-btn" title="收藏此页"><i class="fas fa-star"></i></button>
                <div class="wb-sep"></div>
                <button class="wb-btn wb-home-btn" title="主页"><i class="fas fa-house"></i></button>
                <div class="wb-toolbar-right">
                    <button class="wb-btn wb-menu-btn" title="工具菜单"><i class="fas fa-ellipsis"></i></button>
                    <div class="wb-tool-menu"></div>
                </div>
            </div>
            <div class="wb-bookmark-bar"></div>
            <div class="wb-webview-container">
                <div class="wb-homepage wb-hidden" id="wb-homepage"></div>
                <div class="wb-panel-overlay wb-history-panel"></div>
                <div class="wb-panel-overlay wb-bookmark-mgr-panel"></div>
            </div>
        </div>`;

        this.urlInput = this.querySelector('.wb-url-input') as HTMLInputElement;
        this.tabBarInner = this.querySelector('.wb-tabbar-inner') as HTMLElement;
        this.webviewContainer = this.querySelector('.wb-webview-container') as HTMLElement;
        this.homePageContainer = this.querySelector('#wb-homepage') as HTMLElement;
        this.suggestionsEl = this.querySelector('.wb-suggestions') as HTMLElement;
        this.bookmarkBarEl = this.querySelector('.wb-bookmark-bar') as HTMLElement;
        this.toolMenuEl = this.querySelector('.wb-tool-menu') as HTMLElement;
        this.historyPanelEl = this.querySelector('.wb-history-panel') as HTMLElement;
        this.bookmarkMgrEl = this.querySelector('.wb-bookmark-mgr-panel') as HTMLElement;

        this._initZoomSync();
        this.bindToolbarEvents();
        this.bindTabBarEvents();
        this.bindHomePageEvents();
        this.bindUrlSuggestions();
        this.bindToolMenu();
        this.renderBookmarkBar();
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
        const menuBtn = this.querySelector('.wb-menu-btn') as HTMLButtonElement;
        if (!menuBtn || !this.toolMenuEl) return;

        menuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this.toolMenuEl!.classList.contains('wb-visible')) {
                this.closeToolMenu();
            } else {
                this.openToolMenu();
            }
        });

        document.addEventListener('click', () => this.closeToolMenu());
        this.toolMenuEl.addEventListener('click', (e) => e.stopPropagation());
    }

    private openToolMenu(): void {
        if (!this.toolMenuEl) return;
        this.closeAllPanels();

        const zoomPct = Math.round(this._currentZoomFactor * 100);

        this.toolMenuEl.innerHTML = `
            <div class="wb-tm-item" data-action="newTab">
                <i class="fas fa-plus"></i>
                <span class="wb-tm-label">新建标签页</span>
                <span class="wb-tm-shortcut">⌘T</span>
            </div>
            <div class="wb-tm-divider"></div>
            <div class="wb-tm-zoom-row">
                <i class="fas fa-magnifying-glass-plus"></i>
                <span class="wb-tm-zoom-label">缩放</span>
                <div class="wb-tm-zoom-controls">
                    <button class="wb-tm-zoom-btn" data-action="zoomOut"><i class="fas fa-minus"></i></button>
                    <span class="wb-tm-zoom-val">${zoomPct}%</span>
                    <button class="wb-tm-zoom-btn" data-action="zoomIn"><i class="fas fa-plus"></i></button>
                </div>
            </div>
            <div class="wb-tm-divider"></div>
            <div class="wb-tm-item" data-action="bookmarks">
                <i class="fas fa-star"></i>
                <span class="wb-tm-label">收藏夹</span>
                <span class="wb-tm-shortcut">⌥⌘B</span>
            </div>
            <div class="wb-tm-item" data-action="history">
                <i class="fas fa-clock-rotate-left"></i>
                <span class="wb-tm-label">历史记录</span>
                <span class="wb-tm-shortcut">⌘Y</span>
            </div>
            <div class="wb-tm-item" data-action="downloads">
                <i class="fas fa-download"></i>
                <span class="wb-tm-label">下载</span>
                <span class="wb-tm-shortcut">⌥⌘L</span>
            </div>
            <div class="wb-tm-divider"></div>
            <div class="wb-tm-item" data-action="print">
                <i class="fas fa-print"></i>
                <span class="wb-tm-label">打印…</span>
                <span class="wb-tm-shortcut">⌘P</span>
            </div>
            <div class="wb-tm-item" data-action="screenshot">
                <i class="fas fa-camera"></i>
                <span class="wb-tm-label">截图</span>
            </div>
            <div class="wb-tm-item" data-action="findInPage">
                <i class="fas fa-magnifying-glass"></i>
                <span class="wb-tm-label">在页面上查找…</span>
                <span class="wb-tm-shortcut">⌘F</span>
            </div>
            <div class="wb-tm-divider"></div>
            <div class="wb-tm-item" data-action="clearData">
                <i class="fas fa-trash-can"></i>
                <span class="wb-tm-label">删除浏览数据…</span>
                <span class="wb-tm-shortcut">⇧⌘⌫</span>
            </div>
        `;

        this.toolMenuEl.querySelectorAll('[data-action]').forEach((el) => {
            el.addEventListener('click', () => {
                const action = (el as HTMLElement).dataset.action;
                this.handleToolMenuAction(action!);
            });
        });

        this.toolMenuEl.classList.add('wb-visible');
    }

    private closeToolMenu(): void {
        this.toolMenuEl?.classList.remove('wb-visible');
    }

    private handleToolMenuAction(action: string): void {
        switch (action) {
            case 'newTab':
                this.addTab('opendesk://homepage/');
                this.closeToolMenu();
                break;
            case 'zoomIn':
                this._currentZoomFactor = Math.min(this._currentZoomFactor + 0.1, 3);
                this._applyZoomToAllWebviews(this._currentZoomFactor);
                this.updateZoomDisplay();
                return; // don't close menu
            case 'zoomOut':
                this._currentZoomFactor = Math.max(this._currentZoomFactor - 0.1, 0.25);
                this._applyZoomToAllWebviews(this._currentZoomFactor);
                this.updateZoomDisplay();
                return;
            case 'bookmarks':
                this.closeToolMenu();
                this.openBookmarkManager();
                break;
            case 'history':
                this.closeToolMenu();
                this.openHistoryPanel();
                break;
            case 'downloads':
                this.closeToolMenu();
                break;
            case 'print':
                this.closeToolMenu();
                this.printPage();
                break;
            case 'screenshot':
                this.closeToolMenu();
                break;
            case 'findInPage':
                this.closeToolMenu();
                break;
            case 'clearData':
                this.closeToolMenu();
                this.clearBrowsingData();
                break;
            default:
                this.closeToolMenu();
        }
    }

    private updateZoomDisplay(): void {
        const valEl = this.toolMenuEl?.querySelector('.wb-tm-zoom-val');
        if (valEl) valEl.textContent = `${Math.round(this._currentZoomFactor * 100)}%`;
    }

    private printPage(): void {
        const tab = this.getActiveTab();
        if (tab?.ready && tab.webview) {
            try {
                tab.webview.print();
            } catch {
                /* ignore */
            }
        }
    }

    private clearBrowsingData(): void {
        if (confirm('确定要清除所有浏览数据（历史记录）吗？')) {
            this.history = [];
            saveHistory(this.history);
        }
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
        this.closeAllPanels();
        if (!this.historyPanelEl) return;

        this.renderHistoryPanel('');
        this.historyPanelEl.classList.add('wb-visible');
    }

    private renderHistoryPanel(filter: string): void {
        if (!this.historyPanelEl) return;

        const lf = filter.toLowerCase();
        const filtered = lf
            ? this.history.filter((h) => h.url.toLowerCase().includes(lf) || h.title.toLowerCase().includes(lf))
            : this.history;

        /* Deduplicate for display, keeping the most recent visit */
        const seen = new Set<string>();
        const deduped: HistoryEntry[] = [];
        for (const h of filtered) {
            if (!seen.has(h.url)) {
                seen.add(h.url);
                deduped.push(h);
            }
        }

        this.historyPanelEl.innerHTML = `
            <div class="wb-panel-header">
                <span class="wb-panel-header-title">历史记录</span>
                <button class="wb-panel-manage-btn wb-hist-open-manage">管理</button>
                <button class="wb-panel-close"><i class="fas fa-xmark"></i></button>
            </div>
            <input class="wb-panel-search" placeholder="搜索历史记录…" value="${this.escapeHtml(filter)}">
            <div class="wb-panel-body">
                ${
                    deduped.length === 0
                        ? '<div class="wb-panel-empty">暂无历史记录</div>'
                        : deduped
                              .map(
                                  (
                                      h,
                                      idx
                                  ) => `<div class="wb-history-item" data-idx="${idx}" data-url="${this.escapeAttr(h.url)}">
                            <span class="wb-hi-icon"><i class="fas fa-clock-rotate-left"></i></span>
                            <div class="wb-hi-content">
                                <div class="wb-hi-title">${this.escapeHtml(h.title)}</div>
                                <div class="wb-hi-url">${this.escapeHtml(h.url)}</div>
                            </div>
                            <span class="wb-hi-time">${this.formatTime(h.timestamp)}</span>
                            <button class="wb-hi-delete" data-url="${this.escapeAttr(h.url)}" title="删除"><i class="fas fa-xmark"></i></button>
                        </div>`
                              )
                              .join('')
                }
            </div>
            <div class="wb-panel-footer">
                <button class="wb-clear-btn">清除所有历史记录</button>
            </div>
        `;

        this.historyPanelEl.querySelector('.wb-panel-close')?.addEventListener('click', () => {
            this.historyPanelEl?.classList.remove('wb-visible');
        });

        this.historyPanelEl.querySelector('.wb-hist-open-manage')?.addEventListener('click', () => {
            this.historyPanelEl?.classList.remove('wb-visible');
            this.openInternalPage('opendesk://history/');
        });

        const searchInput = this.historyPanelEl.querySelector('.wb-panel-search') as HTMLInputElement;
        searchInput?.addEventListener('input', () => {
            this.renderHistoryPanel(searchInput.value.trim());
        });
        searchInput?.focus();

        this.historyPanelEl.querySelectorAll('.wb-history-item').forEach((el) => {
            el.addEventListener('click', (e) => {
                if ((e.target as HTMLElement).closest('.wb-hi-delete')) return;
                const url = (el as HTMLElement).dataset.url;
                if (url) {
                    this.navigateTo(url);
                    this.historyPanelEl?.classList.remove('wb-visible');
                }
            });
        });

        this.historyPanelEl.querySelectorAll('.wb-hi-delete').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const url = (btn as HTMLElement).dataset.url;
                if (url) {
                    this.history = this.history.filter((h) => h.url !== url);
                    saveHistory(this.history);
                    this.renderHistoryPanel(filter);
                }
            });
        });

        this.historyPanelEl.querySelector('.wb-clear-btn')?.addEventListener('click', () => {
            if (confirm('确定要清除所有历史记录吗？')) {
                this.history = [];
                saveHistory(this.history);
                this.renderHistoryPanel('');
            }
        });
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
            this.bookmarkBarEl.innerHTML = '<span class="wb-bm-empty">收藏夹为空，点击 ★ 收藏网页</span>';
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
        dropdown.className = 'wb-bm-folder-dropdown';
        dropdown.style.cssText = `position:fixed;top:${rect.bottom + 2}px;left:${rect.left}px;
            background:white;border:1px solid #e5e7eb;border-radius:8px;
            box-shadow:0 4px 16px rgba(0,0,0,0.12);z-index:300;padding:4px 0;min-width:180px;max-width:320px;`;

        for (const child of children) {
            const item = document.createElement('div');
            item.className = 'wb-tm-item';
            item.innerHTML = `<i class="fas fa-star" style="color:#f59e0b"></i><span class="wb-tm-label" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this.escapeHtml(child.title || child.url)}</span>`;
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
        menu.className = 'wb-bm-ctx';
        menu.style.cssText = `position:fixed;top:${e.clientY}px;left:${e.clientX}px;
            background:white;border:1px solid #e5e7eb;border-radius:8px;
            box-shadow:0 4px 16px rgba(0,0,0,0.12);z-index:300;padding:4px 0;min-width:160px;`;

        menu.innerHTML = `
            <div class="wb-tm-item" data-ctx="addFolder">
                <i class="fas fa-folder-plus"></i>
                <span class="wb-tm-label">添加文件夹</span>
            </div>
            <div class="wb-tm-divider"></div>
            <div class="wb-tm-item" data-ctx="manage">
                <i class="fas fa-gear"></i>
                <span class="wb-tm-label">管理收藏夹</span>
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
        menu.className = 'wb-bm-ctx';
        menu.style.cssText = `position:fixed;top:${e.clientY}px;left:${e.clientX}px;
            background:white;border:1px solid #e5e7eb;border-radius:8px;
            box-shadow:0 4px 16px rgba(0,0,0,0.12);z-index:300;padding:4px 0;min-width:160px;`;

        const items: string[] = [];
        if (!bm.isFolder) {
            items.push(`
                <div class="wb-tm-item" data-ctx="open">
                    <i class="fas fa-arrow-up-right-from-square"></i>
                    <span class="wb-tm-label">打开</span>
                </div>
                <div class="wb-tm-item" data-ctx="openNewTab">
                    <i class="fas fa-plus"></i>
                    <span class="wb-tm-label">在新标签页中打开</span>
                </div>
                <div class="wb-tm-divider"></div>`);
        }
        items.push(`
            <div class="wb-tm-item" data-ctx="rename">
                <i class="fas fa-pen"></i>
                <span class="wb-tm-label">编辑</span>
            </div>
            <div class="wb-tm-item" data-ctx="delete">
                <i class="fas fa-trash-can"></i>
                <span class="wb-tm-label">删除</span>
            </div>
            <div class="wb-tm-divider"></div>
            <div class="wb-tm-item" data-ctx="addFolder">
                <i class="fas fa-folder-plus"></i>
                <span class="wb-tm-label">添加文件夹</span>
            </div>
            <div class="wb-tm-divider"></div>
            <div class="wb-tm-item" data-ctx="manage">
                <i class="fas fa-gear"></i>
                <span class="wb-tm-label">管理收藏夹</span>
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
            if (e.key === 'Enter') {
                e.preventDefault();
                commit();
            }
            if (e.key === 'Escape') {
                this.renderBookmarkBar();
            }
        });
    }

    private addBookmarkFolder(parentId?: string): void {
        const name = prompt('请输入文件夹名称：');
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
        this.closeAllPanels();
        if (!this.bookmarkMgrEl) return;

        this.renderBookmarkManager('');
        this.bookmarkMgrEl.classList.add('wb-visible');
    }

    private renderBookmarkManager(filter: string): void {
        if (!this.bookmarkMgrEl) return;

        const lf = filter.toLowerCase();
        const filtered = lf
            ? this.bookmarks.filter((b) => b.url.toLowerCase().includes(lf) || b.title.toLowerCase().includes(lf))
            : this.bookmarks;

        this.bookmarkMgrEl.innerHTML = `
            <div class="wb-panel-header">
                <span class="wb-panel-header-title">收藏夹</span>
                <button class="wb-panel-manage-btn wb-bm-open-manage">管理</button>
                <button class="wb-panel-close"><i class="fas fa-xmark"></i></button>
            </div>
            <input class="wb-panel-search" placeholder="搜索收藏…" value="${this.escapeHtml(filter)}">
            <div class="wb-panel-body">
                ${
                    filtered.length === 0
                        ? '<div class="wb-panel-empty">暂无收藏</div>'
                        : filtered
                              .map(
                                  (
                                      b
                                  ) => `<div class="wb-bm-mgr-item" data-id="${b.id}" data-url="${this.escapeAttr(b.url)}">
                            <span class="wb-bm-mgr-icon"><i class="fas fa-star"></i></span>
                            <div class="wb-bm-mgr-content">
                                <div class="wb-bm-mgr-title">${this.escapeHtml(b.title)}</div>
                                <div class="wb-bm-mgr-url">${this.escapeHtml(b.url)}</div>
                            </div>
                            <div class="wb-bm-mgr-actions">
                                <button class="wb-bm-mgr-btn wb-bm-rename" data-id="${b.id}" title="重命名"><i class="fas fa-pen"></i></button>
                                <button class="wb-bm-mgr-btn wb-bm-delete" data-id="${b.id}" title="删除"><i class="fas fa-trash-can"></i></button>
                            </div>
                        </div>`
                              )
                              .join('')
                }
            </div>
        `;

        this.bookmarkMgrEl.querySelector('.wb-panel-close')?.addEventListener('click', () => {
            this.bookmarkMgrEl?.classList.remove('wb-visible');
        });

        this.bookmarkMgrEl.querySelector('.wb-bm-open-manage')?.addEventListener('click', () => {
            this.bookmarkMgrEl?.classList.remove('wb-visible');
            this.openInternalPage('opendesk://favorites/');
        });

        const searchInput = this.bookmarkMgrEl.querySelector('.wb-panel-search') as HTMLInputElement;
        searchInput?.addEventListener('input', () => {
            this.renderBookmarkManager(searchInput.value.trim());
        });
        searchInput?.focus();

        this.bookmarkMgrEl.querySelectorAll('.wb-bm-mgr-item').forEach((el) => {
            el.addEventListener('click', (e) => {
                if ((e.target as HTMLElement).closest('.wb-bm-mgr-btn')) return;
                const url = (el as HTMLElement).dataset.url;
                if (url) {
                    this.navigateTo(url);
                    this.bookmarkMgrEl?.classList.remove('wb-visible');
                }
            });
        });

        this.bookmarkMgrEl.querySelectorAll('.wb-bm-rename').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = (btn as HTMLElement).dataset.id;
                const bm = this.bookmarks.find((b) => b.id === id);
                if (!bm) return;
                const titleEl = (btn as HTMLElement)
                    .closest('.wb-bm-mgr-item')
                    ?.querySelector('.wb-bm-mgr-title') as HTMLElement;
                if (!titleEl) return;

                const input = document.createElement('input');
                input.className = 'wb-bm-edit-input';
                input.value = bm.title;
                titleEl.replaceWith(input);
                input.focus();
                input.select();

                const commit = () => {
                    bm.title = input.value.trim() || bm.url;
                    saveBookmarks(this.bookmarks);
                    this.renderBookmarkBar();
                    this.renderBookmarkManager(filter);
                };
                input.addEventListener('blur', commit);
                input.addEventListener('keydown', (ev) => {
                    if (ev.key === 'Enter') {
                        ev.preventDefault();
                        commit();
                    }
                    if (ev.key === 'Escape') {
                        this.renderBookmarkManager(filter);
                    }
                });
            });
        });

        this.bookmarkMgrEl.querySelectorAll('.wb-bm-delete').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = (btn as HTMLElement).dataset.id;
                this.bookmarks = this.bookmarks.filter((b) => b.id !== id);
                saveBookmarks(this.bookmarks);
                this.renderBookmarkBar();
                this.renderBookmarkManager(filter);
            });
        });
    }

    // =====================================================================
    //  PANELS UTIL
    // =====================================================================

    private closeAllPanels(): void {
        this.historyPanelEl?.classList.remove('wb-visible');
        this.bookmarkMgrEl?.classList.remove('wb-visible');
        this.closeToolMenu();
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

    public addTab(url?: string): number {
        const isInternal = url?.startsWith('opendesk://');
        const isHome = !url && !isInternal;
        const tabId = nextTabId++;

        const tab: BrowserTab = {
            id: tabId,
            title: isInternal ? this.getInternalPageTitle(url!) : '新标签页',
            url: url || '',
            webview: null,
            wrapEl: null,
            ready: false,
            pendingUrl: null,
            isHomePage: isHome,
            internalUrl: isInternal ? url : undefined
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

        // 清理定时器
        const timer = this._cleanupTimers.get(tabId);
        if (timer) {
            clearTimeout(timer);
            this._cleanupTimers.delete(tabId);
        }

        if (this.tabs.length === 1) {
            const onlyTab = this.tabs[0];
            if (onlyTab.webview) {
                onlyTab.wrapEl?.remove();
                onlyTab.webview = null;
                onlyTab.wrapEl = null;
            } else if (onlyTab.wrapEl) {
                onlyTab.wrapEl.remove();
                onlyTab.wrapEl = null;
            }
            onlyTab.url = 'opendesk://homepage/';
            onlyTab.title = '新标签页';
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
        });

        wv.addEventListener('did-navigate-in-page', (event: any) => {
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

            // 显示错误覆盖层
            this.injectErrorPage(tab);

            // 同步地址栏显示失败的 URL
            if (tab.id === this.activeTabId) {
                this.syncUrlBar();
                this.syncStarButton();
            }
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

    public navigateTo(input: string): void {
        const raw = input.trim();
        if (!raw) return;

        const tab = this.getActiveTab();
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
     * - 看起来像域名（含点号且无空格）→ 添加 https://
     * - 其他 → 作为搜索关键词
     */
    private normalizeUrl(raw: string): string | null {
        if (!raw) return null;
        if (/^opendesk:\/\//.test(raw)) return raw;
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

        // Hide current webview if any
        if (tab.webview) {
            tab.wrapEl?.classList.remove('wb-wv-active');
        }

        tab.isHomePage = false;
        tab.internalUrl = 'opendesk://homepage/';
        tab.url = 'opendesk://homepage/';
        tab.title = '新标签页';

        // Create wrapper for internal page if needed
        if (!tab.wrapEl) {
            const wrapEl = document.createElement('div');
            wrapEl.className = 'wb-webview-wrap';
            wrapEl.dataset.tabId = String(tab.id);
            this.webviewContainer?.appendChild(wrapEl);
            tab.wrapEl = wrapEl;
        }

        tab.wrapEl.classList.add('wb-wv-active');
        this.renderHomepageInternal(tab.wrapEl, tab);

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
        if (url.startsWith('opendesk://favorites')) return '收藏夹管理';
        if (url.startsWith('opendesk://history')) return '历史记录';
        if (url.startsWith('opendesk://homepage')) return '新标签页';
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
        } else {
            tab.wrapEl.innerHTML =
                '<div class="wb-internal-page"><div class="wb-internal-header"><span class="wb-internal-title">页面不存在</span></div></div>';
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
                    <input type="text" class="wb-hp-search-input" placeholder="搜索或输入网址…" autofocus>
                </div>
            </div>
            ${
                topSitesHtml
                    ? `<div class="wb-hp-section">
                <div class="wb-hp-section-title">常访问</div>
                <div class="wb-hp-grid">${topSitesHtml}</div>
            </div>`
                    : ''
            }
        </div>`;

        // Bind search
        const searchInput = container.querySelector('.wb-hp-search-input') as HTMLInputElement;
        searchInput?.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && !e.isComposing && searchInput.value.trim()) {
                this.navigateTo(searchInput.value.trim());
            }
        });
        setTimeout(() => searchInput?.focus(), 50);

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
        if (hour < 6) return '夜深了';
        if (hour < 12) return '早上好';
        if (hour < 14) return '中午好';
        if (hour < 18) return '下午好';
        return '晚上好';
    }

    // ---- Favorites management page ----

    private renderFavoritesPage(container: HTMLElement, selectedFolderId?: string, searchFilter?: string): void {
        const lf = (searchFilter || '').toLowerCase();
        const folders = this.bookmarks.filter((b) => b.isFolder);
        const allBookmarksLabel = '全部收藏';

        // Filter folders for tree
        const filteredFolders = lf ? folders.filter((f) => f.title.toLowerCase().includes(lf)) : folders;

        // Determine selected folder
        const selId = selectedFolderId ?? '__all__';

        // Get detail items
        let detailItems: BookmarkEntry[];
        let detailTitle: string;
        if (selId === '__all__') {
            detailItems = this.bookmarks.filter((b) => !b.isFolder);
            detailTitle = allBookmarksLabel;
        } else {
            detailItems = this.bookmarks.filter((b) => b.parentId === selId && !b.isFolder);
            const folder = this.bookmarks.find((b) => b.id === selId);
            detailTitle = folder ? folder.title : allBookmarksLabel;
        }

        if (lf) {
            detailItems = detailItems.filter(
                (b) => b.title.toLowerCase().includes(lf) || b.url.toLowerCase().includes(lf)
            );
        }

        // Count items per folder
        const folderCounts = new Map<string, number>();
        for (const b of this.bookmarks) {
            if (!b.isFolder && b.parentId) {
                folderCounts.set(b.parentId, (folderCounts.get(b.parentId) || 0) + 1);
            }
        }
        const totalCount = this.bookmarks.filter((b) => !b.isFolder).length;
        const rootCount = this.bookmarks.filter((b) => !b.isFolder && !b.parentId).length;

        container.innerHTML = `
            <div class="wb-internal-page">
                <div class="wb-internal-header">
                    <i class="fas fa-star wb-internal-header-icon" style="color:#f59e0b"></i>
                    <span class="wb-internal-title">收藏夹管理</span>
                </div>
                <div class="wb-fav-layout">
                    <div class="wb-fav-tree">
                        <input class="wb-fav-tree-search" placeholder="搜索收藏夹…" value="${this.escapeHtml(searchFilter || '')}">
                        <div class="wb-fav-tree-body">
                            <div class="wb-fav-tree-item${selId === '__all__' ? ' wb-selected' : ''}" data-folder-id="__all__">
                                <i class="fas fa-bookmark"></i>
                                <span class="wb-fav-tree-item-label">${allBookmarksLabel}</span>
                                <span class="wb-fav-tree-item-count">${totalCount}</span>
                            </div>
                            <div class="wb-fav-tree-item${selId === '__root__' ? ' wb-selected' : ''}" data-folder-id="__root__">
                                <i class="fas fa-bars"></i>
                                <span class="wb-fav-tree-item-label">收藏夹栏</span>
                                <span class="wb-fav-tree-item-count">${rootCount}</span>
                            </div>
                            ${filteredFolders
                                .map(
                                    (
                                        f
                                    ) => `<div class="wb-fav-tree-item wb-indent${selId === f.id ? ' wb-selected' : ''}" data-folder-id="${f.id}">
                                <i class="fas fa-folder"></i>
                                <span class="wb-fav-tree-item-label">${this.escapeHtml(f.title)}</span>
                                <span class="wb-fav-tree-item-count">${folderCounts.get(f.id) || 0}</span>
                            </div>`
                                )
                                .join('')}
                        </div>
                    </div>
                    <div class="wb-fav-detail">
                        <div class="wb-fav-detail-header">
                            <span class="wb-fav-detail-title">${this.escapeHtml(detailTitle)}（${detailItems.length}）</span>
                        </div>
                        <div class="wb-fav-detail-body">
                            ${
                                detailItems.length === 0
                                    ? '<div class="wb-fav-detail-empty">此文件夹暂无收藏</div>'
                                    : detailItems
                                          .map(
                                              (
                                                  b
                                              ) => `<div class="wb-fav-detail-item" data-id="${b.id}" data-url="${this.escapeAttr(b.url)}">
                                    <span class="wb-fav-detail-icon"><i class="fas fa-star"></i></span>
                                    <div class="wb-fav-detail-content">
                                        <div class="wb-fav-detail-name">${this.escapeHtml(b.title || b.url)}</div>
                                        <div class="wb-fav-detail-url">${this.escapeHtml(b.url)}</div>
                                    </div>
                                    <div class="wb-fav-detail-actions">
                                        <button class="wb-fav-detail-btn wb-fav-edit" data-id="${b.id}" title="编辑"><i class="fas fa-pen"></i></button>
                                        <button class="wb-fav-detail-btn wb-del wb-fav-del" data-id="${b.id}" title="删除"><i class="fas fa-trash-can"></i></button>
                                    </div>
                                </div>`
                                          )
                                          .join('')
                            }
                        </div>
                    </div>
                </div>
            </div>`;

        // Bind tree item clicks
        container.querySelectorAll('.wb-fav-tree-item').forEach((el) => {
            el.addEventListener('click', () => {
                const folderId = (el as HTMLElement).dataset.folderId;
                if (folderId === '__root__') {
                    this.renderFavoritesPage(container, '__root__', searchFilter);
                } else {
                    this.renderFavoritesPage(container, folderId, searchFilter);
                }
            });
        });

        // Override __root__ to show root-level (no parentId) bookmarks
        if (selId === '__root__') {
            const detailBody = container.querySelector('.wb-fav-detail-body') as HTMLElement;
            const detailHeader = container.querySelector('.wb-fav-detail-title') as HTMLElement;
            if (detailBody && detailHeader) {
                let rootItems = this.bookmarks.filter((b) => !b.isFolder && !b.parentId);
                if (lf) {
                    rootItems = rootItems.filter(
                        (b) => b.title.toLowerCase().includes(lf) || b.url.toLowerCase().includes(lf)
                    );
                }
                detailHeader.textContent = `收藏夹栏（${rootItems.length}）`;
                if (rootItems.length === 0) {
                    detailBody.innerHTML = '<div class="wb-fav-detail-empty">收藏夹栏暂无收藏</div>';
                } else {
                    detailBody.innerHTML = rootItems
                        .map(
                            (
                                b
                            ) => `<div class="wb-fav-detail-item" data-id="${b.id}" data-url="${this.escapeAttr(b.url)}">
                            <span class="wb-fav-detail-icon"><i class="fas fa-star"></i></span>
                            <div class="wb-fav-detail-content">
                                <div class="wb-fav-detail-name">${this.escapeHtml(b.title || b.url)}</div>
                                <div class="wb-fav-detail-url">${this.escapeHtml(b.url)}</div>
                            </div>
                            <div class="wb-fav-detail-actions">
                                <button class="wb-fav-detail-btn wb-fav-edit" data-id="${b.id}" title="编辑"><i class="fas fa-pen"></i></button>
                                <button class="wb-fav-detail-btn wb-del wb-fav-del" data-id="${b.id}" title="删除"><i class="fas fa-trash-can"></i></button>
                            </div>
                        </div>`
                        )
                        .join('');
                }
            }
        }

        // Bind search
        const treeSearch = container.querySelector('.wb-fav-tree-search') as HTMLInputElement;
        treeSearch?.addEventListener('input', () => {
            this.renderFavoritesPage(container, selId, treeSearch.value.trim());
        });
        treeSearch?.focus();

        // Bind detail item clicks (navigate)
        container.querySelectorAll('.wb-fav-detail-item').forEach((el) => {
            el.addEventListener('click', (e) => {
                if ((e.target as HTMLElement).closest('.wb-fav-detail-btn')) return;
                const url = (el as HTMLElement).dataset.url;
                if (url) this.addTab(url);
            });
        });

        // Bind edit buttons
        container.querySelectorAll('.wb-fav-edit').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = (btn as HTMLElement).dataset.id;
                const bm = this.bookmarks.find((b) => b.id === id);
                if (!bm) return;
                const newTitle = prompt('编辑名称：', bm.title);
                if (newTitle !== null && newTitle.trim()) {
                    bm.title = newTitle.trim();
                    saveBookmarks(this.bookmarks);
                    this.renderBookmarkBar();
                    this.renderFavoritesPage(container, selId, searchFilter);
                }
            });
        });

        // Bind delete buttons
        container.querySelectorAll('.wb-fav-del').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = (btn as HTMLElement).dataset.id;
                this.bookmarks = this.bookmarks.filter((b) => b.id !== id);
                saveBookmarks(this.bookmarks);
                this.renderBookmarkBar();
                this.renderFavoritesPage(container, selId, searchFilter);
            });
        });
    }

    // ---- History management page ----

    private renderHistoryInternalPage(container: HTMLElement, searchFilter?: string): void {
        const lf = (searchFilter || '').toLowerCase();
        const filtered = lf
            ? this.history.filter((h) => h.url.toLowerCase().includes(lf) || h.title.toLowerCase().includes(lf))
            : this.history;

        // Deduplicate for display
        const seen = new Set<string>();
        const deduped: HistoryEntry[] = [];
        for (const h of filtered) {
            if (!seen.has(h.url)) {
                seen.add(h.url);
                deduped.push(h);
            }
        }

        // Group by date
        const groups = new Map<string, HistoryEntry[]>();
        for (const h of deduped) {
            const d = new Date(h.timestamp);
            const key = d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key)!.push(h);
        }

        let groupsHtml = '';
        if (groups.size === 0) {
            groupsHtml = '<div class="wb-hist-empty">暂无历史记录</div>';
        } else {
            for (const [dateLabel, items] of groups) {
                groupsHtml += `<div class="wb-hist-date-group">
                    <div class="wb-hist-date-label">${this.escapeHtml(dateLabel)}</div>
                    ${items
                        .map(
                            (h) => `<div class="wb-hist-item" data-url="${this.escapeAttr(h.url)}">
                        <span class="wb-hist-item-icon"><i class="fas fa-clock-rotate-left"></i></span>
                        <div class="wb-hist-item-content">
                            <div class="wb-hist-item-title">${this.escapeHtml(h.title || h.url)}</div>
                            <div class="wb-hist-item-url">${this.escapeHtml(h.url)}</div>
                        </div>
                        <span class="wb-hist-item-time">${this.formatTime(h.timestamp)}</span>
                        <button class="wb-hist-item-del" data-url="${this.escapeAttr(h.url)}" title="删除"><i class="fas fa-xmark"></i></button>
                    </div>`
                        )
                        .join('')}
                </div>`;
            }
        }

        container.innerHTML = `
            <div class="wb-internal-page">
                <div class="wb-internal-header">
                    <i class="fas fa-clock-rotate-left wb-internal-header-icon"></i>
                    <span class="wb-internal-title">历史记录</span>
                </div>
                <div class="wb-hist-layout">
                    <div class="wb-hist-toolbar">
                        <input class="wb-hist-search" placeholder="搜索历史记录…" value="${this.escapeHtml(searchFilter || '')}">
                        <button class="wb-hist-clear-btn">清除所有历史记录</button>
                    </div>
                    <div class="wb-hist-body">${groupsHtml}</div>
                </div>
            </div>`;

        // Bind search
        const searchInput = container.querySelector('.wb-hist-search') as HTMLInputElement;
        searchInput?.addEventListener('input', () => {
            this.renderHistoryInternalPage(container, searchInput.value.trim());
        });
        searchInput?.focus();

        // Bind clear all
        container.querySelector('.wb-hist-clear-btn')?.addEventListener('click', () => {
            if (confirm('确定要清除所有历史记录吗？此操作不可撤销。')) {
                this.history = [];
                saveHistory(this.history);
                this.renderHistoryInternalPage(container, searchFilter);
            }
        });

        // Bind item clicks (navigate)
        container.querySelectorAll('.wb-hist-item').forEach((el) => {
            el.addEventListener('click', (e) => {
                if ((e.target as HTMLElement).closest('.wb-hist-item-del')) return;
                const url = (el as HTMLElement).dataset.url;
                if (url) this.addTab(url);
            });
        });

        // Bind delete buttons
        container.querySelectorAll('.wb-hist-item-del').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const url = (btn as HTMLElement).dataset.url;
                if (url) {
                    this.history = this.history.filter((h) => h.url !== url);
                    saveHistory(this.history);
                    this.renderHistoryInternalPage(container, searchFilter);
                }
            });
        });
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

    private escapeHtml(str: string): string {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    private escapeAttr(str: string): string {
        return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    private formatTime(ts: number): string {
        const d = new Date(ts);
        const now = new Date();
        const isToday =
            d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
        if (isToday) {
            return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
        }
        return d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
    }
}

customElements.define('browser-entry-widget', BrowserEntryWidget);
