import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

describe('automation task detail next trigger', () => {
    let WidgetClass: CustomElementConstructor;
    let call: ReturnType<typeof jest.fn>;
    const widgets: any[] = [];

    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><head></head><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            Element: window.Element,
            HTMLInputElement: window.HTMLInputElement,
            HTMLTextAreaElement: window.HTMLTextAreaElement,
            HTMLSelectElement: window.HTMLSelectElement,
            Event: window.Event,
            customElements: window.customElements,
            requestAnimationFrame: (callback: FrameRequestCallback) => {
                callback(0);
                return 0;
            },
            cancelAnimationFrame: () => undefined
        });
        jest.unstable_mockModule('../../../main/applications/widget_utils.js', () => ({
            AgentOperableHTMLElement: class extends window.HTMLElement {}
        }));
        jest.unstable_mockModule('../../../renderer/components/workspacePicker.js', () => ({
            showWorkspacePicker: jest.fn()
        }));
        await import('../../../main/applications/todomgr/renderer/entry.js');
        WidgetClass = window.customElements.get('todomgr-entry-widget')!;
    });

    beforeEach(() => {
        call = jest.fn(async (method: unknown) => (method === 'listGlobalTodos' ? [] : undefined));
        (window as any).applicationAPI = { call, callMainWorld: jest.fn() };
    });

    afterEach(() => {
        for (const widget of widgets.splice(0)) widget.disconnectedCallback();
        jest.restoreAllMocks();
        jest.useRealTimers();
    });

    function todo(trigger: Record<string, unknown>, extra: Record<string, unknown> = {}): any {
        return {
            id: 'detail-next-run',
            title: 'Morning report',
            content: 'Prepare the report',
            priority: 'medium',
            enabled: true,
            trigger,
            created_at: '2025-12-01T00:00:00Z',
            updated_at: '2025-12-01T00:00:00Z',
            ...extra
        };
    }

    function widgetFor(plan?: any, locale = 'en-US'): any {
        const widget = new WidgetClass() as any;
        widgets.push(widget);
        widget._applyLocaleSetting({ locale });
        widget.globalTodos = plan ? [plan] : [];
        widget._cachedEvents = [];
        widget.render();
        if (plan) widget._openDetail(plan);
        return widget;
    }

    function localTime(iso: string): string {
        const d = new Date(iso);
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }

    function expectNextRunValue(widget: any, nextIso: string) {
        const value = widget.querySelector('#tm-detail-next-run')?.textContent ?? '';
        expect(value).toContain(localTime(nextIso));
        // 与上次触发格式一致：无年份、无时区标注
        expect(value).not.toContain('(');
        expect(value).not.toContain('2026');
    }

    test('explicit timezone recurrence shows the next trigger without year or timezone', () => {
        jest.useFakeTimers({ doNotFake: ['Intl'], now: new Date('2026-01-01T00:00:00Z') });
        const widget = widgetFor(
            todo({
                type: 'cron',
                cronExpression: '* * * * *',
                recurrence: { mode: 'daily', time: '23:59' },
                timezone: 'Asia/Shanghai'
            })
        );

        expectNextRunValue(widget, '2026-01-01T15:59:00Z');
    });

    test('legacy utc cron is computed in UTC and displayed in local time', () => {
        jest.useFakeTimers({ doNotFake: ['Intl'], now: new Date('2026-01-01T00:00:00Z') });
        const widget = widgetFor(todo({ type: 'cron', cronExpression: '30 9 * * *' }));

        expectNextRunValue(widget, '2026-01-01T09:30:00Z');
    });

    test('disabled tasks show the disabled hint', () => {
        jest.useFakeTimers({ doNotFake: ['Intl'], now: new Date('2026-01-01T00:00:00Z') });
        const widget = widgetFor(
            todo(
                {
                    type: 'cron',
                    cronExpression: '* * * * *',
                    recurrence: { mode: 'daily', time: '23:59' },
                    timezone: 'UTC'
                },
                { enabled: false }
            )
        );

        expect(widget.querySelector('#tm-detail-next-run')?.textContent).toBe('Disabled');
    });
});
