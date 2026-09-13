import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

describe('agentoffice progressive loading', () => {
    let WidgetClass: new () => HTMLElement;

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

    function createWidget(strings: Record<string, string> = { 'agentoffice.loading': 'Loading…' }): any {
        const widget = new WidgetClass() as any;
        widget.attachShadow({ mode: 'open' });
        widget.strings = strings;
        return widget;
    }

    function flushTasks(): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, 0));
    }

    test('the shell renders with a loading state before staff data arrives', async () => {
        const widget = createWidget();
        let resolveStaffs!: (value: unknown) => void;
        widget.call = jest.fn((method: string) => {
            if (method === 'getLocalizedStrings') return Promise.resolve(widget.strings);
            if (method === 'getLocale') return Promise.resolve('en-US');
            if (method === 'listChatModels') return Promise.resolve({ default_model: '', models: [] });
            if (method === 'listStaffs')
                return new Promise((resolve) => {
                    resolveStaffs = resolve;
                });
            return Promise.resolve(undefined);
        });

        const initialized = widget.initialize();
        await flushTasks();

        expect(widget.shadowRoot.querySelector('.tabs')).not.toBeNull();
        expect(widget.shadowRoot.querySelector('.empty')?.textContent).toContain('Loading…');
        expect(widget.shadowRoot.querySelector('.staff-list')).toBeNull();
        expect(widget.loading).toBe(true);

        resolveStaffs([]);
        await initialized;

        expect(widget.loading).toBe(false);
    });

    test('the staff list renders before portraits and chat history finish loading', async () => {
        const widget = createWidget();
        const staff = {
            id: 'staff-1',
            name: 'Ada',
            title: 'Analyst',
            specialties: [],
            enabled: true,
            skill_count: 0
        };
        let resolvePortraits!: () => void;
        let resolveHistory!: () => void;
        widget.preloadPortraits = () => new Promise<void>((resolve) => (resolvePortraits = resolve));
        widget.loadMessages = () => new Promise<void>((resolve) => (resolveHistory = resolve));
        widget.call = jest.fn((method: string) => {
            if (method === 'listStaffs') return Promise.resolve([staff]);
            return Promise.resolve(undefined);
        });

        const reloaded = widget.reloadStaffs();
        await flushTasks();

        expect(widget.loading).toBe(false);
        expect(widget.shadowRoot.querySelector('.staff-list')).not.toBeNull();
        expect(widget.shadowRoot.querySelector('.chat')).not.toBeNull();

        resolvePortraits();
        resolveHistory();
        await reloaded;

        expect(widget.shadowRoot.querySelector('.messages')).not.toBeNull();
    });

    test('background portrait completion does not re-render over an open modal', async () => {
        const widget = createWidget();
        const staff = {
            id: 'staff-1',
            name: 'Ada',
            title: 'Analyst',
            specialties: [],
            enabled: true,
            skill_count: 0
        };
        let resolvePortraits!: () => void;
        widget.preloadPortraits = () => new Promise<void>((resolve) => (resolvePortraits = resolve));
        widget.loadMessages = () => Promise.resolve();
        widget.call = jest.fn((method: string) => {
            if (method === 'listStaffs') return Promise.resolve([staff]);
            return Promise.resolve(undefined);
        });

        const reloaded = widget.reloadStaffs();
        await flushTasks();

        // 用户在加载窗口期打开头像编辑弹窗（含画布草稿状态）
        widget.modal = 'portrait';
        expect(widget.canRenderInBackground()).toBe(false);
        const htmlBefore = widget.shadowRoot.innerHTML;

        resolvePortraits();
        await reloaded;

        expect(widget.shadowRoot.innerHTML).toBe(htmlBefore);
        expect(widget.portraitCache.size).toBe(0);
    });

    test('chat history completion does not re-render over an open modal and shows after closing it', async () => {
        const widget = createWidget();
        const staff = {
            id: 'staff-1',
            name: 'Ada',
            title: 'Analyst',
            specialties: [],
            enabled: true,
            skill_count: 0
        };
        let resolveHistory!: (value: unknown) => void;
        widget.call = jest.fn((method: string) => {
            if (method === 'listStaffs') return Promise.resolve([staff]);
            if (method === 'getHistoryMessagesForUI')
                return new Promise((resolve) => {
                    resolveHistory = resolve;
                });
            return Promise.resolve(undefined);
        });

        const reloaded = widget.reloadStaffs();
        await flushTasks();

        widget.modal = 'portrait';
        const htmlBefore = widget.shadowRoot.innerHTML;

        resolveHistory({ messages: [], has_more: false });
        await reloaded;

        expect(widget.messages).toEqual([]);
        expect(widget.shadowRoot.innerHTML).toBe(htmlBefore);

        widget.closeModal();
        expect(widget.shadowRoot.querySelector('.messages')).not.toBeNull();
    });

    test('a failed initial load stops the loading state and reports the error', async () => {
        const widget = createWidget({
            'agentoffice.loading': 'Loading…',
            'agentoffice.loadFailed': 'Load failed',
            'agentoffice.tab.management': 'Management'
        });
        widget.activeTab = 'management';
        widget.call = jest.fn((method: string) => {
            if (method === 'getLocalizedStrings') return Promise.resolve(widget.strings);
            if (method === 'getLocale') return Promise.resolve('en-US');
            if (method === 'listChatModels') return Promise.resolve({ default_model: '', models: [] });
            if (method === 'listStaffs') return Promise.reject(new Error('worker unavailable'));
            return Promise.resolve(undefined);
        });

        await widget.initialize();

        expect(widget.loading).toBe(false);
        expect(widget.shadowRoot.querySelector('.notice')?.textContent).toContain('worker unavailable');
        expect(widget.shadowRoot.querySelector('.empty')?.textContent).not.toContain('Loading…');
    });
});
