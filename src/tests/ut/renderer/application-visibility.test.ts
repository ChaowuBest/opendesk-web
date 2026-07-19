import {
    isApplicationVisibleInMenu,
    isExperimentalApplicationEnabled
} from '../../../renderer/utils/application-visibility.js';

describe('application menu visibility', () => {
    test('updates experimental application visibility with the runtime setting', () => {
        const office = { showIcon: true, isExperimental: true };

        expect(isApplicationVisibleInMenu(office, false)).toBe(false);
        expect(isApplicationVisibleInMenu(office, true)).toBe(true);
        expect(isApplicationVisibleInMenu(office, false)).toBe(false);
    });

    test('blocks direct access to experimental applications when the setting is disabled', () => {
        const office = { isExperimental: true };

        expect(isExperimentalApplicationEnabled(office, false)).toBe(false);
        expect(isExperimentalApplicationEnabled(office, true)).toBe(true);
        expect(isExperimentalApplicationEnabled({ isExperimental: false }, false)).toBe(true);
    });

    test('keeps regular applications visible and explicit hidden applications hidden', () => {
        expect(isApplicationVisibleInMenu({ showIcon: true, isExperimental: false }, false)).toBe(true);
        expect(isApplicationVisibleInMenu({ showIcon: false, isExperimental: false }, true)).toBe(false);
        expect(isApplicationVisibleInMenu({ showIcon: false, isExperimental: true }, true)).toBe(false);
    });
});
