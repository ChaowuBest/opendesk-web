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

const t = createRendererTranslator();

/**
 * 任务状态浮窗组件。
 *
 * 外观对齐 docs/designs/agent-panel-combo.html：包含两个内部状态——
 * 「任务列表」与「任务详情」。点击列表项进入详情，详情内「打开会话」才恢复
 * 主窗口并跳转对应任务。支持深/浅色双模式。
 */

const CLOSE_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
const CHEVRON_SVG = `<svg class="chev" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>`;
const BACK_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg>`;
const TODO_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`;
const SUBTASK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="12" r="2.5"/><line x1="8" y1="7.2" x2="15.6" y2="10.8"/><line x1="8" y1="16.8" x2="15.6" y2="13.2"/></svg>`;
const CLOCK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
const UP_SVG = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>`;
const DOWN_SVG = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>`;
const DONE_CHECK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="8 12.5 11 15.5 16 9.5"/></svg>`;

const WIDGET_CSS = `
:host {
    display: block;
    width: 100%;
    height: 100%;
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', 'Helvetica Neue',
        'Microsoft YaHei', sans-serif;
    color-scheme: light dark;
    -webkit-font-smoothing: antialiased;

    /* 设计 Token（与 agent-panel-combo.html 同源） */
    --bg: #232120;
    --card: #2a2826;
    --card-hover: #33302d;
    --line: #3b3835;
    --line-soft: #33302d;
    --ink: #efedea;
    --ink2: #d5d1cb;
    --ink3: #9b968f;
    --ink4: #6f6a63;
    --accent: #e8563f;
    --accent-soft: rgba(232, 86, 63, 0.16);
    --accent-hover: #ed6b56;
    --green: #3dbf82;
    --green-soft: rgba(61, 191, 130, 0.15);
    --amber: #e2a23b;
    --amber-soft: rgba(226, 162, 59, 0.15);
    --blue: #7aa2e8;
    --purple: #b98ae0;
    --mono: 'SF Mono', ui-monospace, Menlo, Consolas, monospace;
}

:host([data-theme='light']) {
    --bg: #f5f4f2;
    --card: #ffffff;
    --card-hover: #f5f4f2;
    --line: #e7e5e2;
    --line-soft: #efeeea;
    --ink: #1c1917;
    --ink2: #4a4642;
    --ink3: #8a8580;
    --ink4: #b4afa9;
    --accent: #df4436;
    --accent-soft: #fdeeec;
    --accent-hover: #e8563f;
    --green: #1f9d66;
    --green-soft: #e7f5ee;
    --amber: #b87503;
    --amber-soft: #fdf3e3;
    --blue: #4267b2;
    --purple: #7b4baa;
}

.widget {
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--card);
    border: 1px solid var(--line-soft);
    border-radius: 16px;
    overflow: hidden;
    user-select: none;
}

.widget.is-collapsed {
    border-radius: 999px;
}

.lst-view,
.dt-view {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
}

/* ── 通用控件 ── */
.icon-btn {
    width: 26px;
    height: 26px;
    border: 0;
    border-radius: 7px;
    background: rgba(128, 128, 128, 0.1);
    color: var(--ink3);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex: none;
    -webkit-app-region: no-drag;
    transition: background 0.15s, color 0.15s;
    font-family: inherit;
}

.icon-btn:hover {
    background: rgba(128, 128, 128, 0.2);
    color: var(--ink2);
}

.icon-btn.ghost {
    background: transparent;
}

.icon-btn.ghost:hover {
    background: var(--card-hover);
}

.dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex: none;
}

.dot.wait {
    background: var(--amber);
}

.dot.act {
    background: var(--amber);
    animation: w-pulse-act 1.6s ease-in-out infinite;
}

/* 进行中任务的转圈图标（与主窗口侧边栏 sb-running-spinner 同款，缩小至与标题等高）。 */
.spin {
    width: 12px;
    height: 12px;
    flex: none;
    border: 1.5px solid var(--accent-soft);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: w-spin 0.9s linear infinite;
}

/* 已完成任务的绿色带圈对号（线性风格，与侧边栏左下角图标一致）。 */
.done-check {
    width: 13px;
    height: 13px;
    flex: none;
    color: var(--green);
    display: flex;
    align-items: center;
    justify-content: center;
}

.done-check svg {
    width: 100%;
    height: 100%;
}

@keyframes w-spin {
    to {
        transform: rotate(360deg);
    }
}

@keyframes w-pulse-act {
    0%,
    100% {
        box-shadow: 0 0 0 0 rgba(226, 162, 59, 0.4);
    }
    50% {
        box-shadow: 0 0 0 4px rgba(226, 162, 59, 0);
    }
}

.tm {
    font-family: var(--mono);
    font-size: 10.5px;
    color: var(--ink4);
    white-space: nowrap;
}

.num {
    font-variant-numeric: tabular-nums;
}

.tag {
    font-size: 10px;
    padding: 1px 7px;
    border-radius: 5px;
    font-weight: 500;
    white-space: nowrap;
    display: inline-flex;
    align-items: center;
    gap: 4px;
}

.t-amber {
    background: var(--amber-soft);
    color: var(--amber);
}

.t-gray {
    background: var(--card-hover);
    color: var(--ink3);
}

.pgb {
    width: 100%;
    height: 5px;
    border-radius: 999px;
    background: var(--line);
    overflow: hidden;
}

.pgb-fill {
    height: 100%;
    border-radius: 999px;
    background: var(--accent);
    transition: width 0.25s ease;
}

.pgb-fill.green {
    background: var(--green);
}

.pgb-fill.amber {
    background: var(--amber);
}

/* ── 列表视图 ── */
.lst-head {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 12px 14px 12px 16px;
    border-bottom: 1px solid var(--line-soft);
    flex: none;
    -webkit-app-region: drag;
}

.app-logo {
    width: 30px;
    height: 30px;
    border-radius: 50%;
    flex: none;
    display: block;
    object-fit: cover;
    box-shadow: inset 0 0 0 1px rgba(128, 128, 128, 0.12);
}

.head-tx {
    flex: 1;
    min-width: 0;
}

.head-tx .ht {
    font-size: 12.5px;
    font-weight: 650;
    color: var(--ink);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.head-tx .hs {
    font-size: 11px;
    color: var(--ink3);
    display: flex;
    align-items: center;
    gap: 5px;
    margin-top: 2px;
}

.lst-scroll {
    flex: 1;
    overflow-y: auto;
    padding: 4px 0;
    scrollbar-width: thin;
    scrollbar-color: var(--line) transparent;
}

.lst-scroll::-webkit-scrollbar {
    width: 5px;
}

.lst-scroll::-webkit-scrollbar-thumb {
    background: var(--line);
    border-radius: 999px;
}

.lst-scroll::-webkit-scrollbar-track {
    background: transparent;
}

.lst-item {
    display: flex;
    align-items: flex-start;
    gap: 9px;
    padding: 7px 14px 7px 16px;
    cursor: pointer;
    transition: background 0.15s;
}

.lst-item:hover {
    background: var(--card-hover);
}

.lst-item .tx {
    flex: 1;
    min-width: 0;
}

.lst-item .row1 {
    display: flex;
    align-items: center;
    gap: 6px;
}

.lst-item .rt {
    display: flex;
    align-items: center;
    gap: 7px;
    flex: none;
    margin-left: auto;
}

.tk-title {
    flex: 0 1 auto;
    min-width: 0;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--ink);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.tk-title.tk-title-muted {
    color: var(--ink2);
    font-weight: 500;
}

.chev {
    color: var(--ink4);
    flex: none;
}

.lst-item .row2 {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 5px;
}

.lst-item .row2 .pgb {
    height: 4px;
    flex: 1;
}

.pc {
    font-family: var(--mono);
    font-size: 9.5px;
    color: var(--ink4);
    flex: none;
    min-width: 26px;
    text-align: right;
}

.lst-foot {
    padding: 9px 14px 9px 16px;
    border-top: 1px solid var(--line-soft);
    display: flex;
    justify-content: flex-end;
    align-items: center;
    flex: none;
}

.lst-foot .lnk {
    background: none;
    border: 0;
    color: var(--accent);
    font-size: 11.5px;
    font-family: inherit;
    cursor: pointer;
    padding: 0;
}

.lst-foot .lnk:hover {
    text-decoration: underline;
}

/* ── 收起后的胶囊视图 ── */
.collapsed-view {
    display: flex;
    align-items: center;
    gap: 9px;
    height: 100%;
    padding: 0 16px;
    cursor: pointer;
    -webkit-app-region: drag;
}

.collapsed-summary {
    flex: 1;
    min-width: 0;
    font-size: 12px;
    color: var(--ink2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.widget__empty {
    font-size: 12px;
    color: var(--ink3);
    text-align: center;
    padding: 28px 14px;
}

/* ── 详情视图 ── */
.dt-head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 14px;
    border-bottom: 1px solid var(--line-soft);
    flex: none;
    -webkit-app-region: drag;
}

.dt-head .tx {
    flex: 1;
    min-width: 0;
}

.dt-head .tt {
    font-size: 13px;
    font-weight: 600;
    color: var(--ink);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.dt-head .ts {
    font-size: 11px;
    color: var(--ink3);
    margin-top: 2px;
}

/* 详情页状态指示器适当放大。 */
.dt-head .done-check {
    width: 16px;
    height: 16px;
}

.dt-head .spin {
    width: 14px;
    height: 14px;
}

.dt-body {
    flex: 1;
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 13px;
    overflow: hidden;
}

.dt-stat {
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.dt-stat .row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
}

.dt-stat .lb,
.dt-run .lb {
    font-size: 11.5px;
    color: var(--ink3);
    display: flex;
    align-items: center;
    gap: 6px;
}

.dt-stat .lb svg,
.dt-run .lb svg {
    width: 12px;
    height: 12px;
    color: var(--ink4);
    flex: none;
}

.dt-stat .vl,
.dt-run .vl {
    font-family: var(--mono);
    font-size: 12px;
    font-weight: 600;
    color: var(--ink2);
    white-space: nowrap;
}

.dt-run {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
}

.dt-tok {
    display: flex;
    gap: 8px;
}

.dt-tok .tk {
    flex: 1;
    min-width: 0;
    background: var(--bg);
    border: 1px solid var(--line-soft);
    border-radius: 9px;
    padding: 7px 10px;
}

.dt-tok .tk .k {
    font-size: 10px;
    color: var(--ink4);
    display: flex;
    align-items: center;
    gap: 4px;
    white-space: nowrap;
}

.dt-tok .tk .v {
    font-family: var(--mono);
    font-size: 13px;
    font-weight: 600;
    color: var(--ink);
    margin-top: 3px;
}

.dt-tok .tk .v.v-blue {
    color: var(--blue);
}

.dt-tok .tk .v.v-purple {
    color: var(--purple);
}

.dt-foot {
    padding: 9px 16px 12px;
    border-top: 1px solid var(--line-soft);
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex: none;
}

.back-link {
    background: none;
    border: 0;
    color: var(--ink3);
    font-size: 11.5px;
    font-family: inherit;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 0;
}

.back-link:hover {
    color: var(--accent);
}

.btn-p {
    background: var(--accent);
    color: #fff;
    border: 0;
    border-radius: 8px;
    padding: 6px 14px;
    font-family: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
}

.btn-p:hover {
    background: var(--accent-hover);
}
`;

function formatElapsed(ms) {
    if (!Number.isFinite(ms) || ms < 0) {
        return '—';
    }
    const totalSec = Math.floor(ms / 1000);
    const hours = Math.floor(totalSec / 3600);
    const minutes = Math.floor((totalSec % 3600) / 60);
    const seconds = totalSec % 60;
    const pad = (n) => String(n).padStart(2, '0');
    if (hours > 0) {
        return `${hours}:${pad(minutes)}:${pad(seconds)}`;
    }
    return `${minutes}:${pad(seconds)}`;
}

function elapsedMsOf(task) {
    const started = task?.started_at ? new Date(task.started_at).getTime() : null;
    const finished = task?.finished_at ? new Date(task.finished_at).getTime() : null;
    if (!started || !Number.isFinite(started)) {
        return null;
    }
    const end = task?.task_status === 'completed' && finished && Number.isFinite(finished) ? finished : Date.now();
    return end - started;
}

function formatTokens(n) {
    if (!Number.isFinite(n) || n < 0) {
        return '0';
    }
    if (n >= 1000) {
        const k = n / 1000;
        const text = k >= 100 ? String(Math.round(k)) : k.toFixed(1).replace(/\.0$/, '');
        return `${text}K`;
    }
    return String(Math.round(n));
}

function formatStartTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 依据任务状态与「是否等待用户输入」返回视觉元信息。
 */
function statusMeta(status, waitingForInput) {
    if (waitingForInput) {
        return {
            kind: 'dot',
            cls: 'dot act',
            fill: 'amber',
            right: 'action',
            label: t('renderer.taskStatusWidget.actionRequired')
        };
    }
    if (status === 'running') {
        return {
            kind: 'spin',
            cls: 'spin',
            fill: 'accent',
            right: 'time',
            label: t('renderer.taskStatusWidget.running')
        };
    }
    if (status === 'waiting') {
        return {
            kind: 'dot',
            cls: 'dot wait',
            fill: 'amber',
            right: 'waiting',
            label: t('renderer.taskStatusWidget.waiting')
        };
    }
    return {
        kind: 'check',
        cls: 'done-check',
        fill: 'green',
        right: 'completed',
        label: t('renderer.taskStatusWidget.completed')
    };
}

function percentOf(task) {
    const progress = task?.todo_progress;
    if (progress && Number.isFinite(progress.total) && progress.total > 0) {
        return Math.max(0, Math.min(100, Number(progress.percent) || 0));
    }
    return task?.task_status === 'completed' ? 100 : 0;
}

function extractEffectiveTheme(res) {
    if (!res) return null;
    if (typeof res.effective === 'string') return res.effective;
    if (res.data && typeof res.data.effective === 'string') return res.data.effective;
    return null;
}

function systemTheme() {
    try {
        return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch {
        return 'light';
    }
}

export class TaskStatusWidget extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        this._summary = { count: 0, total: 0, tasks: [], mode: 'pill' };
        this._unsubscribeSummary = null;
        this._unsubscribeTheme = null;
        this._unsubscribeTodo = null;
        this._tickTimer = null;
        this._theme = systemTheme();
        this._view = 'list';
        this._selectedTaskId = null;
        this._mode = 'pill';
        this._collapsed = true;
        this._elapsedEls = [];
        this._buildDOM();
    }

    connectedCallback() {
        this._bindTheme();
        this._bindData();
        this._bindTodoUpdates();
        this._startTicker();
        window.addEventListener('focus', this._onWindowFocus);
        window.addEventListener('blur', this._onWindowBlur);
    }

    disconnectedCallback() {
        if (this._unsubscribeSummary) {
            this._unsubscribeSummary();
            this._unsubscribeSummary = null;
        }
        if (this._unsubscribeTheme) {
            this._unsubscribeTheme();
            this._unsubscribeTheme = null;
        }
        if (this._unsubscribeTodo) {
            this._unsubscribeTodo();
            this._unsubscribeTodo = null;
        }
        this._stopTicker();
        window.removeEventListener('focus', this._onWindowFocus);
        window.removeEventListener('blur', this._onWindowBlur);
    }

    _bindTheme() {
        const apply = (effective) => {
            this._theme = effective === 'dark' ? 'dark' : 'light';
            this.setAttribute('data-theme', this._theme);
            this._updateLogo();
        };

        window.themeAPI
            ?.getResolvedTheme?.()
            .then((res) => apply(extractEffectiveTheme(res) ?? systemTheme()))
            .catch(() => apply(systemTheme()));

        this._unsubscribeTheme =
            window.themeAPI?.onThemeChanged?.((res) => apply(extractEffectiveTheme(res) ?? systemTheme())) ?? null;
    }

    _bindData() {
        const api = window.taskStatusWidgetAPI;
        if (!api) {
            return;
        }
        this._unsubscribeSummary = api.onSummaryUpdate((summary) => {
            this._applySummary(summary);
        });
        api.getSummary()
            .then((summary) => this._applySummary(summary))
            .catch(() => this._applySummary(null));
    }

    _bindTodoUpdates() {
        if (this._unsubscribeTodo) {
            return;
        }
        if (!window.applicationRegistryAPI?.subscribeEvent) {
            return;
        }
        window.applicationRegistryAPI
            .subscribeEvent('todomgr', 'taskTodosUpdated', () => {
                window.taskStatusWidgetAPI
                    ?.getSummary()
                    .then((summary) => this._applySummary(summary))
                    .catch(() => {});
            })
            .then((unsubscribe) => {
                if (typeof unsubscribe === 'function') {
                    this._unsubscribeTodo = unsubscribe;
                }
            })
            .catch(() => {});
    }

    _applySummary(summary) {
        this._summary = summary || { count: 0, total: 0, tasks: [], mode: 'pill' };
        const mode = this._summary.mode ?? 'pill';
        if (mode !== this._mode) {
            this._mode = mode;
            // 模式变化时重置形态：pill 默认胶囊，card 默认完整卡片。
            this._collapsed = mode === 'pill';
            window.taskStatusWidgetAPI?.setCollapsed(this._collapsed);
        }
        this._render();
    }

    _startTicker() {
        this._stopTicker();
        this._tickTimer = window.setInterval(() => this._updateElapsed(), 1000);
    }

    _stopTicker() {
        if (this._tickTimer !== null) {
            window.clearInterval(this._tickTimer);
            this._tickTimer = null;
        }
    }

    _buildDOM() {
        const style = document.createElement('style');
        style.textContent = WIDGET_CSS;

        this._container = document.createElement('div');
        this._container.className = 'widget';

        this._listView = this._buildListView();
        this._detailView = this._buildDetailView();
        this._collapsedView = this._buildCollapsedView();

        this._container.appendChild(this._listView);
        this._container.appendChild(this._detailView);
        this._container.appendChild(this._collapsedView);

        this.shadowRoot.appendChild(style);
        this.shadowRoot.appendChild(this._container);

        this._updateLogo();
        this._render();
    }

    _buildCollapsedView() {
        const view = document.createElement('div');
        view.className = 'collapsed-view';
        // 胶囊是 drag region（可拖动），drag 会吞掉 click；用 mousedown 展开，
        // 保证在窗口已持有焦点时（例如 card 模式手动收起后）点击也能展开。
        view.addEventListener('mousedown', () => {
            this._expand();
        });
        return view;
    }

    _buildListView() {
        const view = document.createElement('div');
        view.className = 'lst-view';

        // 头部
        const head = document.createElement('div');
        head.className = 'lst-head';

        this._logo = document.createElement('img');
        this._logo.className = 'app-logo';
        this._logo.alt = 'OpenDesk';
        this._logo.draggable = false;

        const headTx = document.createElement('div');
        headTx.className = 'head-tx';

        const title = document.createElement('div');
        title.className = 'ht';
        title.textContent = t('renderer.taskStatusWidget.title');

        const subtitle = document.createElement('div');
        subtitle.className = 'hs';
        this._subtitleText = document.createElement('span');
        subtitle.appendChild(this._subtitleText);

        headTx.appendChild(title);
        headTx.appendChild(subtitle);

        const collapseBtn = document.createElement('button');
        collapseBtn.className = 'icon-btn';
        collapseBtn.title = t('renderer.taskStatusWidget.collapse');
        collapseBtn.setAttribute('aria-label', t('renderer.taskStatusWidget.collapse'));
        collapseBtn.innerHTML = CLOSE_SVG;
        collapseBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._collapse();
        });

        head.appendChild(this._logo);
        head.appendChild(headTx);
        head.appendChild(collapseBtn);

        this._list = document.createElement('div');
        this._list.className = 'lst-scroll';

        const foot = document.createElement('div');
        foot.className = 'lst-foot';

        const viewAll = document.createElement('button');
        viewAll.className = 'lnk';
        viewAll.textContent = `${t('renderer.taskStatusWidget.viewAll')} →`;
        viewAll.addEventListener('click', (e) => {
            e.stopPropagation();
            window.taskStatusWidgetAPI?.restoreMainWindow();
        });

        foot.appendChild(viewAll);

        view.appendChild(head);
        view.appendChild(this._list);
        view.appendChild(foot);
        return view;
    }

    _buildDetailView() {
        const view = document.createElement('div');
        view.className = 'dt-view';

        // 头部（返回 + 标题 + 状态点）
        this._detailHead = document.createElement('div');
        this._detailHead.className = 'dt-head';

        const backBtn = document.createElement('button');
        backBtn.className = 'icon-btn ghost';
        backBtn.title = t('renderer.taskStatusWidget.backToList');
        backBtn.setAttribute('aria-label', t('renderer.taskStatusWidget.backToList'));
        backBtn.innerHTML = BACK_SVG;
        backBtn.addEventListener('click', () => this._showList());

        this._detailHeadTx = document.createElement('div');
        this._detailHeadTx.className = 'tx';

        this._detailDot = document.createElement('span');
        this._detailDot.className = '';

        this._detailHead.appendChild(backBtn);
        this._detailHead.appendChild(this._detailHeadTx);
        this._detailHead.appendChild(this._detailDot);

        // 内容
        this._detailBody = document.createElement('div');
        this._detailBody.className = 'dt-body';

        // 页脚
        const foot = document.createElement('div');
        foot.className = 'dt-foot';

        const backLink = document.createElement('button');
        backLink.className = 'back-link';
        backLink.insertAdjacentHTML('beforeend', BACK_SVG);
        backLink.appendChild(document.createTextNode(t('renderer.taskStatusWidget.backToList')));
        backLink.addEventListener('click', () => this._showList());

        const openBtn = document.createElement('button');
        openBtn.className = 'btn-p';
        openBtn.textContent = t('renderer.taskStatusWidget.openSession');
        openBtn.addEventListener('click', () => {
            if (this._selectedTaskId) {
                window.taskStatusWidgetAPI?.openTask(this._selectedTaskId);
            }
        });

        foot.appendChild(backLink);
        foot.appendChild(openBtn);

        view.appendChild(this._detailHead);
        view.appendChild(this._detailBody);
        view.appendChild(foot);
        return view;
    }

    _showList() {
        const changed = this._view !== 'list';
        this._view = 'list';
        this._selectedTaskId = null;
        this._render();
        if (changed) {
            this._animateViewIn('list');
        }
    }

    _showDetail(taskId) {
        const changed = this._view !== 'detail' || this._selectedTaskId !== taskId;
        this._view = 'detail';
        this._selectedTaskId = taskId;
        this._render();
        if (changed) {
            this._animateViewIn('detail');
        }
    }

    _onWindowFocus = () => {
        if (this._collapsed) {
            this._expand();
        }
    };

    _onWindowBlur = () => {
        // 仅「单行胶囊」模式在失焦时自动收回；「完整卡片」模式保持展开，除非手动收起。
        if (this._mode === 'pill' && !this._collapsed) {
            this._collapse();
        }
    };

    _collapse() {
        if (this._collapsed) {
            return;
        }
        this._collapsed = true;
        window.taskStatusWidgetAPI?.setCollapsed(true);
        this._render();
        this._animateCollapsedIn();
    }

    _expand() {
        if (!this._collapsed) {
            return;
        }
        this._collapsed = false;
        window.taskStatusWidgetAPI?.setCollapsed(false);
        this._view = 'list';
        this._selectedTaskId = null;
        this._render();
        this._animateViewIn('list');
    }

    _animateCollapsedIn() {
        const el = this._collapsedView;
        if (!el || typeof el.animate !== 'function') {
            return;
        }
        el.animate(
            [
                { opacity: 0, transform: 'translateY(8px)' },
                { opacity: 1, transform: 'translateY(0)' }
            ],
            { duration: 200, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
        );
    }

    _animateViewIn(view) {
        const el = view === 'list' ? this._listView : this._detailView;
        if (!el || typeof el.animate !== 'function') {
            return;
        }
        const fromX = view === 'list' ? -16 : 16;
        el.animate(
            [
                { opacity: 0, transform: `translateX(${fromX}px)` },
                { opacity: 1, transform: 'translateX(0)' }
            ],
            { duration: 220, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
        );
    }

    _updateLogo() {
        if (!this._logo) return;
        this._logo.src = this._theme === 'dark' ? './images/icon_round_dark.png' : './images/icon_round.png';
    }

    _render() {
        if (!this._list) return;
        this._elapsedEls = [];

        this._container.classList.toggle('is-collapsed', this._collapsed);

        if (this._collapsed) {
            this._listView.style.display = 'none';
            this._detailView.style.display = 'none';
            this._collapsedView.style.display = 'flex';
            this._renderCollapsed();
            return;
        }

        this._collapsedView.style.display = 'none';
        const showList = this._view !== 'detail';
        this._listView.style.display = showList ? 'flex' : 'none';
        this._detailView.style.display = showList ? 'none' : 'flex';

        if (showList) {
            this._renderList();
        } else {
            this._renderDetail();
        }
    }

    _renderCollapsed() {
        const tasks = this._summary.tasks || [];
        const running = tasks.filter((task) => task.task_status === 'running' || task.task_status === 'waiting').length;
        const completed = tasks.filter((task) => task.task_status === 'completed').length;

        this._collapsedView.textContent = '';

        const indicator = document.createElement('span');
        if (running > 0) {
            indicator.className = 'spin';
        } else {
            indicator.className = 'done-check';
            indicator.innerHTML = DONE_CHECK_SVG;
        }

        const summary = document.createElement('span');
        summary.className = 'collapsed-summary';
        const parts = [];
        if (running > 0) {
            parts.push(t('renderer.taskStatusWidget.collapsedRunning', { count: running }));
        }
        if (completed > 0) {
            parts.push(t('renderer.taskStatusWidget.collapsedCompleted', { count: completed }));
        }
        summary.textContent = parts.join(' · ');

        this._collapsedView.appendChild(indicator);
        this._collapsedView.appendChild(summary);
    }

    _renderList() {
        const tasks = this._summary.tasks || [];
        this._list.textContent = '';

        const activeCount = tasks.filter(
            (task) => task.task_status === 'running' || task.task_status === 'waiting'
        ).length;
        this._subtitleText.textContent = t('renderer.taskStatusWidget.activeCount', { count: activeCount });

        if (tasks.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'widget__empty';
            empty.textContent = t('renderer.taskStatusWidget.empty');
            this._list.appendChild(empty);
            return;
        }

        for (const task of tasks) {
            this._list.appendChild(this._buildTaskItem(task));
        }
    }

    _buildTaskItem(task) {
        const meta = statusMeta(task.task_status, task.waiting_for_input);
        const percent = percentOf(task);

        const item = document.createElement('div');
        item.className = 'lst-item';

        const tx = document.createElement('div');
        tx.className = 'tx';

        const row1 = document.createElement('div');
        row1.className = 'row1';

        const title = document.createElement('span');
        title.className = 'tk-title';
        if (meta.right === 'completed') {
            title.classList.add('tk-title-muted');
        }
        title.textContent = task.task_name || task.task_id || '';

        const rt = document.createElement('div');
        rt.className = 'rt';

        let elapsedEl = null;
        if (meta.right === 'time') {
            const elapsed = document.createElement('span');
            elapsed.className = 'tm num';
            elapsed.textContent = formatElapsed(elapsedMsOf(task));
            rt.appendChild(elapsed);
            elapsedEl = elapsed;
        } else {
            const tag = document.createElement('span');
            tag.className = `tag ${meta.right === 'completed' ? 't-gray' : 't-amber'}`;
            tag.textContent = meta.label;
            rt.appendChild(tag);
        }
        rt.insertAdjacentHTML('beforeend', CHEVRON_SVG);

        row1.appendChild(title);
        row1.appendChild(this._buildIndicator(meta));
        row1.appendChild(rt);

        const row2 = document.createElement('div');
        row2.className = 'row2';

        const pgb = document.createElement('div');
        pgb.className = 'pgb';
        const fill = document.createElement('div');
        fill.className = `pgb-fill ${meta.fill}`;
        fill.style.width = `${percent}%`;
        pgb.appendChild(fill);

        const pc = document.createElement('span');
        pc.className = 'pc num';
        pc.textContent = `${percent}%`;

        row2.appendChild(pgb);
        row2.appendChild(pc);

        tx.appendChild(row1);
        tx.appendChild(row2);

        item.appendChild(tx);

        item.addEventListener('click', (e) => {
            e.stopPropagation();
            if (task.task_id) {
                this._showDetail(task.task_id);
            }
        });

        if (elapsedEl && task.task_id) {
            this._elapsedEls.push({ elapsed: elapsedEl, task });
        }

        return item;
    }

    _buildIndicator(meta) {
        const el = document.createElement('span');
        this._applyIndicator(el, meta);
        return el;
    }

    _applyIndicator(el, meta) {
        el.className = meta.cls;
        el.textContent = '';
        if (meta.kind === 'check') {
            el.innerHTML = DONE_CHECK_SVG;
        }
    }

    _renderDetail() {
        const task = this._summary.tasks.find((item) => item.task_id === this._selectedTaskId);
        if (!task) {
            this._showList();
            return;
        }

        const meta = statusMeta(task.task_status, task.waiting_for_input);
        const elapsedMs = elapsedMsOf(task);
        const startTime = formatStartTime(task.started_at);

        // 头部
        this._detailHeadTx.textContent = '';
        const tt = document.createElement('div');
        tt.className = 'tt';
        tt.textContent = task.task_name || task.task_id || '';
        const ts = document.createElement('div');
        ts.className = 'ts';
        ts.textContent = `${meta.label} · ${formatElapsed(elapsedMs)}`;
        this._detailHeadTx.appendChild(tt);
        this._detailHeadTx.appendChild(ts);
        this._applyIndicator(this._detailDot, meta);

        // 内容
        this._detailBody.textContent = '';

        // 待办事项（没有待办时不展示整条进度）
        const todo = task.todo_progress || { completed: 0, total: 0, percent: 0 };
        if (todo.total > 0) {
            this._detailBody.appendChild(
                this._buildDetailStat(
                    TODO_SVG,
                    t('renderer.taskStatusWidget.todo'),
                    t('renderer.taskStatusWidget.todoDone', { completed: todo.completed, total: todo.total }),
                    todo.percent,
                    ''
                )
            );
        }

        // 子任务（没有子任务时不展示整条进度）
        const subtask = task.subtask_progress || { completed: 0, total: 0, percent: 0 };
        if (subtask.total > 0) {
            this._detailBody.appendChild(
                this._buildDetailStat(
                    SUBTASK_SVG,
                    t('renderer.taskStatusWidget.subtask'),
                    t('renderer.taskStatusWidget.subtaskStat', { total: subtask.total, completed: subtask.completed }),
                    subtask.percent,
                    'green'
                )
            );
        }

        // 已运行时间
        const run = document.createElement('div');
        run.className = 'dt-run';
        const runLb = document.createElement('span');
        runLb.className = 'lb';
        runLb.insertAdjacentHTML('beforeend', CLOCK_SVG);
        runLb.appendChild(document.createTextNode(t('renderer.taskStatusWidget.elapsed')));
        const runVl = document.createElement('span');
        runVl.className = 'vl num';
        const runElapsed = document.createElement('span');
        runElapsed.textContent = formatElapsed(elapsedMs);
        runVl.appendChild(runElapsed);
        if (startTime) {
            runVl.appendChild(
                document.createTextNode(` · ${t('renderer.taskStatusWidget.startedAt', { time: startTime })}`)
            );
        }
        run.appendChild(runLb);
        run.appendChild(runVl);
        this._detailBody.appendChild(run);

        // Tokens
        this._detailBody.appendChild(this._buildDetailTokens(task));

        this._elapsedEls.push({ elapsed: runElapsed, task });
    }

    _buildDetailStat(svg, label, value, percent, fillClass) {
        const stat = document.createElement('div');
        stat.className = 'dt-stat';

        const row = document.createElement('div');
        row.className = 'row';

        const lb = document.createElement('span');
        lb.className = 'lb';
        lb.insertAdjacentHTML('beforeend', svg);
        lb.appendChild(document.createTextNode(label));

        const vl = document.createElement('span');
        vl.className = 'vl num';
        vl.textContent = value;

        row.appendChild(lb);
        row.appendChild(vl);

        const pgb = document.createElement('div');
        pgb.className = 'pgb';
        const fill = document.createElement('div');
        fill.className = `pgb-fill ${fillClass}`.trim();
        fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
        pgb.appendChild(fill);

        stat.appendChild(row);
        stat.appendChild(pgb);
        return stat;
    }

    _buildDetailTokens(task) {
        const usage = task.usage || { total_tokens: 0, input_tokens: 0, output_tokens: 0 };

        const wrap = document.createElement('div');
        wrap.className = 'dt-tok';

        wrap.appendChild(this._buildTokenCard(t('renderer.taskStatusWidget.totalTokens'), usage.total_tokens, ''));
        wrap.appendChild(
            this._buildTokenCard(t('renderer.taskStatusWidget.inputTokens'), usage.input_tokens, 'v-blue', UP_SVG)
        );
        wrap.appendChild(
            this._buildTokenCard(t('renderer.taskStatusWidget.outputTokens'), usage.output_tokens, 'v-purple', DOWN_SVG)
        );
        return wrap;
    }

    _buildTokenCard(label, value, valueClass, iconSvg) {
        const tk = document.createElement('div');
        tk.className = 'tk';

        const k = document.createElement('div');
        k.className = 'k';
        if (iconSvg) {
            k.insertAdjacentHTML('beforeend', iconSvg);
        }
        k.appendChild(document.createTextNode(label));

        const v = document.createElement('div');
        v.className = `v num ${valueClass}`.trim();
        v.textContent = formatTokens(value);

        tk.appendChild(k);
        tk.appendChild(v);
        return tk;
    }

    _updateElapsed() {
        for (const { elapsed, task } of this._elapsedEls) {
            if (task.task_status === 'completed') continue;
            elapsed.textContent = formatElapsed(elapsedMsOf(task));
        }
    }
}

if (!customElements.get('task-status-widget')) {
    customElements.define('task-status-widget', TaskStatusWidget);
}
