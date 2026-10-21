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

export function isValidTimezone(timezone: string): boolean {
    if (typeof timezone !== 'string' || !timezone || /^[+-]/.test(timezone)) return false;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
        return true;
    } catch {
        return false;
    }
}

export function getSystemTimezone(): string {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function wallTimeFormatter(timezone: string): Intl.DateTimeFormat {
    return new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        calendar: 'gregory',
        numberingSystem: 'latn',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23'
    });
}

function wallTimeParts(date: Date, formatter: Intl.DateTimeFormat): Record<string, string> {
    return Object.fromEntries(formatter.formatToParts(date).map(({ type, value }) => [type, value]));
}

function wallTimeString(parts: Record<string, string>): string {
    return `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

export function formatDatetimeLocal(iso: string, timezone: string): string {
    return wallTimeString(wallTimeParts(new Date(iso), wallTimeFormatter(timezone))).slice(0, 16);
}

export function formatDateTimeInTimezone(iso: string, timezone: string, locale?: string): string {
    return new Date(iso).toLocaleString(locale, { timeZone: timezone });
}

/** Convert an entered wall time independently of the host timezone. */
export function datetimeLocalToISOString(value: string, timezone: string): string {
    const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(value);
    if (!match || !isValidTimezone(timezone)) throw new RangeError('Invalid datetime or timezone');
    const wallTime = `${match[1]}:${match[2] || '00'}`;
    const milliseconds = (match[3] || '').padEnd(3, '0');
    const naive = Date.parse(`${wallTime}.${milliseconds}Z`);
    if (!Number.isFinite(naive) || new Date(naive).toISOString().slice(0, 19) !== wallTime) {
        throw new RangeError('Invalid datetime');
    }

    const formatter = wallTimeFormatter(timezone);
    const offsets = new Set<number>();
    // Sample both sides of a transition, including zones whose date changes by a whole day.
    for (let hours = -36; hours <= 36; hours += 12) {
        const sample = new Date(naive + hours * 3_600_000);
        const localAsUTC = Date.parse(`${wallTimeString(wallTimeParts(sample, formatter))}Z`);
        offsets.add(localAsUTC - (sample.getTime() - sample.getUTCMilliseconds()));
    }

    const candidates = [...offsets]
        .map((offset) => naive - offset)
        .filter((instant) => wallTimeString(wallTimeParts(new Date(instant), formatter)) === wallTime);
    if (candidates.length === 0) throw new RangeError('Datetime does not exist in timezone');
    // Repeated wall times use the first occurrence, matching the recurring scheduler.
    return new Date(Math.min(...candidates)).toISOString();
}
