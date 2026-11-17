/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import CalendarWorker from './worker.js';
import { z } from 'zod';
import { CalendarItemSchema } from '../common.js';
import { t } from '../locale/index.js';
import { getHostRuntime } from '../../../../platforms/runtime.js';
import { logger } from '../../../utils/logger.js';
import type {
    CalendarItem,
    CalendarItemInput,
    CalendarItemUpdates,
    CalendarIntegrationConfig,
    CalendarIntegrationState,
    SystemCalendarPort,
    SystemCalendarState
} from './system-calendar.js';

const inputSchema = z.object({
    subject: z.string(),
    startTime: z.number(),
    endTime: z.number(),
    location: z.string().optional(),
    isAllDay: z.boolean().optional(),
    type: z.string().optional()
});
const updateSchema = inputSchema.partial();

function failure(code: string, key: string): Error {
    return Object.assign(new Error(t(key)), { code });
}

const nativeErrorKeys: Record<string, string> = {
    CALENDAR_PERMISSION_DENIED: 'system.error.permissionDenied',
    CALENDAR_RECURRING_UNSUPPORTED: 'system.error.recurring',
    CALENDAR_READ_ONLY: 'system.error.readOnly',
    CALENDAR_NOT_FOUND: 'system.error.calendarMissing',
    CALENDAR_EVENT_CHANGED: 'system.error.eventChanged',
    CALENDAR_TYPE_UNSUPPORTED: 'system.error.typeUnsupported',
    CALENDAR_INVALID_ARGUMENT: 'system.error.invalidItem',
    CALENDAR_UNAVAILABLE: 'system.error.unavailable',
    CALENDAR_PROVIDER_UNAVAILABLE: 'system.error.unavailable'
};

function nativeCalendarId(uid: string): string {
    const match = /^android:(\d+):(\d+):(-?\d+)$/.exec(uid);
    if (!match) throw failure('CALENDAR_INVALID_ARGUMENT', 'system.error.invalidItem');
    return match[1];
}

/** Local storage/reminders stay in CalendarWorker; the host owns system rows and their reminders. */
export default class AndroidCalendarWorker extends CalendarWorker {
    private refreshTimer?: ReturnType<typeof setTimeout>;
    private finalized = false;
    private readonly nativeItems = new Map<string, CalendarItem>();

    private async host<T>(operation: () => Promise<T>): Promise<T> {
        try {
            return await operation();
        } catch (error) {
            const value = error as { code?: unknown; category?: unknown; details?: unknown } | null;
            const code = typeof value?.code === 'string' ? value.code : '';
            const key = nativeErrorKeys[code];
            if (!key) throw error;
            throw Object.assign(new Error(t(key), { cause: error }), {
                code,
                category: value?.category,
                details: value?.details
            });
        }
    }

    private integrationConfig(): CalendarIntegrationConfig {
        const config = (this.config as { dataSources?: { systemCalendar?: Partial<CalendarIntegrationConfig> } })
            ?.dataSources?.systemCalendar;
        return { enabled: config?.enabled !== false, defaultCalendarId: config?.defaultCalendarId ?? '' };
    }

    async getSystemCalendarState(): Promise<CalendarIntegrationState> {
        const port = getHostRuntime().systemCalendar;
        const state = port
            ? await this.host(() => port.getState())
            : { supported: false, readGranted: false, writeGranted: false, calendars: [] };
        return { ...state, ...this.integrationConfig() };
    }

    async requestCalendarAccess(): Promise<CalendarIntegrationState> {
        const port = getHostRuntime().systemCalendar;
        if (port) await this.host(() => port.requestAccess());
        return this.getSystemCalendarState();
    }

    private nativeItem(item: CalendarItem, state: SystemCalendarState): CalendarItem {
        const normalized = CalendarItemSchema.parse(item) as CalendarItem;
        const calendarId = nativeCalendarId(normalized.uid);
        const recurring = item.recurring === true;
        const result: CalendarItem = {
            ...normalized,
            source: 'system',
            sourceCalendarId: calendarId,
            recurring,
            canWrite:
                state.writeGranted &&
                !recurring &&
                state.calendars.some((calendar) => calendar.id === calendarId && calendar.canWrite)
        };
        this.nativeItems.set(result.uid, result);
        return result;
    }

    private async readSystem(start: number, end: number): Promise<CalendarItem[]> {
        const port = getHostRuntime().systemCalendar;
        if (!port || !this.integrationConfig().enabled) return [];
        const state = await this.host(() => port.getState());
        if (!state.supported || !state.readGranted) return [];
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
            throw failure('CALENDAR_INVALID_ARGUMENT', 'system.error.invalidTime');
        return (await this.host(() => port.listEvents(start, end))).map((item) => this.nativeItem(item, state));
    }

    private merge(local: CalendarItem[], system: CalendarItem[]): CalendarItem[] {
        const items = new Map(local.map((item) => [item.uid, item]));
        for (const item of system) items.set(item.uid, item);
        return [...items.values()].sort((first, second) => first.startTime - second.startTime);
    }

    override async getCalendarItems(dateString: string): Promise<CalendarItem[]> {
        const local = await super.getCalendarItems(dateString);
        const date = new Date(dateString.replace(/-/g, '/'));
        const start = date.getTime(),
            end = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
        return this.merge(local, await this.readSystem(start, end));
    }

    override async getCalendarItemsInRange(start: number, end: number): Promise<CalendarItem[]> {
        return this.merge(await super.getCalendarItemsInRange(start, end), await this.readSystem(start, end));
    }

    private async writable(
        calendarId: string,
        uid?: string
    ): Promise<{ port: SystemCalendarPort; state: SystemCalendarState }> {
        if (!this.integrationConfig().enabled) throw failure('CALENDAR_DISABLED', 'system.error.disabled');
        const port = getHostRuntime().systemCalendar;
        if (!port) throw failure('CALENDAR_UNAVAILABLE', 'system.error.unavailable');
        const state = await this.host(() => port.getState());
        if (!state.supported) throw failure('CALENDAR_UNAVAILABLE', 'system.error.unavailable');
        if (!state.readGranted || !state.writeGranted)
            throw failure('CALENDAR_PERMISSION_DENIED', 'system.error.permissionDenied');
        const calendar = state.calendars.find((candidate) => candidate.id === calendarId);
        if (!calendar) throw failure('CALENDAR_NOT_FOUND', 'system.error.calendarMissing');
        if (!calendar.canWrite) throw failure('CALENDAR_READ_ONLY', 'system.error.readOnly');
        if (uid && this.nativeItems.get(uid)?.recurring)
            throw failure('CALENDAR_RECURRING_UNSUPPORTED', 'system.error.recurring');
        return { port, state };
    }

    override async addCalendarItem(item: CalendarItemInput): Promise<CalendarItem> {
        const calendarId = this.integrationConfig().defaultCalendarId;
        if (!calendarId) return super.addCalendarItem(item);
        const input = inputSchema.parse(item);
        if (input.endTime <= input.startTime) throw failure('CALENDAR_INVALID_ARGUMENT', 'system.error.invalidTime');
        const { port, state } = await this.writable(calendarId);
        const result = this.nativeItem(await this.host(() => port.addEvent(calendarId, input)), state);
        await this.emitEvent('calendarItemsChanged');
        return result;
    }

    override async updateCalendarItem(uid: string, updates: CalendarItemUpdates): Promise<CalendarItem> {
        if (!uid.startsWith('android:')) return super.updateCalendarItem(uid, updates);
        const calendarId = nativeCalendarId(uid),
            input = updateSchema.parse(updates);
        if (!Object.keys(input).length) throw failure('CALENDAR_INVALID_ARGUMENT', 'system.error.invalidItem');
        const { port, state } = await this.writable(calendarId, uid);
        const item = this.nativeItem(await this.host(() => port.updateEvent(uid, input)), state);
        await this.emitEvent('calendarItemsChanged');
        return item;
    }

    override async deleteCalendarItem(uid: string): Promise<{ deleted: boolean; uid: string }> {
        if (!uid.startsWith('android:')) return super.deleteCalendarItem(uid);
        const { port } = await this.writable(nativeCalendarId(uid), uid);
        const result = await this.host(() => port.deleteEvent(uid));
        this.nativeItems.delete(uid);
        if (result.deleted) await this.emitEvent('calendarItemsChanged');
        return result;
    }

    systemCalendarChanged(_revision?: string | number): void {
        if (this.finalized) return;
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = undefined;
            void this.emitEvent('calendarItemsChanged').catch((error) =>
                logger.warn(`system calendar refresh delivery failed: ${String(error)}`)
            );
        }, 150);
    }

    /** Outlook COM is never invoked on Android, even when an imported desktop config enabled it. */
    override async loadOutlookCalendarItems(): Promise<void> {}

    override async initialize(): Promise<void> {
        this.finalized = false;
        await super.initialize();
    }

    override async finalize(): Promise<void> {
        this.finalized = true;
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        this.refreshTimer = undefined;
        this.nativeItems.clear();
        await super.finalize();
    }
}
