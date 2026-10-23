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
    intervalValue?: number;
    intervalUnit?: IntervalUnit;
    intervalHours?: number;
}

export type IntervalUnit = 'hour' | 'day' | 'week' | 'month' | 'year';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MINUTE = 60_000;
const MODES = ['daily', 'weekly', 'biweekly', 'monthly', 'yearly', 'interval'];
const INTERVAL_UNITS: IntervalUnit[] = ['hour', 'day', 'week', 'month', 'year'];
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

function intervalError(rule: TodoRecurrence): string | null {
    const structured = structuredInterval(rule);
    const calendar = structured && rule.time !== undefined;
    if (structured) {
        if (!integer(rule.intervalValue, 1, 10000) || !INTERVAL_UNITS.includes(rule.intervalUnit!))
            return 'Invalid interval value';
        if (rule.intervalHours !== undefined) return 'Legacy interval fields cannot be combined';
    } else if (!integer(rule.intervalHours, 1, 8760)) return 'Invalid interval hours';
    if (
        typeof rule.anchorAt !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::00(?:\.000)?)?Z$/.test(rule.anchorAt) ||
        !Number.isFinite(Date.parse(rule.anchorAt)) ||
        new Date(rule.anchorAt).toISOString().slice(0, 16) !== rule.anchorAt.slice(0, 16)
    )
        return 'Invalid interval anchor';
    if (rule.anchorDate !== undefined) return 'Calendar anchor requires biweekly mode';
    if (calendar) {
        if (rule.intervalUnit === 'hour') return 'Wall-clock time is not supported for hourly intervals';
        if (typeof rule.time !== 'string' || !TIME.test(rule.time)) return 'Invalid execution time';
        if (rule.intervalUnit === 'week') {
            if (!validSelection(rule.weekdays, 0, 6)) return 'Invalid weekdays';
        } else if (rule.weekdays !== undefined) return 'Weekdays require weekly interval mode';
        if (rule.intervalUnit === 'month' || rule.intervalUnit === 'year') {
            if (!validSelection(rule.days, 1, 31)) return 'Invalid month day';
        } else if (rule.days !== undefined) return 'Month days require monthly or yearly interval mode';
        if (rule.intervalUnit === 'year') {
            if (!validSelection(rule.months, 1, 12)) return 'Invalid month';
            if (!hasPossibleDate(getTodoRecurrenceMonths(rule), getTodoRecurrenceDays(rule)))
                return 'This date never occurs';
        } else if (rule.months !== undefined) return 'Months require yearly interval mode';
    } else {
        if (rule.time !== undefined) return 'Wall-clock time requires calendar interval mode';
        if ((!structured || rule.weekdays !== undefined) && !validSelection(rule.weekdays, 0, 6))
            return 'Invalid weekdays';
        if (rule.days !== undefined || rule.months !== undefined)
            return 'Date selections require calendar interval mode';
    }
    if (rule.day !== undefined || rule.month !== undefined) return 'Date scalars require monthly or yearly mode';
    return null;
}

function hasPossibleDate(months: number[], days: number[]): boolean {
    return months.some((month) => days.some((day) => day <= new Date(Date.UTC(2000, month, 0)).getUTCDate()));
}

/** Internal validation details; callers display their localized schedule error. */
export function getTodoRecurrenceError(value: unknown): string | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 'Invalid recurrence';
    const rule = value as TodoRecurrence;
    if (!MODES.includes(rule.mode)) return 'Invalid recurrence mode';
    if (rule.mode === 'interval') return intervalError(rule);
    const weekly = ['weekly', 'biweekly'].includes(rule.mode);
    if (weekly) {
        if (
            !Array.isArray(rule.weekdays) ||
            !rule.weekdays.length ||
            rule.weekdays.some((day) => !integer(day, 0, 6))
        ) {
            return 'Invalid weekdays';
        }
    } else if (rule.weekdays !== undefined) return 'Weekdays are not supported for this mode';
    if (typeof rule.time !== 'string' || !TIME.test(rule.time)) return 'Invalid execution time';
    if (
        rule.intervalHours !== undefined ||
        rule.intervalValue !== undefined ||
        rule.intervalUnit !== undefined ||
        rule.anchorAt !== undefined
    )
        return 'Interval fields require interval mode';
    if (rule.mode === 'monthly' || rule.mode === 'yearly') {
        if (rule.days !== undefined ? !validSelection(rule.days, 1, 31) : !integer(rule.day, 1, 31))
            return 'Invalid month day';
    } else if (rule.day !== undefined || rule.days !== undefined) return 'Month day requires monthly or yearly mode';
    if (rule.mode === 'yearly') {
        if (rule.months !== undefined ? !validSelection(rule.months, 1, 12) : !integer(rule.month, 1, 12))
            return 'Invalid month';
        if (!hasPossibleDate(getTodoRecurrenceMonths(rule), getTodoRecurrenceDays(rule)))
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

interface LocalParts {
    date: string;
    time: string;
    day: number;
}

function localParts(date: Date, format: Intl.DateTimeFormat): LocalParts {
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

function structuredInterval(rule: TodoRecurrence): boolean {
    return rule.intervalUnit !== undefined || rule.intervalValue !== undefined;
}

function intervalUnitAndValue(rule: TodoRecurrence): { unit: IntervalUnit; value: number } {
    return structuredInterval(rule)
        ? { unit: rule.intervalUnit!, value: rule.intervalValue! }
        : { unit: 'hour', value: rule.intervalHours! };
}

function intervalWeekdayMatches(rule: TodoRecurrence, day: number): boolean {
    return rule.weekdays === undefined || rule.weekdays.includes(new Date(day * DAY).getUTCDay());
}

function localIntervalIndex(
    anchorDay: number,
    currentDay: number,
    anchorDate: string,
    currentDate: string,
    unit: IntervalUnit
): number {
    if (unit === 'day' || unit === 'week') return currentDay - anchorDay;
    const anchor = new Date(`${anchorDate}T00:00:00Z`);
    const current = new Date(`${currentDate}T00:00:00Z`);
    if (unit === 'month')
        return (current.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + current.getUTCMonth() - anchor.getUTCMonth();
    return current.getUTCFullYear() - anchor.getUTCFullYear();
}

function localIntervalCandidate(
    anchor: { date: string; time: string },
    index: number,
    unit: IntervalUnit,
    value: number,
    timezone: string
): Date | undefined {
    if (unit === 'hour') return new Date(Date.parse(`${anchor.date}T${anchor.time}:00Z`) + index * value * HOUR);
    const local = new Date(`${anchor.date}T${anchor.time}:00Z`);
    const anchorDay = local.getUTCDate();
    const anchorMonth = local.getUTCMonth();
    if (unit === 'day') local.setUTCDate(local.getUTCDate() + index * value);
    else if (unit === 'week') local.setUTCDate(local.getUTCDate() + index * value * 7);
    else if (unit === 'month') local.setUTCMonth(local.getUTCMonth() + index * value);
    else local.setUTCFullYear(local.getUTCFullYear() + index * value);
    if (
        (unit === 'month' || unit === 'year') &&
        (local.getUTCDate() !== anchorDay || (unit === 'year' && local.getUTCMonth() !== anchorMonth))
    )
        return undefined;
    const date = local.toISOString().slice(0, 10);
    try {
        return new Date(datetimeLocalToISOString(`${date}T${anchor.time}`, timezone));
    } catch {
        return undefined;
    }
}

function calendarIntervalDifference(anchor: LocalParts, current: LocalParts, unit: IntervalUnit): number {
    return unit === 'week'
        ? (monday(current.day) - monday(anchor.day)) / 7
        : localIntervalIndex(anchor.day, current.day, anchor.date, current.date, unit);
}

function calendarIntervalDayMatches(rule: TodoRecurrence, anchor: LocalParts, current: LocalParts): boolean {
    const difference = calendarIntervalDifference(anchor, current, rule.intervalUnit!);
    if (difference < 0 || difference % rule.intervalValue! !== 0) return false;
    const date = new Date(current.day * DAY);
    if (rule.intervalUnit === 'week') return rule.weekdays!.includes(date.getUTCDay());
    if (rule.intervalUnit === 'month') return getTodoRecurrenceDays(rule).includes(date.getUTCDate());
    if (rule.intervalUnit === 'year')
        return (
            getTodoRecurrenceMonths(rule).includes(date.getUTCMonth() + 1) &&
            getTodoRecurrenceDays(rule).includes(date.getUTCDate())
        );
    return true;
}

function calendarIntervalDays(rule: TodoRecurrence, anchor: LocalParts, index: number): Date[] {
    const { unit, value } = intervalUnitAndValue(rule);
    const date = new Date(`${anchor.date}T00:00:00Z`);
    if (unit === 'day') return [new Date((anchor.day + index * value) * DAY)];
    if (unit === 'week') {
        const firstDay = monday(anchor.day) + index * value * 7;
        return selectedNumbers(rule.weekdays, undefined)
            .map((weekday) => new Date((firstDay + ((weekday + 6) % 7)) * DAY))
            .sort((a, b) => a.getTime() - b.getTime());
    }
    if (unit === 'month') date.setUTCMonth(date.getUTCMonth() + index * value, 1);
    else date.setUTCFullYear(date.getUTCFullYear() + index * value, 0, 1);
    if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() > 9999) return [];
    const months = unit === 'year' ? getTodoRecurrenceMonths(rule) : [date.getUTCMonth() + 1];
    const candidates: Date[] = [];
    for (const month of months) {
        for (const day of getTodoRecurrenceDays(rule)) {
            const candidate = new Date(date);
            candidate.setUTCMonth(month - 1, day);
            if (candidate.getUTCMonth() === month - 1 && candidate.getUTCDate() === day) candidates.push(candidate);
        }
    }
    return candidates;
}

export function matchesTodoRecurrence(rule: TodoRecurrence, date: Date, timezone: string): boolean {
    if (getTodoRecurrenceError(rule) || !Number.isFinite(date.getTime())) return false;
    try {
        const parts = localParts(date, formatter(timezone));
        const minute = Math.floor(date.getTime() / MINUTE) * MINUTE;
        if (rule.mode === 'interval') {
            if (!structuredInterval(rule)) {
                const elapsed = minute - Date.parse(rule.anchorAt!);
                return (
                    elapsed >= 0 &&
                    elapsed % (rule.intervalHours! * HOUR) === 0 &&
                    intervalWeekdayMatches(rule, parts.day)
                );
            }
            const { unit, value } = intervalUnitAndValue(rule);
            const anchor = localParts(new Date(rule.anchorAt!), formatter(timezone));
            if (minute < Date.parse(rule.anchorAt!)) return false;
            if (rule.time !== undefined) {
                if (parts.time !== rule.time || !calendarIntervalDayMatches(rule, anchor, parts)) return false;
                return Date.parse(datetimeLocalToISOString(`${parts.date}T${rule.time}`, timezone)) === minute;
            }
            if (!intervalWeekdayMatches(rule, parts.day)) return false;
            if (unit === 'hour') {
                const elapsed = minute - Date.parse(rule.anchorAt!);
                return elapsed >= 0 && elapsed % (value * HOUR) === 0;
            }
            if (parts.time !== anchor.time) return false;
            const difference = localIntervalIndex(anchor.day, parts.day, anchor.date, parts.date, unit);
            const step = unit === 'week' ? value * 7 : value;
            if (difference < 0 || difference % step !== 0) return false;
            return localIntervalCandidate(anchor, difference / step, unit, value, timezone)?.getTime() === minute;
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
            const { unit, value } = intervalUnitAndValue(rule);
            if (rule.time !== undefined) {
                const anchorLocal = localParts(new Date(anchor), format);
                const difference = calendarIntervalDifference(anchorLocal, start, unit);
                const first = Math.max(0, Math.floor(difference / value));
                // Gregorian month/date combinations repeat after 4,800 months.
                // Bound impossible interval phases while iterating periods, not minutes.
                for (let index = first; index < first + 4800 && runs.length < count; index++) {
                    for (const candidateDay of calendarIntervalDays(rule, anchorLocal, index)) {
                        if (runs.length >= count) break;
                        try {
                            const candidate = new Date(
                                datetimeLocalToISOString(
                                    `${candidateDay.toISOString().slice(0, 10)}T${rule.time}`,
                                    timezone
                                )
                            );
                            if (candidate.getTime() >= anchor && candidate.getTime() > after.getTime())
                                runs.push(candidate);
                        } catch {
                            // Missing calendar dates and wall times have no execution.
                        }
                    }
                }
                return runs;
            }
            if (structuredInterval(rule) && unit !== 'hour') {
                const anchorLocal = localParts(new Date(anchor), format);
                const difference = localIntervalIndex(anchorLocal.day, start.day, anchorLocal.date, start.date, unit);
                const step = unit === 'week' ? value * 7 : value;
                const first = Math.max(0, Math.floor(difference / step));
                for (let index = first; index < first + 1000 && runs.length < count; index++) {
                    const candidate = localIntervalCandidate(anchorLocal, index, unit, value, timezone);
                    if (!candidate || candidate.getTime() < anchor || candidate.getTime() <= after.getTime()) continue;
                    const local = localParts(candidate, format);
                    if (intervalWeekdayMatches(rule, local.day)) runs.push(candidate);
                }
                return runs;
            }
            const step = value * HOUR;
            const first = Math.max(0, Math.floor((after.getTime() - anchor) / step) + 1);
            // Gregorian dates repeat every 400 years. This also bounds an interval
            // whose UTC cadence can never land on any selected local weekday.
            const horizon = Math.max(400, count * 8) * 366 * DAY;
            const limit = first + Math.ceil(horizon / step);
            for (let index = first; index <= limit && runs.length < count; index++) {
                const candidate = new Date(anchor + index * step);
                if (!Number.isFinite(candidate.getTime())) break;
                const local = localParts(candidate, format);
                if (intervalWeekdayMatches(rule, local.day)) runs.push(candidate);
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
