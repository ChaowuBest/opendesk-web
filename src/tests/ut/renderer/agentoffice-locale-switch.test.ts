import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

/**
 * agentoffice 双语跟随：设置界面切换语言后（主进程广播 setting:changed），
 * 办公室界面须重拉主进程文案并按新语言重建界面，与其他子应用共用
 * settingAPI.onSettingChanged 的同一传播模式。
 * 详情表单/弹窗打开时推迟整体重渲染，避免丢草稿（与后台刷新同策略）。
 */
describe('agentoffice locale switching', () => {
    let WidgetClass: new () => HTMLElement;

    const enStrings: Record<string, string> = {
        'agentoffice.loading': 'Loading…',
        'agentoffice.tab.office': 'Office',
        'agentoffice.tab.management': 'Staff Management'
    };
    const zhStrings: Record<string, string> = {
        'agentoffice.loading': '加载中…',
        'agentoffice.tab.office': '办公室',
        'agentoffice.tab.management': '员工管理'
    };

    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            Element: window.Element,
            HTMLInputElement: window.HTMLInputElement,
            HTMLTextAreaElement: window.HTMLTextAreaElement,
            HTMLSelectElement: window.HTMLSelectElement,
            CustomEvent: window.CustomEvent,
            Event: window.Event,
            customElements: window.customElements,
            requestAnimationFrame: (callback: FrameRequestCallback) => {
                callback(0);
                return 0;
            },
            cancelAnimationFrame: () => undefined
        });
        (window as any).applicationAPI = {
            subscribe: jest.fn(),
            unsubscribe: jest.fn()
        };

        const module = await import('../../../main/applications/agentoffice/renderer/entry.js');
        WidgetClass = module.AgentOfficeEntryWidget;
    });

    function flushTasks(): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, 0));
    }

    /** 不走真实 DOM 插入（linkedom 生命周期不完整），直接伪造 isConnected 供事件回调判活 */
    function createWidget(strings: Record<string, string>, locale: string): any {
        const widget = new WidgetClass() as any;
        widget.attachShadow({ mode: 'open' });
        Object.defineProperty(widget, 'isConnected', { value: true, configurable: true });
        widget.strings = strings;
        widget.locale = locale;
        widget.render();
        return widget;
    }

    function installSettingBroadcast(): { handler: (setting: unknown) => void; unsubscribe: () => void } {
        const state: { handler?: (setting: unknown) => void } = {};
        const unsubscribe = jest.fn();
        (window as any).settingAPI = {
            onSettingChanged: jest.fn((callback: (setting: unknown) => void) => {
                state.handler = callback;
                return unsubscribe;
            })
        };
        return {
            get handler() {
                return state.handler!;
            },
            unsubscribe
        };
    }

    test('a locale change broadcast re-fetches strings and rebuilds the UI', async () => {
        const broadcast = installSettingBroadcast();
        const widget = createWidget(enStrings, 'en-US');
        widget.call = jest.fn((method: string) => {
            if (method === 'getLocalizedStrings') return Promise.resolve(zhStrings);
            if (method === 'getLocale') return Promise.resolve('zh-CN');
            return Promise.resolve(undefined);
        });

        expect(widget.shadowRoot.querySelector('.empty')?.textContent).toContain('Loading…');

        widget.subscribeSettingChanges();
        broadcast.handler({ locale: 'zh-CN', resolved_locale: 'zh-CN' });
        await flushTasks();

        expect(widget.call).toHaveBeenCalledWith('getLocalizedStrings');
        expect(widget.call).toHaveBeenCalledWith('getLocale');
        expect(widget.locale).toBe('zh-CN');
        const emptyText = widget.shadowRoot.querySelector('.empty')?.textContent ?? '';
        expect(emptyText).toContain('加载中…');
        expect(emptyText).not.toContain('Loading…');
    });

    test('broadcasts that resolve to the current locale do not trigger a re-fetch', async () => {
        const broadcast = installSettingBroadcast();
        const widget = createWidget(enStrings, 'en-US');
        widget.call = jest.fn(() => Promise.resolve(undefined));

        widget.subscribeSettingChanges();
        // auto 模式下主进程解析结果不变（resolved_locale 仍为 en-US）
        broadcast.handler({ locale: 'auto', resolved_locale: 'en-US' });
        await flushTasks();

        expect(widget.call).not.toHaveBeenCalledWith('getLocalizedStrings');
    });

    test('an open modal defers the rebuild and new strings apply once it closes', async () => {
        const broadcast = installSettingBroadcast();
        const widget = createWidget(enStrings, 'en-US');
        widget.call = jest.fn((method: string) => {
            if (method === 'getLocalizedStrings') return Promise.resolve(zhStrings);
            if (method === 'getLocale') return Promise.resolve('zh-CN');
            return Promise.resolve(undefined);
        });

        widget.subscribeSettingChanges();
        widget.modal = 'portrait';
        const htmlBefore = widget.shadowRoot.innerHTML;

        broadcast.handler({ locale: 'zh-CN', resolved_locale: 'zh-CN' });
        await flushTasks();

        // 文案表已更新但整树未重建：弹窗草稿状态保留
        expect(widget.locale).toBe('zh-CN');
        expect(widget.shadowRoot.innerHTML).toBe(htmlBefore);

        widget.closeModal();
        expect(widget.shadowRoot.querySelector('.empty')?.textContent).toContain('加载中…');
    });

    test('rapid toggles while a refresh is in flight converge to the latest locale', async () => {
        const broadcast = installSettingBroadcast();
        const widget = createWidget(enStrings, 'en-US');
        // 模拟主进程状态：第一次取词时是 zh-CN，第二次切换保存后变为 en-US
        let mainLocale = 'zh-CN';
        widget.call = jest.fn((method: string) => {
            if (method === 'getLocalizedStrings')
                return Promise.resolve(mainLocale === 'zh-CN' ? zhStrings : enStrings);
            if (method === 'getLocale') return Promise.resolve(mainLocale);
            return Promise.resolve(undefined);
        });

        widget.subscribeSettingChanges();
        broadcast.handler({ locale: 'zh-CN', resolved_locale: 'zh-CN' });
        // 在途窗口内用户切回英文：此广播与 this.locale 相同，若不排队会被误判重而丢失
        mainLocale = 'en-US';
        broadcast.handler({ locale: 'en-US', resolved_locale: 'en-US' });
        await flushTasks();

        expect(widget.locale).toBe('en-US');
        expect(widget.shadowRoot.querySelector('.empty')?.textContent).toContain('Loading…');
        expect(widget.shadowRoot.querySelector('.empty')?.textContent).not.toContain('加载中…');
    });

    test('skips subscribing while the element is not connected', () => {
        installSettingBroadcast();
        // 未附加到文档的真实 isConnected 为 false：初始化期间断连的元素不得建立订阅（否则泄漏监听器）
        const widget = new WidgetClass() as any;
        widget.attachShadow({ mode: 'open' });
        widget.call = jest.fn(() => Promise.resolve(undefined));

        widget.subscribeSettingChanges();

        expect((window as any).settingAPI.onSettingChanged).not.toHaveBeenCalled();
        expect(widget.settingUnsubscribe).toBeUndefined();
    });

    test('disconnectedCallback unsubscribes and the widget can subscribe again', () => {
        const broadcast = installSettingBroadcast();
        const widget = createWidget(enStrings, 'en-US');
        widget.call = jest.fn(() => Promise.resolve(undefined));

        widget.subscribeSettingChanges();
        widget.disconnectedCallback();
        expect(broadcast.unsubscribe).toHaveBeenCalledTimes(1);

        widget.subscribeSettingChanges();
        expect((window as any).settingAPI.onSettingChanged).toHaveBeenCalledTimes(2);
    });
});
