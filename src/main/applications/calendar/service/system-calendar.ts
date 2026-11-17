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

export interface CalendarItem {
    uid: string;
    subject: string;
    startTime: number;
    endTime: number;
    location: string;
    isAllDay: boolean;
    isCancelled: boolean;
    type: string;
    source?: 'local' | 'system';
    sourceCalendarId?: string;
    canWrite?: boolean;
    recurring?: boolean;
}

export type CalendarItemInput = Pick<CalendarItem, 'subject' | 'startTime' | 'endTime'> &
    Partial<Pick<CalendarItem, 'location' | 'isAllDay' | 'type'>>;
export type CalendarItemUpdates = Partial<CalendarItemInput>;

export interface SystemCalendar {
    id: string;
    name: string;
    accountName?: string;
    canWrite: boolean;
    visible?: boolean;
    primary?: boolean;
}

export interface SystemCalendarState {
    supported: boolean;
    readGranted: boolean;
    writeGranted: boolean;
    calendars: SystemCalendar[];
    revision?: string | number;
}

/** Host operations run in each process that installs this port; dates are epoch milliseconds. */
export interface SystemCalendarPort {
    getState(): Promise<SystemCalendarState>;
    /** Requests permission UI. Permission completion is observed by subsequent getState calls/events. */
    requestAccess(): Promise<void>;
    listEvents(startTime: number, endTime: number): Promise<CalendarItem[]>;
    addEvent(calendarId: string, item: CalendarItemInput): Promise<CalendarItem>;
    updateEvent(uid: string, updates: CalendarItemUpdates): Promise<CalendarItem>;
    deleteEvent(uid: string): Promise<{ deleted: boolean; uid: string }>;
}

export interface CalendarIntegrationConfig {
    enabled: boolean;
    /** Empty selects the existing local calendar for newly created items. */
    defaultCalendarId: string;
}

export interface CalendarIntegrationState extends SystemCalendarState, CalendarIntegrationConfig {}
