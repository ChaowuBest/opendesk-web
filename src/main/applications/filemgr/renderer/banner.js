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

const BANNER_STYLE_ID = 'filemgr-banner-styles';

const STATUS_MODEL = {
    idle: {
        labelKey: 'renderer.filemgr.status.idle',
        rgb: '142, 142, 147'
    },
    initializing: {
        labelKey: 'renderer.filemgr.status.initializing',
        rgb: '0, 122, 255'
    },
    running: {
        labelKey: 'renderer.filemgr.status.running',
        rgb: '52, 199, 89'
    },
    readonly: {
        labelKey: 'renderer.filemgr.status.readonly',
        rgb: '245, 158, 11'
    },
    error: {
        labelKey: 'renderer.filemgr.status.error',
        rgb: '255, 59, 48'
    }
};

const MODE_LABEL = {
    full: 'renderer.filemgr.mode.full',
    'base-only': 'renderer.filemgr.mode.baseOnly'
};

const ALERT_MODEL = {
    embed_model_missing: {
        tooltipKey: 'renderer.filemgr.alert.embedModelMissing',
        clickable: true
    },
    embedding_unavailable: {
        tooltipKey: 'renderer.filemgr.alert.embeddingUnavailable',
        clickable: true
    },
    embedding_pending: {
        tooltipKey: 'renderer.filemgr.alert.embeddingPending',
        clickable: false
    },
    no_roots: {
        tooltipKey: 'renderer.filemgr.alert.noRoots',
        clickable: false
    },
    worker_init_failed: {
        tooltipKey: 'renderer.filemgr.alert.workerInitFailed',
        clickable: false
    },
    semantic_capacity_limited: {
        tooltipKey: 'renderer.filemgr.alert.semanticCapacityLimited',
        clickable: false
    }
};

const FALLBACK_TEXT = {
    'renderer.filemgr.title': '智能文件系统',
    'renderer.filemgr.subtitle': '轻松寻找，管理和组织你的文件',
    'renderer.filemgr.aria.status': '智能文件系统状态',
    'renderer.filemgr.status.idle': '未配置',
    'renderer.filemgr.status.initializing': '正在启动',
    'renderer.filemgr.status.running': '运行中',
    'renderer.filemgr.status.readonly': '查询模式',
    'renderer.filemgr.status.error': '异常',
    'renderer.filemgr.mode.full': '完整索引',
    'renderer.filemgr.mode.baseOnly': '基础索引',
    'renderer.filemgr.alert.embedModelMissing': '未配置嵌入模型 · 点击去配置',
    'renderer.filemgr.alert.embeddingUnavailable': '嵌入模型不可用 · 点击去配置',
    'renderer.filemgr.alert.embeddingPending': '嵌入索引暂未就绪，将自动同步',
    'renderer.filemgr.alert.noRoots': '未配置任何扫描路径',
    'renderer.filemgr.alert.workerInitFailed': '文件系统初始化失败',
    'renderer.filemgr.alert.semanticCapacityLimited':
        '语义理解已达到当前设备上限。新文件会继续记录，已有语义结果仍可搜索。',
    'renderer.filemgr.refresh.tooltip': '立即扫描新文件'
};

function translate(t, key) {
    return typeof t === 'function' ? t(key) : (FALLBACK_TEXT[key] ?? key);
}

function resolveDocument(documentOverride) {
    const doc = documentOverride || globalThis.document;
    if (!doc) {
        throw new Error('createBanner requires a DOM document.');
    }

    return doc;
}

function getSnapshotData(snapshot) {
    return snapshot?.data || snapshot || {};
}

function getStatus(snapshot) {
    const data = getSnapshotData(snapshot);
    return STATUS_MODEL[data.status] ? data.status : 'idle';
}

function getMode(snapshot) {
    const data = getSnapshotData(snapshot);
    const mode = data.storage?.mode ?? data.mode ?? null;
    return MODE_LABEL[mode] ? mode : null;
}

function getAlerts(snapshot) {
    const data = getSnapshotData(snapshot);
    return Array.isArray(data.alerts) ? data.alerts : [];
}

function getAlertCode(alert) {
    return typeof alert === 'string' ? alert : alert?.code;
}

function injectStyles(doc) {
    if (doc.getElementById(BANNER_STYLE_ID)) {
        return;
    }

    const style = doc.createElement('style');
    style.id = BANNER_STYLE_ID;
    style.textContent = `
.fs-banner {
    flex: 0 0 auto;
    padding: 36px 56px 14px 24px;
    background: color-mix(in srgb, var(--od-bg-elevated) 86%, transparent);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border-bottom: 1px solid var(--od-border);
    box-sizing: border-box;
}

.fs-banner .fs-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    width: 100%;
    min-width: 0;
}

.fs-banner .fs-brand {
    display: flex;
    align-items: center;
    gap: 12px;
    flex: 1 1 auto;
    min-width: 0;
}

.fs-banner .fs-logo-mark {
    position: relative;
    flex: 0 0 46px;
    width: 46px;
    height: 46px;
    border-radius: 13px;
    background: var(--od-bg-elevated);
    border: 1px solid rgba(0, 122, 255, 0.11);
    box-shadow: inset 0 1px 0 color-mix(in srgb, var(--od-bg-elevated) 70%, white);
}

.fs-banner .fs-logo-mark::before {
    content: '';
    position: absolute;
    left: 12px;
    top: 15px;
    width: 22px;
    height: 17px;
    border-radius: 5px;
    background: rgba(0, 122, 255, 0.78);
    box-shadow: inset 0 -7px 0 rgba(255, 255, 255, 0.22);
}

.fs-banner .fs-logo-mark::after {
    content: '';
    position: absolute;
    left: 13px;
    top: 12px;
    width: 11px;
    height: 5px;
    border-radius: 3px 3px 0 0;
    background: rgba(107, 182, 255, 0.78);
}

.fs-banner .fs-title-wrap {
    min-width: 0;
}

.fs-banner .fs-title {
    margin: 0;
    color: var(--od-text);
    font-size: 17px;
    font-weight: 700;
    line-height: 1.22;
    letter-spacing: 0;
}

.fs-banner .fs-subtitle {
    margin: 3px 0 0;
    color: var(--od-text-muted);
    font-size: 12px;
    font-weight: 400;
    line-height: 1.35;
    letter-spacing: 0;
}

.fs-banner .fs-banner-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 10px;
    flex: 0 1 auto;
    min-width: 0;
    margin-left: auto;
}

.fs-banner .fs-alert-slot {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 34px;
    width: 34px;
    height: 34px;
}

.fs-banner .fs-alert-slot:empty {
    display: none;
}

.fs-banner .fs-status-pill {
    display: inline-flex;
    align-items: center;
    flex: 0 1 auto;
    gap: 8px;
    min-width: 0;
    height: 34px;
    min-height: 34px;
    padding: 0 12px;
    box-sizing: border-box;
    border-radius: 999px;
    border: 1px solid var(--od-border);
    background: var(--od-bg-elevated);
    box-shadow: 0 1px 1px rgba(0, 0, 0, 0.025);
    color: var(--od-text);
    font-size: 13px;
    font-weight: 600;
    line-height: 1;
    white-space: nowrap;
}

.fs-banner .fs-status-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
}

.fs-banner .fs-refresh-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 34px;
    width: 34px;
    height: 34px;
    padding: 0;
    border-radius: 999px;
    border: 1px solid var(--od-border);
    background: var(--od-bg-elevated);
    color: var(--od-text-muted);
    cursor: pointer;
    font-size: 14px;
    box-shadow: 0 1px 1px rgba(0, 0, 0, 0.025);
    transition: color 0.15s, background 0.15s, transform 0.15s;
}

.fs-banner .fs-refresh-btn:hover {
    color: var(--od-accent);
    background: color-mix(in srgb, var(--od-accent) 8%, var(--od-bg-elevated));
}

.fs-banner .fs-refresh-btn:active {
    transform: scale(0.93);
}

.fs-banner .fs-refresh-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
    color: var(--od-text-muted);
}

.fs-banner .fs-refresh-btn .fs-refresh-icon {
    transition: transform 0.7s ease;
}

.fs-banner .fs-refresh-btn.spinning .fs-refresh-icon {
    animation: filemgr-spin 0.8s linear infinite;
}

@keyframes filemgr-spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
}

.fs-banner .fs-status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: rgb(var(--filemgr-status-rgb));
    box-shadow: 0 0 0 0 rgba(var(--filemgr-status-rgb), 0.2);
    animation: filemgr-od-pulse 2.4s ease-in-out infinite;
}

.fs-banner button.fs-alert-badge:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--od-accent) 72%, transparent);
    outline-offset: 3px;
}

.fs-banner .fs-alert-badge {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    appearance: none;
    width: 34px;
    height: 34px;
    padding: 0;
    border-radius: 999px;
    border: 1px solid #fde68a;
    background: #fffaf0;
    color: #d97706;
    font: inherit;
    box-sizing: border-box;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.025);
}

.fs-banner .fs-alert-badge[data-clickable='true'] {
    cursor: pointer;
}

.fs-banner .fs-alert-badge[data-clickable='false'] {
    cursor: default;
}

.fs-banner .fs-alert-badge::before,
.fs-banner .fs-alert-badge::after {
    position: absolute;
    pointer-events: none;
    opacity: 0;
    transition: opacity 140ms ease, transform 140ms ease;
}

.fs-banner .fs-alert-badge::before {
    content: '';
    top: calc(100% + 7px);
    right: 13px;
    width: 8px;
    height: 8px;
    background: #1d1d1f;
    transform: translateY(-2px) rotate(45deg);
    z-index: 3;
}

.fs-banner .fs-alert-badge::after {
    content: attr(data-tooltip);
    top: calc(100% + 10px);
    right: 0;
    width: max-content;
    max-width: min(260px, calc(100vw - 48px));
    padding: 7px 10px;
    border-radius: 8px;
    background: #1d1d1f;
    color: #ffffff;
    font-size: 12px;
    font-weight: 600;
    line-height: 1.3;
    overflow-wrap: anywhere;
    text-align: center;
    white-space: normal;
    transform: translateY(-4px);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18);
    z-index: 4;
}

.fs-banner .fs-alert-badge:hover::before,
.fs-banner .fs-alert-badge:hover::after,
.fs-banner button.fs-alert-badge:focus-visible::before,
.fs-banner button.fs-alert-badge:focus-visible::after {
    opacity: 1;
}

.fs-banner .fs-alert-badge:hover::before,
.fs-banner button.fs-alert-badge:focus-visible::before {
    transform: translateY(0) rotate(45deg);
}

.fs-banner .fs-alert-badge:hover::after,
.fs-banner button.fs-alert-badge:focus-visible::after {
    transform: translateY(0);
}

.fs-banner .fs-alert-badge .pulse-ring {
    position: absolute;
    inset: 2px;
    border-radius: inherit;
    border: 1px solid rgba(217, 119, 6, 0.18);
    animation: filemgr-od-alert-pulse 2.6s ease-in-out infinite;
}

.fs-banner .fs-alert-icon {
    position: relative;
    z-index: 1;
    width: 0;
    height: 0;
    border-left: 5px solid transparent;
    border-right: 5px solid transparent;
    border-bottom: 10px solid currentColor;
}

.fs-banner .fs-alert-icon::after {
    content: '!';
    position: absolute;
    left: -1.25px;
    top: 2px;
    color: #fffbeb;
    font-size: 7px;
    font-weight: 800;
    line-height: 1;
}

@keyframes filemgr-od-pulse {
    0% {
        box-shadow: 0 0 0 0 rgba(var(--filemgr-status-rgb), 0.2);
    }

    70% {
        box-shadow: 0 0 0 5px rgba(var(--filemgr-status-rgb), 0);
    }

    100% {
        box-shadow: 0 0 0 0 rgba(var(--filemgr-status-rgb), 0);
    }
}

@keyframes filemgr-od-alert-pulse {
    0% {
        transform: scale(0.88);
        opacity: 0.7;
    }

    70% {
        transform: scale(1.35);
        opacity: 0;
    }

    100% {
        transform: scale(1.35);
        opacity: 0;
    }
}

@media (prefers-reduced-motion: reduce) {
    .fs-banner .fs-status-dot,
    .fs-banner .fs-alert-badge .pulse-ring {
        animation: none;
    }
}

@media (max-width: 640px) {
    .fs-banner {
        padding: 22px 56px 14px 18px;
    }

    .fs-banner .fs-header {
        align-items: stretch;
        flex-direction: column;
        gap: 12px;
    }

    .fs-banner .fs-banner-actions {
        align-self: flex-end;
        width: auto;
        max-width: 100%;
        justify-content: flex-end;
        flex-wrap: wrap;
        margin-left: auto;
    }

    .fs-banner .fs-status-pill {
        max-width: 100%;
    }
}
`;
    doc.head.appendChild(style);
}

function getStatusPillModel(snapshot, t) {
    const status = getStatus(snapshot);
    const mode = getMode(snapshot);
    const statusModel = STATUS_MODEL[status];
    const modeLabel = MODE_LABEL[mode] ? translate(t, MODE_LABEL[mode]) : null;
    const statusLabel = translate(t, statusModel.labelKey);

    return {
        label: modeLabel ? `${statusLabel} · ${modeLabel}` : statusLabel,
        rgb: statusModel.rgb
    };
}

function getAlertBadgeModel(snapshot, t) {
    const alert = getAlerts(snapshot)[0];
    const code = getAlertCode(alert);
    const model = ALERT_MODEL[code];

    if (!model) {
        return null;
    }

    return {
        code,
        tooltip: translate(t, model.tooltipKey),
        clickable: model.clickable
    };
}

function decorateAlertBadge(doc, badge, alertModel) {
    badge.className = 'fs-alert-badge';
    badge.dataset.tooltip = alertModel.tooltip;
    badge.dataset.clickable = alertModel.clickable ? 'true' : 'false';
    badge.setAttribute('aria-label', alertModel.tooltip);

    if (alertModel.clickable) {
        badge.type = 'button';
    } else {
        badge.setAttribute('role', 'status');
    }

    const pulseRing = doc.createElement('span');
    pulseRing.className = 'pulse-ring';
    pulseRing.setAttribute('aria-hidden', 'true');

    const icon = doc.createElement('span');
    icon.className = 'fs-alert-icon';
    icon.setAttribute('aria-hidden', 'true');

    badge.append(pulseRing, icon);
}

function createAlertBadge(doc, alertModel, onOpenSettings) {
    if (!alertModel) {
        return null;
    }

    const tagName = alertModel.clickable ? 'button' : 'span';
    const badge = doc.createElement(tagName);
    decorateAlertBadge(doc, badge, alertModel);

    if (alertModel.clickable) {
        badge.addEventListener('click', () => {
            if (onOpenSettings) {
                onOpenSettings(badge.dataset.alertCode);
            }
        });
    }

    badge.dataset.alertCode = alertModel.code;

    return badge;
}

function buildBannerDom(doc, t) {
    const element = doc.createElement('section');
    element.className = 'fs-banner';
    element.setAttribute('aria-label', translate(t, 'renderer.filemgr.aria.status'));
    element.innerHTML = `
	<div class="fs-header">
	    <div class="fs-brand">
	        <div class="fs-logo-mark" aria-hidden="true"></div>
	        <div class="fs-title-wrap">
	            <h1 class="fs-title"></h1>
	            <p class="fs-subtitle"></p>
	        </div>
    </div>
    <div class="fs-banner-actions">
        <div class="fs-status-pill" role="status" aria-live="polite">
            <span class="fs-status-dot" aria-hidden="true"></span>
            <span class="fs-status-label"></span>
        </div>
        <button type="button" class="fs-refresh-btn" title="">
            <span class="fs-refresh-icon" aria-hidden="true">⟳</span>
        </button>
        <span class="fs-alert-slot"></span>
    </div>
</div>`;

    const refs = {
        element,
        title: element.querySelector('.fs-title'),
        subtitle: element.querySelector('.fs-subtitle'),
        statusLabel: element.querySelector('.fs-status-label'),
        alertSlot: element.querySelector('.fs-alert-slot'),
        refreshBtn: element.querySelector('.fs-refresh-btn'),
        alertBadge: null
    };
    refs.title.textContent = translate(t, 'renderer.filemgr.title');
    refs.subtitle.textContent = translate(t, 'renderer.filemgr.subtitle');
    refs.refreshBtn.title = translate(t, 'renderer.filemgr.refresh.tooltip');

    return refs;
}

function setAlertBadge(refs, doc, alertModel, onOpenSettings) {
    if (!alertModel) {
        refs.alertBadge?.remove();
        refs.alertBadge = null;
        return;
    }

    const expectedTagName = alertModel.clickable ? 'BUTTON' : 'SPAN';
    if (!refs.alertBadge || refs.alertBadge.tagName !== expectedTagName) {
        refs.alertBadge?.remove();
        refs.alertBadge = createAlertBadge(doc, alertModel, onOpenSettings);
        refs.alertSlot.appendChild(refs.alertBadge);
        return;
    }

    refs.alertBadge.replaceChildren();
    decorateAlertBadge(doc, refs.alertBadge, alertModel);
    refs.alertBadge.dataset.alertCode = alertModel.code;
}

function updateBanner(refs, doc, options) {
    const snapshot = getSnapshot();
    const pill = getStatusPillModel(snapshot, options.t);
    const alert = getAlertBadgeModel(snapshot, options.t);

    refs.element.style.setProperty('--filemgr-status-rgb', pill.rgb);
    refs.element.setAttribute('aria-label', translate(options.t, 'renderer.filemgr.aria.status'));
    refs.title.textContent = translate(options.t, 'renderer.filemgr.title');
    refs.subtitle.textContent = translate(options.t, 'renderer.filemgr.subtitle');
    refs.statusLabel.textContent = pill.label;
    refs.refreshBtn.title = translate(options.t, 'renderer.filemgr.refresh.tooltip');
    setAlertBadge(refs, doc, alert, options.onOpenSettings);
}

export function createBanner(options = {}) {
    const doc = resolveDocument(options.document);
    injectStyles(doc);

    const refs = buildBannerDom(doc, options.t);

    let _refreshing = false;

    const render = () => {
        updateBanner(refs, doc, options);
    };

    render();

    const unsubscribe = subscribeSnapshot(render);

    refs.refreshBtn.addEventListener('click', async () => {
        if (_refreshing) return;
        if (!options.onForceRefresh) return;

        _refreshing = true;
        refs.refreshBtn.disabled = true;
        refs.refreshBtn.classList.add('spinning');

        try {
            await options.onForceRefresh();
        } catch (err) {
            console.warn('[filemgr] force refresh failed', err);
        } finally {
            _refreshing = false;
            refs.refreshBtn.disabled = false;
            refs.refreshBtn.classList.remove('spinning');
        }
    });

    return {
        element: refs.element,
        setTranslator(translator) {
            options.t = translator;
            render();
        },
        destroy() {
            unsubscribe();
            refs.element.remove();
        }
    };
}
