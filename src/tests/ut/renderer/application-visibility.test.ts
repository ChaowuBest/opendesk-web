import {
    isApplicationVisibleInMenu,
    isExperimentalApplicationEnabled
} from '../../../renderer/utils/application-visibility.js';

describe('application menu visibility', () => {
    test('updates experimental application visibility with the runtime setting', () => {
        const office = { bundleName: 'agentoffice', showIcon: true, isExperimental: true };

        expect(isApplicationVisibleInMenu(office, { applications: { agentoffice: false } })).toBe(false);
        expect(isApplicationVisibleInMenu(office, { applications: { agentoffice: true } })).toBe(true);
        expect(isApplicationVisibleInMenu(office, { applications: { appmgr: true } })).toBe(false);
    });

    test('blocks direct access to experimental applications when the setting is disabled', () => {
        const office = { bundleName: 'agentoffice', isExperimental: true };

        expect(isExperimentalApplicationEnabled(office, { applications: { agentoffice: false } })).toBe(false);
        expect(isExperimentalApplicationEnabled(office, { applications: { agentoffice: true } })).toBe(true);
        expect(isExperimentalApplicationEnabled({ bundleName: 'agentgate', isExperimental: false }, undefined)).toBe(
            true
        );
    });

    test('keeps regular applications visible and explicit hidden applications hidden', () => {
        expect(
            isApplicationVisibleInMenu({ bundleName: 'mailbox', showIcon: true, isExperimental: false }, undefined)
        ).toBe(true);
        expect(
            isApplicationVisibleInMenu({ bundleName: 'mailbox', showIcon: false, isExperimental: false }, undefined)
        ).toBe(false);
        expect(
            isApplicationVisibleInMenu(
                { bundleName: 'agentoffice', showIcon: false, isExperimental: true },
                { applications: { agentoffice: true } }
            )
        ).toBe(false);
    });
});
