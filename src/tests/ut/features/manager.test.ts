import { FeatureManager, getFeatureManager, resetFeatureManagerForTests } from '../../../common/features/manager.js';
import {
    getFeatureDefinition,
    OPENDESK_FEATURES,
    resolveFeatureLocalizedText
} from '../../../common/features/registry.js';

describe('feature registry', () => {
    test('内置特性列表包含 memory / filesystem / telemetry 且文案完整', () => {
        const ids = OPENDESK_FEATURES.map((feature) => feature.id);
        expect(ids).toEqual(expect.arrayContaining(['memory', 'filesystem', 'telemetry']));
        // 浏览器能力不通过特性门控（use-browser / manage-browser 不受影响），只由 hideApplication 收起入口
        expect(ids).not.toContain('browser');
        for (const feature of OPENDESK_FEATURES) {
            expect(feature.displayName).toBeTruthy();
            expect(feature.description).toBeTruthy();
        }
    });

    test('getFeatureDefinition 命中已知 id、未知的返回 undefined', () => {
        expect(getFeatureDefinition('memory')?.id).toBe('memory');
        expect(getFeatureDefinition('filesystem')?.id).toBe('filesystem');
        expect(getFeatureDefinition('telemetry')?.id).toBe('telemetry');
        expect(getFeatureDefinition('browser')).toBeUndefined();
        expect(getFeatureDefinition('unknown-feature')).toBeUndefined();
    });

    test('resolveFeatureLocalizedText 字符串形式原样返回', () => {
        expect(resolveFeatureLocalizedText('Memory')).toBe('Memory');
        expect(resolveFeatureLocalizedText(undefined)).toBeUndefined();
        expect(resolveFeatureLocalizedText('   ')).toBeUndefined();
    });

    test('resolveFeatureLocalizedText 映射形式按主语言标签匹配并回退', () => {
        const text = { 'zh-CN': '记忆', en: 'Memory' };
        expect(resolveFeatureLocalizedText(text, 'zh-CN')).toBe('记忆');
        expect(resolveFeatureLocalizedText(text, 'zh-TW')).toBe('记忆');
        expect(resolveFeatureLocalizedText(text, 'en-US')).toBe('Memory');
        // 无匹配语言：zh -> en -> 首项
        expect(resolveFeatureLocalizedText(text, 'ja-JP')).toBe('记忆');
        expect(resolveFeatureLocalizedText({ en: 'Memory' }, 'zh-CN')).toBe('Memory');
        expect(resolveFeatureLocalizedText({ 'zh-CN': '记忆' }, 'en-US')).toBe('记忆');
        expect(resolveFeatureLocalizedText({}, 'zh-CN')).toBeUndefined();
    });
});

describe('FeatureManager', () => {
    let manager: FeatureManager;

    beforeEach(() => {
        manager = new FeatureManager();
    });

    test('初始状态无任何禁用', () => {
        expect(manager.isFeatureDisabled('memory')).toBe(false);
        expect(manager.isApplicationDisabled('filemgr')).toBe(false);
        expect(manager.getSnapshot()).toEqual({
            disabledFeatures: [],
            disabledApplications: [],
            hiddenApplications: []
        });
    });

    test('setFeatureDisabled 记录禁用并在释放后恢复', () => {
        manager.setFeatureDisabled('memory', 'plugin-a', true);
        expect(manager.isFeatureDisabled('memory')).toBe(true);
        expect(manager.getDisabledFeatures()).toEqual(['memory']);

        manager.setFeatureDisabled('memory', 'plugin-a', false);
        expect(manager.isFeatureDisabled('memory')).toBe(false);
        expect(manager.getSnapshot()).toEqual({
            disabledFeatures: [],
            disabledApplications: [],
            hiddenApplications: []
        });
    });

    test('多插件叠加禁用：全部回退后才恢复', () => {
        manager.setFeatureDisabled('filesystem', 'plugin-a', true);
        manager.setFeatureDisabled('filesystem', 'plugin-b', true);
        expect(manager.isFeatureDisabled('filesystem')).toBe(true);

        manager.setFeatureDisabled('filesystem', 'plugin-a', false);
        expect(manager.isFeatureDisabled('filesystem')).toBe(true);

        manager.setFeatureDisabled('filesystem', 'plugin-b', false);
        expect(manager.isFeatureDisabled('filesystem')).toBe(false);
    });

    test('同一插件重复禁用/释放是幂等的', () => {
        const notifications: string[] = [];
        manager.onFeaturesChanged(() => notifications.push('feature'));
        manager.onApplicationsChanged(() => notifications.push('application'));

        manager.setFeatureDisabled('memory', 'plugin-a', true);
        manager.setFeatureDisabled('memory', 'plugin-a', true);
        expect(notifications).toEqual(['feature']);

        manager.setFeatureDisabled('memory', 'plugin-a', false);
        manager.setFeatureDisabled('memory', 'plugin-a', false);
        // 第二次释放是 no-op，不重复通知
        expect(notifications).toEqual(['feature', 'feature']);
    });

    test('特性与应用的变更通知相互独立', () => {
        const featureNotifications: string[] = [];
        const applicationNotifications: string[] = [];
        manager.onFeaturesChanged(() => featureNotifications.push('feature'));
        manager.onApplicationsChanged(() => applicationNotifications.push('application'));

        manager.setApplicationDisabled('filemgr', 'plugin-a', true);
        expect(featureNotifications).toEqual([]);
        expect(applicationNotifications).toEqual(['application']);
        expect(manager.isApplicationDisabled('filemgr')).toBe(true);
        expect(manager.isFeatureDisabled('filemgr')).toBe(false);

        manager.setFeatureDisabled('memory', 'plugin-a', true);
        expect(featureNotifications).toEqual(['feature']);
        expect(applicationNotifications).toEqual(['application']);
    });

    test('onFeaturesChanged 返回的注销函数停止通知', () => {
        const notifications: string[] = [];
        const unsubscribe = manager.onFeaturesChanged(() => notifications.push('feature'));
        manager.setFeatureDisabled('memory', 'plugin-a', true);
        unsubscribe();
        manager.setFeatureDisabled('memory', 'plugin-b', true);
        expect(notifications).toEqual(['feature']);
        // plugin-b 仍持有禁用
        expect(manager.isFeatureDisabled('memory')).toBe(true);
    });

    test('acquireFeatureDisable 按持有次数计数：全部释放后才恢复', () => {
        const notifications: string[] = [];
        manager.onFeaturesChanged(() => notifications.push('feature'));

        const releaseFirst = manager.acquireFeatureDisable('memory', 'plugin-a');
        const releaseSecond = manager.acquireFeatureDisable('memory', 'plugin-a');
        expect(manager.isFeatureDisabled('memory')).toBe(true);
        expect(manager.listDisabledFeatures()).toEqual([{ id: 'memory', pluginIds: ['plugin-a'] }]);

        releaseFirst();
        // 同一插件还有一次未释放的持有，不能整体解锁
        expect(manager.isFeatureDisabled('memory')).toBe(true);

        releaseSecond();
        expect(manager.isFeatureDisabled('memory')).toBe(false);
        // 首次持有时通知一次，最后一次释放时再通知一次
        expect(notifications).toEqual(['feature', 'feature']);

        // 重复释放是 no-op，不重复通知
        releaseSecond();
        expect(notifications).toEqual(['feature', 'feature']);
    });

    test('acquireApplicationDisable 与 acquireFeatureDisable 互不影响', () => {
        const applicationNotifications: string[] = [];
        manager.onApplicationsChanged(() => applicationNotifications.push('application'));

        const releaseApp = manager.acquireApplicationDisable('filemgr', 'plugin-a');
        expect(manager.isApplicationDisabled('filemgr')).toBe(true);
        expect(manager.isFeatureDisabled('filemgr')).toBe(false);

        releaseApp();
        expect(manager.isApplicationDisabled('filemgr')).toBe(false);
        expect(applicationNotifications).toEqual(['application', 'application']);
    });

    test('hideApplication 只隐藏入口，不影响应用的禁用状态', () => {
        const notifications: string[] = [];
        manager.onApplicationsChanged(() => notifications.push('application'));

        manager.setApplicationHidden('mailbox', 'plugin-a', true);
        expect(manager.isApplicationHidden('mailbox')).toBe(true);
        expect(manager.isApplicationDisabled('mailbox')).toBe(false);
        expect(manager.getHiddenApplications()).toEqual(['mailbox']);
        expect(manager.getDisabledApplications()).toEqual([]);
        expect(notifications).toEqual(['application']);

        manager.setApplicationHidden('mailbox', 'plugin-a', false);
        expect(manager.isApplicationHidden('mailbox')).toBe(false);
        expect(manager.getSnapshot()).toEqual({
            disabledFeatures: [],
            disabledApplications: [],
            hiddenApplications: []
        });
    });

    test('acquireApplicationHide 按持有次数计数：全部释放后才恢复', () => {
        const releaseFirst = manager.acquireApplicationHide('mailbox', 'plugin-a');
        const releaseSecond = manager.acquireApplicationHide('plugin-app', 'plugin-a');
        expect(manager.listHiddenApplications()).toEqual([
            { bundleName: 'mailbox', pluginIds: ['plugin-a'] },
            { bundleName: 'plugin-app', pluginIds: ['plugin-a'] }
        ]);

        releaseFirst();
        releaseFirst();
        expect(manager.isApplicationHidden('mailbox')).toBe(false);
        expect(manager.isApplicationHidden('plugin-app')).toBe(true);

        releaseSecond();
        expect(manager.getHiddenApplications()).toEqual([]);
    });

    test('setFeatureDisabled(false) 清除该 owner 的全部持有次数', () => {
        manager.acquireFeatureDisable('memory', 'plugin-a');
        manager.acquireFeatureDisable('memory', 'plugin-a');
        manager.acquireFeatureDisable('memory', 'plugin-b');
        expect(manager.isFeatureDisabled('memory')).toBe(true);

        manager.setFeatureDisabled('memory', 'plugin-a', false);
        // plugin-b 仍持有
        expect(manager.isFeatureDisabled('memory')).toBe(true);
        expect(manager.listDisabledFeatures()).toEqual([{ id: 'memory', pluginIds: ['plugin-b'] }]);
    });

    test('监听器抛错不影响其它监听器与状态', () => {
        const notifications: string[] = [];
        manager.onFeaturesChanged(() => {
            throw new Error('listener failed');
        });
        manager.onFeaturesChanged(() => notifications.push('feature'));
        manager.setFeatureDisabled('memory', 'plugin-a', true);
        expect(notifications).toEqual(['feature']);
        expect(manager.isFeatureDisabled('memory')).toBe(true);
    });
});

describe('global feature manager singleton', () => {
    afterEach(() => {
        resetFeatureManagerForTests();
    });

    test('getFeatureManager 返回同一实例', () => {
        expect(getFeatureManager()).toBe(getFeatureManager());
    });

    test('resetFeatureManagerForTests 清空全局状态', () => {
        getFeatureManager().setFeatureDisabled('memory', 'plugin-a', true);
        expect(getFeatureManager().isFeatureDisabled('memory')).toBe(true);
        resetFeatureManagerForTests();
        expect(getFeatureManager().isFeatureDisabled('memory')).toBe(false);
    });

    test('resetForTests 同时清空监听器，避免测试间串味', () => {
        const notifications: string[] = [];
        getFeatureManager().onFeaturesChanged(() => notifications.push('feature'));
        resetFeatureManagerForTests();
        getFeatureManager().setFeatureDisabled('memory', 'plugin-a', true);
        expect(notifications).toEqual([]);
    });
});
