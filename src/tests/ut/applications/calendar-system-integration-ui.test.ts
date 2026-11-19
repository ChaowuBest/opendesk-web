import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

describe('shared calendar system integration controls', () => {
    let widget: any;
    let state: any;
    let api: any;
    let change: () => void;
    let items: any[];

    async function settle() {
        for (let turn = 0; turn < 4; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
    }

    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><head></head><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            customElements: window.customElements,
            requestAnimationFrame: () => 0
        });
        await import('../../../main/applications/calendar/renderer/entry.js');
    });

    beforeEach(() => {
        items = [];
        state = {
            supported: true,
            readGranted: false,
            writeGranted: false,
            enabled: true,
            defaultCalendarId: '',
            calendars: []
        };
        api = {
            call: jest.fn(async (method: string) => {
                if (method === 'getCalendarItemsInRange') return items;
                return {};
            }),
            callMainWorld: jest.fn(async (method: string, patch?: any) => {
                if (method === 'requestCalendarAccess') state = { ...state, readGranted: true, writeGranted: true };
                if (method === 'configureCalendarIntegration') state = { ...state, ...patch };
                return state;
            }),
            subscribe: jest.fn(async (_name: string, callback: () => void) => {
                change = callback;
            }),
            unsubscribe: jest.fn(async () => {})
        };
        (window as any).applicationAPI = api;
        (window as any).settingAPI = { loadSettingObject: jest.fn(async () => ({ locale: 'zh-CN' })) };
    });

    afterEach(async () => {
        widget?.remove();
        await settle();
        jest.restoreAllMocks();
    });

    async function mount() {
        widget = document.createElement('calendar-entry-widget');
        document.body.appendChild(widget);
        await settle();
    }

    test('unsupported hosts keep the local calendar without showing integration or requesting access', async () => {
        state.supported = false;
        await mount();
        expect(widget.querySelector('#cal-system-integration')?.hidden).toBe(true);
        expect(api.callMainWorld.mock.calls).toEqual([['getCalendarIntegrationState']]);
        expect(api.call.mock.calls.every(([method]: string[]) => method === 'getCalendarItemsInRange')).toBe(true);
    });

    test('access is requested only from an explicit click and refusal remains visible', async () => {
        await mount();
        expect(widget.querySelector('#cal-system-integration')?.hidden).toBe(false);
        expect(api.callMainWorld).not.toHaveBeenCalledWith('requestCalendarAccess');
        api.callMainWorld.mockImplementation(async () => state);
        widget.querySelector('#cal-system-authorize').click();
        expect(api.callMainWorld).toHaveBeenCalledWith('requestCalendarAccess');
        await settle();
        expect(widget.querySelector('#cal-system-integration').textContent).toContain('未授权');
        expect(widget.querySelector('#cal-system-authorize').disabled).toBe(false);
        expect(api.call.mock.calls.every(([method]: string[]) => method === 'getCalendarItemsInRange')).toBe(true);
    });

    test('granting access refreshes permissions without automatically changing the local save destination', async () => {
        await mount();
        widget.querySelector('#cal-system-authorize').click();
        await settle();
        expect(widget.querySelector('#cal-system-authorize')).toBeNull();
        expect(widget.querySelector('#cal-system-integration').textContent).toContain('已授权');
        expect(state.defaultCalendarId).toBe('');
        expect(api.callMainWorld).not.toHaveBeenCalledWith('configureCalendarIntegration', expect.anything());
    });

    test('shows escaped calendar names, disables read-only destinations and saves only the integration patch', async () => {
        state = {
            ...state,
            readGranted: true,
            writeGranted: true,
            calendars: [
                { id: 'work', name: '<Work>', accountName: 'Alice', canWrite: true },
                { id: 'shared', name: 'Shared', canWrite: false }
            ]
        };
        await mount();
        const destination = widget.querySelector('#cal-system-destination');
        expect(destination.querySelector('option[value=""]').textContent).toContain('本地');
        expect(destination.querySelector('option[value="work"]').textContent).toContain('<Work>');
        expect(destination.querySelector('option[value="shared"]').hasAttribute('disabled')).toBe(true);
        expect(widget.querySelector('#cal-system-integration work')).toBeNull();
        destination.querySelector('option[value="work"]').selected = true;
        destination.dispatchEvent(new window.Event('change'));
        await settle();
        expect(api.callMainWorld).toHaveBeenCalledWith('configureCalendarIntegration', { defaultCalendarId: 'work' });
        const enabled = widget.querySelector('#cal-system-enabled');
        enabled.checked = false;
        enabled.dispatchEvent(new window.Event('change'));
        await settle();
        expect(api.callMainWorld).toHaveBeenCalledWith('configureCalendarIntegration', { enabled: false });
        expect((window as any).settingAPI.saveSettingObject).toBeUndefined();
    });

    test('a configured system destination that becomes unavailable is not displayed as the local default', async () => {
        state.defaultCalendarId = 'missing';
        await mount();
        const option = widget.querySelector('#cal-system-destination option[value="missing"]');
        expect(option.hasAttribute('selected')).toBe(true);
        expect(option.hasAttribute('disabled')).toBe(true);
        expect(option.textContent).toContain('不可用');
        expect(widget.querySelector('#cal-system-destination option[value=""]').hasAttribute('selected')).toBe(false);
    });

    test('calendar changes and returning to the page refresh both permissions and events', async () => {
        await mount();
        api.call.mockClear();
        api.callMainWorld.mockClear();
        state = { ...state, readGranted: true, writeGranted: false };
        change();
        await settle();
        expect(api.callMainWorld).toHaveBeenCalledWith('getCalendarIntegrationState');
        expect(api.call).toHaveBeenCalledWith('getCalendarItemsInRange', expect.any(Number), expect.any(Number));
        expect(widget.querySelector('#cal-system-integration').textContent).toContain('只读');
        api.callMainWorld.mockClear();
        window.dispatchEvent(new window.Event('focus'));
        await settle();
        expect(api.callMainWorld).toHaveBeenCalledWith('getCalendarIntegrationState');
    });

    test('a failed refresh keeps prior events and shows a localized failure instead of an empty calendar', async () => {
        await mount();
        const now = Date.now();
        items = [{ uid: 'local-event', subject: 'Keep this event', startTime: now, endTime: now + 3600000 }];
        await widget._refreshAll();
        api.call.mockRejectedValueOnce(new Error('PERMISSION_DENIED'));
        await widget._refreshAll();
        expect(widget.querySelector('[data-detail-uid="local-event"]')?.textContent).toContain('Keep this event');
        expect(widget.querySelector('#cal-feedback')?.textContent).toContain('权限');
        expect(widget.querySelector('#cal-feedback')?.textContent).not.toContain('PERMISSION_DENIED');
    });

    test('save failures remain visible inside the open form and keep the entered title', async () => {
        await mount();
        widget._showModal(null);
        widget.querySelector('#cal-m-subject').value = 'Do not lose my title';
        api.call.mockRejectedValueOnce(new Error('PERMISSION_DENIED'));
        widget.querySelector('#cal-modal-save').click();
        await settle();
        expect(widget.querySelector('#cal-modal-error').textContent).toContain('权限');
        expect(widget.querySelector('#cal-m-subject').value).toBe('Do not lose my title');
        expect(widget.querySelector('#cal-modal').classList.contains('hidden')).toBe(false);
        widget.querySelector('#cal-modal-cancel').click();
    });

    test('recurring system events cannot be edited, deleted or dragged while local events remain editable', async () => {
        state = { ...state, readGranted: true, writeGranted: true };
        await mount();
        const now = Date.now();
        const recurring = {
            uid: 'system:1',
            source: 'system',
            recurring: true,
            subject: 'Weekly event',
            startTime: now,
            endTime: now + 3600000
        };
        items = [recurring, { ...recurring, uid: 'local-event', source: 'local' }];
        await widget._refreshAll();
        widget.selectedEvent = recurring;
        widget._renderDetail();
        expect(widget.querySelector('#cal-detail-edit').disabled).toBe(true);
        expect(widget.querySelector('#cal-detail-delete').disabled).toBe(true);
        expect(widget.querySelector('#cal-detail').textContent).toContain('重复日程');
        api.call.mockClear();
        widget._showModal(recurring);
        await widget._deleteEvent(recurring.uid);
        expect(api.call).not.toHaveBeenCalled();
        const event = widget.querySelector('[data-event-uid="system:1"]');
        const down = new window.Event('mousedown');
        Object.assign(down, { button: 0, clientX: 1, clientY: 1 });
        event.dispatchEvent(down);
        expect(widget._drag).toBeNull();
        widget.selectedEvent = items[1];
        widget._renderDetail();
        expect(widget.querySelector('#cal-detail-edit').disabled).toBe(false);
    });

    test('failed configuration uses a friendly error and does not replace the last valid state', async () => {
        state = { ...state, readGranted: true, writeGranted: true };
        await mount();
        api.callMainWorld.mockImplementation(async (method: string) => {
            if (method === 'configureCalendarIntegration') throw new Error('INVALID_ARGUMENT: calendarId');
            return state;
        });
        const enabled = widget.querySelector('#cal-system-enabled');
        enabled.checked = false;
        enabled.dispatchEvent(new window.Event('change'));
        await settle();
        expect(widget.querySelector('#cal-feedback').textContent).toContain('日历');
        expect(widget.querySelector('#cal-feedback').textContent).not.toContain('INVALID_ARGUMENT');
        expect(widget.querySelector('#cal-system-enabled').hasAttribute('checked')).toBe(true);
    });

    test('the selected renderer language applies to integration controls and permission errors', async () => {
        (window as any).settingAPI.loadSettingObject.mockResolvedValue({ locale: 'en-US' });
        await mount();
        expect(widget.querySelector('#cal-system-authorize').textContent).toBe('Allow access to system calendars');
        api.call.mockRejectedValueOnce(new Error('PERMISSION_DENIED'));
        await widget._refreshAll();
        expect(widget.querySelector('#cal-feedback').textContent).toContain('Grant access');
    });

    test('read-only system calendars protect single events as well as recurring events', async () => {
        state = { ...state, readGranted: true, writeGranted: true };
        await mount();
        const now = Date.now();
        const item = {
            uid: 'android:readonly:1:0',
            source: 'system',
            canWrite: false,
            subject: 'Shared event',
            startTime: now,
            endTime: now + 3600000
        };
        items = [item];
        await widget._refreshAll();
        widget.selectedEvent = item;
        widget._renderDetail();
        expect(widget.querySelector('#cal-detail-edit').disabled).toBe(true);
        expect(widget.querySelector('#cal-detail-delete').disabled).toBe(true);
        expect(widget.querySelector('#cal-detail').textContent).toContain('只读');
    });

    test('late integration responses do not update a detached page', async () => {
        await mount();
        let resolve!: (value: unknown) => void;
        api.callMainWorld.mockImplementationOnce(() => new Promise((done) => (resolve = done)));
        const refresh = widget._refreshAll();
        widget.remove();
        resolve({ ...state, readGranted: true });
        await refresh;
        expect(widget.querySelector('#cal-system-integration').textContent).toContain('未授权');
    });

    test('a stale permission response cannot overwrite a newer change event result', async () => {
        await mount();
        let resolve!: (value: unknown) => void;
        api.callMainWorld.mockImplementationOnce(() => new Promise((done) => (resolve = done)));
        const older = widget._refreshAll();
        state = { ...state, readGranted: true, writeGranted: true };
        change();
        await settle();
        resolve({ ...state, readGranted: false });
        await older;
        expect(widget.querySelector('#cal-system-integration').textContent).toContain('已授权');
        expect(widget.querySelector('#cal-system-authorize')).toBeNull();
    });

    test('switching months ignores an older event query that finishes after the current month', async () => {
        await mount();
        let complete!: (value: unknown) => void;
        api.call.mockImplementationOnce(() => new Promise((resolve) => (complete = resolve)));
        widget.currentDate = new Date(2026, 0, 15);
        const older = widget._refreshAll();
        widget.currentDate = new Date(2026, 3, 15);
        const current = {
            uid: 'april',
            subject: 'April event',
            startTime: +widget.currentDate,
            endTime: +widget.currentDate + 3600000
        };
        api.call.mockResolvedValueOnce([current]);
        await widget._refreshAll();
        complete([{ ...current, uid: 'january', subject: 'January event', startTime: +new Date(2026, 0, 15) }]);
        await older;
        expect(widget._findEvent('april')).toEqual(current);
        expect(widget._findEvent('january')).toBeNull();
        expect(widget.querySelector('[data-event-uid="april"]')?.textContent).toContain('April event');
    });

    test('an older event query failure cannot replace the current successful month with an error', async () => {
        await mount();
        let fail!: (error: Error) => void;
        api.call.mockImplementationOnce(() => new Promise((_resolve, reject) => (fail = reject)));
        const older = widget._refreshAll();
        await widget._refreshAll();
        fail(new Error('PERMISSION_DENIED'));
        await older;
        expect(widget.querySelector('#cal-feedback').hidden).toBe(true);
    });

    test('system event titles and locations remain literal text in every view, detail, form and drag confirmation', async () => {
        state = { ...state, readGranted: true, writeGranted: true };
        await mount();
        const start = new Date(widget.currentDate);
        start.setHours(10, 0, 0, 0);
        const subject = '<img data-calendar-payload="title" src=x onerror="alert(1)">';
        const location = '"><svg data-calendar-payload="location" onload="alert(1)"></svg>';
        const item = {
            uid: 'android:1:2:3',
            source: 'system',
            canWrite: true,
            subject,
            location,
            startTime: +start,
            endTime: +start + 3600000
        };
        for (const isAllDay of [false, true]) {
            for (const viewMode of ['month', 'week', 'day']) {
                items = [{ ...item, isAllDay }];
                widget.viewMode = viewMode;
                widget.selectedEvent = null;
                await widget._refreshAll();
                expect(widget.querySelectorAll('[data-calendar-payload]')).toHaveLength(0);
                expect(widget.querySelector('#cal-view').textContent).toContain(subject);
                widget.selectedEvent = items[0];
                widget._renderDetail();
                expect(widget.querySelectorAll('[data-calendar-payload]')).toHaveLength(0);
                expect(widget.querySelector('.cal-detail-card-title').textContent).toBe(subject);
                expect(widget.querySelector('#cal-detail').textContent).toContain(location);
            }
        }
        widget._showModal(item);
        expect(widget.querySelectorAll('[data-calendar-payload]')).toHaveLength(0);
        expect(widget.querySelector('#cal-m-subject').value).toBe(subject);
        expect(widget.querySelector('#cal-m-location').value).toBe(location);
        widget.querySelector('#cal-modal-cancel').click();
        widget._showDragConfirmModal(item, start, new Date(+start + 3600000));
        expect(widget.querySelectorAll('[data-calendar-payload]')).toHaveLength(0);
        expect(widget.querySelector('.cal-drag-subject').textContent).toBe(subject);
        widget.querySelector('#cal-drag-cancel').click();
    });

    test.each(['create', 'edit'])(
        'system %s forms submit an empty type while local forms preserve their category',
        async (operation) => {
            state = { ...state, readGranted: true, writeGranted: true, defaultCalendarId: 'work' };
            await mount();
            const now = Date.now();
            const systemEvent = {
                uid: 'android:work:2:3',
                source: 'system',
                canWrite: true,
                subject: 'System event',
                startTime: now,
                endTime: now + 3600000,
                type: 'meeting'
            };
            widget._showModal(operation === 'edit' ? systemEvent : null);
            expect(widget.querySelector('#cal-m-type').hasAttribute('disabled')).toBe(true);
            expect(widget.querySelectorAll('#cal-m-type option')).toHaveLength(1);
            widget.querySelector('#cal-m-subject').value = 'Save to system';
            widget.querySelector('#cal-modal-save').click();
            await settle();
            const call = api.call.mock.calls.find(
                ([method]: string[]) => method === (operation === 'edit' ? 'updateCalendarItem' : 'addCalendarItem')
            );
            expect(call?.at(-1)).toEqual(expect.objectContaining({ subject: 'Save to system', type: '' }));
            state = { ...state, defaultCalendarId: '' };
            await widget._refreshAll();
            widget._showModal({ ...systemEvent, uid: 'local', source: 'local', type: 'meeting' });
            expect(widget.querySelector('#cal-m-type').hasAttribute('disabled')).toBe(false);
            expect(widget.querySelector('#cal-m-type option[value="meeting"]').selected).toBe(true);
            widget.querySelector('#cal-modal-save').click();
            await settle();
            const local = api.call.mock.calls.find(
                ([method, uid]: string[]) => method === 'updateCalendarItem' && uid === 'local'
            );
            expect(local?.at(-1)).toEqual(expect.objectContaining({ type: 'meeting' }));
        }
    );

    test('unsupported system event types produce a specific localized message', async () => {
        await mount();
        widget._showCalendarError(new Error('CALENDAR_TYPE_UNSUPPORTED'));
        expect(widget.querySelector('#cal-feedback').textContent).toContain('分类');
        expect(widget.querySelector('#cal-feedback').textContent).not.toContain('CALENDAR_TYPE_UNSUPPORTED');
        widget._applyLocaleSetting({ locale: 'en-US' });
        widget._showCalendarError(new Error('CALENDAR_TYPE_UNSUPPORTED'));
        expect(widget.querySelector('#cal-feedback').textContent).toContain('do not support event categories');
        widget._showCalendarError(new Error('System calendars do not support event categories.'));
        expect(widget.querySelector('#cal-feedback').textContent).toContain('do not support event categories');
        widget._applyLocaleSetting({ locale: 'zh-CN' });
        widget._showCalendarError(new Error('系统日历不支持此日程分类，请选择默认分类'));
        expect(widget.querySelector('#cal-feedback').textContent).toContain('不支持日程分类');
    });

    test.each(['local', 'system'])(
        'a new all-day %s event saves from local midnight to the next calendar midnight',
        async (source) => {
            state = {
                ...state,
                readGranted: true,
                writeGranted: true,
                defaultCalendarId: source === 'system' ? 'work' : ''
            };
            await mount();
            widget.currentDate = new Date(2026, 2, 8, 12);
            widget._showModal(null);
            widget.querySelector('#cal-m-subject').value = 'All day';
            const allDay = widget.querySelector('#cal-m-allday');
            allDay.checked = true;
            allDay.dispatchEvent(new window.Event('change'));
            widget.querySelector('#cal-modal-save').click();
            await settle();
            const payload = api.call.mock.calls.find(([method]: string[]) => method === 'addCalendarItem')?.at(-1);
            expect(payload).toEqual(
                expect.objectContaining({
                    isAllDay: true,
                    startTime: +new Date(2026, 2, 8),
                    endTime: +new Date(2026, 2, 9)
                })
            );
            expect(payload.endTime).toBeGreaterThan(payload.startTime);
            if (process.env.TZ === 'America/New_York') expect(payload.endTime - payload.startTime).toBe(23 * 3600000);
        }
    );

    test.each(['local', 'system'])('editing only the title preserves a multi-day all-day %s event', async (source) => {
        state = { ...state, readGranted: true, writeGranted: true };
        await mount();
        const event = {
            uid: source === 'system' ? 'android:work:4:5' : 'local',
            source,
            canWrite: true,
            subject: 'Three days',
            isAllDay: true,
            startTime: +new Date(2026, 2, 7),
            endTime: +new Date(2026, 2, 10)
        };
        widget._showModal(event);
        expect(widget.querySelector('#cal-m-allday').checked).toBe(true);
        widget.querySelector('#cal-m-subject').value = 'Renamed only';
        widget.querySelector('#cal-modal-save').click();
        await settle();
        const payload = api.call.mock.calls.find(([method]: string[]) => method === 'updateCalendarItem')?.at(-1);
        expect(payload).toEqual(
            expect.objectContaining({
                isAllDay: true,
                subject: 'Renamed only',
                startTime: event.startTime,
                endTime: event.endTime
            })
        );
    });

    test.each(['local', 'system'])(
        'changing the date preserves a multi-day all-day %s event by calendar days',
        async (source) => {
            state = { ...state, readGranted: true, writeGranted: true };
            await mount();
            const event = {
                uid: source === 'system' ? 'android:work:4:5' : 'local',
                source,
                canWrite: true,
                subject: 'Three days',
                isAllDay: true,
                startTime: +new Date(2026, 2, 7),
                endTime: +new Date(2026, 2, 10)
            };
            widget._showModal(event);
            expect(widget.querySelector('#cal-m-allday').checked).toBe(true);
            widget.querySelector('#cal-m-date').value = '2026-10-31';
            widget.querySelector('#cal-modal-save').click();
            await settle();
            const payload = api.call.mock.calls.find(([method]: string[]) => method === 'updateCalendarItem')?.at(-1);
            expect(payload).toEqual(
                expect.objectContaining({
                    isAllDay: true,
                    startTime: +new Date(2026, 9, 31),
                    endTime: +new Date(2026, 10, 3)
                })
            );
            if (process.env.TZ === 'America/New_York') expect(payload.endTime - payload.startTime).toBe(73 * 3600000);
        }
    );
});
