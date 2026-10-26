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

import {
    getTodoRecurrenceDays,
    getTodoRecurrenceError,
    getTodoRecurrenceMonths,
    type TodoRecurrence
} from './todo-recurrence.js';
import { parseLegacyCronRecurrence } from './legacy-cron.js';

type Translator = (key: string, params?: Record<string, string | number>) => string;

function describeDays(days: number[], t: Translator): string {
    return [...new Set(days)]
        .sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
        .map((day) => t(`date.dow.${day}`))
        .join(t('recurrence.desc.separator'));
}

export function describeTodoRecurrence(
    recurrence: TodoRecurrence,
    t: Translator,
    timezone: string,
    showTimezone = true
): string {
    if (getTodoRecurrenceError(recurrence))
        return `${t('common.recurrence.legacy')}${showTimezone ? ` (${timezone})` : ''}`;
    const params: Record<string, string | number> = { time: recurrence.time ?? '' };
    let description = `recurrence.desc.${recurrence.mode}`;
    switch (recurrence.mode) {
        case 'weekly':
        case 'biweekly':
            params.days = describeDays(recurrence.weekdays!, t);
            params.anchorDate = recurrence.anchorDate ?? '';
            break;
        case 'monthly':
            params.day = getTodoRecurrenceDays(recurrence)[0];
            params.days = getTodoRecurrenceDays(recurrence).join(t('recurrence.desc.separator'));
            break;
        case 'yearly':
            params.day = getTodoRecurrenceDays(recurrence)[0];
            params.month = t(`date.month.${getTodoRecurrenceMonths(recurrence)[0]}`);
            params.days = getTodoRecurrenceDays(recurrence).join(t('recurrence.desc.separator'));
            params.months = getTodoRecurrenceMonths(recurrence)
                .map((month) => t(`date.month.${month}`))
                .join(t('recurrence.desc.separator'));
            break;
        case 'interval':
            params.days = recurrence.weekdays ? describeDays(recurrence.weekdays, t) : '';
            params.value = recurrence.intervalValue ?? recurrence.intervalHours!;
            // Keep this shared description independent from TodoMgr's renderer dictionary.
            // The TUI passes the core translator, which does not include renderer.todo.* keys.
            params.unit = t(`recurrence.desc.intervalUnit.${recurrence.intervalUnit ?? 'hour'}`);
            if (recurrence.time !== undefined) {
                switch (recurrence.intervalUnit) {
                    case 'day':
                        description = 'recurrence.desc.intervalDaily';
                        break;
                    case 'week':
                        description = 'recurrence.desc.intervalWeekly';
                        break;
                    case 'month':
                        description = 'recurrence.desc.intervalMonthly';
                        params.days = getTodoRecurrenceDays(recurrence).join(t('recurrence.desc.separator'));
                        break;
                    case 'year':
                        description = 'recurrence.desc.intervalYearly';
                        params.days = getTodoRecurrenceDays(recurrence).join(t('recurrence.desc.separator'));
                        params.months = getTodoRecurrenceMonths(recurrence)
                            .map((month) => t(`date.month.${month}`))
                            .join(t('recurrence.desc.separator'));
                        break;
                }
            }
            break;
    }
    const multiple =
        (recurrence.mode === 'monthly' || recurrence.mode === 'yearly') &&
        (getTodoRecurrenceDays(recurrence).length > 1 ||
            (recurrence.mode === 'yearly' && getTodoRecurrenceMonths(recurrence).length > 1));
    const text = t(`${description}${multiple ? 'Multiple' : ''}`, params);
    return showTimezone ? `${text} (${timezone})` : text;
}

function numberField(value: string, min: number, max: number): number | null {
    if (!/^\d+$/.test(value)) return null;
    const number = Number(value);
    return Number.isInteger(number) && number >= min && number <= max ? number : null;
}

/** Only describe unambiguous simple legacy rules; keep other stored rules opaque. */
export function describeLegacyRecurrence(expression: string, t: Translator, timezone: string): string {
    const fallback = `${t('common.recurrence.legacy')} (${timezone})`;
    if (typeof expression !== 'string') return fallback;
    const fields = expression.trim().split(/\s+/);
    if (fields.length !== 5) return fallback;
    const [minute, hour, day, month, weekday] = fields;
    if (fields.every((field) => field === '*')) return `${t('recurrence.desc.everyMinute')} (${timezone})`;
    if (day === '*' && month === '*' && weekday === '*') {
        const minuteStep = /^\*\/(\d+)$/.exec(minute);
        if (hour === '*' && minuteStep && numberField(minuteStep[1], 1, 59) !== null) {
            return `${t('recurrence.desc.everyMinutes', { minutes: Number(minuteStep[1]) })} (${timezone})`;
        }
        const fixedMinute = numberField(minute, 0, 59);
        const hourStep = /^\*\/(\d+)$/.exec(hour);
        if (fixedMinute !== null && hour === '*') {
            return `${t('recurrence.desc.hourly', { minute: fixedMinute })} (${timezone})`;
        }
        if (fixedMinute !== null && hourStep && numberField(hourStep[1], 1, 23) !== null) {
            return `${t('recurrence.desc.everyHours', { hours: Number(hourStep[1]), minute: fixedMinute })} (${timezone})`;
        }
    }
    const recurrence = parseLegacyCronRecurrence(expression);
    return recurrence ? describeTodoRecurrence(recurrence, t, timezone) : fallback;
}
