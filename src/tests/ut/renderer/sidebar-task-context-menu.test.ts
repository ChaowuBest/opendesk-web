// jsdom/linkedom 环境下复现：长按/点击任务上下文菜单中的「开发者」子菜单项，
// 预期子菜单展开且整菜单保留，实际整个菜单被关闭。
import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

describe('sidebar task context menu submenu', () => {
    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            Element: window.Element,
            CustomEvent: window.CustomEvent,
            Event: window.Event,
            customElements: window.customElements,
            requestAnimationFrame: (fn: FrameRequestCallback) => setTimeout(() => fn(0), 0),
            MutationObserver: class {
                observe() {}
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
        } as any;
        window.taskManagerAPI = {
            getTaskList: async () => [],
            subscribeTaskListUpdate: async () => () => undefined,
            getTaskInfo: async () => ({})
        } as any;
        await import('../../../renderer/components/sidebar.js');
    });

    beforeEach(() => {
        document.body.innerHTML = '';
        document.documentElement.dataset.theme = 'light';
    });

    function createSidebar() {
        const sidebar = document.createElement('main-sidebar');
        document.body.appendChild(sidebar);
        return sidebar as any;
    }

    test('点击「开发者」子菜单项后菜单保留且子菜单展开', () => {
        const sidebar = createSidebar();
        sidebar._developerMode = true;

        sidebar._showContextMenu(100, 100, 'task_1');

        const menu = document.querySelector('#task-context-menu');
        expect(menu).not.toBeNull();

        const submenuBtn = menu!.querySelector('[data-submenu="1"]') as HTMLElement;
        expect(submenuBtn).not.toBeNull();
        submenuBtn.dispatchEvent(new (window as any).Event('click', { bubbles: true }));

        // 期望：菜单不被关闭，且子菜单展开
        expect(document.querySelector('#task-context-menu')).not.toBeNull();
        expect(submenuBtn.parentElement!.classList.contains('is-submenu-open')).toBe(true);
    });
});
