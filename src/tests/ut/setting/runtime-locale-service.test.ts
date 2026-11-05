import { describe, expect, jest, test } from '@jest/globals';
import { RuntimeLocaleService } from '../../../main/applications/settings/locale.js';

function createService(locale = 'auto') {
    let settings = { locale, theme: 'dark' };
    const applyPreferredSystemLanguages = jest.fn<(...args: unknown[]) => void>();
    const notifyWorkers = jest.fn<(...args: unknown[]) => Promise<void>>(async () => undefined);
    const broadcastSettings = jest.fn<(...args: unknown[]) => void>();
    const service = new RuntimeLocaleService({
        getSettings: () => settings,
        preferredSystemLanguages: ['en-US'],
        applyPreferredSystemLanguages,
        notifyWorkers,
        broadcastSettings
    });
    return {
        service,
        setSettings: (next: typeof settings) => (settings = next),
        getSettings: () => settings,
        applyPreferredSystemLanguages,
        notifyWorkers,
        broadcastSettings
    };
}

describe('runtime locale service', () => {
    test('host changes update runtime state, worker and renderer without changing persisted settings', async () => {
        const fixture = createService();

        expect(await fixture.service.handleSystemLanguagesChanged(['zh-Hant-TW'])).toBe(true);

        expect(fixture.getSettings()).toEqual({ locale: 'auto', theme: 'dark' });
        expect(fixture.applyPreferredSystemLanguages).toHaveBeenLastCalledWith(['zh-Hant-TW']);
        expect(fixture.notifyWorkers).toHaveBeenCalledWith(
            { locale: 'auto', theme: 'dark' },
            { preferredSystemLanguages: ['zh-Hant-TW'] }
        );
        expect(fixture.broadcastSettings).toHaveBeenCalledWith({
            locale: 'auto',
            theme: 'dark',
            resolved_locale: 'zh-CN'
        });
        expect(await fixture.service.handleSystemLanguagesChanged(['zh-CN'])).toBe(false);
        expect(fixture.service.getSnapshot().preferredSystemLanguages).toEqual(['zh-CN']);
        expect(fixture.broadcastSettings).toHaveBeenCalledTimes(1);
        expect(fixture.notifyWorkers).toHaveBeenCalledTimes(1);
    });

    test('fixed language is stable and a later auto setting uses the newest host preferences', async () => {
        const fixture = createService('en-US');

        expect(await fixture.service.handleSystemLanguagesChanged(['zh-CN'])).toBe(false);
        expect(fixture.broadcastSettings).not.toHaveBeenCalled();
        expect(fixture.notifyWorkers).not.toHaveBeenCalled();
        fixture.setSettings({ locale: 'auto', theme: 'dark' });
        fixture.service.handleSettingChanged();

        expect(fixture.broadcastSettings).toHaveBeenCalledTimes(1);
        expect(fixture.broadcastSettings).toHaveBeenLastCalledWith({
            locale: 'auto',
            theme: 'dark',
            resolved_locale: 'zh-CN'
        });
        expect(fixture.service.getSnapshot().preferredSystemLanguages).toEqual(['zh-CN']);
    });

    test('late old worker acknowledgements never republish an old language', async () => {
        const fixture = createService();
        let releaseOld!: () => void;
        fixture.notifyWorkers.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    releaseOld = resolve;
                })
        );
        const older = fixture.service.handleSystemLanguagesChanged(['zh-CN']);
        await fixture.service.handleSystemLanguagesChanged(['en-US']);
        releaseOld();
        await older;

        expect(fixture.service.getSnapshot()).toMatchObject({ locale: 'en-US', revision: 2 });
        expect(fixture.broadcastSettings.mock.calls.map(([settings]) => (settings as any).resolved_locale)).toEqual([
            'zh-CN',
            'en-US'
        ]);
    });

    test('worker failures remain observable without rolling back the current runtime snapshot', async () => {
        const fixture = createService();
        fixture.notifyWorkers.mockRejectedValueOnce(new Error('worker offline'));

        await expect(fixture.service.handleSystemLanguagesChanged(['zh-CN'])).rejects.toThrow('worker offline');

        expect(fixture.service.getSnapshot()).toMatchObject({ locale: 'zh-CN', revision: 1 });
        expect(fixture.broadcastSettings).toHaveBeenCalledTimes(1);
        expect(await fixture.service.handleSystemLanguagesChanged(['zh-CN'])).toBe(false);
        expect(fixture.notifyWorkers).toHaveBeenCalledTimes(2);
        expect(fixture.broadcastSettings).toHaveBeenCalledTimes(1);
        expect(await fixture.service.handleSystemLanguagesChanged(['zh-CN'])).toBe(false);
        expect(fixture.notifyWorkers).toHaveBeenCalledTimes(2);
    });

    test('an old worker success cannot discard a newer failed sync pending retry', async () => {
        const fixture = createService();
        let releaseOld!: () => void;
        fixture.notifyWorkers.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    releaseOld = resolve;
                })
        );
        fixture.notifyWorkers.mockRejectedValueOnce(new Error('worker offline'));
        const older = fixture.service.handleSystemLanguagesChanged(['zh-CN']);
        await expect(fixture.service.handleSystemLanguagesChanged(['en-US'])).rejects.toThrow('worker offline');
        releaseOld();
        await older;

        expect(await fixture.service.handleSystemLanguagesChanged(['en-US'])).toBe(false);
        expect(fixture.notifyWorkers).toHaveBeenCalledTimes(3);
        expect(fixture.notifyWorkers).toHaveBeenLastCalledWith(
            { locale: 'auto', theme: 'dark' },
            { preferredSystemLanguages: ['en-US'] }
        );
        expect(fixture.broadcastSettings).toHaveBeenCalledTimes(2);
    });
});
