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
import { escapeHtml } from '../../common/utils/escape.js';
import { createModelSelect, MODEL_SELECT_CSS } from '../utils/model-select.js';
import { createRendererTranslator } from '../locale.ts';
import { showInfoModal } from './confirmModal.ts';
import { notifySettingSideEffectFailures } from '../utils/setting-side-effect-notice.ts';
import { isAccountFeatureEnabled } from '../utils/account-feature-visibility.js';
import {
    formatAccountLoginError,
    getAccountApi,
    resolveLocalizedText,
    runAccountLoginFlow,
    splitLoginMethods,
    type AccountApi,
    type AccountLoginMethod
} from '../utils/account-login.ts';

type LoginChoice = 'opendesk' | 'enterprise' | 'nologin';

type WizardStepKey = 'account' | 'model' | 'personalize' | 'done';

type ResultType = 'success' | 'error' | 'info';

type OutputMode = 'minimal' | 'verbose';

interface ProviderTemplate {
    name: string;
    displayName: string;
    base_url: string;
    provider_type?: 'openai' | 'anthropic';
}

declare global {
    interface Window {
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
        accountAPI: AccountApi;
    }
}

/**
 * 首启向导。
 *
 * 步骤顺序：账号登录 → 模型配置 → 个性化设置 → 完成。
 * 账号能力被特性门控关闭（插件 `ctx.features.disableFeature` 或实验特性开关）时，账号步骤整步消失，
 * 第一步直接是模型配置，总步数随之变成 3。
 */
class SetupWizard extends HTMLElement {
    /** 当前步骤序号（1-based，对应 this.steps 的下标） */
    private currentStep = 1;
    private loginChoice: LoginChoice = 'opendesk';
    private providerTemplates: ProviderTemplate[] = [];
    private currentData: LoadedSettingObject | null = null;
    private _verifying = false;
    private t = createRendererTranslator();
    // 企业账号：先输入服务器地址，再进入登录表单
    private enterpriseBaseUrlStep = true;
    // 账号登录表单状态
    private loginUsername = '';
    private loginPassword = '';
    private loginMethods: AccountLoginMethod[] = [];
    private loginMethodLoading = false;
    private loginMethodsLoaded = false;
    // 登录方式请求代次：个人/企业页签可以来回点，晚返回的旧请求不能覆盖当前页签的数据
    private loginMethodsGeneration = 0;
    private activeLoginFlowId: string | null = null;
    private loginBusy = false;
    private loginError: string | null = null;
    private loginBrowserUrl: string | null = null;
    private enterpriseBaseUrlDraft = '';
    // 个性化设置
    private outputMode: OutputMode = 'minimal';
    private memoryEnabled = true;

    async connectedCallback(): Promise<void> {
        this.providerTemplates = await window.settingAPI.getProviderTemplates();
        this.currentData = await window.settingAPI.loadSettingObject();
        try {
            const settingAPI = (window as any).settingAPI;
            if (settingAPI?.loadSettingObject) {
                const setting = await settingAPI.loadSettingObject();
                this.t = createRendererTranslator(setting);
            }
        } catch {
            // 使用默认语言
        }
        const gui = this._readGuiConfig();
        this.outputMode = gui.output_mode;
        this.memoryEnabled = gui.memory_enabled;
        this._render();
        this._bindEvents();
        // 账号步骤可见时立刻拉取登录方式，省掉额外一次点击
        if (this.stepKey === 'account') {
            void this._loadLoginMethods(this._accountKind());
        }
    }

    // =================== 步骤模型 ===================

    private get steps(): WizardStepKey[] {
        return isAccountFeatureEnabled(this.currentData)
            ? ['account', 'model', 'personalize', 'done']
            : ['model', 'personalize', 'done'];
    }

    private get totalSteps(): number {
        return this.steps.length;
    }

    private get stepKey(): WizardStepKey {
        return this.steps[this.currentStep - 1] ?? 'done';
    }

    private _accountKind(): 'personal' | 'enterprise' {
        return this.loginChoice === 'enterprise' ? 'enterprise' : 'personal';
    }

    private _readGuiConfig(): { output_mode: OutputMode; memory_enabled: boolean } {
        const raw = (this.currentData?.gui_config ?? {}) as { output_mode?: unknown; memory_enabled?: unknown };
        return {
            output_mode: raw.output_mode === 'verbose' ? 'verbose' : 'minimal',
            memory_enabled: raw.memory_enabled !== false
        };
    }

    private _goToStep(step: number): void {
        const next = Math.min(this.totalSteps, Math.max(1, step));
        if (next === this.currentStep) return;
        this.currentStep = next;
        this._render();
        this._bindEvents();
    }

    private _nextStep(): void {
        this._goToStep(this.currentStep + 1);
    }

    private _prevStep(): void {
        this._goToStep(this.currentStep - 1);
    }

    // =================== 渲染骨架 ===================

    private _render(): void {
        this.innerHTML = `
        <div class="wiz-root">
            <div class="wiz-inner">
                <nav class="wiz-rail" aria-label="${escapeHtml(this.t('renderer.wizard.stepNav'))}">
                    ${this._renderStepper()}
                </nav>
                <div class="wiz-content">
                    <div class="wiz-scroll">
                        ${this._renderStepContent()}
                    </div>
                    <div class="wiz-foot" data-step="${this.stepKey}">
                        <div class="wiz-foot-inner">
                            ${this._renderNav()}
                        </div>
                    </div>
                </div>
            </div>
        </div>
        `;
    }

    private _stepLabel(key: WizardStepKey): string {
        switch (key) {
            case 'account':
                return this.t('renderer.wizard.stepAccount');
            case 'model':
                return this.t('renderer.wizard.stepModel');
            case 'personalize':
                return this.t('renderer.wizard.stepPersonalize');
            case 'done':
                return this.t('renderer.wizard.stepDone');
        }
    }

    private _renderStepper(): string {
        const steps = this.steps;
        let html = '';
        steps.forEach((key, index) => {
            const number = index + 1;
            const isActive = number === this.currentStep;
            const isDone = number < this.currentStep;
            const classes = ['wiz-rail-node'];
            if (isActive) classes.push('is-active');
            if (isDone) classes.push('is-done');

            html += `<button type="button" class="${classes.join(' ')}" data-wizard-step="${number}"${
                isActive ? ' aria-current="step"' : ''
            }>`;
            html += `<span class="wiz-rail-dot">${number}</span>`;
            html += `<span class="wiz-rail-text">${escapeHtml(this._stepLabel(key))}</span>`;
            html += '</button>';
            if (number < steps.length) {
                html += '<span class="wiz-rail-line" aria-hidden="true"></span>';
            }
        });
        return html;
    }

    private _stepTag(key: WizardStepKey): string {
        return this.t('renderer.wizard.stepTag', {
            step: String(this.currentStep),
            label: this._stepLabel(key)
        });
    }

    private _renderStepContent(): string {
        switch (this.stepKey) {
            case 'account':
                return this._renderAccountStep();
            case 'model':
                return this._renderModelStep();
            case 'personalize':
                return this._renderPersonalizeStep();
            default:
                return this._renderDoneStep();
        }
    }

    // =================== Step: 账号登录 ===================

    private _renderAccountStep(): string {
        const kind = this._accountKind();
        return `
        <div class="wiz-head">
            <div class="wiz-eyebrow">${escapeHtml(this._stepTag('account'))}</div>
            <h2 class="wiz-title">${escapeHtml(this.t('renderer.wizard.accountTitle'))}</h2>
            <p class="wiz-desc">${escapeHtml(this.t('renderer.wizard.accountDesc'))}</p>
        </div>
        <div class="wiz-card">
            <div class="wiz-seg" role="tablist" aria-label="${escapeHtml(this.t('renderer.wizard.accountTitle'))}">
                ${this._renderAccountTypeTab('personal', kind)}
                ${this._renderAccountTypeTab('enterprise', kind)}
            </div>
            ${this._renderAccountLogin(kind)}
        </div>
        <p class="wiz-fine-print">${escapeHtml(this.t('renderer.wizard.accountFootnote'))}</p>
        `;
    }

    private _renderAccountTypeTab(kind: 'personal' | 'enterprise', current: 'personal' | 'enterprise'): string {
        const on = kind === current;
        const label =
            kind === 'personal'
                ? this.t('renderer.wizard.accountTypePersonal')
                : this.t('renderer.wizard.accountTypeEnterprise');
        return `<button type="button" class="wiz-seg-btn${on ? ' is-on' : ''}" role="tab" data-account-kind="${kind}" aria-selected="${
            on ? 'true' : 'false'
        }">${escapeHtml(label)}</button>`;
    }

    /** 账号登录表单本体（不含步骤标题与卡片外壳），企业账号先填服务器地址。 */
    private _renderAccountLogin(kind: 'personal' | 'enterprise'): string {
        const isEnterprise = kind === 'enterprise';

        if (isEnterprise && this.enterpriseBaseUrlStep) {
            return `
            <div class="wiz-field">
                <label class="wiz-label" for="wizard-enterprise-base-url">${escapeHtml(
                    this.t('renderer.account.enterpriseBaseUrl')
                )}</label>
                <input id="wizard-enterprise-base-url" type="text" class="wiz-ctl" placeholder="https://your-server.example.com/api/v1" value="${escapeHtml(
                    this.enterpriseBaseUrlDraft
                )}">
            </div>
            <div id="wizard-account-result" class="wiz-verify" hidden></div>
            `;
        }

        const { passwordMethod, providerMethods } = splitLoginMethods(this.loginMethods);
        const fields =
            passwordMethod?.type === 'form'
                ? passwordMethod.fields
                      .map((field) => {
                          const value =
                              field.id === 'username'
                                  ? this.loginUsername
                                  : field.id === 'password'
                                    ? this.loginPassword
                                    : '';
                          const input = `<input data-login-field="${escapeHtml(field.id)}" type="${field.type}" class="${
                              field.type === 'password' ? 'wiz-ctl-input' : 'wiz-ctl'
                          }" autocomplete="${escapeHtml(field.autocomplete || 'off')}" ${
                              field.placeholder
                                  ? `placeholder="${escapeHtml(resolveLocalizedText(field.placeholder))}"`
                                  : ''
                          } value="${escapeHtml(value)}">`;
                          const control =
                              field.type === 'password'
                                  ? `<div class="wiz-ctl-group">${input}<button class="wiz-ctl-btn" type="button" data-toggle-login-field="${escapeHtml(
                                        field.id
                                    )}" aria-label="${escapeHtml(
                                        this.t('renderer.wizard.showPassword')
                                    )}"><i class="fas fa-eye"></i></button></div>`
                                  : input;
                          return `<div class="wiz-field"><label class="wiz-label">${escapeHtml(
                              resolveLocalizedText(field.label)
                          )}</label>${control}</div>`;
                      })
                      .join('')
                : '';

        const unavailable =
            !this.loginMethodLoading && this.loginMethodsLoaded && !passwordMethod && providerMethods.length === 0;

        const result = this.loginError
            ? `<div id="wizard-account-result" class="wiz-verify wiz-verify-error"><i class="fas fa-circle-exclamation"></i>${escapeHtml(
                  this.loginError
              )}</div>`
            : unavailable
              ? `<div id="wizard-account-result" class="wiz-verify wiz-verify-error"><i class="fas fa-circle-exclamation"></i>${escapeHtml(
                    this.t('renderer.wizard.accountServiceUnavailable')
                )}</div>`
              : `<div id="wizard-account-result" class="wiz-verify" hidden></div>`;

        const browserHint = this.loginBrowserUrl
            ? `<p class="wiz-desc">${escapeHtml(this.t('renderer.account.browserLoginHint'))}</p>
               <div class="wiz-inline-actions"><button id="wizard-copy-login-link" class="wiz-btn wiz-btn-secondary" type="button"><i class="fas fa-copy"></i>${escapeHtml(
                   this.t('renderer.account.copyLoginLink')
               )}</button></div>`
            : '';

        const providers = providerMethods.length
            ? `<div class="wiz-inline-actions">${providerMethods
                  .map((providerMethod) => {
                      const provider = resolveLocalizedText(providerMethod.displayName);
                      const label = this.t('renderer.account.loginWithProvider', { provider });
                      return `<button class="wiz-btn wiz-btn-secondary" type="button" data-browser-method="${escapeHtml(
                          providerMethod.id
                      )}" ${this.loginBusy ? 'disabled' : ''}>${escapeHtml(label)}</button>`;
                  })
                  .join('')}</div>`
            : '';

        if (!fields && !providers && !unavailable && this.loginMethodLoading) {
            return `<div class="wiz-verify wiz-verify-info"><i class="fas fa-spinner fa-spin"></i>${escapeHtml(
                this.t('renderer.wizard.loadingLoginMethods')
            )}</div>`;
        }

        return `${fields}${result}${browserHint}${providers}`;
    }

    // =================== Step: 模型配置 ===================

    private _renderModelStep(): string {
        return `
        <div class="wiz-head">
            <div class="wiz-eyebrow">${escapeHtml(this._stepTag('model'))}</div>
            <h2 class="wiz-title">${escapeHtml(this.t('renderer.wizard.modelTitle'))}</h2>
            <p class="wiz-desc">${escapeHtml(this.t('renderer.wizard.modelDesc'))}</p>
        </div>
        ${this._renderModelConfig()}
        `;
    }

    private _renderModelConfig(): string {
        const templateOptions = this.providerTemplates
            .map(
                (t) =>
                    `<option value="${escapeHtml(t.name)}" data-url="${escapeHtml(t.base_url)}" data-provider-type="${escapeHtml(t.provider_type || 'openai')}" data-display="${escapeHtml(t.displayName)}">${escapeHtml(t.displayName)}</option>`
            )
            .join('');

        return `
        <style>${MODEL_SELECT_CSS}</style>
        <div class="wiz-card">
            <div class="wiz-field">
                <label class="wiz-label" for="wizard-provider-select">${escapeHtml(
                    this.t('renderer.wizard.fieldProvider')
                )}</label>
                <select id="wizard-provider-select" class="wiz-ctl wiz-select">
                    <option value="">${escapeHtml(this.t('renderer.wizard.fieldProviderPlaceholder'))}</option>
                    ${templateOptions}
                    <option value="__custom__">${escapeHtml(this.t('renderer.wizard.fieldProviderCustom'))}</option>
                </select>
            </div>
            <div class="wiz-field">
                <label class="wiz-label" for="wizard-provider-type">${escapeHtml(
                    this.t('renderer.wizard.fieldProviderType')
                )}</label>
                <select id="wizard-provider-type" class="wiz-ctl wiz-select">
                    <option value="openai">OpenAI</option>
                    <option value="anthropic">Anthropic</option>
                </select>
            </div>
            <div class="wiz-field">
                <label class="wiz-label" for="wizard-base-url">${escapeHtml(this.t('renderer.wizard.fieldBaseUrl'))}</label>
                <input id="wizard-base-url" type="text" class="wiz-ctl" placeholder="https://api.example.com/v1">
            </div>
            <div class="wiz-field">
                <label class="wiz-label" for="wizard-api-key">${escapeHtml(this.t('renderer.wizard.fieldApiKey'))}</label>
                <div class="wiz-ctl-group">
                    <input id="wizard-api-key" type="password" class="wiz-ctl-input" placeholder="sk-..." autocomplete="off">
                    <button id="wizard-toggle-key" class="wiz-ctl-btn" type="button" aria-label="${escapeHtml(
                        this.t('renderer.wizard.showPassword')
                    )}">
                        <i class="fas fa-eye"></i>
                    </button>
                </div>
            </div>
            <div class="wiz-checks">
                <label class="wiz-check">
                    <input id="wizard-no-proxy" type="checkbox">
                    <span>${escapeHtml(this.t('renderer.wizard.noProxy'))}</span>
                </label>
                <label class="wiz-check">
                    <input id="wizard-no-ssl" type="checkbox">
                    <span>${escapeHtml(this.t('renderer.wizard.noSsl'))}</span>
                </label>
            </div>
            <div class="wiz-field">
                <label class="wiz-label" for="wizard-model-name">${escapeHtml(
                    this.t('config.model.field.model_name')
                )}</label>
                <div class="wiz-model-fetch-row">
                    <div class="wiz-model-select model-combo">
                        <input id="wizard-model-name" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="wizard-model-suggestions" class="wiz-ctl" disabled autocomplete="off" aria-describedby="wizard-model-error" aria-label="${escapeHtml(
                            this.t('config.model.field.model_name')
                        )}">
                        <button id="wizard-model-name-toggle" class="model-suggestions-toggle" type="button" tabindex="-1" disabled aria-label="${escapeHtml(
                            this.t('config.model.discovery.showSuggestions')
                        )}"><i class="fas fa-chevron-down" aria-hidden="true"></i></button>
                        <div id="wizard-model-suggestions" class="model-suggestions" role="listbox" hidden></div>
                        <span id="wizard-model-loading" class="wiz-model-loading" hidden role="status"><i class="fas fa-spinner fa-spin" aria-hidden="true"></i></span>
                    </div>
                    <button id="wizard-fetch-models" class="wiz-btn wiz-btn-secondary" type="button" disabled>${escapeHtml(
                        this.t('config.model.discovery.fetch')
                    )}</button>
                </div>
                <p id="wizard-model-error" class="wiz-model-error" role="alert" hidden></p>
            </div>
            <div id="wizard-verify-result" class="wiz-verify" hidden></div>
        </div>
        `;
    }

    // =================== Step: 个性化设置 ===================

    private _renderPersonalizeStep(): string {
        return `
        <div class="wiz-head">
            <div class="wiz-eyebrow">${escapeHtml(this._stepTag('personalize'))}</div>
            <h2 class="wiz-title">${escapeHtml(this.t('renderer.wizard.personalizeTitle'))}</h2>
            <p class="wiz-desc">${escapeHtml(this.t('renderer.wizard.personalizeDesc'))}</p>
        </div>
        <div class="wiz-split">
            <div class="wiz-split-main">
                <section class="wiz-block">
                    <div class="wiz-block-head">
                        <h3 class="wiz-block-title">${escapeHtml(this.t('renderer.wizard.memoryTitle'))}</h3>
                        <label class="wiz-switch">
                            <input type="checkbox" role="switch" id="wizard-memory-toggle" ${
                                this.memoryEnabled ? 'checked' : ''
                            } aria-label="${escapeHtml(this.t('renderer.wizard.memoryTitle'))}">
                            <span class="wiz-switch-track" aria-hidden="true"><span class="wiz-switch-knob"></span></span>
                        </label>
                    </div>
                    <p class="wiz-block-desc">${escapeHtml(this.t('renderer.wizard.memoryDesc'))}</p>
                    <div class="wiz-memory-sample${this.memoryEnabled ? '' : ' is-off'}" id="wizard-memory-sample">
                        <span class="wiz-memory-row">· ${escapeHtml(this.t('renderer.wizard.memorySampleStyle'))}</span>
                        <span class="wiz-memory-row">· ${escapeHtml(this.t('renderer.wizard.memorySamplePath'))}</span>
                        <span class="wiz-memory-row">· ${escapeHtml(this.t('renderer.wizard.memorySampleLang'))}</span>
                    </div>
                    <p class="wiz-memory-note${this.memoryEnabled ? '' : ' is-on'}" id="wizard-memory-note">${escapeHtml(
                        this.t('renderer.wizard.memoryOffNote')
                    )}</p>
                </section>

                <section class="wiz-block">
                    <h3 class="wiz-block-title">${escapeHtml(this.t('renderer.wizard.outputTitle'))}</h3>
                    <div class="wiz-radio-list" role="radiogroup" aria-label="${escapeHtml(
                        this.t('renderer.wizard.outputTitle')
                    )}">
                        ${this._renderOutputOption('minimal')}
                        ${this._renderOutputOption('verbose')}
                    </div>
                </section>
            </div>

            <aside class="wiz-split-preview">
                <div class="wiz-preview">
                    <div class="wiz-preview-bar">
                        <span class="wiz-preview-bar-title"><i class="fas fa-wand-magic-sparkles" aria-hidden="true"></i>${escapeHtml(
                            this.t('renderer.wizard.previewTitle')
                        )}</span>
                        <span class="wiz-preview-pill">${escapeHtml(this.t('renderer.wizard.previewLive'))}</span>
                    </div>
                    <div class="wiz-preview-body" id="wizard-preview-body" data-mode="${this.outputMode}">
                        ${this._renderPreviewMinimal()}
                        ${this._renderPreviewVerbose()}
                    </div>
                </div>
            </aside>
        </div>
        `;
    }

    private _renderOutputOption(mode: OutputMode): string {
        const on = this.outputMode === mode;
        const label = this.t(mode === 'minimal' ? 'renderer.wizard.outputMinimal' : 'renderer.wizard.outputVerbose');
        const desc = this.t(
            mode === 'minimal' ? 'renderer.wizard.outputMinimalDesc' : 'renderer.wizard.outputVerboseDesc'
        );
        const icon = mode === 'minimal' ? 'fa-list-ul' : 'fa-layer-group';
        return `
        <button type="button" class="wiz-option${on ? ' is-on' : ''}" role="radio" aria-checked="${
            on ? 'true' : 'false'
        }" data-output-mode="${mode}">
            <span class="wiz-option-icon"><i class="fas ${icon}" aria-hidden="true"></i></span>
            <span class="wiz-option-text">
                <span class="wiz-option-title">${escapeHtml(label)}</span>
                <span class="wiz-option-desc">${escapeHtml(desc)}</span>
            </span>
            <span class="wiz-option-check" aria-hidden="true"><i class="fas fa-check"></i></span>
        </button>
        `;
    }

    /**
     * 简洁模式的预览：照 taskview 的真实结构复刻 —— 一条「查看过程（本轮共耗时 …）」折叠条
     * + 正文结论；已完成态没有「最终结果」小标签，也没有过程卡片外壳。
     */
    private _renderPreviewMinimal(): string {
        const duration = this.t('renderer.taskview.output.duration.seconds', { seconds: 12 });
        const summary = this.t('renderer.taskview.output.completedProcessWithDuration', { duration });
        return `
        <div class="wiz-pv-flow" data-mode="minimal">
            <div class="wiz-pv-process">
                <div class="wiz-pv-summary">
                    <span class="wiz-pv-summary-text">${escapeHtml(summary)}</span>
                    <span class="wiz-pv-chevron" aria-hidden="true"><i class="fas fa-chevron-right"></i></span>
                </div>
            </div>
            <div class="wiz-pv-final">${escapeHtml(this.t('renderer.wizard.previewFinal'))}</div>
        </div>
        `;
    }

    /** 详细模式的预览：琥珀色「深度思考」头 + 左侧竖线正文 + 工具行 + 结论前分隔线。 */
    private _renderPreviewVerbose(): string {
        const elapsed = this.t('reasoning.elapsed.seconds', { seconds: 6 });
        const chars = this.t('reasoning.elapsed.chars', { chars: 320 });
        const reasoningTime = this.t('renderer.wizard.previewReasoningTime', { time: `${elapsed}${chars}` });
        return `
        <div class="wiz-pv-flow" data-mode="verbose">
            <div class="wiz-pv-detail">
                <div class="wiz-pv-reasoning">
                    <div class="wiz-pv-reasoning-head">
                        <i class="fa-regular fa-lightbulb" aria-hidden="true"></i>
                        <span class="wiz-pv-reasoning-title">${escapeHtml(this.t('reasoning.card.title'))}</span>
                        <span class="wiz-pv-reasoning-time">${escapeHtml(reasoningTime)}</span>
                    </div>
                    <div class="wiz-pv-reasoning-body">${escapeHtml(this.t('renderer.wizard.previewReasoning'))}</div>
                </div>
                <div class="wiz-pv-tool">
                    <i class="fas fa-file-lines" aria-hidden="true"></i>
                    <span class="wiz-pv-tool-title">${escapeHtml(this.t('renderer.wizard.previewToolTitle'))}</span>
                    <span class="wiz-pv-tool-detail">${escapeHtml(this.t('renderer.wizard.previewToolDetail'))}</span>
                </div>
                <div class="wiz-pv-terminal">
                    <div class="wiz-pv-terminal-head">
                        <i class="fas fa-terminal" aria-hidden="true"></i>
                        <span class="wiz-pv-terminal-cmd">${escapeHtml(
                            this.t('renderer.wizard.previewTerminalCmd')
                        )}</span>
                        <span class="wiz-pv-terminal-tag">${escapeHtml(
                            this.t('renderer.wizard.previewTerminalTag')
                        )}</span>
                        <i class="fas fa-chevron-down wiz-pv-terminal-chevron" aria-hidden="true"></i>
                    </div>
                    <div class="wiz-pv-terminal-body">${escapeHtml(
                        this.t('renderer.wizard.previewTerminalOutput')
                    )}</div>
                </div>
            </div>
            <div class="wiz-pv-final wiz-pv-final-divider">${escapeHtml(this.t('renderer.wizard.previewFinal'))}</div>
        </div>
        `;
    }

    // =================== Step: 完成 ===================

    private _renderDoneStep(): string {
        const memoryLabel = this.memoryEnabled
            ? this.t('renderer.wizard.memoryOn')
            : this.t('renderer.wizard.memoryOff');
        const outputLabel = this.t(
            this.outputMode === 'minimal' ? 'renderer.wizard.outputMinimal' : 'renderer.wizard.outputVerbose'
        );
        return `
        <div class="wiz-head">
            <div class="wiz-eyebrow">${escapeHtml(this._stepTag('done'))}</div>
            <div class="wiz-done-head">
                <span class="wiz-done-icon" aria-hidden="true"><i class="fas fa-check"></i></span>
                <div>
                    <h2 class="wiz-title">${escapeHtml(this.t('renderer.wizard.doneTitle'))}</h2>
                    <p class="wiz-desc">${escapeHtml(this.t('renderer.wizard.doneDesc'))}</p>
                </div>
            </div>
        </div>
        <div class="wiz-summary">
            <div class="wiz-summary-row">
                <span class="wiz-summary-key">${escapeHtml(this.t('renderer.wizard.summaryModel'))}</span>
                <span class="wiz-summary-value">${escapeHtml(this.t('renderer.wizard.configured'))}</span>
            </div>
            <div class="wiz-summary-row">
                <span class="wiz-summary-key">${escapeHtml(this.t('renderer.wizard.summaryMemory'))}</span>
                <span class="wiz-summary-value" id="wizard-summary-memory">${escapeHtml(memoryLabel)}</span>
            </div>
            <div class="wiz-summary-row">
                <span class="wiz-summary-key">${escapeHtml(this.t('renderer.wizard.summaryOutput'))}</span>
                <span class="wiz-summary-value" id="wizard-summary-output">${escapeHtml(outputLabel)}</span>
            </div>
        </div>
        `;
    }

    // =================== 底部导航 ===================

    private _renderNav(): string {
        const step = this.stepKey;
        const hasPrev = this.currentStep > 1;
        const returnLabel = window.globalControlAPI?.getWizardReturnLabel?.() || this.t('renderer.wizard.back');

        const prevButton = hasPrev
            ? `<button id="wizard-prev-btn" class="wiz-btn-ghost" type="button"><i class="fas fa-arrow-left"></i>${escapeHtml(
                  this.t('renderer.wizard.previous')
              )}</button>`
            : `<button id="wizard-return-btn" class="wiz-btn-ghost" type="button"><i class="fas fa-arrow-left"></i>${escapeHtml(
                  returnLabel
              )}</button>`;

        if (step === 'account') {
            return `
            <button id="wizard-skip-login" class="wiz-btn-ghost" type="button">${escapeHtml(
                this.t('renderer.wizard.skipLogin')
            )}<i class="fas fa-arrow-right"></i></button>
            <span class="wiz-foot-spacer"></span>
            ${this._renderAccountPrimaryButton()}
            `;
        }

        if (step === 'model') {
            return `
            ${prevButton}
            <span class="wiz-foot-spacer"></span>
            <button id="wizard-save-btn" class="wiz-btn wiz-btn-secondary" type="button">${escapeHtml(
                this.t('renderer.wizard.saveOnly')
            )}</button>
            <button id="wizard-verify-btn" class="wiz-btn wiz-btn-primary" type="button">
                <i class="fas fa-check-double"></i>${escapeHtml(this.t('renderer.wizard.verifyAndSave'))}
            </button>
            `;
        }

        if (step === 'personalize') {
            return `
            ${prevButton}
            <span class="wiz-foot-spacer"></span>
            <button id="wizard-next-btn" class="wiz-btn wiz-btn-primary" type="button">${escapeHtml(
                this.t('renderer.wizard.nextStep')
            )}</button>
            `;
        }

        return `
        ${prevButton}
        <span class="wiz-foot-spacer"></span>
        <button id="wizard-create-task-btn" class="wiz-btn wiz-btn-primary" type="button">${escapeHtml(
            this.t('renderer.wizard.createTask')
        )}</button>
        `;
    }

    /** 账号步的主按钮：企业账号先填服务器地址（下一步），否则是登录（仅当存在账号密码表单）。 */
    private _renderAccountPrimaryButton(): string {
        if (this._accountKind() === 'enterprise' && this.enterpriseBaseUrlStep) {
            return `<button id="wizard-enterprise-next" class="wiz-btn wiz-btn-primary" type="button">${escapeHtml(
                this.t('renderer.wizard.nextStep')
            )}</button>`;
        }
        const hasPasswordForm = splitLoginMethods(this.loginMethods).passwordMethod?.type === 'form';
        if (this.loginBusy) {
            return `<button id="wizard-account-finish" class="wiz-btn wiz-btn-primary" type="button" disabled><i class="fas fa-spinner fa-spin"></i>${escapeHtml(
                this.t('renderer.wizard.loggingIn')
            )}</button>`;
        }
        if (!hasPasswordForm) return '';
        return `<button id="wizard-account-finish" class="wiz-btn wiz-btn-primary" type="button">${escapeHtml(
            this.t('renderer.wizard.login')
        )}</button>`;
    }

    // =================== 事件 ===================

    private _bindEvents(): void {
        this.querySelectorAll<HTMLButtonElement>('[data-wizard-step]').forEach((node) =>
            node.addEventListener('click', () => this._goToStep(Number(node.dataset.wizardStep ?? '1')))
        );

        this.querySelector('#wizard-prev-btn')?.addEventListener('click', () => this._prevStep());
        this.querySelector('#wizard-return-btn')?.addEventListener('click', () =>
            window.globalControlAPI.returnFromWizard()
        );
        this.querySelector('#wizard-skip-login')?.addEventListener('click', () => this._handleSkipLogin());
        this.querySelector('#wizard-create-task-btn')?.addEventListener('click', () =>
            window.globalControlAPI.openHomePage()
        );
        this.querySelector('#wizard-next-btn')?.addEventListener('click', () => void this._handlePersonalizeNext());

        this._bindAccountEvents();
        this._bindModelConfigEvents();
        this._bindPersonalizeEvents();
    }

    private _bindPersonalizeEvents(): void {
        const memoryToggle = this.querySelector<HTMLInputElement>('#wizard-memory-toggle');
        const sample = this.querySelector<HTMLElement>('#wizard-memory-sample');
        const note = this.querySelector<HTMLElement>('#wizard-memory-note');

        memoryToggle?.addEventListener('change', () => {
            this.memoryEnabled = !!memoryToggle.checked;
            sample?.classList.toggle('is-off', !this.memoryEnabled);
            note?.classList.toggle('is-on', !this.memoryEnabled);
        });

        this.querySelectorAll<HTMLButtonElement>('[data-output-mode]').forEach((option) =>
            option.addEventListener('click', () => {
                this.outputMode = option.dataset.outputMode === 'verbose' ? 'verbose' : 'minimal';
                this._syncOutputMode();
            })
        );
    }

    /** 切输出模式：选项选中态 + 右侧预览面板同步切换（预览两版都渲染，靠 data-mode 显隐）。 */
    private _syncOutputMode(): void {
        this.querySelectorAll<HTMLButtonElement>('[data-output-mode]').forEach((option) => {
            const on = option.dataset.outputMode === this.outputMode;
            option.classList.toggle('is-on', on);
            option.setAttribute('aria-checked', on ? 'true' : 'false');
        });
        const body = this.querySelector<HTMLElement>('#wizard-preview-body');
        if (body) body.dataset.mode = this.outputMode;
    }

    private async _handleSkipLogin(): Promise<void> {
        if (this.activeLoginFlowId) {
            void getAccountApi()?.cancelLogin?.(this.activeLoginFlowId);
            this.activeLoginFlowId = null;
        }
        this.loginChoice = 'nologin';
        this.loginError = null;
        this.loginBusy = false;
        this.loginBrowserUrl = null;
        this.enterpriseBaseUrlStep = true;
        try {
            await this.requireAccountApi().configure?.({ mode: 'nologin' });
        } catch (error) {
            // 账号模式是次要副作用，失败不阻塞进入模型配置
            console.warn('failed to switch account mode to nologin:', error);
        }
        this._nextStep();
    }

    private _bindAccountEvents(): void {
        this.querySelectorAll<HTMLButtonElement>('[data-account-kind]').forEach((button) =>
            button.addEventListener('click', () => {
                const kind = button.dataset.accountKind === 'enterprise' ? 'enterprise' : 'personal';
                // loginChoice 里个人账号记作 'opendesk'，必须用归一化后的 _accountKind() 比较，
                // 否则点已选中的个人页签也会重载登录方式、整块重绘
                if (this._accountKind() === kind) return;
                this.loginChoice = kind === 'enterprise' ? 'enterprise' : 'opendesk';
                this.enterpriseBaseUrlStep = kind === 'enterprise';
                this.loginError = null;
                this.loginBrowserUrl = null;
                this.loginMethods = [];
                this.loginMethodsLoaded = false;
                this._render();
                this._bindEvents();
                if (kind === 'personal') void this._loadLoginMethods('personal');
            })
        );

        this.querySelectorAll<HTMLButtonElement>('[data-toggle-login-field]').forEach((toggleBtn) =>
            toggleBtn.addEventListener('click', () => {
                const input = this.querySelector<HTMLInputElement>(
                    `[data-login-field="${toggleBtn.dataset.toggleLoginField}"]`
                );
                const icon = toggleBtn.querySelector('i');
                if (!input || !icon) return;
                const show = input.type === 'password';
                input.type = show ? 'text' : 'password';
                icon.classList.replace(show ? 'fa-eye' : 'fa-eye-slash', show ? 'fa-eye-slash' : 'fa-eye');
            })
        );

        this.querySelectorAll<HTMLInputElement>('[data-login-field]').forEach((input) =>
            input.addEventListener('input', (event) => {
                const fieldId = input.dataset.loginField;
                if (fieldId === 'username') this.loginUsername = (event.target as HTMLInputElement).value;
                if (fieldId === 'password') this.loginPassword = (event.target as HTMLInputElement).value;
            })
        );

        this.querySelectorAll<HTMLButtonElement>('[data-browser-method]').forEach((button) =>
            button.addEventListener('click', () => {
                void this._handleBrowserLogin(button.dataset.browserMethod ?? '');
            })
        );

        this.querySelector('#wizard-copy-login-link')?.addEventListener('click', () => {
            const url = this.loginBrowserUrl;
            if (url) void navigator.clipboard?.writeText(url).catch(() => {});
        });

        this.querySelector<HTMLInputElement>('#wizard-enterprise-base-url')?.addEventListener('input', (event) => {
            this.enterpriseBaseUrlDraft = (event.target as HTMLInputElement).value;
        });

        this.querySelector<HTMLButtonElement>('#wizard-account-finish')?.addEventListener('click', () => {
            void this._handleAccountLogin();
        });
        // 企业地址页没有表单按钮，用底栏主按钮承载「下一步」
        const enterpriseNext = this.querySelector<HTMLElement>('#wizard-enterprise-next');
        enterpriseNext?.addEventListener('click', () => void this._handleEnterpriseBaseUrlNext());
    }

    /** accountAPI 缺失（preload 未注入或账号能力被裁剪）时的统一失败路径。 */
    private requireAccountApi(): AccountApi {
        const api = getAccountApi();
        if (!api) throw new Error('account:backend_unavailable');
        return api;
    }

    private async _handleEnterpriseBaseUrlNext(): Promise<void> {
        const baseUrl = this.enterpriseBaseUrlDraft.trim();
        const resultDiv = this.querySelector<HTMLElement>('#wizard-account-result');
        if (!baseUrl) {
            this._showResult(resultDiv, 'error', this.t('renderer.wizard.enterpriseBaseUrlRequired'));
            return;
        }
        try {
            await this.requireAccountApi().configure?.({ enterprise_base_url: baseUrl });
            this.enterpriseBaseUrlStep = false;
            this._render();
            this._bindEvents();
            await this._loadLoginMethods('enterprise');
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            this._showResult(resultDiv, 'error', msg);
        }
    }

    private async _handleAccountLogin(): Promise<void> {
        if (this.loginBusy) return;
        const method = splitLoginMethods(this.loginMethods).passwordMethod;
        const resultDiv = this.querySelector<HTMLElement>('#wizard-account-result');
        if (!method || method.type !== 'form') return;
        const values: Record<string, string> = {};
        for (const field of method.fields) {
            const value = this.querySelector<HTMLInputElement>(`[data-login-field="${field.id}"]`)?.value ?? '';
            values[field.id] = value;
            if (field.required && !value.trim()) {
                this._showResult(resultDiv, 'error', this.t('renderer.wizard.loginRequired'));
                return;
            }
        }
        await this._performAccountLogin(method, values);
    }

    /** Provider 按钮直接发起浏览器登录，无需再点击登录按钮。 */
    private async _handleBrowserLogin(methodId: string): Promise<void> {
        if (this.loginBusy) return;
        const method = this.loginMethods.find((candidate) => candidate.id === methodId);
        if (!method) return;
        await this._performAccountLogin(method, {});
    }

    private async _performAccountLogin(method: AccountLoginMethod, values: Record<string, string>): Promise<void> {
        this.loginBusy = true;
        this.loginError = null;
        this.loginBrowserUrl = null;
        this._render();
        this._bindEvents();
        try {
            const api = this.requireAccountApi();
            const kind = this._accountKind();
            await runAccountLoginFlow({
                api,
                kind,
                method,
                values,
                onStatus: (message) => {
                    if (message !== undefined) {
                        const target = this.querySelector<HTMLElement>('#wizard-account-result');
                        this._showResult(target, 'info', message);
                    }
                },
                onBrowserUrl: (url) => {
                    this.loginBrowserUrl = url;
                    this._render();
                    this._bindEvents();
                },
                onFlowStarted: (flowId) => {
                    this.activeLoginFlowId = flowId;
                }
            });
            this.activeLoginFlowId = null;
            await this._saveAccountMode();
            this.loginBusy = false;
            this.loginBrowserUrl = null;
            // 登录后仍需配置自己的模型，下一步进入模型配置
            this._nextStep();
        } catch (error: unknown) {
            this.activeLoginFlowId = null;
            this.loginBrowserUrl = null;
            this.loginError = formatAccountLoginError(error, this.t, this.t('renderer.wizard.loginFailed'));
            this.loginBusy = false;
            this._render();
            this._bindEvents();
        }
    }

    private async _loadLoginMethods(kind: 'personal' | 'enterprise'): Promise<void> {
        const generation = ++this.loginMethodsGeneration;
        this.loginMethodLoading = true;
        this.loginMethodsLoaded = false;
        this.loginError = null;
        this._render();
        this._bindEvents();
        try {
            const api = this.requireAccountApi();
            if (!api.getLoginMethods) throw new Error('account:backend_unavailable');
            const methods = await api.getLoginMethods(kind);
            // 请求期间用户可能已切到另一种账号类型：丢弃这次的结果，不能覆盖当前页签的数据
            if (generation === this.loginMethodsGeneration) this.loginMethods = methods;
        } catch (error: unknown) {
            if (generation === this.loginMethodsGeneration) {
                this.loginError = error instanceof Error ? error.message : String(error);
            }
        } finally {
            // 只有最新一次请求负责收尾渲染，旧请求的 loading/loaded 状态由它自己那份不再生效
            if (generation === this.loginMethodsGeneration) {
                this.loginMethodLoading = false;
                this.loginMethodsLoaded = true;
                this._render();
                this._bindEvents();
            }
        }
    }

    private async _saveAccountMode(): Promise<void> {
        const mode =
            this.loginChoice === 'opendesk' ? 'personal' : this.loginChoice === 'enterprise' ? 'enterprise' : 'nologin';
        await this.requireAccountApi().configure?.({ mode });
    }

    private _bindModelConfigEvents(): void {
        const providerSelect = this.querySelector<HTMLSelectElement>('#wizard-provider-select');
        const providerTypeSelect = this.querySelector<HTMLSelectElement>('#wizard-provider-type');
        const baseUrlInput = this.querySelector<HTMLInputElement>('#wizard-base-url');
        const toggleKeyBtn = this.querySelector<HTMLButtonElement>('#wizard-toggle-key');
        const verifyBtn = this.querySelector<HTMLButtonElement>('#wizard-verify-btn');
        const saveBtn = this.querySelector<HTMLButtonElement>('#wizard-save-btn');

        const modelSelect = this.querySelector<HTMLInputElement>('#wizard-model-name');
        const loading = this.querySelector<HTMLElement>('#wizard-model-loading');
        const error = this.querySelector<HTMLElement>('#wizard-model-error');
        const fetchBtn = this.querySelector<HTMLButtonElement>('#wizard-fetch-models');
        if (!providerSelect || !baseUrlInput || !modelSelect || !loading || !error || !fetchBtn) return;

        const models = createModelSelect({
            input: modelSelect,
            suggestions: this.querySelector<HTMLElement>('#wizard-model-suggestions')!,
            toggle: this.querySelector<HTMLButtonElement>('#wizard-model-name-toggle')!,
            loading,
            error,
            t: this.t
        });
        models.reset('config.model.discovery.providerFirst');
        let fetchGeneration = 0;
        const clearVerifyResult = () => {
            const result = this.querySelector<HTMLElement>('#wizard-verify-result');
            if (result) {
                result.className = 'wiz-verify';
                result.hidden = true;
                result.textContent = '';
            }
        };
        modelSelect.addEventListener('input', clearVerifyResult);
        modelSelect.addEventListener('change', clearVerifyResult);
        const updateFetchButton = () => {
            fetchBtn.disabled = !providerSelect.value || !baseUrlInput.value.trim();
        };
        const resetModels = () => {
            fetchGeneration++;
            clearVerifyResult();
            models.reset(
                providerSelect.value ? 'config.model.discovery.select' : 'config.model.discovery.providerFirst'
            );
            modelSelect.disabled = !providerSelect.value;
            fetchBtn.textContent = this.t('config.model.discovery.fetch');
            updateFetchButton();
        };
        const fetchModels = async () => {
            if (!providerSelect.value || !baseUrlInput.value.trim()) return;
            const request = ++fetchGeneration;
            fetchBtn.disabled = true;
            fetchBtn.textContent = this.t('config.model.discovery.loading');
            await models.load(() =>
                window.settingAPI.fetchProviderModels({
                    base_url: baseUrlInput.value.trim(),
                    api_key: this.querySelector<HTMLInputElement>('#wizard-api-key')?.value || '',
                    provider_type: providerTypeSelect?.value === 'anthropic' ? 'anthropic' : 'openai',
                    no_proxy: !!this.querySelector<HTMLInputElement>('#wizard-no-proxy')?.checked,
                    no_ssl: !!this.querySelector<HTMLInputElement>('#wizard-no-ssl')?.checked
                })
            );
            if (request === fetchGeneration) {
                fetchBtn.textContent = this.t('config.model.discovery.fetch');
                updateFetchButton();
            }
        };
        fetchBtn.addEventListener('click', () => void fetchModels());
        for (const input of [baseUrlInput, this.querySelector<HTMLInputElement>('#wizard-api-key')]) {
            input?.addEventListener('input', resetModels);
            input?.addEventListener('change', resetModels);
        }
        for (const input of [
            providerTypeSelect,
            this.querySelector('#wizard-no-proxy'),
            this.querySelector('#wizard-no-ssl')
        ]) {
            input?.addEventListener('change', resetModels);
        }

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
            modelSelect.value = '';
            resetModels();
        });

        toggleKeyBtn?.addEventListener('click', () => {
            const input = this.querySelector<HTMLInputElement>('#wizard-api-key');
            const icon = toggleKeyBtn.querySelector('i');
            if (!input || !icon) return;
            const show = input.type === 'password';
            input.type = show ? 'text' : 'password';
            icon.classList.replace(show ? 'fa-eye' : 'fa-eye-slash', show ? 'fa-eye-slash' : 'fa-eye');
        });

        verifyBtn?.addEventListener('click', () => this._handleVerifyAndSave());
        saveBtn?.addEventListener('click', () => this._handleSaveOnly());
    }

    private async _handleSaveOnly(): Promise<void> {
        const baseUrl = this.querySelector<HTMLInputElement>('#wizard-base-url')?.value?.trim();
        const modelName = this.querySelector<HTMLInputElement>('#wizard-model-name')?.value?.trim();
        const resultDiv = this.querySelector<HTMLElement>('#wizard-verify-result');

        if (!baseUrl) {
            this._showResult(resultDiv, 'error', this.t('renderer.wizard.baseUrlRequired'));
            return;
        }
        if (!modelName) {
            this._showResult(resultDiv, 'error', this.t('config.model.validation.model_name_required'));
            return;
        }

        if (!(await this._doSave())) return;
        this._nextStep();
    }

    /**
     * 把向导里填的 provider / 模型写入设置。
     * @returns 是否已成功落盘。返回 false 时调用方必须中止后续步骤，
     *          否则向导会带着没保存的配置进入下一步，用户会误以为已经配置好了。
     */
    private async _doSave(): Promise<boolean> {
        const baseUrl = this.querySelector<HTMLInputElement>('#wizard-base-url')?.value?.trim();
        if (!baseUrl) return false;
        const apiKey = this.querySelector<HTMLInputElement>('#wizard-api-key')?.value || '';
        const providerType =
            this.querySelector<HTMLSelectElement>('#wizard-provider-type')?.value === 'anthropic'
                ? 'anthropic'
                : 'openai';
        const modelName = this.querySelector<HTMLInputElement>('#wizard-model-name')?.value?.trim();
        if (!modelName) return false;
        const noProxy = this.querySelector<HTMLInputElement>('#wizard-no-proxy')?.checked || false;
        const noSSL = this.querySelector<HTMLInputElement>('#wizard-no-ssl')?.checked || false;
        const providerSelect = this.querySelector<HTMLSelectElement>('#wizard-provider-select');
        const providerName =
            providerSelect?.value && providerSelect.value !== '__custom__' ? providerSelect.value : 'custom';

        let data: LoadedSettingObject;
        try {
            data = await window.settingAPI.loadSettingObject();
        } catch (error) {
            // 连现有配置都读不出来，同样属于「配不进去」：必须阻塞告知，不能静默中止
            await this._showSaveFailedModal(error);
            return false;
        }
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

        let sideEffectFailures: SettingSideEffectFailure[];
        try {
            ({ sideEffectFailures } = await window.settingAPI.saveSettingObjectDetailed(data));
        } catch (error) {
            // 配置没能落盘：必须阻塞告知，否则向导会继续进入下一步，用户以为已经配置完成
            await this._showSaveFailedModal(error);
            return false;
        }
        // 配置已落盘：提示放在 catch 之外，避免提示自身出错被误报成「保存失败」
        notifySettingSideEffectFailures(sideEffectFailures, this.t);
        this.currentData = data;
        return true;
    }

    /** 个性化设置落盘：输出模式与记忆开关都写在 gui_config 上。 */
    private async _savePersonalize(): Promise<boolean> {
        let data: LoadedSettingObject;
        try {
            data = await window.settingAPI.loadSettingObject();
        } catch (error) {
            await this._showSaveFailedModal(error);
            return false;
        }
        data.gui_config = {
            ...(data.gui_config ?? {}),
            output_mode: this.outputMode,
            memory_enabled: this.memoryEnabled
        } as typeof data.gui_config;

        let sideEffectFailures: SettingSideEffectFailure[];
        try {
            ({ sideEffectFailures } = await window.settingAPI.saveSettingObjectDetailed(data));
        } catch (error) {
            await this._showSaveFailedModal(error);
            return false;
        }
        notifySettingSideEffectFailures(sideEffectFailures, this.t);
        this.currentData = data;
        return true;
    }

    private async _handlePersonalizeNext(): Promise<void> {
        if (!(await this._savePersonalize())) return;
        this._nextStep();
    }

    /**
     * 向导保存链路（读配置 / 写配置）失败时的阻塞提示。
     * 用模态而不是行内文案：失败时向导不会前进，必须让用户明确知道当前状态。
     */
    private async _showSaveFailedModal(error: unknown): Promise<void> {
        const message = error instanceof Error ? error.message : String(error);
        await showInfoModal({
            variant: 'danger',
            title: this.t('renderer.wizard.saveFailedTitle'),
            message: `${escapeHtml(this.t('renderer.wizard.saveFailedMessage'))}<br><br><code>${escapeHtml(message)}</code>`,
            confirmText: this.t('common.close')
        });
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
            this._showResult(resultDiv, 'error', this.t('renderer.wizard.baseUrlRequired'));
            return;
        }
        if (!modelName) {
            this._showResult(resultDiv, 'error', this.t('config.model.validation.model_name_required'));
            return;
        }

        this._verifying = true;
        if (verifyBtn) {
            verifyBtn.disabled = true;
            verifyBtn.innerHTML = `<i class="fas fa-spinner fa-spin"></i>${escapeHtml(
                this.t('renderer.wizard.verifying')
            )}`;
        }
        this._showResult(resultDiv, 'info', this.t('renderer.wizard.verifyRunning'));

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

            this._showResult(resultDiv, 'success', this.t('renderer.wizard.verifySuccess'));

            if (!(await this._doSave())) return;

            setTimeout(() => {
                // 用户可能在验证成功的这 600ms 里点里程碑跳到别的步骤：只在仍停在模型配置时前进，
                // 否则 _nextStep() 会把「用户已经跳到的那一步」再 +1
                if (this.stepKey === 'model') this._nextStep();
            }, 600);
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            this._showResult(resultDiv, 'error', this.t('renderer.wizard.verifyFailed', { message: msg }));
        } finally {
            this._verifying = false;
            if (verifyBtn) {
                verifyBtn.disabled = false;
                verifyBtn.innerHTML = `<i class="fas fa-check-double"></i>${escapeHtml(
                    this.t('renderer.wizard.verifyAndSave')
                )}`;
            }
        }
    }

    private _showResult(el: HTMLElement | null, type: ResultType, message: string): void {
        if (!el) return;
        el.hidden = false;
        el.className = `wiz-verify wiz-verify-${type}`;
        const iconMap: Record<ResultType, string> = {
            success: 'fa-check-circle',
            error: 'fa-circle-exclamation',
            info: 'fa-info-circle'
        };
        el.innerHTML = `<i class="fas ${iconMap[type]}"></i>${escapeHtml(message)}`;
    }
}

customElements.define('setup-wizard', SetupWizard);
