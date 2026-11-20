import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const requireNative = jest.fn<(name: string) => unknown>();
jest.unstable_mockModule('module', () => ({ createRequire: () => requireNative }));
jest.unstable_mockModule('../../../main/utils/setting.js', () => ({
    Setting: { getInstance: () => ({ data: { locale: 'auto' } }) }
}));
const { detectSystemLocale, setRuntimePreferredSystemLanguages } = await import('../../../locale/index.js');
const electronVersion = Object.getOwnPropertyDescriptor(process.versions, 'electron');

describe('locale detection respects the Electron process boundary', () => {
    beforeEach(() => {
        requireNative.mockReset();
        requireNative.mockImplementation((name) => {
            if (name === 'electron')
                return { app: { isReady: () => true, getPreferredSystemLanguages: () => ['zh-CN'] } };
            return {};
        });
        setRuntimePreferredSystemLanguages(null);
        jest.spyOn(Intl, 'DateTimeFormat').mockImplementation(
            () => ({ resolvedOptions: () => ({ locale: 'en-US' }) }) as Intl.DateTimeFormat
        );
        delete (process.versions as Record<string, string | undefined>).electron;
    });
    afterEach(() => {
        if (electronVersion) Object.defineProperty(process.versions, 'electron', electronVersion);
        else delete (process.versions as Record<string, string | undefined>).electron;
        setRuntimePreferredSystemLanguages(null);
        jest.restoreAllMocks();
    });

    test('a Node or Bun process never loads the Electron package during system locale detection', () => {
        expect(detectSystemLocale()).toBe('en-US');
        expect(requireNative).not.toHaveBeenCalledWith('electron');
    });

    test('an Electron main process keeps its preferred-system-language detection', () => {
        Object.defineProperty(process.versions, 'electron', { value: '39.2.6', configurable: true });
        expect(detectSystemLocale()).toBe('zh-CN');
        expect(requireNative).toHaveBeenCalledWith('electron');
    });

    test('an Electron worker without app access safely uses the ordinary locale fallback', () => {
        Object.defineProperty(process.versions, 'electron', { value: '39.2.6', configurable: true });
        requireNative.mockReturnValue({});
        expect(detectSystemLocale()).toBe('en-US');
    });

    test('host-injected language preferences take priority without loading platform modules', () => {
        setRuntimePreferredSystemLanguages(['zh-Hant-TW']);
        expect(detectSystemLocale()).toBe('zh-CN');
        expect(requireNative).not.toHaveBeenCalled();
    });
});
