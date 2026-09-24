import { beforeAll, describe, expect, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { resolveWizardStep2View } from '../../../renderer/utils/wizard-flow.js';

describe('setup wizard flow', () => {
    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            customElements: window.customElements
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
});
