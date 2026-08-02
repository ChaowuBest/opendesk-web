import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { createRendererTranslator } from '../../../renderer/locale.ts';

describe('setting-panel locale switch', () => {
    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            CustomEvent: window.CustomEvent,
            Event: window.Event,
            customElements: window.customElements,
            requestAnimationFrame: (callback: FrameRequestCallback) => {
                callback(0);
                return 0;
            },
            cancelAnimationFrame: () => undefined
        });
        Object.defineProperty(globalThis, 'navigator', {
            value: { languages: ['zh-CN'], language: 'zh-CN' },
            configurable: true
        });

        await import('../../../renderer/components/settingpanel.js');
    });

    beforeEach(() => {
        document.body.innerHTML = '';
        window.notificationAPI = {
            sendNotification: jest.fn(async () => undefined)
        };
    });

    function createPanel(locale: string = 'zh-CN') {
        const panel = document.createElement('setting-panel') as any;
        panel.currentData = {
            locale,
            resolved_locale: locale,
            gui_config: {},
            debug: {},
            environ: {},
            applications: {},
            providers: [],
            models: []
        };
        panel.gatewayHostOptions = [
            { value: 'none', label: '无' },
            { value: '127.0.0.1', label: '127.0.0.1' }
        ];
        panel._t = createRendererTranslator(panel.currentData);
        // linkedom <select>.value is read-only; stub out to avoid TypeError
        panel.updateDefaultModelSelects = jest.fn();
        return panel;
    }

    function getNavLabels(panel: any): string[] {
        return Array.from(panel.querySelectorAll('.sp-nav-item[data-tab]')).map(
            (btn: Element) => btn.textContent?.trim() || ''
        );
    }

    test('refreshAll updates sidebar tab labels after language switch to English', () => {
        const panel = createPanel('zh-CN');

        panel.render();

        // Initial labels should be Chinese
        const zhLabels = getNavLabels(panel);
        expect(zhLabels.some((l) => l.includes('模型设置'))).toBe(true);
        expect(zhLabels.some((l) => l.includes('任务设置'))).toBe(true);
        expect(zhLabels.some((l) => l.includes('通用设置'))).toBe(true);

        // Switch translator to English and refresh all
        panel.currentData.locale = 'en-US';
        panel.currentData.resolved_locale = 'en-US';
        panel._t = createRendererTranslator(panel.currentData);
        panel.refreshAll();

        // After refreshAll, labels should be English
        const enLabels = getNavLabels(panel);
        expect(enLabels.some((l) => l.includes('Models'))).toBe(true);
        expect(enLabels.some((l) => l.includes('Tasks'))).toBe(true);
        expect(enLabels.some((l) => l.includes('General'))).toBe(true);

        // Old Chinese labels should be gone
        expect(enLabels.some((l) => l.includes('模型设置'))).toBe(false);
        expect(enLabels.some((l) => l.includes('任务设置'))).toBe(false);
    });

    test('refreshAll updates header title and footer after language switch', () => {
        const panel = createPanel('zh-CN');

        panel.render();

        // Initial header should be Chinese
        expect(panel.querySelector('.sp-header-title')?.textContent?.trim()).toBe('设置');
        expect(panel.querySelector('.sp-footer-link')?.textContent?.trim()).toBe('隐私协议');

        // Switch to English
        panel.currentData.locale = 'en-US';
        panel.currentData.resolved_locale = 'en-US';
        panel._t = createRendererTranslator(panel.currentData);
        panel.refreshAll();

        // After refreshAll, header and footer should be English
        expect(panel.querySelector('.sp-header-title')?.textContent?.trim()).toBe('Settings');
        expect(panel.querySelector('.sp-footer-link')?.textContent?.trim()).toBe('Privacy Policy');
    });

    test('refreshAll updates sidebar labels when switching from English back to Chinese', () => {
        const panel = createPanel('en-US');

        panel.render();

        // Initial labels should be English
        const enLabels = getNavLabels(panel);
        expect(enLabels.some((l) => l.includes('Models'))).toBe(true);

        // Switch to Chinese
        panel.currentData.locale = 'zh-CN';
        panel.currentData.resolved_locale = 'zh-CN';
        panel._t = createRendererTranslator(panel.currentData);
        panel.refreshAll();

        // After refreshAll, labels should be Chinese
        const zhLabels = getNavLabels(panel);
        expect(zhLabels.some((l) => l.includes('模型设置'))).toBe(true);
        expect(zhLabels.some((l) => l.includes('任务设置'))).toBe(true);
    });

    test('refreshAll preserves the active tab', () => {
        const panel = createPanel('zh-CN');

        panel.render();

        // Navigate to Tasks tab
        panel._switchTab('tasks');
        expect(panel.querySelector('#tab-tasks')?.classList.contains('hidden')).toBe(false);
        expect(panel.querySelector('#tab-models')?.classList.contains('hidden')).toBe(true);

        // Switch language via refreshAll
        panel.currentData.locale = 'en-US';
        panel.currentData.resolved_locale = 'en-US';
        panel._t = createRendererTranslator(panel.currentData);
        panel.refreshAll();

        // After refreshAll, Tasks tab should still be active
        expect(panel.querySelector('#tab-tasks')?.classList.contains('hidden')).toBe(false);
        expect(panel.querySelector('#tab-models')?.classList.contains('hidden')).toBe(true);
    });

    test('locale-select change handler triggers refreshAll (not just refreshGeneralSection)', () => {
        const panel = createPanel('zh-CN');
        panel.saveImmediately = jest.fn(async () => {
            panel.currentData.resolved_locale = 'en-US';
            return undefined;
        });

        panel.render();
        panel.setUpEventListeners();

        // Spy on refreshAll
        const refreshAllSpy = jest.spyOn(panel, 'refreshAll');

        // Simulate locale change to English
        const localeSelect = panel.querySelector('#locale-select') as HTMLSelectElement;
        Object.defineProperty(localeSelect, 'value', {
            get: () => 'en-US',
            configurable: true
        });
        localeSelect.dispatchEvent(new Event('change'));

        // refreshAll should have been called (synchronously, before save)
        expect(refreshAllSpy).toHaveBeenCalled();

        // Nav labels should be in English now
        const enLabels = getNavLabels(panel);
        expect(enLabels.some((l) => l.includes('Models'))).toBe(true);
        expect(enLabels.some((l) => l.includes('模型设置'))).toBe(false);
    });
});
