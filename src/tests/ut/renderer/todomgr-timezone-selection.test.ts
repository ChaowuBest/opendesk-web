import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

describe('automation task timezone selection', () => {
    let WidgetClass: CustomElementConstructor;
    let call: ReturnType<typeof jest.fn>;

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
        jest.restoreAllMocks();
    });

    function mockSystemTimezone(timeZone: string) {
        const options = new Intl.DateTimeFormat().resolvedOptions();
        jest.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ ...options, timeZone });
    }

    function todo(trigger: Record<string, unknown>): any {
        return {
            id: 'timezone-plan',
            title: 'Timezone report',
            content: 'Prepare the report',
            priority: 'medium',
            enabled: true,
            trigger,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z'
        };
    }

    function widgetFor(plan?: any, locale = 'en-US'): any {
        const widget = new WidgetClass() as any;
        widget._applyLocaleSetting({ locale });
        widget.globalTodos = plan ? [plan] : [];
        widget._cachedEvents = [];
        widget.render();
        if (plan) widget._openDetail(plan);
        return widget;
    }

    function select(widget: any, selector: string, value: string) {
        const element = widget.querySelector(selector);
        for (const option of element.querySelectorAll('option')) option.removeAttribute('selected');
        element.querySelector(`option[value="${value}"]`).setAttribute('selected', '');
        element.dispatchEvent(new Event('change', { bubbles: true }));
    }

    test('cards and details show recurring wall time and its IANA timezone', () => {
        const widget = widgetFor(todo({ type: 'cron', cronExpression: '30 9 * * *', timezone: 'Asia/Kolkata' }));

        expect(widget.querySelector('.tm-todo-card')?.textContent).toContain('9:30');
        expect(widget.querySelector('.tm-todo-card')?.textContent).toContain('Asia/Kolkata');
        expect(widget.querySelector('#tm-detail-scroll')?.textContent).toContain('Asia/Kolkata');
    });

    test('editing an explicit recurring timezone preserves wall time without converting the expression', async () => {
        const plan = todo({ type: 'cron', cronExpression: '30 9 * * 1,3', timezone: 'Asia/Kolkata' });
        const widget = widgetFor(plan);
        await widget._enterEditMode(plan);

        expect(widget.querySelector('#tm-edit-timezone')?.value).toBe('Asia/Kolkata');
        expect(widget.querySelector('#tm-cron-hour')?.value).toBe('9');
        expect(widget.querySelector('#tm-cron-preview')?.textContent).toContain('Asia/Kolkata');
        await widget._saveEdit(plan);

        expect(call).toHaveBeenCalledWith(
            'updateGlobalTodo',
            plan.id,
            expect.objectContaining({ trigger: plan.trigger })
        );
    });

    test.each([
        ['15 23 31 * *', '07:15(+1)'],
        ['17 9 1 * 1', '17:17'],
        ['0 9-17 * * 1-5', 'Saved advanced rule (UTC)']
    ])(
        'legacy recurring expression %s preserves its UTC schedule when edited and saved',
        async (cronExpression, summary) => {
            mockSystemTimezone('Asia/Shanghai');
            const plan = todo({ type: 'cron', cronExpression });
            const widget = widgetFor(plan);
            await widget._enterEditMode(plan);

            expect(widget.querySelector('#tm-edit-timezone')?.value).toBe('Asia/Shanghai');
            expect(widget.querySelector('#tm-cron-preview')?.textContent).toContain(summary);
            expect(widget.querySelector('#tm-frequency-period-trigger')?.disabled).toBe(true);
            await widget._saveEdit(plan);

            expect(call).toHaveBeenCalledWith(
                'updateGlobalTodo',
                plan.id,
                expect.objectContaining({ trigger: plan.trigger })
            );
        }
    );

    test('legacy daily UTC time displays locally and saving a title edit preserves its schedule', async () => {
        mockSystemTimezone('Asia/Shanghai');
        const plan = todo({ type: 'cron', cronExpression: '30 9 * * *' });
        const widget = widgetFor(plan);
        expect(widget.querySelector('.tm-todo-card')?.textContent).toContain('17:30');
        expect(widget.querySelector('#tm-detail-scroll')?.textContent).toContain('17:30');
        await widget._enterEditMode(plan);
        expect(widget.querySelector('#tm-edit-timezone')?.value).toBe('Asia/Shanghai');
        expect(widget.querySelector('#tm-cron-hour')?.value).toBe('17');
        expect(widget.querySelector('#tm-cron-minute')?.value).toBe('30');
        expect(widget.querySelector('#tm-edit-timezone-field .tm-model-effort-note')).toBeNull();
        widget.querySelector('#tm-edit-title').value = 'Renamed';
        await widget._saveEdit(plan);
        expect(call).toHaveBeenCalledWith(
            'updateGlobalTodo',
            plan.id,
            expect.objectContaining({ title: 'Renamed', trigger: plan.trigger })
        );
    });

    test('legacy weekly UTC time converts minutes and weekday across midnight without changing its schedule', async () => {
        mockSystemTimezone('Asia/Kathmandu');
        const plan = todo({ type: 'cron', cronExpression: '45 23 * * 6' });
        const widget = widgetFor(plan);
        await widget._enterEditMode(plan);
        expect(widget.querySelector('#tm-cron-hour')?.value).toBe('5');
        expect(widget.querySelector('#tm-cron-minute')?.value).toBe('30');
        expect(widget.querySelector('[data-days-toggle="period"]')?.textContent).toContain('Sun');
        select(widget, '#tm-edit-timezone', 'UTC');
        expect(widget.querySelector('#tm-cron-hour')?.value).toBe('23');
        expect(widget.querySelector('#tm-cron-minute')?.value).toBe('45');
        expect(widget.querySelector('[data-days-toggle="period"]')?.textContent).toContain('Sat');
        await widget._saveEdit(plan);
        expect(call).toHaveBeenCalledWith(
            'updateGlobalTodo',
            plan.id,
            expect.objectContaining({ trigger: plan.trigger })
        );
    });

    test('legacy UTC rules in DST zones show seasonal times and preserve their execution rule', async () => {
        mockSystemTimezone('America/New_York');
        const plan = todo({ type: 'cron', cronExpression: '30 9 * * *' });
        const widget = widgetFor(plan);
        await widget._enterEditMode(plan);
        expect(widget.querySelector('#tm-cron-preview')?.textContent).toBe(
            'Daily at 09:30 (UTC) → 04:30, 05:30 (America/New_York)'
        );
        expect(widget.querySelector('#tm-frequency-period-trigger')?.disabled).toBe(true);
        await widget._saveEdit(plan);
        expect(call).toHaveBeenCalledWith(
            'updateGlobalTodo',
            plan.id,
            expect.objectContaining({ trigger: plan.trigger })
        );
    });

    test('editing a converted local execution time saves the requested new schedule', async () => {
        mockSystemTimezone('Asia/Shanghai');
        const plan = todo({ type: 'cron', cronExpression: '30 9 * * *' });
        const widget = widgetFor(plan);
        await widget._enterEditMode(plan);
        select(widget, '#tm-cron-hour', '18');
        await widget._saveEdit(plan);
        expect(call).toHaveBeenCalledWith(
            'updateGlobalTodo',
            plan.id,
            expect.objectContaining({
                trigger: {
                    type: 'cron',
                    cronExpression: '* * * * *',
                    timezone: 'Asia/Shanghai',
                    recurrence: { mode: 'daily', time: '18:30' }
                }
            })
        );
    });

    test('new recurring tasks default to the system IANA timezone and changing zone keeps entered wall time', async () => {
        const widget = widgetFor();
        await widget._enterEditMode(null, 'cron');

        expect(widget.querySelector('#tm-edit-timezone')?.value).toBe(
            Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
        );
        select(widget, '#tm-edit-timezone', 'America/New_York');
        expect(widget.querySelector('#tm-cron-hour')?.value).toBe('9');
        expect(widget.querySelector('#tm-cron-preview')?.textContent).toContain('America/New_York');
    });

    test('one-time tasks display and save the date in their selected timezone', async () => {
        const plan = todo({ type: 'scheduled', triggerAt: '2030-01-01T00:15:00.000Z', timezone: 'America/New_York' });
        const widget = widgetFor(plan);
        await widget._enterEditMode(plan);

        expect([widget._dtYear, widget._dtMonth, widget._dtDay, widget._dtHour, widget._dtMinute]).toEqual([
            2029, 12, 31, 19, 15
        ]);
        expect(widget.querySelector('#tm-dt-display-text')?.textContent).toContain('America/New_York');
        await widget._saveEdit(plan);

        expect(call).toHaveBeenCalledWith(
            'updateGlobalTodo',
            plan.id,
            expect.objectContaining({ trigger: plan.trigger })
        );
    });

    test('an untouched one-time draft preserves seconds and the second occurrence of a DST overlap', async () => {
        const plan = todo({ type: 'scheduled', triggerAt: '2030-11-03T06:37:42.000Z', timezone: 'America/New_York' });
        const widget = widgetFor(plan);
        await widget._enterEditMode(plan);

        expect(widget.querySelector('#tm-dt-minute')?.value).toBe('37');
        await widget._saveEdit(plan);

        expect(call).toHaveBeenCalledWith(
            'updateGlobalTodo',
            plan.id,
            expect.objectContaining({ trigger: plan.trigger })
        );
    });

    test('changing the timezone of a one-time task keeps wall time and updates the UTC instant', async () => {
        const plan = todo({ type: 'scheduled', triggerAt: '2030-01-01T00:15:00.000Z', timezone: 'America/New_York' });
        const widget = widgetFor(plan);
        await widget._enterEditMode(plan);
        select(widget, '#tm-edit-timezone', 'UTC');
        await widget._saveEdit(plan);

        expect(call).toHaveBeenCalledWith(
            'updateGlobalTodo',
            plan.id,
            expect.objectContaining({
                trigger: { type: 'scheduled', triggerAt: '2029-12-31T19:15:00.000Z', timezone: 'UTC' }
            })
        );
    });

    test.each([
        ['en-US', 'does not exist'],
        ['zh-CN', '不存在']
    ])('rejects a daylight saving gap with localized feedback (%s)', async (locale, message) => {
        const plan = todo({ type: 'scheduled', triggerAt: '2030-03-10T06:30:00.000Z', timezone: 'America/New_York' });
        const widget = widgetFor(plan, locale);
        await widget._enterEditMode(plan);
        widget._dtYear = 2030;
        widget._dtMonth = 3;
        widget._dtDay = 10;
        widget._dtHour = 2;
        widget._dtMinute = 30;

        await widget._saveEdit(plan);

        expect(call).not.toHaveBeenCalledWith('updateGlobalTodo', expect.anything(), expect.anything());
        expect(widget.querySelector('#tm-edit-error')?.textContent).toContain(message);
    });
});
