import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

describe('automation content textarea sizing', () => {
    let Widget: CustomElementConstructor;
    const widgets: any[] = [];

    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><head></head><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            Element: window.Element,
            HTMLInputElement: window.HTMLInputElement,
            HTMLSelectElement: window.HTMLSelectElement,
            HTMLTextAreaElement: window.HTMLTextAreaElement,
            Event: window.Event,
            customElements: window.customElements,
            requestAnimationFrame: (callback: FrameRequestCallback) => {
                callback(0);
                return 0;
            },
            cancelAnimationFrame: () => undefined
        });
        Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', {
            get() {
                if (this.tagName === 'TEXTAREA') return parseFloat(this.style.height) || 56;
                const content = this.querySelector('#tm-edit-content');
                return this.classList.contains('tm-edit-field') && content ? content.offsetHeight + 22 : 0;
            },
            configurable: true
        });
        Object.defineProperty(window.HTMLTextAreaElement.prototype, 'clientHeight', {
            get() {
                return this.offsetHeight - 2;
            },
            configurable: true
        });
        Object.defineProperty(window.HTMLTextAreaElement.prototype, 'scrollHeight', {
            get() {
                return this.value.split('\n').length * 20 + 18;
            },
            configurable: true
        });
        jest.unstable_mockModule('../../../main/applications/widget_utils.js', () => ({
            AgentOperableHTMLElement: class extends window.HTMLElement {}
        }));
        jest.unstable_mockModule('../../../renderer/components/workspacePicker.js', () => ({
            showWorkspacePicker: jest.fn()
        }));
        await import('../../../main/applications/todomgr/renderer/entry.js');
        Widget = window.customElements.get('todomgr-entry-widget')!;
    });

    beforeEach(() => {
        (window as any).applicationAPI = {
            call: jest.fn(async () => []),
            callMainWorld: jest.fn(async () => []),
            unsubscribe: jest.fn()
        };
    });

    afterEach(() => {
        for (const widget of widgets.splice(0)) widget.disconnectedCallback();
    });

    async function editor(content = 'One line', initialHeight = 600) {
        const plan = {
            id: 'content-plan',
            title: 'Report',
            content,
            priority: 'medium',
            enabled: true,
            trigger: { type: 'scheduled', triggerAt: '2030-01-01T09:00:00.000Z', timezone: 'UTC' },
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z'
        };
        const widget = new Widget() as any;
        widgets.push(widget);
        widget._applyLocaleSetting({ locale: 'en-US' });
        widget._cachedEvents = [];
        widget.globalTodos = [plan];
        widget.render();
        const frame = widget.querySelector('#tm-detail-scroll');
        const height = initialHeight;
        Object.defineProperty(frame, 'clientHeight', { get: () => height, configurable: true });
        widget._openDetail(plan);
        await widget._enterEditMode(plan);
        const textarea = widget.querySelector('#tm-edit-content');
        return { widget, plan, frame, textarea };
    }

    function type(textarea: HTMLTextAreaElement, lines: number) {
        textarea.value = Array.from({ length: lines }, () => 'Report line').join('\n');
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }

    test('sizes existing multiline content immediately, including its borders', async () => {
        const { textarea } = await editor('First\nSecond\nThird');
        expect(textarea.getAttribute('rows')).toBe('1');
        expect(textarea.style.height).toBe('80px');
        expect(textarea.style.maxHeight).toBe('240px');
    });

    test('grows while typing, caps long content, and shrinks after deleting lines', async () => {
        const { textarea } = await editor();
        expect(textarea.style.height).toBe('56px');
        type(textarea, 4);
        expect(textarea.style.height).toBe('100px');
        type(textarea, 40);
        expect(textarea.style.height).toBe('240px');
        type(textarea, 1);
        expect(textarea.style.height).toBe('56px');
    });

    test('freezes the field during measurement and restores its previous minimum height', async () => {
        const { textarea, frame } = await editor();
        const field = textarea.closest('.tm-edit-field');
        field.style.minHeight = '12px';
        frame.scrollTop = 420;
        Object.defineProperty(textarea, 'scrollHeight', {
            get() {
                expect(field.style.minHeight).toBe('78px');
                expect(textarea.style.height).toBe('auto');
                return 118;
            },
            configurable: true
        });
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        expect(textarea.style.height).toBe('120px');
        expect(field.style.minHeight).toBe('12px');
        expect(frame.scrollTop).toBe(420);
    });
});
