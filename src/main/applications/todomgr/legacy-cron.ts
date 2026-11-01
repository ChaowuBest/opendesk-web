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

import { getTodoRecurrenceError, type TodoRecurrence } from './todo-recurrence.js';

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

/** Read the clock even when the calendar rule cannot be represented by the picker. */
export function getLegacyCronTime(expression: string): string | undefined {
    return typeof expression === 'string' ? fixedClock(expression.trim().split(/\s+/)) : undefined;
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
