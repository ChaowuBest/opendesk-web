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
import { getLegacyCronTime, parseLegacyCronRecurrence } from '../../../../common/utils/legacy-cron.js';

type Translate = (key: string, params?: Record<string, string | number>) => string;

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
        if (
            valid?.mode === 'daily' ||
            valid?.mode === 'weekly' ||
            (dayShift === 0 && (valid?.mode === 'monthly' || valid?.mode === 'yearly'))
        ) {
            const displayed = { ...valid, time: localTime };
            if (valid.mode === 'weekly')
                displayed.weekdays = [...new Set(valid.weekdays!.map((day) => (day + dayShift + 7) % 7))].sort();
            return describeTodoRecurrence(displayed, t, timezone);
        }
        // Month/year boundaries cannot be represented by simply shifting a recurring date label.
        const suffix = dayShift === 0 ? '' : `(${dayShift > 0 ? '+' : ''}${dayShift})`;
        return `${rule} → ${localTime}${suffix} (${timezone})`;
    } catch {
        return rule;
    }
}
