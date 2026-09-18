import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

/**
 * 守卫：composer 的输入草稿必须跨整树重渲染保留
 * （后台 staffsChanged 等事件会触发 render()，不能吞掉用户正在输入的内容）。
 */
describe('agentoffice composer draft persistence', () => {
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
        (window as any).applicationAPI = { subscribe: jest.fn(), unsubscribe: jest.fn() };
        if (!(window.HTMLElement.prototype as any).getBoundingClientRect) {
            (window.HTMLElement.prototype as any).getBoundingClientRect = () => ({
                left: 0,
                top: 0,
                right: 200,
                bottom: 120,
                width: 200,
                height: 120
            });
        }

        const module = await import('../../../main/applications/agentoffice/renderer/entry.js');
        WidgetClass = module.AgentOfficeEntryWidget;
    });

    const staff = {
        id: 'staff-1',
        name: 'Ada',
        title: 'Analyst',
        specialties: [],
        enabled: true,
        skill_count: 0
    };

    function createWidget(): any {
        const widget = new WidgetClass() as any;
        widget.attachShadow({ mode: 'open' });
        widget.strings = {
            'agentoffice.tab.office': 'Office',
            'agentoffice.tab.management': 'Staff Management',
            'agentoffice.noMessages': 'No messages'
        };
        widget.staffs = [staff];
        widget.selectedStaffId = 'staff-1';
        widget.messages = [];
        return widget;
    }

    test('composer draft survives a full re-render', () => {
        const widget = createWidget();
        widget.render();
        const first = widget.shadowRoot.querySelector('#message-input') as HTMLTextAreaElement;
        first.value = 'hello draft';
        first.setSelectionRange?.(5, 5);
        widget.render();
        const second = widget.shadowRoot.querySelector('#message-input') as HTMLTextAreaElement;
        expect(second.value).toBe('hello draft');
    });

    test('empty composer stays empty across renders', () => {
        const widget = createWidget();
        widget.render();
        widget.render();
        expect((widget.shadowRoot.querySelector('#message-input') as HTMLTextAreaElement).value).toBe('');
    });

    test('re-render preserves send-button active state for a non-empty draft', () => {
        const widget = createWidget();
        widget.render();
        const input = widget.shadowRoot.querySelector('#message-input') as HTMLTextAreaElement;
        input.value = 'hello draft';
        widget.render();
        const send = widget.shadowRoot.querySelector('.composer-send-btn') as HTMLElement;
        expect(send.className).toContain('composer-send-active');
    });
});
