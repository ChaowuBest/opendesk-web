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

import { describeLegacyRecurrence, describeTodoRecurrence } from '../../../../common/utils/recurrence-description.js';
import { getTodoRecurrenceError, type TodoRecurrence } from '../../../../common/utils/todo-recurrence.js';
import { formatDatetimeLocal } from '../../../../common/utils/timezone.js';

type Translate = (key: string, params?: Record<string, string | number>) => string;
interface LegacyTrigger {
    cronExpression?: string;
    recurrence?: TodoRecurrence;
}

const offsetCache = new Map<string, number[]>();
const formatters = new Map<string, Intl.DateTimeFormat>();

function numbers(value: string, min: number, max: number, ranges = false): number[] | undefined {
    const result = new Set<number>();
    for (const part of value.split(',')) {
        const match = (ranges ? /^(\d+)(?:-(\d+))?$/ : /^(\d+)$/).exec(part);
        if (!match) return;
        const start = Number(match[1]);
        const end = Number(match[2] ?? match[1]);
        if (start < min || end > max || start > end) return;
        for (let value = start; value <= end; value++) result.add(value);
    }
    return [...result].sort((a, b) => a - b);
}

function fixedClock(fields: string[]): string | undefined {
    if (fields.length !== 5) return;
    const [minute, hour] = fields;
    if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour) || Number(minute) > 59 || Number(hour) > 23) return;
    return `${String(Number(hour)).padStart(2, '0')}:${String(Number(minute)).padStart(2, '0')}`;
}

/** Parse only cron rules whose calendar semantics fit the structured picker. */
export function parseLegacyCronRecurrence(expression: string): TodoRecurrence | undefined {
    if (typeof expression !== 'string') return;
    const fields = expression.trim().split(/\s+/);
    const time = fixedClock(fields);
    if (!time) return;
    const [, , day, month, weekday] = fields;
    if (day !== '*' && weekday !== '*') return;
    let recurrence: TodoRecurrence;
    if (day === '*' && month === '*') {
        if (weekday === '*') recurrence = { mode: 'daily', time };
        else {
            const days = numbers(weekday, 0, 7, true);
            if (!days) return;
            recurrence = { mode: 'weekly', time, weekdays: [...new Set(days.map((day) => day % 7))].sort() };
        }
    } else {
        if (weekday !== '*') return;
        const days = numbers(day, 1, 31);
        if (!days) return;
        if (month === '*') recurrence = { mode: 'monthly', time, days };
        else {
            const months = numbers(month, 1, 12);
            if (!months) return;
            recurrence = { mode: 'yearly', time, days, months };
        }
    }
    return getTodoRecurrenceError(recurrence) ? undefined : recurrence;
}

function yearlyOffsets(timezone: string, year: number): number[] {
    const key = `${timezone}:${year}`;
    const cached = offsetCache.get(key);
    if (cached) return cached;
    let formatter = formatters.get(timezone);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat('en-US', {
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
        formatters.set(timezone, formatter);
    }
    const offsets = new Set<number>();
    const end = Date.UTC(year + 1, 0, 1);
    // Daily samples catch seasonal changes; cache them so lists of cards share this work.
    for (let instant = Date.UTC(year, 0, 1, 12); instant < end; instant += 86_400_000) {
        const parts = Object.fromEntries(
            formatter.formatToParts(new Date(instant)).map(({ type, value }) => [type, value])
        );
        const localAsUTC = Date.UTC(
            Number(parts.year),
            Number(parts.month) - 1,
            Number(parts.day),
            Number(parts.hour),
            Number(parts.minute)
        );
        offsets.add((localAsUTC - instant) / 60_000);
    }
    const result = [...offsets].sort((a, b) => a - b);
    offsetCache.set(key, result);
    return result;
}

function localClock(time: string, offset: number): { time: string; dayShift: number } {
    const [hour, minute] = time.split(':').map(Number);
    const minutes = hour * 60 + minute + offset;
    const dayShift = Math.floor(minutes / 1440);
    const clock = ((minutes % 1440) + 1440) % 1440;
    return {
        time: `${String(Math.floor(clock / 60)).padStart(2, '0')}:${String(clock % 60).padStart(2, '0')}`,
        dayShift
    };
}

function projectRecurrence(recurrence: TodoRecurrence, offset: number): TodoRecurrence | undefined {
    if (!recurrence.time) return;
    const local = localClock(recurrence.time, offset);
    const copy = { ...recurrence, time: local.time };
    if (copy.weekdays) copy.weekdays = [...copy.weekdays];
    if (copy.days) copy.days = [...copy.days];
    if (copy.months) copy.months = [...copy.months];
    switch (recurrence.mode) {
        case 'daily':
            return copy;
        case 'weekly':
            copy.weekdays = [...new Set(recurrence.weekdays!.map((day) => (day + local.dayShift + 7) % 7))].sort();
            return copy;
        case 'monthly':
        case 'yearly':
            // Crossing midnight changes month-end and leap-day eligibility, not just the date label.
            return local.dayShift === 0 ? copy : undefined;
        default:
            return;
    }
}

/** Display a legacy UTC schedule in local time without changing its execution rule. */
export function getLegacyCronDisplay(
    trigger: LegacyTrigger,
    timezone: string,
    t: Translate,
    now: Date = new Date()
): { recurrence?: TodoRecurrence; summary: string } {
    const recurrence = trigger.recurrence ?? parseLegacyCronRecurrence(trigger.cronExpression ?? '');
    const validRecurrence = recurrence && !getTodoRecurrenceError(recurrence) ? recurrence : undefined;
    const rule = recurrence
        ? describeTodoRecurrence(recurrence, t, 'UTC')
        : describeLegacyRecurrence(trigger.cronExpression ?? '', t, 'UTC');
    const advanced = () => ({ summary: rule });
    const converted = (times: string) => ({ summary: `${rule} → ${times} (${timezone})` });
    const time =
        validRecurrence?.time ??
        (!trigger.recurrence ? fixedClock((trigger.cronExpression ?? '').trim().split(/\s+/)) : undefined);
    if (!validRecurrence && !time) return advanced();
    try {
        if (!time) {
            if (validRecurrence?.mode !== 'interval' || !validRecurrence.anchorAt) return advanced();
            return converted(formatDatetimeLocal(validRecurrence.anchorAt, timezone).replace('T', ' '));
        }
        const offsets = yearlyOffsets(timezone, now.getUTCFullYear());
        const projected =
            validRecurrence && offsets.length === 1 ? projectRecurrence(validRecurrence, offsets[0]) : undefined;
        if (projected) return { recurrence: projected, summary: describeTodoRecurrence(projected, t, timezone) };
        const times = offsets
            .map((offset) => {
                const local = localClock(time, offset);
                return local.dayShift === 0
                    ? local.time
                    : `${local.time}(${local.dayShift > 0 ? '+' : ''}${local.dayShift})`;
            })
            .join(t('recurrence.desc.separator'));
        return converted(times);
    } catch {
        return advanced();
    }
}
