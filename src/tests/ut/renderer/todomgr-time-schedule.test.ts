import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { getNextTodoRecurrenceRuns } from '../../../common/utils/todo-recurrence.js';

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
        window.HTMLElement.prototype.getBoundingClientRect = () => ({
            left: 0,
            right: 400,
            top: 100,
            bottom: 140,
            width: 400,
            height: 40,
            x: 0,
            y: 100,
            toJSON: () => ({})
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

    test.each(['weekly', 'biweekly'])('selecting %s immediately opens the weekday submenu', async (mode) => {
        const { widget } = await editor();
        choosePeriod(widget, mode);
        const periods = widget.querySelector('#tm-frequency-period-options');
        const weekdays = widget.querySelector('#tm-frequency-period-day-options');
        expect(periods.hidden).toBe(false);
        expect(weekdays.hidden).toBe(false);
        expect(widget.querySelector(`[data-period-mode="${mode}"]`).getAttribute('aria-expanded')).toBe('true');
        expect(weekdays.querySelectorAll('[data-weekday]')).toHaveLength(7);
        selectWeekday(widget, 'period', 0, true);
        expect(periods.hidden).toBe(false);
        expect(weekdays.hidden).toBe(false);
        expect(widget.querySelector('[data-days-toggle="period"]').textContent).toContain('Sun');
        widget.querySelector('[data-period-mode="daily"]').click();
        expect(periods.hidden).toBe(true);
        expect(weekdays.hidden).toBe(true);
    });

    test.each([
        ['monthly', 'dates', 15, 31],
        ['yearly', 'months', 6, 12]
    ])('selecting %s immediately opens its calendar multiselect', async (mode, kind, value, count) => {
        const { widget } = await editor();
        choosePeriod(widget, String(mode));
        const periods = widget.querySelector('#tm-frequency-period-options');
        const menu = widget.querySelector(`#tm-frequency-${kind}-options`);
        expect(periods.hidden).toBe(false);
        expect(menu.hidden).toBe(false);
        expect(widget.querySelector(`[data-period-mode="${mode}"]`).getAttribute('aria-expanded')).toBe('true');
        expect(menu.querySelectorAll('[data-calendar-value]')).toHaveLength(Number(count));
        selectCalendar(widget, kind as 'dates' | 'months', Number(value));
        expect(periods.hidden).toBe(false);
        expect(menu.hidden).toBe(false);
        if (mode === 'yearly') selectCalendar(widget, 'dates', 1);
        await widget._saveEdit(null);
        expect(createdTrigger().recurrence).toMatchObject({
            mode,
            [kind === 'dates' ? 'days' : 'months']: [Number(value)]
        });
    });

    test('switching frequency branches preserves selections and supports the separate calendar fields', async () => {
        const { widget } = await editor();
        choosePeriod(widget, 'weekly');
        widget.querySelector('[data-period-mode="monthly"]').click();
        expect(widget.querySelector('#tm-frequency-period-day-options').hidden).toBe(true);
        const dates = widget.querySelector('#tm-frequency-dates-options');
        expect(dates.hidden).toBe(false);
        selectCalendar(widget, 'dates', 15);
        widget.querySelector('[data-period-mode="yearly"]').click();
        expect(dates.hidden).toBe(true);
        const months = widget.querySelector('#tm-frequency-months-options');
        expect(months.hidden).toBe(false);
        selectCalendar(widget, 'months', 6);
        widget.querySelector('#tm-frequency-month').click();
        expect(widget.querySelector('#tm-frequency-period-options').hidden).toBe(true);
        expect(months.hidden).toBe(false);
        widget.querySelector('#tm-frequency-day').click();
        expect(months.hidden).toBe(true);
        expect(dates.hidden).toBe(false);
        await widget._saveEdit(null);
        expect(createdTrigger().recurrence).toMatchObject({ mode: 'yearly', months: [6], days: [15] });
    });

    test('selecting yearly months also opens dates without interrupting either multiselect', async () => {
        const { widget } = await editor();
        choosePeriod(widget, 'yearly');
        const months = widget.querySelector('#tm-frequency-months-options');
        const dates = widget.querySelector('#tm-frequency-dates-options');
        const focusDate = jest.spyOn(dates.querySelector('[data-calendar-value="1"]'), 'focus');
        selectCalendar(widget, 'months', 2);
        expect(months.hidden).toBe(false);
        expect(dates.hidden).toBe(false);
        expect(widget.querySelector('#tm-frequency-period-options').hidden).toBe(false);
        expect(focusDate).not.toHaveBeenCalled();
        selectCalendar(widget, 'dates', 15);
        dates.scrollTop = 100;
        selectCalendar(widget, 'months', 6);
        expect(dates.hidden).toBe(false);
        expect(dates.scrollTop).toBe(100);
        expect(focusDate).not.toHaveBeenCalled();
        await widget._saveEdit(null);
        expect(createdTrigger().recurrence).toMatchObject({ mode: 'yearly', months: [2, 6], days: [15] });
    });

    test('yearly dates also open from the separate month field and can return to a standalone date picker', async () => {
        const { widget } = await editor();
        choosePeriod(widget, 'yearly');
        widget.querySelector('#tm-frequency-month').click();
        selectCalendar(widget, 'months', 2);
        const months = widget.querySelector('#tm-frequency-months-options');
        const dates = widget.querySelector('#tm-frequency-dates-options');
        expect(widget.querySelector('#tm-frequency-period-options').hidden).toBe(true);
        expect(months.hidden).toBe(false);
        expect(dates.hidden).toBe(false);
        widget.querySelector('#tm-frequency-day').click();
        expect(months.hidden).toBe(true);
        expect(dates.hidden).toBe(false);
        expect(dates.querySelector('[data-period-back]').hidden).toBe(true);
        expect(dates.querySelector('[data-period-back]').textContent).toContain('Back to frequencies');
    });

    test('clearing yearly months closes dates and selecting all opens them again', async () => {
        const { widget } = await editor();
        choosePeriod(widget, 'yearly');
        const all = widget.querySelector('[data-calendar-select-all="months"]');
        const dates = widget.querySelector('#tm-frequency-dates-options');
        all.checked = true;
        all.dispatchEvent(new Event('change', { bubbles: true }));
        expect(dates.hidden).toBe(false);
        selectCalendar(widget, 'months', 12, false);
        expect(dates.hidden).toBe(false);
        all.checked = false;
        all.dispatchEvent(new Event('change', { bubbles: true }));
        expect(dates.hidden).toBe(true);
        expect(widget.querySelector('#tm-frequency-months-options').hidden).toBe(false);
        expect(widget.querySelector('#tm-frequency-validation-error').hidden).toBe(true);
        await widget._saveEdit(null);
        expect(createdTrigger()).toBeUndefined();
        expect(widget.querySelector('#tm-frequency-validation-error').hidden).toBe(false);
    });

    test('yearly keyboard navigation returns from dates to months before returning to frequency', async () => {
        const { widget } = await editor();
        widget.connectedCallback = () => undefined;
        document.body.append(widget);
        try {
            choosePeriod(widget, 'yearly');
            selectCalendar(widget, 'months', 2);
            const month = widget.querySelector('#tm-frequency-months-options [data-calendar-value="2"]');
            const date = widget.querySelector('#tm-frequency-dates-options [data-calendar-select-all="dates"]');
            const key = (target: HTMLElement, value: string) => {
                const event = new Event('keydown', { bubbles: true });
                Object.defineProperty(event, 'key', { value });
                target.dispatchEvent(event);
            };
            const focusDate = jest.spyOn(date, 'focus');
            key(month, 'ArrowRight');
            expect(focusDate).toHaveBeenCalledTimes(1);
            const focusMonth = jest.spyOn(month, 'focus');
            key(date, 'ArrowLeft');
            expect(widget.querySelector('#tm-frequency-dates-options').hidden).toBe(true);
            expect(widget.querySelector('#tm-frequency-months-options').hidden).toBe(false);
            expect(focusMonth).toHaveBeenCalledTimes(1);
            key(month, 'ArrowLeft');
            expect(widget.querySelector('#tm-frequency-months-options').hidden).toBe(true);
            expect(widget.querySelector('#tm-frequency-period-options').hidden).toBe(false);
        } finally {
            widget.remove();
        }
    });

    test.each([
        ['right', 1280, 20, 400, 406, 626],
        ['left', 1280, 884, 1252, 658, 878],
        ['compact', 700, 300, 688, 74, 294],
        ['compact', 320, 12, 308, 12, 308]
    ])(
        'positions yearly dates to the %s of the month menu',
        async (placement, viewportWidth, rootLeft, rootRight, monthLeft, monthRight) => {
            const { widget } = await editor();
            Object.assign(window, { innerWidth: Number(viewportWidth) });
            const rectangle = (left: number, right: number) => ({
                left,
                right,
                top: 100,
                bottom: 400,
                width: right - left,
                height: 300
            });
            jest.spyOn(widget.querySelector('#tm-frequency-period-options'), 'getBoundingClientRect').mockReturnValue(
                rectangle(Number(rootLeft), Number(rootRight))
            );
            jest.spyOn(widget.querySelector('#tm-frequency-months-options'), 'getBoundingClientRect').mockReturnValue(
                rectangle(Number(monthLeft), Number(monthRight))
            );
            try {
                choosePeriod(widget, 'yearly');
                const focusBack = jest.spyOn(widget.querySelector('#tm-frequency-dates-back'), 'focus');
                selectCalendar(widget, 'months', 2);
                const dates = widget.querySelector('#tm-frequency-dates-options');
                const back = dates.querySelector('[data-period-back]');
                expect(dates.hidden).toBe(false);
                const left = parseFloat(dates.style.left);
                const right = left + parseFloat(dates.style.width);
                expect(left).toBeGreaterThanOrEqual(12);
                expect(right).toBeLessThanOrEqual(Number(viewportWidth) - 12);
                if (placement === 'right') expect(left).toBeGreaterThan(Number(monthRight));
                if (placement === 'left') expect(right).toBeLessThan(Number(monthLeft));
                expect(back.hidden).toBe(placement !== 'compact');
                expect(focusBack).toHaveBeenCalledTimes(placement === 'compact' ? 1 : 0);
                if (placement === 'compact') {
                    expect(back.textContent).toContain('Back to months');
                    back.click();
                    expect(dates.hidden).toBe(true);
                    expect(widget.querySelector('#tm-frequency-months-options').hidden).toBe(false);
                }
            } finally {
                Object.assign(window, { innerWidth: 1280 });
            }
        }
    );

    test.each([
        ['weekly', '#tm-frequency-period-day-options', '[data-select-all="period"]'],
        ['monthly', '#tm-frequency-dates-options', '[data-calendar-select-all="dates"]'],
        ['yearly', '#tm-frequency-months-options', '[data-calendar-select-all="months"]']
    ])('%s submenu supports entering, returning, and dismissing with the keyboard', async (mode, menuId, selected) => {
        const { widget } = await editor();
        widget.connectedCallback = () => undefined;
        document.body.append(widget);
        try {
            const trigger = widget.querySelector('#tm-frequency-period-trigger');
            const weekly = widget.querySelector(`[data-period-mode="${mode}"]`);
            const weekdays = widget.querySelector(menuId);
            const periods = widget.querySelector('#tm-frequency-period-options');
            const key = (target: HTMLElement, value: string) => {
                const event = new Event('keydown', { bubbles: true });
                Object.defineProperty(event, 'key', { value });
                target.dispatchEvent(event);
            };
            trigger.click();
            const focusSelected = jest.spyOn(weekdays.querySelector(selected), 'focus');
            key(weekly, 'ArrowRight');
            expect(weekdays.hidden).toBe(false);
            expect(focusSelected).toHaveBeenCalledTimes(1);
            const focusWeekly = jest.spyOn(weekly, 'focus');
            key(weekdays.querySelector('input'), 'ArrowLeft');
            expect(weekdays.hidden).toBe(true);
            expect(periods.hidden).toBe(false);
            expect(focusWeekly).toHaveBeenCalledTimes(1);
            key(weekly, 'ArrowRight');
            const focusTrigger = jest.spyOn(trigger, 'focus');
            key(weekdays.querySelector('input'), 'Escape');
            expect(periods.hidden).toBe(true);
            expect(weekdays.hidden).toBe(true);
            expect(focusTrigger).toHaveBeenCalledTimes(1);
            trigger.click();
            weekly.click();
            document.body.click();
            expect(periods.hidden).toBe(true);
            expect(weekdays.hidden).toBe(true);
        } finally {
            widget.remove();
        }
    });

    test.each([
        ['monthly', 'dates'],
        ['yearly', 'months']
    ])('provides a return button for the %s submenu in a narrow window', async (mode, kind) => {
        const { widget } = await editor();
        Object.assign(window, { innerWidth: 320 });
        try {
            choosePeriod(widget, mode);
            const menu = widget.querySelector(`#tm-frequency-${kind}-options`);
            const back = menu.querySelector('[data-period-back]');
            expect(menu.hidden).toBe(false);
            expect(back.hidden).toBe(false);
            expect(parseFloat(menu.style.left)).toBeGreaterThanOrEqual(12);
            expect(parseFloat(menu.style.left) + parseFloat(menu.style.width)).toBeLessThanOrEqual(308);
            back.click();
            expect(menu.hidden).toBe(true);
            expect(widget.querySelector('#tm-frequency-period-options').hidden).toBe(false);
            expect(widget.querySelector(`[data-period-mode="${mode}"]`).getAttribute('aria-expanded')).toBe('false');
        } finally {
            Object.assign(window, { innerWidth: 1280 });
        }
    });

    test.each([
        ['right', 1280, 20, 400],
        ['left', 1280, 850, 1250],
        ['compact', 320, 12, 308]
    ])('positions the weekday submenu for %s space', async (placement, viewportWidth, left, right) => {
        const { widget } = await editor();
        Object.assign(window, { innerWidth: Number(viewportWidth) });
        const weekly = widget.querySelector('[data-period-mode="weekly"]');
        jest.spyOn(weekly, 'getBoundingClientRect').mockReturnValue({
            left: Number(left),
            right: Number(right),
            top: 150,
            bottom: 190,
            width: Number(right) - Number(left),
            height: 40
        });
        jest.spyOn(widget.querySelector('#tm-frequency-period-options'), 'getBoundingClientRect').mockReturnValue({
            left: Number(left),
            right: Number(right),
            top: 100,
            bottom: 400,
            width: Number(right) - Number(left),
            height: 300
        });
        try {
            choosePeriod(widget, 'weekly');
            const menu = widget.querySelector('#tm-frequency-period-day-options');
            const back = widget.querySelector('#tm-frequency-days-back');
            expect(menu.hidden).toBe(false);
            const menuLeft = parseFloat(menu.style.left);
            const menuWidth = parseFloat(menu.style.width);
            expect(menuLeft).toBeGreaterThanOrEqual(12);
            expect(menuLeft + menuWidth).toBeLessThanOrEqual(Number(viewportWidth) - 12);
            if (placement === 'right') expect(menuLeft).toBeGreaterThan(Number(right));
            if (placement === 'left') expect(menuLeft + menuWidth).toBeLessThan(Number(left));
            expect(back.hidden).toBe(placement !== 'compact');
            if (placement === 'compact') {
                back.click();
                expect(menu.hidden).toBe(true);
                expect(widget.querySelector('#tm-frequency-period-options').hidden).toBe(false);
            }
        } finally {
            Object.assign(window, { innerWidth: 1280 });
        }
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
        expect(createdTrigger().recurrence).toMatchObject({
            mode: 'interval',
            intervalValue: 5,
            intervalUnit: 'hour'
        });
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
        expect(createdTrigger().recurrence).toMatchObject({
            mode: 'interval',
            intervalValue: 1,
            intervalUnit: 'hour'
        });
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
        expect(widget.querySelector(control).getAttribute('aria-describedby')).toContain(
            'tm-frequency-validation-error'
        );
        expect(widget.querySelector('#tm-edit-error').hidden).toBe(true);
    });

    test('clears inline feedback when the user changes the highlighted selection', async () => {
        const { widget } = await editor(undefined, 'zh-CN');
        choosePeriod(widget, 'weekly');
        await widget._saveEdit(null);
        const control = widget.querySelector('[data-days-toggle="period"]');
        const error = widget.querySelector('#tm-frequency-validation-error');
        expect(error.hidden).toBe(false);
        control.click();
        expect(error.hidden).toBe(false);
        selectWeekday(widget, 'period', 1, true);
        expect(error.hidden).toBe(true);
        expect(control.hasAttribute('aria-invalid')).toBe(false);
        expect(control.hasAttribute('aria-describedby')).toBe(false);
        expect(widget.querySelector('#tm-edit-error').hidden).toBe(true);
        await widget._saveEdit(null);
        expect(createdTrigger().recurrence.weekdays).toEqual([1]);
    });

    test('changing the scheduling timezone clears old inline feedback until saving again', async () => {
        const { widget } = await editor(undefined, 'zh-CN');
        choosePeriod(widget, 'weekly');
        await widget._saveEdit(null);
        const control = widget.querySelector('[data-days-toggle="period"]');
        const error = widget.querySelector('#tm-frequency-validation-error');
        expect(error.hidden).toBe(false);
        change(widget, '#tm-edit-timezone', 'UTC');
        expect(error.hidden).toBe(true);
        expect(control.hasAttribute('aria-invalid')).toBe(false);
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
        expect(
            widget
                .querySelector('#tm-frequency-validation-error')
                .parentElement.classList.contains('tm-frequency-interval-line')
        ).toBe(true);
        expect(widget.querySelector('#tm-frequency-hours').getAttribute('aria-invalid')).toBe('true');
        const input = widget.querySelector('#tm-frequency-hours');
        input.value = '2';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        expect(widget.querySelector('#tm-frequency-validation-error').hidden).toBe(true);
        expect(input.hasAttribute('aria-invalid')).toBe(false);
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
        expect(createdTrigger().recurrence).toMatchObject({
            mode: 'interval',
            intervalValue: 2,
            intervalUnit: unit
        });
        const recurrence = createdTrigger().recurrence;
        if (unit !== 'hour') expect(recurrence.time).toBe('17:35');
        else expect(recurrence.time).toBeUndefined();
        if (unit === 'week') expect(recurrence.weekdays).toEqual([1, 4]);
        else expect(recurrence.weekdays).toBeUndefined();
        if (unit === 'month' || unit === 'year') expect(recurrence.days).toEqual([5, 29]);
        else expect(recurrence.days).toBeUndefined();
        if (unit === 'year') expect(recurrence.months).toEqual([2, 6]);
        else expect(recurrence.months).toBeUndefined();
    });

    test.each(['hour', 'day', 'week', 'month', 'year'])(
        'shows the execution details appropriate for %s intervals',
        async (unit) => {
            const { widget } = await editor();
            widget.querySelector('#tm-frequency-interval-tab').click();
            change(widget, '#tm-frequency-interval-unit', unit);
            const panel = widget.querySelector('#tm-frequency-interval-panel');
            const details = widget.querySelector('#tm-frequency-calendar-fields');
            expect(panel.contains(details)).toBe(true);
            expect(details.hidden).toBe(unit === 'hour');
            expect(widget.querySelector('#tm-frequency-time-field').hidden).toBe(unit === 'hour');
            expect(widget.querySelector('#tm-frequency-period-weekdays').hidden).toBe(unit !== 'week');
            expect(widget.querySelector('#tm-frequency-day-field').hidden).toBe(!['month', 'year'].includes(unit));
            expect(widget.querySelector('#tm-frequency-month-field').hidden).toBe(unit !== 'year');
        }
    );

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
            ['week', 'UTC', '1', '37', 5, 30, 10],
            ['month', 'UTC', '1', '37', 5, 30, 10],
            ['year', 'UTC', '1', '37', 5, 30, 10],
            ['day', 'America/New_York', '21', '37', 4, 29, 10],
            ['week', 'America/New_York', '21', '37', 4, 29, 10],
            ['month', 'America/New_York', '21', '37', 4, 29, 10],
            ['year', 'America/New_York', '21', '37', 4, 29, 10]
        ])(
            'switching an hourly interval to %s in %s retains its next run when saved and reopened',
            async (unit, timezone, hour, minute, weekday, day, month) => {
                const { widget, plan } = await editor(trigger);
                if (timezone !== trigger.timezone) change(widget, '#tm-edit-timezone', String(timezone));
                change(widget, '#tm-frequency-interval-unit', String(unit));

                expect(widget.querySelector('#tm-cron-hour').value).toBe(hour);
                expect(widget.querySelector('#tm-cron-minute').value).toBe(minute);
                const time = `${String(hour).padStart(2, '0')}:${minute}`;
                const details = {
                    ...(unit === 'week' ? { weekdays: [weekday] } : {}),
                    ...(['month', 'year'].includes(String(unit)) ? { days: [day] } : {}),
                    ...(unit === 'year' ? { months: [month] } : {})
                };

                if (unit === 'week')
                    expect(widget.querySelector(`[data-day-scope="period"][data-weekday="${weekday}"]`).checked).toBe(
                        true
                    );
                if (unit === 'month' || unit === 'year')
                    expect(
                        widget.querySelector(`#tm-frequency-dates-options [data-calendar-value="${day}"]`).checked
                    ).toBe(true);
                if (unit === 'year')
                    expect(
                        widget.querySelector(`#tm-frequency-months-options [data-calendar-value="${month}"]`).checked
                    ).toBe(true);

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
                ...trigger,
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

        test('later unit switches retain the execution clock and calendar values edited in the draft', async () => {
            const { widget, plan } = await editor(trigger);
            change(widget, '#tm-frequency-interval-unit', 'month');
            selectCalendar(widget, 'dates', 30, false);
            selectCalendar(widget, 'dates', 15);
            change(widget, '#tm-cron-hour', '10');
            change(widget, '#tm-cron-minute', '20');
            change(widget, '#tm-frequency-interval-unit', 'year');
            expect(widget.querySelector('#tm-frequency-months-options [data-calendar-value="10"]').checked).toBe(true);
            selectCalendar(widget, 'months', 10, false);
            selectCalendar(widget, 'months', 3);
            change(widget, '#tm-frequency-interval-unit', 'hour');
            change(widget, '#tm-frequency-interval-unit', 'year');
            expect(widget.querySelector('#tm-cron-hour').value).toBe('10');
            expect(widget.querySelector('#tm-cron-minute').value).toBe('20');
            await widget._saveEdit(plan);
            expect(
                (call.mock.calls.find((args: any[]) => args[0] === 'updateGlobalTodo')?.[2] as any)?.trigger.recurrence
            ).toEqual({
                mode: 'interval',
                intervalValue: 2,
                intervalUnit: 'year',
                anchorAt: nextRun,
                time: '10:20',
                days: [15],
                months: [3]
            });
        });

        test('returning to hourly units retains the next execution anchor without calendar-only fields', async () => {
            const { widget, plan } = await editor(trigger);
            change(widget, '#tm-frequency-interval-unit', 'week');
            change(widget, '#tm-frequency-interval-unit', 'hour');
            await widget._saveEdit(plan);
            const saved = (call.mock.calls.find((args: any[]) => args[0] === 'updateGlobalTodo')?.[2] as any)?.trigger;
            expect(saved.recurrence).toEqual({
                mode: 'interval',
                intervalValue: 2,
                intervalUnit: 'hour',
                anchorAt: nextRun
            });
            expect(getNextTodoRecurrenceRuns(saved.recurrence, saved.timezone, 1)[0]?.toISOString()).toBe(nextRun);
        });

        test.each([
            ['structured', { intervalValue: 2, intervalUnit: 'hour' }],
            ['legacy', { intervalHours: 2 }]
        ] as const)('returning to hourly units retains the original %s weekday filter', async (_kind, interval) => {
            const { widget, plan } = await editor({
                ...trigger,
                recurrence: {
                    mode: 'interval',
                    ...interval,
                    anchorAt: trigger.recurrence.anchorAt,
                    weekdays: [1, 3]
                }
            });
            change(widget, '#tm-frequency-interval-unit', 'day');
            change(widget, '#tm-frequency-interval-unit', 'hour');
            await widget._saveEdit(plan);
            const saved = (call.mock.calls.find((args: any[]) => args[0] === 'updateGlobalTodo')?.[2] as any)?.trigger;
            expect(saved.recurrence).toEqual({
                mode: 'interval',
                intervalValue: 2,
                intervalUnit: 'hour',
                anchorAt: '2026-11-02T01:37:00.000Z',
                weekdays: [1, 3]
            });
        });

        test('an untouched hourly weekday filter follows the next execution date in the selected timezone', async () => {
            jest.setSystemTime(new Date('2026-10-26T21:38:00.000Z'));
            const { widget, plan } = await editor({
                ...trigger,
                recurrence: {
                    ...trigger.recurrence,
                    anchorAt: '2026-10-26T21:37:00.000Z',
                    weekdays: [1]
                }
            });
            change(widget, '#tm-edit-timezone', 'Asia/Shanghai');
            change(widget, '#tm-frequency-interval-unit', 'week');
            expect(widget.querySelector('#tm-cron-hour').value).toBe('7');
            expect(widget.querySelector('#tm-cron-minute').value).toBe('37');
            expect(widget.querySelector('[data-day-scope="period"][data-weekday="2"]').checked).toBe(true);
            expect(widget.querySelector('[data-day-scope="period"][data-weekday="1"]').checked).toBe(false);
            await widget._saveEdit(plan);
            const saved = (call.mock.calls.find((args: any[]) => args[0] === 'updateGlobalTodo')?.[2] as any)?.trigger;
            expect(saved.recurrence).toEqual({
                mode: 'interval',
                intervalValue: 2,
                intervalUnit: 'week',
                anchorAt: '2026-10-26T23:37:00.000Z',
                time: '07:37',
                weekdays: [2]
            });
            expect(getNextTodoRecurrenceRuns(saved.recurrence, saved.timezone, 1)[0]?.toISOString()).toBe(
                '2026-10-26T23:37:00.000Z'
            );
        });

        test('changing a calendar interval to hourly units starts at its original next execution', async () => {
            const { widget, plan } = await editor({
                ...trigger,
                recurrence: {
                    mode: 'interval',
                    intervalValue: 2,
                    intervalUnit: 'day',
                    anchorAt: trigger.recurrence.anchorAt,
                    time: '09:15'
                }
            });
            change(widget, '#tm-frequency-interval-unit', 'hour');
            await widget._saveEdit(plan);
            const saved = (call.mock.calls.find((args: any[]) => args[0] === 'updateGlobalTodo')?.[2] as any)?.trigger;
            expect(saved.recurrence).toEqual({
                mode: 'interval',
                intervalValue: 2,
                intervalUnit: 'hour',
                anchorAt: '2026-10-31T09:15:00.000Z'
            });
            expect(getNextTodoRecurrenceRuns(saved.recurrence, saved.timezone, 1)[0]?.toISOString()).toBe(
                '2026-10-31T09:15:00.000Z'
            );
        });

        test('retains the second occurrence of a repeated wall time after saving and reopening', async () => {
            jest.setSystemTime(new Date('2026-11-01T05:45:00.000Z'));
            const { widget, plan } = await editor({
                ...trigger,
                timezone: 'America/New_York',
                recurrence: {
                    ...trigger.recurrence,
                    intervalValue: 1,
                    anchorAt: '2026-10-31T00:30:00.000Z'
                }
            });
            change(widget, '#tm-frequency-interval-unit', 'day');
            expect(widget.querySelector('#tm-cron-hour').value).toBe('1');
            expect(widget.querySelector('#tm-cron-minute').value).toBe('30');
            await widget._saveEdit(plan);
            const saved = (call.mock.calls.find((args: any[]) => args[0] === 'updateGlobalTodo')?.[2] as any)?.trigger;
            expect(saved.recurrence).toEqual({
                mode: 'interval',
                intervalValue: 1,
                intervalUnit: 'day',
                anchorAt: '2026-11-01T06:30:00.000Z',
                time: '01:30'
            });
            expect(getNextTodoRecurrenceRuns(saved.recurrence, saved.timezone, 1)[0]?.toISOString()).toBe(
                '2026-11-01T06:30:00.000Z'
            );
            call.mockClear();
            const reopened = await editor(saved);
            await reopened.widget._saveEdit(reopened.plan);
            expect(
                (call.mock.calls.find((args: any[]) => args[0] === 'updateGlobalTodo')?.[2] as any)?.trigger
            ).toEqual(saved);
        });

        test('later unit changes keep the chosen anchor after its original next execution has passed', async () => {
            const { widget, plan } = await editor(trigger);
            change(widget, '#tm-frequency-interval-unit', 'day');
            jest.setSystemTime(new Date('2026-10-30T01:40:00.000Z'));
            change(widget, '#tm-frequency-interval-unit', 'month');
            await widget._saveEdit(plan);
            const saved = (call.mock.calls.find((args: any[]) => args[0] === 'updateGlobalTodo')?.[2] as any)?.trigger;
            expect(saved.recurrence).toEqual({
                mode: 'interval',
                intervalValue: 2,
                intervalUnit: 'month',
                anchorAt: nextRun,
                time: '01:37',
                days: [30]
            });
        });

        test('unit changes do not restore calendar values explicitly cleared in the draft', async () => {
            const { widget, plan } = await editor(trigger);
            change(widget, '#tm-frequency-interval-unit', 'year');
            selectCalendar(widget, 'dates', 30, false);
            selectCalendar(widget, 'months', 10, false);
            change(widget, '#tm-frequency-interval-unit', 'week');
            selectWeekday(widget, 'period', 5, false);
            change(widget, '#tm-frequency-interval-unit', 'hour');
            change(widget, '#tm-frequency-interval-unit', 'week');
            expect(widget.querySelectorAll('[data-day-scope="period"][data-weekday]:checked')).toHaveLength(0);
            change(widget, '#tm-frequency-interval-unit', 'year');
            expect(widget.querySelectorAll('#tm-frequency-dates-options [data-calendar-value]:checked')).toHaveLength(
                0
            );
            expect(widget.querySelectorAll('#tm-frequency-months-options [data-calendar-value]:checked')).toHaveLength(
                0
            );
            await widget._saveEdit(plan);
            expect(call.mock.calls.find((args: any[]) => args[0] === 'updateGlobalTodo')).toBeUndefined();
            expect(widget.querySelector('#tm-frequency-validation-error').hidden).toBe(false);
        });

        test('unit changes preserve the multiple calendar values from an existing interval', async () => {
            const { widget, plan } = await editor({
                ...trigger,
                recurrence: {
                    mode: 'interval',
                    intervalValue: 3,
                    intervalUnit: 'year',
                    anchorAt: '2026-01-01T00:00:00.000Z',
                    time: '12:17',
                    months: [2, 6],
                    days: [5, 29]
                }
            });
            change(widget, '#tm-frequency-interval-unit', 'month');
            change(widget, '#tm-frequency-interval-unit', 'year');
            await widget._saveEdit(plan);
            expect(
                (call.mock.calls.find((args: any[]) => args[0] === 'updateGlobalTodo')?.[2] as any)?.trigger.recurrence
            ).toEqual({
                mode: 'interval',
                intervalValue: 3,
                intervalUnit: 'year',
                anchorAt: '2029-02-05T12:17:00.000Z',
                time: '12:17',
                months: [2, 6],
                days: [5, 29]
            });
        });

        test('unit changes replace implicit legacy calendar defaults with the next local execution date', async () => {
            const { widget, plan } = await editor({
                ...trigger,
                recurrence: {
                    mode: 'interval',
                    intervalValue: 2,
                    intervalUnit: 'month',
                    anchorAt: '2026-10-20T01:37:00.000Z'
                }
            });
            change(widget, '#tm-edit-timezone', 'America/New_York');
            change(widget, '#tm-frequency-interval-unit', 'year');
            await widget._saveEdit(plan);
            const saved = (call.mock.calls.find((args: any[]) => args[0] === 'updateGlobalTodo')?.[2] as any)?.trigger;
            expect(saved.recurrence).toEqual({
                mode: 'interval',
                intervalValue: 2,
                intervalUnit: 'year',
                anchorAt: '2026-12-20T01:37:00.000Z',
                time: '20:37',
                days: [19],
                months: [12]
            });
            expect(getNextTodoRecurrenceRuns(saved.recurrence, saved.timezone, 1)[0]?.toISOString()).toBe(
                '2026-12-20T01:37:00.000Z'
            );
        });

        test('changing units on a new interval leaves its calendar selections empty', async () => {
            const { widget } = await editor();
            widget.querySelector('#tm-frequency-interval-tab').click();
            for (const unit of ['week', 'month', 'year']) {
                change(widget, '#tm-frequency-interval-unit', unit);
                expect(widget.querySelectorAll('[data-day-scope="period"][data-weekday]:checked')).toHaveLength(0);
                expect(
                    widget.querySelectorAll('#tm-frequency-dates-options [data-calendar-value]:checked')
                ).toHaveLength(0);
                expect(
                    widget.querySelectorAll('#tm-frequency-months-options [data-calendar-value]:checked')
                ).toHaveLength(0);
            }
        });

        test('saving an hourly interval without a unit change keeps its original elapsed anchor', async () => {
            const { widget, plan } = await editor(trigger);
            await widget._saveEdit(plan);
            expect(
                (call.mock.calls.find((args: any[]) => args[0] === 'updateGlobalTodo')?.[2] as any)?.trigger
            ).toEqual(trigger);
        });
    });

    test.each(['day', 'week', 'month', 'year'])(
        'preserves old %s intervals until their execution details are edited',
        async (unit) => {
            const trigger = {
                type: 'cron',
                cronExpression: '* * * * *',
                timezone: 'Asia/Shanghai',
                recurrence: {
                    mode: 'interval',
                    intervalValue: 2,
                    intervalUnit: unit,
                    anchorAt: '2026-10-20T01:37:00.000Z'
                }
            };
            const { widget, plan } = await editor(trigger);
            expect(widget.querySelector('#tm-cron-hour').value).toBe('9');
            expect(widget.querySelector('#tm-cron-minute').value).toBe('37');
            if (unit === 'week')
                expect(widget.querySelector('[data-day-scope="period"][data-weekday="2"]').checked).toBe(true);
            if (unit === 'month' || unit === 'year')
                expect(widget.querySelector('#tm-frequency-dates-options [data-calendar-value="20"]').checked).toBe(
                    true
                );
            if (unit === 'year')
                expect(widget.querySelector('#tm-frequency-months-options [data-calendar-value="10"]').checked).toBe(
                    true
                );
            await widget._saveEdit(plan);
            expect(call.mock.calls.find((args: any[]) => args[0] === 'updateGlobalTodo')?.[2].trigger).toEqual(trigger);
        }
    );

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

    test('changing an old elapsed interval timezone keeps its elapsed execution rule', async () => {
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
        change(widget, '#tm-edit-timezone', 'UTC');
        expect(widget.querySelector('#tm-cron-hour').value).toBe('9');
        expect(widget.querySelector('#tm-cron-minute').value).toBe('37');
        await widget._saveEdit(plan);
        const saved = (call.mock.calls.find((args: any[]) => args[0] === 'updateGlobalTodo')?.[2] as any)?.trigger;
        expect(saved).toMatchObject({
            timezone: 'UTC',
            recurrence: {
                mode: 'interval',
                intervalValue: 2,
                intervalUnit: 'day',
                anchorAt: trigger.recurrence.anchorAt
            }
        });
        expect(saved.recurrence.time).toBeUndefined();
    });

    test('changing an old elapsed interval value preserves explicit weekday filters', async () => {
        const trigger = {
            type: 'cron',
            cronExpression: '* * * * *',
            timezone: 'UTC',
            recurrence: {
                mode: 'interval',
                intervalValue: 2,
                intervalUnit: 'week',
                weekdays: [1, 3],
                anchorAt: '2026-10-19T01:37:00.000Z'
            }
        };
        const { widget, plan } = await editor(trigger);
        change(widget, '#tm-frequency-hours', '3');
        await widget._saveEdit(plan);
        const saved = (call.mock.calls.find((args: any[]) => args[0] === 'updateGlobalTodo')?.[2] as any)?.trigger;
        expect(saved.recurrence).toEqual({
            mode: 'interval',
            intervalValue: 3,
            intervalUnit: 'week',
            weekdays: [1, 3],
            anchorAt: trigger.recurrence.anchorAt
        });
    });

    test('preserves structured hourly interval weekday filters when editing its value', async () => {
        const trigger = {
            type: 'cron',
            cronExpression: '* * * * *',
            timezone: 'UTC',
            recurrence: {
                mode: 'interval',
                intervalValue: 5,
                intervalUnit: 'hour',
                weekdays: [1, 3],
                anchorAt: '2026-10-19T01:37:00.000Z'
            }
        };
        const { widget, plan } = await editor(trigger);
        change(widget, '#tm-frequency-hours', '6');
        await widget._saveEdit(plan);
        const saved = (call.mock.calls.find((args: any[]) => args[0] === 'updateGlobalTodo')?.[2] as any)?.trigger;
        expect(saved.recurrence).toEqual({
            mode: 'interval',
            intervalValue: 6,
            intervalUnit: 'hour',
            weekdays: [1, 3],
            anchorAt: trigger.recurrence.anchorAt
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
        expect(
            [...widget.querySelectorAll('#tm-frequency-months-options [data-calendar-value]:checked')].map(
                (input: any) => Number(input.dataset.calendarValue)
            )
        ).toEqual([2, 6]);
        expect(
            [...widget.querySelectorAll('#tm-frequency-dates-options [data-calendar-value]:checked')].map(
                (input: any) => Number(input.dataset.calendarValue)
            )
        ).toEqual([5, 29]);
        await widget._saveEdit(plan);
        expect(call.mock.calls.find((args: any[]) => args[0] === 'updateGlobalTodo')?.[2].trigger).toEqual(trigger);
    });

    test('new recurring modes start without preselected calendar values', async () => {
        const { widget } = await editor();
        choosePeriod(widget, 'weekly');
        expect(widget.querySelectorAll('#tm-frequency-period-day-options input[data-weekday]:checked')).toHaveLength(0);
        choosePeriod(widget, 'monthly');
        expect(widget.querySelectorAll('#tm-frequency-dates-options input[data-calendar-value]:checked')).toHaveLength(
            0
        );
        choosePeriod(widget, 'yearly');
        expect(widget.querySelectorAll('#tm-frequency-months-options input[data-calendar-value]:checked')).toHaveLength(
            0
        );
        expect(widget.querySelectorAll('#tm-frequency-dates-options input[data-calendar-value]:checked')).toHaveLength(
            0
        );
    });

    test.each(['weekly', 'biweekly', 'monthly', 'yearly', 'interval'])(
        'only reports an incomplete %s selection when saving',
        async (mode) => {
            const { widget } = await editor();
            if (mode === 'interval') widget.querySelector('#tm-frequency-interval-tab').click();
            else choosePeriod(widget, mode);
            const preview = widget.querySelector('#tm-cron-preview');
            if (mode === 'interval') change(widget, '#tm-frequency-hours', '0');
            expect(preview.hidden).toBe(true);
            if (mode === 'monthly') selectCalendar(widget, 'dates', 1, false);
            else if (mode === 'yearly') selectCalendar(widget, 'months', 1, false);
            else if (mode !== 'interval') {
                for (let day = 0; day < 7; day++) selectWeekday(widget, 'period', day, false);
            }

            expect(preview.hidden).toBe(true);
            expect(preview.textContent).toBe('');
            expect(widget.querySelector('#tm-frequency-validation-error').hidden).toBe(true);
            await widget._saveEdit(null);
            expect(createdTrigger()).toBeUndefined();
            expect(widget.querySelector('#tm-frequency-validation-error').hidden).toBe(false);

            if (mode === 'monthly') selectCalendar(widget, 'dates', 1);
            else if (mode === 'yearly') {
                selectCalendar(widget, 'months', 1);
                selectCalendar(widget, 'dates', 1);
            } else if (mode === 'interval') change(widget, '#tm-frequency-hours', '1');
            else selectWeekday(widget, 'period', 1, true);
            expect(preview.hidden).toBe(false);
            expect(preview.textContent).not.toBe('');
            await widget._saveEdit(null);
            expect(createdTrigger().recurrence.mode).toBe(mode);
        }
    );

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

    test('an unsupported saved rule remains intact and its formula stays hidden', async () => {
        const trigger = { type: 'cron', cronExpression: '0 9-17 * * 1-5', timezone: 'UTC' };
        const { widget, plan } = await editor(trigger);
        expect(widget.querySelector('#tm-detail-scroll').textContent).not.toContain(trigger.cronExpression);
        await widget._saveEdit(plan);
        expect(call.mock.calls.find((args: any[]) => args[0] === 'updateGlobalTodo')?.[2].trigger).toEqual(trigger);
    });

    test('opens the period list with ArrowDown and closes it with Escape', async () => {
        const { widget } = await editor();
        const trigger = widget.querySelector('#tm-frequency-period-trigger');
        const arrow = new Event('keydown', { bubbles: true });
        Object.defineProperty(arrow, 'key', { value: 'ArrowDown' });
        trigger.dispatchEvent(arrow);
        expect(widget.querySelector('#tm-frequency-period-options').hidden).toBe(false);
        const escape = new Event('keydown', { bubbles: true });
        Object.defineProperty(escape, 'key', { value: 'Escape' });
        trigger.dispatchEvent(escape);
        expect(widget.querySelector('#tm-frequency-period-options').hidden).toBe(true);
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
        expect(createdTrigger().recurrence).toEqual({
            mode: 'yearly',
            time: '09:00',
            months: [6, 12],
            days: [15]
        });
    });

    test('editing an old scalar yearly rule preserves it until its frequency changes', async () => {
        const trigger = {
            type: 'cron',
            cronExpression: '* * * * *',
            timezone: 'UTC',
            recurrence: {
                mode: 'yearly',
                time: '09:00',
                month: 6,
                day: 5
            }
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
            recurrence: {
                mode: 'yearly',
                time: '09:00',
                months: [2, 6, 12],
                days: [1, 15, 31]
            }
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

    test.each([
        ['monthly', '#tm-frequency-day', '#tm-frequency-dates-options', '[data-calendar-select-all="dates"]'],
        ['yearly', '#tm-frequency-month', '#tm-frequency-months-options', '[data-calendar-select-all="months"]'],
        ['weekly', '[data-days-toggle="period"]', '#tm-frequency-period-day-options', '[data-select-all="period"]']
    ])(
        'uses a single dropdown bar and checkbox list for %s',
        async (mode, triggerSelector, menuSelector, allSelector) => {
            const { widget } = await editor();
            choosePeriod(widget, mode);
            const trigger = widget.querySelector(triggerSelector);
            expect(trigger.tagName).toBe('BUTTON');
            expect(trigger.querySelector('.tm-frequency-chip')).toBeNull();
            expect(widget.querySelector('[data-remove-weekday], [data-remove-calendar-value]')).toBeNull();
            trigger.click();
            expect(widget.querySelector(menuSelector).hidden).toBe(false);
            expect(widget.querySelector(allSelector).tagName).toBe('INPUT');
            expect(widget.querySelector(allSelector).getAttribute('type')).toBe('checkbox');
        }
    );

    test('select-all checkbox can select and clear the full date list', async () => {
        const { widget } = await editor();
        choosePeriod(widget, 'monthly');
        widget.querySelector('#tm-frequency-day').click();
        let selectAll = widget.querySelector('[data-calendar-select-all="dates"]');
        expect(selectAll.indeterminate).toBe(false);
        selectAll.checked = true;
        selectAll.dispatchEvent(new Event('change', { bubbles: true }));
        selectAll = widget.querySelector('[data-calendar-select-all="dates"]');
        expect(selectAll.checked).toBe(true);
        expect(selectAll.indeterminate).toBe(false);
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

    test.each([
        ['yearly', '[data-calendar-select-all="months"]', '#tm-frequency-month', '#tm-frequency-months-options', 12],
        ['weekly', '[data-select-all="period"]', '[data-days-toggle="period"]', '#tm-frequency-period-day-options', 7]
    ])('synchronizes all checkbox states for %s', async (mode, allSelector, triggerSelector, menuSelector, count) => {
        const { widget } = await editor();
        if (mode === 'interval') widget.querySelector('#tm-frequency-interval-tab').click();
        else choosePeriod(widget, mode as string);
        widget.querySelector(triggerSelector).click();
        const menu = widget.querySelector(menuSelector);
        const all = widget.querySelector(allSelector);
        all.checked = true;
        all.dispatchEvent(new Event('change', { bubbles: true }));
        expect(Array.from(menu.querySelectorAll('input')).filter((input: any) => input.checked)).toHaveLength(
            Number(count) + 1
        );
        expect(all.indeterminate).toBe(false);
        expect(menu.hidden).toBe(false);
        all.checked = false;
        all.dispatchEvent(new Event('change', { bubbles: true }));
        expect(Array.from(menu.querySelectorAll('input')).filter((input: any) => input.checked)).toHaveLength(0);
        await widget._saveEdit(null);
        expect(createdTrigger()).toBeUndefined();
    });
});
