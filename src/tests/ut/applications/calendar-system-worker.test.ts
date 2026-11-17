import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import Datastore from 'nedb-promises';
import CalendarWorker from '../../../main/applications/calendar/service/worker.js';
import AndroidCalendarWorker from '../../../main/applications/calendar/service/android-worker.js';
import { CalendarApplication } from '../../../main/applications/calendar/app.js';
import { configureHostRuntime } from '../../../platforms/runtime.js';
import type {
    CalendarItem,
    SystemCalendarPort,
    SystemCalendarState
} from '../../../main/applications/calendar/service/system-calendar.js';

const localInput = {
    subject: 'local',
    startTime: new Date('2026-11-17T10:00:00').getTime(),
    endTime: new Date('2026-11-17T11:00:00').getTime()
};
function nativeItem(patch: Partial<CalendarItem> = {}): CalendarItem {
    return {
        uid: 'android:7:42:' + localInput.startTime,
        ...localInput,
        subject: 'system',
        location: '',
        isAllDay: false,
        isCancelled: false,
        type: '',
        ...patch
    };
}

describe('Android Calendar Worker keeps local storage separate from the system provider', () => {
    let worker: AndroidCalendarWorker, state: SystemCalendarState, port: SystemCalendarPort;
    let release: () => void;
    beforeEach(() => {
        worker = new AndroidCalendarWorker('calendar', '/unused');
        worker.db = new Datastore({ inMemoryOnly: true });
        jest.spyOn(worker, 'emitEvent').mockResolvedValue(undefined);
        state = {
            supported: true,
            readGranted: true,
            writeGranted: true,
            calendars: [
                { id: '7', name: 'Work', canWrite: true },
                { id: '8', name: 'Read only', canWrite: false }
            ],
            revision: 1
        };
        port = {
            getState: jest.fn(async () => state),
            requestAccess: jest.fn(async () => {}),
            listEvents: jest.fn(async () => [nativeItem()]),
            addEvent: jest.fn(async (_id, input) => nativeItem(input)),
            updateEvent: jest.fn(async (uid, updates) => nativeItem({ uid, ...updates })),
            deleteEvent: jest.fn(async (uid) => ({ deleted: true, uid }))
        };
        release = configureHostRuntime({ systemCalendar: port });
    });
    afterEach(async () => {
        await worker.finalize();
        release();
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    test('merges normal local/native reads, marks their origin and never mirrors native data into NeDB', async () => {
        const local = await worker.addCalendarItem(localInput);
        const items = await worker.getCalendarItems('2026-11-17');
        expect(items).toHaveLength(2);
        expect(items.find((item: CalendarItem) => item.uid === local.uid)).toEqual(local);
        expect(items.find((item: CalendarItem) => item.uid.startsWith('android:'))).toMatchObject({
            source: 'system',
            sourceCalendarId: '7',
            canWrite: true
        });
        expect(await worker.db.find({})).toEqual([expect.objectContaining({ uid: local.uid })]);
        const start = new Date('2026-11-17T00:00:00').getTime(),
            end = new Date('2026-11-18T00:00:00').getTime();
        expect(port.listEvents).toHaveBeenCalledWith(start, end);
        expect(await worker.getCalendarItemsInRange(start, end)).toHaveLength(2);
    });

    test('defaults newly created items to local and preserves all existing local UID operations', async () => {
        const local = await worker.addCalendarItem(localInput);
        expect(local.uid).toMatch(/^local_/);
        expect(port.getState).not.toHaveBeenCalled();
        expect(await worker.updateCalendarItem(local.uid, { subject: 'edited local' })).toMatchObject({
            subject: 'edited local'
        });
        expect(await worker.deleteCalendarItem(local.uid)).toEqual({ deleted: true, uid: local.uid });
        expect(port.addEvent).not.toHaveBeenCalled();
        expect(port.updateEvent).not.toHaveBeenCalled();
        expect(port.deleteEvent).not.toHaveBeenCalled();
    });

    test.each([false, undefined])(
        'ungranted or absent native provider leaves ordinary local queries available (%s)',
        async (permission) => {
            if (permission === undefined) {
                release();
                release = configureHostRuntime();
            } else state.readGranted = false;
            const local = await worker.addCalendarItem(localInput);
            expect(await worker.getCalendarItems('2026-11-17')).toEqual([local]);
            expect(port.listEvents).not.toHaveBeenCalled();
            expect(await worker.getSystemCalendarState()).toMatchObject({
                supported: permission === undefined ? false : true,
                readGranted: false,
                enabled: true,
                defaultCalendarId: ''
            });
        }
    );

    test('disabling system integration hides native rows and rejects a selected native destination without local fallback', async () => {
        await worker.applicationConfigChanged({
            dataSources: { systemCalendar: { enabled: false, defaultCalendarId: '7' } }
        });
        expect(await worker.getCalendarItems('2026-11-17')).toEqual([]);
        expect(port.listEvents).not.toHaveBeenCalled();
        await expect(worker.addCalendarItem(localInput)).rejects.toMatchObject({ code: 'CALENDAR_DISABLED' });
        expect(await worker.db.count({})).toBe(0);
    });

    test('selected writable native destination writes through the port and publishes a change without a local copy', async () => {
        await worker.applicationConfigChanged({
            dataSources: { systemCalendar: { enabled: true, defaultCalendarId: '7' } }
        });
        const result = await worker.addCalendarItem(localInput);
        expect(port.addEvent).toHaveBeenCalledWith('7', localInput);
        expect(result).toMatchObject({ source: 'system', sourceCalendarId: '7', canWrite: true });
        expect(await worker.db.count({})).toBe(0);
        expect(worker.emitEvent).toHaveBeenCalledWith('calendarItemsChanged');
    });

    test('native UID edits/deletes ignore the new-item default destination and never fall back to local DB', async () => {
        const uid = nativeItem().uid;
        const localUpdate = jest.spyOn(worker.db, 'update'),
            localRemove = jest.spyOn(worker.db, 'remove');
        expect(await worker.updateCalendarItem(uid, { subject: 'new system title' })).toMatchObject({
            uid,
            subject: 'new system title',
            source: 'system'
        });
        expect(await worker.deleteCalendarItem(uid)).toEqual({ deleted: true, uid });
        expect(port.updateEvent).toHaveBeenCalledWith(uid, { subject: 'new system title' });
        expect(port.deleteEvent).toHaveBeenCalledWith(uid);
        expect(localUpdate).not.toHaveBeenCalled();
        expect(localRemove).not.toHaveBeenCalled();
    });

    test('native permission, readonly, missing-calendar and provider failures are explicit and do not create local items', async () => {
        await worker.applicationConfigChanged({
            dataSources: { systemCalendar: { enabled: true, defaultCalendarId: '7' } }
        });
        state.writeGranted = false;
        await expect(worker.addCalendarItem(localInput)).rejects.toMatchObject({ code: 'CALENDAR_PERMISSION_DENIED' });
        state.writeGranted = true;
        await worker.applicationConfigChanged({
            dataSources: { systemCalendar: { enabled: true, defaultCalendarId: '8' } }
        });
        await expect(worker.addCalendarItem(localInput)).rejects.toMatchObject({ code: 'CALENDAR_READ_ONLY' });
        await worker.applicationConfigChanged({
            dataSources: { systemCalendar: { enabled: true, defaultCalendarId: 'missing' } }
        });
        await expect(worker.addCalendarItem(localInput)).rejects.toMatchObject({ code: 'CALENDAR_NOT_FOUND' });
        await worker.applicationConfigChanged({
            dataSources: { systemCalendar: { enabled: true, defaultCalendarId: '7' } }
        });
        const failure = Object.assign(new Error('Provider write failed'), { code: 'CALENDAR_UNAVAILABLE' });
        (port.addEvent as jest.Mock).mockRejectedValueOnce(failure);
        await expect(worker.addCalendarItem(localInput)).rejects.toMatchObject({
            code: 'CALENDAR_UNAVAILABLE',
            cause: failure
        });
        expect(await worker.db.count({})).toBe(0);
        expect(worker.emitEvent).not.toHaveBeenCalled();
    });

    test('malformed native UIDs never route to the local calendar', async () => {
        await expect(worker.updateCalendarItem('android:invalid', { subject: 'x' })).rejects.toMatchObject({
            code: 'CALENDAR_INVALID_ARGUMENT'
        });
        await expect(worker.deleteCalendarItem('android:invalid')).rejects.toMatchObject({
            code: 'CALENDAR_INVALID_ARGUMENT'
        });
        expect(port.updateEvent).not.toHaveBeenCalled();
        expect(port.deleteEvent).not.toHaveBeenCalled();
    });

    test('recurring native instances remain readonly while native query errors remain visible', async () => {
        (port.listEvents as jest.Mock).mockResolvedValueOnce([nativeItem({ recurring: true })]);
        const item = (await worker.getCalendarItems('2026-11-17'))[0];
        expect(item).toMatchObject({ recurring: true, canWrite: false, source: 'system' });
        await expect(worker.updateCalendarItem(item.uid, { subject: 'blocked' })).rejects.toMatchObject({
            code: 'CALENDAR_RECURRING_UNSUPPORTED'
        });
        await expect(worker.deleteCalendarItem(item.uid)).rejects.toMatchObject({
            code: 'CALENDAR_RECURRING_UNSUPPORTED'
        });
        const failure = Object.assign(new Error('Read failed'), { code: 'CALENDAR_UNAVAILABLE' });
        (port.listEvents as jest.Mock).mockRejectedValueOnce(failure);
        await expect(worker.getCalendarItems('2026-11-17')).rejects.toMatchObject({
            code: 'CALENDAR_UNAVAILABLE',
            cause: failure
        });
    });

    test('system changes debounce the shared refresh event and finalize cancels a pending refresh', async () => {
        jest.useFakeTimers();
        worker.systemCalendarChanged(1);
        worker.systemCalendarChanged(2);
        expect(worker.emitEvent).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(250);
        expect(worker.emitEvent).toHaveBeenCalledTimes(1);
        expect(worker.emitEvent).toHaveBeenCalledWith('calendarItemsChanged');
        worker.systemCalendarChanged(3);
        await worker.finalize();
        await jest.advanceTimersByTimeAsync(250);
        expect(worker.emitEvent).toHaveBeenCalledTimes(1);
    });

    test('inherited reminders query only the local database, while permission request returns current integration state', async () => {
        await worker.addCalendarItem({ ...localInput, startTime: Date.now() + 60_000, endTime: Date.now() + 120_000 });
        expect(await worker.getUpcomingItems()).toHaveLength(1);
        expect(port.listEvents).not.toHaveBeenCalled();
        expect(await worker.requestCalendarAccess()).toMatchObject({
            supported: true,
            readGranted: true,
            enabled: true,
            defaultCalendarId: ''
        });
        expect(port.requestAccess).toHaveBeenCalledTimes(1);
    });

    test('local initialization succeeds without contacting a missing Java/permission service and disables Outlook COM', async () => {
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
        (port.getState as jest.Mock).mockRejectedValue(new Error('Java not ready'));
        const { OutlookUtils } = await import('../../../main/utils/outlook.js');
        const outlook = jest
            .spyOn(OutlookUtils, 'getOutlookCalendarItems')
            .mockRejectedValue(new Error('COM must not run'));
        await worker.applicationConfigChanged({ dataSources: { outlook: { enabled: true } } });
        await expect(worker.initialize()).resolves.toBeUndefined();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(port.getState).not.toHaveBeenCalled();
        expect(outlook).not.toHaveBeenCalled();
        await worker.finalize();
        jest.clearAllTimers();
    });
});

describe('CalendarApplication platform selection and integration main methods', () => {
    const previous = process.env.OPENDESK_ANDROID_RUNTIME;
    afterEach(() => {
        if (previous === undefined) delete process.env.OPENDESK_ANDROID_RUNTIME;
        else process.env.OPENDESK_ANDROID_RUNTIME = previous;
        jest.restoreAllMocks();
    });
    test('only the exact Android runtime flag selects the subclass; other platforms retain the original worker', () => {
        delete process.env.OPENDESK_ANDROID_RUNTIME;
        expect(CalendarApplication.getWorkerClass()).toBe(CalendarWorker);
        process.env.OPENDESK_ANDROID_RUNTIME = 'true';
        expect(CalendarApplication.getWorkerClass()).toBe(CalendarWorker);
        process.env.OPENDESK_ANDROID_RUNTIME = '1';
        expect(CalendarApplication.getWorkerClass()).toBe(AndroidCalendarWorker);
    });
    test('non-Android integration state is unsupported without a Worker round trip', async () => {
        delete process.env.OPENDESK_ANDROID_RUNTIME;
        const app = new CalendarApplication(),
            call = jest.spyOn(app, 'callWorker');
        expect(await app.getCalendarIntegrationState()).toEqual({
            supported: false,
            readGranted: false,
            writeGranted: false,
            calendars: [],
            enabled: true,
            defaultCalendarId: ''
        });
        expect(call).not.toHaveBeenCalled();
    });
    test('main integration methods delegate to Android Worker and persist only the selected config fields', async () => {
        process.env.OPENDESK_ANDROID_RUNTIME = '1';
        const app = new CalendarApplication();
        let config = {
            dataSources: { outlook: { enabled: true }, systemCalendar: { enabled: true, defaultCalendarId: '' } }
        };
        jest.spyOn(app, 'getConfig').mockImplementation(() => config);
        const saved = jest.spyOn(app, 'setConfig').mockImplementation((value) => {
            config = value;
        });
        const snapshot = {
            supported: true,
            readGranted: true,
            writeGranted: true,
            calendars: [{ id: '7', name: 'Work', canWrite: true }],
            enabled: true,
            defaultCalendarId: '7'
        };
        const call = jest.spyOn(app, 'callWorker').mockImplementation(async (method) => ({
            status: 'ok',
            data: method === 'applicationConfigChanged' ? undefined : snapshot
        }));
        expect(await app.configureCalendarIntegration({ defaultCalendarId: '7' })).toEqual(snapshot);
        expect(saved).toHaveBeenCalledWith({
            dataSources: { outlook: { enabled: true }, systemCalendar: { enabled: true, defaultCalendarId: '7' } }
        });
        expect(call).toHaveBeenCalledWith('applicationConfigChanged', config);
        expect(await app.requestCalendarAccess()).toEqual(snapshot);
        expect(call).toHaveBeenCalledWith('requestCalendarAccess');
    });
    test('config patches preserve disabled state and unrelated Outlook configuration without new defaults overriding them', async () => {
        delete process.env.OPENDESK_ANDROID_RUNTIME;
        const app = new CalendarApplication();
        let config = {
            dataSources: { outlook: { enabled: true }, systemCalendar: { enabled: false, defaultCalendarId: '7' } }
        };
        jest.spyOn(app, 'getConfig').mockImplementation(() => config);
        jest.spyOn(app, 'setConfig').mockImplementation((value) => {
            config = value;
        });
        const state = await app.configureCalendarIntegration({ defaultCalendarId: '' });
        expect(state).toMatchObject({ supported: false, enabled: false, defaultCalendarId: '' });
        expect(config.dataSources.outlook.enabled).toBe(true);
    });
    test('permission/readonly selection and invalid config fail before any settings are saved', async () => {
        process.env.OPENDESK_ANDROID_RUNTIME = '1';
        const app = new CalendarApplication();
        jest.spyOn(app, 'getConfig').mockReturnValue({ dataSources: {} });
        const save = jest.spyOn(app, 'setConfig');
        const state = {
            supported: true,
            readGranted: true,
            writeGranted: false,
            calendars: [{ id: '7', name: 'Work', canWrite: false }],
            enabled: true,
            defaultCalendarId: ''
        };
        jest.spyOn(app, 'callWorker').mockImplementation(async () => ({ status: 'ok', data: state }));
        await expect(app.configureCalendarIntegration({ defaultCalendarId: '7' })).rejects.toMatchObject({
            code: 'CALENDAR_PERMISSION_DENIED'
        });
        state.writeGranted = true;
        await expect(app.configureCalendarIntegration({ defaultCalendarId: '7' })).rejects.toMatchObject({
            code: 'CALENDAR_READ_ONLY'
        });
        await expect(app.configureCalendarIntegration({ defaultCalendarId: 'missing' })).rejects.toMatchObject({
            code: 'CALENDAR_NOT_FOUND'
        });
        await expect(app.configureCalendarIntegration({ enabled: 'yes' })).rejects.toThrow();
        await expect(app.configureCalendarIntegration({ unknown: true })).rejects.toThrow();
        expect(save).not.toHaveBeenCalled();
    });
    test('native worker errors preserve their code and never become a successful unsupported snapshot', async () => {
        process.env.OPENDESK_ANDROID_RUNTIME = '1';
        const app = new CalendarApplication();
        jest.spyOn(app, 'callWorker').mockResolvedValue({
            status: 'error',
            code: 'CALENDAR_PERMISSION_DENIED',
            message: 'denied'
        });
        await expect(app.getCalendarIntegrationState()).rejects.toMatchObject({
            code: 'CALENDAR_PERMISSION_DENIED',
            message: 'denied'
        });
        await expect(app.requestCalendarAccess()).rejects.toMatchObject({ code: 'CALENDAR_PERMISSION_DENIED' });
    });
});
