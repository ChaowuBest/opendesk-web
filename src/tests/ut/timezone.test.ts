import { describe, expect, test } from '@jest/globals';
import {
    datetimeLocalToISOString,
    formatDateTimeInTimezone,
    formatDatetimeLocal,
    getSystemTimezone,
    isValidTimezone
} from '../../main/applications/todomgr/timezone.js';

describe('task timezones', () => {
    test('validates IANA zones and provides a usable system zone', () => {
        expect(isValidTimezone('Asia/Shanghai')).toBe(true);
        expect(isValidTimezone('UTC')).toBe(true);
        expect(isValidTimezone('Invalid/Timezone')).toBe(false);
        expect(isValidTimezone('')).toBe(false);
        expect(isValidTimezone('+08:00')).toBe(false);
        expect(isValidTimezone(getSystemTimezone())).toBe(true);
    });

    test.each([
        ['2026-10-20T09:00', 'Asia/Shanghai', '2026-10-20T01:00:00.000Z'],
        ['2026-10-20T00:15', 'Asia/Kathmandu', '2026-10-19T18:30:00.000Z'],
        ['2026-10-20T23:30', 'America/St_Johns', '2026-10-21T02:00:00.000Z'],
        ['2026-01-20T09:00', 'America/New_York', '2026-01-20T14:00:00.000Z'],
        ['2026-07-20T09:00', 'America/New_York', '2026-07-20T13:00:00.000Z']
    ])('converts wall time %s in %s independently of the host', (value, timezone, expected) => {
        expect(datetimeLocalToISOString(value, timezone)).toBe(expected);
        expect(formatDatetimeLocal(expected, timezone)).toBe(value);
    });

    test('rejects times skipped by daylight saving and skipped calendar dates', () => {
        expect(() => datetimeLocalToISOString('2026-03-08T02:30', 'America/New_York')).toThrow(RangeError);
        expect(() => datetimeLocalToISOString('2026-10-04T02:15', 'Australia/Lord_Howe')).toThrow(RangeError);
        expect(() => datetimeLocalToISOString('2011-12-30T12:00', 'Pacific/Apia')).toThrow(RangeError);
    });

    test('chooses the earlier instant when clocks repeat a wall time', () => {
        expect(datetimeLocalToISOString('2026-11-01T01:30', 'America/New_York')).toBe('2026-11-01T05:30:00.000Z');
    });

    test.each(['2026-02-30T09:00', '2026-13-01T09:00', '2026-10-20T24:00', '2026-10-20', 'invalid'])(
        'rejects invalid wall time %s',
        (value) => {
            expect(() => datetimeLocalToISOString(value, 'UTC')).toThrow(RangeError);
        }
    );

    test('formats the requested zone and locale', () => {
        const iso = '2026-10-20T01:00:00Z';
        expect(formatDateTimeInTimezone(iso, 'Asia/Shanghai', 'en-US')).toBe(
            new Date(iso).toLocaleString('en-US', { timeZone: 'Asia/Shanghai' })
        );
        expect(formatDatetimeLocal(iso, 'UTC')).toBe('2026-10-20T01:00');
    });
});
