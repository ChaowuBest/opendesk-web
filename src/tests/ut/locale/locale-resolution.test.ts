import { resolveLocaleSetting, resolvePreferredLocale } from '../../../common/locale.js';
import { detectSystemLocale, getLocale, setRuntimePreferredSystemLanguages } from '../../../locale/index.js';
import { Setting } from '../../../main/utils/setting.js';

describe('locale resolution', () => {
    afterEach(() => {
        setRuntimePreferredSystemLanguages(null);
        Setting.clearCache();
    });

    test('maps simplified and traditional Chinese language tags to Chinese', () => {
        expect(resolvePreferredLocale(['zh-Hans-CN'])).toBe('zh-CN');
        expect(resolvePreferredLocale(['zh-Hant-TW'])).toBe('zh-CN');
        expect(resolvePreferredLocale(['zh-TW'])).toBe('zh-CN');
        expect(resolvePreferredLocale(['zh_CN'])).toBe('zh-CN');
    });

    test('maps non-Chinese primary languages to English', () => {
        expect(resolvePreferredLocale(['en-US'])).toBe('en-US');
        expect(resolvePreferredLocale(['fr-CA'])).toBe('en-US');
        expect(resolvePreferredLocale(['ja-JP', 'zh-Hans-CN'])).toBe('en-US');
        expect(resolvePreferredLocale([])).toBe('en-US');
    });

    test('explicit locale setting overrides system preference', () => {
        expect(resolveLocaleSetting('zh-CN', ['en-US'])).toBe('zh-CN');
        expect(resolveLocaleSetting('en-US', ['zh-Hant-TW'])).toBe('en-US');
        expect(resolveLocaleSetting('auto', ['zh-Hant-HK'])).toBe('zh-CN');
    });

    test('runtime preferred languages override process locale detection', () => {
        setRuntimePreferredSystemLanguages(['zh-Hant-TW']);
        expect(detectSystemLocale()).toBe('zh-CN');

        setRuntimePreferredSystemLanguages(['fr-FR']);
        expect(detectSystemLocale()).toBe('en-US');
    });

    test('auto setting uses runtime preferred languages after worker setting sync', () => {
        Setting.updateInstanceData({ locale: 'auto' });

        setRuntimePreferredSystemLanguages(['zh-Hant-TW']);
        expect(getLocale()).toBe('zh-CN');

        setRuntimePreferredSystemLanguages(['fr-FR']);
        expect(getLocale()).toBe('en-US');
    });
});
