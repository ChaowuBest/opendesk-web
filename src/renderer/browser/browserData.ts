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

const STORAGE_KEY_HISTORY = 'opendesk-browser-history';
const STORAGE_KEY_BOOKMARKS = 'opendesk-browser-bookmarks';
export const MAX_HISTORY_ITEMS = 2000;
export interface HistoryEntry {
    url: string;
    title: string;
    timestamp: number;
}

export interface BookmarkEntry {
    id: string;
    url: string;
    title: string;
    createdAt: number;
    parentId?: string;
    isFolder?: boolean;
}

export interface DownloadState {
    id: string;
    url: string;
    filename: string;
    savePath: string;
    receivedBytes: number;
    totalBytes: number;
    state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
    startTime: number;
    endTime?: number;
}

// ---- Persistence helpers ----

export function loadHistory(): HistoryEntry[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY_HISTORY);
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
}

export function saveHistory(entries: HistoryEntry[]): void {
    try {
        localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(entries.slice(0, MAX_HISTORY_ITEMS)));
        window.dispatchEvent(new CustomEvent('opendesk-history-changed'));
    } catch {
        /* quota exceeded – best-effort */
    }
}

export function loadBookmarks(): BookmarkEntry[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY_BOOKMARKS);
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
}

export function saveBookmarks(entries: BookmarkEntry[]): void {
    try {
        localStorage.setItem(STORAGE_KEY_BOOKMARKS, JSON.stringify(entries));
        window.dispatchEvent(new CustomEvent('opendesk-bookmarks-changed'));
    } catch {
        /* quota exceeded */
    }
}

export function generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function recordBrowserVisit(url: string, title: string): void {
    if (!/^https?:\/\//i.test(url)) return;
    const entries = loadHistory();
    entries.unshift({ url, title: title || url, timestamp: Date.now() });
    saveHistory(entries);
}
