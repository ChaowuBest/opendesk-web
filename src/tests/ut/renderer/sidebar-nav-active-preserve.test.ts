import { beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { parseHTML } from 'linkedom';

/**
 * 侧边栏底部导航（记忆/文件系统/设置/个人中心）的激活态必须扛得住重渲染。
 *
 * 回归场景：拖动侧边栏宽度 → 防抖 300ms 后保存 gui_config.sidebar_width →
 * 主进程广播 setting:changed → 侧边栏 _updateLocalizedChrome() → 底部工具栏
 * setButtons() 整体重建按钮（用于跟随界面语言文案）。重建时若丢掉 active 标记，
 * 当前页高亮就会在拖动宽度后凭空消失，直到用户再次切换视图才恢复。
 */
describe('侧边栏底部导航激活态', () => {
    let sidebar: HTMLElement & {
        _updateNavActive: (view: string | null, appBundle?: string | null) => void;
        _updateLocalizedChrome: () => void;
    };

    const findNavButton = (id: string) => sidebar.querySelector<HTMLElement>(`[id^="${id}-"]`);

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
        window.taskManagerAPI = {
            getTaskList: async () => [],
            subscribeTaskListUpdate: async () => () => undefined,
            log: () => undefined
        } as never;
        window.applicationRegistryAPI = {
            getApplicationList: async () => [],
            call: async () => undefined,
            callMainWorld: async () => undefined,
            subscribeEvent: async () => () => undefined,
            onApplicationListChanged: () => () => undefined
        } as never;
        window.settingAPI = {
            loadSettingObject: async () => ({}),
            onSettingChanged: () => () => undefined
        } as never;
        await import('../../../renderer/components/sidebar.js');
    });

    beforeEach(() => {
        document.body.innerHTML = '';
        sidebar = document.createElement('main-sidebar') as typeof sidebar;
        document.body.appendChild(sidebar);
    });

    it('切换视图后当前页按钮带激活态', () => {
        sidebar._updateNavActive('setting');
        expect(findNavButton('open-setting-editor-btn')?.classList.contains('navbar-active')).toBe(true);
    });

    it('设置保存触发的重渲染（拖动侧边栏宽度的副作用）保留激活态', () => {
        sidebar._updateNavActive('setting');

        // setting:changed → 侧边栏按新文案重建底部工具栏按钮
        sidebar._updateLocalizedChrome();

        expect(findNavButton('open-setting-editor-btn')?.classList.contains('navbar-active')).toBe(true);
        // 其他按钮不应被误标成激活
        expect(findNavButton('open-memory-btn')?.classList.contains('navbar-active')).toBe(false);
    });

    it('切到别的视图后激活态随之迁移', () => {
        sidebar._updateNavActive('setting');
        sidebar._updateLocalizedChrome();
        sidebar._updateNavActive('memory');
        sidebar._updateLocalizedChrome();

        expect(findNavButton('open-memory-btn')?.classList.contains('navbar-active')).toBe(true);
        expect(findNavButton('open-setting-editor-btn')?.classList.contains('navbar-active')).toBe(false);
    });
});
