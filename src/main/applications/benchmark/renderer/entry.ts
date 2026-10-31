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

import { AgentOperableHTMLElement } from '../../widget_utils.js';
import { escapeHtml } from '../../../../common/utils/escape.js';
import { OPENDESK_THEME_CHANGED } from '../../../../renderer/theme/theme-iframe-bridge.ts';
import { createRendererTranslator, resolveRendererLocale } from '../../../../renderer/locale.js';
import { bindOverlayDismiss, showConfirmModal } from '../../../../renderer/components/confirmModal';
import { createTranslatorForBenchmark } from '../locale/renderer.js';
import { labelForStoredReasoningEffort, REASONING_EFFORT_UI_OPTIONS } from '../../../../common/reasoning-effort.ts';
import type {
    CaseRunState,
    CatalogDatasetEntry,
    DatasetSummary,
    DownloadState,
    ModelOption,
    RunListItem,
    RunRecord
} from '../common.js';
import { findLocalDatasetByName, resolveCatalogInstallState } from '../catalog-common.js';
import css from './style.css?inline';
// 复用 agentinput 的模型面板样式（同一套 ctx-menu / ctx-item 视觉与暗色处理）
import ctxCss from '../../../../renderer/styles/context-menu.css?inline';

// ctxCss 在前：让本应用自己的 .model-panel / .effort-submenu 层级与尺寸覆盖 ctx-menu 默认值
const SHADOW_CSS = `${ctxCss}\n${css}`;

type Translator = ReturnType<typeof createTranslatorForBenchmark>;
type TabId = 'catalog' | 'datasets' | 'history';
type DetailTab = 'overview' | 'cases';

interface RunModalState {
    datasetId: string;
    datasetName: string;
    caseCount: number;
    concurrency: number;
    runModel: string;
    runModelEffort: string;
    verifyModel: string;
    verifyModelEffort: string;
    runTimeout: string;
    verifyTimeout: string;
    tracks: Array<{ id: string; name: string; caseCount: number }>;
    selectedTracks: string[];
    busy: boolean;
    error: string;
}

interface BannerState {
    text: string;
    isError: boolean;
}

const RUN_STATUS_KEYS: Record<string, string> = {
    running: 'benchmark.status.running',
    completed: 'benchmark.status.completed',
    stopped: 'benchmark.status.stopped',
    failed: 'benchmark.status.failed'
};

const CASE_STATUS_KEYS: Record<string, string> = {
    pending: 'benchmark.caseStatus.pending',
    preparing: 'benchmark.caseStatus.preparing',
    running: 'benchmark.caseStatus.running',
    verifying: 'benchmark.caseStatus.verifying',
    done: 'benchmark.caseStatus.done',
    failed: 'benchmark.caseStatus.failed',
    stopped: 'benchmark.caseStatus.stopped'
};

const PASTEL_COLORS = [
    { bg: '#EBF3FE', text: '#5B8DEF' },
    { bg: '#FEF1E6', text: '#E8935A' },
    { bg: '#E7F6EA', text: '#4CAF6E' },
    { bg: '#F2E8FD', text: '#9B6DD7' },
    { bg: '#FDE9E9', text: '#E06060' },
    { bg: '#E5F7F4', text: '#3DB49E' }
];

function formatTime(timestamp: number | null): string {
    if (!timestamp) return '-';
    const date = new Date(timestamp);
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatDuration(ms: number): string {
    if (!ms || ms < 0) return '-';
    const totalSeconds = Math.round(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
}

function percent(value: number): string {
    return `${Math.round((value || 0) * 100)}%`;
}

function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

// 与 agentinput 保持同一套推理强度图标（四格能量条）
const EFFORT_BAR_X = [1.125, 4.875, 8.625, 12.375];
const EFFORT_BAR_GREEN = '#1F9D66';
const EFFORT_BAR_GREY = '#E7E5E2';

function effortBarRects(filledCount: number): string {
    return EFFORT_BAR_X.map(
        (x, index) =>
            `<rect x="${x}" y="2.5" width="2.5" height="11" rx=".5" fill="${index < filledCount ? EFFORT_BAR_GREEN : EFFORT_BAR_GREY}"/>`
    ).join('');
}

const EFFORT_BAR_PATHS: Record<string, string> = {
    '': EFFORT_BAR_X.map(
        (x) => `<rect x="${x}" y="2.5" width="2.5" height="11" rx=".5" fill="${EFFORT_BAR_GREEN}" opacity=".35"/>`
    ).join(''),
    none:
        effortBarRects(0) + '<path d="M1.5 13.5 14.5 2.5" stroke="#8A8580" stroke-width="1.4" stroke-linecap="round"/>',
    low: effortBarRects(1),
    medium: effortBarRects(2),
    high: effortBarRects(3),
    max: effortBarRects(4)
};

function effortIconSvg(effortValue: string): string {
    const paths = EFFORT_BAR_PATHS[effortValue] ?? EFFORT_BAR_PATHS[''];
    return `<svg class="effort-icon" width="16" height="16" viewBox="0 0 16 16" fill="none">${paths}</svg>`;
}

function colorFor(seed: string): { bg: string; text: string } {
    let hash = 0;
    for (let index = 0; index < seed.length; index += 1) {
        hash = (hash * 31 + seed.charCodeAt(index)) % 100000;
    }
    return PASTEL_COLORS[hash % PASTEL_COLORS.length];
}

/* preload 已经把 {status,data} 拆包并在出错时抛异常，这里直接透传，
   不能再按 status 字段嗅探返回值——测评记录本身就有 status 字段 */
function getAPI() {
    const api = (window as any).applicationAPI;
    return {
        call: <T>(method: string, ...args: unknown[]) => api.call(method, ...args) as Promise<T>,
        callMainWorld: <T>(method: string, ...args: unknown[]) => api.callMainWorld(method, ...args) as Promise<T>,
        subscribe: (eventName: string, callback: () => void) => api.subscribe(eventName, callback),
        unsubscribe: (eventName: string) => api.unsubscribe(eventName)
    };
}

class BenchmarkEntryWidget extends AgentOperableHTMLElement {
    private _t: Translator = createTranslatorForBenchmark();
    private _locale: string | undefined = undefined;
    private _settingUnsubscribe: (() => void) | null = null;
    private _onThemeChange: ((event: any) => void) | null = null;
    private _onDataChanged: (() => void) | null = null;
    private _onDownloadsChanged: (() => void) | null = null;
    private _onRunsChanged: (() => void) | null = null;

    private activeTab: TabId = 'catalog';
    private detailTab: DetailTab = 'overview';
    private datasets: DatasetSummary[] = [];
    private catalog: CatalogDatasetEntry[] = [];
    private downloads = new Map<string, DownloadState>();
    private runs: RunListItem[] = [];
    private models: ModelOption[] = [];
    private loading = true;
    /** 进行中的清单请求数：清单走网络，比本地测评集慢，不能和 loading 混在一起 */
    private catalogLoading = 0;
    private importing = false;
    private banner: BannerState | null = null;
    private datasetModalId: string | null = null;
    private catalogModalId: string | null = null;
    private runModal: RunModalState | null = null;
    private detailRunId: string | null = null;
    private detail: RunRecord | null = null;
    private detailLoading = false;
    private detailMissCount = 0;
    private detailSignature: string | null = null;
    private focusedCaseKey: string | null = null;
    private expandedCases = new Set<string>();
    private caseMenu: { key: string; left: number; top: number } | null = null;
    private modelPanel: { picker: 'run' | 'verify'; left: number; top: number } | null = null;
    private effortMenu: { picker: 'run' | 'verify'; alias: string; left: number; top: number } | null = null;
    private skipModalAnimation = false;
    private pollTimer: number | null = null;
    private scrollPositions = new Map<string, number>();

    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        this._onThemeChange = (event: any) => {
            this.applyTheme(event?.detail?.effective);
            this.render();
        };
    }

    async connectedCallback() {
        let setting: any;
        try {
            setting = await (window as any).settingAPI?.loadSettingObject?.();
        } catch {
            setting = undefined;
        }
        this._applyLocaleSetting(setting);
        if (!this.isConnected) return;
        this._subscribeLocaleChanges();
        this.applyTheme();
        this.render();

        document.addEventListener(OPENDESK_THEME_CHANGED, this._onThemeChange as EventListener);
        this.shadowRoot!.addEventListener('click', this.handleClick);
        this.shadowRoot!.addEventListener('mouseover', this.handleHover);
        this.shadowRoot!.addEventListener('input', this.handleInput);
        this.shadowRoot!.addEventListener('contextmenu', this.handleContextMenu);
        document.addEventListener('keydown', this.handleKeydown);

        this._onDataChanged = () => {
            void this.loadDatasets(false);
        };
        this._onDownloadsChanged = () => {
            void this.refreshDownloads();
        };
        this._onRunsChanged = () => {
            void this.loadRuns(false);
            if (this.detailRunId) void this.loadDetail(this.detailRunId, false);
        };
        getAPI().subscribe('datasetsChanged', this._onDataChanged);
        getAPI().subscribe('downloadsChanged', this._onDownloadsChanged);
        getAPI().subscribe('runsChanged', this._onRunsChanged);

        await Promise.all([this.loadCatalog(), this.loadDatasets(true), this.loadRuns(true), this.loadModels()]);
        this.loading = false;
        this.render();
    }

    disconnectedCallback() {
        if (this._onDataChanged) {
            getAPI().unsubscribe('datasetsChanged');
            this._onDataChanged = null;
        }
        if (this._onDownloadsChanged) {
            getAPI().unsubscribe('downloadsChanged');
            this._onDownloadsChanged = null;
        }
        if (this._onRunsChanged) {
            getAPI().unsubscribe('runsChanged');
            this._onRunsChanged = null;
        }
        if (this._settingUnsubscribe) {
            this._settingUnsubscribe();
            this._settingUnsubscribe = null;
        }
        document.removeEventListener(OPENDESK_THEME_CHANGED, this._onThemeChange as EventListener);
        this.shadowRoot?.removeEventListener('click', this.handleClick);
        this.shadowRoot?.removeEventListener('mouseover', this.handleHover);
        this.shadowRoot?.removeEventListener('input', this.handleInput);
        this.shadowRoot?.removeEventListener('contextmenu', this.handleContextMenu);
        document.removeEventListener('keydown', this.handleKeydown);
        this.clearPoll();
    }

    private _settingForLocale: any = undefined;

    private _applyLocaleSetting(setting?: { locale?: string; resolved_locale?: string }) {
        this._locale = resolveRendererLocale(setting);
        this._settingForLocale = setting;
        this._t = createTranslatorForBenchmark(setting);
    }

    private _subscribeLocaleChanges() {
        if (this._settingUnsubscribe) return;
        const unsubscribe = (window as any).settingAPI?.onSettingChanged?.((setting: any) => {
            if (!this.isConnected) return;
            if (resolveRendererLocale(setting) === this._locale) return;
            this._applyLocaleSetting(setting);
            this.render();
        });
        if (typeof unsubscribe === 'function') {
            this._settingUnsubscribe = unsubscribe;
        }
    }

    private applyTheme(effective?: string) {
        const theme =
            effective === 'dark' || effective === 'light'
                ? effective
                : this.dataset.theme || document.documentElement.dataset.theme || 'light';
        this.dataset.theme = theme;
    }

    // ── 数据加载 ──────────────────────────────────────────────────────────

    private async loadCatalog(forceRefresh = false) {
        // 清单要联网，弱网下先转圈，别先闪一屏「暂无可下载的测评集」
        const showLoading = this.catalog.length === 0;
        if (showLoading) {
            this.catalogLoading += 1;
            this.renderUnlessModalOpen();
        }
        try {
            this.catalog = await getAPI().callMainWorld<CatalogDatasetEntry[]>('listCatalogDatasets', forceRefresh);
            this.downloads = await this.fetchDownloads();
        } catch (error: any) {
            this.banner = { text: error?.message || this._t('error.operationFailed'), isError: true };
        } finally {
            if (showLoading) this.catalogLoading -= 1;
        }
    }

    private async fetchDownloads(): Promise<Map<string, DownloadState>> {
        const states = await getAPI().callMainWorld<DownloadState[]>('listDownloads');
        return new Map(states.map((state) => [state.catalogId, state]));
    }

    /**
     * 下载进度变化：弹窗打开时只刷进度条，落地态（完成/失败）才整窗重建，
     * 避免下载过程中反复重建把弹窗闪掉。
     */
    private async refreshDownloads() {
        try {
            this.downloads = await this.fetchDownloads();
        } catch {
            return;
        }
        if (this.catalogModalId) {
            const state = this.downloads.get(this.catalogModalId);
            // 下载中只刷进度条；进入安装/落地态要重建一次，按钮和提示才会跟着变
            if (state && state.status === 'downloading') {
                this.patchDownloadProgress();
                return;
            }
            // 装完了要重新读一次本地测评集，否则弹窗还按旧的安装状态显示「下载」
            if (state?.status === 'done') await this.loadDatasets(false);
            // 同一个弹窗只是换了状态，别把入场动画再播一遍
            this.skipModalAnimation = true;
            this.render();
            return;
        }
        if (this.activeTab === 'catalog' && !this.datasetModalId && !this.runModal && !this.detailRunId) {
            // 卡片上只有状态标签随进度变化，定点更新即可，别整窗重建打断 hover
            this.patchCatalogStatusPills();
        }
    }

    private async loadDatasets(showLoading: boolean) {
        if (showLoading) {
            this.loading = true;
            this.render();
        }
        try {
            this.datasets = await getAPI().callMainWorld<DatasetSummary[]>('listDatasets');
            this.banner = null;
        } catch (error: any) {
            this.banner = { text: error?.message || this._t('error.operationFailed'), isError: true };
        }
        this.renderUnlessModalOpen();
    }

    private async loadRuns(showLoading: boolean) {
        if (showLoading && this.runs.length === 0) {
            this.loading = true;
            this.render();
        }
        try {
            this.runs = await getAPI().callMainWorld<RunListItem[]>('listRuns');
        } catch (error: any) {
            this.banner = { text: error?.message || this._t('error.operationFailed'), isError: true };
        }
        this.renderUnlessModalOpen();
    }

    private async loadModels() {
        try {
            this.models = await getAPI().callMainWorld<ModelOption[]>('listModels');
        } catch {
            this.models = [];
        }
    }

    private async loadDetail(runId: string, showLoading: boolean) {
        if (showLoading) {
            this.detailLoading = true;
            this.render();
        }
        try {
            const detail = await getAPI().callMainWorld<RunRecord | null>('getRunDetail', runId);
            if (this.detailRunId !== runId) return;
            this.detail = detail;
            // 运行刚创建时可能短暂读不到记录：继续重试而不是停在空态
            this.detailMissCount = detail ? 0 : this.detailMissCount + 1;
        } catch (error: any) {
            if (this.detailRunId === runId) {
                this.detail = null;
                this.banner = { text: error?.message || this._t('error.operationFailed'), isError: true };
            }
        }
        this.detailLoading = false;
        if (showLoading || !this.applyDetailUpdate()) this.render();
        this.schedulePoll();
    }

    /** 详情页轮询时只更新变化的部分；结构不匹配才回退整窗渲染 */
    private applyDetailUpdate(): boolean {
        const run = this.detail;
        if (!run || !this.detailRunId || this.runModal || this.datasetModalId) return false;
        const signature = this.computeDetailSignature(run);
        if (signature === this.detailSignature) {
            // 数据没变：连 DOM 都不碰（正在运行的用例只刷新耗时文本）
            this.patchDurations(run);
            return true;
        }
        if (!this.patchDetailNodes(run)) return false;
        this.detailSignature = signature;
        this.patchDurations(run);
        return true;
    }

    private computeDetailSignature(run: RunRecord): string {
        const summary = run.summary;
        return JSON.stringify({
            status: run.status,
            stopping: run.stopRequested === true,
            tab: this.detailTab,
            total: summary.total,
            completed: summary.completed,
            failed: summary.failed,
            stopped: summary.stopped,
            running: summary.running,
            duration: Math.round(summary.avgDurationMs / 1000),
            cases: run.cases.map(
                (item) => `${item.key}:${item.status}:${item.ratio ?? ''}:${item.score ?? ''}:${item.error}`
            )
        });
    }

    private patchDetailNodes(run: RunRecord): boolean {
        const root = this.shadowRoot;
        if (!root) return false;
        const statusPill = root.querySelector('.detail-head .status-pill') as HTMLElement | null;
        const meta = root.querySelector('.detail-meta') as HTMLElement | null;
        if (!statusPill || !meta) return false;

        const statusKey = RUN_STATUS_KEYS[run.status] || 'benchmark.status.stopped';
        statusPill.className = `status-pill ${run.status}`;
        statusPill.innerHTML = `<span class="dot"></span>${escapeHtml(this._t(statusKey))}`;
        this.patchStopButton(run);

        const finished = run.summary.completed + run.summary.failed + run.summary.stopped;
        meta.textContent = [
            this._t('benchmark.detail.models', { test: run.runModel, verify: run.verifyModel }),
            this._t('benchmark.detail.concurrency', { count: run.concurrency }),
            this._t('benchmark.detail.startedAt', { time: formatTime(run.startedAt ?? run.createdAt) }),
            `${finished}/${run.summary.total}`
        ].join(' · ');

        const summary = run.summary;
        const kpis: Record<string, [string, string]> = {
            score: [summary.totalScore.toFixed(2), summary.maxScore.toFixed(2)],
            avg: [percent(summary.avgRatio), ''],
            completed: [String(summary.completed), String(summary.total)],
            failed: [String(summary.failed + summary.stopped), ''],
            duration: [formatDuration(summary.avgDurationMs), '']
        };
        for (const [key, [value, suffix]] of Object.entries(kpis)) {
            const kpi = root.querySelector(`[data-kpi="${key}"]`) as HTMLElement | null;
            const valueEl = kpi?.querySelector('.kpi-value') as HTMLElement | null;
            if (valueEl) valueEl.outerHTML = this.kpiValueHtml(value, suffix);
        }

        if (this.detailTab === 'cases') {
            this.patchRunningPill(run);
            const rows = new Map<string, HTMLElement>();
            root.querySelectorAll<HTMLElement>('tr[data-case-key]').forEach((row) => {
                if (row.dataset.caseKey) rows.set(row.dataset.caseKey, row);
            });
            if (rows.size !== run.cases.length) return false;
            for (const item of run.cases) {
                const row = rows.get(item.key);
                if (!row) return false;
                this.patchCaseRow(row, item);
            }
            this.markFocusedRow(true);
            return true;
        }

        const matrix = root.querySelector('.matrix');
        if (!matrix) return false;
        const tiles = new Map<string, HTMLElement>();
        root.querySelectorAll<HTMLElement>('.tile').forEach((tile) => {
            if (tile.dataset.tileKey) tiles.set(tile.dataset.tileKey, tile);
        });
        if (tiles.size !== run.cases.length) return false;
        for (const item of run.cases) {
            const tile = tiles.get(item.key);
            if (!tile) return false;
            const view = this.tileView(item);
            const className = `tile ${view.variant}`;
            if (tile.className !== className) tile.className = className;
            if (tile.innerHTML !== view.html) tile.innerHTML = view.html;
            if (tile.title !== view.title) tile.title = view.title;
        }

        const groups = new Map<string, CaseRunState[]>();
        for (const item of run.cases) {
            const list = groups.get(item.trackId) ?? [];
            list.push(item);
            groups.set(item.trackId, list);
        }
        root.querySelectorAll<HTMLElement>('[data-track-meta]').forEach((el) => {
            const items = groups.get(el.dataset.trackMeta || '');
            if (!items) return;
            const done = items.filter((item) => item.status === 'done');
            const ratios = done.map((item) => item.ratio).filter((value): value is number => value !== null);
            const avg = ratios.length > 0 ? ratios.reduce((sum, value) => sum + value, 0) / ratios.length : 0;
            el.textContent = `${done.length}/${items.length} · ${percent(avg)}`;
        });

        const dist = root.querySelector('[data-dist]') as HTMLElement | null;
        if (dist) dist.innerHTML = this.renderDistribution(run.cases);
        return true;
    }

    /* 轮询只做局部刷新，所以「停止」「N 个用例正在执行」这类随状态变化的控件必须一起修 */
    private patchStopButton(run: RunRecord) {
        const actions = this.shadowRoot?.querySelector('.detail-actions');
        if (!actions) return;
        const existing = actions.querySelector('[data-action="stop-run"]') as HTMLButtonElement | null;
        if (run.status === 'running') {
            const stopping = run.stopRequested === true;
            if (existing) {
                const label = stopping ? this._t('benchmark.action.stopping') : this._t('benchmark.action.stop');
                if (existing.textContent !== label) existing.textContent = label;
                if (existing.disabled !== stopping) existing.disabled = stopping;
                return;
            }
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'btn btn-sm btn-stop';
            button.dataset.action = 'stop-run';
            button.textContent = stopping ? this._t('benchmark.action.stopping') : this._t('benchmark.action.stop');
            button.disabled = stopping;
            actions.prepend(button);
            return;
        }
        existing?.remove();
    }

    private patchRunningPill(run: RunRecord) {
        const pill = this.shadowRoot?.querySelector('[data-running-pill]') as HTMLElement | null;
        if (!pill) return;
        const running = run.summary.running;
        pill.hidden = running <= 0;
        if (running <= 0) return;
        const html = `<span class="dot"></span>${escapeHtml(this._t('benchmark.detail.runningNow', { count: running }))}`;
        if (pill.innerHTML !== html) pill.innerHTML = html;
    }

    /* 运行中的用例耗时在变，但不重建行，只改文本，避免 hover 状态被打断 */
    private patchDurations(run: RunRecord) {
        if (this.detailTab !== 'cases') return;
        const root = this.shadowRoot;
        if (!root) return;
        for (const item of run.cases) {
            const cell = root.querySelector(`[data-duration-key="${CSS.escape(item.key)}"]`) as HTMLElement | null;
            if (!cell) continue;
            const duration = item.startedAt ? formatDuration((item.finishedAt ?? Date.now()) - item.startedAt) : '-';
            if (cell.textContent !== duration) cell.textContent = duration;
        }
    }

    /* 遮罩关闭策略：信息型弹窗允许点遮罩关闭；带表单的弹窗（运行测评）只认 ESC / 关闭按钮 */
    private bindModalDismiss() {
        const root = this.shadowRoot;
        if (!root) return;
        const overlays = root.querySelectorAll<HTMLElement>('.modal-overlay');
        overlays.forEach((overlay) => {
            const lightDismiss = overlay.dataset.lightDismiss === 'true';
            bindOverlayDismiss(overlay, () => this.closeModals(), undefined, lightDismiss);
        });
    }

    /* 弹窗/详情打开时后台刷新只更新数据，不重建 DOM：
       弹窗重建会闪一下并丢输入，详情重建会打乱滚动位置与 hover */
    private renderUnlessModalOpen() {
        if (this.datasetModalId || this.catalogModalId || this.runModal || this.detailRunId) return;
        this.render();
    }

    private schedulePoll() {
        this.clearPoll();
        if (!this.detailRunId) return;
        if (!this.detail) {
            if (this.detailMissCount <= 10) {
                this.pollTimer = window.setTimeout(() => {
                    if (this.detailRunId) void this.loadDetail(this.detailRunId, false);
                }, 1500);
            }
            return;
        }
        if (this.detail.status !== 'running') return;
        this.pollTimer = window.setTimeout(() => {
            if (this.detailRunId) void this.loadDetail(this.detailRunId, false);
        }, 1500);
    }

    private clearPoll() {
        if (this.pollTimer !== null) {
            window.clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }
    }

    // ── 交互 ──────────────────────────────────────────────────────────────

    private handleClick = async (event: Event) => {
        const target = event.target as HTMLElement | null;
        if (!target) return;
        if (this.caseMenu && !target.closest('.case-menu')) {
            this.closeCaseMenu();
        }
        if (this.modelPanel) {
            const insidePanel = target.closest('.model-panel');
            const onTrigger = target.closest('[data-action="toggle-model-panel"]');
            const action = (target.closest('[data-action]') as HTMLElement | null)?.dataset.action;
            const isPanelAction = action === 'pick-model' || action === 'pick-effort';
            if (!insidePanel && !onTrigger && !isPanelAction) {
                // 只收起面板，不整窗重渲染：避免弹窗闪烁，也不吞掉这次点击本身
                this.closeModelPanel();
            }
        }
        const actionEl = target.closest('[data-action]') as HTMLElement | null;
        const runRow = target.closest('[data-run-id]') as HTMLElement | null;
        if (!actionEl) {
            if (runRow?.dataset.runId) await this.openDetail(runRow.dataset.runId);
            return;
        }

        const action = actionEl.dataset.action;
        switch (action) {
            case 'tab':
                await this.switchTab((actionEl.dataset.tab as TabId) || 'datasets');
                return;
            case 'import':
                await this.importDataset();
                return;
            case 'refresh':
                // 手动刷新要拿到线上最新清单，不能命中主进程的 5 分钟缓存
                await Promise.all([this.loadCatalog(true), this.loadDatasets(false), this.loadRuns(false)]);
                // 清单和测评集是两路 IPC，谁先回来不确定；这里统一补一次渲染，
                // 免得先回来的那路已经渲染完、后回来的清单却停在旧数据上
                this.renderUnlessModalOpen();
                return;
            case 'open-dataset':
                this.datasetModalId = actionEl.dataset.datasetId || null;
                this.catalogModalId = null;
                this.runModal = null;
                this.render();
                return;
            case 'open-catalog':
                this.catalogModalId = actionEl.dataset.catalogId || null;
                this.datasetModalId = null;
                this.runModal = null;
                this.render();
                return;
            case 'download-dataset': {
                const catalogId = actionEl.dataset.catalogId || this.catalogModalId;
                if (catalogId) await this.downloadDataset(catalogId);
                return;
            }
            case 'close-dataset':
            case 'close-catalog':
            case 'modal-close':
                this.closeModals();
                return;
            case 'run-dataset': {
                const datasetId = actionEl.dataset.datasetId || this.datasetModalId;
                if (datasetId) {
                    // 测评集弹窗 → 运行弹窗属于同一次切换：禁用入场动画，避免中间帧闪一下
                    this.skipModalAnimation = true;
                    this.datasetModalId = null;
                    this.openRunModal(datasetId);
                }
                return;
            }
            case 'toggle-model-panel': {
                const picker = (actionEl.dataset.picker as 'run' | 'verify') || 'run';
                if (this.modelPanel?.picker === picker) {
                    this.closeModelPanel();
                    return;
                }
                this.openModelPanel(picker, actionEl);
                return;
            }
            case 'close-model-panel':
                this.closeModelPanel();
                return;
            case 'pick-model': {
                const picker = actionEl.dataset.picker as 'run' | 'verify';
                const alias = actionEl.dataset.alias || '';
                const model = this.models.find((item) => item.alias === alias);
                if (!model || !this.runModal) return;
                this.applyModelSelection(picker, model, model.defaultEffort);
                return;
            }
            case 'pick-effort': {
                const picker = actionEl.dataset.picker as 'run' | 'verify';
                const alias = actionEl.dataset.alias || '';
                const model = this.models.find((item) => item.alias === alias);
                if (!model || !this.runModal) return;
                this.applyModelSelection(picker, model, actionEl.dataset.effort || '');
                return;
            }
            case 'delete-dataset':
                await this.deleteDataset(actionEl.dataset.datasetId || '', actionEl.dataset.datasetName || '');
                return;
            case 'open-url': {
                const url = actionEl.dataset.url;
                if (url)
                    await getAPI()
                        .callMainWorld('openUrl', url)
                        .catch(() => undefined);
                return;
            }
            case 'open-run':
                if (actionEl.dataset.runId) await this.openDetail(actionEl.dataset.runId);
                return;
            case 'back':
                this.detailRunId = null;
                this.detail = null;
                this.focusedCaseKey = null;
                this.expandedCases.clear();
                this.detailMissCount = 0;
                this.detailTab = 'overview';
                this.clearPoll();
                await this.loadRuns(false);
                return;
            case 'open-case': {
                const key = actionEl.dataset.caseKey;
                if (!key) return;
                this.focusedCaseKey = key;
                this.detailTab = 'cases';
                this.render();
                this.focusCaseRow(key);
                return;
            }
            case 'toggle-case': {
                await this.toggleCaseExpand(actionEl.dataset.caseKey || '');
                return;
            }
            case 'case-menu-jump-run':
            case 'case-menu-jump-verify': {
                const key = actionEl.dataset.caseKey || '';
                const item = this.detail?.cases.find((entry) => entry.key === key);
                const taskId = action === 'case-menu-jump-run' ? item?.runTaskId : item?.verifyTaskId;
                this.closeCaseMenu();
                if (taskId)
                    await getAPI()
                        .callMainWorld('openTask', taskId)
                        .catch(() => undefined);
                return;
            }
            case 'case-menu-rerun': {
                const key = actionEl.dataset.caseKey || '';
                this.closeCaseMenu();
                if (!this.detailRunId || !key) return;
                try {
                    // 原地重跑：返回的就是当前 runId，重新拉详情即可看到该用例转为运行中，
                    // 其余用例的历史状态不受影响
                    const runId = await getAPI().callMainWorld<string>('rerunCase', this.detailRunId, key);
                    await this.loadDetail(runId, false);
                } catch (error: any) {
                    this.banner = { text: error?.message || this._t('error.operationFailed'), isError: true };
                    this.render();
                }
                return;
            }
            case 'case-menu-close':
                this.closeCaseMenu();
                return;
            case 'detail-tab':
                this.detailTab = (actionEl.dataset.detailTab as DetailTab) || 'overview';
                this.render();
                return;
            case 'stop-run':
                if (this.detailRunId) {
                    await getAPI()
                        .callMainWorld('stopRun', this.detailRunId)
                        .catch((error: any) => {
                            this.banner = { text: error?.message || this._t('error.operationFailed'), isError: true };
                            this.render();
                        });
                    await this.loadDetail(this.detailRunId, false);
                }
                return;
            case 'delete-run':
                await this.deleteRun(actionEl.dataset.runId || '');
                return;
            case 'open-folder':
                if (this.detailRunId) {
                    await getAPI()
                        .callMainWorld('openRunDirectory', this.detailRunId)
                        .catch(() => undefined);
                }
                return;
            case 'toggle-track': {
                const modal = this.runModal;
                const trackId = actionEl.dataset.trackId;
                if (!modal || modal.busy || !trackId) return;
                const selected = new Set(modal.selectedTracks);
                if (selected.has(trackId)) selected.delete(trackId);
                else selected.add(trackId);
                modal.selectedTracks = [...selected];
                modal.error = selected.size === 0 ? this._t('error.noTrackSelected') : '';
                // 定点更新，避免整窗重渲染导致闪烁/输入焦点丢失
                actionEl.classList.toggle('active', selected.has(trackId));
                this.updateModalError();
                return;
            }
            case 'run-cancel':
                this.runModal = null;
                this.render();
                return;
            case 'run-start':
                await this.startRun();
                return;
            default:
                return;
        }
    };

    /* ESC：先收模型面板，再关弹窗（表单型弹窗不响应外部点击，只认 ESC / 关闭按钮） */
    private handleKeydown = (event: KeyboardEvent) => {
        if (event.key !== 'Escape') return;
        // 确认弹窗自己也监听 document 的 ESC（且同目标上的 stopPropagation 拦不住我们），
        // 这时按 ESC 只是想取消确认，不能顺带把下层弹窗一起关掉
        if (document.querySelector('.od-confirm-modal-overlay')) return;
        if (this.caseMenu) {
            this.closeCaseMenu();
            return;
        }
        if (this.modelPanel) {
            this.closeModelPanel();
            event.stopPropagation();
            return;
        }
        if (this.datasetModalId || this.runModal || this.catalogModalId) {
            this.closeModals();
        }
    };

    private closeModals() {
        this.datasetModalId = null;
        this.catalogModalId = null;
        this.runModal = null;
        this.modelPanel = null;
        this.effortMenu = null;
        this.render();
    }

    private applyModelSelection(picker: 'run' | 'verify', model: ModelOption, effort: string) {
        if (!this.runModal) return;
        // 模型默认档位可能不在该模型支持列表里，回退到「模型默认」
        const nextEffort = model.efforts.includes(effort) ? effort : '';
        if (picker === 'run') {
            this.runModal.runModel = model.alias;
            this.runModal.runModelEffort = nextEffort;
        } else {
            this.runModal.verifyModel = model.alias;
            this.runModal.verifyModelEffort = nextEffort;
        }
        this.closeModelPanel();
        this.updateModelTrigger(picker, model, nextEffort);
    }

    /* 模型按钮定点更新：只改图标/名称/强度 chip，不重建弹窗 */
    private updateModelTrigger(picker: 'run' | 'verify', model: ModelOption, effort: string) {
        const trigger = this.shadowRoot?.querySelector(`.model-trigger[data-picker="${picker}"]`) as HTMLElement | null;
        if (!trigger) return;
        const aliasEl = trigger.querySelector('.model-trigger-alias');
        if (aliasEl) aliasEl.textContent = model.alias;
        const tile = trigger.querySelector('.agent-icon-tile');
        if (tile) tile.outerHTML = this.modelIconTile(model.vision);
        const chip = trigger.querySelector('.model-effort-chip');
        if (chip) chip.innerHTML = `${effortIconSvg(effort)}${escapeHtml(this.effortLabel(effort))}`;
    }

    private openModelPanel(picker: 'run' | 'verify', trigger: HTMLElement) {
        const rect = trigger.getBoundingClientRect();
        this.modelPanel = {
            picker,
            left: Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - 292)),
            top: Math.min(rect.bottom + 6, Math.max(8, window.innerHeight - 268))
        };
        this.effortMenu = null;
        const root = this.shadowRoot!;
        root.querySelector('.model-panel')?.remove();
        root.querySelector('.effort-submenu')?.remove();
        const holder = document.createElement('div');
        holder.innerHTML = this.renderModelPanel();
        const element = holder.firstElementChild as HTMLElement | null;
        if (element) root.querySelector('.app')?.appendChild(element);
        root.querySelector<HTMLInputElement>(`.model-panel[data-picker="${picker}"] .model-search`)?.focus();
    }

    private closeModelPanel() {
        this.modelPanel = null;
        this.effortMenu = null;
        const root = this.shadowRoot;
        root?.querySelector('.model-panel')?.remove();
        root?.querySelector('.effort-submenu')?.remove();
    }

    /* 弹窗内错误提示的定点更新 */
    private updateModalError() {
        const root = this.shadowRoot;
        const modal = root?.querySelector('.modal-dialog');
        if (!root || !modal) return;
        const text = this.runModal?.error || '';
        let element = modal.querySelector('.modal-error') as HTMLElement | null;
        if (!text) {
            element?.remove();
            return;
        }
        if (!element) {
            element = document.createElement('div');
            element.className = 'modal-error';
            modal.querySelector('.modal-body')?.appendChild(element);
        }
        element.textContent = text;
    }

    /* 悬浮在模型条目上时展开思考强度子菜单（与 agentinput 的交互一致） */
    private handleHover = (event: Event) => {
        const target = event.target as HTMLElement | null;
        const item = target?.closest('.model-panel-item') as HTMLElement | null;
        if (!item || !this.modelPanel) return;
        const alias = item.dataset.alias || '';
        if (!alias) return;
        const rect = item.getBoundingClientRect();
        const left = rect.right + 6 + 160 > window.innerWidth ? Math.max(8, rect.left - 166) : rect.right + 6;
        // 估算高度并夹在视口内，避免最后几档被窗口底边裁掉
        const estimatedHeight = this.effortValuesFor(alias).length * 30 + 14;
        const top = Math.max(8, Math.min(rect.top, window.innerHeight - estimatedHeight - 10));
        const info = { picker: this.modelPanel.picker, alias, left, top };
        if (this.effortMenu && this.effortMenu.alias === alias && this.effortMenu.picker === info.picker) return;
        this.effortMenu = info;
        this.refreshEffortMenu();
    };

    /* 搜索框只过滤列表，不重渲染整个弹窗（避免输入丢焦点） */
    private handleInput = (event: Event) => {
        const input = event.target as HTMLInputElement | null;
        if (!input || !input.classList.contains('model-search')) return;
        const query = input.value.trim().toLowerCase();
        const panel = input.closest('.model-panel');
        if (!panel) return;
        panel.querySelectorAll<HTMLElement>('.model-panel-item').forEach((item) => {
            const alias = (item.dataset.alias || '').toLowerCase();
            item.style.display = !query || alias.includes(query) ? '' : 'none';
        });
    };

    private async switchTab(tab: TabId) {
        if (this.activeTab === tab && !this.detailRunId) return;
        this.focusedCaseKey = null;
        this.activeTab = tab;
        this.detailRunId = null;
        this.detail = null;
        this.clearPoll();
        // 清单要联网：切到下载中心时先把加载态摆上再渲染，否则会先闪一屏「暂无可下载的测评集」
        const catalogPending = tab === 'catalog' && this.catalog.length === 0;
        if (catalogPending) this.catalogLoading += 1;
        this.render();
        try {
            if (tab === 'catalog') await Promise.all([this.loadCatalog(), this.loadDatasets(false)]);
            else if (tab === 'datasets') await this.loadDatasets(false);
            else await this.loadRuns(false);
        } finally {
            if (catalogPending) {
                this.catalogLoading -= 1;
                this.renderUnlessModalOpen();
            }
        }
    }

    private async openDetail(runId: string) {
        this.focusedCaseKey = null;
        // 展开态属于「上一次看的那轮」，换一轮后 key 会重复命中，必须清掉
        this.expandedCases.clear();
        this.detailRunId = runId;
        this.detail = null;
        this.detailMissCount = 0;
        this.activeTab = 'history';
        this.detailTab = 'overview';
        await this.loadDetail(runId, true);
    }

    private openRunModal(datasetId: string) {
        const dataset = this.datasets.find((item) => item.id === datasetId);
        if (!dataset) return;
        const defaultModel = this.models.find((item) => item.isDefault) ?? this.models[0];
        this.modelPanel = null;
        this.effortMenu = null;
        this.runModal = {
            datasetId: dataset.id,
            datasetName: dataset.name,
            caseCount: dataset.caseCount,
            concurrency: 2,
            runModel: defaultModel?.alias ?? '',
            runModelEffort: defaultModel?.defaultEffort ?? '',
            verifyModel: defaultModel?.alias ?? '',
            verifyModelEffort: defaultModel?.defaultEffort ?? '',
            runTimeout: '',
            verifyTimeout: '',
            tracks: dataset.tracks.map((track) => ({
                id: track.id,
                name: track.name,
                caseCount: track.caseCount
            })),
            selectedTracks: dataset.tracks.map((track) => track.id),
            busy: false,
            error: this.models.length === 0 ? this._t('benchmark.run.modelsEmpty') : ''
        };
        this.render();
    }

    private async importDataset() {
        if (this.importing) return;
        let paths: string[] = [];
        try {
            paths = (await (window as any).fsAPI?.selectFile?.()) ?? [];
        } catch {
            paths = [];
        }
        const archivePath = paths[0];
        if (!archivePath) return;

        this.importing = true;
        this.banner = { text: this._t('benchmark.import.importing'), isError: false };
        this.render();
        try {
            const dataset = await getAPI().callMainWorld<DatasetSummary>('importDataset', archivePath);
            this.banner = { text: this._t('benchmark.import.success', { name: dataset.name }), isError: false };
            await this.loadDatasets(false);
        } catch (error: any) {
            this.banner = {
                text: this._t('benchmark.import.failed', {
                    message: error?.message || this._t('error.operationFailed')
                }),
                isError: true
            };
        } finally {
            this.importing = false;
            this.render();
        }
    }

    /**
     * 触发下载：主进程后台下载并推送进度，这里拿到「已开始」就可以返回，
     * 随后拉一次下载状态把弹窗切到进度条形态。
     */
    private async downloadDataset(catalogId: string) {
        const entry = this.catalog.find((item) => item.id === catalogId);
        if (!entry) return;
        this.banner = null;
        try {
            await getAPI().callMainWorld('downloadDataset', catalogId);
        } catch (error: any) {
            this.banner = {
                text: this._t('benchmark.catalog.downloadError', {
                    message: error?.message || this._t('error.operationFailed')
                }),
                isError: true
            };
        }
        await this.refreshDownloads();
        // 弹窗还开着，这里只是把按钮切成进度条形态，不要重播入场动画
        this.skipModalAnimation = true;
        this.render();
    }

    private async deleteDataset(datasetId: string, datasetName: string) {
        if (!datasetId) return;
        const confirmed = await showConfirmModal({
            title: this._t('benchmark.action.delete'),
            message: this._t('benchmark.datasets.deleteConfirm', { name: datasetName || datasetId }),
            confirmText: this._t('benchmark.action.delete'),
            cancelText: this._t('benchmark.action.cancel'),
            danger: true
        });
        if (!confirmed) return;
        try {
            await getAPI().callMainWorld('deleteDataset', datasetId);
            this.datasetModalId = null;
            await this.loadDatasets(false);
        } catch (error: any) {
            this.banner = { text: error?.message || this._t('error.operationFailed'), isError: true };
            this.render();
        }
    }

    private async deleteRun(runId: string) {
        if (!runId) return;
        const confirmed = await showConfirmModal({
            title: this._t('benchmark.action.delete'),
            message: this._t('benchmark.run.deleteConfirm'),
            confirmText: this._t('benchmark.action.delete'),
            cancelText: this._t('benchmark.action.cancel'),
            danger: true
        });
        if (!confirmed) return;
        try {
            await getAPI().callMainWorld('deleteRun', runId);
            if (this.detailRunId === runId) {
                this.detailRunId = null;
                this.detail = null;
            }
            await this.loadRuns(false);
        } catch (error: any) {
            this.banner = { text: error?.message || this._t('error.operationFailed'), isError: true };
            this.render();
        }
    }

    /** 弹窗内的输入先回写到状态，避免重渲染（如切换 track）时丢用户输入 */
    private syncModalInputs() {
        const modal = this.runModal;
        if (!modal) return;
        const root = this.shadowRoot!;
        const concurrencyInput = root.querySelector('#benchmark-concurrency') as HTMLInputElement | null;
        const runTimeoutInput = root.querySelector('#benchmark-run-timeout') as HTMLInputElement | null;
        const verifyTimeoutInput = root.querySelector('#benchmark-verify-timeout') as HTMLInputElement | null;
        if (concurrencyInput) modal.concurrency = Number(concurrencyInput.value);
        if (runTimeoutInput) modal.runTimeout = runTimeoutInput.value.trim();
        if (verifyTimeoutInput) modal.verifyTimeout = verifyTimeoutInput.value.trim();
    }

    private async startRun() {
        if (!this.runModal || this.runModal.busy) return;
        this.syncModalInputs();
        const modal = this.runModal!;
        const concurrency = modal.concurrency;
        const runModel = modal.runModel;
        const verifyModel = modal.verifyModel;
        const selectedTracks = [...modal.selectedTracks];
        const parseTimeout = (value: string): number | null => {
            if (!value) return null;
            const parsed = Number(value);
            return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : Number.NaN;
        };
        const runTimeoutSec = parseTimeout(modal.runTimeout);
        const verifyTimeoutSec = parseTimeout(modal.verifyTimeout);

        const failWith = (message: string) => {
            this.runModal = { ...modal, busy: false, error: message };
            this.updateModalError();
        };
        if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 20) {
            failWith(this._t('error.concurrencyInvalid'));
            return;
        }
        if (!runModel || !verifyModel) {
            failWith(this._t('benchmark.run.modelsEmpty'));
            return;
        }
        if (selectedTracks.length === 0) {
            failWith(this._t('error.noTrackSelected'));
            return;
        }
        if (Number.isNaN(runTimeoutSec) || Number.isNaN(verifyTimeoutSec)) {
            failWith(this._t('error.timeoutInvalid'));
            return;
        }

        this.skipModalAnimation = true;
        this.runModal = { ...modal, busy: true, error: '' };
        this.render();
        try {
            const runId = await getAPI().callMainWorld<string>('startRun', {
                datasetId: modal.datasetId,
                concurrency,
                runModel,
                runModelEffort: modal.runModelEffort,
                verifyModel: modal.verifyModel,
                verifyModelEffort: modal.verifyModelEffort,
                runTimeoutSec,
                verifyTimeoutSec,
                tracks: selectedTracks
            });
            this.runModal = null;
            this.activeTab = 'history';
            await this.loadRuns(false);
            await this.openDetail(runId);
        } catch (error: any) {
            this.skipModalAnimation = true;
            this.runModal = { ...modal, busy: false, error: error?.message || this._t('error.operationFailed') };
            this.render();
        }
    }

    // ── 渲染 ──────────────────────────────────────────────────────────────

    render() {
        const shadow = this.shadowRoot;
        if (!shadow) return;
        // 模型面板/右键菜单都是定点维护的（不进模板），整窗重建后它们已不存在，状态一并复位
        this.modelPanel = null;
        this.effortMenu = null;
        this.caseMenu = null;
        const scrollKey = this.detailRunId ?? this.activeTab;
        const previous = shadow.querySelector('.content') as HTMLElement | null;
        if (previous) this.scrollPositions.set(scrollKey, previous.scrollTop);

        shadow.innerHTML = `<style>${SHADOW_CSS}</style>${this.renderShell()}`;
        this.skipModalAnimation = false;
        this.bindModalDismiss();

        const next = shadow.querySelector('.content') as HTMLElement | null;
        if (next) next.scrollTop = this.scrollPositions.get(scrollKey) ?? 0;

        this.detailSignature = this.detail && this.detailRunId ? this.computeDetailSignature(this.detail) : null;
        this.markFocusedRow();
    }

    private renderShell(): string {
        const refreshButton = `<button type="button" class="btn" data-action="refresh">${escapeHtml(this._t('benchmark.action.refresh'))}</button>`;
        const actions =
            this.activeTab === 'datasets'
                ? `<button type="button" class="btn btn-primary" data-action="import" ${this.importing ? 'disabled' : ''}>
                        ${this.importing ? escapeHtml(this._t('benchmark.import.importing')) : escapeHtml(this._t('benchmark.action.import'))}
                   </button>`
                : refreshButton;

        const body = this.detailRunId
            ? this.renderDetail()
            : this.activeTab === 'catalog'
              ? this.renderCatalog()
              : this.activeTab === 'datasets'
                ? this.renderDatasets()
                : this.renderRuns();

        const pendingDownloads = this.catalog.filter(
            (entry) => resolveCatalogInstallState(entry, this.datasets) !== 'installed'
        ).length;

        return `
        <div class="app">
            <div class="header-area">
                <div class="header-title">${escapeHtml(this._t('benchmark.title'))}</div>
                <div class="seg-row">
                    <div class="seg-control">
                        <button type="button" class="seg-item ${this.activeTab === 'catalog' ? 'active' : ''}" data-action="tab" data-tab="catalog">
                            ${escapeHtml(this._t('benchmark.tab.catalog'))}${pendingDownloads > 0 ? `<span class="seg-badge">${pendingDownloads}</span>` : ''}
                        </button>
                        <button type="button" class="seg-item ${this.activeTab === 'datasets' ? 'active' : ''}" data-action="tab" data-tab="datasets">
                            ${escapeHtml(this._t('benchmark.tab.datasets'))}${this.datasets.length > 0 ? `<span class="seg-badge">${this.datasets.length}</span>` : ''}
                        </button>
                        <button type="button" class="seg-item ${this.activeTab === 'history' ? 'active' : ''}" data-action="tab" data-tab="history">
                            ${escapeHtml(this._t('benchmark.tab.history'))}${this.runs.length > 0 ? `<span class="seg-badge">${this.runs.length}</span>` : ''}
                        </button>
                    </div>
                    <div class="header-actions">${actions}</div>
                </div>
            </div>
            <div class="content">
                ${this.banner ? `<div class="banner${this.banner.isError ? ' error' : ''}">${escapeHtml(this.banner.text)}</div>` : ''}
                ${body}
            </div>
            ${this.renderDatasetModal()}
            ${this.renderCatalogModal()}
            ${this.renderRunModal()}
            ${this.renderModelPanel()}
        </div>`;
    }

    // ── 测评集下载 ─────────────────────────────────────────────────────────

    private renderCatalog(): string {
        // 首次挂载/切页签时清单还没回来，先转圈；否则会先闪一下「暂无可下载的测评集」
        if ((this.loading || this.catalogLoading > 0) && this.catalog.length === 0) {
            return `<div class="loading-state"><div class="spinner"></div></div>`;
        }
        if (this.catalog.length === 0) {
            return `
            <div class="empty-state">
                <div class="empty-icon">⤓</div>
                <div class="empty-title">${escapeHtml(this._t('benchmark.catalog.emptyTitle'))}</div>
                <div class="empty-hint">${escapeHtml(this._t('benchmark.catalog.emptyHint'))}</div>
            </div>`;
        }
        const cards = this.catalog.map((entry) => this.renderCatalogCard(entry)).join('');
        return `<div class="card-grid">${cards}</div>`;
    }

    private renderCatalogCard(entry: CatalogDatasetEntry): string {
        const colors = colorFor(entry.name);
        const initial = entry.name.trim().charAt(0) || 'B';
        const tags = entry.tracks
            .map((track) => `<span class="tag-pill tag-blue">${escapeHtml(track.name)}</span>`)
            .join('');
        const description = entry.description ? `<div class="card-desc">${escapeHtml(entry.description)}</div>` : '';
        const pill = this.catalogStatusView(entry);
        return `
        <article class="dataset-card" data-action="open-catalog" data-catalog-id="${escapeHtml(entry.id)}">
            <div class="card-header">
                <div class="card-icon" style="background:${colors.bg};color:${colors.text}">${escapeHtml(initial)}</div>
                <div class="card-info">
                    <div class="card-title">${escapeHtml(entry.name)}</div>
                    <div class="card-subtitle">
                        ${escapeHtml(this._t('benchmark.datasets.tracks', { count: entry.tracks.length }))} ·
                        ${escapeHtml(this._t('benchmark.catalog.version', { version: entry.version }))}
                    </div>
                </div>
                <span class="status-pill ${pill.className}" data-catalog-status="${escapeHtml(entry.id)}">${escapeHtml(pill.label)}</span>
            </div>
            ${description}
            <div class="card-footer">
                <div class="card-meta">${tags}</div>
            </div>
        </article>`;
    }

    /** 卡片/弹窗右上角的状态标签：下载中 > 下载失败 > 安装状态 */
    private catalogStatusView(entry: CatalogDatasetEntry): { className: string; label: string } {
        const state = this.downloads.get(entry.id);
        if (state?.status === 'installing') {
            return { className: 'running', label: this._t('benchmark.catalog.installing') };
        }
        if (state?.status === 'downloading') {
            const ratio =
                state.totalBytes && state.totalBytes > 0 ? Math.min(1, state.receivedBytes / state.totalBytes) : null;
            const label =
                ratio === null
                    ? this._t('benchmark.catalog.downloadingNoTotal')
                    : this._t('benchmark.catalog.downloading', { percent: Math.round(ratio * 100) });
            return { className: 'running', label };
        }
        if (state?.status === 'failed') {
            return { className: 'failed', label: this._t('benchmark.catalog.downloadFailed') };
        }
        switch (resolveCatalogInstallState(entry, this.datasets)) {
            case 'installed':
                return { className: 'completed', label: this._t('benchmark.catalog.installed') };
            case 'update-available':
                return { className: 'running', label: this._t('benchmark.catalog.updateAvailable') };
            default:
                return { className: 'pending', label: this._t('benchmark.catalog.notInstalled') };
        }
    }

    private renderDatasets(): string {
        if (this.loading) {
            return `<div class="loading-state"><div class="spinner"></div></div>`;
        }
        if (this.datasets.length === 0) {
            return `
            <div class="empty-state">
                <div class="empty-icon">◫</div>
                <div class="empty-title">${escapeHtml(this._t('benchmark.datasets.emptyTitle'))}</div>
                <div class="empty-hint">${escapeHtml(this._t('benchmark.datasets.emptyHint'))}</div>
                <button type="button" class="btn btn-primary" data-action="import" ${this.importing ? 'disabled' : ''}>
                    ${escapeHtml(this._t('benchmark.action.import'))}
                </button>
            </div>`;
        }
        const cards = this.datasets.map((dataset) => this.renderDatasetCard(dataset)).join('');
        return `<div class="card-grid">${cards}</div>`;
    }

    private renderDatasetCard(dataset: DatasetSummary): string {
        const colors = colorFor(dataset.name);
        const initial = dataset.name.trim().charAt(0) || 'B';
        const tags = dataset.tracks
            .map((track) => `<span class="tag-pill tag-blue">${escapeHtml(track.name)} · ${track.caseCount}</span>`)
            .join('');
        const description = dataset.description
            ? `<div class="card-desc">${escapeHtml(dataset.description)}</div>`
            : '';
        const version = this.datasetVersionLabel(dataset.version);
        return `
        <article class="dataset-card" data-action="open-dataset" data-dataset-id="${escapeHtml(dataset.id)}">
            <div class="card-header">
                <div class="card-icon" style="background:${colors.bg};color:${colors.text}">${escapeHtml(initial)}</div>
                <div class="card-info">
                    <div class="card-title">${escapeHtml(dataset.name)}</div>
                    <div class="card-subtitle">
                        ${escapeHtml(this._t('benchmark.datasets.tracks', { count: dataset.tracks.length }))} ·
                        ${escapeHtml(this._t('benchmark.datasets.cases', { count: dataset.caseCount }))} ·
                        ${version ? `${escapeHtml(version)} · ` : ''}${escapeHtml(formatTime(dataset.importedAt))}
                    </div>
                </div>
            </div>
            ${description}
            <div class="card-footer">
                <div class="card-meta">${tags}</div>
            </div>
        </article>`;
    }

    /** 测评集版本标签；dataset.json 没写版本时返回空串，不占位 */
    private datasetVersionLabel(version: string): string {
        const trimmed = (version || '').trim();
        return trimmed ? this._t('benchmark.datasets.version', { version: trimmed }) : '';
    }

    private renderRuns(): string {
        if (this.loading && this.runs.length === 0) {
            return `<div class="loading-state"><div class="spinner"></div></div>`;
        }
        if (this.runs.length === 0) {
            return `
            <div class="empty-state">
                <div class="empty-icon">◷</div>
                <div class="empty-title">${escapeHtml(this._t('benchmark.runs.emptyTitle'))}</div>
                <div class="empty-hint">${escapeHtml(this._t('benchmark.runs.emptyHint'))}</div>
            </div>`;
        }
        const rows = this.runs.map((run) => this.renderRunRow(run)).join('');
        return `<div class="run-list">${rows}</div>`;
    }

    private renderRunRow(run: RunListItem): string {
        const summary = run.summary;
        const finished = summary.completed + summary.failed + summary.stopped;
        const progress = summary.total > 0 ? finished / summary.total : 0;
        const statusKey = RUN_STATUS_KEYS[run.status] || 'benchmark.status.stopped';
        const scoreText = summary.maxScore > 0 ? summary.totalScore.toFixed(2) : '-';
        return `
        <div class="run-row" data-run-id="${escapeHtml(run.id)}">
            <div>
                <div class="run-title-row">
                    <span class="run-name">${escapeHtml(run.datasetName)}</span>
                    <span class="status-pill ${escapeHtml(run.status)}"><span class="dot"></span>${escapeHtml(this._t(statusKey))}</span>
                </div>
                <div class="run-sub">
                    ${escapeHtml(this._t('benchmark.detail.models', { test: run.runModel, verify: run.verifyModel }))} ·
                    ${escapeHtml(this._t('benchmark.detail.concurrency', { count: run.concurrency }))} ·
                    ${escapeHtml(formatTime(run.createdAt))} · ${finished}/${summary.total}
                </div>
                <div class="mini-progress"><span style="width:${Math.round(progress * 100)}%"></span></div>
            </div>
            <div class="run-score">
                <div class="score-value">${escapeHtml(scoreText)}</div>
                <div class="score-caption">${escapeHtml(this._t('benchmark.detail.totalScore'))} / ${summary.maxScore.toFixed(2)}</div>
            </div>
            <div class="run-actions">
                <button type="button" class="btn btn-sm btn-danger" data-action="delete-run" data-run-id="${escapeHtml(run.id)}">✕</button>
            </div>
        </div>`;
    }

    // ── 运行详情（矩阵看板） ───────────────────────────────────────────────

    private renderDetail(): string {
        const run = this.detail;
        const backBtn = `<button type="button" class="btn btn-sm" data-action="back">← ${escapeHtml(this._t('benchmark.action.back'))}</button>`;
        if (!run) {
            return this.detailLoading
                ? `${backBtn}<div class="loading-state"><div class="spinner"></div></div>`
                : `${backBtn}<div class="empty-state"><div class="empty-title">${escapeHtml(this._t('error.runNotFound'))}</div></div>`;
        }

        const summary = run.summary;
        const finished = summary.completed + summary.failed + summary.stopped;
        const statusKey = RUN_STATUS_KEYS[run.status] || 'benchmark.status.stopped';
        const stopping = run.status === 'running' && run.stopRequested === true;
        const stopButton =
            run.status === 'running'
                ? `<button type="button" class="btn btn-sm btn-stop" data-action="stop-run"${stopping ? ' disabled' : ''}>${escapeHtml(this._t(stopping ? 'benchmark.action.stopping' : 'benchmark.action.stop'))}</button>`
                : '';
        const tabs = `
            <div class="detail-tabs">
                <button type="button" class="detail-tab ${this.detailTab === 'overview' ? 'active' : ''}" data-action="detail-tab" data-detail-tab="overview">${escapeHtml(this._t('benchmark.detail.tabOverview'))}</button>
                <button type="button" class="detail-tab ${this.detailTab === 'cases' ? 'active' : ''}" data-action="detail-tab" data-detail-tab="cases">${escapeHtml(this._t('benchmark.detail.cases'))}</button>
            </div>`;

        return `
        <div class="detail-head">
            ${backBtn}
            <span class="detail-title">${escapeHtml(run.datasetName)}</span>
            <span class="status-pill ${escapeHtml(run.status)}"><span class="dot"></span>${escapeHtml(this._t(statusKey))}</span>
            <span class="detail-actions">
                ${stopButton}
                <button type="button" class="btn btn-sm" data-action="open-folder">${escapeHtml(this._t('benchmark.action.openFolder'))}</button>
            </span>
            <div class="detail-meta">
                ${escapeHtml(this._t('benchmark.detail.models', { test: run.runModel, verify: run.verifyModel }))} ·
                ${escapeHtml(this._t('benchmark.detail.concurrency', { count: run.concurrency }))} ·
                ${escapeHtml(this._t('benchmark.detail.startedAt', { time: formatTime(run.startedAt ?? run.createdAt) }))} ·
                ${finished}/${summary.total}
            </div>
        </div>
        ${tabs}
        ${this.detailTab === 'cases' ? this.renderCaseTable(run) : this.renderOverview(run)}`;
    }

    private renderOverview(run: RunRecord): string {
        const summary = run.summary;
        return `
        <div class="kpi-row">
            ${this.renderKpi('score', this._t('benchmark.detail.totalScore'), summary.totalScore.toFixed(2), summary.maxScore.toFixed(2))}
            ${this.renderKpi('avg', this._t('benchmark.detail.avg'), percent(summary.avgRatio), '')}
            ${this.renderKpi('completed', this._t('benchmark.detail.completed'), String(summary.completed), String(summary.total))}
            ${this.renderKpi('failed', this._t('benchmark.detail.failedStopped'), String(summary.failed + summary.stopped), '')}
            ${this.renderKpi('duration', this._t('benchmark.detail.avgDuration'), formatDuration(summary.avgDurationMs), '')}
        </div>
        <div class="panel" style="margin-bottom:12px">
            <div class="panel-title">${escapeHtml(this._t('benchmark.detail.matrix'))}</div>
            ${this.renderMatrix(run)}
            ${this.renderMatrixLegend()}
        </div>
        <div class="panel">
            <div class="panel-title">${escapeHtml(this._t('benchmark.detail.distribution'))}</div>
            <div data-dist>${this.renderDistribution(run.cases)}</div>
        </div>`;
    }

    private renderKpi(key: string, label: string, value: string, suffix: string): string {
        return `
        <div class="kpi" data-kpi="${key}">
            <div class="kpi-label">${escapeHtml(label)}</div>
            ${this.kpiValueHtml(value, suffix)}
        </div>`;
    }

    private kpiValueHtml(value: string, suffix: string): string {
        return `<div class="kpi-value">${escapeHtml(value)}${suffix ? `<small>/ ${escapeHtml(suffix)}</small>` : ''}</div>`;
    }

    private renderMatrix(run: RunRecord): string {
        const groups = new Map<string, { name: string; cases: CaseRunState[] }>();
        for (const item of run.cases) {
            let group = groups.get(item.trackId);
            if (!group) {
                group = { name: item.trackName || item.trackId, cases: [] };
                groups.set(item.trackId, group);
            }
            group.cases.push(item);
        }
        if (groups.size === 0) {
            return `<div class="empty-hint">${escapeHtml(this._t('benchmark.detail.noCases'))}</div>`;
        }

        const rows = [...groups.entries()]
            .map(([trackId, group]) => {
                const done = group.cases.filter((item) => item.status === 'done');
                const ratios = done.map((item) => item.ratio).filter((value): value is number => value !== null);
                const avg = ratios.length > 0 ? ratios.reduce((sum, value) => sum + value, 0) / ratios.length : 0;
                const tiles = group.cases.map((item) => this.renderTile(item)).join('');
                return `
                <div class="matrix-row">
                    <div class="matrix-label">
                        <span class="matrix-label-name">${escapeHtml(group.name)}</span>
                        <span class="matrix-label-meta" data-track-meta="${escapeHtml(trackId)}">${done.length}/${group.cases.length} · ${percent(avg)}</span>
                    </div>
                    <div class="matrix-cells">${tiles}</div>
                </div>`;
            })
            .join('');
        return `<div class="matrix">${rows}</div>`;
    }

    /* 进行中的三个阶段用不同图标区分：准备=虚线圆环、测试=播放、验证=放大镜 */
    private phaseIcon(kind: 'preparing' | 'running' | 'verifying'): string {
        const paths: Record<string, string> = {
            preparing: '<circle cx="6" cy="6" r="4.2" stroke-dasharray="1.7 1.7"/>',
            running: '<path d="M3.2 2 9.6 6 3.2 10Z" fill="currentColor" stroke="none"/>',
            verifying: '<circle cx="5.3" cy="5.3" r="3.3"/><path d="M7.9 7.9 10.6 10.6"/>'
        };
        return `<svg class="phase-icon" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${paths[kind]}</svg>`;
    }

    private tileView(item: CaseRunState): { variant: string; html: string; title: string } {
        let variant = 'pending';
        let label = '·';
        let rawHtml = false;
        if (item.status === 'done') {
            const ratio = item.ratio ?? 0;
            variant = ratio >= 0.8 ? 'ok' : ratio >= 0.6 ? 'good' : ratio >= 0.3 ? 'warn' : 'bad';
            label = `${Math.round(ratio * 100)}`;
        } else if (item.status === 'failed') {
            variant = 'err';
            label = 'Err';
        } else if (item.status === 'stopped') {
            variant = 'stopped';
            label = '–';
        } else if (item.status === 'preparing' || item.status === 'running' || item.status === 'verifying') {
            variant = item.status;
            label = this.phaseIcon(item.status);
            rawHtml = true;
        }

        const statusLabel = this._t(CASE_STATUS_KEYS[item.status] || 'benchmark.caseStatus.pending');
        const detail = [
            item.name,
            statusLabel,
            item.ratio !== null ? percent(item.ratio) : '',
            item.error || item.reason || ''
        ]
            .filter(Boolean)
            .join(' · ');

        return { variant, html: rawHtml ? label : escapeHtml(label), title: detail };
    }

    private renderTile(item: CaseRunState): string {
        const view = this.tileView(item);
        return `<span class="tile ${view.variant}" data-action="open-case" data-case-key="${escapeHtml(item.key)}" data-tile-key="${escapeHtml(item.key)}" title="${escapeHtml(view.title)}">${view.html}</span>`;
    }

    private renderMatrixLegend(): string {
        const items: Array<[string, string, string?]> = [
            ['ok', this._t('benchmark.legend.ok')],
            ['good', this._t('benchmark.legend.good')],
            ['warn', this._t('benchmark.legend.warn')],
            ['bad', this._t('benchmark.legend.bad')],
            ['preparing', this._t('benchmark.legend.preparing'), this.phaseIcon('preparing')],
            ['running', this._t('benchmark.legend.running'), this.phaseIcon('running')],
            ['verifying', this._t('benchmark.legend.verifying'), this.phaseIcon('verifying')],
            ['pending', this._t('benchmark.legend.pending')]
        ];
        return `
        <div class="legend-row">
            ${items
                .map(
                    ([variant, label, icon]) =>
                        `<span class="legend-item"><span class="legend-swatch ${variant}">${icon ?? ''}</span>${escapeHtml(label)}</span>`
                )
                .join('')}
        </div>`;
    }

    private renderDistribution(cases: CaseRunState[]): string {
        const buckets = [0, 0, 0, 0, 0];
        const labels = ['0-20%', '20-40%', '40-60%', '60-80%', '80-100%'];
        const colors = ['#E06060', '#E8935A', '#E4B03A', '#6FBF7A', '#34C759'];
        let scored = 0;
        for (const item of cases) {
            if (item.status !== 'done' || item.ratio === null) continue;
            scored += 1;
            const index = Math.min(buckets.length - 1, Math.floor(item.ratio * buckets.length));
            buckets[index] += 1;
        }
        if (scored === 0) {
            return `<div class="empty-hint" style="padding:0">${escapeHtml(this._t('benchmark.detail.noReason'))}</div>`;
        }
        const segments = buckets
            .map((count, index) => {
                const width = (count / scored) * 100;
                if (count === 0) return '';
                return `<span class="dist-seg" style="width:${width}%;background:${colors[index]}"></span>`;
            })
            .join('');
        const legend = buckets
            .map(
                (count, index) =>
                    `<span class="legend-item"><span class="legend-swatch" style="background:${colors[index]};border-color:${colors[index]}"></span>${labels[index]} · ${count}</span>`
            )
            .join('');
        return `<div class="dist-bar">${segments}</div><div class="dist-legend">${legend}</div>`;
    }

    /* 从矩阵点进某条用例：切到明细并滚到这一行（居中），随后高亮 */
    private focusCaseRow(key: string) {
        const root = this.shadowRoot;
        if (!root) return;
        const row = root.querySelector(`tr[data-case-key="${CSS.escape(key)}"]`) as HTMLElement | null;
        if (!row) return;
        this.markFocusedRow(true);
        const content = root.querySelector('.content') as HTMLElement | null;
        if (!content) return;
        const rowRect = row.getBoundingClientRect();
        const contentRect = content.getBoundingClientRect();
        const target =
            content.scrollTop + (rowRect.top - contentRect.top) - content.clientHeight / 2 + rowRect.height / 2;
        content.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
    }

    private markFocusedRow(refocus = false) {
        const root = this.shadowRoot;
        if (!root) return;
        root.querySelectorAll('tr.focused').forEach((row) => row.classList.remove('focused'));
        if (!this.focusedCaseKey) return;
        const row = root.querySelector(`tr[data-case-key="${CSS.escape(this.focusedCaseKey)}"]`) as HTMLElement | null;
        if (!row) return;
        row.classList.add('focused');
        if (refocus) row.focus({ preventScroll: true });
    }

    /** 只有跑出结果的用例才可展开详情 */
    private canExpandCase(item: CaseRunState | undefined): boolean {
        if (!item) return false;
        return item.status === 'done' || item.status === 'failed';
    }

    private async toggleCaseExpand(key: string): Promise<void> {
        if (!key) return;
        const item = this.detail?.cases.find((entry) => entry.key === key);
        if (!this.canExpandCase(item)) return;
        const row = this.shadowRoot?.querySelector(`tr[data-case-key="${CSS.escape(key)}"]`) as HTMLElement | null;
        if (!row) return;
        const existing = row.nextElementSibling as HTMLElement | null;
        if (this.expandedCases.has(key)) {
            this.expandedCases.delete(key);
            if (existing?.classList.contains('case-detail')) existing.remove();
            row.classList.remove('expanded');
            return;
        }
        this.expandedCases.add(key);
        row.classList.add('expanded');
        const holder = document.createElement('tbody');
        holder.innerHTML = this.renderCaseDetailRow(item!);
        const detailRow = holder.firstElementChild as HTMLElement | null;
        if (detailRow) row.after(detailRow);
    }

    private renderCaseDetailRow(item: CaseRunState): string {
        const statusLabel = this._t(CASE_STATUS_KEYS[item.status] || 'benchmark.caseStatus.pending');
        const duration = item.startedAt ? formatDuration((item.finishedAt ?? Date.now()) - item.startedAt) : '-';
        const scoreText = item.status === 'done' ? (item.score?.toFixed(2) ?? '-') : '-';
        const rows: string[] = [
            `<div class="cd-item"><span class="cd-key">${escapeHtml(this._t('benchmark.caseDetail.status'))}</span><span>${escapeHtml(statusLabel)}</span></div>`,
            `<div class="cd-item"><span class="cd-key">${escapeHtml(this._t('benchmark.caseDetail.score'))}</span><span>${escapeHtml(scoreText)}${item.ratio !== null ? ` · ${escapeHtml(percent(item.ratio))}` : ''}</span></div>`,
            `<div class="cd-item"><span class="cd-key">${escapeHtml(this._t('benchmark.caseDetail.duration'))}</span><span>${escapeHtml(duration)}</span></div>`,
            `<div class="cd-item"><span class="cd-key">${escapeHtml(this._t('benchmark.caseDetail.runTask'))}</span><span class="cd-mono">${escapeHtml(item.runTaskId || '-')}</span></div>`,
            `<div class="cd-item"><span class="cd-key">${escapeHtml(this._t('benchmark.caseDetail.verifyTask'))}</span><span class="cd-mono">${escapeHtml(item.verifyTaskId || '-')}</span></div>`,
            `<div class="cd-item"><span class="cd-key">${escapeHtml(this._t('benchmark.caseDetail.dir'))}</span><span class="cd-mono">${escapeHtml(item.dir)}</span></div>`
        ];
        if (item.error) {
            rows.push(
                `<div class="cd-item cd-full"><span class="cd-key">${escapeHtml(this._t('benchmark.caseDetail.error'))}</span><span class="cd-error">${escapeHtml(item.error)}</span></div>`
            );
        }
        if (item.logError) {
            rows.push(
                `<div class="cd-item cd-full"><span class="cd-key">${escapeHtml(this._t('benchmark.caseDetail.logError'))}</span><pre class="cd-log-error">${escapeHtml(item.logError)}</pre></div>`
            );
        }
        rows.push(
            `<div class="cd-item cd-full"><span class="cd-key">${escapeHtml(this._t('benchmark.caseDetail.reason'))}</span><span class="cd-reason">${escapeHtml(item.reason || this._t('benchmark.detail.noReason'))}</span></div>`
        );
        return `
        <tr class="case-detail" data-case-detail="${escapeHtml(item.key)}">
            <td colspan="5"><div class="case-detail-body">${rows.join('')}</div></td>
        </tr>`;
    }

    /* 用例行右键菜单：复用 agentinput 的 ctx-menu 视觉。
       跑过（有任务/有结果）的用例才给菜单，运行中的用例也能跳转到执行/验证任务；
       跳转项按 taskId 有无禁用，见 renderCaseMenu */
    private handleContextMenu = (event: Event) => {
        const mouse = event as MouseEvent;
        const target = event.target as HTMLElement | null;
        const row = target?.closest('tr[data-case-key]') as HTMLElement | null;
        if (!row || !row.dataset.caseKey || !this.detail) {
            this.closeCaseMenu();
            return;
        }
        const key = row.dataset.caseKey;
        const item = this.detail.cases.find((entry) => entry.key === key);
        // 还没开始跑（pending）的用例既没有可跳转的任务也没有可重跑的意义，
        // 弹出来只会是一个三项全灰的菜单；顺手把上一条的菜单收掉，否则它会飘在原地
        if (!item || item.status === 'pending') {
            this.closeCaseMenu();
            return;
        }
        event.preventDefault();
        const left = Math.min(mouse.clientX, Math.max(8, window.innerWidth - 210));
        const top = Math.min(mouse.clientY, Math.max(8, window.innerHeight - 150));
        this.caseMenu = { key, left, top };
        this.renderCaseMenu();
    };

    private renderCaseMenu(): void {
        const root = this.shadowRoot;
        const menu = this.caseMenu;
        if (!root || !menu) return;
        const run = this.detail;
        const item = run?.cases.find((entry) => entry.key === menu.key);
        const dark = this.dataset.theme === 'dark' ? ' ctx-menu-dark' : '';
        const entry = (action: string, label: string, iconPath: string, disabled = false) => `
            <button type="button" class="ctx-item${disabled ? ' disabled' : ''}" data-action="${action}"
                data-case-key="${escapeHtml(menu.key)}" ${disabled ? 'disabled' : ''}>
                <span class="ctx-icon-sm"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${iconPath}</svg></span>
                <span class="ctx-label">${escapeHtml(label)}</span>
            </button>`;
        // 整轮在跑或该用例正在执行/验证时不能重跑（后端同样会拒绝）
        const caseActive = item ? ['preparing', 'running', 'verifying'].includes(item.status) : true;
        const rerunDisabled = !run || run.status === 'running' || caseActive;
        const html = `
        <div class="ctx-menu case-menu${dark}" style="left:${menu.left}px;top:${menu.top}px">
            ${entry('case-menu-jump-run', this._t('benchmark.caseMenu.jumpRunTask'), '<path d="M3 5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H6l-3 2.5V5Z"/>', !item?.runTaskId)}
            ${entry('case-menu-jump-verify', this._t('benchmark.caseMenu.jumpVerifyTask'), '<circle cx="5.3" cy="5.3" r="3.3"/><path d="M7.9 7.9 10.6 10.6"/>', !item?.verifyTaskId)}
            <div class="ctx-sep"></div>
            ${entry('case-menu-rerun', this._t('benchmark.caseMenu.rerun'), '<path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M13 2v3h-3"/>', rerunDisabled)}
        </div>`;
        root.querySelector('.case-menu')?.remove();
        const holder = document.createElement('div');
        holder.innerHTML = html;
        const element = holder.firstElementChild as HTMLElement | null;
        if (element) root.querySelector('.app')?.appendChild(element);
    }

    private closeCaseMenu(): void {
        this.caseMenu = null;
        this.shadowRoot?.querySelector('.case-menu')?.remove();
    }

    private renderCaseTable(run: RunRecord): string {
        const running = run.summary.running;
        return `
        <div class="panel case-table-wrap">
            <div class="case-table-head">
                <div class="panel-title" style="margin:0">${escapeHtml(this._t('benchmark.detail.cases'))}</div>
                <span class="status-pill running" data-running-pill ${running > 0 ? '' : 'hidden'}>
                    <span class="dot"></span>${escapeHtml(this._t('benchmark.detail.runningNow', { count: running }))}
                </span>
            </div>
            <table class="case-table">
                <colgroup>
                    <col style="width:46%"><col style="width:14%"><col style="width:15%"><col style="width:17%"><col style="width:8%">
                </colgroup>
                <thead>
                    <tr>
                        <th>${escapeHtml(this._t('benchmark.table.case'))}</th>
                        <th>${escapeHtml(this._t('benchmark.table.track'))}</th>
                        <th>${escapeHtml(this._t('benchmark.table.status'))}</th>
                        <th>${escapeHtml(this._t('benchmark.table.score'))}</th>
                        <th>${escapeHtml(this._t('benchmark.table.duration'))}</th>
                    </tr>
                </thead>
                <tbody data-case-body>
                    ${run.cases
                        .map(
                            (item) =>
                                this.renderCaseRow(item) +
                                (this.expandedCases.has(item.key) ? this.renderCaseDetailRow(item) : '')
                        )
                        .join('')}
                </tbody>
            </table>
        </div>`;
    }

    /* 明细行定点更新：不重建 tr，滚动位置/hover/焦点都不受影响 */
    private patchCaseRow(row: HTMLElement, item: CaseRunState) {
        const statusKey = CASE_STATUS_KEYS[item.status] || 'benchmark.caseStatus.pending';
        const pill = row.querySelector('.status-pill') as HTMLElement | null;
        if (pill) {
            const className = `status-pill ${item.status}`;
            if (pill.className !== className) pill.className = className;
            const html = `<span class="dot"></span>${escapeHtml(this._t(statusKey))}`;
            if (pill.innerHTML !== html) pill.innerHTML = html;
        }
        const bar = row.querySelector('.case-score-bar > span') as HTMLElement | null;
        if (bar) {
            const width = Math.round((item.ratio ?? 0) * 100);
            const style = `width:${width}%`;
            if (bar.getAttribute('style') !== style) bar.setAttribute('style', style);
        }
        const scoreText = row.querySelector('.case-score-text') as HTMLElement | null;
        if (scoreText) {
            const text = item.status === 'done' ? (item.score?.toFixed(2) ?? '-') : '-';
            if (scoreText.textContent !== text) scoreText.textContent = text;
        }
        const detailRow = row.nextElementSibling as HTMLElement | null;
        if (detailRow?.classList.contains('case-detail')) {
            detailRow.outerHTML = this.renderCaseDetailRow(item);
        }
        const nameWrap = row.querySelector('.case-name') as HTMLElement | null;
        if (nameWrap) {
            const note = item.error || item.reason;
            let noteEl = nameWrap.querySelector('.case-name-sub') as HTMLElement | null;
            if (!note) {
                noteEl?.remove();
            } else {
                if (!noteEl) {
                    noteEl = document.createElement('span');
                    nameWrap.appendChild(noteEl);
                }
                const className = `case-name-sub${item.error ? ' error' : ''}`;
                if (noteEl.className !== className) noteEl.className = className;
                if (noteEl.textContent !== note) noteEl.textContent = note;
                if (noteEl.title !== note) noteEl.title = note;
            }
        }
    }

    private renderCaseRow(item: CaseRunState): string {
        const statusKey = CASE_STATUS_KEYS[item.status] || 'benchmark.caseStatus.pending';
        const scoreRatio = item.ratio ?? 0;
        const scoreText = item.status === 'done' ? (item.score?.toFixed(2) ?? '-') : '-';
        const note = item.error || item.reason;
        const duration = item.startedAt ? formatDuration((item.finishedAt ?? Date.now()) - item.startedAt) : '-';
        const noteClass = item.error ? 'case-name-sub error' : 'case-name-sub';
        return `
        <tr data-case-key="${escapeHtml(item.key)}" data-action="toggle-case" tabindex="-1">
            <td>
                <div class="case-name">
                    <span class="case-name-text" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
                    ${note ? `<span class="${noteClass}" title="${escapeHtml(note)}">${escapeHtml(note)}</span>` : ''}
                </div>
            </td>
            <td>${escapeHtml(item.trackName)}</td>
            <td><span class="status-pill ${escapeHtml(item.status)}"><span class="dot"></span>${escapeHtml(this._t(statusKey))}</span></td>
            <td>
                <div class="case-score">
                    <span class="case-score-bar"><span style="width:${Math.round(scoreRatio * 100)}%"></span></span>
                    <span class="case-score-text">${escapeHtml(scoreText)}</span>
                </div>
            </td>
            <td data-duration-key="${escapeHtml(item.key)}">${escapeHtml(duration)}</td>
        </tr>`;
    }

    // ── 弹窗 ──────────────────────────────────────────────────────────────

    private renderDatasetModal(): string {
        if (!this.datasetModalId) return '';
        const dataset = this.datasets.find((item) => item.id === this.datasetModalId);
        if (!dataset) return '';
        const colors = colorFor(dataset.name);
        const initial = dataset.name.trim().charAt(0) || 'B';
        const version = this.datasetVersionLabel(dataset.version);
        const homepageSection = dataset.homepage
            ? `
                    <div class="section-label">${escapeHtml(this._t('benchmark.datasets.homepage'))}</div>
                    <div class="dataset-homepage">
                        <button type="button" class="homepage-link" data-action="open-url" data-url="${escapeHtml(dataset.homepage)}">${escapeHtml(dataset.homepage)}</button>
                    </div>`
            : '';
        const tracks = dataset.tracks
            .map(
                (track) => `
                <div class="track-item">
                    <div style="flex:1;min-width:0">
                        <div class="track-item-name">${escapeHtml(track.name)}</div>
                        ${track.description ? `<div class="track-item-desc">${escapeHtml(track.description)}</div>` : ''}
                    </div>
                    <span class="tag-pill tag-blue">${escapeHtml(this._t('benchmark.datasets.cases', { count: track.caseCount }))}</span>
                </div>`
            )
            .join('');

        return `
        <div class="modal-overlay${this.skipModalAnimation ? ' no-anim' : ''}" data-light-dismiss="true">
            <div class="modal-dialog">
                <div class="modal-banner info">
                    <div class="modal-banner-icon" style="background:${colors.text}">${escapeHtml(initial)}</div>
                    <div class="modal-banner-text">
                        <h3 class="modal-banner-title">${escapeHtml(dataset.name)}</h3>
                        <div class="modal-banner-sub">
                            ${escapeHtml(this._t('benchmark.datasets.tracks', { count: dataset.tracks.length }))} ·
                            ${escapeHtml(this._t('benchmark.datasets.cases', { count: dataset.caseCount }))} ·
                            ${version ? `${escapeHtml(version)} · ` : ''}
                            ${escapeHtml(this._t('benchmark.datasets.importedAt', { time: formatTime(dataset.importedAt) }))}
                        </div>
                    </div>
                    <button type="button" class="modal-close" data-action="close-dataset">✕</button>
                </div>
                <div class="modal-body">
                    ${dataset.description ? `<div style="margin-bottom:16px">${escapeHtml(dataset.description)}</div>` : ''}
                    ${homepageSection}
                    <div class="section-label">${escapeHtml(this._t('benchmark.dataset.tracks'))}</div>
                    <div class="track-list">${tracks}</div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-sm btn-danger" data-action="delete-dataset" data-dataset-id="${escapeHtml(dataset.id)}" data-dataset-name="${escapeHtml(dataset.name)}">
                        ${escapeHtml(this._t('benchmark.action.delete'))}
                    </button>
                    <span class="spacer"></span>
                    <button type="button" class="btn" data-action="close-dataset">${escapeHtml(this._t('benchmark.action.close'))}</button>
                    <button type="button" class="btn btn-primary" data-action="run-dataset" data-dataset-id="${escapeHtml(dataset.id)}">
                        ${escapeHtml(this._t('benchmark.action.run'))}
                    </button>
                </div>
            </div>
        </div>`;
    }

    private renderCatalogModal(): string {
        const catalogId = this.catalogModalId;
        if (!catalogId) return '';
        const entry = this.catalog.find((item) => item.id === catalogId);
        if (!entry) return '';
        const colors = colorFor(entry.name);
        const initial = entry.name.trim().charAt(0) || 'B';
        const local = findLocalDatasetByName(this.datasets, entry.name);
        const installState = resolveCatalogInstallState(entry, this.datasets);
        const state = this.downloads.get(catalogId);
        const busy = state?.status === 'downloading' || state?.status === 'installing';
        const pill = this.catalogStatusView(entry);
        // 本地 meta 可能没写版本号（dataset.json 里 version 可省略），这时不摆一个空的「本地版本 v」
        const localVersionSuffix = local?.version.trim()
            ? ` · ${escapeHtml(this._t('benchmark.catalog.installedVersion', { version: local.version.trim() }))}`
            : '';

        const homepageSection = entry.homepage
            ? `
                    <div class="section-label">${escapeHtml(this._t('benchmark.datasets.homepage'))}</div>
                    <div class="dataset-homepage">
                        <button type="button" class="homepage-link" data-action="open-url" data-url="${escapeHtml(entry.homepage)}">${escapeHtml(entry.homepage)}</button>
                    </div>`
            : '';

        const tracks = entry.tracks
            .map((track) => {
                // 已安装过才能知道用例数，未下载时只展示 track 说明
                const installedTrack = local?.tracks.find(
                    (item) => item.id === (track.id ?? track.name) || item.name === track.name
                );
                return `
                <div class="track-item">
                    <div style="flex:1;min-width:0">
                        <div class="track-item-name">${escapeHtml(track.name)}</div>
                        ${track.description ? `<div class="track-item-desc">${escapeHtml(track.description)}</div>` : ''}
                    </div>
                    ${
                        installedTrack
                            ? `<span class="tag-pill tag-blue">${escapeHtml(this._t('benchmark.datasets.cases', { count: installedTrack.caseCount }))}</span>`
                            : ''
                    }
                </div>`;
            })
            .join('');

        let primaryButton: string;
        if (busy) {
            const label =
                state?.status === 'installing'
                    ? this._t('benchmark.catalog.installing')
                    : this._t('benchmark.catalog.downloadingNoTotal');
            primaryButton = `<button type="button" class="btn btn-primary" disabled>${escapeHtml(label)}</button>`;
        } else if (installState === 'installed') {
            primaryButton = `<button type="button" class="btn" disabled>${escapeHtml(this._t('benchmark.catalog.installed'))}</button>`;
        } else {
            const label =
                installState === 'update-available'
                    ? this._t('benchmark.action.update')
                    : this._t('benchmark.action.download');
            primaryButton = `<button type="button" class="btn btn-primary" data-action="download-dataset" data-catalog-id="${escapeHtml(entry.id)}">${escapeHtml(label)}</button>`;
        }

        return `
        <div class="modal-overlay${this.skipModalAnimation ? ' no-anim' : ''}" data-light-dismiss="true">
            <div class="modal-dialog">
                <div class="modal-banner info">
                    <div class="modal-banner-icon" style="background:${colors.text}">${escapeHtml(initial)}</div>
                    <div class="modal-banner-text">
                        <h3 class="modal-banner-title">${escapeHtml(entry.name)}</h3>
                        <div class="modal-banner-sub">
                            ${escapeHtml(this._t('benchmark.datasets.tracks', { count: entry.tracks.length }))} ·
                            ${escapeHtml(this._t('benchmark.catalog.version', { version: entry.version }))}${localVersionSuffix}
                        </div>
                    </div>
                    <span class="status-pill ${pill.className}" data-catalog-status="${escapeHtml(entry.id)}">${escapeHtml(pill.label)}</span>
                    <button type="button" class="modal-close" data-action="close-catalog">✕</button>
                </div>
                <div class="modal-body">
                    ${entry.description ? `<div style="margin-bottom:16px">${escapeHtml(entry.description)}</div>` : ''}
                    ${homepageSection}
                    ${this.renderDownloadProgress(state)}
                    <div class="section-label">${escapeHtml(this._t('benchmark.dataset.tracks'))}</div>
                    <div class="track-list">${tracks}</div>
                </div>
                <div class="modal-footer">
                    <span class="spacer"></span>
                    <button type="button" class="btn" data-action="close-catalog">${escapeHtml(this._t('benchmark.action.close'))}</button>
                    ${primaryButton}
                </div>
            </div>
        </div>`;
    }

    /** 下载进度条：只渲染当前状态，进度刷新走 patchDownloadProgress 定点更新 */
    private renderDownloadProgress(state: DownloadState | undefined): string {
        if (!state) return '';
        if (state.status === 'failed') {
            return `<div class="modal-error">${escapeHtml(
                this._t('benchmark.catalog.downloadError', { message: state.error || this._t('error.operationFailed') })
            )}</div>`;
        }
        if (state.status !== 'downloading' && state.status !== 'installing') return '';
        const view = this.downloadProgressView(state);
        return `
        <div class="dl-progress" data-dl-progress>
            <div class="dl-progress-head">
                <span data-dl-title>${escapeHtml(view.title)}</span>
                <span data-dl-detail>${escapeHtml(view.detail)}</span>
            </div>
            <div class="dl-progress-bar${view.ratio === null ? ' indeterminate' : ''}">
                <span data-dl-bar style="width:${view.ratio === null ? 100 : Math.round(view.ratio * 100)}%"></span>
            </div>
        </div>`;
    }

    private downloadProgressView(state: DownloadState): { title: string; detail: string; ratio: number | null } {
        if (state.status === 'installing') {
            return {
                title: this._t('benchmark.catalog.installing'),
                detail: state.totalBytes ? formatBytes(state.totalBytes) : '',
                ratio: 1
            };
        }
        const ratio =
            state.totalBytes && state.totalBytes > 0 ? Math.min(1, state.receivedBytes / state.totalBytes) : null;
        return {
            title:
                ratio === null
                    ? this._t('benchmark.catalog.downloadingNoTotal')
                    : this._t('benchmark.catalog.downloading', { percent: Math.round(ratio * 100) }),
            detail: state.totalBytes
                ? this._t('benchmark.catalog.progressDetail', {
                      received: formatBytes(state.receivedBytes),
                      total: formatBytes(state.totalBytes)
                  })
                : formatBytes(state.receivedBytes),
            ratio
        };
    }

    /** 下载进行中的定点刷新：不重建弹窗，按钮/滚动/hover 都不受影响 */
    private patchDownloadProgress(): void {
        this.patchCatalogStatusPills();
        const root = this.shadowRoot;
        const catalogId = this.catalogModalId;
        if (!root || !catalogId) return;
        const state = this.downloads.get(catalogId);
        if (!state) return;

        const view = this.downloadProgressView(state);
        const title = root.querySelector('[data-dl-title]') as HTMLElement | null;
        if (title && title.textContent !== view.title) title.textContent = view.title;
        const detail = root.querySelector('[data-dl-detail]') as HTMLElement | null;
        if (detail && detail.textContent !== view.detail) detail.textContent = view.detail;
        const bar = root.querySelector('[data-dl-bar]') as HTMLElement | null;
        if (!bar) return;
        // 拿到 content-length 后必须退掉漂移动画，否则动画的 width/transform 会盖掉真实百分比
        const track = bar.parentElement;
        if (track) {
            const indeterminate = view.ratio === null;
            if (track.classList.contains('indeterminate') !== indeterminate) {
                track.classList.toggle('indeterminate', indeterminate);
            }
        }
        const width = `${view.ratio === null ? 100 : Math.round(view.ratio * 100)}%`;
        if (bar.style.width !== width) bar.style.width = width;
    }

    /** 清单项状态标签（卡片和弹窗共用）的定点更新 */
    private patchCatalogStatusPills(): void {
        const root = this.shadowRoot;
        if (!root) return;
        root.querySelectorAll<HTMLElement>('[data-catalog-status]').forEach((element) => {
            const entry = this.catalog.find((item) => item.id === element.dataset.catalogStatus);
            if (!entry) return;
            const view = this.catalogStatusView(entry);
            const className = `status-pill ${view.className}`;
            if (element.className !== className) element.className = className;
            if (element.textContent !== view.label) element.textContent = view.label;
        });
    }

    private renderRunModal(): string {
        const modal = this.runModal;
        if (!modal) return '';
        const disabled = modal.busy || this.models.length === 0;
        return `
        <div class="modal-overlay${this.skipModalAnimation ? ' no-anim' : ''}" data-light-dismiss="false">
            <div class="modal-dialog">
                <div class="modal-banner info">
                    <div class="modal-banner-icon">▶</div>
                    <div class="modal-banner-text">
                        <h3 class="modal-banner-title">${escapeHtml(this._t('benchmark.run.title'))}</h3>
                        <div class="modal-banner-sub">
                            ${escapeHtml(modal.datasetName)} · ${escapeHtml(this._t('benchmark.datasets.cases', { count: modal.caseCount }))}
                        </div>
                    </div>
                    <button type="button" class="modal-close" data-action="run-cancel">✕</button>
                </div>
                <div class="modal-body">
                    <div class="form-field">
                        <span class="form-label">${escapeHtml(this._t('benchmark.run.tracks'))}</span>
                        <div class="card-meta">
                            ${modal.tracks
                                .map(
                                    (track) =>
                                        `<button type="button" class="chip-toggle ${modal.selectedTracks.includes(track.id) ? 'active' : ''}" data-action="toggle-track" data-track-id="${escapeHtml(track.id)}" ${modal.busy ? 'disabled' : ''}>${escapeHtml(track.name)} · ${track.caseCount}</button>`
                                )
                                .join('')}
                        </div>
                    </div>
                    <div class="form-field">
                        <label class="form-label" for="benchmark-concurrency">${escapeHtml(this._t('benchmark.run.concurrency'))}</label>
                        <input id="benchmark-concurrency" class="form-input" type="number" min="1" max="20" step="1" value="${modal.concurrency}" ${modal.busy ? 'disabled' : ''}>
                    </div>
                    <div class="form-row-2 model-timeout-row">
                        <div class="form-field" style="margin-bottom:0">
                            <span class="form-label">${escapeHtml(this._t('benchmark.run.testModel'))}</span>
                            ${this.renderModelPicker('run', modal.runModel, modal.runModelEffort, modal.busy)}
                        </div>
                        <div class="form-field" style="margin-bottom:0">
                            <label class="form-label" for="benchmark-run-timeout">${escapeHtml(this._t('benchmark.run.runTimeout'))}</label>
                            <input id="benchmark-run-timeout" class="form-input" type="number" min="30" step="30"
                                placeholder="${escapeHtml(this._t('benchmark.run.timeoutPlaceholderShort'))}"
                                title="${escapeHtml(this._t('benchmark.run.timeoutPlaceholder'))}"
                                value="${escapeHtml(modal.runTimeout)}" ${modal.busy ? 'disabled' : ''}>
                        </div>
                    </div>
                    <div class="form-row-2 model-timeout-row">
                        <div class="form-field" style="margin-bottom:0">
                            <span class="form-label">${escapeHtml(this._t('benchmark.run.verifyModel'))}</span>
                            ${this.renderModelPicker('verify', modal.verifyModel, modal.verifyModelEffort, modal.busy)}
                        </div>
                        <div class="form-field" style="margin-bottom:0">
                            <label class="form-label" for="benchmark-verify-timeout">${escapeHtml(this._t('benchmark.run.verifyTimeout'))}</label>
                            <input id="benchmark-verify-timeout" class="form-input" type="number" min="30" step="30"
                                placeholder="${escapeHtml(this._t('benchmark.run.timeoutPlaceholderShort'))}"
                                title="${escapeHtml(this._t('benchmark.run.timeoutPlaceholder'))}"
                                value="${escapeHtml(modal.verifyTimeout)}" ${modal.busy ? 'disabled' : ''}>
                        </div>
                    </div>
                    ${modal.error ? `<div class="modal-error">${escapeHtml(modal.error)}</div>` : ''}
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn" data-action="run-cancel" ${modal.busy ? 'disabled' : ''}>${escapeHtml(this._t('benchmark.action.cancel'))}</button>
                    <button type="button" class="btn btn-primary" data-action="run-start" ${disabled ? 'disabled' : ''}>
                        ${escapeHtml(modal.busy ? this._t('benchmark.run.starting') : this._t('benchmark.action.start'))}
                    </button>
                </div>
            </div>
        </div>`;
    }

    // ── 模型选择器（复用 agentinput 的模型面板视觉与交互） ────────────────

    private modelIconTile(vision = false): string {
        const svgPath = vision
            ? '<path d="M1.5 8S3.5 4.5 8 4.5s6.5 3.5 6.5 3.5-2 3.5-6.5 3.5S1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="2"/>'
            : '<path d="M3 5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H6l-3 2.5V5Z"/>';
        return `<span class="agent-icon-tile ${vision ? 'model-vision' : 'model-chat'}"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${svgPath}</svg></span>`;
    }

    private effortLabel(value: string): string {
        return labelForStoredReasoningEffort(value || '', (key) =>
            createRendererTranslator(this._settingForLocale)(key)
        );
    }

    private effortValuesFor(alias: string): string[] {
        const model = this.models.find((item) => item.alias === alias);
        const efforts = model?.efforts?.length ? model.efforts : REASONING_EFFORT_UI_OPTIONS.map((item) => item.value);
        return efforts;
    }

    private renderModelPicker(picker: 'run' | 'verify', alias: string, effort: string, busy: boolean): string {
        const label = alias ? alias : this._t('benchmark.run.modelPlaceholder');
        return `
        <div class="model-picker">
            <button type="button" class="model-trigger" data-action="toggle-model-panel" data-picker="${picker}" ${busy ? 'disabled' : ''}>
                ${this.modelIconTile(this.models.find((item) => item.alias === alias)?.vision ?? false)}
                <span class="model-trigger-alias">${escapeHtml(label)}</span>
                <span class="model-effort-chip">${effortIconSvg(effort)}${escapeHtml(this.effortLabel(effort))}</span>
                <span class="model-trigger-caret">▾</span>
            </button>
        </div>`;
    }

    private renderModelPanel(): string {
        const panel = this.modelPanel;
        if (!panel || !this.runModal) return '';
        const selectedAlias = panel.picker === 'run' ? this.runModal.runModel : this.runModal.verifyModel;
        const items = this.models
            .map((model) => {
                const active = model.alias === selectedAlias;
                return `
                <button type="button" class="ctx-item model-panel-item ${active ? 'active' : ''}"
                    data-action="pick-model" data-picker="${panel.picker}" data-alias="${escapeHtml(model.alias)}">
                    ${this.modelIconTile(model.vision)}
                    <span class="ctx-label">${escapeHtml(model.alias)}</span>
                    ${model.vision ? `<span class="ctx-badge blue">${escapeHtml(this._t('benchmark.run.modelVision'))}</span>` : ''}
                    ${model.isDefault ? `<span class="ctx-badge">${escapeHtml(this._t('benchmark.run.modelDefault'))}</span>` : ''}
                    ${active ? '<span class="ctx-item-check">✓</span>' : ''}
                    <span class="ctx-arrow">›</span>
                </button>`;
            })
            .join('');
        const dark = this.dataset.theme === 'dark' ? ' ctx-menu-dark' : '';
        return `
        <div class="model-panel ctx-menu${dark}" data-picker="${panel.picker}" style="left:${panel.left}px;top:${panel.top}px">
            <div class="ctx-search">
                <span class="ctx-search-icon">⌕</span>
                <input class="model-search" type="text" placeholder="${escapeHtml(this._t('benchmark.run.modelSearch'))}">
            </div>
            <div class="ctx-menu-list">${items || `<div class="ctx-empty">${escapeHtml(this._t('benchmark.run.modelEmpty'))}</div>`}</div>
        </div>`;
    }

    private effortMenuItemsHtml(): string {
        const menu = this.effortMenu;
        if (!menu || !this.runModal) return '';
        const selected = menu.picker === 'run' ? this.runModal.runModelEffort : this.runModal.verifyModelEffort;
        return this.effortValuesFor(menu.alias)
            .map((value) => {
                const active = value === (selected || '');
                return `
                <button type="button" class="ctx-item effort-item ${active ? 'active' : ''}"
                    data-action="pick-effort" data-picker="${menu.picker}" data-alias="${escapeHtml(menu.alias)}" data-effort="${escapeHtml(value)}">
                    ${effortIconSvg(value)}
                    <span class="ctx-label">${escapeHtml(this.effortLabel(value))}</span>
                    ${active ? '<span class="ctx-item-check">✓</span>' : ''}
                </button>`;
            })
            .join('');
    }

    private refreshEffortMenu(): void {
        const root = this.shadowRoot;
        if (!root) return;
        let element = root.querySelector('.effort-submenu') as HTMLElement | null;
        if (!this.effortMenu) {
            element?.remove();
            return;
        }
        if (!element) {
            element = document.createElement('div');
            element.className = 'effort-submenu ctx-menu';
            root.querySelector('.app')?.appendChild(element);
        }
        element.classList.toggle('ctx-menu-dark', this.dataset.theme === 'dark');
        element.style.left = `${this.effortMenu.left}px`;
        element.style.top = `${this.effortMenu.top}px`;
        element.innerHTML = this.effortMenuItemsHtml();
    }
}

customElements.define('benchmark-entry-widget', BenchmarkEntryWidget);
