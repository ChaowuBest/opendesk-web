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

        // 记录菜单 DOM 被移除时的调用栈，定位关闭者
        const origRemove = (window.Element.prototype as any).remove;
        let removeStack: string | null = null;
        (window.Element.prototype as any).remove = function () {
            if (this.id === 'task-context-menu') {
                removeStack = new Error().stack || '';
            }
            return origRemove.call(this);
        };

        // 记录菜单创建期间注册的监听器
        const added: Array<{ el: any; type: string; capture: boolean }> = [];
        const origAdd = (window.HTMLElement.prototype as any).addEventListener;
        (window.HTMLElement.prototype as any).addEventListener = function (type: string, listener: any, opts: any) {
            added.push({
                el: this,
                type,
                capture: typeof opts === 'object' ? !!opts?.capture : !!opts
            });
            return origAdd.call(this, type, listener, opts);
        };

        try {
            sidebar._showContextMenu(100, 100, 'task_1');
        } finally {
            (window.HTMLElement.prototype as any).addEventListener = origAdd;
        }

        const menu = document.querySelector('#task-context-menu');
        expect(menu).not.toBeNull();
        console.log(
            '[diag] capture click listeners registered during menu build:',
            JSON.stringify(
                added
                    .filter((r) => r.type === 'click' && r.capture)
                    .map((r) => ({ tag: r.el.tagName, id: r.el.id, inMenu: menu!.contains(r.el) }))
            )
        );

        const submenuBtn = menu!.querySelector('[data-submenu="1"]') as HTMLElement;
        expect(submenuBtn).not.toBeNull();
        submenuBtn.dispatchEvent(new (window as any).Event('click', { bubbles: true }));

        console.log('[diag] remove stack after submenu click:\n' + (removeStack ?? '(menu not removed)'));

        // 期望：菜单不被关闭，且子菜单展开
        expect(document.querySelector('#task-context-menu')).not.toBeNull();
        expect(submenuBtn.parentElement!.classList.contains('is-submenu-open')).toBe(true);
    });
});
