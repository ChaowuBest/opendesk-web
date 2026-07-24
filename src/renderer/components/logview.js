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

import { createRendererTranslator } from '../locale.ts';

const MIN_ROW_HEIGHT = 24;
const ROW_VERTICAL_PADDING = 8;
const MESSAGE_LINE_HEIGHT = 14;
const MESSAGE_CHAR_WIDTH = 7.2;
const OVERSCAN_PX = 320;
const BATCH_SIZE = 200;
const LEVEL_COL_WIDTH = 80;
const TIME_COL_WIDTH = 140;
const EXPORT_MENU_MIN_WIDTH = 180;
const EXPORT_MENU_GAP = 6;
const EXPORT_MENU_VIEWPORT_PADDING = 8;

class LogView extends HTMLElement {
    constructor() {
        super();
        this._allEntries = [];
        this._filtered = [];
        this._filter = '';
        this._total = 0;
        this._fetchedUpTo = 0;
        this._pollTimer = null;
        this._debounceTimer = null;
        this._loading = false;
        this._scrollRAF = null;
        this._autoScroll = true;
        this._rowHeights = [];
        this._rowOffsets = [0];
        this._virtualHeight = 0;
        this._lastMetricsWidth = 0;
        this._resizeObserver = null;
        this._dismissExportMenu = null;
        this._exportMenuPositionHandler = null;
        this._t = createRendererTranslator();
        this._initSequence = 0;
        this._settingUnsubscribe = null;
    }

    connectedCallback() {
        this._initSequence += 1;
        void this._initialize(this._initSequence);
    }

    disconnectedCallback() {
        this._initSequence += 1;
        if (this._pollTimer) clearInterval(this._pollTimer);
        if (this._debounceTimer) clearTimeout(this._debounceTimer);
        if (this._scrollRAF) cancelAnimationFrame(this._scrollRAF);
        if (this._resizeObserver) this._resizeObserver.disconnect();
        if (this._settingUnsubscribe) {
            this._settingUnsubscribe();
            this._settingUnsubscribe = null;
        }
        this._hideExportMenu();
    }

    async _initialize(initSequence) {
        try {
            const setting = await window.settingAPI.loadSettingObject();
            this._t = createRendererTranslator(setting);
            this._settingUnsubscribe = window.settingAPI.onSettingChanged?.((newSetting) => {
                this._t = createRendererTranslator(newSetting);
                this._rerenderLocalizedChrome();
            });
        } catch {
            // Use browser locale fallback when settings are unavailable.
        }
        if (!this.isConnected || initSequence !== this._initSequence) return;
        this.render();
        this.bindEvents();
        this._initialLoad();
        this._pollTimer = setInterval(() => this._pollNew(), 3000);
    }

    _rerenderLocalizedChrome() {
        const previousFilter = this._filter;
        this._hideExportMenu();
        if (this._resizeObserver) {
            this._resizeObserver.disconnect();
            this._resizeObserver = null;
        }
        this.render();
        this.bindEvents();
        const input = this.querySelector('#log-filter-input');
        const clearBtn = this.querySelector('#log-filter-clear');
        if (input) input.value = previousFilter;
        if (clearBtn) clearBtn.classList.toggle('hidden', !previousFilter);
        this._invalidateRowMetrics();
        this._applyFilter();
    }

    async _initialLoad() {
        this._loading = true;
        try {
            const data = await window.settingAPI.getLogEntries({ offset: 0, limit: BATCH_SIZE });
            this._allEntries = data.entries;
            this._total = data.total;
            this._fetchedUpTo = data.entries.length;
            if (data.hasMore) await this._fetchAll();
            this._applyFilter();
            this._scrollToBottom();
        } catch (e) {
            // fail silently on initial load
        } finally {
            this._loading = false;
        }
    }

    async _fetchAll() {
        while (this._fetchedUpTo < this._total) {
            const data = await window.settingAPI.getLogEntries({
                offset: this._fetchedUpTo,
                limit: BATCH_SIZE
            });
            if (data.entries.length === 0) break;
            this._allEntries = this._allEntries.concat(data.entries);
            this._fetchedUpTo += data.entries.length;
            this._total = data.total;
        }
    }

    async _pollNew() {
        if (this._loading) return;
        try {
            const data = await window.settingAPI.getLogEntries({
                offset: this._fetchedUpTo,
                limit: BATCH_SIZE
            });
            if (data.total !== this._total || data.entries.length > 0) {
                this._total = data.total;
                if (data.entries.length > 0) {
                    this._allEntries = this._allEntries.concat(data.entries);
                    this._fetchedUpTo += data.entries.length;
                    if (data.hasMore) await this._fetchAll();
                }
                const wasAtBottom = this._autoScroll;
                this._applyFilter();
                if (wasAtBottom) this._scrollToBottom();
                this._updateCounter();
            }
        } catch (e) {
            // poll errors are non-critical
        }
    }

    _applyFilter() {
        if (this._filter) {
            const kw = this._filter.toLowerCase();
            this._filtered = this._allEntries.filter(
                (e) =>
                    e.message.toLowerCase().includes(kw) ||
                    e.timestamp.toLowerCase().includes(kw) ||
                    e.level.toLowerCase().includes(kw)
            );
        } else {
            this._filtered = this._allEntries;
        }
        this._invalidateRowMetrics();
        this._updateVirtualHeight();
        this._renderVisible();
        this._updateCounter();
    }

    escapeHtml(text) {
        if (!text) return '';
        return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    normalizeLevel(level) {
        return String(level || 'info')
            .replace(/\x1b\[[0-9;]*m/g, '')
            .trim()
            .toLowerCase();
    }

    getLevelConfig(level) {
        const n = this.normalizeLevel(level);
        const c = {
            error: { icon: 'fa-times-circle', color: 'text-red-500', label: this._t('renderer.log.level.error') },
            warn: {
                icon: 'fa-exclamation-triangle',
                color: 'text-amber-500',
                label: this._t('renderer.log.level.warning')
            },
            warning: {
                icon: 'fa-exclamation-triangle',
                color: 'text-amber-500',
                label: this._t('renderer.log.level.warning')
            },
            info: { icon: 'fa-info-circle', color: 'text-blue-500', label: this._t('renderer.log.level.info') },
            debug: { icon: 'fa-bug', color: 'text-gray-400', label: this._t('renderer.log.level.debug') },
            verbose: { icon: 'fa-comment', color: 'text-gray-400', label: this._t('renderer.log.level.verbose') }
        };
        return c[n] || c.info;
    }

    render() {
        this.innerHTML = `
        <div class="od-log-view w-full h-full overflow-hidden flex flex-col bg-gradient-to-br from-slate-50 via-white to-blue-50/30">
            <div class="od-log-header sticky top-0 z-10 px-4 py-2 flex items-center bg-white/60 backdrop-blur-2xl border-b border-gray-100/50">
                <div class="flex items-center gap-2">
                    <div class="od-log-icon w-5 h-5 rounded-md bg-indigo-500/10 flex items-center justify-center">
                        <i class="fas fa-file-lines text-indigo-500" style="font-size:9px"></i>
                    </div>
                    <h1 class="od-log-title text-sm font-bold bg-gradient-to-r from-gray-800 to-gray-600 bg-clip-text text-transparent">${this.escapeHtml(this._t('renderer.log.title'))}</h1>
                    <span id="log-counter" class="od-log-counter text-[10px] text-gray-400 ml-1"></span>
                </div>
            </div>

            <div class="flex-1 flex flex-col overflow-hidden px-3 pt-2 pb-2 gap-2">
                <div class="od-log-toolbar flex items-center gap-2">
                    <div class="od-log-search relative flex-1">
                        <i class="od-log-search-icon fas fa-search absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-300" style="font-size:10px;pointer-events:none"></i>
                        <input id="log-filter-input" type="text" placeholder="${this.escapeHtml(this._t('renderer.log.filterPlaceholder'))}"
                            class="od-log-filter-input w-full pl-7 pr-7 py-1 text-[11px] bg-white/70 backdrop-blur-sm border border-gray-200/60 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-400/30 focus:border-blue-300/50 transition-all placeholder-gray-300">
                        <button id="log-filter-clear" class="od-log-filter-clear absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 rounded-full bg-gray-200 hover:bg-gray-300 text-gray-500 flex items-center justify-center transition-colors hidden" title="${this.escapeHtml(this._t('renderer.log.clearFilter'))}">
                            <i class="fas fa-times" style="font-size:8px"></i>
                        </button>
                    </div>
                    <button id="log-goto-bottom" class="od-log-goto-bottom shrink-0 px-2.5 py-1 text-[11px] text-gray-500 bg-white/70 backdrop-blur-sm border border-gray-200/60 rounded-md hover:bg-gray-50 hover:border-gray-300/60 transition-all flex items-center gap-1" title="${this.escapeHtml(this._t('renderer.log.gotoLatest'))}">
                        <i class="fas fa-angle-double-down" style="font-size:9px"></i>
                        <span>${this.escapeHtml(this._t('renderer.log.latest'))}</span>
                    </button>
                    <div class="od-log-export relative shrink-0">
                        <button id="log-export-btn" class="od-log-export-btn px-2.5 py-1 text-[11px] text-gray-500 bg-white/70 backdrop-blur-sm border border-gray-200/60 rounded-md hover:bg-gray-50 hover:border-gray-300/60 transition-all flex items-center gap-1" title="${this.escapeHtml(this._t('renderer.log.export'))}" aria-haspopup="menu" aria-expanded="false">
                            <i class="fas fa-download" style="font-size:9px"></i>
                            <span>${this.escapeHtml(this._t('renderer.log.export'))}</span>
                            <i class="fas fa-chevron-down" style="font-size:7px"></i>
                        </button>
                        <div id="log-export-menu" class="od-log-export-menu hidden z-50 min-w-[180px] rounded-lg border border-gray-200/70 bg-white/95 shadow-lg backdrop-blur-xl py-1" role="menu">
                            <button type="button" class="od-log-export-menu-item w-full px-3 py-1.5 text-left text-[11px] text-gray-600 hover:bg-blue-50 hover:text-gray-800 flex items-center gap-2" data-log-export-scope="filtered" role="menuitem">
                                <i class="fas fa-filter text-gray-400" style="font-size:10px"></i>
                                <span>${this.escapeHtml(this._t('renderer.log.exportFiltered'))}</span>
                            </button>
                            <button type="button" class="od-log-export-menu-item w-full px-3 py-1.5 text-left text-[11px] text-gray-600 hover:bg-blue-50 hover:text-gray-800 flex items-center gap-2" data-log-export-scope="all" role="menuitem">
                                <i class="fas fa-list text-gray-400" style="font-size:10px"></i>
                                <span>${this.escapeHtml(this._t('renderer.log.exportAll'))}</span>
                            </button>
                        </div>
                    </div>
                </div>

                <div class="od-log-table flex-1 flex flex-col overflow-hidden rounded-lg border border-gray-200/80">
                    <div class="od-log-table-head grid grid-cols-[80px_140px_minmax(0,1fr)] px-3 py-1 bg-gray-50/90 border-b border-gray-200/60 text-[10px] font-semibold text-gray-400 select-none">
                        <span>${this.escapeHtml(this._t('renderer.log.column.level'))}</span>
                        <span>${this.escapeHtml(this._t('renderer.log.column.time'))}</span>
                        <span>${this.escapeHtml(this._t('renderer.log.column.content'))}</span>
                    </div>
                    <div id="log-scroll-container" class="od-log-scroll flex-1 overflow-y-auto relative" style="will-change:transform">
                        <div id="log-virtual-spacer" class="relative w-full">
                            <div id="log-virtual-rows" class="absolute top-0 left-0 w-full"></div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        `;
    }

    bindEvents() {
        const input = this.querySelector('#log-filter-input');
        const clearBtn = this.querySelector('#log-filter-clear');
        const gotoBottom = this.querySelector('#log-goto-bottom');
        const exportBtn = this.querySelector('#log-export-btn');
        const exportMenu = this.querySelector('#log-export-menu');
        const scroller = this.querySelector('#log-scroll-container');

        input.addEventListener('input', () => {
            if (this._debounceTimer) clearTimeout(this._debounceTimer);
            this._debounceTimer = setTimeout(() => {
                this._filter = input.value.trim();
                clearBtn.classList.toggle('hidden', !this._filter);
                this._applyFilter();
            }, 250);
        });

        clearBtn.addEventListener('click', () => {
            input.value = '';
            this._filter = '';
            clearBtn.classList.add('hidden');
            this._applyFilter();
        });

        gotoBottom.addEventListener('click', () => {
            this._scrollToBottom();
        });

        exportBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            this._toggleExportMenu();
        });

        exportMenu.addEventListener('click', (event) => {
            const item = event.target instanceof Element ? event.target.closest('[data-log-export-scope]') : null;
            if (!item) return;
            this._hideExportMenu();
            void this._exportLogs(item.dataset.logExportScope);
        });

        scroller.addEventListener('scroll', () => {
            if (this._scrollRAF) cancelAnimationFrame(this._scrollRAF);
            this._scrollRAF = requestAnimationFrame(() => this._onScroll());
        });

        if (window.ResizeObserver) {
            this._resizeObserver = new ResizeObserver(() => {
                this._invalidateRowMetrics();
                this._updateVirtualHeight();
                this._renderVisible();
                this._positionExportMenu();
            });
            this._resizeObserver.observe(scroller);
        }
    }

    _toggleExportMenu() {
        const menu = this.querySelector('#log-export-menu');
        if (!menu) return;
        if (menu.classList.contains('hidden')) {
            this._showExportMenu();
        } else {
            this._hideExportMenu();
        }
    }

    _showExportMenu() {
        const menu = this.querySelector('#log-export-menu');
        const button = this.querySelector('#log-export-btn');
        if (!menu) return;
        menu.classList.remove('hidden');
        this._positionExportMenu();
        this._startExportMenuPositionTracking();
        button?.setAttribute('aria-expanded', 'true');

        const click = (event) => {
            if (!this.contains(event.target)) {
                this._hideExportMenu();
            }
        };
        const keydown = (event) => {
            if (event.key === 'Escape') {
                this._hideExportMenu();
            }
        };
        this._dismissExportMenu = { click, keydown };
        setTimeout(() => {
            if (this._dismissExportMenu?.click !== click) return;
            document.addEventListener('click', click, true);
            document.addEventListener('keydown', keydown, true);
        }, 0);
    }

    _hideExportMenu() {
        const menu = this.querySelector('#log-export-menu');
        const button = this.querySelector('#log-export-btn');
        menu?.classList.add('hidden');
        if (menu) {
            menu.removeAttribute('style');
        }
        button?.setAttribute('aria-expanded', 'false');
        this._stopExportMenuPositionTracking();
        if (this._dismissExportMenu) {
            document.removeEventListener('click', this._dismissExportMenu.click, true);
            document.removeEventListener('keydown', this._dismissExportMenu.keydown, true);
            this._dismissExportMenu = null;
        }
    }

    _positionExportMenu() {
        const menu = this.querySelector('#log-export-menu');
        const button = this.querySelector('#log-export-btn');
        if (!menu || !button || menu.classList.contains('hidden')) return;

        menu.style.position = 'fixed';
        menu.style.zIndex = '9999';
        menu.style.visibility = 'hidden';
        menu.style.left = '0px';
        menu.style.top = '0px';
        menu.style.width = `${EXPORT_MENU_MIN_WIDTH}px`;
        menu.style.maxWidth = `${Math.max(120, window.innerWidth - EXPORT_MENU_VIEWPORT_PADDING * 2)}px`;
        menu.style.overflowY = 'auto';

        const buttonRect = button.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        const maxMenuWidth = Math.max(120, viewportWidth - EXPORT_MENU_VIEWPORT_PADDING * 2);
        const measuredWidth = Math.min(
            Math.max(menu.getBoundingClientRect().width, EXPORT_MENU_MIN_WIDTH),
            maxMenuWidth
        );
        menu.style.width = `${measuredWidth}px`;

        const availableBelow = viewportHeight - buttonRect.bottom - EXPORT_MENU_GAP - EXPORT_MENU_VIEWPORT_PADDING;
        const availableAbove = buttonRect.top - EXPORT_MENU_GAP - EXPORT_MENU_VIEWPORT_PADDING;
        const openAbove = availableBelow < menu.scrollHeight && availableAbove > availableBelow;
        const maxViewportMenuHeight = Math.max(40, viewportHeight - EXPORT_MENU_VIEWPORT_PADDING * 2);
        const availableHeight = Math.min(
            maxViewportMenuHeight,
            Math.max(40, openAbove ? availableAbove : availableBelow)
        );
        menu.style.maxHeight = `${availableHeight}px`;

        const menuRect = menu.getBoundingClientRect();
        const maxLeft = Math.max(
            EXPORT_MENU_VIEWPORT_PADDING,
            viewportWidth - EXPORT_MENU_VIEWPORT_PADDING - menuRect.width
        );
        const maxTop = Math.max(
            EXPORT_MENU_VIEWPORT_PADDING,
            viewportHeight - EXPORT_MENU_VIEWPORT_PADDING - menuRect.height
        );
        const left = Math.min(Math.max(EXPORT_MENU_VIEWPORT_PADDING, buttonRect.right - menuRect.width), maxLeft);
        const preferredTop = openAbove
            ? buttonRect.top - EXPORT_MENU_GAP - menuRect.height
            : buttonRect.bottom + EXPORT_MENU_GAP;
        const top = Math.min(Math.max(EXPORT_MENU_VIEWPORT_PADDING, preferredTop), maxTop);

        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
        menu.style.visibility = '';
    }

    _startExportMenuPositionTracking() {
        if (this._exportMenuPositionHandler) return;
        this._exportMenuPositionHandler = () => this._positionExportMenu();
        window.addEventListener('resize', this._exportMenuPositionHandler, true);
        window.addEventListener('scroll', this._exportMenuPositionHandler, true);
    }

    _stopExportMenuPositionTracking() {
        if (!this._exportMenuPositionHandler) return;
        window.removeEventListener('resize', this._exportMenuPositionHandler, true);
        window.removeEventListener('scroll', this._exportMenuPositionHandler, true);
        this._exportMenuPositionHandler = null;
    }

    async _exportLogs(scope) {
        const normalizedScope = scope === 'filtered' ? 'filtered' : 'all';
        const exportBtn = this.querySelector('#log-export-btn');
        const input = this.querySelector('#log-filter-input');
        const filter = normalizedScope === 'filtered' ? input?.value.trim() || '' : '';
        try {
            exportBtn?.setAttribute('disabled', 'true');
            exportBtn?.classList.add('opacity-60');
            await window.settingAPI.exportLogEntries({ scope: normalizedScope, filter });
        } catch (e) {
            const message = e?.message || String(e);
            window.alert(this._t('renderer.log.exportFailed', { message }));
        } finally {
            exportBtn?.removeAttribute('disabled');
            exportBtn?.classList.remove('opacity-60');
        }
    }

    _onScroll() {
        const scroller = this.querySelector('#log-scroll-container');
        if (!scroller) return;
        const threshold = 40;
        this._autoScroll = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - threshold;
        this._renderVisible();
    }

    _invalidateRowMetrics() {
        this._rowHeights = [];
        this._rowOffsets = [0];
        this._virtualHeight = 0;
        this._lastMetricsWidth = 0;
    }

    _getMessageColumnWidth() {
        const scroller = this.querySelector('#log-scroll-container');
        const width = scroller?.clientWidth || this.clientWidth || 800;
        return Math.max(120, width - LEVEL_COL_WIDTH - TIME_COL_WIDTH - 24);
    }

    _estimateRowHeight(entry, messageWidth) {
        const message = String(entry?.message || '');
        const charsPerLine = Math.max(1, Math.floor(messageWidth / MESSAGE_CHAR_WIDTH));
        const lines = message.split(/\r?\n/);
        const visualLineCount = lines.reduce((count, line) => {
            return count + Math.max(1, Math.ceil(line.length / charsPerLine));
        }, 0);
        return Math.max(MIN_ROW_HEIGHT, visualLineCount * MESSAGE_LINE_HEIGHT + ROW_VERTICAL_PADDING);
    }

    _ensureRowMetrics() {
        const messageWidth = this._getMessageColumnWidth();
        if (this._lastMetricsWidth === messageWidth && this._rowHeights.length === this._filtered.length) {
            return;
        }

        const rowHeights = new Array(this._filtered.length);
        const rowOffsets = new Array(this._filtered.length + 1);
        let offset = 0;
        rowOffsets[0] = 0;
        for (let i = 0; i < this._filtered.length; i++) {
            const height = this._estimateRowHeight(this._filtered[i], messageWidth);
            rowHeights[i] = height;
            offset += height;
            rowOffsets[i + 1] = offset;
        }
        this._rowHeights = rowHeights;
        this._rowOffsets = rowOffsets;
        this._virtualHeight = offset;
        this._lastMetricsWidth = messageWidth;
    }

    _findIndexForOffset(offset) {
        const count = this._filtered.length;
        if (count === 0) return 0;
        let low = 0;
        let high = count;
        while (low < high) {
            const mid = Math.floor((low + high) / 2);
            if (this._rowOffsets[mid] <= offset) {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        return Math.max(0, Math.min(count - 1, low - 1));
    }

    _updateVirtualHeight() {
        const spacer = this.querySelector('#log-virtual-spacer');
        this._ensureRowMetrics();
        if (spacer) {
            spacer.style.height = `${this._virtualHeight}px`;
        }
    }

    _renderVisible() {
        const scroller = this.querySelector('#log-scroll-container');
        const container = this.querySelector('#log-virtual-rows');
        if (!scroller || !container) return;

        const count = this._filtered.length;
        if (count === 0) {
            container.style.transform = 'translateY(0)';
            container.innerHTML = `
                <div class="od-log-empty flex flex-col items-center justify-center py-12 text-gray-300">
                    <i class="fas fa-inbox text-3xl mb-2"></i>
                    <span class="text-xs">${this.escapeHtml(this._filter ? this._t('renderer.log.emptyFiltered') : this._t('renderer.log.empty'))}</span>
                </div>`;
            return;
        }

        const scrollTop = scroller.scrollTop;
        const viewH = scroller.clientHeight;

        this._ensureRowMetrics();
        const startIdx = this._findIndexForOffset(Math.max(0, scrollTop - OVERSCAN_PX));
        const endIdx = Math.min(count, this._findIndexForOffset(scrollTop + viewH + OVERSCAN_PX) + 1);

        container.style.transform = `translateY(${this._rowOffsets[startIdx]}px)`;

        let html = '';
        for (let i = startIdx; i < endIdx; i++) {
            const entry = this._filtered[i];
            const level = this.normalizeLevel(entry.level);
            const cfg = this.getLevelConfig(entry.level);
            const stripe = i % 2 === 0 ? '' : 'od-log-row-alt bg-gray-50/40';
            const rowHeight = this._rowHeights[i] || MIN_ROW_HEIGHT;
            html += `<div class="od-log-row grid grid-cols-[80px_140px_minmax(0,1fr)] px-3 py-1 items-start ${stripe} hover:bg-blue-50/40 transition-colors border-b border-gray-100/50" data-log-level="${this.escapeHtml(level)}" style="min-height:${rowHeight}px">
                <div class="od-log-level flex items-center gap-1 overflow-hidden min-w-0">
                    <span class="od-log-level-pill flex items-center gap-1 min-w-0 h-4 px-1.5 rounded">
                        <i class="od-log-level-icon fas ${cfg.icon} ${cfg.color}" style="font-size:9px"></i>
                        <span class="od-log-level-label ${cfg.color} text-[10px] font-medium truncate">${this.escapeHtml(cfg.label)}</span>
                    </span>
                </div>
                <span class="od-log-time text-[10px] text-gray-400 font-mono truncate" title="${this.escapeHtml(entry.timestamp)}">${this.escapeHtml(entry.timestamp)}</span>
                <span class="od-log-message min-w-0 text-[10px] text-gray-600 font-mono" title="${this.escapeHtml(entry.message)}" style="white-space:pre-wrap;overflow-wrap:anywhere;line-height:${MESSAGE_LINE_HEIGHT}px">${this.escapeHtml(entry.message)}</span>
            </div>`;
        }
        container.innerHTML = html;
    }

    _scrollToBottom() {
        const scroller = this.querySelector('#log-scroll-container');
        if (scroller) {
            this._autoScroll = true;
            this._updateVirtualHeight();
            scroller.scrollTop = this._virtualHeight;
        }
    }

    _updateCounter() {
        const el = this.querySelector('#log-counter');
        if (!el) return;
        if (this._filter && this._filtered.length !== this._allEntries.length) {
            el.textContent = this._t('renderer.log.counterFiltered', {
                filtered: this._filtered.length,
                total: this._allEntries.length
            });
        } else {
            el.textContent = this._t('renderer.log.counter', { count: this._allEntries.length });
        }
    }
}

customElements.define('log-view', LogView);
