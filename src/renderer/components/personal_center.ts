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

import { escapeHtml } from '../../common/utils/escape.js';
import { createRendererTranslator } from '../locale.ts';

interface UsagePeriodSummary {
    task_count: number;
    request_count: number;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
}

interface UsageDailyTrendPoint {
    day: string;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
}

interface UsageHourlyTrendPoint {
    hour: string;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
}

interface UsageTaskRankItem {
    task_id: string;
    task_name?: string;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    request_count: number;
    last_used_at: string;
}

interface UsageModelRankItem {
    model: string;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    request_count: number;
}

interface UsageDashboardSummary {
    today: UsagePeriodSummary;
    week: UsagePeriodSummary;
    daily_trend: UsageDailyTrendPoint[];
    hourly_trend: UsageHourlyTrendPoint[];
    month_top_tasks: UsageTaskRankItem[];
    month_top_models: UsageModelRankItem[];
    updated_at?: string;
}

interface TrendPoint {
    label: string;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
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

class PersonalCenter extends HTMLElement {
    private readonly root: ShadowRoot;
    private summary: UsageDashboardSummary | null = null;
    private loading = false;
    private error: string | null = null;
    private settingUnsubscribe: (() => void) | null = null;
    private t = createRendererTranslator();

    constructor() {
        super();
        this.root = this.attachShadow({ mode: 'open' });
    }

    connectedCallback(): void {
        this.render();
        void this.initializeLocale();
        void this.loadData();
    }

    disconnectedCallback(): void {
        this.settingUnsubscribe?.();
        this.settingUnsubscribe = null;
    }

    private async initializeLocale(): Promise<void> {
        try {
            const api = (window as any).settingAPI;
            if (api?.loadSettingObject) {
                const setting = await api.loadSettingObject();
                this.t = createRendererTranslator(setting);
                this.render();
            }
            if (api?.onSettingChanged && !this.settingUnsubscribe) {
                this.settingUnsubscribe = api.onSettingChanged((setting: any) => {
                    this.t = createRendererTranslator(setting);
                    this.render();
                });
            }
        } catch {
            this.t = createRendererTranslator();
        }
    }

    private async loadData(): Promise<void> {
        this.loading = true;
        this.error = null;
        this.render();
        try {
            const usageAPI = (window as any).usageAPI;
            if (!usageAPI?.getDashboardSummary) {
                throw new Error(this.t('renderer.personal.usageUnavailable'));
            }
            this.summary = (await usageAPI.getDashboardSummary()) as UsageDashboardSummary;
        } catch (error) {
            this.error = error instanceof Error ? error.message : String(error);
        } finally {
            this.loading = false;
            this.render();
        }
    }

    private renderPeriodCard(kind: 'today' | 'week', summary: UsagePeriodSummary): string {
        const title = kind === 'today' ? this.t('renderer.personal.today') : this.t('renderer.personal.week');
        const accentClass = kind === 'today' ? 'coral' : 'ink';
        return `
            <section class="metric-card ${accentClass}">
                <div class="metric-card-header">
                    <span>${escapeHtml(title)}</span>
                    <span class="metric-pill">${escapeHtml(this.t('renderer.personal.requests', { count: summary.request_count }))}</span>
                </div>
                <div class="metric-main">
                    <div>
                        <div class="metric-value">${escapeHtml(compactNumber(summary.task_count))}</div>
                        <div class="metric-label">${escapeHtml(this.t('renderer.personal.startedTasks'))}</div>
                    </div>
                    <div class="metric-token">
                        <div class="metric-value">${escapeHtml(compactNumber(summary.total_tokens))}</div>
                        <div class="metric-label">${escapeHtml(this.t('renderer.personal.tokens'))}</div>
                    </div>
                </div>
                <div class="metric-split">
                    <span>${escapeHtml(this.t('renderer.personal.inputTokens'))}: ${escapeHtml(compactNumber(summary.input_tokens))}</span>
                    <span>${escapeHtml(this.t('renderer.personal.outputTokens'))}: ${escapeHtml(compactNumber(summary.output_tokens))}</span>
                </div>
            </section>
        `;
    }

    private renderLineChart(points: TrendPoint[], ariaLabel: string, emptyMessage: string): string {
        const hasData = points.some((point) => point.total_tokens > 0);
        if (!hasData) {
            return `<div class="empty-state compact">${escapeHtml(emptyMessage)}</div>`;
        }

        const width = 680;
        const height = 170;
        const padding = { top: 14, right: 16, bottom: 28, left: 36 };
        const innerWidth = width - padding.left - padding.right;
        const innerHeight = height - padding.top - padding.bottom;
        const maxValue = Math.max(...points.map((p) => Math.max(p.input_tokens, p.output_tokens)), 1);
        const xStep = innerWidth / Math.max(1, points.length - 1);
        const labelStride = Math.max(1, Math.ceil(points.length / 8));

        const inputPts = points.map((p, i) => ({
            x: padding.left + i * xStep,
            y: padding.top + innerHeight - (p.input_tokens / maxValue) * innerHeight
        }));
        const outputPts = points.map((p, i) => ({
            x: padding.left + i * xStep,
            y: padding.top + innerHeight - (p.output_tokens / maxValue) * innerHeight
        }));

        const inputPath = smoothPath(inputPts);
        const outputPath = smoothPath(outputPts);

        const labels = points
            .map((p, i) => {
                if (i % labelStride !== 0 && i !== points.length - 1) {
                    return '';
                }
                const x = padding.left + i * xStep;
                return `<text x="${x.toFixed(2)}" y="${height - 8}" text-anchor="middle">${escapeHtml(p.label)}</text>`;
            })
            .join('');

        return `
            <div class="chart-wrap">
                <svg class="trend-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(ariaLabel)}">
                    <line class="axis" x1="${padding.left}" y1="${padding.top + innerHeight}" x2="${width - padding.right}" y2="${padding.top + innerHeight}"></line>
                    <path class="line-input" d="${inputPath}"></path>
                    <path class="line-output" d="${outputPath}"></path>
                    ${labels}
                </svg>
            </div>
        `;
    }

    private renderRanking(tasks: UsageTaskRankItem[]): string {
        if (tasks.length === 0) {
            return `<div class="empty-state compact">${escapeHtml(this.t('renderer.personal.noRankedTasks'))}</div>`;
        }
        const maxTokens = Math.max(...tasks.map((task) => task.total_tokens), 1);
        return `
            <div class="rank-list">
                ${tasks
                    .map((task, index) => {
                        const inputPct = (task.input_tokens / maxTokens) * 100;
                        const outputPct = (task.output_tokens / maxTokens) * 100;
                        return `
                            <button class="rank-row" type="button" data-task-id="${escapeHtml(task.task_id)}" title="${escapeHtml(this.t('renderer.personal.openTask'))}">
                                <span class="rank-index">${index + 1}</span>
                                <span class="rank-main">
                                    <span class="rank-title">${escapeHtml(task.task_name || this.t('renderer.personal.untitledTask'))}</span>
                                    <span class="rank-bar">
                                        <span class="rank-bar-input" style="width:${inputPct.toFixed(1)}%"></span>
                                        <span class="rank-bar-output" style="width:${outputPct.toFixed(1)}%"></span>
                                    </span>
                                </span>
                                <span class="rank-meta">
                                    <span class="rank-detail">
                                        <span class="rank-detail-input"><span class="rank-arrow">↓</span>${escapeHtml(compactNumber(task.input_tokens))}</span>
                                        <span class="rank-detail-output"><span class="rank-arrow">↑</span>${escapeHtml(compactNumber(task.output_tokens))}</span>
                                    </span>
                                </span>
                            </button>
                        `;
                    })
                    .join('')}
            </div>
        `;
    }

    private renderModelRanking(models: UsageModelRankItem[]): string {
        if (models.length === 0) {
            return `<div class="empty-state compact">${escapeHtml(this.t('renderer.personal.noRankedModels'))}</div>`;
        }
        const maxTokens = Math.max(...models.map((m) => m.total_tokens), 1);
        return `
            <div class="rank-list">
                ${models
                    .map((model, index) => {
                        const inputPct = (model.input_tokens / maxTokens) * 100;
                        const outputPct = (model.output_tokens / maxTokens) * 100;
                        const displayName =
                            model.model === 'unknown' ? this.t('renderer.personal.unknownModel') : model.model;
                        return `
                            <div class="rank-row rank-row-static">
                                <span class="rank-index">${index + 1}</span>
                                <span class="rank-main">
                                    <span class="rank-title">${escapeHtml(displayName)}</span>
                                    <span class="rank-bar">
                                        <span class="rank-bar-input" style="width:${inputPct.toFixed(1)}%"></span>
                                        <span class="rank-bar-output" style="width:${outputPct.toFixed(1)}%"></span>
                                    </span>
                                </span>
                                <span class="rank-meta">
                                    <span class="rank-detail">
                                        <span class="rank-detail-input"><span class="rank-arrow">↓</span>${escapeHtml(compactNumber(model.input_tokens))}</span>
                                        <span class="rank-detail-output"><span class="rank-arrow">↑</span>${escapeHtml(compactNumber(model.output_tokens))}</span>
                                    </span>
                                </span>
                            </div>
                        `;
                    })
                    .join('')}
            </div>
        `;
    }

    private renderUpdatedAt(summary: UsageDashboardSummary): string {
        if (!summary.updated_at) {
            return '';
        }
        const date = new Date(summary.updated_at);
        const label = Number.isNaN(date.getTime()) ? summary.updated_at : date.toLocaleString();
        return `<span>${escapeHtml(this.t('renderer.personal.updatedAt', { time: label }))}</span>`;
    }

    private bindEvents(): void {
        this.root.querySelector<HTMLButtonElement>('[data-action="refresh"]')?.addEventListener('click', () => {
            void this.loadData();
        });
        this.root.querySelectorAll<HTMLButtonElement>('.rank-row[data-task-id]').forEach((row) => {
            row.addEventListener('click', () => {
                const taskId = row.dataset.taskId;
                if (taskId) {
                    (window as any).globalControlAPI?.openTask?.(taskId);
                }
            });
        });
    }

    private render(): void {
        const summary = this.summary;
        const body = this.error
            ? `
                    <div class="state error">
                        <div class="state-title">${escapeHtml(this.t('renderer.personal.loadFailed'))}</div>
                        <div class="state-detail">${escapeHtml(this.error)}</div>
                    </div>
                `
            : this.loading || !summary
              ? `
                    <div class="state">
                        <div class="spinner"></div>
                        <div>${escapeHtml(this.t('renderer.personal.loading'))}</div>
                    </div>
                `
              : `
                    <div class="summary-grid">
                        ${this.renderPeriodCard('today', summary.today)}
                        ${this.renderPeriodCard('week', summary.week)}
                    </div>
                    <div class="dashboard-grid">
                        <section class="panel trend-panel">
                            <div class="panel-header">
                                <div>
                                    <h2>${escapeHtml(this.t('renderer.personal.hourlyTrend'))}</h2>
                                    <p>${escapeHtml(this.t('renderer.personal.hourlyTrendSubtitle'))}</p>
                                </div>
                            </div>
                            ${this.renderLineChart(
                                summary.hourly_trend.map((p) => ({ label: p.hour, ...p })),
                                this.t('renderer.personal.hourlyTrend'),
                                this.t('renderer.personal.noUsage')
                            )}
                            <div class="chart-divider"></div>
                            <div class="panel-header">
                                <div>
                                    <h2>${escapeHtml(this.t('renderer.personal.dailyTrend'))}</h2>
                                    <p>${escapeHtml(this.t('renderer.personal.dailyTrendSubtitle'))}</p>
                                </div>
                            </div>
                            ${this.renderLineChart(
                                summary.daily_trend.map((p) => ({ label: formatDayLabel(p.day), ...p })),
                                this.t('renderer.personal.dailyTrend'),
                                this.t('renderer.personal.noUsage')
                            )}
                            <div class="legend">
                                <span><i class="legend-dot input"></i>${escapeHtml(this.t('renderer.personal.inputTokens'))}</span>
                                <span><i class="legend-dot output"></i>${escapeHtml(this.t('renderer.personal.outputTokens'))}</span>
                            </div>
                        </section>
                        <section class="panel rank-panel">
                            <div class="panel-header">
                                <div>
                                    <h2>${escapeHtml(this.t('renderer.personal.monthRanking'))}</h2>
                                    <p>${escapeHtml(this.t('renderer.personal.monthRankingSubtitle'))}</p>
                                </div>
                            </div>
                            ${this.renderRanking(summary.month_top_tasks)}
                        </section>
                        <section class="panel rank-panel">
                            <div class="panel-header">
                                <div>
                                    <h2>${escapeHtml(this.t('renderer.personal.modelRanking'))}</h2>
                                    <p>${escapeHtml(this.t('renderer.personal.modelRankingSubtitle'))}</p>
                                </div>
                            </div>
                            ${this.renderModelRanking(summary.month_top_models)}
                        </section>
                    </div>
                `;

        this.root.innerHTML = `
                <style>
                    :host {
                        display: block;
                        width: 100%;
                        height: 100%;
                        color: var(--pc-text, #1f2937);
                    }

                    .personal-center {
                        box-sizing: border-box;
                        width: 100%;
                        height: 100%;
                        padding: 28px;
                        background:
                            linear-gradient(135deg, rgba(255, 255, 255, 0.82), rgba(247, 243, 242, 0.92)),
                            var(--pc-page-bg, #f6f2f1);
                        overflow: hidden;
                    }

                    .page-inner {
                        width: 100%;
                        height: 100%;
                        display: flex;
                        flex-direction: column;
                        gap: 18px;
                    }

                    .page-header {
                        display: flex;
                        align-items: center;
                        gap: 12px;
                        flex: 0 0 auto;
                    }

                    .page-title {
                        min-width: 0;
                        flex: 1;
                    }

                    h1,
                    h2,
                    p {
                        margin: 0;
                    }

                    h1 {
                        color: var(--pc-heading, #111827);
                        font-size: 24px;
                        line-height: 1.2;
                        font-weight: 750;
                    }

                    .updated-at {
                        margin-top: 5px;
                        color: var(--pc-muted, #6b7280);
                        font-size: 12px;
                    }

                    .icon-button {
                        width: 34px;
                        height: 34px;
                        display: inline-flex;
                        align-items: center;
                        justify-content: center;
                        border: 1px solid var(--pc-border, rgba(148, 163, 184, 0.28));
                        border-radius: 8px;
                        background: var(--pc-button-bg, rgba(255, 255, 255, 0.78));
                        color: var(--pc-muted, #64748b);
                        cursor: pointer;
                        font-size: 16px;
                    }

                    .icon-button:hover {
                        background: var(--pc-button-hover-bg, #ffffff);
                        color: var(--pc-heading, #111827);
                    }

                    .icon-button:focus-visible,
                    .rank-row:focus-visible {
                        outline: 2px solid var(--od-accent, #3b82f6);
                        outline-offset: 2px;
                    }

                    .summary-grid,
                    .dashboard-grid {
                        display: grid;
                        gap: 16px;
                    }

                    .summary-grid {
                        grid-template-columns: repeat(2, minmax(0, 1fr));
                        flex: 0 0 auto;
                    }

                    .dashboard-grid {
                        grid-template-columns: minmax(0, 1.1fr) minmax(230px, 1fr) minmax(230px, 1fr);
                        align-items: stretch;
                        flex: 1 1 auto;
                        min-height: 0;
                    }

                    .metric-card,
                    .panel {
                        border: 1px solid var(--pc-border, rgba(226, 232, 240, 0.86));
                        border-radius: 8px;
                        background: var(--pc-card-bg, rgba(255, 255, 255, 0.76));
                        box-shadow: var(--pc-card-shadow, 0 16px 44px rgba(15, 23, 42, 0.08));
                    }

                    .metric-card {
                        position: relative;
                        overflow: hidden;
                        min-height: 124px;
                        padding: 18px;
                    }

                    .metric-card::before {
                        content: '';
                        position: absolute;
                        inset: 0 auto 0 0;
                        width: 5px;
                    }

                    .metric-card.coral::before {
                        background: #d94d45;
                    }

                    .metric-card.ink::before {
                        background: #111827;
                    }

                    .metric-card-header,
                    .metric-main,
                    .metric-split,
                    .panel-header,
                    .legend {
                        display: flex;
                        align-items: center;
                    }

                    .metric-card-header {
                        justify-content: space-between;
                        gap: 12px;
                        color: var(--pc-muted, #64748b);
                        font-size: 12px;
                        font-weight: 650;
                    }

                    .metric-pill {
                        padding: 4px 8px;
                        border-radius: 999px;
                        background: var(--pc-pill-bg, rgba(15, 23, 42, 0.06));
                        color: var(--pc-muted, #64748b);
                        white-space: nowrap;
                    }

                    .metric-main {
                        margin-top: 16px;
                        justify-content: space-between;
                        gap: 18px;
                    }

                    .metric-value {
                        color: var(--pc-heading, #111827);
                        font-size: 30px;
                        line-height: 1;
                        font-weight: 780;
                    }

                    .metric-label {
                        margin-top: 6px;
                        color: var(--pc-muted, #64748b);
                        font-size: 12px;
                    }

                    .metric-token {
                        text-align: right;
                    }

                    .metric-split {
                        margin-top: 18px;
                        gap: 10px;
                        flex-wrap: wrap;
                        color: var(--pc-muted, #64748b);
                        font-size: 12px;
                    }

                    .panel {
                        min-width: 0;
                        padding: 18px;
                        overflow: hidden;
                        display: flex;
                        flex-direction: column;
                        min-height: 0;
                    }

                    .trend-panel {
                        overflow-y: auto;
                    }

                    .panel-header {
                        justify-content: space-between;
                        gap: 12px;
                        margin-bottom: 10px;
                    }

                    h2 {
                        color: var(--pc-heading, #111827);
                        font-size: 15px;
                        line-height: 1.3;
                        font-weight: 720;
                    }

                    .panel-header p {
                        margin-top: 4px;
                        color: var(--pc-muted, #64748b);
                        font-size: 12px;
                    }

                    .chart-wrap {
                        width: 100%;
                        flex: 0 0 auto;
                        min-height: 0;
                    }

                    .trend-chart {
                        width: 100%;
                        height: 100%;
                        min-height: 140px;
                        overflow: visible;
                    }

                    .trend-chart text {
                        fill: var(--pc-muted, #64748b);
                        font-size: 10px;
                    }

                    .axis {
                        stroke: var(--pc-axis, rgba(148, 163, 184, 0.32));
                        stroke-width: 1;
                    }

                    .line-input {
                        fill: none;
                        stroke: var(--pc-input, #d94d45);
                        stroke-width: 2;
                        stroke-linecap: round;
                        stroke-linejoin: round;
                    }

                    .line-output {
                        fill: none;
                        stroke: var(--pc-output, #111827);
                        stroke-width: 2;
                        stroke-linecap: round;
                        stroke-linejoin: round;
                    }

                    .chart-divider {
                        margin: 14px 0 10px;
                        border-top: 1px solid var(--pc-border, rgba(226, 232, 240, 0.86));
                    }

                    .legend {
                        justify-content: flex-end;
                        gap: 14px;
                        margin-top: 10px;
                        color: var(--pc-muted, #64748b);
                        font-size: 12px;
                    }

                    .legend span {
                        display: inline-flex;
                        align-items: center;
                        gap: 6px;
                    }

                    .legend-dot {
                        width: 8px;
                        height: 8px;
                        border-radius: 999px;
                        display: inline-block;
                    }

                    .legend-dot.input {
                        background: var(--pc-input, #d94d45);
                    }

                    .legend-dot.output {
                        background: var(--pc-output, #111827);
                    }

                    .rank-list {
                        flex: 1 1 auto;
                        min-height: 0;
                        overflow-y: auto;
                        overflow-x: hidden;
                        display: flex;
                        flex-direction: column;
                        gap: 8px;
                    }

                    .rank-row {
                        min-width: 0;
                        min-height: 52px;
                        display: grid;
                        grid-template-columns: 28px minmax(0, 1fr) minmax(70px, auto);
                        align-items: center;
                        gap: 10px;
                        border: 0;
                        border-radius: 8px;
                        padding: 8px 12px 8px 8px;
                        background: transparent;
                        color: inherit;
                        font: inherit;
                        text-align: left;
                        cursor: pointer;
                    }

                    .rank-row:hover {
                        background: var(--pc-row-hover-bg, rgba(15, 23, 42, 0.05));
                    }

                    .rank-row-static {
                        cursor: default;
                    }

                    .rank-row-static:hover {
                        background: transparent;
                    }

                    .rank-index {
                        width: 24px;
                        height: 24px;
                        border-radius: 50%;
                        display: inline-flex;
                        align-items: center;
                        justify-content: center;
                        background: var(--pc-index-bg, rgba(217, 77, 69, 0.12));
                        color: var(--pc-input, #d94d45);
                        font-size: 12px;
                        font-weight: 700;
                    }

                    .rank-main {
                        min-width: 0;
                        overflow: hidden;
                    }

                    .rank-title {
                        display: block;
                        min-width: 0;
                        color: var(--pc-heading, #111827);
                        font-size: 13px;
                        font-weight: 650;
                        overflow: hidden;
                        text-overflow: ellipsis;
                        white-space: nowrap;
                    }

                    .rank-bar {
                        display: flex;
                        height: 5px;
                        margin-top: 7px;
                        border-radius: 999px;
                        background: var(--pc-bar-track, rgba(15, 23, 42, 0.08));
                        overflow: hidden;
                    }

                    .rank-bar-input {
                        display: block;
                        height: 100%;
                        background: var(--pc-input, #d94d45);
                    }

                    .rank-bar-output {
                        display: block;
                        height: 100%;
                        background: var(--pc-output, #111827);
                    }

                    .rank-meta {
                        align-items: center;
                        white-space: nowrap;
                        flex-shrink: 0;
                    }

                    .rank-detail {
                        display: flex;
                        flex-direction: column;
                        align-items: flex-end;
                        gap: 2px;
                        font-size: 11px;
                    }

                    .rank-detail-input,
                    .rank-detail-output {
                        display: inline-flex;
                        align-items: center;
                        gap: 3px;
                        white-space: nowrap;
                        font-weight: 600;
                    }

                    .rank-detail-input {
                        color: var(--pc-input, #d94d45);
                    }

                    .rank-detail-output {
                        color: var(--pc-output, #111827);
                    }

                    .rank-arrow {
                        font-size: 10px;
                        opacity: 0.65;
                    }

                    .state,
                    .empty-state {
                        flex: 1 1 auto;
                        min-height: 220px;
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                        justify-content: center;
                        gap: 8px;
                        text-align: center;
                        color: var(--pc-muted, #64748b);
                        font-size: 13px;
                    }

                    .empty-state.compact {
                        min-height: 140px;
                    }

                    .state-title {
                        color: var(--pc-heading, #111827);
                        font-size: 14px;
                        font-weight: 650;
                    }

                    .state-detail {
                        max-width: 520px;
                        color: var(--pc-muted, #64748b);
                        font-size: 12px;
                        line-height: 1.6;
                    }

                    .state.error .state-title {
                        color: #dc2626;
                    }

                    .spinner {
                        width: 22px;
                        height: 22px;
                        border: 2px solid var(--pc-spinner-track, rgba(148, 163, 184, 0.26));
                        border-top-color: var(--pc-input, #d94d45);
                        border-radius: 999px;
                        animation: spin 0.85s linear infinite;
                    }

                    @keyframes spin {
                        to {
                            transform: rotate(360deg);
                        }
                    }

                    :host-context(html[data-theme='dark']) {
                        --pc-page-bg: #17171a;
                        --pc-card-bg: rgba(31, 31, 35, 0.78);
                        --pc-border: rgba(82, 82, 91, 0.62);
                        --pc-text: #e5e7eb;
                        --pc-heading: #f8fafc;
                        --pc-muted: #a1a1aa;
                        --pc-pill-bg: rgba(255, 255, 255, 0.08);
                        --pc-button-bg: rgba(39, 39, 42, 0.76);
                        --pc-button-hover-bg: rgba(63, 63, 70, 0.86);
                        --pc-card-shadow: 0 18px 44px rgba(0, 0, 0, 0.24);
                        --pc-axis: rgba(161, 161, 170, 0.32);
                        --pc-output: #e5e7eb;
                        --pc-row-hover-bg: rgba(255, 255, 255, 0.06);
                        --pc-index-bg: rgba(217, 77, 69, 0.2);
                        --pc-bar-track: rgba(255, 255, 255, 0.1);
                        --pc-spinner-track: rgba(161, 161, 170, 0.3);
                    }

                    @media (max-width: 1080px) {
                        .dashboard-grid {
                            grid-template-columns: minmax(0, 1fr) minmax(200px, 1fr) minmax(200px, 1fr);
                        }
                    }

                    @media (max-width: 920px) {
                        .personal-center {
                            padding: 20px 16px;
                            overflow: auto;
                        }

                        .summary-grid,
                        .dashboard-grid {
                            grid-template-columns: 1fr;
                        }
                    }

                    @media (max-width: 560px) {
                        .page-header {
                            align-items: flex-start;
                        }

                        h1 {
                            font-size: 21px;
                        }

                        .metric-main {
                            flex-direction: column;
                            align-items: flex-start;
                        }

                        .metric-token {
                            text-align: left;
                        }

                        .trend-chart {
                            min-height: 120px;
                        }
                    }
                </style>
                <div class="personal-center">
                    <div class="page-inner">
                        <header class="page-header">
                            <div class="page-title">
                                <h1>${escapeHtml(this.t('renderer.personal.title'))}</h1>
                                <div class="updated-at">${summary ? this.renderUpdatedAt(summary) : ''}</div>
                            </div>
                            <button class="icon-button" data-action="refresh" type="button" title="${escapeHtml(this.t('renderer.personal.refresh'))}" aria-label="${escapeHtml(this.t('renderer.personal.refresh'))}"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="16" height="16" fill="currentColor"><path d="M105.1 202.6c7.7-21.8 20.2-42.3 37.8-59.8c62.5-62.5 163.8-62.5 226.3 0L386.3 160H336c-17.7 0-32 14.3-32 32s14.3 32 32 32H463.5c0 0 0 0 0 0h.4c17.7 0 32-14.3 32-32V64c0-17.7-14.3-32-32-32s-32 14.3-32 32v51.2L414.4 97.6c-87.5-87.5-229.3-87.5-316.8 0C73.2 122 55.6 150.7 44.8 181.4c-5.9 16.7 2.9 34.9 19.5 40.8s34.9-2.9 40.8-19.5zM39 289.3c-5 1.5-9.8 4.2-13.7 8.2c-4 4-6.7 8.8-8.1 14c-.3 1.2-.6 2.5-.8 3.8c-.3 1.7-.4 3.4-.4 5.1V448c0 17.7 14.3 32 32 32s32-14.3 32-32V396.9l17.6 17.5 0 0c87.5 87.4 229.3 87.4 316.7 0c24.4-24.4 42.1-53.1 52.9-83.7c5.9-16.7-2.9-34.9-19.5-40.8s-34.9 2.9-40.8 19.5c-7.7 21.8-20.2 42.3-37.8 59.8c-62.5 62.5-163.8 62.5-226.3 0l-.1-.1L125.6 352H176c17.7 0 32-14.3 32-32s-14.3-32-32-32H48.4c-1.6 0-3.2 .1-4.8 .3s-3.1 .5-4.6 1z"/></svg></button>
                        </header>
                        ${body}
                    </div>
                </div>
            `;
        this.bindEvents();
    }
}

customElements.define('personal-center', PersonalCenter);
