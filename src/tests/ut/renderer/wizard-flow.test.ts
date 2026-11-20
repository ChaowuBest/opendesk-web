import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { choose, mockModelAPI, settle } from './helpers/model-form.js';

describe('setup wizard flow', () => {
    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            Event: window.Event,
            customElements: window.customElements
        });
        const selectValue = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!;
        Object.defineProperty(window.HTMLSelectElement.prototype, 'value', {
            ...selectValue,
            set(value) {
                for (const option of this.options) option.removeAttribute('selected');
                this.options.find((option: any) => option.value === value)?.setAttribute('selected', '');
            }
        });
        Object.defineProperty(globalThis, 'navigator', {
            value: { languages: ['en-US'], language: 'en-US' },
            configurable: true
        });

        await import('../../../renderer/components/wizard.js');
    });

    test('account step leads the wizard when the account feature is enabled', () => {
        const wizard = document.createElement('setup-wizard') as any;
        wizard.currentData = { debug: { experimental_features: { account: true } } };

        const html = wizard._renderStepper();
        expect(html).toContain('Sign in');
        expect(html).toContain('Model');
        expect(html).toContain('Preferences');
        expect(wizard.steps).toEqual(['account', 'model', 'personalize', 'done']);
    });

    test('account step disappears entirely when the account feature is disabled', () => {
        const wizard = document.createElement('setup-wizard') as any;
        wizard.currentData = { debug: { experimental_features: { account: false } } };

        const html = wizard._renderStepper();
        expect(html).not.toContain('Sign in');
        expect(wizard.steps).toEqual(['model', 'personalize', 'done']);
        expect(wizard.stepKey).toBe('model');
    });

    test('renders the enterprise login form after the server address step', () => {
        const wizard = document.createElement('setup-wizard') as any;
        wizard.enterpriseBaseUrlStep = false;
        wizard.loginMethods = [
            {
                id: 'password',
                type: 'form',
                displayName: 'Password',
                fields: [
                    { id: 'username', type: 'text', label: 'Username' },
                    { id: 'password', type: 'password', label: 'Password' }
                ]
            }
        ];

        expect(() => wizard._renderAccountLogin('enterprise')).not.toThrow();
        expect(wizard._renderAccountLogin('enterprise')).toContain('data-login-field="username"');
        expect(wizard._renderAccountLogin('enterprise')).toContain('data-login-field="password"');
    });

    test('renders provider sign-in buttons for personal accounts', () => {
        const wizard = document.createElement('setup-wizard') as any;
        wizard.enterpriseBaseUrlStep = false;
        wizard.loginMethodsLoaded = true;
        wizard.loginMethods = [
            { id: 'gitcode', type: 'browser', displayName: 'GitCode' },
            { id: 'gitee', type: 'browser', displayName: 'Gitee' }
        ];

        const html = wizard._renderAccountLogin('personal');
        expect(html).toContain('data-browser-method="gitcode"');
        expect(html).toContain('data-browser-method="gitee"');
        expect(html).toContain('Sign in with GitCode');
        expect(html).not.toContain('data-login-field=');
        expect(html).not.toContain('id="wizard-account-finish"');
    });

    test('renders the password form before provider buttons when both are available', () => {
        const wizard = document.createElement('setup-wizard') as any;
        wizard.enterpriseBaseUrlStep = false;
        wizard.loginMethodsLoaded = true;
        wizard.loginMethods = [
            {
                id: 'password',
                type: 'form',
                displayName: 'Password',
                fields: [
                    { id: 'username', type: 'text', label: 'Username' },
                    { id: 'password', type: 'password', label: 'Password' }
                ]
            },
            { id: 'gitcode', type: 'browser', displayName: 'GitCode' }
        ];

        const html = wizard._renderAccountLogin('personal');
        expect(html).toContain('data-login-field="username"');
        expect(html).toContain('data-browser-method="gitcode"');
        expect(html).toContain('Sign in with GitCode');
        expect(wizard._renderAccountPrimaryButton()).toContain('id="wizard-account-finish"');
        expect(html.indexOf('data-login-field="username"')).toBeLessThan(html.indexOf('data-browser-method="gitcode"'));
    });

    test('shows account service unavailable once async loading finishes with no methods', () => {
        const wizard = document.createElement('setup-wizard') as any;
        wizard.enterpriseBaseUrlStep = false;
        wizard.loginMethodsLoaded = true;
        wizard.loginMethods = [];

        const html = wizard._renderAccountLogin('personal');
        expect(html).toContain('wiz-verify-error');
        expect(html).not.toContain('data-login-field=');
    });

    describe('account tab and login-method loading', () => {
        beforeEach(() => {
            (window as any).globalControlAPI = {};
            (globalThis as any).accountAPI = { configure: async () => undefined };
        });

        function accountWizard() {
            const wizard = document.createElement('setup-wizard') as any;
            wizard.currentData = { debug: { experimental_features: { account: true } }, gui_config: {} };
            wizard.loginChoice = 'opendesk';
            wizard.innerHTML = wizard._renderAccountStep();
            wizard._bindAccountEvents();
            return wizard;
        }

        test('clicking the already-selected personal tab does not reload login methods', async () => {
            const calls: string[] = [];
            (globalThis as any).accountAPI = {
                getLoginMethods: async (kind: string) => {
                    calls.push(kind);
                    return [];
                },
                configure: async () => undefined
            };

            const wizard = accountWizard();
            wizard.querySelector('[data-account-kind="personal"]').click();
            await settle();

            // loginChoice 里个人账号记作 'opendesk'，用原始值比较会让这个页签每次都重载
            expect(calls).toEqual([]);
            expect(wizard.querySelector('[data-account-kind="personal"]').classList.contains('is-on')).toBe(true);
        });

        test('switching to the enterprise tab asks for the server address first', () => {
            const wizard = accountWizard();
            wizard.querySelector('[data-account-kind="enterprise"]').click();

            expect(wizard.loginChoice).toBe('enterprise');
            expect(wizard.enterpriseBaseUrlStep).toBe(true);
            expect(wizard.querySelector('#wizard-enterprise-base-url')).toBeTruthy();
            expect(wizard.querySelector('[data-account-kind="enterprise"]').classList.contains('is-on')).toBe(true);
        });

        test('a stale login-method response does not overwrite the current tab data', async () => {
            const gates: Record<string, (methods: unknown[]) => void> = {};
            (globalThis as any).accountAPI = {
                getLoginMethods: (kind: string) => new Promise((resolve) => (gates[kind] = resolve)),
                configure: async () => undefined
            };

            const wizard = accountWizard();
            const personal = wizard._loadLoginMethods('personal');
            const enterprise = wizard._loadLoginMethods('enterprise');
            gates.enterprise([{ id: 'ent', type: 'form', displayName: 'Enterprise', fields: [] }]);
            await enterprise;
            gates.personal([{ id: 'pwd', type: 'form', displayName: 'Password', fields: [] }]);
            await personal;

            expect(wizard.loginMethods.map((method: { id: string }) => method.id)).toEqual(['ent']);
            expect(wizard.loginMethodLoading).toBe(false);
        });
    });

    describe('personalize step', () => {
        beforeEach(() => {
            (window as any).__savedSetting = null;
            (window as any).settingAPI = {
                loadSettingObject: async () => ({ gui_config: { output_mode: 'minimal' } }),
                saveSettingObjectDetailed: async (data: any) => {
                    (window as any).__savedSetting = data;
                    return { data, sideEffectFailures: [] };
                }
            };
        });

        function personalizeWizard() {
            const wizard = document.createElement('setup-wizard') as any;
            wizard.currentData = { debug: { experimental_features: { account: true } }, gui_config: {} };
            wizard.innerHTML = wizard._renderPersonalizeStep();
            wizard._bindPersonalizeEvents();
            return wizard;
        }

        test('renders the memory switch, both output options and both previews', () => {
            const wizard = document.createElement('setup-wizard') as any;
            wizard.currentData = { debug: { experimental_features: { account: true } }, gui_config: {} };
            const html = wizard._renderPersonalizeStep();
            expect(html).toContain('id="wizard-memory-toggle"');
            expect(html).toContain('data-output-mode="minimal"');
            expect(html).toContain('data-output-mode="verbose"');
            expect(html).toContain('data-mode="minimal"');
            expect(html).toContain('data-mode="verbose"');
        });

        test('switching output mode updates the option state and the preview container', () => {
            const wizard = personalizeWizard();
            wizard.querySelector('[data-output-mode="verbose"]').click();
            expect(wizard.outputMode).toBe('verbose');
            expect(wizard.querySelector('#wizard-preview-body').dataset.mode).toBe('verbose');
            expect(wizard.querySelector('[data-output-mode="verbose"]').classList.contains('is-on')).toBe(true);
            expect(wizard.querySelector('[data-output-mode="minimal"]').getAttribute('aria-checked')).toBe('false');
        });

        test('toggling memory switches the sample block and the off hint', () => {
            const wizard = personalizeWizard();
            const toggle = wizard.querySelector('#wizard-memory-toggle');
            toggle.checked = false;
            toggle.dispatchEvent(new Event('change'));
            expect(wizard.memoryEnabled).toBe(false);
            expect(wizard.querySelector('#wizard-memory-sample').classList.contains('is-off')).toBe(true);
            expect(wizard.querySelector('#wizard-memory-note').classList.contains('is-on')).toBe(true);
        });

        test('persists memory switch and output mode into gui_config', async () => {
            const wizard = document.createElement('setup-wizard') as any;
            wizard.memoryEnabled = false;
            wizard.outputMode = 'verbose';
            await expect(wizard._savePersonalize()).resolves.toBe(true);
            const saved = (window as any).__savedSetting;
            expect(saved.gui_config.memory_enabled).toBe(false);
            expect(saved.gui_config.output_mode).toBe('verbose');
        });
    });

    describe('model discovery', () => {
        beforeEach(() => {
            (window as any).settingAPI = mockModelAPI();
            (window as any).globalControlAPI = {};
            (globalThis as any).accountAPI = { configure: async () => undefined };
        });

        function wizardForm() {
            const wizard = document.createElement('setup-wizard') as any;
            wizard.providerTemplates = [{ name: 'preset', displayName: 'Preset', base_url: 'https://example.test/v1' }];
            wizard.innerHTML = wizard._renderModelConfig();
            wizard._bindModelConfigEvents();
            return wizard;
        }

        test('wizard loads every provider only on button click with current credentials and network flags', async () => {
            const wizard = wizardForm();
            const select = wizard.querySelector('#wizard-model-name');
            const fetch = wizard.querySelector('#wizard-fetch-models');
            choose(wizard.querySelector('#wizard-provider-select'), 'preset');
            choose(select, 'unlisted-model');
            for (const [id, value] of [
                ['wizard-api-key', 'key'],
                ['wizard-base-url', 'https://updated.test/v1']
            ]) {
                const input = wizard.querySelector(`#${id}`);
                input.value = value;
                input.dispatchEvent(new Event('input'));
                input.dispatchEvent(new Event('change'));
            }
            for (const id of ['wizard-no-proxy', 'wizard-no-ssl']) {
                const input = wizard.querySelector(`#${id}`);
                input.checked = true;
                input.dispatchEvent(new Event('change'));
            }
            choose(wizard.querySelector('#wizard-provider-type'), 'anthropic');
            await settle();
            expect((window as any).settingAPI.fetchProviderModels).not.toHaveBeenCalled();
            fetch.click();
            expect(fetch.disabled).toBe(true);
            await settle();
            expect((window as any).settingAPI.fetchProviderModels).toHaveBeenCalledTimes(1);
            expect(select.value).toBe('unlisted-model');
            expect((window as any).settingAPI.fetchProviderModels).toHaveBeenCalledWith({
                base_url: 'https://updated.test/v1',
                api_key: 'key',
                provider_type: 'anthropic',
                no_proxy: true,
                no_ssl: true
            });
            choose(select, 'gpt-4o');
            choose(wizard.querySelector('#wizard-provider-select'), '__custom__');
            await settle();
            expect((window as any).settingAPI.fetchProviderModels).toHaveBeenCalledTimes(1);
            expect(select.disabled).toBe(false);
            expect(select.value).toBe('');
        });

        test('wizard accepts a manually entered model after discovery fails', async () => {
            const wizard = wizardForm();
            choose(wizard.querySelector('#wizard-provider-select'), '__custom__');
            const url = wizard.querySelector('#wizard-base-url');
            url.value = 'https://custom.test/v1';
            url.dispatchEvent(new Event('input'));
            (window as any).settingAPI.fetchProviderModels.mockRejectedValueOnce(new Error('MODEL_LIST_HTTP_401'));
            wizard.querySelector('#wizard-fetch-models').click();
            await settle();
            const error = wizard.querySelector('#wizard-model-error');
            expect(error.hidden).toBe(false);
            expect(error.textContent).toContain('may not provide');
            expect(error.textContent).toContain('401');
            await wizard._handleSaveOnly();
            const result = wizard.querySelector('#wizard-verify-result');
            expect(result.hidden).toBe(false);
            choose(wizard.querySelector('#wizard-model-name'), 'manual-model');
            expect(result.hidden).toBe(true);
            const saved = { providers: [], models: [] };
            (window as any).settingAPI.loadSettingObject = async () => saved;
            (window as any).settingAPI.saveSettingObjectDetailed = async () => ({
                data: saved,
                sideEffectFailures: []
            });
            await wizard._handleSaveOnly();
            expect(saved.models).toEqual([expect.objectContaining({ model_name: 'manual-model' })]);
        });

        test('the delayed auto-advance does not push a step further when the user already jumped', async () => {
            const wizard = wizardForm();
            wizard.currentData = {};
            choose(wizard.querySelector('#wizard-provider-select'), 'preset');
            const url = wizard.querySelector('#wizard-base-url');
            url.value = 'https://custom.test/v1';
            url.dispatchEvent(new Event('input'));
            choose(wizard.querySelector('#wizard-model-name'), 'manual-model');
            const saved = { providers: [], models: [] };
            (window as any).settingAPI.verifyModel = async () => undefined;
            (window as any).settingAPI.loadSettingObject = async () => saved;
            (window as any).settingAPI.saveSettingObjectDetailed = async () => ({
                data: saved,
                sideEffectFailures: []
            });

            jest.useFakeTimers();
            await wizard._handleVerifyAndSave();
            // 用户在成功提示与自动前进之间的 600ms 里点了里程碑跳到个性化设置
            wizard._goToStep(2);
            expect(wizard.stepKey).toBe('personalize');
            jest.advanceTimersByTime(700);
            jest.useRealTimers();

            // 定时器若按相对步数前进，会把用户已经跳到的这一步再 +1
            expect(wizard.stepKey).toBe('personalize');
        });
    });
});
