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

const ROW_HEIGHT = 32;
const OVERSCAN = 10;
const BATCH_SIZE = 200;

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
    }

    connectedCallback() {
        this.render();
        this.bindEvents();
        this._initialLoad();
        this._pollTimer = setInterval(() => this._pollNew(), 3000);
    }

    disconnectedCallback() {
        if (this._pollTimer) clearInterval(this._pollTimer);
        if (this._debounceTimer) clearTimeout(this._debounceTimer);
        if (this._scrollRAF) cancelAnimationFrame(this._scrollRAF);
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
        this._updateVirtualHeight();
        this._renderVisible();
        this._updateCounter();
    }

    escapeHtml(text) {
        if (!text) return '';
        return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    getLevelConfig(level) {
        const n = level
            .replace(/\x1b\[[0-9;]*m/g, '')
            .trim()
            .toLowerCase();
        const c = {
            error: { icon: 'fa-times-circle', color: 'text-red-500', label: 'Error' },
            warn: { icon: 'fa-exclamation-triangle', color: 'text-amber-500', label: 'Warning' },
            warning: { icon: 'fa-exclamation-triangle', color: 'text-amber-500', label: 'Warning' },
            info: { icon: 'fa-info-circle', color: 'text-blue-500', label: 'Info' },
            debug: { icon: 'fa-bug', color: 'text-gray-400', label: 'Debug' },
            verbose: { icon: 'fa-comment', color: 'text-gray-400', label: 'Verbose' }
        };
        return c[n] || c.info;
    }

    render() {
        this.innerHTML = `
        <div class="w-full h-full overflow-hidden flex flex-col bg-gradient-to-br from-slate-50 via-white to-blue-50/30">
            <div class="sticky top-0 z-10 px-6 py-4 flex items-center bg-white/60 backdrop-blur-2xl border-b border-gray-100/50">
                <div class="flex items-center gap-2.5">
                    <div class="w-7 h-7 rounded-lg bg-indigo-500/10 flex items-center justify-center">
                        <i class="fas fa-file-lines text-indigo-500 text-xs"></i>
                    </div>
                    <h1 class="text-xl font-bold bg-gradient-to-r from-gray-800 to-gray-600 bg-clip-text text-transparent">日志</h1>
                    <span id="log-counter" class="text-[11px] text-gray-400 ml-1"></span>
                </div>
            </div>

            <div class="flex-1 flex flex-col overflow-hidden px-5 pt-4 pb-3 gap-3">
                <div class="flex items-center gap-2.5">
                    <div class="relative flex-1">
                        <i class="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-gray-300 text-xs pointer-events-none"></i>
                        <input id="log-filter-input" type="text" placeholder="筛选日志..."
                            class="w-full pl-8 pr-8 py-2 text-xs bg-white/70 backdrop-blur-sm border border-gray-200/60 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400/30 focus:border-blue-300/50 transition-all placeholder-gray-300">
                        <button id="log-filter-clear" class="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 rounded-full bg-gray-200 hover:bg-gray-300 text-gray-500 flex items-center justify-center transition-colors hidden" title="清除搜索">
                            <i class="fas fa-times" style="font-size:8px"></i>
                        </button>
                    </div>
                    <button id="log-goto-bottom" class="shrink-0 px-3 py-2 text-xs text-gray-500 bg-white/70 backdrop-blur-sm border border-gray-200/60 rounded-lg hover:bg-gray-50 hover:border-gray-300/60 transition-all flex items-center gap-1.5" title="跳转到最底部">
                        <i class="fas fa-angle-double-down" style="font-size:10px"></i>
                        <span>最新</span>
                    </button>
                </div>

                <div class="flex-1 flex flex-col overflow-hidden rounded-lg border border-gray-200/80">
                    <div class="grid grid-cols-[100px_160px_1fr] px-4 py-2 bg-gray-50/90 border-b border-gray-200/60 text-[11px] font-semibold text-gray-400 uppercase tracking-wider select-none">
                        <span>级别</span>
                        <span>时间</span>
                        <span>内容</span>
                    </div>
                    <div id="log-scroll-container" class="flex-1 overflow-y-auto relative" style="will-change:transform">
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

        scroller.addEventListener('scroll', () => {
            if (this._scrollRAF) cancelAnimationFrame(this._scrollRAF);
            this._scrollRAF = requestAnimationFrame(() => this._onScroll());
        });
    }

    _onScroll() {
        const scroller = this.querySelector('#log-scroll-container');
        if (!scroller) return;
        const threshold = 40;
        this._autoScroll = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - threshold;
        this._renderVisible();
    }

    _updateVirtualHeight() {
        const spacer = this.querySelector('#log-virtual-spacer');
        if (spacer) {
            spacer.style.height = `${this._filtered.length * ROW_HEIGHT}px`;
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
                <div class="flex flex-col items-center justify-center py-12 text-gray-300">
                    <i class="fas fa-inbox text-3xl mb-2"></i>
                    <span class="text-xs">${this._filter ? '没有匹配的日志' : '暂无日志'}</span>
                </div>`;
            return;
        }

        const scrollTop = scroller.scrollTop;
        const viewH = scroller.clientHeight;

        let startIdx = Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN;
        let endIdx = Math.ceil((scrollTop + viewH) / ROW_HEIGHT) + OVERSCAN;
        startIdx = Math.max(0, startIdx);
        endIdx = Math.min(count, endIdx);

        container.style.transform = `translateY(${startIdx * ROW_HEIGHT}px)`;

        let html = '';
        for (let i = startIdx; i < endIdx; i++) {
            const entry = this._filtered[i];
            const cfg = this.getLevelConfig(entry.level);
            const stripe = i % 2 === 0 ? '' : 'bg-gray-50/40';
            html += `<div class="grid grid-cols-[100px_160px_1fr] px-4 items-center ${stripe} hover:bg-blue-50/40 transition-colors border-b border-gray-100/50" style="height:${ROW_HEIGHT}px">
                <div class="flex items-center gap-1.5 overflow-hidden">
                    <i class="fas ${cfg.icon} ${cfg.color}" style="font-size:10px"></i>
                    <span class="${cfg.color} text-[11px] font-medium truncate">${this.escapeHtml(cfg.label)}</span>
                </div>
                <span class="text-[11px] text-gray-400 font-mono truncate">${this.escapeHtml(entry.timestamp)}</span>
                <span class="text-[11px] text-gray-600 font-mono truncate">${this.escapeHtml(entry.message)}</span>
            </div>`;
        }
        container.innerHTML = html;
    }

    _scrollToBottom() {
        const scroller = this.querySelector('#log-scroll-container');
        if (scroller) {
            this._autoScroll = true;
            scroller.scrollTop = scroller.scrollHeight;
        }
    }

    _updateCounter() {
        const el = this.querySelector('#log-counter');
        if (!el) return;
        if (this._filter && this._filtered.length !== this._allEntries.length) {
            el.textContent = `${this._filtered.length} / ${this._allEntries.length} 条`;
        } else {
            el.textContent = `${this._allEntries.length} 条`;
        }
    }
}

customElements.define('log-view', LogView);
