import { isAccountFeatureEnabled } from '../../../renderer/utils/account-feature-visibility.js';

describe('account feature visibility', () => {
    test('is disabled unless experimental features are explicitly enabled', () => {
        expect(isAccountFeatureEnabled(undefined)).toBe(false);
        expect(isAccountFeatureEnabled({})).toBe(false);
        expect(isAccountFeatureEnabled({ debug: {} })).toBe(false);
        expect(isAccountFeatureEnabled({ debug: { experimental_feature: false } })).toBe(false);
    });

    test('is enabled when experimental features are enabled', () => {
        expect(isAccountFeatureEnabled({ debug: { experimental_feature: true } })).toBe(true);
    });
});
