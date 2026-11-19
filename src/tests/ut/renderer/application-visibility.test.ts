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

    test('hides applications that have no standalone entry', () => {
        // agentgate 已并入「设置 → 安全设置」；skillmgr 由侧边栏「技能」直达。
        // 两者都还带 showIcon=true（主进程侧仍在运行），但不应出现在应用列表里。
        expect(
            isApplicationVisibleInMenu({ bundleName: 'agentgate', showIcon: true, isExperimental: false }, undefined)
        ).toBe(false);
        expect(
            isApplicationVisibleInMenu({ bundleName: 'skillmgr', showIcon: true, isExperimental: false }, undefined)
        ).toBe(false);
        // 与实验性开关无关：即使显式打开也不回到列表
        expect(
            isApplicationVisibleInMenu(
                { bundleName: 'agentgate', showIcon: true, isExperimental: true },
                { applications: { agentgate: true } }
            )
        ).toBe(false);
    });
});
