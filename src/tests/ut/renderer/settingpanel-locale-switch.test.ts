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

    test('locale-select change 只保存，不本地立即切换（等新语言快照就位后统一刷新）', () => {
        const panel = createPanel('zh-CN');
        const originalTranslator = panel._t;
        panel.saveImmediately = jest.fn(async () => undefined);

        panel.render();
        panel.setUpEventListeners();

        const refreshAllSpy = jest.spyOn(panel, 'refreshAll');

        // Simulate locale change to English
        const localeSelect = panel.querySelector('#locale-select') as HTMLSelectElement;
        Object.defineProperty(localeSelect, 'value', {
            get: () => 'en-US',
            configurable: true
        });
        localeSelect.dispatchEvent(new Event('change'));

        // 只触发保存：此刻瘦身快照仍是旧语言的，本地立即切换会先回退英文（闪英文），
        // 等 main 推送新语言快照后的 onLocalePacksChanged 统一重建并刷新
        expect(panel.saveImmediately).toHaveBeenCalledTimes(1);
        expect(refreshAllSpy).not.toHaveBeenCalled();
        expect(panel._t).toBe(originalTranslator);

        // 面板文案保持旧语言
        const labels = getNavLabels(panel);
        expect(labels.some((l) => l.includes('模型设置'))).toBe(true);
        expect(labels.some((l) => l.includes('Models'))).toBe(false);
    });

    test('切到自动后 main 广播的权威 resolved_locale 纠正面板语言', () => {
        // 场景：面板 currentData.resolved_locale 滞留旧值（tr-TR），用户切到 auto，
        // main 解析结果为 en-US；sidebar 用广播对象所以生效，面板须同样跟随
        const settingChangedHandlers: Array<(data: unknown) => void> = [];
        window.settingAPI = {
            onSettingChanged: jest.fn((callback: (data: unknown) => void) => {
                settingChangedHandlers.push(callback);
                return () => undefined;
            })
        };

        const panel = createPanel('tr-TR');
        panel.currentData.locale = 'auto';
        panel.saveImmediately = jest.fn(async () => undefined);
        // linkedom 下元素未插入文档，伪造判活供订阅回调使用
        Object.defineProperty(panel, 'isConnected', { value: true, configurable: true });

        panel.render();
        panel.setUpEventListeners();
        panel._subscribeLocaleChanges();

        expect(settingChangedHandlers.length).toBe(1);
        const refreshAllSpy = jest.spyOn(panel, 'refreshAll');

        // main 广播权威解析结果 en-US（面板滞留值是 tr-TR）
        settingChangedHandlers[0]({ locale: 'auto', resolved_locale: 'en-US' });

        expect(panel.currentData.resolved_locale).toBe('en-US');
        expect(refreshAllSpy).toHaveBeenCalled();
        const labels = getNavLabels(panel);
        expect(labels.some((l) => l.includes('Models'))).toBe(true);
        expect(labels.some((l) => l.includes('模型设置'))).toBe(false);
    });

    test('语言字段未变的 setting:changed 广播不触发面板刷新', () => {
        const settingChangedHandlers: Array<(data: unknown) => void> = [];
        window.settingAPI = {
            onSettingChanged: jest.fn((callback: (data: unknown) => void) => {
                settingChangedHandlers.push(callback);
                return () => undefined;
            })
        };

        const panel = createPanel('zh-CN');
        panel.saveImmediately = jest.fn(async () => undefined);

        panel.render();
        panel.setUpEventListeners();
        panel._subscribeLocaleChanges();

        const refreshAllSpy = jest.spyOn(panel, 'refreshAll');
        // 无关配置项保存的广播：locale / resolved_locale 均未变化
        settingChangedHandlers[0]({ locale: 'zh-CN', resolved_locale: 'zh-CN', debug: { developer_mode: true } });

        expect(refreshAllSpy).not.toHaveBeenCalled();
    });
});
