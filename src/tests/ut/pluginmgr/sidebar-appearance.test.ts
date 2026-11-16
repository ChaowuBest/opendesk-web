import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

describe('sidebar appearance capability branding', () => {
    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            CustomEvent: window.CustomEvent,
            Event: window.Event,
            customElements: window.customElements,
            MutationObserver: class {
                observe() {}
                disconnect() {}
            },
            ResizeObserver: class {
                observe() {}
                unobserve() {}
                disconnect() {}
            },
            localStorage: {
                getItem: () => null,
                setItem: () => undefined,
                removeItem: () => undefined
            }
        });
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            writable: true,
            value: { language: 'zh-CN', languages: ['zh-CN'] }
        });
        window.applicationRegistryAPI = {
            getApplicationList: async () => [],
            call: async () => undefined,
            callMainWorld: async () => undefined,
            subscribeEvent: async () => () => undefined
        };
        window.taskManagerAPI = {
            getTaskList: async () => [],
            subscribeTaskListUpdate: async () => () => undefined
        };
        await import('../../../renderer/components/sidebar.js');
    });

    beforeEach(() => {
        document.body.innerHTML = '';
    });

    function createSidebar() {
        const sidebar = document.createElement('main-sidebar');
        document.body.appendChild(sidebar);
        return sidebar;
    }

    test('未注入外观覆盖时品牌区保持默认 OpenDesk、默认标语与主题 Logo', () => {
        const sidebar = createSidebar();
        expect(sidebar.querySelector('#sidebar-banner').textContent).toBe('OpenDesk');
        expect(sidebar.querySelector('[data-sidebar-subtitle]').textContent).toBe('一站式智慧办公空间');
        expect(sidebar.querySelector('#sidebar-icon').getAttribute('src')).toBe('./images/icon_round.png');
    });

    test('外观覆盖生效后品牌区显示自定义标题与 Logo', () => {
        const sidebar = createSidebar();
        sidebar._applyAppearance({
            appTitle: 'My Custom App',
            appLogoUrl: 'data:image/png;base64,aGVsbG8='
        });
        expect(sidebar.querySelector('#sidebar-banner').textContent).toBe('My Custom App');
        expect(sidebar.querySelector('#sidebar-icon').getAttribute('src')).toBe('data:image/png;base64,aGVsbG8=');
        expect(sidebar.querySelector('#sidebar-icon-collapsed').getAttribute('src')).toBe(
            'data:image/png;base64,aGVsbG8='
        );
    });

    test('描述覆盖生效后副标题显示自定义文案，未覆盖时回退默认标语', () => {
        const sidebar = createSidebar();
        sidebar._applyAppearance({
            appTitle: 'MyDesk',
            appDescription: '自定义描述文案'
        });
        expect(sidebar.querySelector('#sidebar-banner').textContent).toBe('MyDesk');
        expect(sidebar.querySelector('[data-sidebar-subtitle]').textContent).toBe('自定义描述文案');

        // 仅设置标题时描述回退默认标语
        sidebar._applyAppearance({ appTitle: 'MyDesk' });
        expect(sidebar.querySelector('#sidebar-banner').textContent).toBe('MyDesk');
        expect(sidebar.querySelector('[data-sidebar-subtitle]').textContent).toBe('一站式智慧办公空间');
    });

    test('自定义 Logo 不随暗色主题回退', () => {
        const sidebar = createSidebar();
        sidebar._applyAppearance({ appLogoUrl: 'data:image/png;base64,aGVsbG8=' });
        document.documentElement.dataset.theme = 'dark';
        sidebar._updateBannerForTheme();
        expect(sidebar.querySelector('#sidebar-icon').getAttribute('src')).toBe('data:image/png;base64,aGVsbG8=');
    });

    test('主题变体 Logo 按当前主题选用，切换主题即时跟随', () => {
        const sidebar = createSidebar();
        sidebar._applyAppearance({
            appLogoDarkUrl: 'data:image/png;base64,ZGFyaw==',
            appLogoLightUrl: 'data:image/png;base64,bGlnaHQ='
        });
        document.documentElement.dataset.theme = 'light';
        sidebar._updateBannerForTheme();
        expect(sidebar.querySelector('#sidebar-icon').getAttribute('src')).toBe('data:image/png;base64,bGlnaHQ=');

        document.documentElement.dataset.theme = 'dark';
        sidebar._updateBannerForTheme();
        expect(sidebar.querySelector('#sidebar-icon').getAttribute('src')).toBe('data:image/png;base64,ZGFyaw==');
        expect(sidebar.querySelector('#sidebar-icon-collapsed').getAttribute('src')).toBe(
            'data:image/png;base64,ZGFyaw=='
        );
    });

    test('主题变体缺省一侧时回退到单图形式，再回退到默认 Logo', () => {
        const sidebar = createSidebar();
        // 变体只有暗色时亮色回退单图
        sidebar._applyAppearance({
            appLogoUrl: 'data:image/png;base64,c2luZ2xl',
            appLogoDarkUrl: 'data:image/png;base64,ZGFyaw=='
        });
        document.documentElement.dataset.theme = 'dark';
        sidebar._updateBannerForTheme();
        expect(sidebar.querySelector('#sidebar-icon').getAttribute('src')).toBe('data:image/png;base64,ZGFyaw==');
        document.documentElement.dataset.theme = 'light';
        sidebar._updateBannerForTheme();
        expect(sidebar.querySelector('#sidebar-icon').getAttribute('src')).toBe('data:image/png;base64,c2luZ2xl');

        // 完全没有自定义 Logo 时回退默认主题图
        sidebar._applyAppearance(undefined);
        document.documentElement.dataset.theme = 'light';
        sidebar._updateBannerForTheme();
        expect(sidebar.querySelector('#sidebar-icon').getAttribute('src')).toBe('./images/icon_round.png');
    });

    test('未覆盖标题时暗色主题仍使用暗色默认 Logo', () => {
        const sidebar = createSidebar();
        sidebar._applyAppearance(undefined);
        document.documentElement.dataset.theme = 'dark';
        sidebar._updateBannerForTheme();
        expect(sidebar.querySelector('#sidebar-banner').textContent).toBe('OpenDesk');
        expect(sidebar.querySelector('#sidebar-icon').getAttribute('src')).toBe('./images/icon_round_dark.png');
    });

    test('重挂载重新渲染时自定义标题与描述被转义，不注入 HTML', () => {
        const sidebar = createSidebar();
        const hostile = '<img src=x onerror=alert(1)>';
        sidebar._applyAppearance({ appTitle: hostile, appDescription: hostile });
        // 断开再重连触发 connectedCallback -> render()，验证模板插值走转义
        sidebar.remove();
        document.body.appendChild(sidebar);
        const banner = sidebar.querySelector('#sidebar-banner');
        expect(banner.textContent).toBe(hostile);
        expect(banner.querySelector('img')).toBeNull();
        expect(sidebar.querySelector('#sidebar-icon').getAttribute('alt')).toBe(hostile);
        const subtitle = sidebar.querySelector('[data-sidebar-subtitle]');
        expect(subtitle.textContent).toBe(hostile);
        expect(subtitle.querySelector('img')).toBeNull();
    });
});
