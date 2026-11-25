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

import {
    getSnapshot,
    getEntries,
    getDefaultWorkspace,
    subscribeEntries,
    subscribeDefaultWorkspace,
    subscribeSnapshot
} from './state.js';
import { normalizePath } from './tree/utils.js';

const SOURCES_STYLE_ID = 'filemgr-sources-styles';
const MINI_RING_CIRCUMFERENCE = 37.7;
const SKELETON_CARD_COUNT = 3;
export const WORKSPACE_SOURCE_PROTECTED_MESSAGE = '当前工作空间不能在这里移除。请回到主页面切换工作空间。';
const SOURCE_CONTROL_FALLBACKS = {
    'renderer.filemgr.source.progress.body': '关键词索引 · ${done}/${total}',
    'renderer.filemgr.source.progress.semantic': '语义索引 · ${done}/${total}',
    'renderer.filemgr.source.progress.completed': '索引完成',
    'renderer.filemgr.source.fullText.withCounts': '全文索引 · ${done} / ${total} 文件',
    'renderer.filemgr.source.ring.fullText': '全文索引 ${done}/${total}',
    'renderer.filemgr.source.ring.vector': '向量索引 ${done}/${total}',
    'renderer.filemgr.source.metadataWritePending': '此前部分文件的扫描结果保存失败，等待后续扫描确认恢复。',
    'renderer.filemgr.source.unavailable': '路径不可访问',
    'renderer.filemgr.source.unavailableWithCount': '路径不可访问 · 上次 ${count} 文件',
    'renderer.filemgr.source.empty': '未发现可扫描文件',
    'renderer.filemgr.source.fileCount': ' · ${count} 文件',
    'renderer.filemgr.source.scan.withCounts': '扫描中 · ${embedded} / ${total} 文件',
    'renderer.filemgr.source.scan.pending': '等待扫描',
    'renderer.filemgr.source.scan.scanning': '扫描中',
    'renderer.filemgr.source.scan.completed': '已完成',
    'renderer.filemgr.source.scan.unknown': '暂无扫描信息',
    'renderer.filemgr.mode.baseOnly': '基础索引',
    'renderer.filemgr.source.pause': 'Pause scanning',
    'renderer.filemgr.source.resume': 'Continue scanning',
    'renderer.filemgr.source.moreActions': 'More actions',
    'renderer.filemgr.source.remove': 'Remove scan path',
    'renderer.filemgr.source.pausing': 'Pausing…',
    'renderer.filemgr.source.resuming': 'Resuming…',
    'renderer.filemgr.source.paused': 'Paused',
    'renderer.filemgr.source.pausedWithCount': 'Paused · ${count} files',
    'renderer.filemgr.source.error.readonly': 'Pause state cannot be changed in query mode. Retry in the main window.',
    'renderer.filemgr.source.error.unknownRoot': 'This source no longer exists. Refresh and retry.',
    'renderer.filemgr.source.error.notReady': 'The file manager is not ready. Retry shortly.',
    'renderer.filemgr.source.error.persistenceFailed': 'The pause state could not be saved. Retry.',
    'renderer.filemgr.source.error.runtimeFailed': 'The pause or resume operation failed. Retry.',
    'renderer.filemgr.source.error.generic': 'The operation failed. Retry.'
};
const SOURCE_CONTROL_ERROR_KEYS = {
    readonly: 'renderer.filemgr.source.error.readonly',
    unknown_root: 'renderer.filemgr.source.error.unknownRoot',
    not_ready: 'renderer.filemgr.source.error.notReady',
    persistence_failed: 'renderer.filemgr.source.error.persistenceFailed',
    runtime_failed: 'renderer.filemgr.source.error.runtimeFailed',
    invalid_request: 'renderer.filemgr.source.error.generic',
    generic: 'renderer.filemgr.source.error.generic'
};

function sourceControlText(options, key, vars = {}) {
    const translated = options.t?.(key, vars);
    const template = translated && translated !== key ? translated : (SOURCE_CONTROL_FALLBACKS[key] ?? key);
    return template.replace(/\$\{(\w+)\}/g, (_match, name) => String(vars[name] ?? ''));
}

function resolveDocument(documentOverride) {
    const doc = documentOverride || globalThis.document;
    if (!doc) {
        throw new Error('createSources requires a DOM document.');
    }

    return doc;
}

function getSnapshotData(snapshot) {
    return snapshot?.data || snapshot || {};
}

function toNumber(value, fallback = 0) {
    if (value == null || value === '') return fallback;
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : fallback;
}

const MAX_FULL_PATH_LENGTH = 28;
const MAX_FULL_LEAF_LENGTH = 4;
const MAX_LEAF_DISPLAY_LENGTH = 18;

function middleEllipsizeLeaf(leaf) {
    if (leaf.length <= MAX_LEAF_DISPLAY_LENGTH) {
        return leaf;
    }

    const headLength = 7;
    const tailLength = 3;
    return `${leaf.slice(0, headLength)}…${leaf.slice(-tailLength)}`;
}

export function formatDisplayPath(path) {
    if (!path || typeof path !== 'string') {
        return '未命名数据源';
    }

    const normalizedPath = path.replace(/[\\/]+$/, '');
    const separator = normalizedPath.includes('\\') && !normalizedPath.includes('/') ? '\\' : '/';
    const parts = normalizedPath.split(/[\\/]+/).filter(Boolean);
    const leaf = parts.at(-1) ?? normalizedPath;
    const canShowFullPath =
        parts.length === 0 ||
        (normalizedPath.length <= MAX_FULL_PATH_LENGTH &&
            (parts.length <= 2 || (parts.length <= 3 && leaf.length <= MAX_FULL_LEAF_LENGTH)));

    if (canShowFullPath) {
        return path;
    }

    return `…${separator}${middleEllipsizeLeaf(leaf)}`;
}

function getMode(data) {
    return data.mode ?? data.storage?.mode ?? null;
}

function getStatus(data) {
    return typeof data.status === 'string' ? data.status : 'idle';
}

function getSourceArray(data) {
    if (Array.isArray(data.sources)) {
        return data.sources;
    }

    if (Array.isArray(data.storage?.sources)) {
        return data.storage.sources;
    }

    if (Array.isArray(data.scanners)) {
        return data.scanners;
    }

    if (Array.isArray(data.entries)) {
        return data.entries;
    }

    return [];
}

function getUnavailableInfo(source, data, path) {
    const unavailableRoots = data.unavailable_roots ?? data.storage?.unavailable_roots ?? {};
    const unavailableRoot = unavailableRoots?.[path] ?? null;

    if (
        !unavailableRoot &&
        source?.state !== 'unavailable' &&
        source?.status !== 'unavailable' &&
        source?.unavailable !== true
    ) {
        return null;
    }

    return {
        lastCount: toNumber(
            source?.last_file_count ??
                source?.last_count ??
                source?.lastCount ??
                unavailableRoot?.last_count ??
                unavailableRoot?.lastCount ??
                source?.total_files ??
                source?.totalFiles,
            null
        )
    };
}

function normalizeSource(source, entry, data, index) {
    const path = entry.root;
    return {
        raw: source ?? null,
        id: path,
        path,
        index,
        hasBackend: Boolean(source),
        metadataWritePending: source?.metadata_write_pending === true,
        totalFiles: toNumber(source?.total_files ?? source?.totalFiles, null),
        embeddedCount: toNumber(source?.embedded_count ?? source?.embeddedCount, null),
        failedCount: toNumber(source?.failed_count ?? source?.failedCount, null),
        fullText:
            data.full_text && !['unsupported', 'open_failed', 'tokenizer_unavailable'].includes(data.full_text.reason)
                ? (source?.full_text ?? null)
                : null,
        lastScanAt: source?.last_scan_at ?? source?.lastScanAt ?? source?.last_full_scan ?? null,
        unavailableInfo: source ? getUnavailableInfo(source, data, path) : null,
        workspace: Boolean(getDefaultWorkspace()) && normalizePath(path) === normalizePath(getDefaultWorkspace()),
        paused: source?.paused === true,
        state: source?.state ?? source?.status ?? null,
        isRunning: source?.isRunning === true
    };
}

function getSortedSources(data) {
    const backend = new Map(
        getSourceArray(data).map((source) => [source?.root ?? source?.path ?? source?.entry?.root, source])
    );
    return getEntries()
        .map((entry, index) => normalizeSource(backend.get(entry.root), entry, data, index))
        .sort((a, b) => Number(b.workspace) - Number(a.workspace) || a.index - b.index);
}

function getDisplayState(source) {
    if (!source.hasBackend) return 'unknown';
    if (source.paused) return 'paused';
    if (source.unavailableInfo) return 'unavailable';
    if (source.metadataWritePending) return 'pending';
    if (source.isRunning) return 'scanning';
    return ['pending', 'scanning', 'completed', 'unavailable'].includes(source.state) ? source.state : 'unknown';
}

function getProgress(source, displayState, mode) {
    const empty = { fullText: null, vector: null };
    if (
        !source.hasBackend ||
        (source.metadataWritePending && displayState !== 'paused' && displayState !== 'unavailable') ||
        source.totalFiles === null ||
        displayState === 'unknown'
    )
        return empty;
    let vector = displayState === 'completed' ? 100 : 0;
    if (displayState === 'scanning' && source.totalFiles > 0) {
        vector =
            source.embeddedCount === null
                ? null
                : Math.max(0, Math.min(100, Math.round((source.embeddedCount / source.totalFiles) * 100)));
    }
    const fullText = source.fullText
        ? !['scanning', 'completed'].includes(displayState)
            ? 0
            : source.fullText.pending === 0
              ? 100
              : Math.max(
                    0,
                    Math.min(
                        100,
                        Math.round(((source.fullText.done + source.fullText.excluded) / (source.totalFiles || 1)) * 100)
                    )
                )
        : null;
    return { fullText, vector: mode === 'base-only' && source.fullText ? null : vector };
}

let progressTooltipId = 0;

function progressLabels(source, progress, options) {
    const labels = [];
    if (progress.fullText !== null)
        labels.push({
            kind: 'full-text',
            text: sourceControlText(options, 'renderer.filemgr.source.progress.body', {
                done: source.fullText.done + source.fullText.excluded,
                total: source.totalFiles
            })
        });
    if (progress.vector !== null)
        labels.push({
            kind: 'vector',
            text: sourceControlText(options, 'renderer.filemgr.source.progress.semantic', {
                done: source.embeddedCount ?? 0,
                total: source.totalFiles
            })
        });
    return labels;
}

function createProgressTooltip(doc, row, status) {
    const id = `filemgr-progress-tooltip-${++progressTooltipId}`;
    const view = doc.defaultView;
    let labels = [];
    let tooltip = null;
    const hide = () => {
        tooltip?.remove();
        tooltip = null;
        status.removeAttribute('aria-describedby');
    };
    const position = () => {
        if (!tooltip) return;
        const rect = row.getBoundingClientRect?.();
        if (!rect) return;
        const bounds = tooltip.getBoundingClientRect();
        const width = view.innerWidth || 1024;
        const height = view.innerHeight || 768;
        tooltip.style.left = `${Math.max(8, Math.min(rect.left, width - bounds.width - 8))}px`;
        tooltip.style.top = `${Math.max(
            8,
            rect.bottom + 8 + bounds.height <= height - 8 ? rect.bottom + 8 : rect.top - bounds.height - 8
        )}px`;
    };
    const render = () => {
        if (!tooltip) return;
        for (let i = 0; i < labels.length; i++) {
            let line = tooltip.children[i];
            if (!line) {
                line = doc.createElement('div');
                const dot = doc.createElement('span');
                dot.setAttribute('aria-hidden', 'true');
                const label = doc.createElement('span');
                label.className = 'fs-progress-tooltip-label';
                line.append(dot, label);
                tooltip.append(line);
            }
            updateAttribute(line.firstChild, 'class', `fs-progress-tooltip-dot ${labels[i].kind}`);
            updateText(line.lastChild, labels[i].text);
        }
        while (tooltip.children.length > labels.length) tooltip.lastChild.remove();
        position();
    };
    const show = () => {
        if (!labels.length || tooltip) return;
        tooltip = doc.createElement('div');
        tooltip.id = id;
        tooltip.className = 'fs-progress-tooltip';
        tooltip.setAttribute('role', 'tooltip');
        doc.body.append(tooltip);
        status.setAttribute('aria-describedby', id);
        render();
    };
    const isTrigger = (target) => target && row.contains(target) && target.closest?.('.mini-ring, .status-text');
    row.addEventListener('pointerover', (event) => {
        if (isTrigger(event.target)) show();
    });
    row.addEventListener('pointerout', (event) => {
        if (!isTrigger(event.relatedTarget)) hide();
    });
    status.addEventListener('focus', show);
    status.addEventListener('blur', hide);
    const onKey = (event) => {
        if (event.key === 'Escape') hide();
    };
    doc.addEventListener('keydown', onKey);
    view?.addEventListener('scroll', hide, true);
    view?.addEventListener('resize', hide);
    return {
        update(nextLabels) {
            labels = nextLabels;
            updateAttribute(status, 'aria-label', labels.length ? labels.map((label) => label.text).join('\n') : null);
            updateAttribute(status, 'tabindex', labels.length ? '0' : null);
            if (!labels.length) hide();
            else render();
        },
        destroy() {
            hide();
            doc.removeEventListener('keydown', onKey);
            view?.removeEventListener('scroll', hide, true);
            view?.removeEventListener('resize', hide);
        }
    };
}

function getStatusText(source, displayState, mode, options) {
    if (!source.hasBackend) return sourceControlText(options, 'renderer.filemgr.source.scan.pending');
    const pendingPaused = options.pendingByRoot?.get(source.path);
    if (pendingPaused === true) return sourceControlText(options, 'renderer.filemgr.source.pausing');
    if (pendingPaused === false) return sourceControlText(options, 'renderer.filemgr.source.resuming');
    if (displayState === 'paused') {
        return sourceControlText(
            options,
            source.totalFiles === null ? 'renderer.filemgr.source.paused' : 'renderer.filemgr.source.pausedWithCount',
            { count: source.totalFiles }
        );
    }
    if (displayState === 'unavailable') {
        const count = source.unavailableInfo?.lastCount ?? source.totalFiles;
        return sourceControlText(
            options,
            count === null ? 'renderer.filemgr.source.unavailable' : 'renderer.filemgr.source.unavailableWithCount',
            { count }
        );
    }
    if (source.metadataWritePending) return sourceControlText(options, 'renderer.filemgr.source.metadataWritePending');
    if (displayState === 'completed' && source.totalFiles === 0)
        return sourceControlText(options, 'renderer.filemgr.source.empty');
    const countText =
        source.totalFiles === null
            ? ''
            : sourceControlText(options, 'renderer.filemgr.source.fileCount', { count: source.totalFiles });
    if (displayState === 'completed')
        return sourceControlText(options, 'renderer.filemgr.source.progress.completed') + countText;
    if (displayState === 'pending') return sourceControlText(options, 'renderer.filemgr.source.scan.pending');
    if (displayState === 'scanning' && source.totalFiles !== null) {
        const body = source.fullText ? source.fullText.done + source.fullText.excluded : null;
        const semantic = mode === 'base-only' ? null : source.embeddedCount;
        const showBody = body !== null && (source.fullText.pending > 0 || mode === 'base-only');
        const done = showBody ? body : semantic;
        if (done !== null)
            return sourceControlText(
                options,
                showBody ? 'renderer.filemgr.source.progress.body' : 'renderer.filemgr.source.progress.semantic',
                { done, total: source.totalFiles }
            );
    }
    return sourceControlText(options, `renderer.filemgr.source.scan.${displayState}`);
}

function injectStyles(doc) {
    if (doc.getElementById(SOURCES_STYLE_ID)) {
        return;
    }

    const style = doc.createElement('style');
    style.id = SOURCES_STYLE_ID;
    style.textContent = `
.fs-progress-tooltip {
    position: fixed;
    z-index: 10000;
    pointer-events: none;
    padding: 10px 12px;
    border: 1px solid var(--od-border, #d5dbe3);
    border-radius: 9px;
    background: var(--od-bg-elevated, #fff);
    color: var(--od-text, #202530);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
    font-family: inherit;
    font-size: 12px;
    line-height: 1.6;
    font-variant-numeric: tabular-nums;
    max-width: calc(100vw - 16px);
    overflow-wrap: anywhere;
}
.fs-progress-tooltip > div { display: flex; align-items: center; gap: 8px; }
.fs-progress-tooltip > div + div { margin-top: 3px; }
.fs-progress-tooltip-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.fs-progress-tooltip-dot.full-text { background: color-mix(in srgb, var(--od-accent, #2563eb) 50%, white); }
.fs-progress-tooltip-dot.vector { background: var(--od-accent, #2563eb); }
.fs-upper {
    --filemgr-success: #10b981;
    --filemgr-danger: #ef4444;
    --filemgr-danger-bg: color-mix(in srgb, var(--filemgr-danger) 10%, var(--od-bg-elevated));
    --filemgr-radius-card-sm: 12px;
    --filemgr-radius-icon: 9px;
    --filemgr-shadow-card: 0 0 0 1px var(--od-border), 0 8px 24px rgba(0, 0, 0, 0.05);
    --filemgr-shadow-card-hover: 0 0 0 1px var(--od-border-strong), 0 12px 30px rgba(0, 0, 0, 0.08);
    --filemgr-ease-out: cubic-bezier(0.16, 1, 0.3, 1);
    flex: 0 0 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    width: 100%;
    container-type: inline-size;
}

.fs-upper .fs-sources {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    align-content: start;
    gap: 10px;
    overflow-y: auto;
    max-height: 196px;
    padding: 2px 7px 4px 2px;
    scrollbar-width: thin;
    scrollbar-color: color-mix(in srgb, var(--od-text-muted) 42%, transparent) transparent;
    scrollbar-gutter: stable;
    flex: 1;
    min-width: 0;
    min-height: 0;
    transition: opacity 180ms ease;
}

.fs-upper .fs-sources::-webkit-scrollbar {
    width: 8px;
}

.fs-upper .fs-sources::-webkit-scrollbar-track {
    background: transparent;
}

.fs-upper .fs-sources::-webkit-scrollbar-thumb {
    min-height: 36px;
    border: 2px solid transparent;
    border-radius: 999px;
    background: color-mix(in srgb, var(--od-text-muted) 42%, transparent);
    background-clip: content-box;
}

.fs-upper .fs-sources::-webkit-scrollbar-thumb:hover {
    background: color-mix(in srgb, var(--od-text-muted) 64%, transparent);
    background-clip: content-box;
}

.fs-upper .fs-sources::-webkit-scrollbar-corner {
    background: transparent;
}

.fs-upper .fs-sources.fs-error-layer {
    opacity: 0.5;
}

.fs-upper .fs-anim {
    animation: filemgr-source-enter 260ms var(--filemgr-ease-out) both;
}

.fs-upper .fs-anim-delay-1 {
    animation-delay: 40ms;
}

.fs-upper .fs-source-card {
    position: relative;
    min-width: 0;
    min-height: 74px;
    background: var(--od-bg-elevated);
    border-radius: var(--filemgr-radius-card-sm);
    padding: 11px 12px;
    display: flex;
    gap: 10px;
    align-items: center;
    box-shadow: var(--filemgr-shadow-card);
    transition: transform 0.22s var(--filemgr-ease-out), box-shadow 0.22s;
    overflow: hidden;
    box-sizing: border-box;
}

.fs-upper .fs-source-card:hover {
    transform: translateY(-1px);
    box-shadow: var(--filemgr-shadow-card-hover);
}

.fs-upper .fs-source-card.unavailable {
    opacity: 0.55;
}

.fs-upper .fs-source-card .icon-box {
    width: 32px;
    height: 32px;
    border-radius: var(--filemgr-radius-icon);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    position: relative;
    box-shadow: inset 0 0 0 0.5px rgba(0, 0, 0, 0.04), inset 0 1px 0 rgba(255, 255, 255, 0.5);
}

.fs-upper .fs-source-card.workspace .icon-box {
    background: color-mix(in srgb, var(--od-accent) 14%, var(--od-bg-elevated));
    color: var(--od-accent);
}

.fs-upper .fs-source-card.normal .icon-box {
    background: var(--od-bg-muted);
    color: var(--od-text-muted);
}

.fs-upper .fs-source-card.unavailable .icon-box {
    background: var(--od-bg-muted);
    color: var(--od-text-disabled);
}

.fs-upper .fs-source-card .folder-shape,
.fs-upper .fs-source-card .workspace-shape {
    position: relative;
    width: 20px;
    height: 15px;
    border-radius: 4px;
    background: currentColor;
}

.fs-upper .fs-source-card .folder-shape::before,
.fs-upper .fs-source-card .workspace-shape::before {
    content: '';
    position: absolute;
    left: 1px;
    top: -4px;
    width: 10px;
    height: 5px;
    border-radius: 4px 4px 0 0;
    background: currentColor;
    opacity: 0.78;
}

.fs-upper .fs-source-card .workspace-shape::after {
    content: '';
    position: absolute;
    left: 7px;
    top: 5px;
    width: 6px;
    height: 6px;
    border-radius: 2px;
    background: #ffffff;
    opacity: 0.72;
}

.fs-upper .fs-source-card .warning-corner {
    position: absolute;
    right: 4px;
    bottom: 4px;
    width: 0;
    height: 0;
    border-left: 5px solid transparent;
    border-right: 5px solid transparent;
    border-bottom: 9px solid #9ca3af;
}

.fs-upper .fs-source-card .warning-corner::after {
    content: '';
    position: absolute;
    left: -1px;
    top: 3px;
    width: 2px;
    height: 2px;
    border-radius: 50%;
    background: #ffffff;
    box-shadow: 0 -3px 0 #ffffff;
}

.fs-upper .fs-source-card .info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.fs-upper .fs-source-card .row1 {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
}

.fs-upper .fs-source-card .path {
    flex: 1 1 auto;
    min-width: 0;
    max-width: 100%;
    color: var(--od-text);
    font-size: 13px;
    font-weight: 500;
    line-height: 1.3;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
    unicode-bidi: plaintext;
    letter-spacing: 0;
}

.fs-upper .source-actions {
    flex-shrink: 0;
}

.fs-upper .source-menu-trigger {
    width: 28px;
    height: 28px;
    border: none;
    background: transparent;
    color: var(--od-text-muted);
    border-radius: 8px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0.68;
    transition: color 150ms ease, background 150ms ease, opacity 150ms ease;
}

.fs-upper .source-menu-trigger:hover,
.fs-upper .source-actions.open .source-menu-trigger {
    color: var(--od-text);
    background: var(--od-bg-muted);
    opacity: 1;
}

.fs-upper .source-menu-trigger:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--od-accent) 72%, transparent);
    outline-offset: 2px;
}

.fs-upper .source-menu-dots,
.fs-upper .source-menu-dots::before,
.fs-upper .source-menu-dots::after {
    width: 3px;
    height: 3px;
    border-radius: 50%;
    background: currentColor;
}

.fs-upper .source-menu-dots {
    position: relative;
}

.fs-upper .source-menu-dots::before,
.fs-upper .source-menu-dots::after {
    content: '';
    position: absolute;
    top: 0;
}

.fs-upper .source-menu-dots::before {
    left: -5px;
}

.fs-upper .source-menu-dots::after {
    right: -5px;
}

.filemgr-source-menu-portal {
    --filemgr-danger: #ef4444;
    --filemgr-danger-bg: color-mix(in srgb, var(--filemgr-danger) 10%, var(--od-bg-elevated));
    position: fixed;
    z-index: 10000;
    min-width: 132px;
    padding: 5px;
    border: 1px solid color-mix(in srgb, var(--od-border) 82%, transparent);
    border-radius: 10px;
    background: color-mix(in srgb, var(--od-bg-elevated) 96%, transparent);
    box-shadow:
        0 12px 30px rgba(0, 0, 0, 0.18),
        0 2px 8px rgba(0, 0, 0, 0.08);
    backdrop-filter: blur(16px);
}

.filemgr-source-menu-portal[hidden] {
    display: none;
}

.filemgr-source-menu-portal .source-menu-item {
    width: 100%;
    height: 30px;
    padding: 0 9px;
    border: none;
    border-radius: 7px;
    background: transparent;
    color: var(--od-text);
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11.5px;
    font-weight: 500;
    line-height: 1;
    text-align: left;
    white-space: nowrap;
    transition: color 140ms ease, background 140ms ease;
}

.filemgr-source-menu-portal .source-menu-item:hover {
    background: var(--od-bg-muted);
}

.filemgr-source-menu-portal .source-menu-item[data-action='pause']:hover {
    color: #d99035;
    background: color-mix(in srgb, #d99035 10%, transparent);
}

.filemgr-source-menu-portal .source-menu-remove {
    color: var(--filemgr-danger);
}

.filemgr-source-menu-portal .source-menu-remove:hover {
    background: var(--filemgr-danger-bg);
}

.filemgr-source-menu-portal .source-menu-item:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--od-accent) 68%, transparent);
    outline-offset: -2px;
}

.fs-upper .source-resume-btn {
    flex-shrink: 0;
    height: 24px;
    padding: 0 9px 0 7px;
    border: 1px solid color-mix(in srgb, var(--od-accent) 24%, transparent);
    border-radius: 999px;
    background: color-mix(in srgb, var(--od-accent) 9%, transparent);
    color: var(--od-accent);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    font-size: 11px;
    font-weight: 600;
    line-height: 1;
    white-space: nowrap;
    transition:
        color 150ms ease,
        background 150ms ease,
        border-color 150ms ease,
        transform 150ms var(--filemgr-ease-out);
}

.fs-upper .source-resume-btn:hover {
    background: color-mix(in srgb, var(--od-accent) 15%, transparent);
    border-color: color-mix(in srgb, var(--od-accent) 42%, transparent);
    transform: translateY(-1px);
}

.fs-upper .source-resume-btn:active {
    transform: translateY(0) scale(0.97);
}

.fs-upper .source-resume-btn:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--od-accent) 72%, transparent);
    outline-offset: 2px;
}

.fs-upper .source-control-icon,
.filemgr-source-menu-portal .source-control-icon {
    position: relative;
    width: 12px;
    height: 12px;
    flex: 0 0 12px;
    display: inline-block;
}

.filemgr-source-menu-portal [data-action='pause'] .source-control-icon::before,
.filemgr-source-menu-portal [data-action='pause'] .source-control-icon::after {
    content: '';
    position: absolute;
    top: 2px;
    width: 3px;
    height: 8px;
    border-radius: 1.5px;
    background: currentColor;
}

.filemgr-source-menu-portal [data-action='pause'] .source-control-icon::before {
    left: 2px;
}

.filemgr-source-menu-portal [data-action='pause'] .source-control-icon::after {
    right: 2px;
}

.fs-upper [data-action='resume'] .source-control-icon::before {
    content: '';
    position: absolute;
    left: 3px;
    top: 1.5px;
    width: 0;
    height: 0;
    border-top: 4.5px solid transparent;
    border-bottom: 4.5px solid transparent;
    border-left: 7px solid currentColor;
}

.fs-upper .source-control-label,
.filemgr-source-menu-portal .source-control-label {
    transform: translateY(-0.25px);
}

.fs-upper .source-control-btn:disabled,
.filemgr-source-menu-portal .source-menu-item:disabled {
    cursor: default;
    opacity: 0.5;
}

.fs-upper .source-resume-btn:disabled {
    color: var(--od-text-muted);
    background: var(--od-bg-muted);
    border-color: var(--od-border);
    transform: none;
}

.filemgr-source-menu-portal .source-menu-item:disabled {
    background: transparent;
}

.fs-upper .fs-source-control-error {
    color: var(--filemgr-danger);
    font-size: 11px;
    line-height: 1.3;
}

@keyframes filemgr-source-control-spin {
    to { transform: rotate(360deg); }
}

.fs-upper .source-control-spinner {
    width: 12px;
    height: 12px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: filemgr-source-control-spin 800ms linear infinite;
}

.fs-upper .fs-source-card .fs-file-alert {
    flex-shrink: 0;
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    border-radius: 999px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: #fff7ed;
    color: #c2410c;
    box-shadow: inset 0 0 0 1px rgba(251, 146, 60, 0.34);
    font-size: 10px;
    font-weight: 600;
    line-height: 1;
    font-variant-numeric: tabular-nums;
}

.fs-upper .fs-source-card .row3 {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
    color: var(--od-text-muted);
    font-size: 11px;
    line-height: 1.3;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0;
    white-space: nowrap;
}

.fs-upper .fs-source-card .status-text {
    flex: 1 1 auto;
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.fs-upper .fs-source-card .time-tag {
    margin-left: auto;
    color: var(--od-text-muted);
    font-size: 10.5px;
    font-weight: 500;
    opacity: 0.72;
    flex-shrink: 0;
}

.fs-upper .fs-source-card .fs-mini-ring,
.fs-upper .fs-source-card .mini-ring {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    transform: rotate(-90deg);
}

.fs-upper .fs-source-card .mini-ring .track {
    fill: none;
    stroke: var(--od-border);
    stroke-width: 2.5;
}

.fs-upper .fs-source-card .mini-ring .fill {
    fill: none;
    stroke: var(--od-accent);
    stroke-width: 2.5;
    stroke-linecap: round;
    stroke-dasharray: 37.7;
    stroke-dashoffset: 37.7;
    transition: stroke-dashoffset 0.9s var(--filemgr-ease-out), stroke 0.3s;
}

.fs-upper .fs-source-card .mini-ring.dual .track,
.fs-upper .fs-source-card .mini-ring.dual .fill {
    stroke-width: 1.6;
}

.fs-upper .fs-source-card .mini-ring .fill.full-text {
    stroke: color-mix(in srgb, var(--od-accent) 50%, white);
}

.fs-upper .fs-source-card .mini-ring .fill.vector {
    stroke: var(--od-accent);
}

.fs-upper .fs-source-card.scan-done .mini-ring .fill {
    stroke: var(--filemgr-success);
}

.fs-upper .fs-source-card .status-accent {
    color: var(--od-accent);
    font-weight: 600;
}

.fs-upper .fs-source-card.scan-done .status-accent {
    color: var(--filemgr-success);
}

.fs-upper .fs-warning-icon {
    position: relative;
    width: 0;
    height: 0;
    flex-shrink: 0;
    border-left: 7px solid transparent;
    border-right: 7px solid transparent;
    border-bottom: 13px solid #9ca3af;
}

.fs-upper .fs-warning-icon::after {
    content: '';
    position: absolute;
    left: -1px;
    top: 4px;
    width: 2px;
    height: 2px;
    border-radius: 50%;
    background: #ffffff;
    box-shadow: 0 -4px 0 #ffffff;
}

.fs-upper .fs-source-card.empty,
.fs-upper .fs-source-card.skeleton {
    border: 1px dashed var(--od-border-strong);
    box-shadow: none;
    background: var(--od-bg-muted);
}

.fs-upper .fs-source-card.empty {
    min-height: 74px;
    justify-content: center;
    color: var(--od-text-muted);
    text-align: center;
}

.fs-upper .fs-source-card.empty:hover,
.fs-upper .fs-source-card.skeleton:hover {
    transform: none;
    box-shadow: none;
}

.fs-upper .fs-empty-content {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    min-width: 0;
    font-size: 12.5px;
    font-weight: 500;
    line-height: 1.35;
}

.fs-upper .fs-empty-icon {
    position: relative;
    width: 24px;
    height: 18px;
    border-radius: 5px;
    background: var(--od-border-strong);
    flex-shrink: 0;
}

.fs-upper .fs-empty-icon::before {
    content: '';
    position: absolute;
    left: 2px;
    top: -5px;
    width: 11px;
    height: 6px;
    border-radius: 4px 4px 0 0;
    background: var(--od-border-strong);
}

.fs-upper .fs-empty-icon::after {
    content: '+';
    position: absolute;
    right: -5px;
    bottom: -5px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--od-bg-elevated);
    color: var(--od-text-muted);
    font-size: 12px;
    font-weight: 700;
    line-height: 14px;
    box-shadow: 0 0 0 1px var(--od-border-strong);
}

.fs-upper .fs-source-card.skeleton {
    min-height: 74px;
}

.fs-upper .fs-skeleton-line {
    height: 9px;
    border-radius: 999px;
    background: var(--od-bg-muted);
}

.fs-upper .fs-skeleton-line.path-line {
    width: 78%;
}

.fs-upper .fs-skeleton-line.meta-line {
    width: 48%;
}

.fs-upper .fs-skeleton-line.status-line {
    width: 66%;
}

.fs-upper .fs-source-card.skeleton .icon-box {
    background: var(--od-bg-subtle);
    box-shadow: none;
}

@container (min-width: 480px) {
    .fs-upper .fs-sources {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }
}

@container (min-width: 600px) {
    .fs-upper .fs-sources {
        grid-template-columns: repeat(3, minmax(0, 1fr));
    }
}

@container (min-width: 1200px) {
    .fs-upper .fs-sources {
        grid-template-columns: repeat(4, minmax(0, 1fr));
    }
}

@keyframes filemgr-source-enter {
    from {
        opacity: 0;
        transform: translateY(8px);
    }

    to {
        opacity: 1;
        transform: translateY(0);
    }
}

@media (prefers-reduced-motion: reduce) {
    .fs-upper .source-control-spinner {
        animation: none;
    }

    .fs-upper .fs-anim,
    .fs-upper .fs-skeleton-line,
    .fs-upper .fs-source-card,
    .fs-upper .fs-source-card .mini-ring .fill {
        animation: none;
        transition: none;
    }
}
`;
    doc.head.appendChild(style);
}

export function formatLastScan(lastScanAt) {
    if (!lastScanAt) {
        return '等待首次扫描';
    }

    const timestamp = typeof lastScanAt === 'string' ? Date.parse(lastScanAt) : Number(lastScanAt);
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
        return '等待首次扫描';
    }

    const diffMs = Math.max(0, Date.now() - timestamp);
    const diffMinutes = Math.floor(diffMs / (60 * 1000));
    if (diffMinutes < 1) {
        return '刚刚';
    }

    if (diffMinutes < 60) {
        return `${diffMinutes} 分钟前`;
    }

    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) {
        return `${diffHours} 小时前`;
    }

    return `${Math.floor(diffHours / 24)} 天前`;
}

function createMiniRing(doc, progress) {
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('fs-mini-ring', 'mini-ring');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');

    updateMiniRing(doc, svg, progress);
    return svg;
}

function updateMiniRing(doc, svg, progress) {
    const layers = [
        ['full-text', progress.fullText],
        ['vector', progress.vector]
    ];
    for (const [name, value] of layers) {
        if (value === null) svg.querySelector(`.fill.${name}`)?.remove();
    }
    const active = layers.filter(([, value]) => value !== null);
    const dual = active.length === 2;
    if (svg.classList.contains('dual') !== dual) svg.classList.toggle('dual', dual);
    for (const name of ['full-text', 'vector']) {
        if (!active.some(([key]) => key === name)) svg.querySelector(`.track.${name}`)?.remove();
    }
    for (const [name, value] of active) {
        const radius = dual && name === 'vector' ? 3 : 6;
        for (const kind of ['track', 'fill']) {
            let circle = svg.querySelector(`.${kind}.${name}`);
            if (!circle) {
                circle = doc.createElementNS('http://www.w3.org/2000/svg', 'circle');
                circle.classList.add(kind, name);
                circle.setAttribute('cx', '8');
                circle.setAttribute('cy', '8');
                svg.append(circle);
            }
            updateAttribute(circle, 'r', radius);
            if (kind === 'fill') {
                const circumference = radius === 6 ? MINI_RING_CIRCUMFERENCE : 2 * Math.PI * radius;
                const dash = String(circumference);
                const offset = String(circumference * (1 - value / 100));
                if (circle.style.strokeDasharray !== dash) circle.style.strokeDasharray = dash;
                if (circle.style.strokeDashoffset !== offset) circle.style.strokeDashoffset = offset;
                const visibility = value === 0 ? 'hidden' : 'visible';
                if (circle.style.visibility !== visibility) circle.style.visibility = visibility;
            }
        }
    }
}

function createIconBox(doc, source, displayState) {
    const iconBox = doc.createElement('span');
    iconBox.className = 'icon-box';
    iconBox.setAttribute('aria-hidden', 'true');

    const shape = doc.createElement('span');
    shape.className = source.workspace && displayState !== 'unavailable' ? 'workspace-shape' : 'folder-shape';
    iconBox.appendChild(shape);

    if (displayState === 'unavailable') {
        const warning = doc.createElement('span');
        warning.className = 'warning-corner';
        iconBox.appendChild(warning);
    }

    return iconBox;
}

function createDeleteButton(doc, getSource, options) {
    const source = getSource();
    const removeText = sourceControlText(options, 'renderer.filemgr.source.remove');
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'source-menu-item source-menu-remove';
    button.setAttribute('role', 'menuitem');
    button.title = removeText;
    button.setAttribute('aria-label', `${removeText}: ${source.path}`);
    button.textContent = removeText;
    button.disabled = options.pendingByRoot?.has(source.path) === true;
    button.addEventListener('click', (event) => {
        event.stopPropagation();
        const source = getSource();
        if (!source || button.disabled || options.pendingByRoot?.has(source.path)) return;
        options.sourceMenuPortal.closeFor(button.closest('.filemgr-source-menu-portal'), { restoreFocus: true });
        if (source.workspace) {
            const protectedPayload = {
                root: source.path,
                message: WORKSPACE_SOURCE_PROTECTED_MESSAGE
            };
            const CustomEventConstructor = doc.defaultView?.CustomEvent ?? globalThis.CustomEvent;
            button.dispatchEvent(
                new CustomEventConstructor('filemgr:protected-workspace-delete', {
                    bubbles: true,
                    detail: protectedPayload
                })
            );
            options.onProtectedWorkspaceDelete?.(protectedPayload);
            return;
        }

        const CustomEventConstructor = doc.defaultView?.CustomEvent ?? globalThis.CustomEvent;
        const requestEvent = new CustomEventConstructor('filemgr:delete-root-request', {
            bubbles: true,
            cancelable: true,
            detail: {
                source: source.raw,
                root: source.path
            }
        });

        if (!button.dispatchEvent(requestEvent)) {
            return;
        }

        if (typeof options.onRequestDeleteRoot === 'function') {
            options.onRequestDeleteRoot(source.raw, source);
            return;
        }

        if (typeof options.onDeleteRoot === 'function') {
            options.onDeleteRoot(source.raw, source);
            return;
        }

        if (typeof options.onDeleteSource === 'function') {
            options.onDeleteSource(source.raw, source);
        }
    });

    return button;
}

function updateAttribute(node, name, value) {
    if (value === null) {
        if (node.hasAttribute(name)) node.removeAttribute(name);
    } else if (node.getAttribute(name) !== String(value)) {
        node.setAttribute(name, String(value));
    }
}

function updateText(node, text) {
    if (node.textContent !== text) node.textContent = text;
}

function updateData(node, key, value) {
    if (value === null) {
        if (node.dataset[key] !== undefined) delete node.dataset[key];
    } else if (node.dataset[key] !== String(value)) node.dataset[key] = String(value);
}

function placeBefore(parent, node, next = null) {
    if (node.parentNode !== parent || node.nextSibling !== next) parent.insertBefore(node, next);
}

function updateSourceControlButton(button, source, options) {
    const rootIsPending = options.pendingByRoot.has(source.path);
    const actionText = sourceControlText(
        options,
        source.paused ? 'renderer.filemgr.source.resume' : 'renderer.filemgr.source.pause'
    );
    updateAttribute(
        button,
        'class',
        source.paused ? 'source-control-btn source-resume-btn' : 'source-control-btn source-menu-item'
    );
    updateAttribute(button, 'role', source.paused ? null : 'menuitem');
    updateData(button, 'action', source.paused ? 'resume' : 'pause');
    const disabled = !source.hasBackend || rootIsPending || options.workerStatus !== 'running';
    if (button.disabled !== disabled) button.disabled = disabled;
    updateAttribute(button, 'aria-busy', String(rootIsPending));
    updateAttribute(button, 'aria-label', actionText);
    updateAttribute(button, 'title', actionText);
    updateAttribute(button.firstChild, 'class', rootIsPending ? 'source-control-spinner' : 'source-control-icon');
    updateText(button.lastChild, actionText);
}

function createSourceControlButton(doc, getSource, options) {
    const button = doc.createElement('button');
    button.type = 'button';
    const icon = doc.createElement('span');
    icon.setAttribute('aria-hidden', 'true');
    const label = doc.createElement('span');
    label.className = 'source-control-label';
    button.append(icon, label);
    updateSourceControlButton(button, getSource(), options);
    button.addEventListener('click', (event) => {
        event.stopPropagation();
        const source = getSource();
        if (!source || button.disabled) return;
        options.sourceMenuPortal.closeFor(button.closest('.filemgr-source-menu-portal'), { restoreFocus: true });
        options.onRequestSourceControl?.(source, !source.paused);
    });
    return button;
}

function createSourceMenuPortal(doc) {
    const view = doc.defaultView;
    let activeMenu = null;
    let focusTimer = null;

    const positionMenu = () => {
        if (!activeMenu) return;
        const { menu, trigger } = activeMenu;
        const triggerRect = trigger.getBoundingClientRect();
        const menuRect = menu.getBoundingClientRect();
        const viewportWidth = view?.innerWidth || doc.documentElement?.clientWidth || 1024;
        const viewportHeight = view?.innerHeight || doc.documentElement?.clientHeight || 768;
        const viewportInset = 8;
        const gap = 6;
        const fitsBelow = triggerRect.bottom + gap + menuRect.height <= viewportHeight - viewportInset;
        const fitsAbove = triggerRect.top - gap - menuRect.height >= viewportInset;
        const placement = !fitsBelow && fitsAbove ? 'top' : 'bottom';
        const preferredTop = placement === 'top' ? triggerRect.top - menuRect.height - gap : triggerRect.bottom + gap;
        const maxTop = Math.max(viewportInset, viewportHeight - menuRect.height - viewportInset);
        const top = Math.min(Math.max(viewportInset, preferredTop), maxTop);
        const preferredLeft = triggerRect.right - menuRect.width;
        const maxLeft = Math.max(viewportInset, viewportWidth - menuRect.width - viewportInset);
        const left = Math.min(Math.max(viewportInset, preferredLeft), maxLeft);

        const topValue = `${Math.round(top)}px`;
        const leftValue = `${Math.round(left)}px`;
        if (menu.style.top !== topValue) menu.style.top = topValue;
        if (menu.style.left !== leftValue) menu.style.left = leftValue;
    };

    const close = ({ restoreFocus = false } = {}) => {
        if (focusTimer !== null) {
            clearTimeout(focusTimer);
            focusTimer = null;
        }
        if (!activeMenu) return;
        const { actions, menu, trigger } = activeMenu;
        activeMenu = null;
        actions.classList.remove('open');
        trigger.setAttribute('aria-expanded', 'false');
        menu.hidden = true;
        menu.style.removeProperty('top');
        menu.style.removeProperty('left');
        actions.appendChild(menu);
        if (restoreFocus && trigger.isConnected) {
            trigger.focus();
        }
    };

    const open = ({ actions, menu, trigger, focusFirst = false }) => {
        if (activeMenu?.trigger === trigger) {
            close({ restoreFocus: true });
            return;
        }
        close();
        activeMenu = { actions, menu, trigger };
        actions.classList.add('open');
        trigger.setAttribute('aria-expanded', 'true');
        menu.hidden = false;
        doc.body.appendChild(menu);
        positionMenu();
        if (focusFirst) {
            menu.querySelector('.source-menu-item:not([disabled])')?.focus();
        }
    };

    const closeOnOutsidePointer = (event) => {
        if (!activeMenu) return;
        if (activeMenu.trigger.contains(event.target) || activeMenu.menu.contains(event.target)) return;
        close();
    };
    const closeOnViewportChange = () => close();

    doc.addEventListener('pointerdown', closeOnOutsidePointer);
    view?.addEventListener('resize', closeOnViewportChange);
    view?.addEventListener('scroll', closeOnViewportChange, true);

    return {
        open,
        close,
        closeFor(menu, options) {
            if (activeMenu?.menu === menu) close(options);
        },
        refresh: positionMenu,
        deferClose(menu, trigger) {
            if (activeMenu?.menu !== menu) return;
            if (focusTimer !== null) clearTimeout(focusTimer);
            focusTimer = setTimeout(() => {
                focusTimer = null;
                if (activeMenu?.menu === menu && !menu.contains(doc.activeElement) && doc.activeElement !== trigger)
                    close();
            }, 0);
        },
        destroy() {
            close();
            doc.removeEventListener('pointerdown', closeOnOutsidePointer);
            view?.removeEventListener('resize', closeOnViewportChange);
            view?.removeEventListener('scroll', closeOnViewportChange, true);
        }
    };
}

function createSourceActionsMenu(doc, getSource, options) {
    const source = getSource();
    const actions = doc.createElement('div');
    actions.className = 'source-actions';

    const moreActionsText = sourceControlText(options, 'renderer.filemgr.source.moreActions');
    const trigger = doc.createElement('button');
    trigger.type = 'button';
    trigger.className = 'source-menu-trigger';
    trigger.title = moreActionsText;
    trigger.setAttribute('aria-label', `${moreActionsText}: ${source.path}`);
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');

    const dots = doc.createElement('span');
    dots.className = 'source-menu-dots';
    dots.setAttribute('aria-hidden', 'true');
    trigger.appendChild(dots);

    const menu = doc.createElement('div');
    menu.className = 'filemgr-source-menu-portal';
    menu.setAttribute('role', 'menu');
    menu.hidden = true;

    const remove = createDeleteButton(doc, getSource, options);
    menu.appendChild(remove);

    trigger.addEventListener('click', (event) => {
        event.stopPropagation();
        if (getSource()) options.sourceMenuPortal?.open({ actions, menu, trigger });
    });
    trigger.addEventListener('keydown', (event) => {
        if (!getSource()) return;
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            options.sourceMenuPortal?.open({ actions, menu, trigger, focusFirst: true });
        } else if (event.key === 'Escape') {
            event.preventDefault();
            options.sourceMenuPortal?.close({ restoreFocus: true });
        }
    });
    menu.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        options.sourceMenuPortal?.close({ restoreFocus: true });
    });
    menu.addEventListener('focusout', (event) => {
        const relatedTarget = event.relatedTarget;
        if (relatedTarget && (menu.contains(relatedTarget) || trigger.contains(relatedTarget))) return;
        options.sourceMenuPortal?.deferClose(menu, trigger);
    });

    actions.append(trigger, menu);
    return { element: actions, trigger, menu, remove };
}

function createFileAlert(doc, source) {
    if (!source.failedCount || source.failedCount <= 0) return null;
    const alert = doc.createElement('span');
    alert.className = 'fs-file-alert';
    alert.textContent = String(source.failedCount);
    alert.title = `${source.failedCount} 个文件太大或格式不适合智能理解，仍可通过文件名找到。`;
    alert.setAttribute('aria-label', `${source.failedCount} 个文件无法理解`);
    alert.setAttribute('role', 'status');
    return alert;
}

function createSourceCard(doc, initialSource, mode, options) {
    let source = initialSource;
    const getSource = () => source;
    const card = doc.createElement('article');
    card.dataset.sourceId = String(source.id);
    const iconBox = createIconBox(doc, source, getDisplayState(source));
    const info = doc.createElement('div');
    info.className = 'info';
    const row1 = doc.createElement('div');
    row1.className = 'row1';
    const path = doc.createElement('span');
    path.className = 'path';
    path.textContent = formatDisplayPath(source.path);
    path.title = source.path || '未命名数据源';
    const actions = createSourceActionsMenu(doc, getSource, options);
    row1.append(path, actions.element);
    const row3 = doc.createElement('div');
    row3.className = 'row3';
    const status = doc.createElement('span');
    row3.append(status);
    info.append(row1, row3);
    card.append(iconBox, info);
    let fileAlert = null;
    let statusIcon = null;
    let control = null;
    let timeTag = null;
    let error = null;
    const progressTooltip = createProgressTooltip(doc, row3, status);

    const update = (nextSource, nextMode, workerStatus, translator = options.t) => {
        const rootIsPending = options.pendingByRoot.has(nextSource.path);
        // Capability changes can invalidate a focused operation. Ordinary scan
        // progress leaves both the menu and its focused item in place.
        if (
            source.paused !== nextSource.paused ||
            source.workspace !== nextSource.workspace ||
            source.hasBackend !== nextSource.hasBackend ||
            options.workerStatus !== workerStatus ||
            (card.getAttribute('aria-busy') === 'false' && rootIsPending)
        ) {
            options.sourceMenuPortal.closeFor(actions.menu, { restoreFocus: true });
        }
        source = nextSource;
        options.workerStatus = workerStatus;
        options.t = translator;
        const displayState = getDisplayState(source);
        const statusText = getStatusText(source, displayState, nextMode, options);
        const progress = getProgress(source, displayState, nextMode);
        const values = Object.values(progress).filter((value) => value !== null);
        const hasProgress = values.length > 0;
        updateAttribute(
            card,
            'class',
            [
                'fs-source-card',
                source.workspace ? 'workspace' : 'normal',
                displayState,
                displayState === 'completed' ? 'scan-done' : '',
                nextMode === 'base-only' ? 'base-only' : ''
            ]
                .filter(Boolean)
                .join(' ')
        );
        updateData(card, 'state', displayState);
        updateData(card, 'progress', hasProgress ? Math.min(...values) : null);
        updateAttribute(card, 'aria-busy', String(rootIsPending));
        updateAttribute(
            iconBox.firstChild,
            'class',
            source.workspace && displayState !== 'unavailable' ? 'workspace-shape' : 'folder-shape'
        );
        const warning = iconBox.querySelector('.warning-corner');
        if (displayState === 'unavailable' && !warning) {
            const corner = doc.createElement('span');
            corner.className = 'warning-corner';
            iconBox.append(corner);
        } else if (displayState !== 'unavailable') warning?.remove();

        if (source.failedCount > 0) {
            if (!fileAlert) {
                fileAlert = createFileAlert(doc, source);
                row1.insertBefore(fileAlert, actions.element);
            }
            updateText(fileAlert, String(source.failedCount));
            updateAttribute(
                fileAlert,
                'title',
                `${source.failedCount} 个文件太大或格式不适合智能理解，仍可通过文件名找到。`
            );
            updateAttribute(fileAlert, 'aria-label', `${source.failedCount} 个文件无法理解`);
        } else if (fileAlert) {
            fileAlert.remove();
            fileAlert = null;
        }
        const moreText = sourceControlText(options, 'renderer.filemgr.source.moreActions');
        updateAttribute(actions.trigger, 'title', moreText);
        updateAttribute(actions.trigger, 'aria-label', `${moreText}: ${source.path}`);
        const removeText = sourceControlText(options, 'renderer.filemgr.source.remove');
        updateAttribute(actions.remove, 'title', removeText);
        updateAttribute(actions.remove, 'aria-label', `${removeText}: ${source.path}`);
        updateText(actions.remove, removeText);
        if (actions.remove.disabled !== rootIsPending) actions.remove.disabled = rootIsPending;

        const iconClass = displayState === 'unavailable' ? 'fs-warning-icon' : hasProgress ? 'fs-mini-ring' : null;
        if (statusIcon && (!iconClass || !statusIcon.classList.contains(iconClass))) {
            statusIcon.remove();
            statusIcon = null;
        }
        if (iconClass && !statusIcon) {
            statusIcon =
                hasProgress && displayState !== 'unavailable'
                    ? createMiniRing(doc, progress)
                    : doc.createElement('span');
            if (iconClass === 'fs-warning-icon') {
                statusIcon.className = iconClass;
                statusIcon.setAttribute('aria-hidden', 'true');
            }
            row3.insertBefore(statusIcon, status);
        }
        if (iconClass === 'fs-mini-ring') updateMiniRing(doc, statusIcon, progress);
        progressTooltip.update(iconClass === 'fs-mini-ring' ? progressLabels(source, progress, options) : []);
        updateAttribute(
            status,
            'class',
            displayState === 'pending' || displayState === 'unavailable' ? 'status-text' : 'status-text status-accent'
        );
        updateText(status, statusText);
        if (source.lastScanAt) {
            if (!timeTag) {
                timeTag = doc.createElement('span');
                timeTag.className = 'time-tag';
                row3.append(timeTag);
            }
            const lastScan = formatLastScan(source.lastScanAt);
            updateText(timeTag, lastScan);
            updateAttribute(timeTag, 'title', lastScan);
        } else if (timeTag) {
            timeTag.remove();
            timeTag = null;
        }
        if (source.hasBackend) {
            if (!control) control = createSourceControlButton(doc, getSource, options);
            updateSourceControlButton(control, source, options);
            if (source.paused) placeBefore(row3, control, timeTag);
            else placeBefore(actions.menu, control, actions.remove);
        } else control?.remove();
        const controlError = options.errorByRoot.get(source.path);
        if (controlError) {
            if (!error) {
                error = doc.createElement('div');
                error.className = 'fs-source-control-error';
                error.setAttribute('role', 'alert');
                info.append(error);
            }
            updateText(
                error,
                sourceControlText(
                    options,
                    SOURCE_CONTROL_ERROR_KEYS[controlError.code] ?? SOURCE_CONTROL_ERROR_KEYS.generic
                )
            );
        } else if (error) {
            error.remove();
            error = null;
        }
    };
    update(source, mode, options.workerStatus);
    return {
        element: card,
        get source() {
            return source;
        },
        update,
        destroy() {
            options.sourceMenuPortal.closeFor(actions.menu);
            progressTooltip.destroy();
            source = null;
            card.remove();
        }
    };
}

function createEmptyCard(doc) {
    const card = doc.createElement('article');
    card.className = 'fs-source-card empty';

    const content = doc.createElement('div');
    content.className = 'fs-empty-content';

    const icon = doc.createElement('span');
    icon.className = 'fs-empty-icon';
    icon.setAttribute('aria-hidden', 'true');

    const text = doc.createElement('span');
    text.textContent = '勾选下方文件树中的目录开始添加数据源 ↓';

    content.append(icon, text);
    card.appendChild(content);
    return card;
}

function createSkeletonCard(doc) {
    const card = doc.createElement('article');
    card.className = 'fs-source-card skeleton';
    card.setAttribute('aria-hidden', 'true');
    const icon = doc.createElement('span');
    icon.className = 'icon-box';
    const info = doc.createElement('div');
    info.className = 'info';
    for (const className of ['path-line', 'meta-line', 'status-line']) {
        const line = doc.createElement('span');
        line.className = `fs-skeleton-line ${className}`;
        info.appendChild(line);
    }
    card.append(icon, info);
    return card;
}

function renderCards(refs, doc, options) {
    const snapshot = getSnapshot();
    const data = getSnapshotData(snapshot);
    const status = getStatus(data);
    const mode = getMode(data);
    const sources = getSortedSources(data);
    const isError = status === 'error';
    if (refs.grid.classList.contains('fs-error-layer') !== isError)
        refs.grid.classList.toggle('fs-error-layer', isError);
    const roots = new Set(sources.map((source) => source.path));
    for (const [root, card] of refs.cards) {
        if (!roots.has(root)) {
            card.destroy();
            refs.cards.delete(root);
        }
    }
    const placeholder = sources.length ? null : snapshot == null || status === 'initializing' ? 'skeleton' : 'empty';
    if (placeholder !== refs.placeholder) {
        for (const node of refs.placeholders) node.remove();
        refs.placeholders = [];
        refs.placeholder = placeholder;
        if (placeholder === 'skeleton') {
            for (let i = 0; i < SKELETON_CARD_COUNT; i++) refs.placeholders.push(createSkeletonCard(doc));
        } else if (placeholder === 'empty') refs.placeholders.push(createEmptyCard(doc));
        refs.grid.append(...refs.placeholders);
    }
    let cursor = refs.grid.firstChild;
    for (const source of sources) {
        let card = refs.cards.get(source.path);
        if (!card) {
            card = createSourceCard(doc, source, mode, { ...options, workerStatus: status });
            refs.cards.set(source.path, card);
        } else card.update(source, mode, status, options.t);
        if (card.element !== cursor) {
            const focused = doc.activeElement;
            refs.grid.insertBefore(card.element, cursor);
            // Moving a card can blur its focused descendant in native DOM.
            if (
                focused?.isConnected &&
                card.element.contains(focused) &&
                doc.activeElement !== focused &&
                !focused.disabled
            )
                focused.focus();
        }
        cursor = card.element.nextSibling;
    }
    options.sourceMenuPortal.refresh();
    if (!refs.hasAnimated) {
        refs.grid.classList.add('fs-anim', 'fs-anim-delay-1');
        refs.hasAnimated = true;
    }
}

function buildSourcesDom(doc) {
    const element = doc.createElement('section');
    element.className = 'fs-upper';
    element.setAttribute('aria-label', '数据源');

    const grid = doc.createElement('div');
    grid.className = 'fs-sources';
    element.appendChild(grid);

    return {
        element,
        grid,
        cards: new Map(),
        placeholder: null,
        placeholders: [],
        hasAnimated: false
    };
}

export function createSources(options = {}) {
    const doc = resolveDocument(options.document);
    injectStyles(doc);

    const refs = buildSourcesDom(doc);
    const sourceMenuPortal = createSourceMenuPortal(doc);
    const pendingByRoot = new Map();
    const errorByRoot = new Map();
    let disposed = false;
    const requestSourceControl = async (source, paused) => {
        const root = source.path;
        const current = refs.cards.get(root)?.source;
        if (
            disposed ||
            !current?.hasBackend ||
            getStatus(getSnapshotData(getSnapshot())) !== 'running' ||
            !root ||
            pendingByRoot.has(root)
        )
            return;
        pendingByRoot.set(root, paused);
        errorByRoot.delete(root);
        render();
        try {
            await options.onSetSourcePaused?.({ root, paused });
        } catch (error) {
            if (!disposed) errorByRoot.set(root, { code: error?.code ?? 'generic' });
        } finally {
            pendingByRoot.delete(root);
            render();
        }
    };
    const renderOptions = {
        ...options,
        pendingByRoot,
        errorByRoot,
        sourceMenuPortal,
        onRequestSourceControl: requestSourceControl
    };
    function render() {
        if (disposed) return;
        renderCards(refs, doc, renderOptions);
    }

    render();

    const unsubscribes = [subscribeEntries(render), subscribeDefaultWorkspace(render)];
    const unsubscribe = subscribeSnapshot(() => {
        errorByRoot.clear();
        render();
    });

    return {
        element: refs.element,
        setTranslator(translator) {
            renderOptions.t = translator;
            render();
        },
        destroy() {
            disposed = true;
            for (const card of refs.cards.values()) card.destroy();
            refs.cards.clear();
            unsubscribe();
            for (const unsub of unsubscribes) unsub();
            sourceMenuPortal.destroy();
            refs.element.remove();
        }
    };
}
