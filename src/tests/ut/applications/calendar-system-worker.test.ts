import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import Datastore from 'nedb-promises';
import CalendarWorker from '../../../main/applications/calendar/service/worker.js';
import { CalendarApplication } from '../../../main/applications/calendar/app.js';
import { AbstractPlatform, setPlatform } from '../../../platforms/base.js';
import type {
    CalendarEvent,
    CalendarKit,
    CalendarKitState,
    CalendarKitChange
} from '../../../platforms/bridges/common.js';
import type { CalendarItem } from '../../../main/applications/calendar/service/system-calendar.js';

const localInput = {
    subject: 'local',
    startTime: new Date('2026-11-17T10:00:00').getTime(),
    endTime: new Date('2026-11-17T11:00:00').getTime()
};
function nativeItem(patch: Partial<CalendarEvent> = {}): CalendarEvent {
    return {
        uid: 'opaque-provider-event',
        calendarId: '7',
        canWrite: true,
        recurring: false,
        ...localInput,
        subject: 'system',
        location: '',
        isAllDay: false,
        isCancelled: false,
        type: '',
        ...patch
    };
}

class TestCalendarPlatform extends AbstractPlatform {
    getName() {
        return 'test-calendar-host';
    }
    getEffectiveWorkspace() {
        return process.cwd();
    }
    async initPlatformHarness() {}
    async fetch(): Promise<Response> {
        throw new Error('Unexpected network');
    }
}

describe('shared Calendar Worker keeps local storage separate from the native kit', () => {
    let worker: CalendarWorker, state: CalendarKitState, port: CalendarKit;
    let changes: Set<(change: CalendarKitChange) => void>;
    let release: () => void;
    beforeEach(() => {
        worker = new CalendarWorker('calendar', '/unused');
        changes = new Set();
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
            deleteEvent: jest.fn(async (uid) => ({ deleted: true, uid })),
            ownsEvent: (uid) => uid === 'opaque-provider-event' || uid === 'provider-invalid',
            onDidChange: jest.fn((listener) => {
                changes.add(listener);
                return jest.fn(() => {
                    changes.delete(listener);
                });
            })
        };
        const platform = new TestCalendarPlatform();
        setPlatform(platform);
        const bridge = jest
            .spyOn(platform, 'getNativeBridge')
            .mockReturnValue({ getCalendarKit: async () => port } as any);
        release = () => {
            bridge.mockReturnValue(null);
        };
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
        expect(items.find((item: CalendarItem) => item.source === 'system')).toMatchObject({
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
                release = () => {};
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

    test('opaque native identities are delegated to the kit without platform parsing or local fallback', async () => {
        const error = Object.assign(new Error('Invalid provider identity'), { code: 'CALENDAR_INVALID_ARGUMENT' });
        (port.updateEvent as jest.Mock).mockRejectedValueOnce(error);
        (port.deleteEvent as jest.Mock).mockRejectedValueOnce(error);
        await expect(worker.updateCalendarItem('provider-invalid', { subject: 'x' })).rejects.toMatchObject({
            code: 'CALENDAR_INVALID_ARGUMENT'
        });
        await expect(worker.deleteCalendarItem('provider-invalid')).rejects.toMatchObject({
            code: 'CALENDAR_INVALID_ARGUMENT'
        });
        expect(port.updateEvent).toHaveBeenCalledWith('provider-invalid', { subject: 'x' });
        expect(port.deleteEvent).toHaveBeenCalledWith('provider-invalid');
    });

    test('recurring native instances remain readonly while native query errors remain visible', async () => {
        (port.listEvents as jest.Mock).mockResolvedValueOnce([nativeItem({ recurring: true })]);
        const item = (await worker.getCalendarItems('2026-11-17'))[0];
        expect(item).toMatchObject({ recurring: true, canWrite: false, source: 'system' });
        const recurringError = Object.assign(new Error('Recurring event'), { code: 'CALENDAR_RECURRING_UNSUPPORTED' });
        (port.updateEvent as jest.Mock).mockRejectedValueOnce(recurringError);
        (port.deleteEvent as jest.Mock).mockRejectedValueOnce(recurringError);
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
        await worker.getSystemCalendarState();
        jest.useFakeTimers();
        for (const listener of changes) {
            listener({ revision: 1 });
            listener({ revision: 2 });
        }
        expect(worker.emitEvent).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(250);
        expect(worker.emitEvent).toHaveBeenCalledTimes(1);
        expect(worker.emitEvent).toHaveBeenCalledWith('calendarItemsChanged');
        for (const listener of changes) listener({ revision: 3 });
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
        const outlook = jest.spyOn(OutlookUtils, 'getOutlookCalendarItems').mockResolvedValue([]);
        await worker.applicationConfigChanged({ dataSources: { outlook: { enabled: true } } });
        await expect(worker.initialize()).resolves.toBeUndefined();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(port.getState).not.toHaveBeenCalled();
        expect(outlook).toHaveBeenCalled();
        await worker.finalize();
        jest.clearAllTimers();
    });

    test('repeated initialize and calls share one kit subscription, while finalize and reinitialize release/restore it once', async () => {
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
        await Promise.all([worker.initialize(), worker.initialize()]);
        await worker.getSystemCalendarState();
        expect(port.onDidChange).toHaveBeenCalledTimes(1);
        expect(changes.size).toBe(1);
        expect(jest.getTimerCount()).toBe(3);
        await worker.finalize();
        expect(changes.size).toBe(0);
        expect(jest.getTimerCount()).toBe(0);
        await worker.initialize();
        expect(port.onDidChange).toHaveBeenCalledTimes(2);
        expect(changes.size).toBe(1);
    });

    test('a failed kit acquisition can recover and never prevents local initialization', async () => {
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
        const get = jest.fn(async () => port).mockRejectedValueOnce(new Error('bridge not ready'));
        const platform = new TestCalendarPlatform();
        jest.spyOn(platform, 'getNativeBridge').mockReturnValue({ getCalendarKit: get } as any);
        setPlatform(platform);
        await expect(worker.initialize()).resolves.toBeUndefined();
        expect(await worker.getSystemCalendarState()).toMatchObject({ supported: true });
        expect(get).toHaveBeenCalledTimes(2);
        expect(port.onDidChange).toHaveBeenCalledTimes(1);
    });

    test('finalize during database loading prevents a late initialization from restoring timers or subscriptions', async () => {
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
        let finishDatabase!: () => void;
        jest.spyOn(worker, 'loadDatabase').mockReturnValue(
            new Promise<void>((resolve) => {
                finishDatabase = resolve;
            })
        );
        const initializing = worker.initialize();
        await worker.finalize();
        finishDatabase();
        await initializing;
        expect(port.onDidChange).not.toHaveBeenCalled();
        expect(changes.size).toBe(0);
        expect(jest.getTimerCount()).toBe(0);
    });

    test('finalize during kit acquisition leaves no subscription or timer when the getter settles', async () => {
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
        jest.spyOn(worker, 'loadDatabase').mockResolvedValue(undefined);
        let finishKit!: (kit: CalendarKit) => void;
        const get = jest.fn(
            () =>
                new Promise<CalendarKit>((resolve) => {
                    finishKit = resolve;
                })
        );
        const platform = new TestCalendarPlatform();
        jest.spyOn(platform, 'getNativeBridge').mockReturnValue({ getCalendarKit: get } as any);
        setPlatform(platform);
        const initializing = worker.initialize();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(get).toHaveBeenCalledTimes(1);
        await worker.finalize();
        finishKit(port);
        await initializing;
        expect(port.onDidChange).not.toHaveBeenCalled();
        expect(changes.size).toBe(0);
        expect(jest.getTimerCount()).toBe(0);
    });

    test('reinitializing while the old kit getter is pending restores one lifecycle only', async () => {
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
        jest.spyOn(worker, 'loadDatabase').mockResolvedValue(undefined);
        let finishKit!: (kit: CalendarKit) => void;
        const get = jest.fn(
            () =>
                new Promise<CalendarKit>((resolve) => {
                    finishKit = resolve;
                })
        );
        const platform = new TestCalendarPlatform();
        jest.spyOn(platform, 'getNativeBridge').mockReturnValue({ getCalendarKit: get } as any);
        setPlatform(platform);
        const oldInitialization = worker.initialize();
        await new Promise<void>((resolve) => setImmediate(resolve));
        await worker.finalize();
        const newInitialization = worker.initialize();
        finishKit(port);
        await Promise.all([oldInitialization, newInitialization]);
        expect(get).toHaveBeenCalledTimes(1);
        expect(port.onDidChange).toHaveBeenCalledTimes(1);
        expect(changes.size).toBe(1);
        expect(jest.getTimerCount()).toBe(3);
    });

    test('switching host bridges cancels a queued change from the previous kit', async () => {
        jest.useFakeTimers();
        await worker.getSystemCalendarState();
        for (const listener of changes) listener({ revision: 1 });
        release();
        await worker.getSystemCalendarState();
        await jest.advanceTimersByTimeAsync(250);
        expect(changes.size).toBe(0);
        expect(worker.emitEvent).not.toHaveBeenCalled();
    });
});

describe('CalendarApplication platform-neutral worker and integration main methods', () => {
    const previous = process.env.OPENDESK_ANDROID_RUNTIME;
    afterEach(() => {
        if (previous === undefined) delete process.env.OPENDESK_ANDROID_RUNTIME;
        else process.env.OPENDESK_ANDROID_RUNTIME = previous;
        jest.restoreAllMocks();
    });
    test('all runtime flags keep the same shared worker class', () => {
        delete process.env.OPENDESK_ANDROID_RUNTIME;
        expect(CalendarApplication.getWorkerClass()).toBe(CalendarWorker);
        process.env.OPENDESK_ANDROID_RUNTIME = 'true';
        expect(CalendarApplication.getWorkerClass()).toBe(CalendarWorker);
        process.env.OPENDESK_ANDROID_RUNTIME = '1';
        expect(CalendarApplication.getWorkerClass()).toBe(CalendarWorker);
    });
    test('unsupported integration state also comes from the same worker on desktop', async () => {
        delete process.env.OPENDESK_ANDROID_RUNTIME;
        const app = new CalendarApplication(),
            call = jest.spyOn(app, 'callWorker').mockResolvedValue({
                status: 'ok',
                data: {
                    supported: false,
                    readGranted: false,
                    writeGranted: false,
                    calendars: [],
                    enabled: true,
                    defaultCalendarId: ''
                }
            });
        expect(await app.getCalendarIntegrationState()).toEqual({
            supported: false,
            readGranted: false,
            writeGranted: false,
            calendars: [],
            enabled: true,
            defaultCalendarId: ''
        });
        expect(call).toHaveBeenCalledWith('getSystemCalendarState');
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
        jest.spyOn(app, 'callWorker').mockImplementation(async (method) => ({
            status: 'ok',
            data:
                method === 'applicationConfigChanged'
                    ? undefined
                    : {
                          supported: false,
                          enabled: config.dataSources.systemCalendar.enabled,
                          defaultCalendarId: config.dataSources.systemCalendar.defaultCalendarId
                      }
        }));
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
