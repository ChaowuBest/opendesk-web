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

import { datetimeLocalToISOString } from './timezone.js';

export interface TodoRecurrence {
    mode: 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'yearly' | 'interval';
    time?: string;
    weekdays?: number[];
    day?: number;
    days?: number[];
    month?: number;
    months?: number[];
    anchorDate?: string;
    anchorAt?: string;
    intervalHours?: number;
}

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MINUTE = 60_000;
const MODES = ['daily', 'weekly', 'biweekly', 'monthly', 'yearly', 'interval'];
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const formatters = new Map<string, Intl.DateTimeFormat>();

function isDate(value: unknown): value is string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function integer(value: unknown, min: number, max: number): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function selectedNumbers(values: number[] | undefined, legacy: number | undefined): number[] {
    const selected = values !== undefined ? values : legacy === undefined ? [] : [legacy];
    return Array.isArray(selected) ? [...new Set(selected)].sort((a, b) => a - b) : [];
}

export function getTodoRecurrenceDays(rule: TodoRecurrence): number[] {
    return selectedNumbers(rule.days, rule.day);
}

export function getTodoRecurrenceMonths(rule: TodoRecurrence): number[] {
    return selectedNumbers(rule.months, rule.month);
}

function validSelection(values: unknown, min: number, max: number): boolean {
    return Array.isArray(values) && values.length > 0 && [...values].every((value) => integer(value, min, max));
}

/** Internal validation details; callers display their localized schedule error. */
export function getTodoRecurrenceError(value: unknown): string | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 'Invalid recurrence';
    const rule = value as TodoRecurrence;
    if (!MODES.includes(rule.mode)) return 'Invalid recurrence mode';
    const weekly = ['weekly', 'biweekly', 'interval'].includes(rule.mode);
    if (weekly) {
        if (
            !Array.isArray(rule.weekdays) ||
            !rule.weekdays.length ||
            rule.weekdays.some((day) => !integer(day, 0, 6))
        ) {
            return 'Invalid weekdays';
        }
    } else if (rule.weekdays !== undefined) return 'Weekdays are not supported for this mode';
    if (rule.mode === 'interval') {
        if (!integer(rule.intervalHours, 1, 8760)) return 'Invalid interval hours';
        if (
            typeof rule.anchorAt !== 'string' ||
            !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::00(?:\.000)?)?Z$/.test(rule.anchorAt) ||
            !Number.isFinite(Date.parse(rule.anchorAt)) ||
            new Date(rule.anchorAt).toISOString().slice(0, 16) !== rule.anchorAt.slice(0, 16)
        )
            return 'Invalid interval anchor';
        if (rule.time !== undefined) return 'Wall-clock time is not supported for intervals';
    } else {
        if (typeof rule.time !== 'string' || !TIME.test(rule.time)) return 'Invalid execution time';
        if (rule.intervalHours !== undefined || rule.anchorAt !== undefined)
            return 'Interval fields require interval mode';
    }
    if (rule.mode === 'monthly' || rule.mode === 'yearly') {
        if (rule.days !== undefined ? !validSelection(rule.days, 1, 31) : !integer(rule.day, 1, 31))
            return 'Invalid month day';
    } else if (rule.day !== undefined || rule.days !== undefined) return 'Month day requires monthly or yearly mode';
    if (rule.mode === 'yearly') {
        if (rule.months !== undefined ? !validSelection(rule.months, 1, 12) : !integer(rule.month, 1, 12))
            return 'Invalid month';
        const days = getTodoRecurrenceDays(rule);
        if (
            !getTodoRecurrenceMonths(rule).some((month) =>
                days.some((day) => day <= new Date(Date.UTC(2000, month, 0)).getUTCDate())
            )
        )
            return 'This date never occurs';
    } else if (rule.month !== undefined || rule.months !== undefined) return 'Month requires yearly mode';
    if (rule.mode === 'biweekly') {
        if (!isDate(rule.anchorDate)) return 'Invalid biweekly anchor';
    } else if (rule.anchorDate !== undefined) return 'Calendar anchor requires biweekly mode';
    return null;
}

function formatter(timezone: string): Intl.DateTimeFormat {
    let result = formatters.get(timezone);
    if (!result) {
        result = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            calendar: 'gregory',
            numberingSystem: 'latn',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23'
        });
        if (formatters.size >= 16) formatters.delete(formatters.keys().next().value!);
        formatters.set(timezone, result);
    }
    return result;
}

function localParts(date: Date, format: Intl.DateTimeFormat): { date: string; time: string; day: number } {
    const parts = Object.fromEntries(format.formatToParts(date).map(({ type, value }) => [type, value]));
    const dateString = `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}`;
    return {
        date: dateString,
        time: `${parts.hour}:${parts.minute}`,
        day: Date.parse(`${dateString}T00:00:00Z`) / DAY
    };
}

function monday(day: number): number {
    return day - ((new Date(day * DAY).getUTCDay() + 6) % 7);
}

function calendarDayMatches(rule: TodoRecurrence, day: number): boolean {
    const date = new Date(day * DAY);
    switch (rule.mode) {
        case 'daily':
            return true;
        case 'weekly':
            return rule.weekdays!.includes(date.getUTCDay());
        case 'biweekly': {
            const start = monday(Date.parse(`${rule.anchorDate}T00:00:00Z`) / DAY);
            return day >= start && Math.floor((day - start) / 7) % 2 === 0 && rule.weekdays!.includes(date.getUTCDay());
        }
        case 'monthly':
            return getTodoRecurrenceDays(rule).includes(date.getUTCDate());
        case 'yearly':
            return (
                getTodoRecurrenceMonths(rule).includes(date.getUTCMonth() + 1) &&
                getTodoRecurrenceDays(rule).includes(date.getUTCDate())
            );
        default:
            return false;
    }
}

export function matchesTodoRecurrence(rule: TodoRecurrence, date: Date, timezone: string): boolean {
    if (getTodoRecurrenceError(rule) || !Number.isFinite(date.getTime())) return false;
    try {
        const parts = localParts(date, formatter(timezone));
        const minute = Math.floor(date.getTime() / MINUTE) * MINUTE;
        if (rule.mode === 'interval') {
            const elapsed = minute - Date.parse(rule.anchorAt!);
            return (
                elapsed >= 0 &&
                elapsed % (rule.intervalHours! * HOUR) === 0 &&
                rule.weekdays!.includes(new Date(parts.day * DAY).getUTCDay())
            );
        }
        if (parts.time !== rule.time || !calendarDayMatches(rule, parts.day)) return false;
        // A calendar time runs once when a daylight-saving transition repeats it.
        return Date.parse(datetimeLocalToISOString(`${parts.date}T${rule.time}`, timezone)) === minute;
    } catch {
        return false;
    }
}

/** Generate candidate days or elapsed intervals, never scan individual minutes. */
export function getNextTodoRecurrenceRuns(
    rule: TodoRecurrence,
    timezone: string,
    count = 3,
    after = new Date()
): Date[] {
    if (
        getTodoRecurrenceError(rule) ||
        !Number.isInteger(count) ||
        count < 1 ||
        count > 100 ||
        !Number.isFinite(after.getTime())
    )
        return [];
    try {
        const format = formatter(timezone);
        const start = localParts(after, format);
        const runs: Date[] = [];
        if (rule.mode === 'interval') {
            const anchor = Date.parse(rule.anchorAt!);
            const step = rule.intervalHours! * HOUR;
            const first = Math.max(0, Math.floor((after.getTime() - anchor) / step) + 1);
            // Gregorian dates repeat every 400 years. This also bounds an interval
            // whose UTC cadence can never land on any selected local weekday.
            const horizon = Math.max(400, count * 8) * 366 * DAY;
            const limit = first + Math.ceil(horizon / step);
            for (let index = first; index <= limit && runs.length < count; index++) {
                const candidate = new Date(anchor + index * step);
                if (!Number.isFinite(candidate.getTime())) break;
                const local = localParts(candidate, format);
                if (rule.weekdays!.includes(new Date(local.day * DAY).getUTCDay())) runs.push(candidate);
            }
            return runs;
        }
        const startDate = new Date(start.day * DAY);
        const limit =
            rule.mode === 'yearly' ? count * 8 + 8 : rule.mode === 'monthly' ? count * 2 + 2 : count * 14 + 28;
        let firstDay = start.day;
        if (rule.mode === 'biweekly')
            firstDay = Math.max(firstDay, monday(Date.parse(`${rule.anchorDate}T00:00:00Z`) / DAY));
        const days = getTodoRecurrenceDays(rule);
        const months = getTodoRecurrenceMonths(rule);
        for (let index = 0; index < limit && runs.length < count; index++) {
            const candidates: Date[] = [];
            if (rule.mode === 'monthly' || rule.mode === 'yearly') {
                const period = new Date(0);
                period.setUTCFullYear(
                    startDate.getUTCFullYear() + (rule.mode === 'yearly' ? index : 0),
                    rule.mode === 'monthly' ? startDate.getUTCMonth() + index : 0,
                    1
                );
                const selectedMonths = rule.mode === 'yearly' ? months : [period.getUTCMonth() + 1];
                for (const month of selectedMonths) {
                    for (const day of days) {
                        const candidate = new Date(period);
                        candidate.setUTCMonth(month - 1, day);
                        // Date setters roll nonexistent dates into the next month.
                        if (candidate.getUTCMonth() === month - 1 && candidate.getUTCDate() === day)
                            candidates.push(candidate);
                    }
                }
            } else candidates.push(new Date((firstDay + index) * DAY));
            for (const candidateDay of candidates) {
                if (runs.length >= count) break;
                const day = candidateDay.getTime() / DAY;
                if (!calendarDayMatches(rule, day)) continue;
                try {
                    const candidate = new Date(
                        datetimeLocalToISOString(`${candidateDay.toISOString().slice(0, 10)}T${rule.time}`, timezone)
                    );
                    if (candidate.getTime() > after.getTime()) runs.push(candidate);
                } catch {
                    // Missing wall times and calendar dates have no execution.
                }
            }
        }
        return runs;
    } catch {
        return [];
    }
}
