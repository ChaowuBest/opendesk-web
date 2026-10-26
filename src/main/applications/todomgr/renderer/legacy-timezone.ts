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
import { createWallClockFormatter, formatDatetimeLocal } from '../../../../common/utils/timezone.js';
import { getLegacyCronTime, parseLegacyCronRecurrence } from '../../../../common/utils/legacy-cron.js';

type Translate = (key: string, params?: Record<string, string | number>) => string;
interface LegacyTrigger {
    cronExpression?: string;
    recurrence?: TodoRecurrence;
}

const offsetCache = new Map<string, number[]>();

function yearlyOffsets(timezone: string, year: number): number[] {
    const key = `${timezone}:${year}`;
    const cached = offsetCache.get(key);
    if (cached) return cached;
    const formatter = createWallClockFormatter(timezone);
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
        validRecurrence?.time ?? (!trigger.recurrence ? getLegacyCronTime(trigger.cronExpression ?? '') : undefined);
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
