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

/**
 * 上下文占比弹窗 — 开发者模式入口（侧边栏任务右键菜单「查看上下文占比」）。
 *
 * 数据链路与 TUI /context 命令一致：main 进程 `taskManager:getContextDiagnostics`
 * 复用 aikernel/context 只读诊断管线，返回 ContextDiagnosticsReport + suggestions；
 * 渲染层只做可视化：与 TUI circle 可视化页同款的 10×10 圆点网格 + 本地化建议。
 *
 * 服务端 suggestions 的 title/detail 为硬编码中文，GUI 侧按 suggestion.id 映射
 * 本地化词条，仅在映射缺失时回退服务端文案。
 *
 * 纯构建函数（formatCompactTokens / contextCategoryColor / buildContextUsageContent）
 * 与弹窗挂载分离导出，便于 linkedom 单测（同 feedbackModal 模式）。
 */

import {
    MODAL_CSS,
    MODAL_ANIM_DURATION_OUT,
    CLOSE_SVG,
    renderIcon,
    detectDarkMode,
    bindOverlayDismiss
} from './confirmModal.js';
import { escapeHtml } from '../../common/utils/escape.js';

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** 主进程 ContextDiagnosticsReport 的渲染子集（IPC 传输为纯数据，结构兼容即可） */
export interface ContextUsageReport {
    modelName?: string;
    contextWindow: number;
    totalEstimatedTokens: number;
    usageRatio?: number;
    categories: { name: string; tokens: number }[];
}

/** 主进程 ContextSuggestion 的渲染子集 */
export interface ContextUsageSuggestion {
    id: string;
    severity: 'info' | 'warn';
    title: string;
    detail: string;
}

export interface ContextUsageDiagnostics {
    report: ContextUsageReport;
    suggestions: ContextUsageSuggestion[];
}

/** 与 TUI /context 可视化页保持一致的四类配色 */
const CONTEXT_CATEGORY_COLORS: Record<string, string> = {
    'system prompt': '#FFAB00',
    tools: '#00C853',
    messages: '#9C4DFF',
    'free space': '#94A3B8'
};
const CONTEXT_CATEGORY_FALLBACK_COLORS = ['#42A5F5', '#EC407A', '#00ACC1', '#7E57C2'];
/** 报告中的类目名（英文）→ 本地化 key 与配色 */
const CONTEXT_CATEGORY_META: Record<string, { labelKey: string }> = {
    'system prompt': { labelKey: 'renderer.sidebar.contextUsageCategorySystemPrompt' },
    tools: { labelKey: 'renderer.sidebar.contextUsageCategoryTools' },
    messages: { labelKey: 'renderer.sidebar.contextUsageCategoryMessages' },
    'free space': { labelKey: 'renderer.sidebar.contextUsageCategoryFreeSpace' }
};
/** 建议 id → 本地化标题/详情 key */
const CONTEXT_SUGGESTION_LABEL_KEYS: Record<string, { titleKey: string; detailKey: string }> = {
    'near-auto-compact-threshold': {
        titleKey: 'renderer.sidebar.contextUsageSuggestNearCompact',
        detailKey: 'renderer.sidebar.contextUsageSuggestNearCompactDetail'
    },
    'tool-results-overweight': {
        titleKey: 'renderer.sidebar.contextUsageSuggestToolResults',
        detailKey: 'renderer.sidebar.contextUsageSuggestToolResultsDetail'
    },
    'system-prompt-overweight': {
        titleKey: 'renderer.sidebar.contextUsageSuggestSystemPrompt',
        detailKey: 'renderer.sidebar.contextUsageSuggestSystemPromptDetail'
    },
    'compact-summary-overweight': {
        titleKey: 'renderer.sidebar.contextUsageSuggestCompactSummary',
        detailKey: 'renderer.sidebar.contextUsageSuggestCompactSummaryDetail'
    }
};

/** 紧凑 token 计数格式：>=1M 显示 1.2m，>=1K 显示 52.3k（与 TUI context 页一致） */
export function formatCompactTokens(tokens: number): string {
    if (!Number.isFinite(tokens)) {
        return '0';
    }
    const abs = Math.abs(tokens);
    const sign = tokens < 0 ? '-' : '';
    const scaled = (value: number, suffix: string) => {
        if (value >= 100) {
            return `${Math.round(value)}${suffix}`;
        }
        return `${value.toFixed(1).replace(/\.0$/, '')}${suffix}`;
    };
    if (abs >= 1_000_000) {
        return `${sign}${scaled(abs / 1_000_000, 'm')}`;
    }
    if (abs >= 1_000) {
        return `${sign}${scaled(abs / 1_000, 'k')}`;
    }
    return `${sign}${Math.round(abs).toLocaleString('en-US')}`;
}

export function contextCategoryColor(name: string, fallbackIndex: number): string {
    const key = name.toLowerCase();
    return (
        CONTEXT_CATEGORY_COLORS[key] ??
        CONTEXT_CATEGORY_FALLBACK_COLORS[fallbackIndex % CONTEXT_CATEGORY_FALLBACK_COLORS.length]
    );
}

/** 圆点网格规格：与 TUI /context circle 可视化页一致的 10×10 = 100 格，每格 ≈ 1% 窗口 */
const GRID_COLUMNS = 10;
const GRID_ROWS = 10;

interface GridEntry {
    name: string;
    tokens: number;
    color: string;
    isFreeSpace: boolean;
}

interface AllocatedEntry extends GridEntry {
    squares: number;
    minimumSquares: number;
    remainder: number;
}

/**
 * 与 TUI allocateSquares 一致的整格分配：按 tokens/window 计算精确格数后向下取整，
 * 非空类目至少保留 1 格；超发时优先削减 free space，缺额时按余数降序轮转补齐。
 */
function allocateSquares(entries: GridEntry[], contextWindow: number, totalSquares: number): AllocatedEntry[] {
    const window_ = Math.max(contextWindow, 1);
    const allocated: AllocatedEntry[] = entries.map((entry) => {
        const exactSquares = (entry.tokens / window_) * totalSquares;
        const baseSquares = Math.floor(exactSquares);
        const minimumSquares = entry.isFreeSpace ? 0 : entry.tokens > 0 ? 1 : 0;
        return {
            ...entry,
            squares: Math.max(baseSquares, minimumSquares),
            minimumSquares,
            remainder: exactSquares - baseSquares
        };
    });

    let assigned = allocated.reduce((sum, entry) => sum + entry.squares, 0);
    if (assigned > totalSquares) {
        let overflow = assigned - totalSquares;
        const reducible = [...allocated].sort((a, b) => {
            if (a.isFreeSpace !== b.isFreeSpace) {
                return a.isFreeSpace ? -1 : 1;
            }
            const aFlex = a.squares - a.minimumSquares;
            const bFlex = b.squares - b.minimumSquares;
            if (aFlex !== bFlex) {
                return bFlex - aFlex;
            }
            return a.remainder - b.remainder;
        });
        for (const entry of reducible) {
            while (overflow > 0 && entry.squares > entry.minimumSquares) {
                entry.squares -= 1;
                overflow -= 1;
                assigned -= 1;
            }
        }
    }

    if (assigned < totalSquares) {
        let remaining = totalSquares - assigned;
        const priority = [...allocated].sort((a, b) => {
            if (a.remainder !== b.remainder) {
                return b.remainder - a.remainder;
            }
            if (a.isFreeSpace !== b.isFreeSpace) {
                return a.isFreeSpace ? 1 : -1;
            }
            return b.tokens - a.tokens;
        });
        for (let index = 0; remaining > 0; index = (index + 1) % priority.length) {
            priority[index]!.squares += 1;
            remaining -= 1;
        }
    }

    return allocated;
}

/** 生成圆点网格 HTML：实心为类目占用（内联类目色），空心（is-free）为剩余空间 */
function buildCircleGrid(allocated: AllocatedEntry[], totalSquares: number): string {
    const cells: string[] = [];
    for (const entry of allocated) {
        const circle = entry.isFreeSpace
            ? '<div class="od-contextusage-circle is-free"></div>'
            : `<div class="od-contextusage-circle" style="background: ${entry.color};"></div>`;
        for (let i = 0; i < entry.squares; i += 1) {
            cells.push(circle);
        }
    }
    const freeCircle = '<div class="od-contextusage-circle is-free"></div>';
    while (cells.length < totalSquares) {
        cells.push(freeCircle);
    }
    if (cells.length > totalSquares) {
        cells.length = totalSquares;
    }
    return `<div class="od-contextusage-grid">${cells.join('')}</div>`;
}

const MONO_FONT_STACK =
    "'Maple Mono', 'Cascadia Code', 'Fira Code', 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, 'HarmonyOS Sans', 'PingFang SC', 'Microsoft YaHei', monospace";

const CONTEXT_USAGE_CSS = `
    /* 上下文占比弹窗 · 基于 MODAL_CSS 顶部色带风格扩展 */
    .od-contextusage-summary {
        display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
        padding: 4px 0 10px;
    }
    .od-contextusage-percent {
        font-size: 26px; font-weight: 700; color: var(--mc-ink1); line-height: 1.1;
        font-family: ${MONO_FONT_STACK};
    }
    .od-contextusage-tokens {
        font-size: 12px; color: var(--mc-ink3);
        font-family: ${MONO_FONT_STACK};
    }
    .od-contextusage-model {
        font-size: 11.5px; color: var(--mc-ink3); padding-bottom: 10px;
        border-bottom: 1px solid var(--mc-line-soft);
    }
    .od-contextusage-model span { color: var(--mc-ink2); }
    /* 与 TUI /context circle 页一致的 10×10 圆点网格 */
    .od-contextusage-grid {
        display: grid; grid-template-columns: repeat(10, 1fr);
        gap: 5px; margin: 14px 0 4px;
    }
    .od-contextusage-circle {
        width: 11px; height: 11px; border-radius: 50%;
        justify-self: center;
    }
    .od-contextusage-circle.is-free {
        border: 1.5px solid #94A3B8; background: transparent;
    }
    .od-contextusage-granularity {
        font-size: 11px; color: var(--mc-ink4); padding-bottom: 8px;
    }
    .od-contextusage-legend { padding: 2px 0 6px; }
    .od-contextusage-legend-row {
        display: flex; align-items: center; gap: 8px;
        padding: 6px 0; border-bottom: 1px solid var(--mc-line-soft);
    }
    .od-contextusage-legend-row:last-child { border-bottom: none; }
    .od-contextusage-dot { width: 9px; height: 9px; border-radius: 3px; flex-shrink: 0; }
    /* 剩余空间图例图标与圆点网格的空心样式保持一致 */
    .od-contextusage-dot.is-free { border: 1.5px solid #94A3B8; background: transparent; }
    .od-contextusage-legend-name { font-size: 12.5px; color: var(--mc-ink2); flex: 1; min-width: 0; }
    .od-contextusage-legend-tokens {
        font-size: 12px; color: var(--mc-ink3);
        font-family: ${MONO_FONT_STACK};
    }
    .od-contextusage-legend-pct {
        font-size: 12px; color: var(--mc-ink2); width: 52px; text-align: right;
        font-family: ${MONO_FONT_STACK};
    }
    .od-contextusage-suggest-title {
        font-size: 11.5px; font-weight: 600; color: var(--mc-ink3);
        padding: 10px 0 4px;
    }
    .od-contextusage-suggestion {
        display: flex; gap: 8px; align-items: flex-start;
        padding: 7px 9px; border-radius: 8px; margin-bottom: 6px;
        background: var(--mc-hover);
    }
    .od-contextusage-suggestion i { font-size: 12px; margin-top: 2px; flex-shrink: 0; }
    .od-contextusage-suggestion.warn i { color: #F59E0B; }
    .od-contextusage-suggestion.info i { color: #3B82F6; }
    .od-contextusage-suggestion-body { min-width: 0; }
    .od-contextusage-suggestion-name { font-size: 12.5px; font-weight: 500; color: var(--mc-ink1); }
    .od-contextusage-suggestion-detail { font-size: 11.5px; color: var(--mc-ink3); line-height: 1.5; margin-top: 2px; }
    .od-contextusage-note {
        font-size: 11px; color: var(--mc-ink4); padding-top: 8px;
        border-top: 1px solid var(--mc-line-soft); margin-top: 6px;
    }
    .od-contextusage-loading {
        text-align: center; padding: 28px; color: var(--mc-ink3); font-size: 12.5px;
    }
    .od-contextusage-error {
        text-align: center; padding: 28px; color: var(--mc-red); font-size: 12.5px;
    }
`;

/**
 * 构建弹窗内容区 HTML。导出以便单测直接断言结构与文案。
 */
export function buildContextUsageContent(
    report: ContextUsageReport,
    suggestions: ContextUsageSuggestion[],
    t: Translate
): string {
    const window_ = Math.max(report.contextWindow, 0);
    const hasRatio = report.usageRatio !== undefined && Number.isFinite(report.usageRatio);
    const percentText = hasRatio ? `${(report.usageRatio! * 100).toFixed(1)}%` : 'n/a';
    // 与 TUI 一致：图例跳过 token 为 0 的类目，Free space 始终保留
    const legendEntries = report.categories
        .map((category, index) => ({
            ...category,
            color: contextCategoryColor(category.name, index),
            isFreeSpace: category.name.toLowerCase() === 'free space'
        }))
        .filter((entry) => entry.tokens > 0 || entry.isFreeSpace);
    const gridHtml = buildCircleGrid(
        allocateSquares(legendEntries, window_, GRID_COLUMNS * GRID_ROWS),
        GRID_COLUMNS * GRID_ROWS
    );

    const suggestionItems = (suggestions || [])
        .map((suggestion) => {
            const keys = CONTEXT_SUGGESTION_LABEL_KEYS[suggestion.id];
            const title = keys ? t(keys.titleKey) : suggestion.title;
            const detail = keys ? t(keys.detailKey) : suggestion.detail;
            return `<div class="od-contextusage-suggestion ${suggestion.severity === 'warn' ? 'warn' : 'info'}">
                <i class="fa-solid ${suggestion.severity === 'warn' ? 'fa-triangle-exclamation' : 'fa-circle-info'}"></i>
                <div class="od-contextusage-suggestion-body">
                    <div class="od-contextusage-suggestion-name">${escapeHtml(title)}</div>
                    <div class="od-contextusage-suggestion-detail">${escapeHtml(detail)}</div>
                </div>
            </div>`;
        })
        .join('');

    const legendRows = legendEntries
        .map((entry) => {
            const meta = CONTEXT_CATEGORY_META[entry.name.toLowerCase()];
            const label = meta ? t(meta.labelKey) : escapeHtml(entry.name);
            const pct = window_ > 0 ? `${((entry.tokens / window_) * 100).toFixed(1)}%` : 'n/a';
            return `<div class="od-contextusage-legend-row">
                <span class="od-contextusage-dot${entry.isFreeSpace ? ' is-free' : ''}"${entry.isFreeSpace ? '' : ` style="background: ${entry.color};"`}></span>
                <span class="od-contextusage-legend-name">${label}</span>
                <span class="od-contextusage-legend-tokens">${formatCompactTokens(entry.tokens)}</span>
                <span class="od-contextusage-legend-pct">${pct}</span>
            </div>`;
        })
        .join('');

    const modelRow = report.modelName
        ? `<div class="od-contextusage-model">${t('renderer.sidebar.taskInfoModel')} <span>${escapeHtml(report.modelName)}</span></div>`
        : '';

    return `
        <div class="od-contextusage-summary">
            <span class="od-contextusage-percent">${percentText}</span>
            <span class="od-contextusage-tokens">${formatCompactTokens(report.totalEstimatedTokens)} / ${formatCompactTokens(window_)}</span>
        </div>
        ${modelRow}
        ${gridHtml}
        <div class="od-contextusage-granularity">${t('renderer.sidebar.contextUsageCircleGranularity')}</div>
        <div class="od-contextusage-legend">${legendRows}</div>
        <div class="od-contextusage-suggest-title">${t('renderer.sidebar.contextUsageSuggestions')}</div>
        ${suggestionItems || `<div class="od-contextusage-suggestion info"><i class="fa-solid fa-circle-check"></i><div class="od-contextusage-suggestion-body"><div class="od-contextusage-suggestion-detail">${t('renderer.sidebar.contextUsageNoSuggestions')}</div></div></div>`}
        <div class="od-contextusage-note">${t('renderer.sidebar.contextUsageEstimateNote')}</div>`;
}

export interface ContextUsageModalDeps {
    /** 诊断数据获取，默认走 preload 的 taskManagerAPI.getContextDiagnostics */
    fetchDiagnostics?: (taskId: string) => Promise<ContextUsageDiagnostics>;
    /** 深色模式判定，默认复用 confirmModal 的 detectDarkMode */
    detectDark?: () => boolean;
}

/**
 * 展示上下文占比弹窗。loading 态 → 诊断数据渲染 / 错误态；
 * 关闭入口为关闭按钮与 ESC，点击遮罩不关闭（与任务详情弹窗一致）。
 * 返回 overlay 元素，便于测试与调用方在需要时主动清理。
 */
export function showContextUsageModal(taskId: string, t: Translate, deps: ContextUsageModalDeps = {}): HTMLElement {
    const fetchDiagnostics: (taskId: string) => Promise<ContextUsageDiagnostics> =
        deps.fetchDiagnostics ?? ((taskId) => window.taskManagerAPI.getContextDiagnostics(taskId));
    const isDark = deps.detectDark ? deps.detectDark() : detectDarkMode();

    const overlay = document.createElement('div');
    overlay.className = 'od-taskinfo-overlay od-confirm-modal-overlay';
    if (isDark) {
        overlay.classList.add('od-modal-dark');
    }
    overlay.innerHTML = `
<style>${MODAL_CSS}${CONTEXT_USAGE_CSS}</style>
<div class="od-confirm-modal-card">
    <div class="od-confirm-modal-banner info">
        <div class="od-confirm-modal-icon">${renderIcon('fa-chart-pie')}</div>
        <div class="od-confirm-modal-banner-text">
            <div class="od-confirm-modal-title">${t('renderer.sidebar.contextUsageTitle')}</div>
        </div>
        <button class="od-confirm-modal-close" data-action="close" aria-label="${t('renderer.sidebar.taskInfoClose')}">${CLOSE_SVG}</button>
    </div>
    <div class="od-confirm-modal-body">
        <div class="od-contextusage-content">
            <div class="od-contextusage-loading">
                <i class="fas fa-spinner fa-spin"></i> ${t('renderer.sidebar.taskInfoLoading')}
            </div>
        </div>
    </div>
    <div class="od-confirm-modal-footer">
        <button class="od-confirm-btn od-confirm-btn-primary" data-action="close">${t('renderer.sidebar.taskInfoClose')}</button>
    </div>
</div>`;

    let closed = false;
    const close = () => {
        if (closed) return;
        closed = true;
        overlay.classList.add('od-modal-leaving');
        setTimeout(() => overlay.remove(), MODAL_ANIM_DURATION_OUT);
        document.removeEventListener('keydown', escHandler);
    };
    const escHandler = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
            e.stopPropagation();
            close();
        }
    };
    document.addEventListener('keydown', escHandler);
    bindOverlayDismiss(overlay, close, (tgt) => {
        const el = tgt as HTMLElement | null;
        return !!el?.classList?.contains('od-confirm-modal-overlay');
    });
    overlay.querySelectorAll('[data-action="close"]').forEach((btn) => {
        btn.addEventListener('click', close);
    });
    document.body.appendChild(overlay);

    const content = overlay.querySelector('.od-contextusage-content') as HTMLElement;
    fetchDiagnostics(taskId)
        .then(({ report, suggestions }) => {
            if (closed) return;
            content.innerHTML = buildContextUsageContent(report, suggestions, t);
        })
        .catch((err: unknown) => {
            if (closed) return;
            const msg = err instanceof Error ? err.message : String(err);
            content.innerHTML = `<div class="od-contextusage-error">
                <i class="fas fa-triangle-exclamation"></i> ${t('renderer.sidebar.taskInfoLoadFailed')}${escapeHtml(msg)}
            </div>`;
        });

    return overlay;
}
