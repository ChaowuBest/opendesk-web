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

    test('shows model configuration after enterprise account login completes', () => {
        expect(resolveWizardStep2View('enterprise', false, true)).toBe('enterprise-login');
        expect(resolveWizardStep2View('enterprise', true, true)).toBe('model-config');
    });

    test('shows model configuration directly for no-login and disabled account flows', () => {
        expect(resolveWizardStep2View('nologin', false, true)).toBe('model-config');
        expect(resolveWizardStep2View('opendesk', false, false)).toBe('model-config');
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
        wizard.selectedLoginMethodId = 'password';

        expect(() => wizard._renderAccountLogin('enterprise')).not.toThrow();
        expect(wizard._renderAccountLogin('enterprise')).toContain('data-login-field="username"');
        expect(wizard._renderAccountLogin('enterprise')).toContain('data-login-field="password"');
    });
});
