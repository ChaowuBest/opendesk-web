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
 * 「消息设置」面板组件（channel-settings-panel）。
 * 挂载于设置界面（设置面板 → 消息设置 tab），管理消息渠道：
 * - 展示所有插件注册的 channel 与各账号连接状态
 * - 二维码登录 / 参数登录（模态弹窗，对齐设置面板模型编辑风格）
 * - 每个账号可配置 workspace / 模式（agent），入站消息自动使用该设定
 * - 账号登出
 */

import { createRendererTranslator } from '../locale.ts';
import { showConfirmModal, showInfoModal, MODAL_CSS, detectDarkMode } from './confirmModal.ts';
import { showWorkspacePicker } from './workspacePicker.ts';
import QRCode from 'qrcode';
import { escapeHtml } from '../../common/utils/escape.js';

const CHANNEL_MGR = 'channelmgr';

function appCall(method, ...args) {
    return window.applicationRegistryAPI.callMainWorld(CHANNEL_MGR, method, ...args);
}

function appSubscribe(event, callback) {
    return window.applicationRegistryAPI.subscribeEvent(CHANNEL_MGR, event, callback);
}

/**
 * 本地生成二维码图片 data URL。
 * 登录二维码内容（会话凭据）必须留在本地，禁止外发第三方 QR 服务。
 */
async function localQrDataUrl(content) {
    try {
        return await QRCode.toDataURL(content, { width: 240, margin: 1 });
    } catch (err) {
        console.error('[channel-settings] generate QR failed:', err);
        return '';
    }
}

/** 账号显示名：有可读名称时显示「名称 (id)」，否则只显示 id */
function accountDisplay(account) {
    const name = account && typeof account.accountName === 'string' ? account.accountName.trim() : '';
    const id = account?.accountId || '';
    if (name && name !== id) return `${name} (${id})`;
    return id;
}

/** 模态 overlay class（confirmModal 自包含深浅色） */
function modalOverlayClass() {
    return `od-confirm-modal-overlay ${detectDarkMode() ? 'od-modal-dark' : ''}`;
}

// 模块级样式注入：一次性挂到 document.head，全局生效，不受组件生命周期影响
let stylesInjected = false;
function ensureStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    try {
        const style = document.createElement('style');
        style.textContent = MODAL_CSS + CHANNEL_SETTINGS_STYLE;
        (document.head || document.documentElement).appendChild(style);
    } catch (err) {
        console.error('[channel-settings] inject styles failed:', err);
    }
}

const CHANNEL_SETTINGS_STYLE = `
.sp-channel-list { display: flex; flex-direction: column; gap: 12px; }
.sp-channel { border: 1px solid var(--sp-color-border, #E7E5E2); border-radius: var(--sp-radius-lg, 12px); background: var(--sp-color-bg, #fff); overflow: hidden; }
.sp-channel-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--sp-color-border-light, #EFEEEA); }
.sp-channel-name { font-size: 14px; font-weight: 600; color: var(--sp-color-text, #1C1917); }
.sp-channel-desc { font-size: 12px; color: var(--sp-color-text-tertiary, #8A8580); margin-top: 2px; }
.sp-channel-actions { display: flex; gap: 8px; flex-shrink: 0; }
.sp-channel-accounts { padding: 8px 12px; display: flex; flex-direction: column; gap: 6px; }
.sp-channel-account { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: var(--sp-radius-sm, 8px); background: var(--sp-color-bg-page, #F5F4F2); }
.sp-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.sp-dot-online { background: #34d399; box-shadow: 0 0 4px rgba(52, 211, 153, 0.6); }
.sp-dot-offline { background: #f87171; }
.sp-account-id { font-size: 13px; font-weight: 500; color: var(--sp-color-text, #1C1917); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sp-account-status { font-size: 12px; color: var(--sp-color-text-tertiary, #8A8580); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sp-account-runtime { font-size: 11px; color: var(--sp-color-text-tertiary, #8A8580); flex-shrink: 0; }
.sp-account-actions { display: flex; gap: 6px; flex-shrink: 0; }
.sp-channel-btn { border: 1px solid var(--sp-color-border, #E7E5E2); background: var(--sp-color-bg, #fff); color: var(--sp-color-text-secondary, #4A4642); font-size: 12px; padding: 4px 10px; border-radius: var(--sp-radius-sm, 8px); cursor: pointer; font-family: inherit; }
.sp-channel-btn:hover { background: var(--sp-color-bg-hover, #F0EFEC); }
.sp-channel-btn-primary { border-color: var(--sp-color-blue, #4267B2); color: var(--sp-color-blue, #4267B2); }
.sp-channel-btn-danger { border-color: var(--sp-color-danger, #ef4444); color: var(--sp-color-danger, #ef4444); }
.sp-channel-empty { padding: 24px; text-align: center; color: var(--sp-color-text-tertiary, #8A8580); font-size: 13px; }
.sp-qr-body { display: flex; flex-direction: column; align-items: center; gap: 10px; text-align: center; }
.sp-qr-img { width: 220px; height: 220px; border-radius: 8px; background: #fff; padding: 8px; box-sizing: border-box; }
.sp-qr-status { font-size: 13px; color: var(--mc-ink2, #4A4642); }
.sp-qr-success { color: var(--mc-accent, #1F9D66); font-size: 14px; font-weight: 500; }
.sp-qr-error { color: var(--mc-red, #ef4444); font-size: 13px; word-break: break-word; }
/* 模态表单（对齐设置面板 od-sp-* 风格） */
.od-confirm-modal-card.od-sp-wide { width: 480px; max-width: 92vw; }
.od-confirm-modal-body.od-sp-scroll { max-height: 60vh; overflow-y: auto; }
.od-sp-fg { margin-bottom: 14px; }
.od-sp-fg:last-child { margin-bottom: 0; }
.od-sp-fl { display: block; font-size: 11.5px; font-weight: 600; color: var(--mc-ink2); margin-bottom: 5px; }
.od-sp-fi {
    width: 100%; padding: 7px 12px; font-size: 13px;
    border: 1px solid var(--mc-line); border-radius: 8px;
    background: var(--mc-card-bg); color: var(--mc-ink);
    outline: none; font-family: inherit; transition: border-color 0.15s; box-sizing: border-box;
}
.od-sp-fi::placeholder { color: var(--mc-ink4); }
.od-sp-fi:focus { border-color: var(--mc-accent); }
select.od-sp-fi { appearance: none; cursor: pointer; }
`;

class ChannelSettingsPanel extends HTMLElement {
    constructor() {
        super();
        this._t = createRendererTranslator();
        this._channels = [];
        this._states = [];
        this._accounts = {};
        this._agents = [];
        this._loginModesCache = null;
        this._activeLoginOverlay = null;
        this._unsubscribers = [];
    }

    connectedCallback() {
        ensureStyles();
        void this.initialize();
    }

    disconnectedCallback() {
        for (const unsub of this._unsubscribers) {
            try {
                unsub();
            } catch {
                /* ignore */
            }
        }
        this._unsubscribers = [];
    }

    async initialize() {
        try {
            const settings = await window.top?.settingAPI?.loadSettingObject?.();
            if (settings) this._t = createRendererTranslator(settings);
        } catch {
            /* fallback */
        }
        for (const event of ['channel:connected', 'channel:disconnected', 'channel:error', 'channel:contactsUpdated']) {
            this._unsubscribers.push(await appSubscribe(event, () => void this.reload()));
        }
        this._unsubscribers.push(await appSubscribe('channel:loginStatus', (payload) => this.onLoginStatus(payload)));
        await this.reload();
    }

    async reload() {
        try {
            const [channels, states, agents] = await Promise.all([
                appCall('getChannelPlugins'),
                appCall('getChannelStates'),
                appCall('getAvailableAgents')
            ]);
            this._channels = channels || [];
            this._states = states || [];
            this._agents = agents || [];
            const accounts = {};
            for (const channel of this._channels) {
                accounts[channel.id] = (await appCall('getChannelAccounts', channel.id)) || [];
            }
            this._accounts = accounts;
            if (!this._loginModesCache) {
                await this.loadLoginModes();
            } else {
                this.render();
            }
        } catch (err) {
            console.error('[channel-settings] reload failed:', err);
            this.render();
        }
    }

    /** 拉取各渠道登录方式；参数登录仅在存在可用参数时才启用 */
    async loadLoginModes() {
        const cache = {};
        for (const channel of this._channels) {
            try {
                const modes = await appCall('getChannelLoginModes', channel.id);
                const params = (await appCall('getChannelLoginParams', channel.id)) || [];
                cache[channel.id] = {
                    qr: !!modes?.qr,
                    params: !!modes?.params && params.length > 0
                };
            } catch {
                cache[channel.id] = { qr: false, params: false };
            }
        }
        this._loginModesCache = cache;
        this.render();
    }

    render() {
        const t = this._t;
        if (this._channels.length === 0) {
            this.innerHTML = `
                <div class="sp-channel-empty">${escapeHtml(t('sp.channel.empty'))}</div>`;
            return;
        }
        const cards = this._channels
            .map((channel) => {
                const accounts = this._accounts[channel.id] || [];
                const modes = this._loginModesCache?.[channel.id] || { qr: false, params: false };
                const accountRows = accounts
                    .map((account) => {
                        const state = this._states.find(
                            (s) => s.channelId === channel.id && s.accountId === account.accountId
                        );
                        const online = state?.status?.online;
                        const dot = online ? 'sp-dot-online' : 'sp-dot-offline';
                        const runtimeParts = [];
                        if (account.runtime.workspace)
                            runtimeParts.push(`workspace: ${escapeHtml(account.runtime.workspace)}`);
                        // 仅 OpenDesk 主 agent（含未设置时默认主 agent）显示运行模式（只读/标准/效率）
                        const isMain = !account.runtime.agentId || account.runtime.agentId === 'main';
                        if (isMain && account.runtime.modeId) {
                            runtimeParts.push(`模式: ${escapeHtml(t('mode.' + account.runtime.modeId + '.name'))}`);
                        }
                        const runtime = runtimeParts.length
                            ? `<span class="sp-account-runtime">${runtimeParts.join(' · ')}</span>`
                            : '';
                        return `
                            <div class="sp-channel-account">
                                <span class="sp-dot ${dot}" title="${escapeHtml(state?.status?.statusText || '')}"></span>
                                <span class="sp-account-id" title="${escapeHtml(accountDisplay(account))}">${escapeHtml(accountDisplay(account))}</span>
                                <span class="sp-account-status">${escapeHtml(state?.status?.statusText || '')}</span>
                                ${runtime}
                                <span class="sp-account-actions">
                                    <button type="button" class="sp-channel-btn" data-action="settings" data-channel="${escapeHtml(channel.id)}" data-account="${escapeHtml(account.accountId)}">${escapeHtml(t('sp.channel.settings'))}</button>
                                    <button type="button" class="sp-channel-btn sp-channel-btn-danger" data-action="logout" data-channel="${escapeHtml(channel.id)}" data-account="${escapeHtml(account.accountId)}">${escapeHtml(t('sp.channel.logout'))}</button>
                                </span>
                            </div>`;
                    })
                    .join('');

                const qrBtn = modes.qr
                    ? `<button type="button" class="sp-channel-btn sp-channel-btn-primary" data-action="qr-login" data-channel="${escapeHtml(channel.id)}">${escapeHtml(t('sp.channel.qrLogin'))}</button>`
                    : '';
                const paramsBtn = modes.params
                    ? `<button type="button" class="sp-channel-btn" data-action="params-login" data-channel="${escapeHtml(channel.id)}">${escapeHtml(t('sp.channel.paramsLogin'))}</button>`
                    : '';

                return `
                    <div class="sp-channel">
                        <div class="sp-channel-header">
                            <div>
                                <div class="sp-channel-name">${escapeHtml(channel.label)}</div>
                                ${channel.description ? `<div class="sp-channel-desc">${escapeHtml(channel.description)}</div>` : ''}
                            </div>
                            <div class="sp-channel-actions">
                                ${qrBtn}${paramsBtn}
                                <button type="button" class="sp-channel-btn" data-action="refresh" data-channel="${escapeHtml(channel.id)}">${escapeHtml(t('sp.channel.refresh'))}</button>
                            </div>
                        </div>
                        <div class="sp-channel-accounts">${accountRows || `<div class="sp-channel-empty" style="padding:12px;">${escapeHtml(t('sp.channel.noAccount'))}</div>`}</div>
                    </div>`;
            })
            .join('');

        this.innerHTML = `
            <div class="sp-channel-list">
                ${cards}
            </div>`;

        this.querySelectorAll('[data-action]').forEach((el) => {
            el.addEventListener('click', () => void this.onAction(el));
        });
    }

    async onAction(el) {
        const action = el.dataset.action;
        const channelId = el.dataset.channel || '';
        const accountId = el.dataset.account || 'default';
        switch (action) {
            case 'reload':
                await this.reload();
                break;
            case 'refresh':
                try {
                    await appCall('restartChannelPlugin', channelId);
                } catch {
                    /* ignore */
                }
                await this.reload();
                break;
            case 'qr-login':
                this.openQrLoginModal(channelId, accountId);
                break;
            case 'params-login':
                await this.openParamsLoginModal(channelId);
                break;
            case 'settings':
                await this.openSettingsModal(channelId, accountId);
                break;
            case 'logout':
                await this.confirmLogout(channelId, accountId);
                break;
        }
    }

    /** 创建标准模态 overlay（对齐设置面板 showModal 结构） */
    createModal({ icon, title, body, footer }) {
        if (this._modalOverlay) {
            this._modalOverlay.remove();
            this._modalOverlay = null;
        }
        const overlay = document.createElement('div');
        overlay.className = modalOverlayClass();
        overlay.innerHTML = `
            <div class="od-confirm-modal-card od-sp-wide">
                <div class="od-confirm-modal-banner info">
                    <div class="od-confirm-modal-icon"><i class="fas ${icon}"></i></div>
                    <div class="od-confirm-modal-banner-text">
                        <div class="od-confirm-modal-title">${escapeHtml(title)}</div>
                    </div>
                    <button type="button" class="od-confirm-modal-close modal-close-btn" data-modal-close>${CLOSE_SVG}</button>
                </div>
                <div class="od-confirm-modal-body od-sp-scroll">${body}</div>
                <div class="od-confirm-modal-footer">${footer}</div>
            </div>`;
        document.body.appendChild(overlay);
        overlay
            .querySelectorAll('[data-modal-close]')
            .forEach((btn) => btn.addEventListener('click', () => this.closeModal(overlay)));
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) this.closeModal(overlay);
        });
        this._modalOverlay = overlay;
        return overlay;
    }

    closeModal(overlay) {
        if (!overlay.isConnected) return;
        overlay.classList.add('od-modal-leaving');
        setTimeout(() => overlay.remove(), 200);
        if (this._modalOverlay === overlay) this._modalOverlay = null;
    }

    // ── 二维码登录模态 ──────────────────────────────────────────────────────

    openQrLoginModal(channelId, accountId) {
        if (this._activeLoginOverlay) this._activeLoginOverlay.overlay.remove();
        const t = this._t;
        const overlay = this.createModal({
            icon: 'fa-qrcode',
            title: t('sp.channel.qrLogin'),
            body: `
                <div class="sp-qr-body">
                    <div class="sp-qr-status">${escapeHtml(t('sp.channel.qrWaiting'))}</div>
                </div>`,
            footer: `
                <button type="button" class="od-confirm-btn od-confirm-btn-cancel" data-modal-close>${escapeHtml(t('sp.channel.close'))}</button>`
        });

        this._activeLoginOverlay = {
            overlay,
            body: overlay.querySelector('.sp-qr-body'),
            channelId,
            accountId
        };
        this.updateLoginOverlay({ channelId, accountId, phase: 'init' });

        void appCall('startQrLogin', channelId, accountId)
            .catch(() => null)
            .then(() => {
                void this.reload();
                setTimeout(() => {
                    if (this._activeLoginOverlay?.overlay === overlay) {
                        this._activeLoginOverlay = null;
                        this.closeModal(overlay);
                    }
                }, 2000);
            });
    }

    updateLoginOverlay(state) {
        const active = this._activeLoginOverlay;
        if (!active || state.channelId !== active.channelId) return;
        const body = active.body;
        const t = this._t;
        if (state.phase === 'polling' && state.verification_url) {
            body.innerHTML = `
                <div class="sp-qr-status">${escapeHtml(t('sp.channel.qrPreparing'))}</div>`;
            // 本地生成二维码，登录内容不外发
            void localQrDataUrl(state.verification_url).then((dataUrl) => {
                const active = this._activeLoginOverlay;
                if (!active || active.body !== body || !dataUrl) return;
                active.body.innerHTML = `
                    <img class="sp-qr-img" src="${dataUrl}" alt="QR" />
                    <div class="sp-qr-status">${escapeHtml(t('sp.channel.qrScanHint'))}</div>`;
            });
        } else if (state.phase === 'success') {
            body.innerHTML = `<div class="sp-qr-success">✓ ${escapeHtml(state.message || t('sp.channel.loginSuccess'))}</div>`;
        } else if (state.phase === 'error') {
            body.innerHTML = `<div class="sp-qr-error">✗ ${escapeHtml(state.error || t('sp.channel.loginFailed'))}</div>`;
        } else if (state.phase === 'init') {
            body.innerHTML = `<div class="sp-qr-status">${escapeHtml(t('sp.channel.qrPreparing'))}</div>`;
        }
    }

    onLoginStatus(payload) {
        this.updateLoginOverlay(payload);
        if (payload.phase === 'success' || payload.phase === 'error') {
            void this.reload();
        }
    }

    // ── 参数登录模态 ────────────────────────────────────────────────────────

    async openParamsLoginModal(channelId) {
        let fields = [];
        try {
            fields = (await appCall('getChannelLoginParams', channelId)) || [];
        } catch {
            fields = [];
        }
        if (fields.length === 0) return;
        const t = this._t;
        const inputs = fields
            .map(
                (field) => `
                    <div class="od-sp-fg">
                        <label class="od-sp-fl">${escapeHtml(field.displayName)}${field.required ? ' *' : ''}</label>
                        <input class="od-sp-fi" type="${field.type === 'password' ? 'password' : 'text'}" data-field="${escapeHtml(field.name)}" ${field.required ? 'required' : ''} />
                    </div>`
            )
            .join('');
        const overlay = this.createModal({
            icon: 'fa-key',
            title: t('sp.channel.paramsLogin'),
            body: `<div data-params-form>${inputs}</div>`,
            footer: `
                <button type="button" class="od-confirm-btn od-confirm-btn-cancel" data-modal-close>${escapeHtml(t('sp.channel.cancel'))}</button>
                <button type="button" class="od-confirm-btn od-confirm-btn-primary" data-login-submit>${escapeHtml(t('sp.channel.login'))}</button>`
        });
        const submitBtn = overlay.querySelector('[data-login-submit]');
        submitBtn.addEventListener('click', async () => {
            const values = {};
            for (const field of fields) {
                const input = overlay.querySelector(`[data-field="${field.name}"]`);
                if (input) values[field.name] = input.value;
            }
            submitBtn.disabled = true;
            submitBtn.textContent = '...';
            try {
                const result = await appCall('loginChannelWithParams', channelId, 'default', values);
                if (result?.phase === 'success') {
                    this.closeModal(overlay);
                } else {
                    submitBtn.disabled = false;
                    submitBtn.textContent = t('sp.channel.login');
                    const err = document.createElement('div');
                    err.className = 'sp-qr-error';
                    err.textContent = result?.error || t('sp.channel.loginFailed');
                    overlay.querySelector('[data-params-form]').appendChild(err);
                }
            } catch (err) {
                submitBtn.disabled = false;
                submitBtn.textContent = t('sp.channel.login');
                const errEl = document.createElement('div');
                errEl.className = 'sp-qr-error';
                errEl.textContent = err?.message || String(err);
                overlay.querySelector('[data-params-form]').appendChild(errEl);
            }
            await this.reload();
        });
    }

    // ── 账号设置模态（workspace / Agent / 模式 / 模型） ─────────────────────

    /** Agent 显示名：主 agent 显示 "OpenDesk"，其他显示 agentId */
    agentDisplayName(agentId) {
        return agentId === 'main' ? 'OpenDesk' : agentId;
    }

    async openSettingsModal(channelId, accountId) {
        let runtime = {};
        try {
            runtime = (await appCall('getAccountRuntimeConfig', channelId, accountId)) || {};
        } catch {
            runtime = {};
        }
        const t = this._t;

        // 拉取 Agent 模式与模型列表
        let agentModes = [];
        try {
            agentModes = (await appCall('getAgentModes', runtime.agentId || 'main')) || [];
        } catch {
            agentModes = [];
        }
        let models = { models: [], defaultModel: '' };
        try {
            models = (await appCall('getAvailableModels')) || { models: [], defaultModel: '' };
        } catch {
            models = { models: [], defaultModel: '' };
        }

        // 消息接收方：默认 OpenDesk（main）
        const resolvedAgentId = runtime.agentId || 'main';
        const agentOptions = this._agents
            .map(
                (agentId) =>
                    `<option value="${escapeHtml(agentId)}" ${agentId === resolvedAgentId ? 'selected' : ''}>${escapeHtml(this.agentDisplayName(agentId))}</option>`
            )
            .join('');

        // 模式：仅主 agent 展示 只读/标准/效率，默认标准模式
        const isMainAgent = resolvedAgentId === 'main';
        const resolvedModeId = runtime.modeId || 'standard';
        const modeOptions = agentModes
            .map(
                (mode) =>
                    `<option value="${escapeHtml(mode.id || '')}" ${mode.id === resolvedModeId ? 'selected' : ''}>${escapeHtml(mode.name || '')}</option>`
            )
            .join('');

        // 模型：默认「默认对话模型」（空值，跟随系统默认模型切换）；仅显式配置且有效时选中具体模型
        const selectedModel = runtime.model && models.models.includes(runtime.model) ? runtime.model : '';
        const modelOptions = ['', ...models.models]
            .map(
                (model) =>
                    `<option value="${escapeHtml(model)}" ${model === selectedModel ? 'selected' : ''}>${escapeHtml(model || t('sp.channel.defaultModel'))}</option>`
            )
            .join('');

        // 消息分发策略：总是同任务 / 空闲超时切换（默认 1 天）/ 智能投递
        const resolvedDispatchMode = runtime.dispatchPolicy?.mode || 'timeout';
        const resolvedTimeoutMinutes = String(runtime.dispatchPolicy?.timeoutMinutes || 1440);
        const dispatchModeOptions = [
            ['sticky', 'sp.channel.dispatchPolicy.sticky'],
            ['timeout', 'sp.channel.dispatchPolicy.timeout'],
            ['smart', 'sp.channel.dispatchPolicy.smart']
        ]
            .map(
                ([value, key]) =>
                    `<option value="${value}" ${value === resolvedDispatchMode ? 'selected' : ''}>${escapeHtml(t(key))}</option>`
            )
            .join('');
        const TIMEOUT_MINUTE_OPTIONS = ['15', '30', '60', '120', '300', '1440'];
        // 配置里若是预设之外的值（手改/旧版本写入），也要原样出现在下拉里：
        // 否则 select 会落到第一项，用户一保存就把间隔静默改成 15 分钟
        const timeoutMinuteChoices = TIMEOUT_MINUTE_OPTIONS.includes(resolvedTimeoutMinutes)
            ? TIMEOUT_MINUTE_OPTIONS
            : [...TIMEOUT_MINUTE_OPTIONS, resolvedTimeoutMinutes].sort((a, b) => Number(a) - Number(b));
        const timeoutLabel = (minutes) =>
            TIMEOUT_MINUTE_OPTIONS.includes(minutes)
                ? t('sp.channel.dispatchTimeout.' + minutes)
                : t('sp.channel.dispatchTimeout.minutes', { minutes });
        const dispatchTimeoutOptions = timeoutMinuteChoices
            .map(
                (minutes) =>
                    `<option value="${minutes}" ${minutes === resolvedTimeoutMinutes ? 'selected' : ''}>${escapeHtml(timeoutLabel(minutes))}</option>`
            )
            .join('');

        const overlay = this.createModal({
            icon: 'fa-sliders',
            title: t('sp.channel.accountSettings') + ' · ' + escapeHtml(accountDisplay({ accountId })),
            body: `
                <div class="od-sp-fg">
                    <label class="od-sp-fl">${escapeHtml(t('sp.channel.workspace'))}</label>
                    <div style="display:flex;gap:8px;">
                        <input class="od-sp-fi" style="flex:1;" type="text" data-runtime-field="workspace" value="${escapeHtml(runtime.workspace || '')}" placeholder="${escapeHtml(t('sp.channel.workspacePlaceholder'))}" />
                        <button type="button" class="sp-channel-btn" data-pick-workspace>${escapeHtml(t('sp.channel.pickWorkspace'))}</button>
                    </div>
                </div>
                <div class="od-sp-fg">
                    <label class="od-sp-fl">${escapeHtml(t('sp.channel.agent'))}</label>
                    <select class="od-sp-fi" data-runtime-field="agentId">${agentOptions}</select>
                </div>
                <div class="od-sp-fg" data-mode-field style="${isMainAgent ? '' : 'display:none;'}">
                    <label class="od-sp-fl">${escapeHtml(t('sp.channel.mode'))}</label>
                    <select class="od-sp-fi" data-runtime-field="modeId">${modeOptions}</select>
                </div>
                <div class="od-sp-fg">
                    <label class="od-sp-fl">${escapeHtml(t('sp.channel.model'))}</label>
                    <select class="od-sp-fi" data-runtime-field="model">${modelOptions}</select>
                </div>
                <div class="od-sp-fg">
                    <label class="od-sp-fl">${escapeHtml(t('sp.channel.dispatchPolicy'))}</label>
                    <select class="od-sp-fi" data-dispatch-mode>${dispatchModeOptions}</select>
                </div>
                <div class="od-sp-fg" data-timeout-field>
                    <label class="od-sp-fl">${escapeHtml(t('sp.channel.dispatchTimeout'))}</label>
                    <select class="od-sp-fi" data-dispatch-timeout>${dispatchTimeoutOptions}</select>
                </div>`,
            footer: `
                <button type="button" class="od-confirm-btn od-confirm-btn-cancel" data-modal-close>${escapeHtml(t('sp.channel.cancel'))}</button>
                <button type="button" class="od-confirm-btn od-confirm-btn-primary" data-save-runtime>${escapeHtml(t('sp.channel.save'))}</button>`
        });

        // 工作空间选择（复用 taskview 的 showWorkspacePicker）
        overlay.querySelector('[data-pick-workspace]').addEventListener('click', async () => {
            const picked = await showWorkspacePicker({
                title: t('sp.channel.pickWorkspace'),
                t: this._t
            });
            if (picked) {
                const input = overlay.querySelector('[data-runtime-field="workspace"]');
                if (input) input.value = picked;
            }
        });

        // Agent 切换：仅主 agent 显示模式下拉；非主 agent 清空模式
        const agentSelect = overlay.querySelector('[data-runtime-field="agentId"]');
        const modeField = overlay.querySelector('[data-mode-field]');
        const modeSelect = overlay.querySelector('[data-runtime-field="modeId"]');
        const refreshModes = async (agentId) => {
            let modes = [];
            try {
                modes = (await appCall('getAgentModes', agentId || 'main')) || [];
            } catch {
                modes = [];
            }
            const options = ['', ...modes]
                .map((mode) => `<option value="${escapeHtml(mode.id || '')}">${escapeHtml(mode.name || '')}</option>`)
                .join('');
            modeSelect.innerHTML = options;
            modeField.style.display = '';
        };
        agentSelect.addEventListener('change', () => {
            const agentId = agentSelect.value;
            if (agentId && agentId !== 'main') {
                modeField.style.display = 'none';
                modeSelect.value = '';
            } else {
                void refreshModes(agentId);
            }
        });

        // 分发策略切换：仅 timeout 模式显示空闲切换周期下拉
        const dispatchModeSelect = overlay.querySelector('[data-dispatch-mode]');
        const timeoutField = overlay.querySelector('[data-timeout-field]');
        const syncTimeoutField = () => {
            timeoutField.style.display = dispatchModeSelect.value === 'timeout' ? '' : 'none';
        };
        dispatchModeSelect.addEventListener('change', syncTimeoutField);
        syncTimeoutField();

        overlay.querySelector('[data-save-runtime]').addEventListener('click', async () => {
            const next = {
                workspace: overlay.querySelector('[data-runtime-field="workspace"]')?.value || undefined,
                agentId: overlay.querySelector('[data-runtime-field="agentId"]')?.value || 'main',
                modeId: overlay.querySelector('[data-runtime-field="modeId"]')?.value || 'standard',
                model: overlay.querySelector('[data-runtime-field="model"]')?.value || undefined,
                dispatchPolicy: {
                    mode: dispatchModeSelect?.value || 'timeout',
                    timeoutMinutes: Number(overlay.querySelector('[data-dispatch-timeout]')?.value || 1440)
                }
            };
            try {
                await appCall('setAccountRuntimeConfig', channelId, accountId, next);
            } catch (err) {
                console.error('[channel-settings] setAccountRuntimeConfig failed:', err);
                // 保存失败不能静默关窗：用户会以为设置已生效，而配置其实没写进去
                await showInfoModal({
                    variant: 'danger',
                    icon: 'fa-circle-exclamation',
                    title: t('sp.channel.saveFailed'),
                    message: escapeHtml(String(err?.message || err)),
                    confirmText: t('sp.channel.save')
                });
                return;
            }
            this.closeModal(overlay);
            await this.reload();
        });
    }

    // ── 登出 ────────────────────────────────────────────────────────────────

    async confirmLogout(channelId, accountId) {
        const title = this._t('sp.channel.logout');
        const confirmed = await showConfirmModal({
            icon: 'fa-right-from-bracket',
            iconBg: '#FEF2F2',
            iconColor: '#DC2626',
            title,
            message:
                escapeHtml(this._t('sp.channel.logoutConfirm')) +
                '<br><b>' +
                escapeHtml(`${channelId} · ${accountId}`) +
                '</b>',
            confirmText: title,
            cancelText: this._t('sp.channel.cancel')
        });
        if (!confirmed) return;
        try {
            const result = await appCall('logoutChannelAccount', channelId, accountId);
            if (result?.ok) {
                await this.reload();
            } else {
                await showConfirmModal({
                    icon: 'fa-circle-xmark',
                    iconBg: '#FEF2F2',
                    iconColor: '#DC2626',
                    title: this._t('sp.channel.loginFailed'),
                    message: escapeHtml(result?.message || ''),
                    confirmText: this._t('sp.channel.close'),
                    cancelText: null
                });
            }
        } catch (err) {
            await showConfirmModal({
                icon: 'fa-circle-xmark',
                iconBg: '#FEF2F2',
                iconColor: '#DC2626',
                title: this._t('sp.channel.loginFailed'),
                message: escapeHtml(err?.message || String(err)),
                confirmText: this._t('sp.channel.close'),
                cancelText: null
            });
        }
    }
}

const CLOSE_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

customElements.define('channel-settings-panel', ChannelSettingsPanel);
