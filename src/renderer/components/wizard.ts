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

type LoginChoice = 'opendesk' | 'enterprise' | 'nologin';

type ResultType = 'success' | 'error' | 'info';

interface ProviderTemplate {
    name: string;
    displayName: string;
    base_url: string;
}

interface SettingProvider {
    name: string;
    base_url: string;
    api_key: string;
    no_proxy: boolean;
}

interface SettingModel {
    alias: string;
    provider_name: string;
    model_name: string;
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
            verifyModel(params: { base_url: string; api_key: string; model_name: string }): Promise<boolean>;
        };
        globalControlAPI: {
            openHomePage(): void;
            openWizard(): void;
            openSettingEditor(): void;
            openAdvancedSettingEditor(): void;
            openTask(taskId: string | null): void;
            openLogView(): void;
            openApplication(bundleName: string): void;
            removeTaskViewCache(taskId: string): void;
            clearAllTaskViewCache(): void;
        };
    }
}

class SetupWizard extends HTMLElement {
    private currentStep = 1;
    private readonly totalSteps = 3;
    private loginChoice: LoginChoice | null = null;
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
        <div class="wizard-root w-full h-full overflow-hidden flex bg-gradient-to-br from-slate-50 via-white to-blue-50/30">
            <div class="wizard-stepper flex-shrink-0 w-20 flex flex-col items-center py-12">
                ${this._renderStepper()}
            </div>
            <div class="flex-1 flex flex-col overflow-hidden">
                <div class="flex-1 overflow-y-auto px-12 py-12">
                    ${this._renderStepContent()}
                </div>
                <div class="wizard-nav flex-shrink-0 px-12 py-6 border-t border-gray-100/50">
                    ${this._renderNavButtons()}
                </div>
            </div>
        </div>
        `;
    }

    private _renderStepper(): string {
        let html = '';
        for (let i = 1; i <= this.totalSteps; i++) {
            const isActive = i === this.currentStep;
            const isCompleted = i < this.currentStep;
            const circleClass = isActive
                ? 'w-10 h-10 rounded-full bg-indigo-500 text-white flex items-center justify-center text-sm font-semibold shadow-lg shadow-indigo-200'
                : isCompleted
                  ? 'w-10 h-10 rounded-full bg-indigo-500 text-white flex items-center justify-center text-sm font-semibold'
                  : 'w-10 h-10 rounded-full bg-gray-200 text-gray-400 flex items-center justify-center text-sm font-semibold';

            html += `<div class="${circleClass}">`;
            html += isCompleted ? '<i class="fas fa-check text-xs"></i>' : `${i}`;
            html += '</div>';

            if (i < this.totalSteps) {
                const lineClass = isCompleted ? 'w-0.5 h-16 bg-indigo-500' : 'w-0.5 h-16 bg-gray-200';
                html += `<div class="${lineClass}"></div>`;
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
        <div class="max-w-3xl">
            <p class="text-sm font-medium text-indigo-500 mb-2">Step 1</p>
            <h1 class="text-3xl font-bold text-gray-900 mb-3">您希望如何登录 OpenDesk？</h1>
            <p class="text-base text-gray-500 mb-10 leading-relaxed">我们支持使用个人账号或企业账号接入，也支持您配置自己的模型服务。无论使用何种登录方式，我们提供的功能都一视同仁。</p>
            <div class="grid grid-cols-1 md:grid-cols-3 gap-5">
                ${this._renderChoiceCard('opendesk', 'fa-user-circle', 'OpenDesk 账号', '正在建设中', true)}
                ${this._renderChoiceCard('enterprise', 'fa-building', '企业账号', '正在建设中', true)}
                ${this._renderChoiceCard('nologin', 'fa-plug', '不登录账号', '使用自定义的大模型服务，无需登录任何账号', false)}
            </div>
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
        const disabledClass = disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer';
        const selectedClass = isSelected
            ? 'border-indigo-400 bg-indigo-50/50 ring-2 ring-indigo-400/30'
            : 'border-gray-200 bg-white/70 hover:border-gray-300 hover:shadow-md';
        const pointerEvents = disabled ? 'pointer-events-none' : '';

        return `
        <div class="wizard-choice-card relative rounded-2xl border-2 p-6 transition-all duration-200 backdrop-blur-xl ${selectedClass} ${disabledClass} ${pointerEvents}"
             data-choice="${value}" ${disabled ? 'data-disabled="true"' : ''}>
            ${isSelected ? '<div class="absolute top-3 right-3"><i class="fas fa-check-circle text-indigo-500"></i></div>' : ''}
            ${disabled ? '<div class="absolute top-3 right-3"><i class="fas fa-lock text-gray-300 text-xs"></i></div>' : ''}
            <div class="w-12 h-12 rounded-xl ${disabled ? 'bg-gray-100' : 'bg-indigo-50'} flex items-center justify-center mb-4">
                <i class="fas ${icon} text-xl ${disabled ? 'text-gray-300' : 'text-indigo-500'}"></i>
            </div>
            <h3 class="font-semibold text-gray-800 mb-1">${title}</h3>
            <p class="text-xs text-gray-400 leading-relaxed">${subtitle}</p>
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
        <div class="max-w-3xl">
            <p class="text-sm font-medium text-indigo-500 mb-2">Step 2</p>
            <h1 class="text-3xl font-bold text-gray-900 mb-3">${this._escapeHtml(title)}</h1>
            <p class="text-base text-gray-500 mb-10 leading-relaxed">${this._escapeHtml(description)}</p>
            <div class="flex flex-col items-center justify-center py-16 bg-white/70 backdrop-blur-xl rounded-2xl border border-gray-100">
                <div class="w-20 h-20 rounded-full bg-amber-50 flex items-center justify-center mb-6">
                    <i class="fas fa-hard-hat text-3xl text-amber-400"></i>
                </div>
                <p class="text-lg font-semibold text-gray-700 mb-2">正在建设中</p>
                <p class="text-sm text-gray-400">此功能尚未上线，请选择其他登录方式</p>
            </div>
        </div>
        `;
    }

    private _renderModelConfig(): string {
        const templateOptions = this.providerTemplates
            .map(
                (t) =>
                    `<option value="${this._escapeHtml(t.name)}" data-url="${this._escapeHtml(t.base_url)}" data-display="${this._escapeHtml(t.displayName)}">${this._escapeHtml(t.displayName)}</option>`
            )
            .join('');

        return `
        <div class="max-w-3xl">
            <p class="text-sm font-medium text-indigo-500 mb-2">Step 2</p>
            <h1 class="text-3xl font-bold text-gray-900 mb-3">配置您的模型服务</h1>
            <p class="text-base text-gray-500 mb-10 leading-relaxed">请选择一个模型提供方并填入对应的密钥和模型名称，我们将验证配置是否有效。</p>
            <div class="bg-white/70 backdrop-blur-xl rounded-2xl border border-white/50 shadow-lg p-6 space-y-5">
                <div>
                    <label class="block text-sm font-medium text-gray-600 mb-1.5">模型提供方</label>
                    <select id="wizard-provider-select" class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-400/30 transition-all">
                        <option value="">请选择模型提供方</option>
                        ${templateOptions}
                        <option value="__custom__">自定义</option>
                    </select>
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-600 mb-1.5">API 地址 (Base URL)</label>
                    <input id="wizard-base-url" type="text" class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-400/30 transition-all" placeholder="https://api.example.com/v1">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-600 mb-1.5">API 密钥</label>
                    <div class="relative">
                        <input id="wizard-api-key" type="password" class="w-full px-4 py-2.5 pr-10 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-400/30 transition-all" placeholder="sk-...">
                        <button id="wizard-toggle-key" class="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors">
                            <i class="fas fa-eye text-xs"></i>
                        </button>
                    </div>
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-600 mb-1.5">模型名称</label>
                    <input id="wizard-model-name" type="text" class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-400/30 transition-all" placeholder="例如: gpt-4o, deepseek-chat">
                </div>
                <div id="wizard-verify-result" class="text-sm hidden"></div>
                <button id="wizard-verify-btn" class="w-full py-3 text-sm font-medium text-white bg-gradient-to-r from-indigo-500 to-indigo-600 rounded-xl hover:shadow-lg hover:shadow-indigo-200 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed">
                    <i class="fas fa-check-double mr-2"></i>验证配置并保存
                </button>
            </div>
        </div>
        `;
    }

    // =================== Step 3 ===================
    private _renderStep3(): string {
        return `
        <div class="max-w-3xl">
            <p class="text-sm font-medium text-indigo-500 mb-2">Step 3</p>
            <h1 class="text-3xl font-bold text-gray-900 mb-3">配置已完成</h1>
            <p class="text-base text-gray-500 mb-10 leading-relaxed">使用 OpenDesk 完成你的第一个任务吧！</p>
            <div class="flex flex-col items-center justify-center py-20 bg-white/70 backdrop-blur-xl rounded-2xl border border-gray-100">
                <div class="w-24 h-24 rounded-full bg-green-50 flex items-center justify-center mb-8">
                    <i class="fas fa-check-circle text-5xl text-green-500"></i>
                </div>
                <p class="text-lg font-semibold text-gray-700 mb-6">一切就绪！</p>
                <button id="wizard-create-task-btn" class="px-8 py-3 text-sm font-medium text-white bg-gradient-to-r from-indigo-500 to-indigo-600 rounded-xl hover:shadow-lg hover:shadow-indigo-200 transition-all duration-200">
                    <i class="fas fa-plus mr-2"></i>点击创建任务
                </button>
            </div>
        </div>
        `;
    }

    // =================== Nav ===================
    private _renderNavButtons(): string {
        const showBack = this.currentStep > 1;
        const showNext = this.currentStep === 1;
        const nextDisabled = this.currentStep === 1 && !this.loginChoice;

        return `
        <div class="flex items-center gap-3">
            ${
                showBack
                    ? `
            <button id="wizard-back-btn" class="px-6 py-2.5 text-sm font-medium text-gray-600 bg-white border border-gray-200 rounded-xl hover:bg-gray-50 hover:border-gray-300 transition-all duration-200">
                <i class="fas fa-arrow-left mr-2"></i>上一步
            </button>`
                    : ''
            }
            ${
                showNext
                    ? `
            <button id="wizard-next-btn" class="px-6 py-2.5 text-sm font-medium text-white bg-gradient-to-r from-indigo-500 to-indigo-600 rounded-xl hover:shadow-lg hover:shadow-indigo-200 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed" ${nextDisabled ? 'disabled' : ''}>
                下一步<i class="fas fa-arrow-right ml-2"></i>
            </button>`
                    : ''
            }
        </div>
        `;
    }

    // =================== Events ===================
    private _bindEvents(): void {
        this.querySelectorAll<HTMLElement>('.wizard-choice-card').forEach((card) => {
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

        this._bindModelConfigEvents();

        this.querySelector('#wizard-create-task-btn')?.addEventListener('click', () => {
            window.globalControlAPI.openHomePage();
        });
    }

    private _bindModelConfigEvents(): void {
        const providerSelect = this.querySelector<HTMLSelectElement>('#wizard-provider-select');
        const baseUrlInput = this.querySelector<HTMLInputElement>('#wizard-base-url');
        const toggleKeyBtn = this.querySelector<HTMLButtonElement>('#wizard-toggle-key');
        const verifyBtn = this.querySelector<HTMLButtonElement>('#wizard-verify-btn');

        if (!providerSelect || !baseUrlInput) return;

        providerSelect.addEventListener('change', () => {
            const selected = providerSelect.options[providerSelect.selectedIndex];
            if (selected?.dataset.url) {
                baseUrlInput.value = selected.dataset.url;
            } else if (providerSelect.value === '__custom__') {
                baseUrlInput.value = '';
                baseUrlInput.focus();
            } else {
                baseUrlInput.value = '';
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
    }

    private async _handleVerifyAndSave(): Promise<void> {
        if (this._verifying) return;

        const baseUrl = this.querySelector<HTMLInputElement>('#wizard-base-url')?.value?.trim();
        const apiKey = this.querySelector<HTMLInputElement>('#wizard-api-key')?.value || '';
        const modelName = this.querySelector<HTMLInputElement>('#wizard-model-name')?.value?.trim();
        const providerSelect = this.querySelector<HTMLSelectElement>('#wizard-provider-select');
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
            verifyBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>正在验证...';
        }
        this._showResult(resultDiv, 'info', '正在验证模型配置，请稍候...');

        try {
            await window.settingAPI.verifyModel({
                base_url: baseUrl,
                api_key: apiKey,
                model_name: modelName
            });

            this._showResult(resultDiv, 'success', '验证成功！正在保存配置...');

            const providerName =
                providerSelect?.value && providerSelect.value !== '__custom__' ? providerSelect.value : 'custom';

            const data = await window.settingAPI.loadSettingObject();
            if (!data.providers) data.providers = [];
            if (!data.models) data.models = [];

            const existingProvider = data.providers.find((p) => p.name === providerName);
            if (!existingProvider) {
                data.providers.push({ name: providerName, base_url: baseUrl, api_key: apiKey, no_proxy: false });
            } else {
                existingProvider.base_url = baseUrl;
                existingProvider.api_key = apiKey;
            }

            if (!data.models.find((m) => m.alias === modelName)) {
                data.models.push({
                    alias: modelName,
                    provider_name: providerName,
                    model_name: modelName,
                    reasoning_effort: ''
                });
            }

            data.default_model = modelName;

            await window.settingAPI.saveSettingObject(data);
            this.currentData = data;

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
                verifyBtn.innerHTML = '<i class="fas fa-check-double mr-2"></i>验证配置并保存';
            }
        }
    }

    private _showResult(el: HTMLElement | null, type: ResultType, message: string): void {
        if (!el) return;
        el.classList.remove('hidden');
        const colorMap: Record<ResultType, string> = {
            success: 'text-green-600 bg-green-50 border-green-200',
            error: 'text-red-600 bg-red-50 border-red-200',
            info: 'text-blue-600 bg-blue-50 border-blue-200'
        };
        const iconMap: Record<ResultType, string> = {
            success: 'fa-check-circle',
            error: 'fa-times-circle',
            info: 'fa-info-circle'
        };
        el.className = `text-sm p-3 rounded-xl border ${colorMap[type]}`;
        el.innerHTML = `<i class="fas ${iconMap[type]} mr-2"></i>${this._escapeHtml(message)}`;
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
