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

import { escapeHtml } from '../../../../common/utils/escape.js';
import { createRendererTranslator } from '../../../../renderer/locale.js';
import { OPENDESK_THEME_CHANGED } from '../../../../renderer/theme/theme-iframe-bridge.js';
import { syncShadowHostTheme } from '../../../../renderer/theme/theme-shadow-overrides.js';
import adminPanelCss from './admin-panel.css?inline';

/**
 * 管理后台数据接口。原先由 preload 以 window.adminAPI 暴露全局 IPC，
 * 改为应用后统一经 applicationAPI.callMainWorld 走 adminconsole 应用的方法，
 * 应用方法返回 { status, code, data, message }，这里还原成抛错语义供 UI 使用。
 */
interface AdminApi {
    getServerUrl(): Promise<string>;
    loadToken(serverUrl: string): Promise<{ token: string | null; canPersist: boolean }>;
    verifyToken(serverUrl: string, token: string): Promise<true>;
    clearToken(): Promise<true>;
    getDailyStats(days: number): Promise<unknown>;
    getSummaryStats(): Promise<unknown>;
    getFeedbackList(limit: number): Promise<unknown>;
    downloadAttachment(attachmentId: number, filename: string): Promise<{ canceled?: boolean; filePath?: string }>;
}

function unwrapAdminResult(result: any): any {
    if (result && result.status !== 'ok') {
        const error: any = new Error(result.message ?? 'admin request failed');
        error.code = result.code;
        throw error;
    }
    return result?.data;
}

function createAdminApi(): AdminApi | null {
    const call = (window as any).applicationAPI?.callMainWorld;
    if (typeof call !== 'function') return null;
    return {
        getServerUrl: async () => unwrapAdminResult(await call('getServerUrl')),
        loadToken: async (serverUrl) => unwrapAdminResult(await call('loadToken', serverUrl)),
        verifyToken: async (serverUrl, token) => (unwrapAdminResult(await call('verifyToken', serverUrl, token)), true),
        clearToken: async () => (unwrapAdminResult(await call('clearToken')), true),
        getDailyStats: async (days) => unwrapAdminResult(await call('getDailyStats', days)),
        getSummaryStats: async () => unwrapAdminResult(await call('getSummaryStats')),
        getFeedbackList: async (limit) => unwrapAdminResult(await call('getFeedbackList', limit)),
        downloadAttachment: async (attachmentId, filename) =>
            unwrapAdminResult(await call('downloadAttachment', attachmentId, filename))
    };
}

/** 生产服务默认地址（授权页服务器输入框的占位提示） */
const DEFAULT_ADMIN_SERVER_URL = 'https://opendesk.matrix.openharmony.cn';

interface AdminDailyPoint {
    day: string;
    devices: number;
    by_type: Record<string, number>;
}

interface AdminDailyStats {
    ok: true;
    days: number;
    range: { start: string; end: string; today_start: string };
    points: AdminDailyPoint[];
}

interface AdminSummaryStats {
    ok: true;
    total: { devices: number; by_type: Record<string, number> };
    last_1d: { devices: number; by_type: Record<string, number> };
    last_7d: { devices: number; by_type: Record<string, number> };
}

interface AdminFeedbackItem {
    id: number;
    type: 'feature' | 'bug';
    content: string;
    contact: string | null;
    time: string;
    attachments: Array<{ attachment_id: number; filename: string }>;
}

interface AdminFeedbackList {
    ok: true;
    items: AdminFeedbackItem[];
}

function compactNumber(value: number): string {
    if (!Number.isFinite(value) || value <= 0) {
        return '0';
    }
    if (value < 1000) {
        return new Intl.NumberFormat().format(Math.floor(value));
    }
    return new Intl.NumberFormat(undefined, {
        notation: 'compact',
        maximumFractionDigits: value < 10_000 ? 1 : 0
    }).format(Math.floor(value));
}

function formatDayLabel(day: string): string {
    const [, month, date] = day.split('-');
    return month && date ? `${month}/${date}` : day;
}

function formatDateTime(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Generate a smooth SVG path through the given points using Catmull-Rom splines. */
function smoothPath(points: { x: number; y: number }[]): string {
    if (points.length === 0) {
        return '';
    }
    if (points.length === 1) {
        return `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
    }

    const tension = 1 / 6;
    let path = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;

    for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[i - 1] || points[i];
        const p1 = points[i];
        const p2 = points[i + 1];
        const p3 = points[i + 2] || p2;

        const cp1x = p1.x + (p2.x - p0.x) * tension;
        const cp1y = p1.y + (p2.y - p0.y) * tension;
        const cp2x = p2.x - (p3.x - p1.x) * tension;
        const cp2y = p2.y - (p3.y - p1.y) * tension;

        path += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
    }

    return path;
}

export class AdminConsoleEntryWidget extends HTMLElement {
    private readonly root: ShadowRoot;
    private activeTab: 'activity' | 'feedback' = 'activity';
    private serverUrl = '';
    private canPersist = true;
    private authorized = false;
    private authBusy = false;
    private authError: string | null = null;
    private activityLoading = false;
    private activityError: string | null = null;
    private dailyStats: AdminDailyStats | null = null;
    private summaryStats: AdminSummaryStats | null = null;
    private feedbackLoading = false;
    private feedbackError: string | null = null;
    private feedbackList: AdminFeedbackList | null = null;
    private feedbackFilter: 'all' | 'feature' | 'bug' = 'all';
    private t = createRendererTranslator();

    constructor() {
        super();
        this.root = this.attachShadow({ mode: 'open' });
        // 趋势图逐日悬浮提示：事件委托绑定一次即可（shadow root 内事件冒泡到根）
        this.root.addEventListener('mouseover', (event) => {
            const hit = (event.target as HTMLElement).closest?.('[data-hit-idx]') as HTMLElement | null;
            if (hit) this.showTrendTip(Number(hit.dataset.hitIdx));
        });
        this.root.addEventListener('mouseout', (event) => {
            const hit = (event.target as HTMLElement).closest?.('[data-hit-idx]');
            if (hit) this.hideTrendTip();
        });
    }

    connectedCallback(): void {
        syncShadowHostTheme(this);
        document.addEventListener(OPENDESK_THEME_CHANGED, this.onThemeChanged);
        this.render();
        void this.initialize();
    }

    disconnectedCallback(): void {
        document.removeEventListener(OPENDESK_THEME_CHANGED, this.onThemeChanged);
    }

    private readonly onThemeChanged = (event: Event): void => {
        const detail = (event as CustomEvent<{ effective?: 'light' | 'dark' }>).detail;
        syncShadowHostTheme(this, detail?.effective);
    };

    private async initialize(): Promise<void> {
        try {
            const api = (window as any).settingAPI;
            if (api?.loadSettingObject) {
                this.t = createRendererTranslator(await api.loadSettingObject());
            }
        } catch {
            // 读取设置失败时沿用默认翻译
        }
        const adminApi = createAdminApi();
        if (!adminApi) {
            this.render();
            return;
        }
        try {
            this.serverUrl = (await adminApi.getServerUrl()) || '';
            const persisted = await adminApi.loadToken(this.serverUrl);
            this.canPersist = persisted?.canPersist !== false;
            if (persisted?.token) {
                // 有历史授权：先渲染，再拉数据验证令牌是否仍有效
                this.authorized = true;
                this.render();
                void this.loadActiveTabData();
                return;
            }
        } catch (error: any) {
            this.authError = error?.message ?? String(error);
        }
        this.render();
    }

    private async verifyToken(token: string): Promise<void> {
        const adminApi = createAdminApi();
        if (!adminApi) return;
        this.authBusy = true;
        this.authError = null;
        this.render();
        try {
            await adminApi.verifyToken(this.serverUrl, token);
            this.authorized = true;
            this.authBusy = false;
            this.render();
            void this.loadActiveTabData();
        } catch (error: any) {
            this.authBusy = false;
            this.authError =
                error.code === 'unauthorized'
                    ? this.t('renderer.admin.authUnauthorized')
                    : this.t('renderer.admin.authFailed', { message: error.message });
            this.render();
        }
    }

    private async logout(): Promise<void> {
        const adminApi = createAdminApi();
        if (!adminApi) return;
        try {
            await adminApi.clearToken();
        } catch {
            // 清除失败也不阻碍回到授权页
        }
        this.authorized = false;
        this.dailyStats = null;
        this.summaryStats = null;
        this.feedbackList = null;
        this.activityError = null;
        this.feedbackError = null;
        this.render();
    }

    private async loadActiveTabData(): Promise<void> {
        if (this.activeTab === 'activity') {
            await this.loadActivity();
        } else {
            await this.loadFeedback();
        }
    }

    private async loadActivity(): Promise<void> {
        const adminApi = createAdminApi();
        if (!adminApi) return;
        this.activityLoading = true;
        this.activityError = null;
        this.render();
        try {
            const [daily, summary] = await Promise.all([adminApi.getDailyStats(7), adminApi.getSummaryStats()]);
            this.dailyStats = daily;
            this.summaryStats = summary;
            this.activityLoading = false;
        } catch (error: any) {
            this.activityLoading = false;
            if (error.code === 'unauthorized') {
                this.authorized = false;
            } else {
                this.activityError = this.t('renderer.admin.loadFailed', { message: error.message });
            }
        }
        this.render();
    }

    private async loadFeedback(): Promise<void> {
        const adminApi = createAdminApi();
        if (!adminApi) return;
        this.feedbackLoading = true;
        this.feedbackError = null;
        this.render();
        try {
            this.feedbackList = await adminApi.getFeedbackList(100);
            this.feedbackLoading = false;
        } catch (error: any) {
            this.feedbackLoading = false;
            if (error.code === 'unauthorized') {
                this.authorized = false;
            } else {
                this.feedbackError = this.t('renderer.admin.loadFailed', { message: error.message });
            }
        }
        this.render();
    }

    private async downloadAttachment(attachmentId: number, filename: string): Promise<void> {
        const adminApi = createAdminApi();
        if (!adminApi?.downloadAttachment) return;
        try {
            const result = await adminApi.downloadAttachment(attachmentId, filename);
            if (result && result.filePath) {
                this.showToast(this.t('renderer.admin.attachmentSaved', { path: result.filePath }));
            }
        } catch (error: any) {
            this.showToast(this.t('renderer.admin.loadFailed', { message: error.message }));
        }
    }

    private toastTimer: ReturnType<typeof setTimeout> | null = null;
    private showToast(message: string): void {
        const toast = this.root.querySelector('.ap-toast');
        if (!toast) return;
        toast.textContent = message;
        toast.classList.add('visible');
        if (this.toastTimer) clearTimeout(this.toastTimer);
        this.toastTimer = setTimeout(() => toast.classList.remove('visible'), 4000);
    }

    private handleAuthSubmit(event: Event): void {
        event.preventDefault();
        const serverInput = this.root.querySelector<HTMLInputElement>('#ap-server-input');
        const serverFromInput = serverInput?.value.trim() ?? '';
        if (serverFromInput) {
            // 非空时做协议校验，避免把无效地址发给 main 再失败
            try {
                const parsed = new URL(serverFromInput);
                if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protocol');
            } catch {
                this.authError = this.t('renderer.admin.serverInvalid');
                this.render();
                return;
            }
            this.serverUrl = serverFromInput.replace(/\/+$/, '');
        }
        const input = this.root.querySelector<HTMLInputElement>('#ap-token-input');
        const token = input?.value.trim() ?? '';
        if (!token) {
            this.authError = this.t('renderer.admin.tokenRequired');
            this.render();
            return;
        }
        void this.verifyToken(token);
    }

    private bindEvents(): void {
        this.root.querySelectorAll('[data-tab]').forEach((element) => {
            element.addEventListener('click', () => {
                const tab = (element as HTMLElement).dataset.tab as 'activity' | 'feedback';
                if (tab === this.activeTab) return;
                this.activeTab = tab;
                this.render();
                void this.loadActiveTabData();
            });
        });
        const authForm = this.root.querySelector('#ap-auth-form');
        authForm?.addEventListener('submit', (event) => this.handleAuthSubmit(event));
        this.root.querySelector('[data-action="refresh"]')?.addEventListener('click', () => {
            void this.loadActiveTabData();
        });
        this.root.querySelector('[data-action="logout"]')?.addEventListener('click', () => {
            void this.logout();
        });
        this.root.querySelector('[data-action="reload-activity"]')?.addEventListener('click', () => {
            void this.loadActivity();
        });
        this.root.querySelector('[data-action="reload-feedback"]')?.addEventListener('click', () => {
            void this.loadFeedback();
        });
        this.root.querySelectorAll('[data-filter]').forEach((element) => {
            element.addEventListener('click', () => {
                const filter = (element as HTMLElement).dataset.filter as 'all' | 'feature' | 'bug';
                if (filter === this.feedbackFilter) return;
                this.feedbackFilter = filter;
                this.render();
            });
        });
        this.root.querySelectorAll('[data-attachment]').forEach((element) => {
            element.addEventListener('click', () => {
                const el = element as HTMLElement;
                void this.downloadAttachment(Number(el.dataset.attachment), el.dataset.filename || 'attachment');
            });
        });
    }

    private render(): void {
        if (!this.authorized) {
            this.renderAuth();
            return;
        }
        this.root.innerHTML = `
            <style>${adminPanelCss}</style>
            <div class="ap-root">
                <div class="ap-tabs">
                    <div class="ap-tab-group">
                        ${this.tabButton('activity', this.t('renderer.admin.tabActivity'))}
                        ${this.tabButton('feedback', this.t('renderer.admin.tabFeedback'))}
                    </div>
                    <div class="ap-tabs-actions">
                        <span class="ap-server" title="${escapeHtml(this.serverUrl)}">${escapeHtml(this.serverUrl)}</span>
                        <button class="ap-icon-btn" data-action="refresh" type="button" title="${escapeHtml(this.t('renderer.admin.refresh'))}">${AP_ICONS.refresh}</button>
                        <button class="ap-icon-btn" data-action="logout" type="button" title="${escapeHtml(this.t('renderer.admin.logout'))}">${AP_ICONS.logout}</button>
                    </div>
                </div>
                <div class="ap-body">${this.activeTab === 'activity' ? this.renderActivity() : this.renderFeedback()}</div>
                <div class="ap-toast" role="status"></div>
            </div>
        `;
        this.bindEvents();
    }

    private renderAuth(): void {
        this.root.innerHTML = `
            <style>${adminPanelCss}</style>
            <div class="ap-root">
                <div class="ap-auth">
                    <div class="ap-auth-icon">${AP_ICONS.shield}</div>
                    <h1>${escapeHtml(this.t('renderer.admin.authTitle'))}</h1>
                    <p class="ap-auth-hint">${escapeHtml(this.t('renderer.admin.authHint'))}</p>
                    <form id="ap-auth-form">
                        <label class="ap-field-label" for="ap-server-input">${escapeHtml(this.t('renderer.admin.serverLabel'))}</label>
                        <input id="ap-server-input" type="text" autocomplete="off" spellcheck="false"
                            value="${escapeHtml(this.serverUrl)}"
                            placeholder="${escapeHtml(DEFAULT_ADMIN_SERVER_URL)}" />
                        <label class="ap-field-label" for="ap-token-input">${escapeHtml(this.t('renderer.admin.tokenPlaceholder'))}</label>
                        <input id="ap-token-input" type="password" autocomplete="off" spellcheck="false"
                            placeholder="${escapeHtml(this.t('renderer.admin.tokenPlaceholder'))}" />
                        ${this.canPersist ? '' : `<p class="ap-auth-warn">${escapeHtml(this.t('renderer.admin.persistUnavailable'))}</p>`}
                        ${this.authError ? `<p class="ap-auth-error">${escapeHtml(this.authError)}</p>` : ''}
                        <button class="ap-primary" type="submit" ${this.authBusy ? 'disabled' : ''}>${escapeHtml(this.authBusy ? this.t('renderer.admin.verifying') : this.t('renderer.admin.verify'))}</button>
                    </form>
                </div>
            </div>
        `;
        this.bindEvents();
        this.root.querySelector<HTMLInputElement>('#ap-token-input')?.focus();
    }

    private tabButton(id: 'activity' | 'feedback', label: string): string {
        return `<button class="ap-tab ${this.activeTab === id ? 'active' : ''}" data-tab="${id}" aria-pressed="${this.activeTab === id}">${escapeHtml(label)}</button>`;
    }

    private renderActivity(): string {
        if (this.activityLoading && !this.dailyStats) {
            return `<div class="ap-status">${escapeHtml(this.t('renderer.admin.loading'))}</div>`;
        }
        if (this.activityError && !this.dailyStats) {
            return `<div class="ap-status ap-error">${escapeHtml(this.activityError)}</div>
                <div class="ap-status-actions"><button class="ap-primary" data-action="reload-activity" type="button">${escapeHtml(this.t('renderer.admin.reload'))}</button></div>`;
        }
        const summary = this.summaryStats;
        const points = this.dailyStats?.points ?? [];
        return `
            ${
                summary
                    ? `<div class="ap-cards">
                ${this.summaryCard(this.t('renderer.admin.totalDevices'), summary.total.devices)}
                ${this.summaryCard(this.t('renderer.admin.weekDevices'), summary.last_7d.devices)}
                ${this.summaryCard(this.t('renderer.admin.dayDevices'), summary.last_1d.devices)}
            </div>`
                    : ''
            }
            <section class="ap-panel">
                <div class="ap-panel-header">
                    <h2>${escapeHtml(this.t('renderer.admin.last7Days'))}</h2>
                    ${this.activityLoading ? `<span class="ap-loading-hint">${escapeHtml(this.t('renderer.admin.loading'))}</span>` : ''}
                </div>
                ${points.length > 0 ? this.renderTrendChart(points) : `<div class="ap-empty">${escapeHtml(this.t('renderer.admin.empty'))}</div>`}
            </section>
        `;
    }

    private summaryCard(label: string, value: number): string {
        return `<div class="ap-card"><div class="ap-card-value">${escapeHtml(compactNumber(value))}</div><div class="ap-card-label">${escapeHtml(label)}</div></div>`;
    }

    /** 当前趋势图的绘图模型，供悬浮提示定位与取数 */
    private chartModel: {
        points: AdminDailyPoint[];
        plotPoints: { x: number; y: number }[];
        width: number;
        height: number;
    } | null = null;

    /** 设备类型 → 调色板槽位（跨天一致）；未知类型走灰槽 */
    private static readonly TYPE_COLOR_SLOTS: Record<string, number> = {
        pc: 0,
        phone: 1,
        mobile: 1,
        tablet: 2,
        unknown: 5
    };

    private typeColorSlot(type: string): number {
        const known = AdminConsoleEntryWidget.TYPE_COLOR_SLOTS[type];
        if (known !== undefined) return known;
        let hash = 0;
        for (let i = 0; i < type.length; i++) hash = (hash * 31 + type.charCodeAt(i)) >>> 0;
        return 3 + (hash % 2);
    }

    private renderTrendChart(points: AdminDailyPoint[]): string {
        const width = 720;
        const height = 220;
        const padding = { top: 16, right: 16, bottom: 28, left: 36 };
        const innerWidth = width - padding.left - padding.right;
        const innerHeight = height - padding.top - padding.bottom;
        const max = Math.max(...points.map((p) => p.devices), 1);
        const stepX = points.length > 1 ? innerWidth / (points.length - 1) : 0;
        const plotPoints = points.map((p, i) => ({
            x: padding.left + (points.length > 1 ? i * stepX : innerWidth / 2),
            y: padding.top + innerHeight - (p.devices / max) * innerHeight
        }));
        this.chartModel = { points, plotPoints, width, height };
        const gridLines = [0, 0.5, 1]
            .map((ratio) => {
                const y = padding.top + innerHeight - ratio * innerHeight;
                const value = Math.round(max * ratio);
                return `<line x1="${padding.left}" y1="${y.toFixed(1)}" x2="${width - padding.right}" y2="${y.toFixed(1)}" class="grid"></line>
                    <text x="${padding.left - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" class="axis-label">${escapeHtml(compactNumber(value))}</text>`;
            })
            .join('');
        const labels = points
            .map(
                (p, i) =>
                    `<text x="${plotPoints[i].x.toFixed(1)}" y="${height - 8}" text-anchor="middle" class="axis-label">${escapeHtml(formatDayLabel(p.day))}</text>`
            )
            .join('');
        const baseline = padding.top + innerHeight;
        const barWidth = 10;
        const halfBar = barWidth / 2;
        // 分段柱：按类型数量占比从基线堆叠到曲线点；类型按数量降序堆叠
        const bars = points
            .map((p, i) => {
                if (p.devices <= 0) return '';
                const segments = Object.entries(p.by_type ?? {})
                    .filter(([, count]) => count > 0)
                    .sort((a, b) => b[1] - a[1]);
                const typeSum = segments.reduce((acc, [, count]) => acc + count, 0);
                if (typeSum <= 0) return '';
                const barHeight = baseline - plotPoints[i].y;
                let cursor = baseline;
                const rects = segments
                    .map(([type, count]) => {
                        const segHeight = Math.max((count / typeSum) * barHeight, 1);
                        const yTop = cursor - segHeight;
                        cursor = yTop;
                        return `<rect x="${(plotPoints[i].x - halfBar).toFixed(1)}" y="${yTop.toFixed(1)}" width="${barWidth}" height="${segHeight.toFixed(1)}" class="bar-seg c${this.typeColorSlot(type)}"></rect>`;
                    })
                    .join('');
                return `<g class="bar">${rects}</g>`;
            })
            .join('');
        // 逐日命中区（含悬浮高亮），宽度取列间距与最小宽度中的较大者
        const hitWidth = Math.max(stepX * 0.86, 32);
        const hits = points
            .map(
                (p, i) =>
                    `<rect class="hit" data-hit-idx="${i}" x="${(plotPoints[i].x - hitWidth / 2).toFixed(1)}" y="${padding.top}" width="${hitWidth.toFixed(1)}" height="${innerHeight}"></rect>`
            )
            .join('');
        const dots = plotPoints
            .map((pt) => `<circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="3.5" class="dot"></circle>`)
            .join('');
        const linePath = smoothPath(plotPoints);
        const areaPath =
            plotPoints.length > 1
                ? `${linePath} L ${plotPoints[plotPoints.length - 1].x.toFixed(2)} ${(padding.top + innerHeight).toFixed(2)} L ${plotPoints[0].x.toFixed(2)} ${(padding.top + innerHeight).toFixed(2)} Z`
                : '';
        return `<div class="trend-wrap">
            <svg class="trend" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet">
                ${gridLines}
                ${bars}
                ${areaPath ? `<path d="${areaPath}" class="area"></path>` : ''}
                <path d="${linePath}" class="line"></path>
                ${dots}
                ${labels}
                ${hits}
            </svg>
            <div class="trend-tip" role="status"></div>
        </div>`;
    }

    private tipRow(label: string, count: number, slot?: number): string {
        const chip = slot !== undefined ? `<i class="chip c${slot}"></i>` : '';
        return `<div class="tip-row">${chip}<span class="tip-label">${escapeHtml(label)}</span><span class="val">${escapeHtml(compactNumber(count))}</span></div>`;
    }

    private showTrendTip(index: number): void {
        const model = this.chartModel;
        const tip = this.root.querySelector('.trend-tip');
        const wrap = this.root.querySelector('.trend-wrap');
        const svg = this.root.querySelector('svg.trend');
        if (!model || !tip || !wrap || !svg) return;
        const point = model.points[index];
        const pt = model.plotPoints[index];
        const types = Object.entries(point.by_type ?? {})
            .filter(([, count]) => count > 0)
            .sort((a, b) => b[1] - a[1]);
        tip.innerHTML = `
            <div class="tip-title">${escapeHtml(point.day)}</div>
            ${this.tipRow(this.t('renderer.admin.tipTotal'), point.devices)}
            ${types.map(([type, count]) => this.tipRow(type, count, this.typeColorSlot(type))).join('')}
        `;
        // viewBox 坐标 → 容器像素坐标（preserveAspectRatio 等比缩放，x/y 缩放系数一致）
        const svgRect = svg.getBoundingClientRect();
        const wrapRect = wrap.getBoundingClientRect();
        const scale = svgRect.width / model.width;
        const left = pt.x * scale + (svgRect.left - wrapRect.left);
        const top = pt.y * scale + (svgRect.top - wrapRect.top);
        const tipEl = tip as HTMLElement;
        tipEl.style.left = `${Math.min(Math.max(left, 60), wrapRect.width - 60)}px`;
        tipEl.style.top = `${top}px`;
        tipEl.classList.add('show');
    }

    private hideTrendTip(): void {
        this.root.querySelector('.trend-tip')?.classList.remove('show');
    }

    private renderFeedback(): string {
        const items = (this.feedbackList?.items ?? []).filter(
            (item) => this.feedbackFilter === 'all' || item.type === this.feedbackFilter
        );
        const filterButton = (id: 'all' | 'feature' | 'bug', label: string) =>
            `<button class="ap-filter ${this.feedbackFilter === id ? 'active' : ''}" data-filter="${id}" type="button">${escapeHtml(label)}</button>`;
        let body: string;
        if (this.feedbackLoading && !this.feedbackList) {
            body = `<div class="ap-status">${escapeHtml(this.t('renderer.admin.loading'))}</div>`;
        } else if (this.feedbackError && !this.feedbackList) {
            body = `<div class="ap-status ap-error">${escapeHtml(this.feedbackError)}</div>
                <div class="ap-status-actions"><button class="ap-primary" data-action="reload-feedback" type="button">${escapeHtml(this.t('renderer.admin.reload'))}</button></div>`;
        } else if (items.length === 0) {
            body = `<div class="ap-empty">${escapeHtml(this.t('renderer.admin.feedbackEmpty'))}</div>`;
        } else {
            body = items.map((item) => this.feedbackCard(item)).join('');
        }
        return `
            <div class="ap-toolbar">
                <div class="ap-filters">
                    ${filterButton('all', this.t('renderer.admin.feedbackFilterAll'))}
                    ${filterButton('feature', this.t('renderer.admin.feedbackFilterFeature'))}
                    ${filterButton('bug', this.t('renderer.admin.feedbackFilterBug'))}
                </div>
                ${this.feedbackLoading ? `<span class="ap-loading-hint">${escapeHtml(this.t('renderer.admin.loading'))}</span>` : ''}
            </div>
            ${body}
        `;
    }

    private feedbackCard(item: AdminFeedbackItem): string {
        const typeKey =
            item.type === 'feature' ? 'renderer.admin.feedbackTypeFeature' : 'renderer.admin.feedbackTypeBug';
        const attachments = (item.attachments ?? [])
            .map(
                (a) =>
                    `<button class="ap-attachment" data-attachment="${a.attachment_id}" data-filename="${escapeHtml(a.filename)}" type="button" title="${escapeHtml(this.t('renderer.admin.openAttachment'))}">${AP_ICONS.paperclip}${escapeHtml(a.filename)}</button>`
            )
            .join('');
        return `<article class="ap-feedback">
            <header class="ap-feedback-head">
                <span class="ap-badge ${item.type}">${escapeHtml(this.t(typeKey))}</span>
                <span class="ap-feedback-time">${escapeHtml(formatDateTime(item.time))}</span>
                <span class="ap-feedback-id">#${item.id}</span>
            </header>
            <p class="ap-feedback-content">${escapeHtml(item.content)}</p>
            ${(item.contact || attachments) && item.contact ? `<div class="ap-feedback-meta"><span class="ap-meta-label">${escapeHtml(this.t('renderer.admin.feedbackContact'))}</span><span>${escapeHtml(item.contact)}</span></div>` : ''}
            ${attachments ? `<div class="ap-feedback-meta"><span class="ap-meta-label">${escapeHtml(this.t('renderer.admin.feedbackAttachments'))}</span><div class="ap-attachments">${attachments}</div></div>` : ''}
        </article>`;
    }
}

const AP_ICONS = {
    shield: '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
    refresh:
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/></svg>',
    logout: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>',
    paperclip:
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>'
};

customElements.define('adminconsole-entry-widget', AdminConsoleEntryWidget);
