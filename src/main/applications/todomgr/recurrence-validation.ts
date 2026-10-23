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

import { getTodoRecurrenceError, type TodoRecurrence } from '../../../common/utils/todo-recurrence.js';

type Translator = (key: string, params?: Record<string, string | number>) => string;

export type RecurrenceValidationField =
    | 'frequency'
    | 'weekdays'
    | 'months'
    | 'days'
    | 'time'
    | 'intervalValue'
    | 'intervalUnit'
    | 'anchorDate'
    | 'anchorAt';

export interface RecurrenceValidationIssue {
    field: RecurrenceValidationField;
    message: string;
}

function integer(value: unknown, min: number, max: number): boolean {
    return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function selection(values: unknown, legacy: unknown, min: number, max: number): boolean {
    if (values === undefined) return integer(legacy, min, max);
    return Array.isArray(values) && values.length > 0 && [...values].every((value) => integer(value, min, max));
}

/** Display the first actionable field error without changing engine validation or legacy compatibility. */
export function getRecurrenceValidationIssue(value: unknown, t: Translator): RecurrenceValidationIssue | null {
    const error = getTodoRecurrenceError(value);
    if (!error) return null;
    const issue = (field: RecurrenceValidationField, key: string, params?: Record<string, string | number>) => ({
        field,
        message: t(key, params)
    });
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return issue('frequency', 'error.recurrenceInvalid');
    const rule = value as TodoRecurrence;
    if (!['daily', 'weekly', 'biweekly', 'monthly', 'yearly', 'interval'].includes(rule.mode))
        return issue('frequency', 'error.recurrenceInvalid');

    const interval = rule.mode === 'interval';
    const structured = rule.intervalValue !== undefined || rule.intervalUnit !== undefined;
    if (interval) {
        const max = structured ? 10000 : 8760;
        if (!integer(structured ? rule.intervalValue : rule.intervalHours, 1, max))
            return issue('intervalValue', 'error.recurrenceIntervalValue', { max });
        if (structured && !['hour', 'day', 'week', 'month', 'year'].includes(rule.intervalUnit!))
            return issue('intervalUnit', 'error.recurrenceIntervalUnit');
    }

    const calendarInterval =
        interval &&
        structured &&
        rule.intervalUnit !== 'hour' &&
        (rule.time !== undefined || rule.days !== undefined || rule.months !== undefined);
    const yearly = rule.mode === 'yearly' || (calendarInterval && rule.intervalUnit === 'year');
    const monthly = rule.mode === 'monthly' || yearly || (calendarInterval && rule.intervalUnit === 'month');
    const weekly =
        rule.mode === 'weekly' ||
        rule.mode === 'biweekly' ||
        (interval && (calendarInterval ? rule.intervalUnit === 'week' : !structured || rule.weekdays !== undefined));

    if (yearly && !selection(rule.months, interval ? undefined : rule.month, 1, 12))
        return issue('months', 'error.recurrenceMonthsRequired');
    if (monthly && !selection(rule.days, interval ? undefined : rule.day, 1, 31))
        return issue('days', 'error.recurrenceDaysRequired');
    if (weekly && !selection(rule.weekdays, undefined, 0, 6))
        return issue('weekdays', 'error.recurrenceWeekdaysRequired');
    if (
        (!interval || calendarInterval) &&
        (typeof rule.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(rule.time))
    )
        return issue('time', 'error.recurrenceTimeRequired');

    switch (error) {
        case 'Invalid biweekly anchor':
            return issue('anchorDate', 'error.recurrenceAnchorDateInvalid');
        case 'Invalid interval anchor':
            return issue('anchorAt', 'error.recurrenceAnchorAtInvalid');
        case 'This date never occurs':
            return issue('days', 'error.recurrenceDateImpossible');
        default:
            return issue('frequency', 'error.recurrenceInvalid');
    }
}

export function getRecurrenceValidationMessage(value: unknown, t: Translator): string | null {
    return getRecurrenceValidationIssue(value, t)?.message ?? null;
}
