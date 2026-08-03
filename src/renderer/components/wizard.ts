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

import './wizard.css';

type LoginChoice = 'opendesk' | 'enterprise' | 'nologin';

type ResultType = 'success' | 'error' | 'info';

interface ProviderTemplate {
    name: string;
    displayName: string;
    base_url: string;
    provider_type?: 'openai' | 'anthropic';
}

interface SettingProvider {
    name: string;
    provider_type?: 'openai' | 'anthropic';
    base_url: string;
    api_key: string;
    no_proxy: boolean;
    no_ssl: boolean;
}

interface SettingModel {
    alias: string;
    provider_name: string;
    model_name: string;
    model_type?: 'chat' | 'embedding';
    reasoning_effort: string;
}

interface SettingData {
    providers: SettingProvider[];
    models: SettingModel[];
    default_model: string;
    [key: string]: unknown;
}

declare global {
    interface Window {
        settingAPI: {
            getProviderTemplates(): Promise<ProviderTemplate[]>;
            loadSettingObject(): Promise<SettingData>;
            saveSettingObject(data: SettingData): Promise<void>;
            verifyModel(params: {
                base_url: string;
                api_key: string;
                provider_type?: 'openai' | 'anthropic';
                model_name: string;
                model_type?: 'chat' | 'embedding';
                custom_headers?: Record<string, string>;
                no_proxy?: boolean;
                no_ssl?: boolean;
            }): Promise<boolean>;
        };
        globalControlAPI: {
            openHomePage(skipWizard?: boolean): void;
            openWizard(): void;
            returnFromWizard(): void;
            getWizardReturnLabel(): string;
            openSettingEditor(): void;
            openAdvancedSettingEditor(): void;
            openTask(taskId: string | null): void;
            openLogView(): void;
            openPersonalCenter(): void;
            openApplication(bundleName: string): void;
            removeTaskViewCache(taskId: string): void;
            clearAllTaskViewCache(): void;
        };
    }
}

class SetupWizard extends HTMLElement {
    private currentStep = 1;
    private readonly totalSteps = 3;
    private loginChoice: LoginChoice | null = 'nologin';
    private providerTemplates: ProviderTemplate[] = [];
    private currentData: SettingData | null = null;
    private _verifying = false;

    async connectedCallback(): Promise<void> {
        this.providerTemplates = await window.settingAPI.getProviderTemplates();
        this.currentData = await window.settingAPI.loadSettingObject();
        this._render();
        this._bindEvents();
    }

    private _render(): void {
        this.innerHTML = `
        <div class="wizard-root">
            <div class="wizard-inner">
                <div class="wizard-rail">
                    ${this._renderStepper()}
                </div>
                <div class="wizard-content">
                    <div class="wizard-body">
                        ${this._renderStepContent()}
                    </div>
                    <div class="wizard-footer">
                        ${this._renderNavButtons()}
                    </div>
                </div>
            </div>
        </div>
        `;
    }

    private _renderStepper(): string {
        const labels = ['账号选择', '模型配置', '完成'];
        let html = '';
        for (let i = 1; i <= this.totalSteps; i++) {
            const isActive = i === this.currentStep;
            const isCompleted = i < this.currentStep;
            const itemClass = isActive ? 'rail-item active' : isCompleted ? 'rail-item done' : 'rail-item';

            const dotContent = isCompleted ? '<i class="fas fa-check" style="font-size:9px"></i>' : `${i}`;

            html += `<div class="${itemClass}">`;
            html += `<div class="rail-dot">${dotContent}</div>`;
            html += `<span class="rail-label">${labels[i - 1]}</span>`;
            html += '</div>';

            if (i < this.totalSteps) {
                html += '<div class="rail-line"></div>';
            }
        }
        return html;
    }

    private _renderStepContent(): string {
        switch (this.currentStep) {
            case 1:
                return this._renderStep1();
            case 2:
                return this._renderStep2();
            case 3:
                return this._renderStep3();
            default:
                return '';
        }
    }

    // =================== Step 1 ===================
    private _renderStep1(): string {
        return `
        <span class="step-tag">Step 1 · 账号选择</span>
        <h2>您希望如何登录 OpenDesk？</h2>
        <p class="ob-desc">我们支持使用个人账号或企业账号接入，也支持您配置自己的模型服务。无论使用何种登录方式，我们提供的功能都一视同仁。</p>
        <div class="opt-grid">
            ${this._renderChoiceCard('opendesk', 'fa-user', 'OpenDesk 账号', '个人账号，同步任务、技能与偏好设置', true)}
            ${this._renderChoiceCard('enterprise', 'fa-building', '企业账号', '企业统一身份认证（SSO）接入', true)}
            ${this._renderChoiceCard('nologin', 'fa-plug', '不登录账号', '使用自定义的大模型服务，无需登录任何账号', false)}
        </div>
        `;
    }

    private _renderChoiceCard(
        value: LoginChoice,
        icon: string,
        title: string,
        subtitle: string,
        disabled: boolean
    ): string {
        const isSelected = this.loginChoice === value;
        const classes = ['opt-card', disabled ? 'disabled' : '', isSelected ? 'selected' : '']
            .filter(Boolean)
            .join(' ');

        return `
        <div class="${classes}"
             data-choice="${value}" ${disabled ? 'data-disabled="true"' : ''}>
            ${disabled ? '<span class="opt-badge">建设中</span>' : ''}
            ${disabled ? '<i class="fas fa-lock opt-lock"></i>' : ''}
            ${isSelected ? '<span class="opt-check"><i class="fas fa-check"></i></span>' : ''}
            <div class="opt-icon"><i class="fas ${icon}"></i></div>
            <div class="opt-name">${title}</div>
            <div class="opt-desc">${subtitle}</div>
        </div>
        `;
    }

    // =================== Step 2 ===================
    private _renderStep2(): string {
        switch (this.loginChoice) {
            case 'opendesk':
                return this._renderPlaceholder('OpenDesk 账号', '个人账号系统正在建设中，敬请期待');
            case 'enterprise':
                return this._renderPlaceholder('企业账号', '企业账号接入系统正在建设中，敬请期待');
            case 'nologin':
                return this._renderModelConfig();
            default:
                return this._renderPlaceholder('请先选择登录方式', '请返回上一步选择您的登录方式');
        }
    }

    private _renderPlaceholder(title: string, description: string): string {
        return `
        <span class="step-tag">Step 2 · ${this._escapeHtml(title)}</span>
        <h2>${this._escapeHtml(title)}</h2>
        <p class="ob-desc">${this._escapeHtml(description)}</p>
        <div class="placeholder-card">
            <div class="placeholder-icon"><i class="fas fa-hard-hat"></i></div>
            <p class="placeholder-title">正在建设中</p>
            <p class="placeholder-sub">此功能尚未上线，请选择其他登录方式</p>
        </div>
        `;
    }

    private _renderModelConfig(): string {
        const templateOptions = this.providerTemplates
            .map(
                (t) =>
                    `<option value="${this._escapeHtml(t.name)}" data-url="${this._escapeHtml(t.base_url)}" data-provider-type="${this._escapeHtml(t.provider_type || 'openai')}" data-display="${this._escapeHtml(t.displayName)}">${this._escapeHtml(t.displayName)}</option>`
            )
            .join('');

        return `
        <span class="step-tag">Step 2 · 模型配置</span>
        <h2>配置您的模型服务</h2>
        <p class="ob-desc">请选择一个模型提供方并填入对应的密钥和模型名称。</p>
        <div class="form-card">
            <div class="f-row">
                <label class="f-label">模型提供方</label>
                <select id="wizard-provider-select" class="f-ctl f-select">
                    <option value="">请选择模型提供方</option>
                    ${templateOptions}
                    <option value="__custom__">自定义</option>
                </select>
            </div>
            <div class="f-row f-grid2">
                <div>
                    <label class="f-label">协议类型</label>
                    <select id="wizard-provider-type" class="f-ctl f-select">
                        <option value="openai">OpenAI</option>
                        <option value="anthropic">Anthropic</option>
                    </select>
                </div>
                <div>
                    <label class="f-label">模型名称</label>
                    <input id="wizard-model-name" type="text" class="f-ctl" placeholder="例如: gpt-4o, deepseek-chat">
                </div>
            </div>
            <div class="f-row">
                <label class="f-label">API 地址 (Base URL)</label>
                <input id="wizard-base-url" type="text" class="f-ctl" placeholder="https://api.example.com/v1">
            </div>
            <div class="f-row">
                <label class="f-label">API 密钥</label>
                <div class="f-ctl f-ctl-with-btn">
                    <input id="wizard-api-key" type="password" class="f-ctl-input" placeholder="sk-...">
                    <button id="wizard-toggle-key" class="f-ctl-btn" type="button">
                        <i class="fas fa-eye"></i>
                    </button>
                </div>
            </div>
            <div class="f-row f-checks">
                <label class="f-check">
                    <input id="wizard-no-proxy" type="checkbox">
                    <span>禁用代理</span>
                </label>
                <label class="f-check">
                    <input id="wizard-no-ssl" type="checkbox">
                    <span>跳过 SSL 证书校验</span>
                </label>
            </div>
            <div id="wizard-verify-result" class="verify-result hidden"></div>
            <div class="f-actions">
                <button id="wizard-save-btn" class="wiz-btn wiz-btn-secondary" type="button">
                    <i class="fas fa-save"></i>仅保存
                </button>
                <button id="wizard-verify-btn" class="wiz-btn wiz-btn-primary" type="button">
                    <i class="fas fa-check-double"></i>验证配置并保存
                </button>
            </div>
        </div>
        `;
    }

    // =================== Step 3 ===================
    private _renderStep3(): string {
        return `
        <span class="step-tag">Step 3 · 完成</span>
        <h2>配置已完成</h2>
        <p class="ob-desc">使用 OpenDesk 完成你的第一个任务吧！</p>
        <div class="done-card">
            <div class="done-icon"><i class="fas fa-check-circle"></i></div>
            <p class="done-title">一切就绪！</p>
            <button id="wizard-create-task-btn" class="wiz-btn wiz-btn-primary wiz-btn-lg" type="button">
                <i class="fas fa-plus"></i>点击创建任务
            </button>
        </div>
        `;
    }

    // =================== Nav ===================
    private _renderNavButtons(): string {
        const showBack = this.currentStep > 1;
        const showNext = this.currentStep === 1;
        const nextDisabled = this.currentStep === 1 && !this.loginChoice;
        const returnLabel = window.globalControlAPI.getWizardReturnLabel?.() || '返回';

        if (showBack) {
            return `
        <button id="wizard-back-btn" class="wiz-btn-ghost" type="button">
            <i class="fas fa-arrow-left"></i>上一步
        </button>
        `;
        }

        return `
        <button id="wizard-return-btn" class="wiz-btn-ghost" type="button">
            <i class="fas fa-arrow-left"></i>${this._escapeHtml(returnLabel)}
        </button>
        ${
            showNext
                ? `
        <button id="wizard-next-btn" class="wiz-btn wiz-btn-primary" type="button" ${nextDisabled ? 'disabled' : ''}>
            下一步<i class="fas fa-arrow-right"></i>
        </button>`
                : ''
        }
        `;
    }

    // =================== Events ===================
    private _bindEvents(): void {
        this.querySelectorAll<HTMLElement>('.opt-card').forEach((card) => {
            card.addEventListener('click', () => {
                if (card.dataset.disabled === 'true') return;
                this.loginChoice = card.dataset.choice as LoginChoice;
                this._render();
                this._bindEvents();
            });
        });

        this.querySelector('#wizard-next-btn')?.addEventListener('click', () => {
            if (this.loginChoice) {
                this.currentStep = 2;
                this._render();
                this._bindEvents();
            }
        });

        this.querySelector('#wizard-back-btn')?.addEventListener('click', () => {
            if (this.currentStep > 1) {
                this.currentStep--;
                this._render();
                this._bindEvents();
            }
        });

        this.querySelector('#wizard-return-btn')?.addEventListener('click', () => {
            window.globalControlAPI.returnFromWizard();
        });

        this._bindModelConfigEvents();

        this.querySelector('#wizard-create-task-btn')?.addEventListener('click', () => {
            window.globalControlAPI.openHomePage();
        });
    }

    private _bindModelConfigEvents(): void {
        const providerSelect = this.querySelector<HTMLSelectElement>('#wizard-provider-select');
        const providerTypeSelect = this.querySelector<HTMLSelectElement>('#wizard-provider-type');
        const baseUrlInput = this.querySelector<HTMLInputElement>('#wizard-base-url');
        const toggleKeyBtn = this.querySelector<HTMLButtonElement>('#wizard-toggle-key');
        const verifyBtn = this.querySelector<HTMLButtonElement>('#wizard-verify-btn');
        const saveBtn = this.querySelector<HTMLButtonElement>('#wizard-save-btn');

        if (!providerSelect || !baseUrlInput) return;

        providerSelect.addEventListener('change', () => {
            const selected = providerSelect.options[providerSelect.selectedIndex];
            if (selected?.dataset.url) {
                baseUrlInput.value = selected.dataset.url;
                if (providerTypeSelect) {
                    providerTypeSelect.value = selected.dataset.providerType === 'anthropic' ? 'anthropic' : 'openai';
                }
            } else if (providerSelect.value === '__custom__') {
                baseUrlInput.value = '';
                if (providerTypeSelect) {
                    providerTypeSelect.value = 'openai';
                }
                baseUrlInput.focus();
            } else {
                baseUrlInput.value = '';
                if (providerTypeSelect) {
                    providerTypeSelect.value = 'openai';
                }
            }
        });

        toggleKeyBtn?.addEventListener('click', () => {
            const input = this.querySelector<HTMLInputElement>('#wizard-api-key');
            const icon = toggleKeyBtn.querySelector('i');
            if (!input || !icon) return;
            if (input.type === 'password') {
                input.type = 'text';
                icon.classList.replace('fa-eye', 'fa-eye-slash');
            } else {
                input.type = 'password';
                icon.classList.replace('fa-eye-slash', 'fa-eye');
            }
        });

        verifyBtn?.addEventListener('click', () => this._handleVerifyAndSave());

        saveBtn?.addEventListener('click', () => this._handleSaveOnly());
    }

    private async _handleSaveOnly(): Promise<void> {
        const baseUrl = this.querySelector<HTMLInputElement>('#wizard-base-url')?.value?.trim();
        const modelName = this.querySelector<HTMLInputElement>('#wizard-model-name')?.value?.trim();
        const resultDiv = this.querySelector<HTMLElement>('#wizard-verify-result');

        if (!baseUrl) {
            this._showResult(resultDiv, 'error', '请填写 API 地址');
            return;
        }
        if (!modelName) {
            this._showResult(resultDiv, 'error', '请填写模型名称');
            return;
        }

        await this._doSave();
        this.currentStep = 3;
        this._render();
        this._bindEvents();
    }

    private async _doSave(): Promise<void> {
        const baseUrl = this.querySelector<HTMLInputElement>('#wizard-base-url')?.value?.trim();
        if (!baseUrl) return;
        const apiKey = this.querySelector<HTMLInputElement>('#wizard-api-key')?.value || '';
        const providerType =
            this.querySelector<HTMLSelectElement>('#wizard-provider-type')?.value === 'anthropic'
                ? 'anthropic'
                : 'openai';
        const modelName = this.querySelector<HTMLInputElement>('#wizard-model-name')?.value?.trim();
        if (!modelName) return;
        const noProxy = this.querySelector<HTMLInputElement>('#wizard-no-proxy')?.checked || false;
        const noSSL = this.querySelector<HTMLInputElement>('#wizard-no-ssl')?.checked || false;
        const providerSelect = this.querySelector<HTMLSelectElement>('#wizard-provider-select');
        const providerName =
            providerSelect?.value && providerSelect.value !== '__custom__' ? providerSelect.value : 'custom';

        const data = await window.settingAPI.loadSettingObject();
        if (!data.providers) data.providers = [];
        if (!data.models) data.models = [];

        const existingProvider = data.providers.find((p) => p.name === providerName);
        if (!existingProvider) {
            data.providers.push({
                name: providerName,
                provider_type: providerType,
                base_url: baseUrl,
                api_key: apiKey,
                no_proxy: noProxy,
                no_ssl: noSSL
            });
        } else {
            existingProvider.base_url = baseUrl;
            existingProvider.api_key = apiKey;
            existingProvider.provider_type = providerType;
            existingProvider.no_proxy = noProxy;
            existingProvider.no_ssl = noSSL;
        }

        if (!data.models.find((m) => m.alias === modelName)) {
            data.models.push({
                alias: modelName,
                provider_name: providerName,
                model_name: modelName,
                model_type: 'chat',
                reasoning_effort: ''
            });
        }

        data.default_model = modelName;

        await window.settingAPI.saveSettingObject(data);
        this.currentData = data;
    }

    private async _handleVerifyAndSave(): Promise<void> {
        if (this._verifying) return;

        const baseUrl = this.querySelector<HTMLInputElement>('#wizard-base-url')?.value?.trim();
        const apiKey = this.querySelector<HTMLInputElement>('#wizard-api-key')?.value || '';
        const providerType =
            this.querySelector<HTMLSelectElement>('#wizard-provider-type')?.value === 'anthropic'
                ? 'anthropic'
                : 'openai';
        const modelName = this.querySelector<HTMLInputElement>('#wizard-model-name')?.value?.trim();
        const noProxy = this.querySelector<HTMLInputElement>('#wizard-no-proxy')?.checked || false;
        const noSSL = this.querySelector<HTMLInputElement>('#wizard-no-ssl')?.checked || false;
        const resultDiv = this.querySelector<HTMLElement>('#wizard-verify-result');
        const verifyBtn = this.querySelector<HTMLButtonElement>('#wizard-verify-btn');

        if (!baseUrl) {
            this._showResult(resultDiv, 'error', '请填写 API 地址');
            return;
        }
        if (!modelName) {
            this._showResult(resultDiv, 'error', '请填写模型名称');
            return;
        }

        this._verifying = true;
        if (verifyBtn) {
            verifyBtn.disabled = true;
            verifyBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>正在验证...';
        }
        this._showResult(resultDiv, 'info', '正在验证模型配置，请稍候...');

        try {
            await window.settingAPI.verifyModel({
                base_url: baseUrl,
                api_key: apiKey,
                provider_type: providerType,
                model_name: modelName,
                model_type: 'chat',
                no_proxy: noProxy,
                no_ssl: noSSL
            });

            this._showResult(resultDiv, 'success', '验证成功！正在保存配置...');

            await this._doSave();

            setTimeout(() => {
                this.currentStep = 3;
                this._render();
                this._bindEvents();
            }, 600);
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            this._showResult(resultDiv, 'error', `验证失败：${msg}`);
        } finally {
            this._verifying = false;
            if (verifyBtn) {
                verifyBtn.disabled = false;
                verifyBtn.innerHTML = '<i class="fas fa-check-double"></i>验证配置并保存';
            }
        }
    }

    private _showResult(el: HTMLElement | null, type: ResultType, message: string): void {
        if (!el) return;
        el.classList.remove('hidden');
        el.className = `verify-result verify-${type}`;
        const iconMap: Record<ResultType, string> = {
            success: 'fa-check-circle',
            error: 'fa-times-circle',
            info: 'fa-info-circle'
        };
        el.innerHTML = `<i class="fas ${iconMap[type]}"></i>${this._escapeHtml(message)}`;
    }

    private _escapeHtml(text: string | null | undefined): string {
        if (!text) return '';
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }
}

customElements.define('setup-wizard', SetupWizard);
