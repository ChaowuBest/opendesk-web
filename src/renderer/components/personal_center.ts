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
import personalCenterCss from '../styles/personal-center.css?inline';

interface UsagePeriodSummary {
    task_count: number;
    request_count: number;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cache_read_input_tokens?: number;
    cache_miss_input_tokens?: number;
}

interface UsageDailyTrendPoint {
    day: string;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cache_read_input_tokens?: number;
    cache_miss_input_tokens?: number;
}

interface UsageHourlyTrendPoint {
    hour: string;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cache_read_input_tokens?: number;
    cache_miss_input_tokens?: number;
}

interface UsageTaskRankItem {
    task_id: string;
    task_name?: string;
    model?: string;
    provider?: string;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cache_read_input_tokens?: number;
    request_count: number;
    last_used_at: string;
}

interface UsageModelRankItem {
    model: string;
    provider?: string;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cache_read_input_tokens?: number;
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
    cache_read_input_tokens?: number;
    cache_miss_input_tokens?: number;
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

function formatPercent(part: number, total: number): string {
    if (!Number.isFinite(part) || !Number.isFinite(total) || part <= 0 || total <= 0) {
        return '0%';
    }
    return `${((part / total) * 100).toFixed(1)}%`;
}

/**
 * 将趋势图 tooltip 夹取在图表容器内：默认显示在数据点上方，空间不足时翻转
 * 到点下方，仍放不下时贴边。tooltip 一旦溢出图表容器就会让趋势面板出现
 * 滚动条，鼠标移动过程中滚动条反复出现/消失导致布局闪烁。
 */
export function clampTooltipPosition(
    pointLeft: number,
    pointTop: number,
    tooltipWidth: number,
    tooltipHeight: number,
    wrapWidth: number,
    wrapHeight: number
): { left: number; top: number } {
    const margin = 4;
    const left = Math.max(margin, Math.min(pointLeft - tooltipWidth / 2, wrapWidth - tooltipWidth - margin));
    let top = pointTop - tooltipHeight - 10;
    if (top < margin) {
        top = pointTop + 14;
    }
    top = Math.max(margin, Math.min(top, wrapHeight - tooltipHeight - margin));
    return { left, top };
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
    private taskRankPeriod: 'today' | 'week' | 'month' = 'month';
    private modelRankPeriod: 'today' | 'week' | 'month' = 'month';
    private taskRankings: UsageTaskRankItem[] | null = null;
    private modelRankings: UsageModelRankItem[] | null = null;
    private chartCounter = 0;
    private chartPointsMap = new Map<
        number,
        {
            points: TrendPoint[];
            inputPts: { x: number; y: number }[];
            outputPts: { x: number; y: number }[];
            padding: { top: number; right: number; bottom: number; left: number };
            innerWidth: number;
            innerHeight: number;
        }
    >();

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
            await this.loadRankings();
        } catch (error) {
            this.error = error instanceof Error ? error.message : String(error);
        } finally {
            this.loading = false;
            this.render();
        }
    }

    private async loadRankings(): Promise<void> {
        const usageAPI = (window as any).usageAPI;
        if (!usageAPI?.getRankings) {
            return;
        }
        try {
            const [taskResult, modelResult] = await Promise.all([
                usageAPI.getRankings({ rankPeriod: this.taskRankPeriod }),
                usageAPI.getRankings({ rankPeriod: this.modelRankPeriod })
            ]);
            this.taskRankings = taskResult?.tasks ?? null;
            this.modelRankings = modelResult?.models ?? null;
        } catch {
            this.taskRankings = null;
            this.modelRankings = null;
        }
    }

    private async changeTaskRankPeriod(period: 'today' | 'week' | 'month'): Promise<void> {
        this.taskRankPeriod = period;
        await this.loadRankings();
        this.render();
    }

    private async changeModelRankPeriod(period: 'today' | 'week' | 'month'): Promise<void> {
        this.modelRankPeriod = period;
        await this.loadRankings();
        this.render();
    }

    private renderPeriodCard(kind: 'today' | 'week', summary: UsagePeriodSummary): string {
        const title = kind === 'today' ? this.t('renderer.personal.today') : this.t('renderer.personal.week');
        const accentClass = kind === 'today' ? 'coral' : 'ink';
        const cacheRead = summary.cache_read_input_tokens ?? 0;
        const cacheMiss = summary.cache_miss_input_tokens ?? 0;
        const hasCacheBreakdown = cacheRead > 0 || cacheMiss > 0;
        const cacheBreakdown = hasCacheBreakdown
            ? `<span class="cache-breakdown">（${escapeHtml(this.t('renderer.personal.cacheHit'))} ${escapeHtml(compactNumber(cacheRead))} / ${escapeHtml(this.t('renderer.personal.cacheHitRateShort', { rate: formatPercent(cacheRead, cacheRead + cacheMiss) }))} / ${escapeHtml(this.t('renderer.personal.cacheMiss'))} ${escapeHtml(compactNumber(cacheMiss))}）</span>`
            : '';
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
                    <span>${escapeHtml(this.t('renderer.personal.inputTokens'))}: ${escapeHtml(compactNumber(summary.input_tokens))}${cacheBreakdown}</span>
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

        const chartIdx = this.chartCounter++;
        this.chartPointsMap.set(chartIdx, { points, inputPts, outputPts, padding, innerWidth, innerHeight });

        const labels = points
            .map((p, i) => {
                if (i % labelStride !== 0 && i !== points.length - 1) {
                    return '';
                }
                const x = padding.left + i * xStep;
                return `<text x="${x.toFixed(2)}" y="${height - 8}" text-anchor="middle">${escapeHtml(p.label)}</text>`;
            })
            .join('');

        const clipId = `chart-clip-${chartIdx}`;
        const crosshairStroke = 'var(--pc-crosshair, rgba(138, 133, 128, 0.55))';

        return `
            <div class="chart-wrap" data-chart-idx="${chartIdx}">
                <svg class="trend-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(ariaLabel)}" preserveAspectRatio="xMidYMid meet">
                    <defs>
                        <clipPath id="${clipId}">
                            <rect x="${padding.left}" y="${padding.top}" width="${innerWidth}" height="${innerHeight + 1}"></rect>
                        </clipPath>
                    </defs>
                    <line class="axis" x1="${padding.left}" y1="${padding.top + innerHeight}" x2="${width - padding.right}" y2="${padding.top + innerHeight}"></line>
                    <path class="line-input" d="${inputPath}" clip-path="url(#${clipId})"></path>
                    <path class="line-output" d="${outputPath}" clip-path="url(#${clipId})"></path>
                    ${labels}
                    <line class="crosshair crosshair-v" x1="0" y1="${padding.top}" x2="0" y2="${padding.top + innerHeight}" stroke="${crosshairStroke}"></line>
                    <line class="crosshair crosshair-h" x1="${padding.left}" y1="0" x2="${width - padding.right}" y2="0" stroke="${crosshairStroke}"></line>
                    <rect class="chart-overlay" x="${padding.left}" y="${padding.top}" width="${innerWidth}" height="${innerHeight}" fill="transparent"></rect>
                    <circle class="chart-dot chart-dot-input" cx="0" cy="0" r="4" fill="var(--pc-input, #DF4436)" stroke="var(--pc-card-bg, #fff)" stroke-width="2"></circle>
                    <circle class="chart-dot chart-dot-output" cx="0" cy="0" r="4" fill="var(--pc-output, #1C1917)" stroke="var(--pc-card-bg, #fff)" stroke-width="2"></circle>
                </svg>
                <div class="chart-tooltip" data-chart-idx="${chartIdx}" hidden>
                    <div class="chart-tooltip-time"></div>
                    <div class="chart-tooltip-row chart-tooltip-input">
                        <span class="tooltip-dot input"></span>
                        <span class="tooltip-label">${escapeHtml(this.t('renderer.personal.inputTokens'))}</span>
                        <span class="tooltip-val"></span>
                    </div>
                    <div class="chart-tooltip-row chart-tooltip-output">
                        <span class="tooltip-dot output"></span>
                        <span class="tooltip-label">${escapeHtml(this.t('renderer.personal.outputTokens'))}</span>
                        <span class="tooltip-val"></span>
                    </div>
                    <div class="chart-tooltip-row chart-tooltip-cache" hidden>
                        <span class="tooltip-dot cache"></span>
                        <span class="tooltip-label">${escapeHtml(this.t('renderer.personal.cacheHit'))} / ${escapeHtml(this.t('renderer.personal.cacheMiss'))}</span>
                        <span class="tooltip-val"></span>
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * 排行副标题：模型/供应商拼为一行，缺失段自动跳过。
     */
    private rankSubtitle(segments: string[]): string {
        const parts = segments.filter((segment) => segment.length > 0);
        if (parts.length === 0) {
            return '';
        }
        return `<span class="rank-subtitle">${parts.map((part) => escapeHtml(part)).join(' · ')}</span>`;
    }

    /** 排行右侧数值区的缓存命中率行，悬停显示命中率（含小数） */
    private rankCacheDetail(cacheRead: number, inputTokens: number): string {
        if (cacheRead <= 0) {
            return '';
        }
        const label = `${escapeHtml(this.t('renderer.personal.cacheHit'))} ${Math.round(
            inputTokens > 0 ? (cacheRead / inputTokens) * 100 : 0
        )}%`;
        const title = escapeHtml(
            this.t('renderer.personal.cacheHitRate', { rate: formatPercent(cacheRead, inputTokens) })
        );
        return `<span class="rank-detail-cache" title="${title}">${label}</span>`;
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
                        const cacheRead = task.cache_read_input_tokens ?? 0;
                        const subtitleHtml = this.rankSubtitle([task.model ?? '', task.provider ?? '']);
                        return `
                            <button class="rank-row" type="button" data-task-id="${escapeHtml(task.task_id)}" title="${escapeHtml(this.t('renderer.personal.openTask'))}">
                                <span class="rank-index">${index + 1}</span>
                                <span class="rank-main">
                                    <span class="rank-title">${escapeHtml(task.task_name || this.t('renderer.personal.untitledTask'))}</span>
                                    ${subtitleHtml}
                                    <span class="rank-bar">
                                        <span class="rank-bar-input" style="width:${inputPct.toFixed(1)}%"></span>
                                        <span class="rank-bar-output" style="width:${outputPct.toFixed(1)}%"></span>
                                    </span>
                                </span>
                                <span class="rank-meta">
                                    <span class="rank-detail">
                                        <span class="rank-detail-input"><span class="rank-arrow">↓</span>${escapeHtml(compactNumber(task.input_tokens))}</span>
                                        <span class="rank-detail-output"><span class="rank-arrow">↑</span>${escapeHtml(compactNumber(task.output_tokens))}</span>
                                        ${this.rankCacheDetail(cacheRead, task.input_tokens)}
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
                        const cacheRead = model.cache_read_input_tokens ?? 0;
                        const subtitleHtml = this.rankSubtitle([model.provider ?? '']);
                        return `
                            <div class="rank-row rank-row-static">
                                <span class="rank-index">${index + 1}</span>
                                <span class="rank-main">
                                    <span class="rank-title">${escapeHtml(displayName)}</span>
                                    ${subtitleHtml}
                                    <span class="rank-bar">
                                        <span class="rank-bar-input" style="width:${inputPct.toFixed(1)}%"></span>
                                        <span class="rank-bar-output" style="width:${outputPct.toFixed(1)}%"></span>
                                    </span>
                                </span>
                                <span class="rank-meta">
                                    <span class="rank-detail">
                                        <span class="rank-detail-input"><span class="rank-arrow">↓</span>${escapeHtml(compactNumber(model.input_tokens))}</span>
                                        <span class="rank-detail-output"><span class="rank-arrow">↑</span>${escapeHtml(compactNumber(model.output_tokens))}</span>
                                        ${this.rankCacheDetail(cacheRead, model.input_tokens)}
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

    private renderRankPeriodDropdown(kind: 'task' | 'model', current: string): string {
        const options = [
            { value: 'month', label: this.t('renderer.personal.rankPeriodMonth') },
            { value: 'week', label: this.t('renderer.personal.rankPeriodWeek') },
            { value: 'today', label: this.t('renderer.personal.rankPeriodToday') }
        ];
        const optionsHtml = options
            .map(
                (opt) =>
                    `<option value="${opt.value}"${opt.value === current ? ' selected' : ''}>${escapeHtml(opt.label)}</option>`
            )
            .join('');
        return `<select class="rank-period-select" data-rank-kind="${kind}">${optionsHtml}</select>`;
    }

    private bindChartEvents(): void {
        this.root.querySelectorAll<HTMLElement>('.chart-wrap[data-chart-idx]').forEach((wrap) => {
            const chartIdx = Number(wrap.dataset.chartIdx);
            const data = this.chartPointsMap.get(chartIdx);
            if (!data) {
                return;
            }

            const svg = wrap.querySelector<SVGSVGElement>('.trend-chart');
            if (!svg) {
                return;
            }

            const overlay = svg.querySelector<SVGRectElement>('.chart-overlay');
            const crossV = svg.querySelector<SVGLineElement>('.crosshair-v');
            const crossH = svg.querySelector<SVGLineElement>('.crosshair-h');
            const dotInput = svg.querySelector<SVGCircleElement>('.chart-dot-input');
            const dotOutput = svg.querySelector<SVGCircleElement>('.chart-dot-output');
            const tooltip = wrap.querySelector<HTMLElement>('.chart-tooltip');
            if (!overlay || !crossV || !crossH || !dotInput || !dotOutput || !tooltip) {
                return;
            }

            const { points, inputPts, outputPts, padding, innerWidth, innerHeight } = data;
            const width = 680;
            const snapThreshold = (innerWidth / Math.max(1, points.length - 1)) * 0.65;

            const hideAll = () => {
                crossV.style.visibility = 'hidden';
                crossH.style.visibility = 'hidden';
                dotInput.style.visibility = 'hidden';
                dotOutput.style.visibility = 'hidden';
                tooltip.hidden = true;
            };

            const handleMove = (e: MouseEvent) => {
                const pt = svg.createSVGPoint();
                pt.x = e.clientX;
                pt.y = e.clientY;
                const ctm = svg.getScreenCTM();
                if (!ctm) {
                    hideAll();
                    return;
                }
                const svgPt = pt.matrixTransform(ctm.inverse());

                // Find nearest data point by x distance
                let nearestIdx = 0;
                let minDist = Infinity;
                for (let i = 0; i < inputPts.length; i++) {
                    const dist = Math.abs(svgPt.x - inputPts[i].x);
                    if (dist < minDist) {
                        minDist = dist;
                        nearestIdx = i;
                    }
                }

                if (minDist > snapThreshold) {
                    hideAll();
                    return;
                }

                const snapX = inputPts[nearestIdx].x;
                const inputY = inputPts[nearestIdx].y;
                const outputY = outputPts[nearestIdx].y;

                // Crosshair lines
                crossV.setAttribute('x1', String(snapX));
                crossV.setAttribute('x2', String(snapX));
                crossV.style.visibility = 'visible';

                const crossY = Math.min(inputY, outputY);
                crossH.setAttribute('y1', String(crossY));
                crossH.setAttribute('y2', String(crossY));
                crossH.style.visibility = 'visible';

                // Dots on curves
                dotInput.setAttribute('cx', String(snapX));
                dotInput.setAttribute('cy', String(inputY));
                dotInput.style.visibility = 'visible';

                dotOutput.setAttribute('cx', String(snapX));
                dotOutput.setAttribute('cy', String(outputY));
                dotOutput.style.visibility = 'visible';

                // Tooltip content
                const p = points[nearestIdx];
                tooltip.querySelector('.chart-tooltip-time')!.textContent = p.label;
                tooltip.querySelector('.chart-tooltip-input .tooltip-val')!.textContent = compactNumber(p.input_tokens);
                tooltip.querySelector('.chart-tooltip-output .tooltip-val')!.textContent = compactNumber(
                    p.output_tokens
                );
                const cacheRead = p.cache_read_input_tokens ?? 0;
                const cacheMiss = p.cache_miss_input_tokens ?? 0;
                const cacheRow = tooltip.querySelector<HTMLElement>('.chart-tooltip-cache')!;
                if (cacheRead > 0 || cacheMiss > 0) {
                    cacheRow.hidden = false;
                    cacheRow.querySelector('.tooltip-val')!.textContent =
                        `${compactNumber(cacheRead)} / ${compactNumber(cacheMiss)}`;
                } else {
                    cacheRow.hidden = true;
                }
                tooltip.hidden = false;

                // Position tooltip relative to chart-wrap. Clamp it fully inside the
                // chart wrap (measured size, not assumptions): any overflow would make
                // the trend panel show scrollbars and flicker the layout while moving.
                const svgRect = svg.getBoundingClientRect();
                const wrapRect = wrap.getBoundingClientRect();
                const scaleX = svgRect.width / width;
                const scaleY = svgRect.height / 170;
                const pointLeft = svgRect.left - wrapRect.left + snapX * scaleX;
                const pointTop = svgRect.top - wrapRect.top + crossY * scaleY;

                const { left, top } = clampTooltipPosition(
                    pointLeft,
                    pointTop,
                    tooltip.offsetWidth,
                    tooltip.offsetHeight,
                    wrapRect.width,
                    wrapRect.height
                );

                tooltip.style.left = `${left}px`;
                tooltip.style.top = `${top}px`;
            };

            const handleLeave = () => {
                hideAll();
            };

            overlay.addEventListener('mousemove', handleMove);
            overlay.addEventListener('mouseleave', handleLeave);
        });
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
        this.root.querySelectorAll<HTMLSelectElement>('.rank-period-select').forEach((sel) => {
            sel.addEventListener('change', () => {
                const kind = sel.dataset.rankKind;
                const period = sel.value as 'today' | 'week' | 'month';
                if (kind === 'task') {
                    void this.changeTaskRankPeriod(period);
                } else if (kind === 'model') {
                    void this.changeModelRankPeriod(period);
                }
            });
        });
        this.bindChartEvents();
    }

    private render(): void {
        this.chartCounter = 0;
        this.chartPointsMap.clear();
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
                                    <h2>${escapeHtml(this.t('renderer.personal.taskRanking'))}</h2>
                                    <p>${escapeHtml(this.t('renderer.personal.taskRankingSubtitle'))}</p>
                                </div>
                                ${this.renderRankPeriodDropdown('task', this.taskRankPeriod)}
                            </div>
                            ${this.renderRanking(this.taskRankings ?? summary.month_top_tasks)}
                        </section>
                        <section class="panel rank-panel">
                            <div class="panel-header">
                                <div>
                                    <h2>${escapeHtml(this.t('renderer.personal.modelRankingTitle'))}</h2>
                                    <p>${escapeHtml(this.t('renderer.personal.modelRankingSubtitle'))}</p>
                                </div>
                                ${this.renderRankPeriodDropdown('model', this.modelRankPeriod)}
                            </div>
                            ${this.renderModelRanking(this.modelRankings ?? summary.month_top_models)}
                        </section>
                    </div>
                `;

        this.root.innerHTML = `
                <style>
                    ${personalCenterCss}
                </style>
                <div class="personal-center">
                    <div class="page-inner">
                        <header class="page-header">
                            <div class="page-title">
                                <h1>${escapeHtml(this.t('renderer.personal.title'))}</h1>
                                <div class="updated-at">${summary ? this.renderUpdatedAt(summary) : ''}</div>
                            </div>
                            <button class="icon-button" data-action="refresh" type="button" title="${escapeHtml(this.t('renderer.personal.refresh'))}" aria-label="${escapeHtml(this.t('renderer.personal.refresh'))}"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="16" height="16" fill="currentColor"><path d="M105.1 202.6c7.7-21.8 20.2-42.3 37.8-59.8c62.5-62.5 163.8-62.5 226.3 0L386.3 160H336c-17.7 0-32 14.3-32 32s14.3 32 32 32H463.5c0 0 0 0 0 0h.4c17.7 0 32-14.3 32-32V64c0-17.7-14.3-32-32-32s-32 14.3-32 32v51.2L414.4 97.6c-87.5-87.5-229.3-87.5-316.8 0C73.2 122 55.6 150.7 44.8 181.4c-5.9 16.7 2.9 34.9 19.5 40.8s34.9-2.9 40.8-19.5zM39 289.3c-5 1.5-9.8 4.2-13.7 8.2c-4 4-6.7 8.8-8.1 14c-.3 1.2-.6 2.5-.8 3.8c-.3 1.7-.4 3.4-.4 5.1V448c0 17.7 14.3 32 32 32s32-14.3 32-32V396.9l17.6 17.5 0 0c87.5 87.4 229.3 87.4 316.7 0c24.4-24.4 42.1-53.1 52.9-83.7c5.9-16.7-2.9-34.9-19.5-40.8s-34.9 2.9-40.8 19.5c-7.7 21.8-20.2 42.3-37.8 59.8c-62.5 62.5-163.8 62.5-226.3 0l-.1-.1L125.6 352H176c17.7 0 32-14.3 32-32s-14.3-32-32-32H48.4c-1.6 0-3.2 .1-4.8 .3s-3.1 .5-4.6 1z"/></svg></button>
                            <account-panel></account-panel>
                        </header>
                        ${body}
                    </div>
                </div>
            `;
        this.bindEvents();
    }
}

customElements.define('personal-center', PersonalCenter);
