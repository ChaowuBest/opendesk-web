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

import { describeLegacyRecurrence, describeTodoRecurrence } from '../recurrence-description.js';
import { getTodoRecurrenceError, type TodoRecurrence } from '../todo-recurrence.js';
import { formatDatetimeLocal } from '../timezone.js';
import { getLegacyCronTime, parseLegacyCronRecurrence } from '../legacy-cron.js';

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** Project editable UTC calendar fields without changing the stored trigger. */
export function getLegacyRecurrenceInTimezone(
    trigger: { cronExpression?: string; recurrence?: TodoRecurrence },
    timezone: string,
    now: Date = new Date()
): TodoRecurrence | undefined {
    const recurrence = trigger.recurrence ?? parseLegacyCronRecurrence(trigger.cronExpression ?? '');
    if (!recurrence || getTodoRecurrenceError(recurrence)) return;
    if (timezone === 'UTC') return recurrence;
    if (!['daily', 'weekly', 'monthly', 'yearly'].includes(recurrence.mode)) return;
    try {
        const date = formatDatetimeLocal(now.toISOString(), timezone).slice(0, 10);
        const local = formatDatetimeLocal(`${date}T${recurrence.time}:00Z`, timezone);
        const dayShift = (Date.parse(`${local.slice(0, 10)}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000;
        if (dayShift !== 0 && (recurrence.mode === 'monthly' || recurrence.mode === 'yearly')) return;
        return {
            ...recurrence,
            time: local.slice(11, 16),
            ...(recurrence.mode === 'weekly'
                ? { weekdays: [...new Set(recurrence.weekdays!.map((day) => (day + dayShift + 7) % 7))].sort() }
                : {})
        };
    } catch {
        return;
    }
}

/** Display a stored UTC rule using today's local offset without rewriting its schedule. */
export function describeLegacyCronInTimezone(
    trigger: { cronExpression?: string; recurrence?: TodoRecurrence },
    timezone: string,
    t: Translate,
    now: Date = new Date()
): string {
    const recurrence = trigger.recurrence ?? parseLegacyCronRecurrence(trigger.cronExpression ?? '');
    const valid = recurrence && !getTodoRecurrenceError(recurrence) ? recurrence : undefined;
    const rule = recurrence
        ? describeTodoRecurrence(recurrence, t, 'UTC')
        : describeLegacyRecurrence(trigger.cronExpression ?? '', t, 'UTC');
    if (timezone === 'UTC') return rule;
    const displayed = getLegacyRecurrenceInTimezone(trigger, timezone, now);
    if (displayed) return describeTodoRecurrence(displayed, t, timezone);
    const time = valid?.time ?? (!trigger.recurrence ? getLegacyCronTime(trigger.cronExpression ?? '') : undefined);
    try {
        if (!time) {
            if (valid?.mode !== 'interval' || !valid.anchorAt) return rule;
            return `${rule} → ${formatDatetimeLocal(valid.anchorAt, timezone).replace('T', ' ')} (${timezone})`;
        }
        // Convert an actual UTC occurrence on today's date so DST is resolved at the execution time.
        const date = formatDatetimeLocal(now.toISOString(), timezone).slice(0, 10);
        const local = formatDatetimeLocal(`${date}T${time}:00Z`, timezone);
        const localTime = local.slice(11, 16);
        const dayShift = (Date.parse(`${local.slice(0, 10)}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000;
        // Month/year boundaries cannot be represented by simply shifting a recurring date label.
        const suffix = dayShift === 0 ? '' : `(${dayShift > 0 ? '+' : ''}${dayShift})`;
        return `${rule} → ${localTime}${suffix} (${timezone})`;
    } catch {
        return rule;
    }
}
