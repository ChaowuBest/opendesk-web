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
 * 「仓库设置」面板的共用实现（registryChannelSettings）。
 *
 * 设置界面里的两类仓库面板长得一样：测评集仓库（benchmark-channel-settings）与插件仓库
 * （plugin-channel-settings）。两者都是「一处远端清单地址」的管理面板：
 * - 最上面是系统默认仓库（官方清单地址），只能启停，不能改名/改地址/删除；
 * - 其余是用户自己添加的仓库，支持编辑、删除、启停；
 * - 添加/编辑的模态弹窗点确定时，由主进程联网验证清单确实可解析，验证不过不落配置。
 *
 * 差别只有应用包名、主进程接口方法名、文案前缀与几个 DOM id，因此放在同一个基类里实现：
 * 改一处两边都跟着改，不会再出现「测评集仓库修了、插件仓库忘了修」的漂移。
 * 子类只需提供一份 `static registryChannelConfig` 并注册自定义元素。
 *
 * 刷新策略：启停只改这一行（开关 + 状态标签），增删改只重画列表容器，
 * 都不重建整个面板——设置界面的其它 Tab 状态与滚动位置因此不会被搅乱。
 */

import { createRendererTranslator } from '../locale.ts';
import { showConfirmModal, MODAL_CSS, detectDarkMode } from './confirmModal.ts';
import { escapeHtml } from '../../common/utils/escape.js';

const CLOSE_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

/**
 * CSS 属性选择器里用的转义。
 *
 * 仓库 id 来自配置（可被外部工具直接改写），拼进 `[data-xxx="…"]` 前必须转义；
 * 单元测试环境没有 CSS.escape，退化成只处理引号与反斜杠。
 */
function escapeSelector(value) {
    const text = String(value ?? '');
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(text);
    return text.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

/**
 * 面板样式。类名带仓库类型前缀（`sp-bm-channel` / `sp-pc-channel`）：两个面板同时挂在
 * 「仓库设置」页签里，样式是全局的，共用一个前缀会互相影响。
 */
function buildChannelSettingsStyle(config) {
    const prefix = `${config.cssPrefix}-channel`;
    return `
/* 模态表单元素样式：设置面板只在它自己弹窗时注入这套 od-sp-*，本组件的弹窗必须自带一份 */
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
.${prefix}-list { display: flex; flex-direction: column; gap: 10px; }
.${prefix}-count:empty { display: none; }
.${prefix} { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
.${prefix}-main { flex: 1; min-width: 0; }
.${prefix}-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.${prefix}-name { font-size: 13.5px; font-weight: 600; color: var(--sp-color-text, #1C1917); overflow-wrap: anywhere; }
.${prefix}-url { margin-top: 4px; font-size: 11.5px; color: var(--sp-color-text-tertiary, #8A8580); overflow-wrap: anywhere; }
.${prefix}-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.${prefix}-actions .sp-toggle-switch { margin-left: 0; }
.${prefix}-empty { padding: 20px; text-align: center; font-size: 12.5px; color: var(--sp-color-text-tertiary, #8A8580); }
.${prefix}-hint { margin-top: 12px; font-size: 12px; color: var(--sp-color-text-secondary, #4A4642); }
.${prefix}-error { margin-top: 10px; font-size: 11.5px; line-height: 1.5; color: var(--sp-color-danger, #ef4444); overflow-wrap: anywhere; }
.${prefix}-error[hidden] { display: none; }
`;
}

/** 模块级样式注入：一次性挂到 document.head，组件重建不会重复插入 */
function ensureStyles(config) {
    if (document.getElementById(config.styleId)) return;
    try {
        const style = document.createElement('style');
        style.id = config.styleId;
        style.textContent = `${MODAL_CSS}\n${buildChannelSettingsStyle(config)}`;
        (document.head || document.documentElement).appendChild(style);
    } catch (error) {
        console.error(`[${config.logTag}] inject styles failed:`, error);
    }
}

export class RegistryChannelSettings extends HTMLElement {
    constructor() {
        super();
        this._t = createRendererTranslator();
        this._channels = [];
        this._loading = true;
        this._error = '';
        this._unsubscribers = [];
        this._modal = null;
        this._modalKeyHandler = null;
        /** 正在提交的仓库开关：避免同一条仓库的并发点击把配置写乱 */
        this._pendingToggles = new Set();
    }

    /** 子类声明的差异化配置（应用包名、文案前缀、DOM id、接口方法名） */
    get config() {
        return this.constructor.registryChannelConfig;
    }

    /** 文案键：`sp.pluginChannel.count` 这类前缀由子类配置决定 */
    _k(name) {
        return `${this.config.i18n}.${name}`;
    }

    callMainWorld(method, ...args) {
        return window.applicationRegistryAPI.callMainWorld(this.config.app, method, ...args);
    }

    subscribeEvent(event, callback) {
        return window.applicationRegistryAPI.subscribeEvent(this.config.app, event, callback);
    }

    connectedCallback() {
        ensureStyles(this.config);
        void this.initialize();
    }

    disconnectedCallback() {
        for (const unsubscribe of this._unsubscribers) {
            try {
                unsubscribe();
            } catch {
                /* 退订失败不影响组件卸载 */
            }
        }
        this._unsubscribers = [];
        this._closeModal();
    }

    async initialize() {
        try {
            const settings = await window.settingAPI?.loadSettingObject?.();
            if (settings) this._t = createRendererTranslator(settings);
        } catch {
            /* 拿不到设置里的语言就用默认语言 */
        }
        if (!this.isConnected) return;
        // 先把外壳摆出来（列表显示加载态），别让这个 Tab 在首次 IPC 回来前一片空白
        this.render();
        // 仓库变化也可能来自别的窗口，订阅后这里只重画列表
        try {
            const unsubscribe = await this.subscribeEvent(
                'registriesChanged',
                () => void this.reload({ silent: true })
            );
            if (!this.isConnected) {
                // 订阅期间组件已被卸载：立刻退订，别把回调留在一个已销毁的面板上
                unsubscribe();
                return;
            }
            this._unsubscribers.push(unsubscribe);
        } catch (error) {
            console.warn(`[${this.config.logTag}] subscribe registriesChanged failed:`, error);
        }
        if (!this.isConnected) return;
        await this.reload();
    }

    /**
     * 从主进程取一份仓库列表并重画列表。
     *
     * silent 用于后台刷新（仓库变化事件）：失败时保留现有列表，不要把界面切成错误页。
     */
    async reload({ silent = false } = {}) {
        const wasLoading = this._loading;
        try {
            const channels = await this.callMainWorld(this.config.api.list);
            // 首次返回时即使列表为空也要重画一次，否则「正在加载」会一直留在界面上
            this._applyChannels(Array.isArray(channels) ? channels : [], { force: wasLoading });
        } catch (error) {
            this._loading = false;
            if (silent) return;
            this._error = error?.message || this._t(this._k('loadFailed'));
            this._channels = [];
            this.renderList();
        }
    }

    render() {
        const prefix = `${this.config.cssPrefix}-channel`;
        this.innerHTML = `
            <section class="sp-section">
                <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:16px">
                    <div style="min-width:0">
                        <h2 class="sp-section-title">${escapeHtml(this._t(this._k('title')))}</h2>
                        <p class="sp-section-desc" style="margin-bottom:0">${escapeHtml(this._t(this._k('desc')))}</p>
                    </div>
                    <span class="sp-tag sp-tag-neutral ${prefix}-count" data-channel-count style="flex-shrink:0"></span>
                </div>
                <div class="sp-section-card">
                    <div class="${prefix}-list" data-channel-list></div>
                    <button type="button" id="${this.config.dom.addButton}" class="sp-add-btn" style="margin-top:14px">
                        <i class="fas fa-plus" style="margin-right:8px"></i>${escapeHtml(this._t(this._k('add')))}
                    </button>
                    <p class="${prefix}-hint">
                        <i class="fas fa-circle-info" style="margin-right:5px"></i>${escapeHtml(
                            this._t(this._k('hint'))
                        )}
                    </p>
                </div>
            </section>`;
        this.querySelector(`#${this.config.dom.addButton}`)?.addEventListener('click', () => this.openEditModal(null));
        this.renderList();
    }

    /** 只重画列表与计数：启停/增删改都走这里，不动面板的其它部分 */
    renderList() {
        const prefix = `${this.config.cssPrefix}-channel`;
        const list = this.querySelector('[data-channel-list]');
        if (!list) {
            this.render();
            return;
        }
        const count = this.querySelector('[data-channel-count]');
        if (count) {
            // 加载中 / 出错时不留一个「共 0 个仓库」的错数：空内容由 :empty 规则整块隐藏
            count.textContent =
                this._loading || this._error ? '' : this._t(this._k('count'), { count: this._channels.length });
        }
        if (this._loading) {
            list.innerHTML = `<div class="${prefix}-empty">${escapeHtml(this._t(this._k('loading')))}</div>`;
            return;
        }
        if (this._error) {
            list.innerHTML = `<div class="${prefix}-error">${escapeHtml(this._error)}</div>`;
            return;
        }
        if (this._channels.length === 0) {
            list.innerHTML = `<div class="${prefix}-empty">${escapeHtml(this._t(this._k('empty')))}</div>`;
            return;
        }
        list.innerHTML = this._channels.map((channel) => this.renderChannel(channel)).join('');
        this._bindListEvents();
    }

    renderChannel(channel) {
        const prefix = `${this.config.cssPrefix}-channel`;
        const isDefault = channel.isDefault === true;
        const enabled = channel.isEnabled !== false;
        // 系统默认仓库不提供编辑/删除：它的地址是官方常量，改了也没有意义
        const actions = isDefault
            ? ''
            : `<button type="button" class="sp-btn sp-btn-sm sp-btn-secondary" data-action="edit" data-channel-id="${escapeHtml(channel.id)}">${escapeHtml(this._t(this._k('edit')))}</button>
               <button type="button" class="sp-btn sp-btn-sm sp-btn-danger" data-action="delete" data-channel-id="${escapeHtml(channel.id)}">${escapeHtml(this._t(this._k('delete')))}</button>`;
        const toggleHint = escapeHtml(this._t(this._k('toggleHint')));
        return `
        <div class="sp-card ${prefix}" data-channel-row="${escapeHtml(channel.id)}">
            <div class="${prefix}-main">
                <div class="${prefix}-title">
                    <span class="${prefix}-name">${escapeHtml(channel.name)}</span>
                    ${
                        isDefault
                            ? `<span class="sp-tag sp-tag-primary">${escapeHtml(this._t(this._k('systemDefault')))}</span>`
                            : ''
                    }
                    <span class="sp-tag ${enabled ? 'sp-tag-success' : 'sp-tag-neutral'}" data-channel-status="${escapeHtml(channel.id)}">
                        ${escapeHtml(this._t(this._k(enabled ? 'enabled' : 'disabled')))}
                    </span>
                </div>
                <div class="${prefix}-url" title="${escapeHtml(channel.url)}">${escapeHtml(channel.url)}</div>
            </div>
            <div class="${prefix}-actions">
                <label class="sp-toggle-switch" title="${toggleHint}">
                    <input type="checkbox" data-channel-toggle="${escapeHtml(channel.id)}" ${enabled ? 'checked' : ''}
                        aria-label="${toggleHint}">
                    <span class="sp-toggle-track"></span>
                </label>
                ${actions}
            </div>
        </div>`;
    }

    _bindListEvents() {
        this.querySelectorAll('[data-channel-toggle]').forEach((input) => {
            input.addEventListener('change', () => void this.toggleChannel(input.dataset.channelToggle, input.checked));
        });
        this.querySelectorAll('[data-action="edit"]').forEach((button) => {
            button.addEventListener('click', () => this.openEditModal(button.dataset.channelId));
        });
        this.querySelectorAll('[data-action="delete"]').forEach((button) => {
            button.addEventListener('click', () => void this.deleteChannel(button.dataset.channelId));
        });
    }

    /** 启停只改这一行：开关状态先乐观切换，失败再回滚 */
    async toggleChannel(id, enabled) {
        if (!id) return;
        const applyState = (value) => {
            const channel = this._channels.find((item) => item.id === id);
            if (channel) channel.isEnabled = value;
            // 每次都按 id 重新取节点：这一行可能刚被别的刷新重画过，
            // 拿着旧引用去改只会改到已经脱离文档的元素上，界面显示的仍是错的状态
            const input = this.querySelector(`[data-channel-toggle="${escapeSelector(id)}"]`);
            if (input) input.checked = value;
            const status = this.querySelector(`[data-channel-status="${escapeSelector(id)}"]`);
            if (status) {
                status.textContent = this._t(this._k(value ? 'enabled' : 'disabled'));
                status.className = `sp-tag ${value ? 'sp-tag-success' : 'sp-tag-neutral'}`;
            }
        };
        if (this._pendingToggles.has(id)) {
            // 上一次请求还没回来：把被浏览器翻过去的开关拨回当前已知状态，
            // 否则界面会显示一个后端并不认可的值
            const channel = this._channels.find((item) => item.id === id);
            const input = this.querySelector(`[data-channel-toggle="${escapeSelector(id)}"]`);
            if (input && channel) input.checked = channel.isEnabled !== false;
            return;
        }
        this._pendingToggles.add(id);
        const previous = !enabled;
        applyState(enabled);
        try {
            await this.callMainWorld(this.config.api.setEnabled, id, enabled);
        } catch (error) {
            applyState(previous);
            this._notifyError(this._t(this._k('toggleFailed'), { message: error?.message || '' }));
        } finally {
            this._pendingToggles.delete(id);
        }
    }

    async deleteChannel(id) {
        const channel = this._channels.find((item) => item.id === id);
        if (!channel) return;
        const confirmed = await showConfirmModal({
            variant: 'danger',
            icon: 'fa-trash',
            title: this._t(this._k('delete')),
            message: this._t(this._k('deleteConfirm'), { name: channel.name }),
            confirmText: this._t(this._k('delete')),
            cancelText: this._t('common.cancel')
        });
        if (!confirmed) return;
        try {
            const channels = await this.callMainWorld(this.config.api.remove, id);
            this._applyChannels(channels);
        } catch (error) {
            this._notifyError(this._t(this._k('deleteFailed'), { message: error?.message || '' }));
        }
    }

    /**
     * 用主进程给的最新列表刷新本地状态。
     *
     * 列表没变就不重画：启停/增删的返回值与 registriesChanged 事件都会走到这里，
     * 没变化还整片重画会把用户正在点的开关（焦点、动画）一起换掉。
     */
    _applyChannels(channels, { force = false } = {}) {
        if (!Array.isArray(channels)) return;
        const changed = JSON.stringify(channels) !== JSON.stringify(this._channels);
        this._channels = channels;
        this._error = '';
        this._loading = false;
        if (changed || force) this.renderList();
    }

    _notifyError(message) {
        window.notificationAPI?.sendNotification(
            'error',
            this._t(this._k('title')),
            this._t(this._k('operationFailed')),
            message
        );
    }

    // ── 添加 / 编辑弹窗 ────────────────────────────────────────────────────

    openEditModal(channelId) {
        // 弹窗已经开着（例如连点两次添加）：不新建第二个，否则前一个会失去引用留在屏幕上
        if (this._modal) return;
        const editing = channelId ? this._channels.find((item) => item.id === channelId) : null;
        // 系统默认仓库只能启停，连弹窗都不该打开
        if (channelId && !editing) return;
        if (editing?.isDefault) return;
        const isEdit = Boolean(editing);
        const { nameInput, urlInput } = this.config.dom;
        const overlay = document.createElement('div');
        overlay.className = `od-confirm-modal-overlay ${detectDarkMode() ? 'od-modal-dark' : ''}`;
        overlay.innerHTML = `
            <div class="od-confirm-modal-card od-sp-wide">
                <div class="od-confirm-modal-banner info">
                    <div class="od-confirm-modal-icon"><i class="fas ${this.config.icon}"></i></div>
                    <div class="od-confirm-modal-banner-text">
                        <div class="od-confirm-modal-title">${escapeHtml(
                            this._t(this._k(isEdit ? 'editTitle' : 'addTitle'))
                        )}</div>
                    </div>
                    <button type="button" class="od-confirm-modal-close" data-modal-close aria-label="${escapeHtml(
                        this._t('common.close')
                    )}">${CLOSE_SVG}</button>
                </div>
                <div class="od-confirm-modal-body od-sp-scroll">
                    <div class="od-sp-fg">
                        <label class="od-sp-fl" for="${nameInput}">${escapeHtml(this._t(this._k('name')))}</label>
                        <input id="${nameInput}" class="od-sp-fi" type="text" autocomplete="off"
                            placeholder="${escapeHtml(this._t(this._k('namePlaceholder')))}"
                            value="${escapeHtml(editing?.name || '')}">
                    </div>
                    <div class="od-sp-fg">
                        <label class="od-sp-fl" for="${urlInput}">${escapeHtml(this._t(this._k('url')))}</label>
                        <input id="${urlInput}" class="od-sp-fi" type="text" autocomplete="off" spellcheck="false"
                            placeholder="${escapeHtml(this._t(this._k('urlPlaceholder')))}"
                            value="${escapeHtml(editing?.url || '')}">
                        <p class="${this.config.cssPrefix}-channel-hint" style="margin-top:6px">${escapeHtml(
                            this._t(this._k('urlHint'))
                        )}</p>
                    </div>
                    <div class="${this.config.cssPrefix}-channel-error" data-modal-error hidden></div>
                </div>
                <div class="od-confirm-modal-footer">
                    <button type="button" class="od-confirm-btn od-confirm-btn-cancel" data-modal-close>${escapeHtml(
                        this._t('common.cancel')
                    )}</button>
                    <button type="button" class="od-confirm-btn od-confirm-btn-primary" data-modal-confirm>${escapeHtml(
                        this._t('common.confirm')
                    )}</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        this._modal = { overlay, channelId: editing?.id ?? null };

        overlay.querySelectorAll('[data-modal-close]').forEach((button) => {
            button.addEventListener('click', () => this._closeModal());
        });
        overlay.addEventListener('mousedown', (event) => {
            if (event.target === overlay) this._closeModal();
        });
        overlay.querySelector('[data-modal-confirm]')?.addEventListener('click', () => {
            void this.submitModal();
        });
        // 回车提交、ESC 关闭：与设置面板其它弹窗一致。只在输入框里响应回车，
        // 免得焦点落在「取消」按钮上时回车既提交又关闭。
        overlay.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' || event.isComposing) return;
            if (!(event.target instanceof HTMLInputElement)) return;
            event.preventDefault();
            void this.submitModal();
        });
        this._modalKeyHandler = (event) => {
            if (event.key !== 'Escape') return;
            event.stopPropagation();
            this._closeModal();
        };
        document.addEventListener('keydown', this._modalKeyHandler, true);
        const first = overlay.querySelector(`#${nameInput}`);
        first?.focus();
        if (isEdit) first?.setSelectionRange?.(first.value.length, first.value.length);
    }

    async submitModal() {
        const modal = this._modal;
        if (!modal) return;
        const overlay = modal.overlay;
        const { nameInput: nameInputId, urlInput: urlInputId } = this.config.dom;
        const nameInput = overlay.querySelector(`#${nameInputId}`);
        const urlInput = overlay.querySelector(`#${urlInputId}`);
        const errorBox = overlay.querySelector('[data-modal-error]');
        const confirmBtn = overlay.querySelector('[data-modal-confirm]');
        if (!nameInput || !urlInput || !confirmBtn) return;
        if (confirmBtn.disabled) return;

        const name = nameInput.value.trim();
        const url = urlInput.value.trim();
        const showError = (message) => {
            if (!errorBox) return;
            errorBox.textContent = message;
            errorBox.hidden = false;
        };
        if (!name) {
            showError(this._t(this._k('nameRequired')));
            nameInput.focus();
            return;
        }
        if (!url) {
            showError(this._t(this._k('urlRequired')));
            urlInput.focus();
            return;
        }

        const isEdit = Boolean(modal.channelId);
        const originalText = confirmBtn.textContent;
        confirmBtn.disabled = true;
        confirmBtn.textContent = this._t(this._k('verifying'));
        if (errorBox) errorBox.hidden = true;
        try {
            const channels = isEdit
                ? await this.callMainWorld(this.config.api.update, modal.channelId, { name, url })
                : await this.callMainWorld(this.config.api.add, { name, url });
            // 请求期间用户可能已经关掉（甚至换了）弹窗：只关自己那一个，别误伤新的
            if (this._modal === modal) this._closeModal();
            this._applyChannels(channels);
        } catch (error) {
            // 校验不通过时保留用户输入，让他改完再试一次
            if (this._modal !== modal) return;
            showError(error?.message || this._t(this._k(isEdit ? 'editFailed' : 'addFailed')));
            confirmBtn.disabled = false;
            confirmBtn.textContent = originalText;
        }
    }

    _closeModal() {
        if (this._modalKeyHandler) {
            document.removeEventListener('keydown', this._modalKeyHandler, true);
            this._modalKeyHandler = null;
        }
        const modal = this._modal;
        this._modal = null;
        if (!modal) return;
        modal.overlay.classList.add('od-modal-leaving');
        setTimeout(() => modal.overlay.remove(), 200);
    }
}
