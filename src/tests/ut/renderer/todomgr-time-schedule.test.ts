import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { getNextTodoRecurrenceRuns } from '../../../main/applications/todomgr/todo-recurrence.js';

describe('automation period and interval picker', () => {
    let Widget: CustomElementConstructor;
    let call: ReturnType<typeof jest.fn>;

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
        Object.assign(window, { innerWidth: 1280, innerHeight: 800 });
        window.HTMLElement.prototype.focus = () => undefined;
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
        call = jest.fn(async (method: unknown) => (method === 'listGlobalTodos' ? [] : undefined));
        (window as any).applicationAPI = { call, callMainWorld: jest.fn(async () => []) };
    });

    async function editor(trigger?: any, locale = 'en-US'): Promise<{ widget: any; plan: any }> {
        const plan = trigger
            ? {
                  id: 'plan-1',
                  title: 'Daily report',
                  content: 'Prepare the report',
                  priority: 'medium',
                  enabled: true,
                  trigger,
                  created_at: '2026-01-01T00:00:00Z',
                  updated_at: '2026-01-01T00:00:00Z'
              }
            : null;
        const widget = new Widget() as any;
        widget._applyLocaleSetting({ locale });
        widget._cachedEvents = [];
        widget.globalTodos = plan ? [plan] : [];
        widget.render();
        if (plan) widget._openDetail(plan);
        await widget._enterEditMode(plan, 'scheduled');
        if (!plan) {
            widget.querySelector('#tm-edit-title').value = 'Daily report';
            widget.querySelector('#tm-edit-content').value = 'Prepare the report';
        }
        return { widget, plan };
    }

    function change(widget: any, selector: string, value: string) {
        const element = widget.querySelector(selector);
        if (element.tagName === 'SELECT') {
            for (const option of element.querySelectorAll('option')) option.removeAttribute('selected');
            element.querySelector(`option[value="${value}"]`).setAttribute('selected', '');
        } else element.value = value;
        element.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function choosePeriod(widget: any, mode: string) {
        widget.querySelector('#tm-frequency-period-trigger').click();
        widget.querySelector(`[data-period-mode="${mode}"]`).click();
    }

    function createdTrigger(): any {
        return call.mock.calls.find((args: any[]) => args[0] === 'addGlobalTodo')?.[5];
    }

    function selectCalendar(widget: any, kind: 'dates' | 'months', value: number, selected = true) {
        const input = widget.querySelector(`[data-calendar-kind="${kind}"][data-calendar-value="${value}"]`);
        input.checked = selected;
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function selectWeekday(widget: any, scope: 'period' | 'interval', day: number, selected: boolean) {
        const input = widget.querySelector(`[data-weekday="${day}"][data-day-scope="${scope}"]`);
        input.checked = selected;
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    test('provides period and interval tabs with exactly the six requested cycle modes', async () => {
        const { widget } = await editor();
        expect(widget.querySelector('#tm-frequency-period-tab').getAttribute('aria-selected')).toBe('true');
        expect(widget.querySelector('#tm-frequency-interval-tab')).not.toBeNull();
        expect(
            Array.from(widget.querySelectorAll('[data-period-mode]')).map((element: any) => element.dataset.periodMode)
        ).toEqual(['once', 'daily', 'weekly', 'biweekly', 'monthly', 'yearly']);
        expect(widget.querySelector('#tm-cron-custom-input')).toBeNull();
        expect(widget.querySelector('#tm-detail-scroll').textContent).not.toMatch(/cron/i);
    });

    test.each([
        ['daily', { mode: 'daily', time: '09:00' }],
        ['weekly', { mode: 'weekly', time: '09:00', weekdays: [1, 2, 3, 4, 5] }],
        ['monthly', { mode: 'monthly', time: '09:00', days: [1] }],
        ['yearly', { mode: 'yearly', time: '09:00', months: [1], days: [1] }]
    ])('persists the %s period', async (mode, recurrence) => {
        const { widget } = await editor();
        choosePeriod(widget, mode as string);
        if (mode === 'weekly') for (const day of [1, 2, 3, 4, 5]) selectWeekday(widget, 'period', day, true);
        if (mode === 'monthly') selectCalendar(widget, 'dates', 1, true);
        if (mode === 'yearly') {
            selectCalendar(widget, 'months', 1, true);
            selectCalendar(widget, 'dates', 1, true);
        }
        await widget._saveEdit(null);
        expect(createdTrigger()).toMatchObject({ type: 'cron', recurrence });
    });

    test('does not prefill weekday, date, or month selections for a new recurring task', async () => {
        const { widget } = await editor();
        for (const [mode, selector] of [
            ['weekly', '#tm-frequency-period-day-options'],
            ['monthly', '#tm-frequency-dates-options'],
            ['yearly', '#tm-frequency-months-options']
        ]) {
            choosePeriod(widget, mode);
            const menu = widget.querySelector(selector);
            expect(menu.querySelectorAll('input:checked')).toHaveLength(0);
            expect(menu.querySelector('[data-select-all], [data-calendar-select-all]').checked).toBe(false);
            widget.querySelector('#tm-frequency-period-trigger').click();
        }
        widget.querySelector('#tm-frequency-interval-tab').click();
        expect(widget.querySelectorAll('#tm-frequency-interval-day-options input:checked')).toHaveLength(0);
    });

    test('stores the biweekly calendar anchor and selected weekdays', async () => {
        const { widget } = await editor();
        choosePeriod(widget, 'biweekly');
        for (const day of [1, 2, 3, 4, 5]) selectWeekday(widget, 'period', day, true);
        change(widget, '#tm-frequency-anchor-week', '2026-10-19');
        await widget._saveEdit(null);
        expect(createdTrigger().recurrence).toEqual({
            mode: 'biweekly',
            time: '09:00',
            weekdays: [1, 2, 3, 4, 5],
            anchorDate: '2026-10-19'
        });
    });

    test('interval selection persists the chosen value and hourly unit', async () => {
        const { widget } = await editor();
        widget.querySelector('#tm-frequency-interval-tab').click();
        change(widget, '#tm-frequency-hours', '5');
        await widget._saveEdit(null);
        expect(createdTrigger().recurrence).toMatchObject({ mode: 'interval', intervalValue: 5, intervalUnit: 'hour' });
        expect(createdTrigger().recurrence.anchorAt).toMatch(/T\d{2}:\d{2}:00\.000Z$/);
    });

    test('switching tabs preserves the interval draft and period selection', async () => {
        const { widget } = await editor();
        choosePeriod(widget, 'yearly');
        selectCalendar(widget, 'months', 6);
        widget.querySelector('#tm-frequency-interval-tab').click();
        change(widget, '#tm-frequency-hours', '3');
        widget.querySelector('#tm-frequency-period-tab').click();
        expect(
            widget.querySelector('[data-calendar-kind="months"][data-calendar-value="6"]').hasAttribute('checked')
        ).toBe(true);
        widget.querySelector('#tm-frequency-interval-tab').click();
        expect(widget.querySelector('#tm-frequency-hours').value).toBe('3');
    });

    test('allows an interval without weekday restrictions', async () => {
        const { widget } = await editor();
        widget.querySelector('#tm-frequency-interval-tab').click();
        await widget._saveEdit(null);
        expect(createdTrigger().recurrence).toMatchObject({ mode: 'interval', intervalValue: 1, intervalUnit: 'hour' });
        expect(createdTrigger().recurrence.weekdays).toBeUndefined();
    });

    test.each([
        ['weekly', '请选择执行星期。', '#tm-frequency-period-weekdays', '[data-days-toggle="period"]'],
        ['biweekly', '请选择执行星期。', '#tm-frequency-period-weekdays', '[data-days-toggle="period"]'],
        ['monthly', '请选择日期。', '#tm-frequency-day-field', '#tm-frequency-day'],
        ['yearly', '请选择月份。', '#tm-frequency-month-field', '#tm-frequency-month']
    ])('saving an incomplete %s task only identifies the missing field', async (mode, message, field, control) => {
        const { widget } = await editor(undefined, 'zh-CN');
        choosePeriod(widget, mode);
        expect(widget.querySelector('#tm-frequency-validation-error').hidden).toBe(true);
        await widget._saveEdit(null);
        expect(createdTrigger()).toBeUndefined();
        expect(widget.querySelector('#tm-frequency-validation-error').textContent).toBe(message);
        expect(widget.querySelector('#tm-frequency-validation-error').parentElement).toBe(widget.querySelector(field));
        expect(widget.querySelector(control).getAttribute('aria-invalid')).toBe('true');
    });

    test('clears inline feedback when the user changes the highlighted selection', async () => {
        const { widget } = await editor(undefined, 'zh-CN');
        choosePeriod(widget, 'weekly');
        await widget._saveEdit(null);
        const error = widget.querySelector('#tm-frequency-validation-error');
        expect(error.hidden).toBe(false);
        selectWeekday(widget, 'period', 1, true);
        expect(error.hidden).toBe(true);
        await widget._saveEdit(null);
        expect(createdTrigger().recurrence.weekdays).toEqual([1]);
    });

    test('changing the scheduling timezone clears old inline feedback until saving again', async () => {
        const { widget } = await editor(undefined, 'zh-CN');
        choosePeriod(widget, 'weekly');
        await widget._saveEdit(null);
        const error = widget.querySelector('#tm-frequency-validation-error');
        expect(error.hidden).toBe(false);
        change(widget, '#tm-edit-timezone', 'UTC');
        expect(error.hidden).toBe(true);
        await widget._saveEdit(null);
        expect(error.hidden).toBe(false);
        expect(error.textContent).toBe('请选择执行星期。');
    });

    test.each([
        ['week', '请选择执行星期。'],
        ['month', '请选择日期。'],
        ['year', '请选择月份。']
    ])('saving an incomplete %s interval only identifies its missing field', async (unit, message) => {
        const { widget } = await editor(undefined, 'zh-CN');
        widget.querySelector('#tm-frequency-interval-tab').click();
        change(widget, '#tm-frequency-interval-unit', unit);
        await widget._saveEdit(null);
        expect(createdTrigger()).toBeUndefined();
        expect(widget.querySelector('#tm-frequency-validation-error').textContent).toBe(message);
        const field =
            unit === 'week'
                ? '#tm-frequency-period-weekdays'
                : unit === 'month'
                  ? '#tm-frequency-day-field'
                  : '#tm-frequency-month-field';
        expect(widget.querySelector('#tm-frequency-validation-error').parentElement).toBe(widget.querySelector(field));
    });

    test('yearly validation follows the missing fields as they are completed', async () => {
        const { widget } = await editor(undefined, 'zh-CN');
        choosePeriod(widget, 'yearly');
        await widget._saveEdit(null);
        expect(widget.querySelector('#tm-frequency-validation-error').textContent).toBe('请选择月份。');
        selectCalendar(widget, 'months', 2);
        await widget._saveEdit(null);
        expect(widget.querySelector('#tm-frequency-validation-error').textContent).toBe('请选择日期。');
        selectCalendar(widget, 'dates', 30);
        await widget._saveEdit(null);
        expect(widget.querySelector('#tm-frequency-validation-error').textContent).toBe(
            '所选月份没有该日期，请重新选择日期。'
        );
        selectCalendar(widget, 'dates', 30, false);
        selectCalendar(widget, 'dates', 29);
        await widget._saveEdit(null);
        expect(createdTrigger().recurrence).toMatchObject({ mode: 'yearly', months: [2], days: [29] });
    });

    test('an invalid interval value gets a short value-specific message', async () => {
        const { widget } = await editor(undefined, 'zh-CN');
        widget.querySelector('#tm-frequency-interval-tab').click();
        change(widget, '#tm-frequency-hours', '0');
        await widget._saveEdit(null);
        const message = widget.querySelector('#tm-frequency-validation-error').textContent;
        expect(createdTrigger()).toBeUndefined();
        expect(message).toMatch(/1.*10000/);
        expect(message.length).toBeLessThan(45);
        expect(message).not.toMatch(/星期|月份|日期|时间/);
        const input = widget.querySelector('#tm-frequency-hours');
        input.value = '2';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        expect(widget.querySelector('#tm-frequency-validation-error').hidden).toBe(true);
    });

    test.each(['hour', 'day', 'week', 'month', 'year'])('persists an interval in %s units', async (unit) => {
        const { widget } = await editor();
        widget.querySelector('#tm-frequency-interval-tab').click();
        change(widget, '#tm-frequency-hours', '2');
        change(widget, '#tm-frequency-interval-unit', unit);
        if (unit !== 'hour') {
            change(widget, '#tm-cron-hour', '17');
            change(widget, '#tm-cron-minute', '35');
        }
        if (unit === 'week') {
            selectWeekday(widget, 'period', 1, true);
            selectWeekday(widget, 'period', 4, true);
        }
        if (unit === 'month' || unit === 'year') {
            selectCalendar(widget, 'dates', 5);
            selectCalendar(widget, 'dates', 29);
        }
        if (unit === 'year') {
            selectCalendar(widget, 'months', 2);
            selectCalendar(widget, 'months', 6);
        }
        await widget._saveEdit(null);
        const recurrence = createdTrigger().recurrence;
        expect(recurrence).toMatchObject({ mode: 'interval', intervalValue: 2, intervalUnit: unit });
        if (unit !== 'hour') expect(recurrence.time).toBe('17:35');
        else expect(recurrence.time).toBeUndefined();
        if (unit === 'week') expect(recurrence.weekdays).toEqual([1, 4]);
        else expect(recurrence.weekdays).toBeUndefined();
        if (unit === 'month' || unit === 'year') expect(recurrence.days).toEqual([5, 29]);
        else expect(recurrence.days).toBeUndefined();
        if (unit === 'year') expect(recurrence.months).toEqual([2, 6]);
        else expect(recurrence.months).toBeUndefined();
    });

    test('shows the execution details appropriate for each interval unit', async () => {
        const { widget } = await editor();
        widget.querySelector('#tm-frequency-interval-tab').click();
        for (const unit of ['hour', 'day', 'week', 'month', 'year']) {
            change(widget, '#tm-frequency-interval-unit', unit);
            const details = widget.querySelector('#tm-frequency-calendar-fields');
            expect(details.hidden).toBe(unit === 'hour');
            expect(widget.querySelector('#tm-frequency-time-field').hidden).toBe(unit === 'hour');
            expect(widget.querySelector('#tm-frequency-period-weekdays').hidden).toBe(unit !== 'week');
            expect(widget.querySelector('#tm-frequency-day-field').hidden).toBe(!['month', 'year'].includes(unit));
            expect(widget.querySelector('#tm-frequency-month-field').hidden).toBe(unit !== 'year');
        }
    });

    test('changing interval units retains the chosen dates, months, and time draft', async () => {
        const { widget } = await editor();
        widget.querySelector('#tm-frequency-interval-tab').click();
        change(widget, '#tm-frequency-interval-unit', 'month');
        selectCalendar(widget, 'dates', 5);
        selectCalendar(widget, 'dates', 15);
        change(widget, '#tm-cron-hour', '10');
        change(widget, '#tm-cron-minute', '20');
        change(widget, '#tm-frequency-interval-unit', 'year');
        widget.querySelector('#tm-frequency-month').click();
        selectCalendar(widget, 'months', 3);
        selectCalendar(widget, 'months', 9);
        expect(widget.querySelector('#tm-frequency-dates-options').hidden).toBe(false);
        change(widget, '#tm-frequency-interval-unit', 'hour');
        expect(widget.querySelector('#tm-frequency-dates-options').hidden).toBe(true);
        change(widget, '#tm-frequency-interval-unit', 'year');
        expect(widget.querySelector('#tm-cron-hour').value).toBe('10');
        expect(widget.querySelector('#tm-cron-minute').value).toBe('20');
        await widget._saveEdit(null);
        expect(createdTrigger().recurrence).toMatchObject({
            mode: 'interval',
            intervalUnit: 'year',
            time: '10:20',
            months: [3, 9],
            days: [5, 15]
        });
    });

    describe('editing interval units', () => {
        const now = '2026-10-30T00:00:00.000Z';
        const nextRun = '2026-10-30T01:37:00.000Z';
        const trigger = {
            type: 'cron',
            cronExpression: '* * * * *',
            timezone: 'UTC',
            recurrence: {
                mode: 'interval' as const,
                intervalValue: 2,
                intervalUnit: 'hour' as const,
                anchorAt: '2026-10-19T01:37:00.000Z'
            }
        };

        beforeEach(() => {
            jest.useFakeTimers({ now: new Date(now) });
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        test.each([
            ['day', 'UTC', '1', '37', 5, 30, 10],
            ['week', 'America/New_York', '21', '37', 4, 29, 10]
        ])(
            'switching an hourly interval to %s in %s retains its next run when saved and reopened',
            async (unit, timezone, hour, minute, weekday, day, month) => {
                const { widget, plan } = await editor(trigger);
                if (timezone !== trigger.timezone) change(widget, '#tm-edit-timezone', String(timezone));
                change(widget, '#tm-frequency-interval-unit', String(unit));

                expect(widget.querySelector('#tm-cron-hour').value).toBe(hour);
                expect(widget.querySelector('#tm-cron-minute').value).toBe(minute);
                const time = `${String(hour).padStart(2, '0')}:${minute}`;
                const details = unit === 'week' ? { weekdays: [weekday] } : {};
                if (unit === 'week')
                    expect(widget.querySelector(`[data-day-scope="period"][data-weekday="${weekday}"]`).checked).toBe(
                        true
                    );

                await widget._saveEdit(plan);
                const saved = (call.mock.calls.find((args: any[]) => args[0] === 'updateGlobalTodo')?.[2] as any)
                    ?.trigger;
                expect(saved).toEqual({
                    type: 'cron',
                    cronExpression: '* * * * *',
                    timezone,
                    recurrence: {
                        mode: 'interval',
                        intervalValue: 2,
                        intervalUnit: unit,
                        anchorAt: nextRun,
                        time,
                        ...details
                    }
                });
                expect(getNextTodoRecurrenceRuns(saved.recurrence, saved.timezone, 1)[0]?.toISOString()).toBe(nextRun);

                call.mockClear();
                const reopened = await editor(saved);
                expect(reopened.widget.querySelector('#tm-cron-hour').value).toBe(hour);
                expect(reopened.widget.querySelector('#tm-cron-minute').value).toBe(minute);
                await reopened.widget._saveEdit(reopened.plan);
                expect(
                    (call.mock.calls.find((args: any[]) => args[0] === 'updateGlobalTodo')?.[2] as any)?.trigger
                ).toEqual(saved);
            }
        );

        test('changing an hourly interval to selected Fridays saves the visible clock and has a next run', async () => {
            const { widget, plan } = await editor(trigger);
            change(widget, '#tm-frequency-interval-unit', 'week');
            selectWeekday(widget, 'period', 5, true);
            await widget._saveEdit(plan);
            const saved = (call.mock.calls.find((args: any[]) => args[0] === 'updateGlobalTodo')?.[2] as any)?.trigger;
            expect(saved?.recurrence).toMatchObject({
                intervalUnit: 'week',
                anchorAt: nextRun,
                time: '01:37',
                weekdays: [5]
            });
            expect(getNextTodoRecurrenceRuns(saved.recurrence, saved.timezone, 1)[0]?.toISOString()).toBe(nextRun);
        });

        test('resolves the original next run in its stored timezone before displaying the selected timezone', async () => {
            const { widget, plan } = await editor({
                type: 'cron',
                cronExpression: '* * * * *',
                timezone: 'Asia/Shanghai',
                recurrence: {
                    mode: 'interval',
                    intervalValue: 2,
                    intervalUnit: 'day',
                    anchorAt: '2026-10-19T01:00:00.000Z',
                    time: '09:00'
                }
            });
            change(widget, '#tm-edit-timezone', 'America/New_York');
            change(widget, '#tm-frequency-interval-unit', 'week');
            expect(widget.querySelector('#tm-cron-hour').value).toBe('21');
            expect(widget.querySelector('#tm-cron-minute').value).toBe('0');
            expect(widget.querySelector('[data-day-scope="period"][data-weekday="5"]').checked).toBe(true);
            await widget._saveEdit(plan);
            const saved = (call.mock.calls.find((args: any[]) => args[0] === 'updateGlobalTodo')?.[2] as any)?.trigger;
            expect(saved.recurrence).toEqual({
                mode: 'interval',
                intervalValue: 2,
                intervalUnit: 'week',
                anchorAt: '2026-10-31T01:00:00.000Z',
                time: '21:00',
                weekdays: [5]
            });
            expect(getNextTodoRecurrenceRuns(saved.recurrence, saved.timezone, 1)[0]?.toISOString()).toBe(
                '2026-10-31T01:00:00.000Z'
            );
        });
    });

    test('preserves an old day interval until its execution details are edited', async () => {
        const trigger = {
            type: 'cron',
            cronExpression: '* * * * *',
            timezone: 'Asia/Shanghai',
            recurrence: {
                mode: 'interval',
                intervalValue: 2,
                intervalUnit: 'day',
                anchorAt: '2026-10-20T01:37:00.000Z'
            }
        };
        const { widget, plan } = await editor(trigger);
        expect(widget.querySelector('#tm-cron-hour').value).toBe('9');
        expect(widget.querySelector('#tm-cron-minute').value).toBe('37');
        await widget._saveEdit(plan);
        expect(call.mock.calls.find((args: any[]) => args[0] === 'updateGlobalTodo')?.[2].trigger).toEqual(trigger);
    });

    test('editing an old interval clock keeps its calendar anchor and explicit day selection', async () => {
        const trigger = {
            type: 'cron',
            cronExpression: '* * * * *',
            timezone: 'Asia/Shanghai',
            recurrence: {
                mode: 'interval',
                intervalValue: 2,
                intervalUnit: 'week',
                anchorAt: '2026-10-20T01:37:00.000Z'
            }
        };
        const { widget, plan } = await editor(trigger);
        change(widget, '#tm-cron-minute', '38');
        await widget._saveEdit(plan);
        const recurrence = (call.mock.calls.find((args: any[]) => args[0] === 'updateGlobalTodo')?.[2] as any)?.trigger
            .recurrence;
        expect(recurrence).toEqual({
            mode: 'interval',
            intervalValue: 2,
            intervalUnit: 'week',
            anchorAt: trigger.recurrence.anchorAt,
            time: '09:38',
            weekdays: [2]
        });
    });

    test('restores the selected execution details of an existing yearly interval', async () => {
        const trigger = {
            type: 'cron',
            cronExpression: '* * * * *',
            timezone: 'UTC',
            recurrence: {
                mode: 'interval',
                intervalValue: 3,
                intervalUnit: 'year',
                anchorAt: '2026-01-01T00:00:00Z',
                time: '12:17',
                months: [2, 6],
                days: [5, 29]
            }
        };
        const { widget, plan } = await editor(trigger);
        expect(widget.querySelector('#tm-cron-hour').value).toBe('12');
        expect(widget.querySelector('#tm-cron-minute').value).toBe('17');
        const checked = (selector: string) =>
            [...widget.querySelectorAll(selector)].map((input: any) => Number(input.dataset.calendarValue));
        expect(checked('#tm-frequency-months-options [data-calendar-value]:checked')).toEqual([2, 6]);
        expect(checked('#tm-frequency-dates-options [data-calendar-value]:checked')).toEqual([5, 29]);
        await widget._saveEdit(plan);
        expect(call.mock.calls.find((args: any[]) => args[0] === 'updateGlobalTodo')?.[2].trigger).toEqual(trigger);
    });

    test('editing a stored interval preserves its original anchor', async () => {
        const trigger = {
            type: 'cron',
            cronExpression: '* * * * *',
            timezone: 'UTC',
            recurrence: {
                mode: 'interval',
                intervalHours: 5,
                anchorAt: '2026-01-01T09:10:00.000Z',
                weekdays: [1, 2, 3, 4, 5]
            }
        };
        const { widget, plan } = await editor(trigger);
        widget.querySelector('#tm-edit-title').value = 'Renamed';
        await widget._saveEdit(plan);
        expect(call.mock.calls.find((args: any[]) => args[0] === 'updateGlobalTodo')?.[2].trigger).toEqual(trigger);
    });

    test('an unsupported saved rule shows its read-only formula and remains intact', async () => {
        const trigger = { type: 'cron', cronExpression: '0 9-17 * * 1-5', timezone: 'UTC' };
        const { widget, plan } = await editor(trigger);
        expect(widget.querySelector('.tm-todo-card .tm-legacy-cron')?.textContent).toBe(trigger.cronExpression);
        expect(widget.querySelector('#tm-cron-expression')?.textContent).toBe(trigger.cronExpression);
        expect(widget.querySelector('#tm-cron-custom-input')).toBeNull();
        widget.querySelector('#tm-frequency-interval-tab').click();
        expect(widget.querySelector('#tm-cron-expression')?.hidden).toBe(true);
        widget.querySelector('#tm-frequency-period-tab').click();
        expect(widget.querySelector('#tm-cron-expression')?.hidden).toBe(false);
        await widget._saveEdit(plan);
        expect(call.mock.calls.find((args: any[]) => args[0] === 'updateGlobalTodo')?.[2].trigger).toEqual(trigger);
        widget._renderDetail(plan);
        expect(widget.querySelector('#tm-detail-scroll .tm-legacy-cron')?.textContent).toBe(trigger.cronExpression);
        const malformed = { ...plan, trigger: { ...trigger, cronExpression: '<img src=x onerror=alert(1)>' } };
        widget._renderDetail(malformed);
        expect(widget.querySelector('#tm-detail-scroll .tm-legacy-cron')?.textContent).toBe(
            malformed.trigger.cronExpression
        );
        expect(widget.querySelector('#tm-detail-scroll .tm-legacy-cron img')).toBeNull();
    });

    test('preserves the one-time date and edited clock when visiting other modes', async () => {
        const { widget, plan } = await editor({
            type: 'scheduled',
            triggerAt: '2030-06-01T09:37:42.000Z',
            timezone: 'UTC'
        });
        change(widget, '#tm-dt-hour', '17');
        choosePeriod(widget, 'daily');
        widget.querySelector('#tm-frequency-interval-tab').click();
        widget.querySelector('#tm-frequency-period-tab').click();
        choosePeriod(widget, 'once');
        expect(widget.querySelector('#tm-dt-hour').value).toBe('17');
        await widget._saveEdit(plan);
        expect(call.mock.calls.find((args: any[]) => args[0] === 'updateGlobalTodo')?.[2].trigger).toEqual({
            type: 'scheduled',
            triggerAt: '2030-06-01T17:37:00.000Z',
            timezone: 'UTC'
        });
    });

    test('persists multiple monthly dates selected from the dropdown', async () => {
        const { widget } = await editor();
        choosePeriod(widget, 'monthly');
        selectCalendar(widget, 'dates', 1, false);
        selectCalendar(widget, 'dates', 15);
        selectCalendar(widget, 'dates', 31);
        await widget._saveEdit(null);
        expect(createdTrigger().recurrence).toEqual({ mode: 'monthly', time: '09:00', days: [15, 31] });
    });

    test('persists every selected yearly month and date', async () => {
        const { widget } = await editor();
        choosePeriod(widget, 'yearly');
        selectCalendar(widget, 'months', 6);
        selectCalendar(widget, 'months', 12);
        selectCalendar(widget, 'dates', 15);
        await widget._saveEdit(null);
        expect(createdTrigger().recurrence).toEqual({ mode: 'yearly', time: '09:00', months: [6, 12], days: [15] });
    });

    test('editing an old scalar yearly rule preserves it until its frequency changes', async () => {
        const trigger = {
            type: 'cron',
            cronExpression: '* * * * *',
            timezone: 'UTC',
            recurrence: { mode: 'yearly', time: '09:00', month: 6, day: 5 }
        };
        const { widget, plan } = await editor(trigger);
        expect(
            widget.querySelector('[data-calendar-kind="months"][data-calendar-value="6"]').hasAttribute('checked')
        ).toBe(true);
        expect(
            widget.querySelector('[data-calendar-kind="dates"][data-calendar-value="5"]').hasAttribute('checked')
        ).toBe(true);
        await widget._saveEdit(plan);
        expect(call.mock.calls.find((args: any[]) => args[0] === 'updateGlobalTodo')?.[2].trigger).toEqual(trigger);
    });

    test('changing the clock preserves all dates and months of an existing rule', async () => {
        const trigger = {
            type: 'cron',
            cronExpression: '* * * * *',
            timezone: 'UTC',
            recurrence: { mode: 'yearly', time: '09:00', months: [2, 6, 12], days: [1, 15, 31] }
        };
        const { widget, plan } = await editor(trigger);
        change(widget, '#tm-cron-hour', '10');
        await widget._saveEdit(plan);
        expect(call.mock.calls.find((args: any[]) => args[0] === 'updateGlobalTodo')?.[2].trigger.recurrence).toEqual({
            ...trigger.recurrence,
            time: '10:00'
        });
    });

    test.each(['monthly', 'yearly'])('requires at least one date for %s', async (mode) => {
        const { widget } = await editor();
        choosePeriod(widget, mode);
        selectCalendar(widget, 'dates', 1, false);
        await widget._saveEdit(null);
        expect(createdTrigger()).toBeUndefined();
        expect(widget.querySelector('#tm-frequency-validation-error').hidden).toBe(false);
    });

    test('requires at least one month for a yearly rule', async () => {
        const { widget } = await editor();
        choosePeriod(widget, 'yearly');
        selectCalendar(widget, 'months', 1, false);
        await widget._saveEdit(null);
        expect(createdTrigger()).toBeUndefined();
        expect(widget.querySelector('#tm-frequency-validation-error').hidden).toBe(false);
    });

    test('only reports an incomplete monthly selection when saving', async () => {
        const { widget } = await editor();
        choosePeriod(widget, 'monthly');
        const preview = widget.querySelector('#tm-cron-preview');
        expect(preview.hidden).toBe(true);
        expect(preview.textContent).toBe('');
        await widget._saveEdit(null);
        expect(createdTrigger()).toBeUndefined();
        expect(widget.querySelector('#tm-frequency-validation-error').hidden).toBe(false);
        selectCalendar(widget, 'dates', 1);
        expect(preview.hidden).toBe(false);
        await widget._saveEdit(null);
        expect(createdTrigger().recurrence.mode).toBe('monthly');
    });

    test('select-all checkbox can select and clear the full date list', async () => {
        const { widget } = await editor();
        choosePeriod(widget, 'monthly');
        widget.querySelector('#tm-frequency-day').click();
        const selectAll = widget.querySelector('[data-calendar-select-all="dates"]');
        expect(selectAll.indeterminate).toBe(false);
        selectAll.checked = true;
        selectAll.dispatchEvent(new Event('change', { bubbles: true }));
        expect(selectAll.checked).toBe(true);
        expect(widget.querySelector('#tm-frequency-dates-options').hidden).toBe(false);
        selectAll.checked = false;
        selectAll.dispatchEvent(new Event('change', { bubbles: true }));
        await widget._saveEdit(null);
        expect(createdTrigger()).toBeUndefined();
        expect(widget.querySelector('#tm-frequency-validation-error').hidden).toBe(false);
    });

    test('selected values update in the collapsed bar after checkbox changes', async () => {
        const { widget } = await editor();
        choosePeriod(widget, 'yearly');
        selectCalendar(widget, 'months', 6);
        selectCalendar(widget, 'dates', 15);
        expect(widget.querySelector('#tm-frequency-month').textContent).toContain('Jun');
        expect(widget.querySelector('#tm-frequency-day').textContent).toContain('15');
        await widget._saveEdit(null);
        expect(createdTrigger().recurrence).toMatchObject({ months: [6], days: [15] });
    });
});
