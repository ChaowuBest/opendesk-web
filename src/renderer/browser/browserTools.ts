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

import { BrowserSettings } from './browserSettings.js';
import type { WebviewTag } from 'electron';
import type { BrowserMenuAction } from '../components/browserToolMenu.js';
import { showConfirmModal } from '../components/confirmModal.js';
import { BROWSER_TOOLS_CSS } from './browserToolsStyles.js';
import {
    loadHistory,
    saveHistory,
    loadBookmarks,
    saveBookmarks,
    type HistoryEntry,
    type BookmarkEntry,
    type DownloadState
} from './browserData.js';

interface BrowserToolsOptions {
    container: HTMLElement;
    t: (key: string, params?: Record<string, string | number>) => string;
    navigateTo: (url: string) => void;
    addTab: (url: string) => void;
    getWebview: () => WebviewTag | null;
    getUserAgent: () => string;
    setUserAgent: (value: string) => void;
    closeMenu: () => void;
    onHistoryChanged?: () => void;
    onBookmarksChanged?: () => void;
}

/** Browser-owned views and actions shared by application and task browsers. */
export class BrowserTools {
    private settings: BrowserSettings;
    private root: HTMLElement;
    public historyPanelEl: HTMLElement;
    public bookmarkMgrEl: HTMLElement;
    public downloadPanelEl: HTMLElement;
    private pagePanel: HTMLElement;
    private pageBody: HTMLElement;
    private findBar: HTMLElement;
    private findGuest: WebviewTag | null = null;
    private pageUrl = '';
    private history = loadHistory();
    private bookmarks = loadBookmarks();
    private downloads: DownloadState[] = [];
    private removedDownloads = new Set<string>();
    private destroyed = false;
    private _t: BrowserToolsOptions['t'];
    private readonly historyChanged = () => {
        this.history = loadHistory();
        this.options.onHistoryChanged?.();
        if (this.historyPanelEl.classList.contains('wb-visible')) this.renderHistoryPanel('');
        if (this.pageUrl.includes('history')) this.renderHistoryInternalPage(this.pageBody);
    };
    private readonly bookmarksChanged = () => {
        this.bookmarks = loadBookmarks();
        this.options.onBookmarksChanged?.();
        if (this.bookmarkMgrEl.classList.contains('wb-visible')) this.renderBookmarkManager('');
        if (this.pageUrl.includes('favorites')) this.renderFavoritesPage(this.pageBody);
    };
    private readonly storageChanged = (event: StorageEvent) => {
        if (!event.key || event.key === 'opendesk-browser-history') this.historyChanged();
        if (!event.key || event.key === 'opendesk-browser-bookmarks') this.bookmarksChanged();
    };
    private readonly downloadChanged = (event: Event) => {
        const download = (event as CustomEvent<DownloadState>).detail;
        const index = this.downloads.findIndex((d) => d.id === download.id);
        if (index < 0) this.downloads.unshift(download);
        else this.downloads[index] = download;
        if (this.downloadPanelEl.classList.contains('wb-visible')) this.renderDownloadPanel();
    };
    private readonly downloadRemoved = (event: Event) => {
        const id = (event as CustomEvent<string>).detail;
        this.removedDownloads.add(id);
        this.downloads = this.downloads.filter((download) => download.id !== id);
        if (this.downloadPanelEl.classList.contains('wb-visible')) this.renderDownloadPanel();
    };
    constructor(private options: BrowserToolsOptions) {
        this._t = options.t;
        this.settings = new BrowserSettings(options);
        this.root = document.createElement('div');
        this.root.className = 'od-browser-tools';
        const style = document.createElement('style');
        style.textContent = BROWSER_TOOLS_CSS;
        this.root.append(style);
        const panel = (name: string) => {
            const el = document.createElement('div');
            el.className = 'wb-panel-overlay ' + name;
            this.root.append(el);
            return el;
        };
        this.historyPanelEl = panel('wb-history-panel');
        this.bookmarkMgrEl = panel('wb-bookmark-mgr-panel');
        this.downloadPanelEl = panel('wb-downloads-panel');
        this.pagePanel = panel('wb-page-panel');
        const close = document.createElement('button');
        close.className = 'wb-panel-close';
        close.type = 'button';
        close.textContent = '×';
        close.setAttribute('aria-label', this._t('renderer.browser.tools.close'));
        close.onclick = () => this.closeAllPanels();
        this.pageBody = document.createElement('div');
        this.pageBody.className = 'wb-page-body';
        this.pagePanel.append(close, this.pageBody);
        this.findBar = document.createElement('div');
        this.findBar.className = 'wb-find';
        this.findBar.hidden = true;
        this.root.append(this.findBar);
        options.container.append(this.root);
        window.addEventListener('opendesk-history-changed', this.historyChanged);
        window.addEventListener('opendesk-bookmarks-changed', this.bookmarksChanged);
        window.addEventListener('storage', this.storageChanged);
        window.addEventListener('browser-download-update', this.downloadChanged);
        window.addEventListener('opendesk-download-removed', this.downloadRemoved);
        const api = (window as any).downloadAPI;
        if (api?.getDownloads)
            void Promise.resolve(api.getDownloads())
                .then((list: DownloadState[]) => {
                    if (this.destroyed) return;
                    const merged = new Map((list ?? []).map((d) => [d.id, d]));
                    for (const download of this.downloads) merged.set(download.id, download);
                    this.downloads = [...merged.values()]
                        .filter((download) => !this.removedDownloads.has(download.id))
                        .sort((a, b) => b.startTime - a.startTime);
                    if (this.downloadPanelEl.classList.contains('wb-visible')) this.renderDownloadPanel();
                })
                .catch((error) => console.error('Failed to load browser downloads', error));
    }
    public renderBrowserSettingsPage(container: HTMLElement) {
        this.settings.render(container);
    }
    private getActiveTab() {
        const webview = this.options.getWebview();
        return webview ? { ready: true, webview } : null;
    }
    private navigateTo(url: string) {
        this.options.navigateTo(url);
    }
    private addTab(url: string) {
        this.options.addTab(url);
    }
    private renderBookmarkBar() {
        this.options.onBookmarksChanged?.();
    }
    private closeToolMenu() {
        this.options.closeMenu();
    }
    private openInternalPage(url: string) {
        this.closeAllPanels();
        this.pageUrl = url;
        if (url.startsWith('opendesk://favorites')) this.renderFavoritesPage(this.pageBody);
        else if (url.startsWith('opendesk://history')) this.renderHistoryInternalPage(this.pageBody);
        else this.renderBrowserSettingsPage(this.pageBody);
        this.pagePanel.classList.add('wb-visible');
    }
    private async captureScreenshot() {
        const guest = this.options.getWebview();
        if (!guest) return;
        const api = (window as any).browserAPI;
        const data = await api.captureScreenshot(guest.getWebContentsId());
        if (data) await (window as any).magicPointerAPI.saveScreenshot(data, guest.getTitle());
    }
    private showFind() {
        this.closeAllPanels();
        const guest = this.options.getWebview();
        if (!guest) return;
        this.findGuest = guest;
        this.findBar.replaceChildren();
        this.findBar.hidden = false;
        const input = document.createElement('input');
        input.type = 'search';
        input.placeholder = this._t('renderer.browser.menu.find');
        input.setAttribute('aria-label', input.placeholder);
        const search = (forward: boolean) => {
            if (input.value) guest.findInPage(input.value, { forward, findNext: true });
            else guest.stopFindInPage('clearSelection');
        };
        input.addEventListener('input', () => {
            if (input.value) guest.findInPage(input.value);
            else guest.stopFindInPage('clearSelection');
        });
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                search(!event.shiftKey);
            } else if (event.key === 'Escape') {
                event.stopPropagation();
                this.closeAllPanels();
                guest.focus();
            }
        });
        this.findBar.append(input);
        for (const [label, action] of [
            ['previous', () => search(false)],
            ['next', () => search(true)],
            ['close', () => this.closeAllPanels()]
        ] as const) {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = this._t('renderer.browser.tools.' + label);
            button.onclick = action;
            this.findBar.append(button);
        }
        input.focus();
    }
    public destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        this.closeAllPanels();
        window.removeEventListener('opendesk-history-changed', this.historyChanged);
        window.removeEventListener('opendesk-bookmarks-changed', this.bookmarksChanged);
        window.removeEventListener('storage', this.storageChanged);
        window.removeEventListener('browser-download-update', this.downloadChanged);
        window.removeEventListener('opendesk-download-removed', this.downloadRemoved);
        this.root.remove();
    }
    public async handleAction(action: BrowserMenuAction): Promise<void> {
        switch (action) {
            case 'newTab':
                this.addTab('opendesk://homepage/');
                break;
            case 'bookmarks':
                this.openBookmarkManager();
                break;
            case 'history':
                this.openHistoryPanel();
                break;
            case 'downloads':
                this.toggleDownloadPanel();
                break;
            case 'print':
                this.printPage();
                break;
            case 'screenshot':
                await this.captureScreenshot();
                break;
            case 'findInPage':
                this.showFind();
                break;
            case 'consoleDebug':
                this.openWebviewDevTools();
                break;
            case 'snapshotDebug':
                await this.captureAndSaveSnapshot();
                break;
            case 'clearHistoryData':
                this.clearBrowsingData();
                break;
            case 'clearCookies':
                await this._callBrowserMain('clearBrowserCookies', this._t('renderer.browser.msg.cookiesCleared'));
                break;
            case 'clearStorage':
                await this._callBrowserMain('clearBrowserStorage', this._t('renderer.browser.msg.storageCleared'));
                break;
            case 'clearCache':
                await this._callBrowserMain('clearBrowserCache', this._t('renderer.browser.msg.httpCacheCleared'));
                break;
            case 'clearAutofill':
                await this._callBrowserMain('clearAutofillData', this._t('renderer.browser.msg.autofillCleared'));
                break;
            case 'clearAllData':
                await this._confirmAndClearAllData();
                break;
            case 'openBrowserSettings':
                this.openInternalPage('opendesk://browser-settings/');
                break;
            default:
                break;
        }
    }

    private async _callBrowserMain(method: string, successMsg: string): Promise<void> {
        const registryAPI = (window as any).applicationRegistryAPI;
        if (!registryAPI?.callMainWorld) {
            await showConfirmModal({
                icon: 'fa-circle-exclamation',
                iconBg: '#FEF2F2',
                iconColor: '#DC2626',
                title: this._t('renderer.browser.modal.actionFailed'),
                message: this._t('renderer.browser.modal.unsupported'),
                confirmText: this._t('renderer.browser.modal.acknowledge'),
                cancelText: null
            });
            return;
        }
        try {
            const result = await registryAPI.callMainWorld('browser', method);
            if (result?.success) {
                await showConfirmModal({
                    icon: 'fa-circle-check',
                    iconBg: '#ECFDF5',
                    iconColor: '#059669',
                    title: this._t('renderer.browser.modal.actionSuccess'),
                    message: result.message || successMsg,
                    confirmText: this._t('renderer.browser.modal.acknowledge'),
                    cancelText: null
                });
            } else {
                await showConfirmModal({
                    icon: 'fa-circle-exclamation',
                    iconBg: '#FEF2F2',
                    iconColor: '#DC2626',
                    title: this._t('renderer.browser.modal.actionFailed'),
                    message: result?.message || this._t('renderer.browser.modal.unknownError'),
                    confirmText: this._t('renderer.browser.modal.acknowledge'),
                    cancelText: null
                });
            }
        } catch (err: any) {
            await showConfirmModal({
                icon: 'fa-circle-exclamation',
                iconBg: '#FEF2F2',
                iconColor: '#DC2626',
                title: this._t('renderer.browser.modal.actionFailed'),
                message: err?.message || String(err),
                confirmText: this._t('renderer.browser.modal.acknowledge'),
                cancelText: null
            });
        }
    }

    private async _confirmAndClearAllData(): Promise<void> {
        const confirmed = await showConfirmModal({
            icon: 'fa-triangle-exclamation',
            iconBg: '#FEF2F2',
            iconColor: '#DC2626',
            title: this._t('renderer.browser.clearAll.title'),
            message: this._t('renderer.browser.clearAll.message'),
            confirmText: this._t('renderer.browser.clearAll.confirm'),
            cancelText: this._t('renderer.browser.modal.cancel'),
            danger: true
        });
        if (confirmed) {
            // 清除应用侧历史记录
            this.history = [];
            saveHistory(this.history);
            // 清除浏览器数据
            await this._callBrowserMain('clearAllBrowserData', this._t('renderer.browser.msg.allDataCleared'));
        }
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

    public clearBrowsingData(): void {
        if (confirm(this._t('renderer.browser.histClear.confirmData'))) {
            this.history = [];
            saveHistory(this.history);
        }
    }

    private async captureAndSaveSnapshot(): Promise<void> {
        const tab = this.getActiveTab();
        if (!tab?.ready || !tab.webview) {
            await showConfirmModal({
                icon: 'fa-circle-exclamation',
                iconBg: '#FEF2F2',
                iconColor: '#DC2626',
                title: this._t('renderer.browser.snapshot.notReady.title'),
                message: this._t('renderer.browser.snapshot.notReady.tab'),
                confirmText: this._t('renderer.browser.modal.acknowledge'),
                cancelText: null
            });
            return;
        }

        let webContentsId: number;
        try {
            webContentsId = (tab.webview as any).getWebContentsId();
        } catch {
            await showConfirmModal({
                icon: 'fa-circle-exclamation',
                iconBg: '#FEF2F2',
                iconColor: '#DC2626',
                title: this._t('renderer.browser.snapshot.notReady.title'),
                message: this._t('renderer.browser.snapshot.notReady.handle'),
                confirmText: this._t('renderer.browser.modal.acknowledge'),
                cancelText: null
            });
            return;
        }

        const registryAPI = (window as any).applicationRegistryAPI;
        if (!registryAPI?.callMainWorld) {
            await showConfirmModal({
                icon: 'fa-circle-exclamation',
                iconBg: '#FEF2F2',
                iconColor: '#DC2626',
                title: this._t('renderer.browser.snapshot.notReady.title'),
                message: this._t('renderer.browser.snapshot.unsupported'),
                confirmText: this._t('renderer.browser.modal.acknowledge'),
                cancelText: null
            });
            return;
        }

        try {
            await registryAPI.callMainWorld('browser', 'exportSnapshotByWebContentsId', webContentsId);
            await showConfirmModal({
                icon: 'fa-circle-check',
                iconBg: '#ECFDF5',
                iconColor: '#059669',
                title: this._t('renderer.browser.snapshot.saved.title'),
                message: this._t('renderer.browser.snapshot.saved.message'),
                confirmText: this._t('renderer.browser.modal.acknowledge'),
                cancelText: null
            });
        } catch (err: any) {
            await showConfirmModal({
                icon: 'fa-circle-exclamation',
                iconBg: '#FEF2F2',
                iconColor: '#DC2626',
                title: this._t('renderer.browser.snapshot.failed.title'),
                message: this._t('renderer.browser.snapshot.failed.message', { message: err?.message || String(err) }),
                confirmText: this._t('renderer.browser.modal.acknowledge'),
                cancelText: null
            });
        }
    }

    private openWebviewDevTools(): void {
        const tab = this.getActiveTab();
        if (!tab?.ready || !tab.webview) {
            alert(this._t('renderer.browser.alert.tabNotReady'));
            return;
        }
        try {
            (tab.webview as any).openDevTools();
        } catch {
            alert(this._t('renderer.browser.alert.devtoolsFailed'));
        }
    }

    public openHistoryPanel(): void {
        this.closeAllPanels();
        if (!this.historyPanelEl) return;

        this.renderHistoryPanel('');
        this.historyPanelEl.classList.add('wb-visible');
    }

    public renderHistoryPanel(filter: string): void {
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
                <span class="wb-panel-header-title">${this._t('renderer.browser.history.title')}</span>
                <button class="wb-panel-manage-btn wb-hist-open-manage">${this._t('renderer.browser.history.manage')}</button>
                <button class="wb-panel-close"><i class="fas fa-xmark"></i></button>
            </div>
            <input class="wb-panel-search" placeholder="${this._t('renderer.browser.history.search')}" value="${this.escapeHtml(filter)}">
            <div class="wb-panel-body">
                ${
                    deduped.length === 0
                        ? '<div class="wb-panel-empty">' + this._t('renderer.browser.history.empty') + '</div>'
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
                            <button class="wb-hi-delete" data-url="${this.escapeAttr(h.url)}" title="${this._t('renderer.browser.modal.delete')}"><i class="fas fa-xmark"></i></button>
                        </div>`
                              )
                              .join('')
                }
            </div>
            <div class="wb-panel-footer">
                <button class="wb-clear-btn">${this._t('renderer.browser.history.clearAll')}</button>
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
            if (confirm(this._t('renderer.browser.histClear.confirm1'))) {
                this.history = [];
                saveHistory(this.history);
                this.renderHistoryPanel('');
            }
        });
    }

    public openBookmarkManager(): void {
        this.closeAllPanels();
        if (!this.bookmarkMgrEl) return;

        this.renderBookmarkManager('');
        this.bookmarkMgrEl.classList.add('wb-visible');
    }

    public renderBookmarkManager(filter: string): void {
        if (!this.bookmarkMgrEl) return;

        const lf = filter.toLowerCase();
        const filtered = lf
            ? this.bookmarks.filter((b) => b.url.toLowerCase().includes(lf) || b.title.toLowerCase().includes(lf))
            : this.bookmarks;

        this.bookmarkMgrEl.innerHTML = `
            <div class="wb-panel-header">
                <span class="wb-panel-header-title">${this._t('renderer.browser.fav.panel.title')}</span>
                <button class="wb-panel-manage-btn wb-bm-open-manage">${this._t('renderer.browser.history.manage')}</button>
                <button class="wb-panel-close"><i class="fas fa-xmark"></i></button>
            </div>
            <input class="wb-panel-search" placeholder="${this._t('renderer.browser.fav.panel.search')}" value="${this.escapeHtml(filter)}">
            <div class="wb-panel-body">
                ${
                    filtered.length === 0
                        ? '<div class="wb-panel-empty">' + this._t('renderer.browser.fav.panel.empty') + '</div>'
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
                                <button class="wb-bm-mgr-btn wb-bm-rename" data-id="${b.id}" title="${this._t('renderer.browser.fav.rename')}"><i class="fas fa-pen"></i></button>
                                <button class="wb-bm-mgr-btn wb-bm-delete" data-id="${b.id}" title="${this._t('renderer.browser.modal.delete')}"><i class="fas fa-trash-can"></i></button>
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
                    if (ev.key === 'Enter' && !ev.isComposing) {
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

    public closeAllPanels(): void {
        this.pagePanel.classList.remove('wb-visible');
        this.pageUrl = '';
        this.findBar.hidden = true;
        try {
            this.findGuest?.stopFindInPage('keepSelection');
        } catch {
            /* guest may be closed */
        }
        this.findGuest = null;
        this.historyPanelEl?.classList.remove('wb-visible');
        this.bookmarkMgrEl?.classList.remove('wb-visible');
        this.downloadPanelEl?.classList.remove('wb-visible');
        this.closeToolMenu();
    }

    public toggleDownloadPanel(): void {
        if (!this.downloadPanelEl) return;
        const isVisible = this.downloadPanelEl.classList.contains('wb-visible');
        if (isVisible) {
            this.downloadPanelEl.classList.remove('wb-visible');
        } else {
            this.closeAllPanels();
            this.renderDownloadPanel();
            this.downloadPanelEl.classList.add('wb-visible');
        }
    }

    public renderDownloadPanel(): void {
        if (!this.downloadPanelEl) return;

        const formatBytes = (bytes: number): string => {
            if (bytes === 0) return '0 B';
            const units = ['B', 'KB', 'MB', 'GB'];
            const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
            return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
        };

        const formatSpeed = (received: number, startTime: number): string => {
            const elapsed = (Date.now() - startTime) / 1000;
            if (elapsed < 0.5) return '';
            const speed = received / elapsed;
            return formatBytes(speed) + '/s';
        };

        this.downloadPanelEl.innerHTML = `
            <div class="wb-panel-header">
                <span class="wb-panel-header-title">${this._t('renderer.browser.dl.title')}</span>
                <button class="wb-panel-close"><i class="fas fa-xmark"></i></button>
            </div>
            <div class="wb-panel-body">
                ${
                    this.downloads.length === 0
                        ? '<div class="wb-panel-empty">' + this._t('renderer.browser.dl.empty') + '</div>'
                        : this.downloads
                              .map((dl) => {
                                  const pct =
                                      dl.totalBytes > 0 ? Math.round((dl.receivedBytes / dl.totalBytes) * 100) : 0;
                                  const isDone = dl.state === 'completed';
                                  const isCancelled = dl.state === 'cancelled';
                                  const iconClass = isDone ? 'wb-dl-done' : isCancelled ? 'wb-dl-cancelled' : '';
                                  const iconEl = isDone
                                      ? '<i class="fas fa-circle-check"></i>'
                                      : isCancelled
                                        ? '<i class="fas fa-circle-xmark"></i>'
                                        : '<i class="fas fa-arrow-down"></i>';
                                  let meta = formatBytes(dl.receivedBytes);
                                  if (dl.totalBytes > 0 && !isDone && !isCancelled) {
                                      meta += ' / ' + formatBytes(dl.totalBytes);
                                  }
                                  const speed =
                                      dl.state === 'progressing' ? formatSpeed(dl.receivedBytes, dl.startTime) : '';
                                  if (speed) meta += ' — ' + speed;
                                  if (isDone) meta += this._t('renderer.browser.dl.done');
                                  if (isCancelled) meta += this._t('renderer.browser.dl.cancelled');
                                  if (dl.state === 'interrupted') meta += this._t('renderer.browser.dl.interrupted');

                                  return `
                                        <div class="wb-dl-item" data-dl-id="${this.escapeAttr(dl.id)}">
                                            <span class="wb-dl-icon ${iconClass}">${iconEl}</span>
                                            <div class="wb-dl-content">
                                                <div class="wb-dl-filename" title="${this.escapeAttr(dl.filename)}">${this.escapeHtml(dl.filename)}</div>
                                                <div class="wb-dl-meta">${meta}</div>
                                                ${dl.state === 'progressing' ? `<div class="wb-dl-progress-wrap"><div class="wb-dl-progress-bar" style="width:${pct}%"></div></div>` : isDone ? `<div class="wb-dl-progress-wrap"><div class="wb-dl-progress-bar wb-dl-done" style="width:100%"></div></div>` : ''}
                                            </div>
                                            <div class="wb-dl-actions">
                                                ${dl.state === 'progressing' ? `<button class="wb-dl-btn wb-dl-cancel" title="${this._t('renderer.browser.dl.cancel')}"><i class="fas fa-xmark"></i></button>` : ''}
                                                ${isDone ? `<button class="wb-dl-btn wb-dl-open-file" title="${this._t('renderer.browser.dl.showInFolder')}"><i class="fas fa-folder-open"></i></button>` : ''}
                                                ${!dl.state || dl.state === 'completed' || isCancelled || dl.state === 'interrupted' ? `<button class="wb-dl-btn wb-dl-clear" title="${this._t('renderer.browser.dl.remove')}"><i class="fas fa-trash-can"></i></button>` : ''}
                                            </div>
                                        </div>`;
                              })
                              .join('')
                }
            </div>
        `;

        // Bind close button
        this.downloadPanelEl.querySelector('.wb-panel-close')?.addEventListener('click', () => {
            this.downloadPanelEl?.classList.remove('wb-visible');
        });

        // Bind cancel buttons
        this.downloadPanelEl.querySelectorAll('.wb-dl-cancel').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const item = (btn as HTMLElement).closest('.wb-dl-item') as HTMLElement;
                const dlId = item?.dataset.dlId;
                if (dlId) {
                    const downloadAPI = (window as any).downloadAPI;
                    downloadAPI?.cancelDownload(dlId);
                }
            });
        });

        // Bind open file/folder buttons
        this.downloadPanelEl.querySelectorAll('.wb-dl-open-file').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const item = (btn as HTMLElement).closest('.wb-dl-item') as HTMLElement;
                const dlId = item?.dataset.dlId;
                if (dlId) {
                    const downloadAPI = (window as any).downloadAPI;
                    downloadAPI?.openDownloadFolder(dlId);
                }
            });
        });

        // Bind clear buttons
        this.downloadPanelEl.querySelectorAll('.wb-dl-clear').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const item = (btn as HTMLElement).closest('.wb-dl-item') as HTMLElement;
                const dlId = item?.dataset.dlId;
                if (dlId) {
                    const downloadAPI = (window as any).downloadAPI;
                    if (downloadAPI)
                        void downloadAPI
                            .clearDownload(dlId)
                            .then(() => {
                                window.dispatchEvent(new CustomEvent('opendesk-download-removed', { detail: dlId }));
                            })
                            .catch((error: unknown) => console.error('Failed to remove browser download', error));
                }
            });
        });
    }

    public renderFavoritesPage(container: HTMLElement, selectedFolderId?: string, searchFilter?: string): void {
        const lf = (searchFilter || '').toLowerCase();
        const folders = this.bookmarks.filter((b) => b.isFolder);
        const allBookmarksLabel = this._t('renderer.browser.fav.allBookmarks');

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
                    <span class="wb-internal-title">${this._t('renderer.browser.fav.manageTitle')}</span>
                </div>
                <div class="wb-fav-layout">
                    <div class="wb-fav-tree">
                        <input class="wb-fav-tree-search" placeholder="${this._t('renderer.browser.fav.search')}" value="${this.escapeHtml(searchFilter || '')}">
                        <div class="wb-fav-tree-body">
                            <div class="wb-fav-tree-item${selId === '__all__' ? ' wb-selected' : ''}" data-folder-id="__all__">
                                <i class="fas fa-bookmark"></i>
                                <span class="wb-fav-tree-item-label">${allBookmarksLabel}</span>
                                <span class="wb-fav-tree-item-count">${totalCount}</span>
                            </div>
                            <div class="wb-fav-tree-item${selId === '__root__' ? ' wb-selected' : ''}" data-folder-id="__root__">
                                <i class="fas fa-bars"></i>
                                <span class="wb-fav-tree-item-label">${this._t('renderer.browser.fav.bar')}</span>
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
                                    ? '<div class="wb-fav-detail-empty">' +
                                      this._t('renderer.browser.fav.folderEmpty') +
                                      '</div>'
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
                                        <button class="wb-fav-detail-btn wb-fav-edit" data-id="${b.id}" title="${this._t('renderer.browser.modal.edit')}"><i class="fas fa-pen"></i></button>
                                        <button class="wb-fav-detail-btn wb-del wb-fav-del" data-id="${b.id}" title="${this._t('renderer.browser.modal.delete')}"><i class="fas fa-trash-can"></i></button>
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
                detailHeader.textContent = this._t('renderer.browser.fav.barWithCount', { count: rootItems.length });
                if (rootItems.length === 0) {
                    detailBody.innerHTML =
                        '<div class="wb-fav-detail-empty">' + this._t('renderer.browser.fav.barEmpty') + '</div>';
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
                                <button class="wb-fav-detail-btn wb-fav-edit" data-id="${b.id}" title="${this._t('renderer.browser.modal.edit')}"><i class="fas fa-pen"></i></button>
                                <button class="wb-fav-detail-btn wb-del wb-fav-del" data-id="${b.id}" title="${this._t('renderer.browser.modal.delete')}"><i class="fas fa-trash-can"></i></button>
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
                const newTitle = prompt(this._t('renderer.browser.fav.renamePrompt'), bm.title);
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

    public renderHistoryInternalPage(container: HTMLElement, searchFilter?: string): void {
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
            groupsHtml = `<div class="wb-hist-empty">${this._t('renderer.browser.history.empty')}</div>`;
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
                        <button class="wb-hist-item-del" data-url="${this.escapeAttr(h.url)}" title="${this._t('renderer.browser.modal.delete')}"><i class="fas fa-xmark"></i></button>
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
                    <span class="wb-internal-title">${this._t('renderer.browser.history.title')}</span>
                </div>
                <div class="wb-hist-layout">
                    <div class="wb-hist-toolbar">
                        <input class="wb-hist-search" placeholder="${this._t('renderer.browser.history.search')}" value="${this.escapeHtml(searchFilter || '')}">
                        <button class="wb-hist-clear-btn">${this._t('renderer.browser.history.clearAll')}</button>
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
            if (confirm(this._t('renderer.browser.histClear.confirm2'))) {
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
