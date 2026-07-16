import { jest } from '@jest/globals';
import { parseHTML } from 'linkedom';

describe('desktop sidebar layout', () => {
    beforeEach(() => {
        const { window, document } = parseHTML(`
            <div id="app-root">
                <splitter-widget></splitter-widget>
                <main-sidebar id="main-sidebar"></main-sidebar>
                <button id="expand-sidebar-btn" class="sidebar-expand-rail" hidden></button>
            </div>
        `);
        const storage = new Map<string, string>();
        Object.assign(globalThis, {
            window,
            document,
            HTMLElement: window.HTMLElement,
            customElements: window.customElements,
            CustomEvent: window.CustomEvent,
            Event: window.Event,
            localStorage: {
                getItem: (key: string) => storage.get(key) ?? null,
                setItem: (key: string, value: string) => storage.set(key, value)
            },
            navigator: { language: 'zh-CN', languages: ['zh-CN'] }
        });
        (window as any).settingAPI = undefined;
    });

    test('collapses from the sidebar request and expands from the rail button', async () => {
        const { initializeSidebarLayout } = await import('../../../renderer/sidebarLayout.js');
        const splitter = document.querySelector('splitter-widget') as HTMLElement & {
            setCollapsed: jest.Mock;
        };
        splitter.setCollapsed = jest.fn();

        const controller = initializeSidebarLayout();
        const appRoot = document.getElementById('app-root')!;
        const sidebar = document.getElementById('main-sidebar')!;
        const expandButton = document.getElementById('expand-sidebar-btn')!;

        document.dispatchEvent(
            new CustomEvent('sidebar-collapse-request', {
                detail: { collapsed: true },
                bubbles: true
            })
        );

        expect(splitter.setCollapsed).toHaveBeenLastCalledWith(true);
        expect(appRoot.classList.contains('sidebar-collapsed')).toBe(true);
        expect(sidebar.hasAttribute('data-collapsed')).toBe(true);
        expect(expandButton.hidden).toBe(false);

        expandButton.click();

        expect(splitter.setCollapsed).toHaveBeenLastCalledWith(false);
        expect(appRoot.classList.contains('sidebar-collapsed')).toBe(false);
        expect(sidebar.hasAttribute('data-collapsed')).toBe(false);
        expect(expandButton.hidden).toBe(true);
        controller?.destroy();
    });

    test('splitter keeps its configured width while collapsed', async () => {
        await import('../../../renderer/components/splitter.js');
        const splitter = document.createElement('splitter-widget') as HTMLElement & {
            setCollapsed: (collapsed: boolean) => void;
            isCollapsed: () => boolean;
            _startResize: () => void;
            _stopResize: () => void;
            shadowRoot: ShadowRoot;
        };
        splitter.setAttribute('initial-width', '376');
        document.body.appendChild(splitter);

        splitter.setCollapsed(true);
        expect(splitter.isCollapsed()).toBe(true);
        expect(splitter.getAttribute('aria-expanded')).toBe('false');

        splitter.setCollapsed(false);
        const leftPanel = splitter.shadowRoot.getElementById('leftPanel') as HTMLElement;
        expect(splitter.isCollapsed()).toBe(false);
        expect(leftPanel.style.width).toBe('376px');

        splitter._startResize();
        expect(splitter.hasAttribute('resizing')).toBe(true);
        splitter._stopResize();
        expect(splitter.hasAttribute('resizing')).toBe(false);
    });
});
