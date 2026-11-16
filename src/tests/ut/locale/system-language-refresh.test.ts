import { describe, expect, test, afterEach } from '@jest/globals';
import {
    queryLatestPreferredSystemLanguages,
    refreshRuntimePreferredSystemLanguages
} from '../../../main/utils/system-language-refresh.js';
import {
    getLocale,
    getRuntimePreferredSystemLanguages,
    setRuntimePreferredSystemLanguages
} from '../../../locale/index.js';
import { Setting } from '../../../main/utils/setting.js';

describe('system language refresh', () => {
    afterEach(() => {
        setRuntimePreferredSystemLanguages(null);
        Setting.clearCache();
    });

    test('auto setting: language change updates cache and requests broadcast', async () => {
        Setting.updateInstanceData({ locale: 'auto' });
        setRuntimePreferredSystemLanguages(['zh-Hans', 'en-Latn-US']);
        expect(getLocale()).toBe('zh-CN');

        const outcome = await refreshRuntimePreferredSystemLanguages(async () => ['en-Latn-US', 'zh-Hans']);

        expect(outcome.languageChanged).toBe(true);
        expect(outcome.shouldBroadcast).toBe(true);
        expect(getRuntimePreferredSystemLanguages()).toEqual(['en-Latn-US', 'zh-Hans']);
        expect(getLocale()).toBe('en-US');
    });

    test('list shape change with same resolved locale is not a language change', async () => {
        Setting.updateInstanceData({ locale: 'auto' });
        setRuntimePreferredSystemLanguages(['zh-Hans', 'en-Latn-US']);

        const outcome = await refreshRuntimePreferredSystemLanguages(async () => ['zh-Hans-CN']);

        expect(outcome.languageChanged).toBe(false);
        expect(outcome.shouldBroadcast).toBe(false);
    });

    test('first refresh only warms the cache without broadcast', async () => {
        Setting.updateInstanceData({ locale: 'auto' });
        expect(getRuntimePreferredSystemLanguages()).toBeNull();

        const outcome = await refreshRuntimePreferredSystemLanguages(async () => ['zh-Hans-CN']);

        expect(outcome.languageChanged).toBe(false);
        expect(outcome.shouldBroadcast).toBe(false);
        expect(getRuntimePreferredSystemLanguages()).toEqual(['zh-Hans-CN']);
        expect(getLocale()).toBe('zh-CN');
    });

    test('explicit available locale setting: system language change updates cache but effective locale is unchanged', async () => {
        Setting.updateInstanceData({ locale: 'zh-CN' });
        setRuntimePreferredSystemLanguages(['zh-Hans']);

        const outcome = await refreshRuntimePreferredSystemLanguages(async () => ['en-Latn-US']);

        // 生效语言不随系统语言变化：不广播
        expect(outcome.languageChanged).toBe(false);
        expect(outcome.shouldBroadcast).toBe(false);
        // 缓存仍更新为最新系统语言
        expect(getRuntimePreferredSystemLanguages()).toEqual(['en-Latn-US']);
        expect(getLocale()).toBe('zh-CN');
    });

    test('unavailable explicit locale (uninstalled pack residue) resolves via system language and requests broadcast', async () => {
        // 'tr-TR' 不在可用集合（内置 zh-CN/en-US，未注册语言包）：等同 auto 按系统语言解析
        Setting.updateInstanceData({ locale: 'tr-TR' });
        setRuntimePreferredSystemLanguages(['zh-Hans']);
        expect(getLocale()).toBe('zh-CN');

        const outcome = await refreshRuntimePreferredSystemLanguages(async () => ['en-Latn-US']);

        expect(outcome.languageChanged).toBe(true);
        expect(outcome.shouldBroadcast).toBe(true);
        expect(getRuntimePreferredSystemLanguages()).toEqual(['en-Latn-US']);
        expect(getLocale()).toBe('en-US');
    });

    test('empty refresh result keeps the previous cache and does not report change', async () => {
        Setting.updateInstanceData({ locale: 'auto' });
        setRuntimePreferredSystemLanguages(['zh-Hans']);

        const outcome = await refreshRuntimePreferredSystemLanguages(async () => []);

        expect(outcome.languageChanged).toBe(false);
        expect(outcome.shouldBroadcast).toBe(false);
        expect(getRuntimePreferredSystemLanguages()).toEqual(['zh-Hans']);
        expect(getLocale()).toBe('zh-CN');
    });

    test('queryLatestPreferredSystemLanguages degrades gracefully without bridge and electron', async () => {
        // 测试环境无 ohos bridge、无 electron app：应返回空列表而不是抛错
        const languages = await queryLatestPreferredSystemLanguages();
        expect(Array.isArray(languages)).toBe(true);
    });
});
