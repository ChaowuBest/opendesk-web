import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

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

    async function editor(trigger?: any): Promise<{ widget: any; plan: any }> {
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
        widget._applyLocaleSetting({ locale: 'en-US' });
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
        await widget._saveEdit(null);
        expect(createdTrigger().recurrence).toMatchObject({
            mode,
            [kind === 'dates' ? 'days' : 'months']: [1, Number(value)]
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
        expect(createdTrigger().recurrence).toMatchObject({ mode: 'yearly', months: [1, 6], days: [1, 15] });
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
        expect(createdTrigger().recurrence).toMatchObject({ mode: 'yearly', months: [1, 2, 6], days: [1, 15] });
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
        expect(widget.querySelector('#tm-edit-error').hidden).toBe(true);
        await widget._saveEdit(null);
        expect(createdTrigger()).toBeUndefined();
        expect(widget.querySelector('#tm-edit-error').hidden).toBe(false);
    });

    test('yearly keyboard navigation returns from dates to months before returning to frequency', async () => {
        const { widget } = await editor();
        widget.connectedCallback = () => undefined;
        document.body.append(widget);
        try {
            choosePeriod(widget, 'yearly');
            selectCalendar(widget, 'months', 2);
            const month = widget.querySelector('#tm-frequency-months-options [data-calendar-value="2"]');
            const date = widget.querySelector('#tm-frequency-dates-options [data-calendar-value="1"]');
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
        ['weekly', '#tm-frequency-period-day-options', '[data-weekday="1"]'],
        ['monthly', '#tm-frequency-dates-options', '[data-calendar-value="1"]'],
        ['yearly', '#tm-frequency-months-options', '[data-calendar-value="1"]']
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
        await widget._saveEdit(null);
        expect(createdTrigger()).toMatchObject({ type: 'cron', recurrence });
    });

    test('stores the biweekly calendar anchor and selected weekdays', async () => {
        const { widget } = await editor();
        choosePeriod(widget, 'biweekly');
        change(widget, '#tm-frequency-anchor-week', '2026-10-19');
        await widget._saveEdit(null);
        expect(createdTrigger().recurrence).toEqual({
            mode: 'biweekly',
            time: '09:00',
            weekdays: [1, 2, 3, 4, 5],
            anchorDate: '2026-10-19'
        });
    });

    test('interval checkbox selection persists the chosen weekdays and hourly interval', async () => {
        const { widget } = await editor();
        widget.querySelector('#tm-frequency-interval-tab').click();
        selectWeekday(widget, 'interval', 0, false);
        change(widget, '#tm-frequency-hours', '5');
        await widget._saveEdit(null);
        expect(createdTrigger().recurrence).toMatchObject({
            mode: 'interval',
            intervalHours: 5,
            weekdays: [1, 2, 3, 4, 5, 6]
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

    test('rejects an interval without weekdays before saving', async () => {
        const { widget } = await editor();
        widget.querySelector('#tm-frequency-interval-tab').click();
        for (let day = 0; day < 7; day++) selectWeekday(widget, 'interval', day, false);
        await widget._saveEdit(null);
        expect(createdTrigger()).toBeUndefined();
        expect(widget.querySelector('#tm-edit-error').hidden).toBe(false);
    });

    test.each(['weekly', 'biweekly', 'monthly', 'yearly', 'interval'])(
        'only reports an incomplete %s selection when saving',
        async (mode) => {
            const { widget } = await editor();
            if (mode === 'interval') widget.querySelector('#tm-frequency-interval-tab').click();
            else choosePeriod(widget, mode);
            const preview = widget.querySelector('#tm-cron-preview');
            expect(preview.hidden).toBe(false);
            if (mode === 'monthly') selectCalendar(widget, 'dates', 1, false);
            else if (mode === 'yearly') selectCalendar(widget, 'months', 1, false);
            else {
                for (let day = 0; day < 7; day++)
                    selectWeekday(widget, mode === 'interval' ? 'interval' : 'period', day, false);
            }

            expect(preview.hidden).toBe(true);
            expect(preview.textContent).toBe('');
            expect(widget.querySelector('#tm-edit-error').hidden).toBe(true);
            await widget._saveEdit(null);
            expect(createdTrigger()).toBeUndefined();
            expect(widget.querySelector('#tm-edit-error').hidden).toBe(false);

            if (mode === 'monthly') selectCalendar(widget, 'dates', 1);
            else if (mode === 'yearly') selectCalendar(widget, 'months', 1);
            else selectWeekday(widget, mode === 'interval' ? 'interval' : 'period', 1, true);
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
            months: [1, 6, 12],
            days: [1, 15]
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
        expect(widget.querySelector('#tm-edit-error').hidden).toBe(false);
    });

    test('requires at least one month for a yearly rule', async () => {
        const { widget } = await editor();
        choosePeriod(widget, 'yearly');
        selectCalendar(widget, 'months', 1, false);
        await widget._saveEdit(null);
        expect(createdTrigger()).toBeUndefined();
        expect(widget.querySelector('#tm-edit-error').hidden).toBe(false);
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
        expect(selectAll.indeterminate).toBe(true);
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
        expect(widget.querySelector('#tm-edit-error').hidden).toBe(false);
    });

    test('selected values update in the collapsed bar after checkbox changes', async () => {
        const { widget } = await editor();
        choosePeriod(widget, 'yearly');
        selectCalendar(widget, 'months', 6);
        selectCalendar(widget, 'dates', 15);
        expect(widget.querySelector('#tm-frequency-month').textContent).toContain('Jun');
        expect(widget.querySelector('#tm-frequency-day').textContent).toContain('15');
        await widget._saveEdit(null);
        expect(createdTrigger().recurrence).toMatchObject({ months: [1, 6], days: [1, 15] });
    });

    test.each([
        ['yearly', '[data-calendar-select-all="months"]', '#tm-frequency-month', '#tm-frequency-months-options', 12],
        ['weekly', '[data-select-all="period"]', '[data-days-toggle="period"]', '#tm-frequency-period-day-options', 7],
        [
            'interval',
            '[data-select-all="interval"]',
            '[data-days-toggle="interval"]',
            '#tm-frequency-interval-day-options',
            7
        ]
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
