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
        jest.useRealTimers();
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

    test.each([undefined, 'UTC'])(
        'editing a multi-date rule with timezone %s preserves every saved date',
        async (timezone) => {
            mockSystemTimezone('UTC');
            const plan = todo({ type: 'cron', cronExpression: '0 9 1,15 * *', ...(timezone ? { timezone } : {}) });
            const widget = widgetFor(plan);
            await widget._enterEditMode(plan);

            expect(widget.querySelector('#tm-frequency-period-trigger').disabled).toBe(false);
            expect(widget._timeSchedulePicker.getTrigger()).toEqual(plan.trigger);
            select(widget, '#tm-cron-hour', '10');
            await widget._saveEdit(plan);
            expect(call).toHaveBeenCalledWith(
                'updateGlobalTodo',
                plan.id,
                expect.objectContaining({
                    trigger: {
                        type: 'cron',
                        cronExpression: '* * * * *',
                        timezone: 'UTC',
                        recurrence: { mode: 'monthly', time: '10:00', days: [1, 15] }
                    }
                })
            );
        }
    );

    test.each([
        ['15 23 31 * *', 'Day 31 of every month at 23:15', false],
        ['17 9 1 * 1', 'Saved advanced rule (UTC)', true],
        ['0 9-17 * * 1-5', 'Saved advanced rule (UTC)', true]
    ])(
        'legacy recurring expression %s keeps its UTC wall clock and preserves its schedule when edited and saved',
        async (cronExpression, summary, legacyDisabled) => {
            mockSystemTimezone('Asia/Shanghai');
            const plan = todo({ type: 'cron', cronExpression });
            const widget = widgetFor(plan);
            await widget._enterEditMode(plan);

            // 旧 cron 未存时区：编辑页如实显示 UTC 墙钟，而不是换算成系统时区。
            expect(widget.querySelector('#tm-edit-timezone')?.value).toBe('UTC');
            expect(widget.querySelector('#tm-cron-preview')?.textContent).toContain(summary);
            expect(widget.querySelector('#tm-frequency-period-trigger')?.disabled).toBe(legacyDisabled);
            await widget._saveEdit(plan);

            expect(call).toHaveBeenCalledWith(
                'updateGlobalTodo',
                plan.id,
                expect.objectContaining({ trigger: plan.trigger })
            );
        }
    );

    test('legacy daily UTC rule: cards show local time, the editor keeps UTC, and a title edit preserves the schedule', async () => {
        mockSystemTimezone('Asia/Shanghai');
        const plan = todo({ type: 'cron', cronExpression: '30 9 * * *' });
        const widget = widgetFor(plan);
        expect(widget.querySelector('.tm-todo-card')?.textContent).toContain('Daily at 17:30 (Asia/Shanghai)');
        expect(widget.querySelector('#tm-detail-scroll')?.textContent).toContain('Daily at 17:30 (Asia/Shanghai)');
        await widget._enterEditMode(plan);
        // 编辑页显示规则本身的 UTC 墙钟，时区下拉如实标 UTC。
        expect(widget.querySelector('#tm-edit-timezone')?.value).toBe('UTC');
        expect(widget.querySelector('#tm-cron-hour')?.value).toBe('9');
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

    test.each([
        ['2026-01-15T12:00:00Z', 'Daily at 04:30 (America/New_York)'],
        ['2026-07-15T12:00:00Z', 'Daily at 05:30 (America/New_York)']
    ])('a legacy recurrence converts using the offset on %s', (date, summary) => {
        jest.useFakeTimers({ doNotFake: ['Intl'] });
        jest.setSystemTime(new Date(date));
        mockSystemTimezone('America/New_York');
        const trigger = { type: 'cron', cronExpression: '* * * * *', recurrence: { mode: 'daily', time: '09:30' } };
        const plan = todo(trigger);
        const widget = widgetFor(plan);

        expect(widget.querySelector('.tm-todo-card')?.textContent).toContain(summary);
        expect(widget.querySelector('#tm-detail-scroll')?.textContent).toContain(summary);
        expect(plan.trigger).toEqual(trigger);
    });

    test('legacy weekly UTC time keeps its wall clock and weekday, and a timezone change reinterprets them without converting', async () => {
        mockSystemTimezone('Asia/Kathmandu');
        const plan = todo({ type: 'cron', cronExpression: '45 23 * * 6' });
        const widget = widgetFor(plan);
        expect(widget.querySelector('.tm-todo-card')?.textContent).toContain('Every Sun at 05:30 (Asia/Kathmandu)');
        await widget._enterEditMode(plan);
        // 不再跨日换算：墙钟与星期原样（UTC 23:45 周六）。
        expect(widget.querySelector('#tm-edit-timezone')?.value).toBe('UTC');
        expect(widget.querySelector('#tm-cron-hour')?.value).toBe('23');
        expect(widget.querySelector('#tm-cron-minute')?.value).toBe('45');
        expect(widget.querySelector('[data-days-toggle="period"]')?.textContent).toContain('Sat');
        // 改时区：墙钟数字不变，保存仅落库新时区（同一墙钟重新解释）。
        select(widget, '#tm-edit-timezone', 'Asia/Kathmandu');
        expect(widget.querySelector('#tm-cron-hour')?.value).toBe('23');
        expect(widget.querySelector('#tm-cron-minute')?.value).toBe('45');
        expect(widget.querySelector('[data-days-toggle="period"]')?.textContent).toContain('Sat');
        await widget._saveEdit(plan);
        expect(call).toHaveBeenCalledWith(
            'updateGlobalTodo',
            plan.id,
            expect.objectContaining({ trigger: { ...plan.trigger, timezone: 'Asia/Kathmandu' } })
        );
    });

    test('legacy UTC rule in a DST zone keeps its UTC wall clock, and a timezone change saves the new zone without converting', async () => {
        mockSystemTimezone('America/New_York');
        const plan = todo({ type: 'cron', cronExpression: '30 9 * * *' });
        const widget = widgetFor(plan);
        await widget._enterEditMode(plan);
        expect(widget.querySelector('#tm-edit-timezone')?.value).toBe('UTC');
        expect(widget.querySelector('#tm-cron-preview')?.textContent).toBe('Daily at 09:30 (UTC)');
        expect(widget.querySelector('#tm-frequency-period-trigger')?.disabled).toBe(false);
        select(widget, '#tm-edit-timezone', 'America/New_York');
        // 预览与落库一致：墙钟不变，仅时区标签更新。
        expect(widget.querySelector('#tm-cron-preview')?.textContent).toBe('Daily at 09:30 (America/New_York)');
        await widget._saveEdit(plan);
        expect(call).toHaveBeenCalledWith(
            'updateGlobalTodo',
            plan.id,
            expect.objectContaining({ trigger: { ...plan.trigger, timezone: 'America/New_York' } })
        );
    });

    test('editing the UTC wall clock of a legacy rule saves the requested new schedule in the editor timezone', async () => {
        mockSystemTimezone('Asia/Shanghai');
        const plan = todo({ type: 'cron', cronExpression: '30 9 * * *' });
        const widget = widgetFor(plan);
        await widget._enterEditMode(plan);
        select(widget, '#tm-cron-hour', '18');
        await widget._saveEdit(plan);
        // 未改时区（初始 UTC）：新规则落在 UTC。
        expect(call).toHaveBeenCalledWith(
            'updateGlobalTodo',
            plan.id,
            expect.objectContaining({
                trigger: {
                    type: 'cron',
                    cronExpression: '* * * * *',
                    timezone: 'UTC',
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
