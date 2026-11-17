import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import Datastore from 'nedb-promises';
import { CalendarApplication } from '../../../main/applications/calendar/app.js';
import AndroidCalendarWorker from '../../../main/applications/calendar/service/android-worker.js';
import {
    GetCalendarItemsTool,
    AddCalendarItemTool,
    EditCalendarItemTool,
    DeleteCalendarItemTool
} from '../../../main/applications/calendar/tools.js';
import { ApplicationRegistry, dispatchWorkerMessage } from '../../../main/applications/registry.js';
import { handleWorkerRequest } from '../../../main/applications/worker.js';
import { configureHostRuntime } from '../../../platforms/runtime.js';
import { t } from '../../../main/applications/calendar/locale/index.js';

let app: CalendarApplication, worker: AndroidCalendarWorker;
let oldApplications: typeof ApplicationRegistry.applications, oldWorker: typeof ApplicationRegistry.globalWorker;
let release: () => void;
const previousAndroid = process.env.OPENDESK_ANDROID_RUNTIME;
const uid = 'android:7:42:1794880800000';
const failure = Object.assign(new Error('Native provider rejected the operation'), {
    code: 'CALENDAR_TYPE_UNSUPPORTED',
    category: 'provider',
    details: { operation: 'calendar' }
});
beforeEach(async () => {
    failure.code = 'CALENDAR_TYPE_UNSUPPORTED';
    process.env.OPENDESK_ANDROID_RUNTIME = '1';
    worker = new AndroidCalendarWorker('calendar', '/unused');
    worker.db = new Datastore({ inMemoryOnly: true });
    jest.spyOn(worker, 'emitEvent').mockResolvedValue(undefined);
    await worker.applicationConfigChanged({
        dataSources: { systemCalendar: { enabled: true, defaultCalendarId: '7' } }
    });
    release = configureHostRuntime({
        systemCalendar: {
            getState: async () => ({
                supported: true,
                readGranted: true,
                writeGranted: true,
                calendars: [{ id: '7', name: 'Work', canWrite: true }]
            }),
            requestAccess: async () => {
                throw failure;
            },
            listEvents: async () => {
                throw failure;
            },
            addEvent: async () => {
                throw failure;
            },
            updateEvent: async () => {
                throw failure;
            },
            deleteEvent: async () => {
                throw failure;
            }
        }
    });
    oldApplications = ApplicationRegistry.applications;
    oldWorker = ApplicationRegistry.globalWorker;
    app = new CalendarApplication();
    app.setRegistry(ApplicationRegistry);
    ApplicationRegistry.applications = new Map([['calendar', app]]);
    ApplicationRegistry.globalWorker = {
        postMessage: (request: any) => {
            void handleWorkerRequest(request, new Map([['calendar', worker]]), new Map(), (frame) =>
                dispatchWorkerMessage(frame, {} as any)
            );
        }
    } as any;
});
afterEach(async () => {
    ApplicationRegistry.applications = oldApplications;
    ApplicationRegistry.globalWorker = oldWorker;
    ApplicationRegistry.pendingRequests.clear();
    await worker.finalize();
    release();
    jest.restoreAllMocks();
    if (previousAndroid === undefined) delete process.env.OPENDESK_ANDROID_RUNTIME;
    else process.env.OPENDESK_ANDROID_RUNTIME = previousAndroid;
});

test('native error metadata survives the real Worker request/response and registry call chain', async () => {
    const response = await app.callWorker('updateCalendarItem', uid, { subject: 'new title' });
    expect(response).toMatchObject({
        status: 'error',
        code: 'CALENDAR_TYPE_UNSUPPORTED',
        category: 'provider',
        details: { operation: 'calendar' }
    });
    expect(response.message).toContain(t('system.error.typeUnsupported'));
    await expect(app.requestCalendarAccess()).rejects.toMatchObject({ code: 'CALENDAR_TYPE_UNSUPPORTED' });
});

test.each([
    ['CALENDAR_PERMISSION_DENIED', 'system.error.permissionDenied'],
    ['CALENDAR_READ_ONLY', 'system.error.readOnly'],
    ['CALENDAR_PROVIDER_UNAVAILABLE', 'system.error.unavailable'],
    ['CALENDAR_EVENT_CHANGED', 'system.error.eventChanged']
])('native query error %s stays explicit and localized across the real message chain', async (code, key) => {
    failure.code = code;
    const result = await app.callWorker('getCalendarItems', '2026-11-17');
    expect(result).toMatchObject({ status: 'error', code, category: 'provider', details: { operation: 'calendar' } });
    expect(result.message).toContain(t(key));
});

test.each([
    ['get', () => new GetCalendarItemsTool(app), { dateString: '2026-11-17' }],
    [
        'add',
        () => new AddCalendarItemTool(app),
        { subject: 'title', dateString: '2026-11-17', startTime: '10:00', endTime: '11:00', isAllDay: false }
    ],
    ['edit', () => new EditCalendarItemTool(app), { itemId: uid, subject: 'changed title' }],
    ['delete', () => new DeleteCalendarItemTool(app), { uid }]
])(
    'Calendar %s tool reports the real native failure instead of a successful item or delete',
    async (_name, makeTool, args) => {
        const result = await (makeTool as () => any)().execute(args);
        expect(result.status).toBe('error');
        expect(result.result).toContain(t('system.error.typeUnsupported'));
        expect(result.result).not.toContain('"success":true');
        expect(await worker.db.count({})).toBe(0);
        expect(worker.emitEvent).not.toHaveBeenCalled();
    }
);
