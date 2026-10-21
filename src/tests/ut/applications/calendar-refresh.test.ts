import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import Datastore from 'nedb-promises';
import CalendarWorker from '../../../main/applications/calendar/service/worker.js';
import { CalendarApplication } from '../../../main/applications/calendar/app.js';
import {
    AddCalendarItemTool,
    EditCalendarItemTool,
    DeleteCalendarItemTool
} from '../../../main/applications/calendar/tools.js';

describe('calendar refresh after conversation tools change schedules', () => {
    let widget: any;
    let worker: CalendarWorker;
    let app: CalendarApplication;
    let emitEvent: any;
    let listeners: Map<string, (...args: unknown[]) => unknown>;
    let api: any;
    let refreshes: Promise<void>[];

    async function settleRefresh(): Promise<void> {
        await new Promise<void>((resolve) => setImmediate(resolve));
        for (let i = 0; i < refreshes.length; i++) {
            await refreshes[i];
        }
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

    beforeEach(async () => {
        listeners = new Map();
        worker = new CalendarWorker('calendar', '/unused');
        worker.db = new Datastore({ inMemoryOnly: true });
        app = new CalendarApplication();
        jest.spyOn(app, 'callWorker').mockImplementation(async (method: string, ...args: any[]) => ({
            status: 'ok',
            data: await (worker as any)[method](...args)
        }));
        api = {
            call: jest.fn(async (method: string, ...args: any[]) => (worker as any)[method](...args)),
            subscribe: jest.fn(async (event: string, callback: (...args: unknown[]) => unknown) => {
                listeners.set(event, callback);
            }),
            unsubscribe: jest.fn(async (event: string) => {
                listeners.delete(event);
            })
        };
        (window as any).applicationAPI = api;
        (window as any).settingAPI = { loadSettingObject: async () => ({ locale: 'zh-CN' }) };
        emitEvent = jest.spyOn(worker, 'emitEvent').mockImplementation(async (event: string, ...args: unknown[]) => {
            listeners.get(event)?.(...args);
        });
        widget = document.createElement('calendar-entry-widget');
        refreshes = [];
        const refresh = widget._refreshAll.bind(widget);
        jest.spyOn(widget, '_refreshAll').mockImplementation(() => {
            const pending = refresh();
            refreshes.push(pending);
            return pending;
        });
        document.body.appendChild(widget);
        await settleRefresh();
    });

    afterEach(() => {
        widget.remove();
        jest.restoreAllMocks();
    });

    afterAll(() => {
        delete (window as any).applicationAPI;
        delete (window as any).settingAPI;
    });

    async function addSchedule(): Promise<any> {
        const d = widget.currentDate;
        const dateString = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const result = await new AddCalendarItemTool(app).execute({
            subject: '会话创建的会议',
            dateString,
            startTime: '10:00',
            endTime: '11:00',
            isAllDay: false
        });
        expect(result.status).toBe('success');
        return JSON.parse(result.result!);
    }

    test('declares the shared calendar change event', async () => {
        expect(await app.getSupportedEvents()).toEqual(
            expect.arrayContaining([expect.objectContaining({ eventName: 'calendarItemsChanged' })])
        );
    });

    test.each(['month', 'week', 'day'])('conversation create refreshes an open %s view', async (mode) => {
        widget.viewMode = mode;
        await widget._refreshAll();
        expect(widget.querySelectorAll('[data-detail-uid]')).toHaveLength(0);
        const item = await addSchedule();
        await settleRefresh();
        expect(emitEvent).toHaveBeenCalledWith('calendarItemsChanged');
        expect(widget.querySelector(`[data-detail-uid="${item.uid}"]`)?.textContent).toContain('会话创建的会议');
        expect(widget.querySelector(`[data-event-uid="${item.uid}"]`)?.textContent).toContain('会话创建的会议');
    });

    test.each(['month', 'week', 'day'])('conversation edit refreshes the %s view and selected detail', async (mode) => {
        widget.viewMode = mode;
        const item = await addSchedule();
        await widget._refreshAll();
        widget.selectedEvent = widget._findEvent(item.uid);
        widget._renderDetail();
        const result = await new EditCalendarItemTool(app).execute({ itemId: item.uid, subject: '会话修改后的会议' });
        expect(result.status).toBe('success');
        await settleRefresh();
        expect(widget.querySelector(`[data-event-uid="${item.uid}"]`)?.textContent).toContain('会话修改后的会议');
        expect(widget.querySelector('.cal-detail-card-title')?.textContent).toBe('会话修改后的会议');
    });

    test.each(['month', 'week', 'day'])(
        'conversation delete refreshes the %s view and selected detail',
        async (mode) => {
            widget.viewMode = mode;
            const item = await addSchedule();
            await widget._refreshAll();
            widget.selectedEvent = widget._findEvent(item.uid);
            widget._renderDetail();
            const result = await new DeleteCalendarItemTool(app).execute({ uid: item.uid });
            expect(result.status).toBe('success');
            await settleRefresh();
            expect(widget.querySelector(`[data-event-uid="${item.uid}"]`)).toBeNull();
            expect(widget.querySelector('.cal-detail-card-title')).toBeNull();
            expect(widget.selectedEvent).toBeNull();
        }
    );

    test('failed writes do not publish change events', async () => {
        jest.spyOn(worker.db, 'insert').mockRejectedValueOnce(new Error('write failed'));
        await expect(worker.addCalendarItem({ subject: 'failed', startTime: 1, endTime: 2 })).rejects.toThrow(
            'write failed'
        );
        await expect(worker.updateCalendarItem('missing', { subject: 'failed' })).rejects.toThrow();
        await expect(worker.deleteCalendarItem('missing')).rejects.toThrow();
        expect(emitEvent).not.toHaveBeenCalled();
    });

    test('a subscription finishing after removal is disposed without restarting the widget', async () => {
        widget.remove();
        await settleRefresh();
        api.unsubscribe.mockClear();
        let complete!: () => void;
        api.subscribe.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    complete = resolve;
                })
        );
        widget = document.createElement('calendar-entry-widget');
        document.body.appendChild(widget);
        await settleRefresh();
        widget.remove();
        complete();
        await settleRefresh();
        expect(api.unsubscribe).toHaveBeenCalledTimes(1);
        expect(api.unsubscribe).toHaveBeenCalledWith('calendarItemsChanged');
        expect(widget._nowTimer).toBeNull();
    });

    test('reconnect waits for a pending old subscription to be cleaned up', async () => {
        widget.remove();
        await settleRefresh();
        let complete!: () => void;
        api.subscribe.mockImplementationOnce(
            (event: string, callback: (...args: unknown[]) => unknown) =>
                new Promise<void>((resolve) => {
                    complete = () => {
                        listeners.set(event, callback);
                        resolve();
                    };
                })
        );
        document.body.appendChild(widget);
        await settleRefresh();
        widget.remove();
        document.body.appendChild(widget);
        await settleRefresh();
        expect(api.subscribe).toHaveBeenCalledTimes(2);
        complete();
        await settleRefresh();
        expect(api.subscribe).toHaveBeenCalledTimes(3);
        await addSchedule();
        await settleRefresh();
        expect(widget.querySelector('[data-detail-uid]')?.textContent).toContain('会话创建的会议');
    });

    test('removing and reconnecting the widget releases and restores its subscription', async () => {
        expect(api.subscribe).toHaveBeenCalledTimes(1);
        widget.remove();
        await settleRefresh();
        expect(api.unsubscribe).toHaveBeenCalledWith('calendarItemsChanged');
        expect(listeners.size).toBe(0);
        document.body.appendChild(widget);
        await settleRefresh();
        expect(api.subscribe).toHaveBeenCalledTimes(2);
        await addSchedule();
        await settleRefresh();
        expect(widget.querySelector('[data-detail-uid]')?.textContent).toContain('会话创建的会议');
    });
});
