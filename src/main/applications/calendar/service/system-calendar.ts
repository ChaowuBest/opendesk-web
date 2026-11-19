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

import type {
    CalendarEvent,
    CalendarEventInput,
    CalendarEventUpdates,
    CalendarKitState
} from '../../../../platforms/bridges/common.js';

export type CalendarItem = Omit<CalendarEvent, 'calendarId' | 'canWrite' | 'recurring'> & {
    source?: 'local' | 'system';
    sourceCalendarId?: string;
    canWrite?: boolean;
    recurring?: boolean;
};

export type CalendarItemInput = CalendarEventInput;
export type CalendarItemUpdates = CalendarEventUpdates;

export interface CalendarIntegrationConfig {
    enabled: boolean;
    /** Empty selects the existing local calendar for newly created items. */
    defaultCalendarId: string;
}

export interface CalendarIntegrationState extends CalendarKitState, CalendarIntegrationConfig {}
