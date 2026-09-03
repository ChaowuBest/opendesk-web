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
import { isAccountFeatureEnabled } from '../utils/account-feature-visibility.ts';
import accountPanelCss from '../styles/accountpanel.css?inline';

interface AccountUser {
    id: string;
    username: string;
    email?: string;
    display_name?: string;
    avatar_url?: string;
}

interface AccountSession {
    kind: 'personal' | 'enterprise';
    baseUrl: string;
    user: AccountUser;
}

/**
 * 账号面板组件（自包含、与页面解耦）。
 *
 * 仅用于个人中心：通过 window.accountAPI 拉取登录方式与会话，监听 account:sessionChanged 自刷新。
 * mode 为 nologin 时自隐藏，个人中心保持原样。弹出层支持点击外部 / Escape 关闭。
 */
class AccountPanel extends HTMLElement {
    private readonly root: ShadowRoot;
    private mode: 'personal' | 'enterprise' | 'nologin' = 'nologin';
    private featureEnabled = false;
    private session: AccountSession | null = null;
    private expanded = false;
    private editing = false;
    private confirmLogout = false;
    private showPassword = false;
    private busy = false;
    private error: string | null = null;
    private success: string | null = null;
    private loginUsername = '';
    private loginPassword = '';
    private displayNameDraft = '';
    private t = createRendererTranslator();
    private unsubscribeSession: (() => void) | null = null;

    constructor() {
        super();
        this.root = this.attachShadow({ mode: 'open' });
    }

    connectedCallback(): void {
        this.render();
        document.addEventListener('click', this.handleOutsideClick);
        document.addEventListener('keydown', this.handleKeydown);
        void this.initialize();
    }

    disconnectedCallback(): void {
        this.unsubscribeSession?.();
        this.unsubscribeSession = null;
        document.removeEventListener('click', this.handleOutsideClick);
        document.removeEventListener('keydown', this.handleKeydown);
    }

    private handleOutsideClick = (event: Event): void => {
        const path = event.composedPath();
        if (this.expanded && !path.includes(this)) {
            this.expanded = false;
            this.error = null;
            this.success = null;
            this.render();
        }
    };

    private handleKeydown = (event: KeyboardEvent): void => {
        if (event.key === 'Escape' && this.expanded) {
            this.expanded = false;
            this.error = null;
            this.success = null;
            this.render();
        }
    };

    private async initialize(): Promise<void> {
        try {
            const settingAPI = (window as any).settingAPI;
            if (settingAPI?.loadSettingObject) {
                const setting = await settingAPI.loadSettingObject();
                this.t = createRendererTranslator(setting);
                this.featureEnabled = isAccountFeatureEnabled(setting);
            }
        } catch {
            // 使用默认语言
        }
        if (!this.featureEnabled) {
            this.render();
            return;
        }
        try {
            const api = (window as any).accountAPI;
            if (api?.getConfig) {
                this.mode = (await api.getConfig()).mode;
            }
            if (api?.getSession) {
                this.session = (await api.getSession()) ?? null;
            }
            if (api?.onSessionChanged && !this.unsubscribeSession) {
                this.unsubscribeSession = api.onSessionChanged((session: AccountSession | null) => {
                    this.session = session ?? null;
                    this.expanded = false;
                    this.editing = false;
                    this.confirmLogout = false;
                    this.error = null;
                    this.success = null;
                    this.render();
                });
            }
        } catch {
            // 账号 API 不可用时保持未登录态
        }
        this.render();
    }

    private displayName(user: AccountUser): string {
        return user.display_name || user.username;
    }

    private avatarInitial(user: AccountUser): string {
        const name = this.displayName(user);
        return name ? name.charAt(0).toUpperCase() : '?';
    }

    /** 将后端返回的相对头像地址解析为完整 URL（基于会话 base_url 的 origin）。 */
    private resolveAvatarUrl(url: string): string {
        if (/^https?:\/\//i.test(url)) {
            return url;
        }
        try {
            return new URL(url, this.session?.baseUrl).href;
        } catch {
            return url;
        }
    }

    private renderAvatar(user: AccountUser, className: string): string {
        if (user.avatar_url) {
            return `<img class="${className}" src="${escapeHtml(this.resolveAvatarUrl(user.avatar_url))}" alt="">`;
        }
        return `<span class="${className}">${escapeHtml(this.avatarInitial(user))}</span>`;
    }

    private renderTrigger(): string {
        if (this.session) {
            return `<button class="trigger" type="button" data-action="toggle" title="${escapeHtml(this.displayName(this.session.user))}">
                ${this.renderAvatar(this.session.user, 'trigger-avatar')}
                <span class="trigger-name">${escapeHtml(this.displayName(this.session.user))}</span>
            </button>`;
        }
        return `<button class="trigger" type="button" data-action="toggle">
            <span class="trigger-avatar">${escapeHtml(this.t('renderer.account.login'))}</span>
        </button>`;
    }

    private renderLoginForm(): string {
        const enterpriseUrl =
            this.mode === 'enterprise'
                ? `<p class="url-info">${escapeHtml(this.t('renderer.account.enterpriseBaseUrl'))}</p>`
                : '';
        return `
            <form data-form="login">
                <h2 class="form-title">${escapeHtml(this.t('renderer.account.loginTitle'))}</h2>
                ${enterpriseUrl}
                <div class="field">
                    <label for="ap-username">${escapeHtml(this.t('renderer.account.username'))}</label>
                    <input id="ap-username" data-username type="text" autocomplete="username" value="${escapeHtml(this.loginUsername)}">
                </div>
                <div class="field">
                    <label for="ap-password">${escapeHtml(this.t('renderer.account.password'))}</label>
                    <div class="password-wrap">
                        <input id="ap-password" data-password type="${this.showPassword ? 'text' : 'password'}" autocomplete="current-password" value="${escapeHtml(this.loginPassword)}">
                        <button class="password-toggle" type="button" data-action="toggle-password">${escapeHtml(this.showPassword ? this.t('renderer.account.hidePassword') : this.t('renderer.account.showPassword'))}</button>
                    </div>
                </div>
                ${this.error ? `<p class="error-text">${escapeHtml(this.error)}</p>` : ''}
                <div class="actions">
                    <button class="btn btn-primary" type="submit" data-submit ${this.busy ? 'disabled' : ''}>${escapeHtml(this.busy ? this.t('renderer.account.loggingIn') : this.t('renderer.account.loginSubmit'))}</button>
                </div>
            </form>
        `;
    }

    private renderDisplayNameEditor(): string {
        return `
            <div class="edit-row">
                <input data-display-name type="text" value="${escapeHtml(this.displayNameDraft)}">
                <button class="btn btn-primary" type="button" data-action="save-display" ${this.busy ? 'disabled' : ''}>${escapeHtml(this.busy ? this.t('renderer.account.saving') : this.t('renderer.account.save'))}</button>
                <button class="btn btn-ghost" type="button" data-action="cancel-edit">${escapeHtml(this.t('renderer.account.cancel'))}</button>
            </div>
            ${this.error ? `<p class="error-text">${escapeHtml(this.error)}</p>` : ''}
            ${this.success ? `<p class="success-text">${escapeHtml(this.success)}</p>` : ''}
        `;
    }

    private renderProfile(): string {
        const user = this.session!.user;
        const email = user.email ? `<div class="profile-email">${escapeHtml(user.email)}</div>` : '';
        return `
            <div class="profile">
                ${this.renderAvatar(user, 'profile-avatar')}
                <div class="profile-main">
                    <div class="profile-name">${escapeHtml(this.displayName(user))}</div>
                    ${email}
                </div>
            </div>
            <div class="profile-section">
                <div class="profile-section-title">${escapeHtml(this.t('renderer.account.profileSettings'))}</div>
                ${
                    this.editing
                        ? this.renderDisplayNameEditor()
                        : `<div class="edit-row">
                        <input data-display-name readonly type="text" value="${escapeHtml(this.displayName(user))}">
                        <button class="btn btn-ghost" type="button" data-action="start-edit">${escapeHtml(this.t('renderer.account.edit'))}</button>
                    </div>`
                }
            </div>
            <div class="logout-row">
                ${
                    this.confirmLogout
                        ? `<div class="confirm-row">
                        <span>${escapeHtml(this.t('renderer.account.confirmLogout'))}</span>
                        <button class="btn btn-confirm" type="button" data-action="do-logout" ${this.busy ? 'disabled' : ''}>${escapeHtml(this.busy ? this.t('renderer.account.loggingOut') : this.t('renderer.account.logout'))}</button>
                        <button class="btn btn-cancel" type="button" data-action="cancel-logout">${escapeHtml(this.t('renderer.account.cancel'))}</button>
                    </div>`
                        : `<button class="btn btn-danger" type="button" data-action="ask-logout">${escapeHtml(this.t('renderer.account.logout'))}</button>`
                }
            </div>
        `;
    }

    private render(): void {
        if (!this.featureEnabled || this.mode === 'nologin') {
            this.root.innerHTML = '';
            return;
        }

        const popover = this.expanded
            ? `<div class="popover" data-popover>
                ${this.session ? this.renderProfile() : this.renderLoginForm()}
            </div>`
            : '';

        this.root.innerHTML = `
            <style>${accountPanelCss}</style>
            <div class="account-panel">
                ${this.renderTrigger()}
                ${popover}
            </div>
        `;
        this.bindEvents();
    }

    private bindEvents(): void {
        this.root.querySelector('[data-action="toggle"]')?.addEventListener('click', (event) => {
            event.stopPropagation();
            this.expanded = !this.expanded;
            this.error = null;
            this.success = null;
            if (this.session && !this.editing) {
                this.displayNameDraft = this.displayName(this.session.user);
            }
            this.render();
        });

        this.root.querySelector('[data-action="toggle-password"]')?.addEventListener('click', (event) => {
            event.stopPropagation();
            this.showPassword = !this.showPassword;
            this.render();
        });

        this.root.querySelector('[data-username]')?.addEventListener('input', (event: Event) => {
            this.loginUsername = (event.target as HTMLInputElement).value;
        });
        this.root.querySelector('[data-password]')?.addEventListener('input', (event: Event) => {
            this.loginPassword = (event.target as HTMLInputElement).value;
        });

        const loginForm = this.root.querySelector<HTMLFormElement>('[data-form="login"]');
        loginForm?.addEventListener('submit', (event) => {
            void this.handleLogin(event);
        });

        this.root.querySelector('[data-action="start-edit"]')?.addEventListener('click', () => {
            this.editing = true;
            this.error = null;
            this.success = null;
            this.render();
        });
        this.root.querySelector('[data-action="cancel-edit"]')?.addEventListener('click', () => {
            this.editing = false;
            this.error = null;
            this.success = null;
            this.render();
        });
        this.root.querySelector('[data-display-name]')?.addEventListener('input', (event: Event) => {
            this.displayNameDraft = (event.target as HTMLInputElement).value;
        });
        this.root.querySelector('[data-action="save-display"]')?.addEventListener('click', () => {
            void this.handleSaveDisplayName();
        });
        this.root.querySelector('[data-action="ask-logout"]')?.addEventListener('click', () => {
            this.confirmLogout = true;
            this.error = null;
            this.render();
        });
        this.root.querySelector('[data-action="cancel-logout"]')?.addEventListener('click', () => {
            this.confirmLogout = false;
            this.render();
        });
        this.root.querySelector('[data-action="do-logout"]')?.addEventListener('click', () => {
            void this.handleLogout();
        });
    }

    private async handleLogin(event: Event): Promise<void> {
        event.preventDefault();
        if (this.busy || !this.loginUsername || !this.loginPassword) {
            return;
        }
        this.busy = true;
        this.error = null;
        this.render();
        try {
            const api = (window as any).accountAPI;
            if (!api?.login) {
                throw new Error(this.t('renderer.account.accountServiceUnavailable'));
            }
            this.session = (await api.login(this.mode, this.loginUsername, this.loginPassword)) ?? null;
            this.expanded = false;
            this.loginUsername = '';
            this.loginPassword = '';
        } catch (error) {
            this.error = error instanceof Error ? error.message : String(error);
        } finally {
            this.busy = false;
            this.render();
        }
    }

    private async handleSaveDisplayName(): Promise<void> {
        if (this.busy || !this.displayNameDraft) {
            return;
        }
        this.busy = true;
        this.error = null;
        this.success = null;
        this.render();
        try {
            const api = (window as any).accountAPI;
            await api.updateDisplayName(this.displayNameDraft);
            this.editing = false;
            this.success = this.t('renderer.account.saved');
        } catch (error) {
            this.error = error instanceof Error ? error.message : String(error);
        } finally {
            this.busy = false;
            this.render();
        }
    }

    private async handleLogout(): Promise<void> {
        if (this.busy) {
            return;
        }
        this.busy = true;
        this.error = null;
        this.render();
        try {
            const api = (window as any).accountAPI;
            await api.logout();
            this.session = null;
            this.expanded = false;
            this.confirmLogout = false;
        } catch (error) {
            this.error = error instanceof Error ? error.message : String(error);
        } finally {
            this.busy = false;
            this.render();
        }
    }
}

customElements.define('account-panel', AccountPanel);
