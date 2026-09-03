import { resolveWizardStep2View } from '../../../renderer/utils/wizard-flow.js';

describe('setup wizard flow', () => {
    test('shows model configuration after enterprise account login completes', () => {
        expect(resolveWizardStep2View('enterprise', false, true)).toBe('enterprise-login');
        expect(resolveWizardStep2View('enterprise', true, true)).toBe('model-config');
    });

    test('shows model configuration directly for no-login and disabled account flows', () => {
        expect(resolveWizardStep2View('nologin', false, true)).toBe('model-config');
        expect(resolveWizardStep2View('opendesk', false, false)).toBe('model-config');
    });
});
