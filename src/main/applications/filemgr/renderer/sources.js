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

import { getSnapshot, subscribeSnapshot } from './state.js';

const SOURCES_STYLE_ID = 'filemgr-sources-styles';
const MINI_RING_CIRCUMFERENCE = 37.7;
const SKELETON_CARD_COUNT = 3;
export const WORKSPACE_SOURCE_PROTECTED_MESSAGE = '当前工作空间不能在这里移除。请回到主页面切换工作空间。';
const SOURCE_CONTROL_FALLBACKS = {
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
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : fallback;
}

function isWorkspaceSource(source, data) {
    const path = getSourcePath(source);
    const type = source?.type ?? source?.kind ?? source?.entry?.type ?? source?.entry?.kind;
    const workspacePath = data.workspace ?? data.default_workspace ?? data.storage?.workspace ?? null;

    return (
        type === 'workspace' ||
        source?.workspace === true ||
        source?.isWorkspace === true ||
        source?.is_workspace === true ||
        source?.entry?.workspace === true ||
        source?.entry?.is_workspace === true ||
        source?.entry?.scope === 'workspace' ||
        (workspacePath && path === workspacePath)
    );
}

function getSourcePath(source) {
    return source?.path ?? source?.root ?? source?.entry?.root ?? source?.entry?.path ?? source?.name ?? '';
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
            0
        )
    };
}

function normalizeSource(source, data, index) {
    const path = getSourcePath(source);
    const totalFiles = toNumber(
        source?.total_files ?? source?.totalFiles ?? source?.total ?? source?.file_count ?? source?.fileCount,
        0
    );
    const embeddedCount = toNumber(
        source?.embedded_count ??
            source?.embeddedCount ??
            source?.embedded ??
            source?.indexed_files ??
            source?.indexedFiles,
        0
    );
    const failedCount = toNumber(
        source?.failed_count ?? source?.failedCount ?? source?.failed_files ?? source?.failedFiles,
        0
    );
    const lastScanAt =
        source?.last_scan_at ?? source?.lastScanAt ?? source?.last_full_scan ?? source?.lastFullScan ?? null;
    const unavailableInfo = getUnavailableInfo(source, data, path);

    return {
        raw: source,
        id: source?.id ?? path ?? `source-${index}`,
        path,
        index,
        totalFiles,
        embeddedCount,
        failedCount,
        lastScanAt,
        unavailableInfo,
        workspace: isWorkspaceSource(source, data),
        paused: source?.paused === true,
        state: source?.state ?? source?.status ?? null,
        isRunning: source?.isRunning === true
    };
}

function getSortedSources(data) {
    return getSourceArray(data)
        .map((source, index) => normalizeSource(source, data, index))
        .sort((a, b) => {
            if (a.workspace !== b.workspace) {
                return a.workspace ? -1 : 1;
            }

            return a.index - b.index;
        });
}

function getDisplayState(source, mode) {
    if (source.paused) {
        return 'paused';
    }
    if (source.unavailableInfo) {
        return 'unavailable';
    }

    if (source.isRunning) {
        return 'scanning';
    }

    if (source.totalFiles === 0 && source.lastScanAt) {
        return 'completed';
    }

    if (mode === 'base-only') {
        if (source.totalFiles === 0) {
            return 'pending';
        }

        return source.lastScanAt ? 'completed' : 'pending';
    }

    if (['pending', 'scanning', 'completed', 'unavailable'].includes(source.state)) {
        return source.state;
    }

    return source.lastScanAt || source.totalFiles > 0 ? 'completed' : 'pending';
}

function getProgress(source, displayState) {
    if (displayState === 'completed') {
        return 100;
    }

    if (displayState !== 'scanning' || source.totalFiles <= 0) {
        return 0;
    }

    return Math.max(0, Math.min(100, Math.round((source.embeddedCount / source.totalFiles) * 100)));
}

function getStatusText(source, displayState, mode, options) {
    const pendingPaused = options.pendingByRoot?.get(source.path);
    if (pendingPaused === true) return sourceControlText(options, 'renderer.filemgr.source.pausing');
    if (pendingPaused === false) return sourceControlText(options, 'renderer.filemgr.source.resuming');
    if (displayState === 'paused') {
        return sourceControlText(options, 'renderer.filemgr.source.pausedWithCount', { count: source.totalFiles });
    }
    if (displayState === 'unavailable') {
        return `路径不可访问 · 上次 ${source.unavailableInfo?.lastCount ?? source.totalFiles} 文件`;
    }

    if (displayState === 'completed' && source.totalFiles === 0) {
        return '未发现可扫描文件';
    }

    if (mode === 'base-only') {
        return `基础索引 · ${source.totalFiles} 文件`;
    }

    if (displayState === 'pending') {
        return '等待扫描';
    }

    if (displayState === 'scanning') {
        return `扫描中 · ${source.embeddedCount} / ${source.totalFiles} 文件`;
    }

    return `已完成 · ${source.totalFiles} 文件`;
}

function injectStyles(doc) {
    if (doc.getElementById(SOURCES_STYLE_ID)) {
        return;
    }

    const style = doc.createElement('style');
    style.id = SOURCES_STYLE_ID;
    style.textContent = `
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

.fs-upper .fs-source-card.scan-done .mini-ring .fill {
    stroke: var(--filemgr-success);
}

.fs-upper .fs-source-card.base-only.scan-done .mini-ring .fill {
    stroke: var(--od-text-muted);
}

.fs-upper .fs-source-card .status-accent {
    color: var(--od-accent);
    font-weight: 600;
}

.fs-upper .fs-source-card.scan-done .status-accent {
    color: var(--filemgr-success);
}

.fs-upper .fs-source-card.base-only.scan-done .status-accent {
    color: var(--od-text-muted);
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

    const track = doc.createElementNS('http://www.w3.org/2000/svg', 'circle');
    track.classList.add('track');
    track.setAttribute('cx', '8');
    track.setAttribute('cy', '8');
    track.setAttribute('r', '6');

    const fill = doc.createElementNS('http://www.w3.org/2000/svg', 'circle');
    fill.classList.add('fill');
    fill.setAttribute('cx', '8');
    fill.setAttribute('cy', '8');
    fill.setAttribute('r', '6');
    fill.style.strokeDashoffset = String(MINI_RING_CIRCUMFERENCE * (1 - progress / 100));

    svg.append(track, fill);
    return svg;
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

function createDeleteButton(doc, source, options) {
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

function createSourceControlButton(doc, source, options) {
    const rootIsPending = options.pendingByRoot?.has(source.path) === true;
    const action = source.paused ? 'resume' : 'pause';
    const actionText = sourceControlText(
        options,
        source.paused ? 'renderer.filemgr.source.resume' : 'renderer.filemgr.source.pause'
    );
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = source.paused
        ? 'source-control-btn source-resume-btn'
        : 'source-control-btn source-menu-item';
    if (!source.paused) {
        button.setAttribute('role', 'menuitem');
    }
    button.dataset.action = action;
    button.disabled = rootIsPending || options.workerStatus !== 'running';
    button.setAttribute('aria-busy', rootIsPending ? 'true' : 'false');
    button.setAttribute('aria-label', actionText);
    button.title = actionText;
    if (rootIsPending) {
        const spinner = doc.createElement('span');
        spinner.className = 'source-control-spinner';
        spinner.setAttribute('aria-hidden', 'true');
        button.appendChild(spinner);
    } else {
        const icon = doc.createElement('span');
        icon.className = 'source-control-icon';
        icon.setAttribute('aria-hidden', 'true');
        button.appendChild(icon);
    }
    const label = doc.createElement('span');
    label.className = 'source-control-label';
    label.textContent = actionText;
    button.appendChild(label);
    button.addEventListener('click', (event) => {
        event.stopPropagation();
        options.onRequestSourceControl?.(source, !source.paused);
    });
    return button;
}

function createSourceMenuPortal(doc) {
    const view = doc.defaultView;
    let activeMenu = null;

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
        const preferredTop =
            placement === 'top' ? triggerRect.top - menuRect.height - gap : triggerRect.bottom + gap;
        const maxTop = Math.max(viewportInset, viewportHeight - menuRect.height - viewportInset);
        const top = Math.min(Math.max(viewportInset, preferredTop), maxTop);
        const preferredLeft = triggerRect.right - menuRect.width;
        const maxLeft = Math.max(viewportInset, viewportWidth - menuRect.width - viewportInset);
        const left = Math.min(Math.max(viewportInset, preferredLeft), maxLeft);

        menu.style.top = `${Math.round(top)}px`;
        menu.style.left = `${Math.round(left)}px`;
    };

    const close = ({ restoreFocus = false } = {}) => {
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
        destroy() {
            close();
            doc.removeEventListener('pointerdown', closeOnOutsidePointer);
            view?.removeEventListener('resize', closeOnViewportChange);
            view?.removeEventListener('scroll', closeOnViewportChange, true);
        }
    };
}

function createSourceActionsMenu(doc, source, options) {
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

    if (!source.paused) {
        menu.appendChild(createSourceControlButton(doc, source, options));
    }
    menu.appendChild(createDeleteButton(doc, source, options));

    trigger.addEventListener('click', (event) => {
        event.stopPropagation();
        options.sourceMenuPortal?.open({ actions, menu, trigger });
    });
    trigger.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            options.sourceMenuPortal?.open({ actions, menu, trigger, focusFirst: true });
        } else if (event.key === 'Escape') {
            event.preventDefault();
            options.sourceMenuPortal?.close({ restoreFocus: true });
        }
    });
    menu.addEventListener(
        'click',
        (event) => {
            if (event.target.closest?.('.source-menu-item')) {
                options.sourceMenuPortal?.close();
            }
        },
        true
    );
    menu.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        options.sourceMenuPortal?.close({ restoreFocus: true });
    });
    menu.addEventListener('focusout', (event) => {
        const relatedTarget = event.relatedTarget;
        if (relatedTarget && (menu.contains(relatedTarget) || trigger.contains(relatedTarget))) return;
        const setTimeout = doc.defaultView?.setTimeout ?? globalThis.setTimeout;
        setTimeout(() => {
            if (!menu.contains(doc.activeElement) && doc.activeElement !== trigger) {
                options.sourceMenuPortal?.close();
            }
        }, 0);
    });

    actions.append(trigger, menu);
    return actions;
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

function appendStatusIcon(doc, row, source, displayState) {
    if (displayState === 'unavailable') {
        const warning = doc.createElement('span');
        warning.className = 'fs-warning-icon';
        warning.setAttribute('aria-hidden', 'true');
        row.appendChild(warning);
        return;
    }

    row.appendChild(createMiniRing(doc, getProgress(source, displayState)));
}

function createSourceCard(doc, source, mode, options) {
    const displayState = getDisplayState(source, mode);
    const statusText = getStatusText(source, displayState, mode, options);
    const rootIsPending = options.pendingByRoot?.has(source.path) === true;
    const card = doc.createElement('article');
    card.className = [
        'fs-source-card',
        source.workspace ? 'workspace' : 'normal',
        displayState,
        displayState === 'completed' ? 'scan-done' : '',
        mode === 'base-only' ? 'base-only' : ''
    ]
        .filter(Boolean)
        .join(' ');
    card.dataset.sourceId = String(source.id);
    card.dataset.state = displayState;
    card.dataset.progress = String(getProgress(source, displayState));
    card.setAttribute('aria-busy', rootIsPending ? 'true' : 'false');

    const info = doc.createElement('div');
    info.className = 'info';

    const row1 = doc.createElement('div');
    row1.className = 'row1';

    const path = doc.createElement('span');
    path.className = 'path';
    path.textContent = formatDisplayPath(source.path);
    path.title = source.path || '未命名数据源';

    row1.appendChild(path);
    const fileAlert = createFileAlert(doc, source);
    if (fileAlert) {
        row1.appendChild(fileAlert);
    }
    row1.appendChild(createSourceActionsMenu(doc, source, options));

    const row3 = doc.createElement('div');
    row3.className = 'row3';
    row3.title = statusText;
    appendStatusIcon(doc, row3, source, displayState);

    const status = doc.createElement('span');
    status.className =
        displayState === 'pending' || displayState === 'unavailable' ? 'status-text' : 'status-text status-accent';
    status.textContent = statusText;
    status.title = statusText;

    row3.appendChild(status);
    if (source.paused) {
        row3.appendChild(createSourceControlButton(doc, source, options));
    }
    if (source.lastScanAt) {
        const timeTag = doc.createElement('span');
        timeTag.className = 'time-tag';
        timeTag.textContent = formatLastScan(source.lastScanAt);
        timeTag.title = timeTag.textContent;
        row3.appendChild(timeTag);
    }
    info.append(row1, row3);
    const controlError = options.errorByRoot?.get(source.path);
    if (controlError) {
        const error = doc.createElement('div');
        error.className = 'fs-source-control-error';
        error.setAttribute('role', 'alert');
        error.textContent = sourceControlText(
            options,
            SOURCE_CONTROL_ERROR_KEYS[controlError.code] ?? SOURCE_CONTROL_ERROR_KEYS.generic
        );
        info.appendChild(error);
    }
    card.append(createIconBox(doc, source, displayState), info);

    return card;
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
    const data = getSnapshotData(getSnapshot());
    const status = getStatus(data);
    const mode = getMode(data);
    const currentSources = getSortedSources(data);
    let sources = currentSources;
    let renderMode = mode;

    if (status !== 'error' && status !== 'initializing') {
        refs.lastSuccessfulSnapshot = {
            sources: currentSources,
            mode
        };
    } else if (sources.length === 0 && refs.lastSuccessfulSnapshot) {
        sources = refs.lastSuccessfulSnapshot.sources;
        renderMode = mode ?? refs.lastSuccessfulSnapshot.mode;
    }

    refs.grid.classList.toggle('fs-error-layer', status === 'error');
    refs.grid.replaceChildren();

    if (status === 'initializing' && sources.length === 0) {
        for (let i = 0; i < SKELETON_CARD_COUNT; i++) {
            refs.grid.appendChild(createSkeletonCard(doc));
        }
    } else if (sources.length === 0) {
        refs.grid.appendChild(createEmptyCard(doc));
    } else {
        for (const source of sources) {
            refs.grid.appendChild(createSourceCard(doc, source, renderMode, { ...options, workerStatus: status }));
        }
    }

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
        hasAnimated: false,
        lastSuccessfulSnapshot: null
    };
}

export function createSources(options = {}) {
    const doc = resolveDocument(options.document);
    injectStyles(doc);

    const refs = buildSourcesDom(doc);
    const sourceMenuPortal = createSourceMenuPortal(doc);
    const pendingByRoot = new Map();
    const errorByRoot = new Map();
    const requestSourceControl = async (source, paused) => {
        const root = source.path;
        if (!root || pendingByRoot.has(root)) return;
        pendingByRoot.set(root, paused);
        errorByRoot.delete(root);
        render();
        try {
            await options.onSetSourcePaused?.({ root, paused });
        } catch (error) {
            errorByRoot.set(root, { code: error?.code ?? 'generic' });
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
        sourceMenuPortal.close();
        renderCards(refs, doc, renderOptions);
    }

    render();

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
            unsubscribe();
            sourceMenuPortal.destroy();
            refs.element.remove();
        }
    };
}
