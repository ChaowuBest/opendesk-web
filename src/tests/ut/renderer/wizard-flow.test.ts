import { beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { choose, mockModelAPI, settle } from './helpers/model-form.js';
import { resolveWizardStep2View } from '../../../renderer/utils/wizard-flow.js';

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

    test('account choices show account login as the second step', () => {
        expect(resolveWizardStep2View('enterprise', true)).toBe('enterprise-login');
        expect(resolveWizardStep2View('opendesk', true)).toBe('personal-login');
    });

    test('no-login and disabled account flows keep model configuration', () => {
        expect(resolveWizardStep2View('nologin', true)).toBe('model-config');
        expect(resolveWizardStep2View('opendesk', false)).toBe('model-config');
    });

    test('stepper labels the second step by login choice', () => {
        const wizard = document.createElement('setup-wizard') as any;
        wizard.currentData = { debug: { experimental_features: { account: true } } };

        wizard.loginChoice = 'opendesk';
        expect(wizard._renderStepper()).toContain('账号登录');

        wizard.loginChoice = 'nologin';
        expect(wizard._renderStepper()).toContain('模型配置');
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
        expect(html).toContain('id="wizard-account-finish"');
        expect(html).toContain('data-browser-method="gitcode"');
        expect(html).toContain('Sign in with GitCode');
        expect(html.indexOf('data-login-field="username"')).toBeLessThan(html.indexOf('data-browser-method="gitcode"'));
    });

    test('shows account service unavailable once async loading finishes with no methods', () => {
        const wizard = document.createElement('setup-wizard') as any;
        wizard.enterpriseBaseUrlStep = false;
        wizard.loginMethodsLoaded = true;
        wizard.loginMethods = [];

        const html = wizard._renderAccountLogin('personal');
        expect(html).toContain('verify-result verify-error');
        expect(html).not.toContain('data-login-field=');
    });

    describe('model discovery', () => {
        beforeEach(() => {
            (window as any).settingAPI = mockModelAPI();
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
            expect(select.disabled).toBe(true);
            expect(select.querySelector('option[value="gpt-4o"]')).toBeNull();
        });

        test('wizard recovers from discovery and validation errors after choosing a model', async () => {
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
            expect(error.textContent).toContain('API key');
            await wizard._handleSaveOnly();
            const result = wizard.querySelector('#wizard-verify-result');
            expect(result.classList.contains('hidden')).toBe(false);
            wizard.querySelector('#wizard-fetch-models').click();
            await settle();
            choose(wizard.querySelector('#wizard-model-name'), 'gpt-4o');
            expect(error.hidden).toBe(true);
            expect(result.classList.contains('hidden')).toBe(true);
        });
    });
});
