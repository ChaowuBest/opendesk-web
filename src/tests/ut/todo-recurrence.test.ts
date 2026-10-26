import { jest } from '@jest/globals';
import {
    getNextTodoRecurrenceRuns,
    getTodoRecurrenceDays,
    getTodoRecurrenceError,
    getTodoRecurrenceMonths,
    matchesTodoRecurrence,
    type TodoRecurrence
} from '../../common/utils/todo-recurrence.js';

function next(rule: TodoRecurrence, zone: string, after: string, count = 3): string[] {
    return getNextTodoRecurrenceRuns(rule, zone, count, new Date(after)).map((date) => date.toISOString());
}

describe('calendar and elapsed-hour todo recurrence', () => {
    test.each([
        null,
        { mode: 'other' },
        { mode: 'daily', time: '24:00' },
        { mode: 'daily', time: '09:00', weekdays: [1] },
        { mode: 'weekly', time: '09:00', weekdays: [1], intervalHours: 2 },
        { mode: 'weekly', time: '09:00', weekdays: [] },
        { mode: 'weekly', time: '09:00', weekdays: [7] },
        { mode: 'biweekly', time: '09:00', weekdays: [1], anchorDate: '2026-02-30' },
        { mode: 'monthly', time: '09:00', day: 0 },
        { mode: 'yearly', time: '09:00', month: 2, day: 30 },
        { mode: 'interval', intervalHours: 0, weekdays: [1], anchorAt: '2026-01-01T00:00:00Z' },
        { mode: 'interval', intervalHours: 1, weekdays: [], anchorAt: '2026-01-01T00:00:00Z' },
        { mode: 'interval', intervalHours: 1, weekdays: [1], anchorAt: '2026-01-01T00:00:31Z' }
    ])('rejects an invalid rule: %j', (rule) => {
        expect(getTodoRecurrenceError(rule)).not.toBeNull();
        expect(matchesTodoRecurrence(rule as TodoRecurrence, new Date(), 'UTC')).toBe(false);
    });

    test('daily follows the chosen timezone and skips the spring DST gap', () => {
        const rule: TodoRecurrence = { mode: 'daily', time: '02:30' };
        expect(next(rule, 'America/New_York', '2026-03-07T08:00:00Z')).toEqual([
            '2026-03-09T06:30:00.000Z',
            '2026-03-10T06:30:00.000Z',
            '2026-03-11T06:30:00.000Z'
        ]);
        expect(matchesTodoRecurrence(rule, new Date('2026-03-09T06:30:42Z'), 'America/New_York')).toBe(true);
    });

    test.each([
        ['America/New_York', '2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z', '01:30'],
        ['Australia/Lord_Howe', '2026-04-04T14:45:00Z', '2026-04-04T15:15:00Z', '01:45']
    ])('calendar rules trigger only the first repeated wall time in %s', (zone, first, repeated, time) => {
        const rule: TodoRecurrence = { mode: 'daily', time };
        expect(matchesTodoRecurrence(rule, new Date(first), zone)).toBe(true);
        expect(matchesTodoRecurrence(rule, new Date(repeated), zone)).toBe(false);
        expect(next(rule, zone, first, 1)).not.toContain(new Date(repeated).toISOString());
    });

    test('weekly allows several weekdays', () => {
        expect(
            next({ mode: 'weekly', time: '09:00', weekdays: [1, 5] }, 'Asia/Shanghai', '2026-10-22T01:00:00Z')
        ).toEqual(['2026-10-23T01:00:00.000Z', '2026-10-26T01:00:00.000Z', '2026-10-30T01:00:00.000Z']);
    });

    test('a skipped local calendar day never shifts the chosen execution time', () => {
        expect(next({ mode: 'daily', time: '09:00' }, 'Pacific/Apia', '2011-12-29T20:00:00Z', 2)).toEqual([
            '2011-12-30T19:00:00.000Z',
            '2011-12-31T19:00:00.000Z'
        ]);
    });

    test('biweekly uses calendar weeks across a year boundary', () => {
        const rule: TodoRecurrence = { mode: 'biweekly', time: '09:00', weekdays: [1, 5], anchorDate: '2026-12-31' };
        expect(next(rule, 'UTC', '2026-12-31T12:00:00Z')).toEqual([
            '2027-01-01T09:00:00.000Z',
            '2027-01-11T09:00:00.000Z',
            '2027-01-15T09:00:00.000Z'
        ]);
    });

    test('biweekly keeps its parity across DST instead of dividing UTC milliseconds', () => {
        const rule: TodoRecurrence = { mode: 'biweekly', time: '09:00', weekdays: [1], anchorDate: '2026-03-02' };
        expect(next(rule, 'America/New_York', '2026-03-02T15:00:00Z')).toEqual([
            '2026-03-16T13:00:00.000Z',
            '2026-03-30T13:00:00.000Z',
            '2026-04-13T13:00:00.000Z'
        ]);
    });

    test('monthly skips months without the selected date', () => {
        expect(next({ mode: 'monthly', time: '09:00', day: 31 }, 'UTC', '2026-01-31T10:00:00Z')).toEqual([
            '2026-03-31T09:00:00.000Z',
            '2026-05-31T09:00:00.000Z',
            '2026-07-31T09:00:00.000Z'
        ]);
    });

    test('yearly leap-day preview jumps between matching years', () => {
        expect(next({ mode: 'yearly', time: '09:00', month: 2, day: 29 }, 'UTC', '2096-02-29T10:00:00Z')).toEqual([
            '2104-02-29T09:00:00.000Z',
            '2108-02-29T09:00:00.000Z',
            '2112-02-29T09:00:00.000Z'
        ]);
    });

    test('monthly dates are combined in execution order and missing dates are skipped', () => {
        const rule: TodoRecurrence = { mode: 'monthly', time: '09:00', days: [31, 15, 1, 15] };
        const original = structuredClone(rule);
        expect(getTodoRecurrenceError(rule)).toBeNull();
        expect(next(rule, 'Asia/Shanghai', '2026-01-31T02:00:00Z', 6)).toEqual([
            '2026-02-01T01:00:00.000Z',
            '2026-02-15T01:00:00.000Z',
            '2026-03-01T01:00:00.000Z',
            '2026-03-15T01:00:00.000Z',
            '2026-03-31T01:00:00.000Z',
            '2026-04-01T01:00:00.000Z'
        ]);
        expect(matchesTodoRecurrence(rule, new Date('2026-03-31T01:00:42Z'), 'Asia/Shanghai')).toBe(true);
        expect(matchesTodoRecurrence(rule, new Date('2026-03-03T01:00:00Z'), 'Asia/Shanghai')).toBe(false);
        expect(rule).toEqual(original);
    });

    test('yearly months and dates use all valid combinations including leap days', () => {
        const rule: TodoRecurrence = { mode: 'yearly', time: '09:00', months: [6, 2, 3, 2], days: [31, 29, 30, 29] };
        const original = structuredClone(rule);
        expect(getTodoRecurrenceError(rule)).toBeNull();
        expect(next(rule, 'UTC', '2027-02-01T00:00:00Z', 10)).toEqual([
            '2027-03-29T09:00:00.000Z',
            '2027-03-30T09:00:00.000Z',
            '2027-03-31T09:00:00.000Z',
            '2027-06-29T09:00:00.000Z',
            '2027-06-30T09:00:00.000Z',
            '2028-02-29T09:00:00.000Z',
            '2028-03-29T09:00:00.000Z',
            '2028-03-30T09:00:00.000Z',
            '2028-03-31T09:00:00.000Z',
            '2028-06-29T09:00:00.000Z'
        ]);
        expect(matchesTodoRecurrence(rule, new Date('2028-02-29T09:00:00Z'), 'UTC')).toBe(true);
        expect(matchesTodoRecurrence(rule, new Date('2028-05-31T09:00:00Z'), 'UTC')).toBe(false);
        expect(matchesTodoRecurrence(rule, new Date('2028-07-01T09:00:00Z'), 'UTC')).toBe(false);
        expect(rule).toEqual(original);
    });

    test('array values take priority over legacy scalars without changing either input', () => {
        const legacy: TodoRecurrence = { mode: 'yearly', time: '09:00', month: 12, day: 25 };
        expect(getTodoRecurrenceDays(legacy)).toEqual([25]);
        expect(getTodoRecurrenceMonths(legacy)).toEqual([12]);
        expect(next(legacy, 'UTC', '2026-01-01T00:00:00Z', 1)).toEqual(['2026-12-25T09:00:00.000Z']);
        const rule: TodoRecurrence = { ...legacy, months: [6, 3, 6], days: [15, 1, 15] };
        const days = getTodoRecurrenceDays(rule);
        expect(days).toEqual([1, 15]);
        expect(getTodoRecurrenceMonths(rule)).toEqual([3, 6]);
        days.push(20);
        expect(rule.days).toEqual([15, 1, 15]);
        expect(next(rule, 'UTC', '2026-01-01T00:00:00Z', 4)).toEqual([
            '2026-03-01T09:00:00.000Z',
            '2026-03-15T09:00:00.000Z',
            '2026-06-01T09:00:00.000Z',
            '2026-06-15T09:00:00.000Z'
        ]);
        expect(getTodoRecurrenceDays({ ...legacy, days: [] })).toEqual([]);
        expect(getTodoRecurrenceMonths({ ...legacy, months: [] })).toEqual([]);
    });

    test('multi-date rules generate bounded calendar candidates rather than scanning minutes', () => {
        const format = jest.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
        try {
            const rule: TodoRecurrence = { mode: 'yearly', time: '09:00', months: [2], days: [29] };
            expect(next(rule, 'UTC', '2096-02-29T10:00:00Z', 2)).toEqual([
                '2104-02-29T09:00:00.000Z',
                '2108-02-29T09:00:00.000Z'
            ]);
            expect(format.mock.calls.length).toBeLessThan(100);
        } finally {
            format.mockRestore();
        }
    });

    test('mixed valid and missing yearly dates retain the selection while impossible rules are rejected', () => {
        const rule: TodoRecurrence = { mode: 'yearly', time: '09:00', months: [2, 3], days: [30, 31] };
        expect(getTodoRecurrenceError(rule)).toBeNull();
        expect(next(rule, 'UTC', '2026-01-01T00:00:00Z')).toEqual([
            '2026-03-30T09:00:00.000Z',
            '2026-03-31T09:00:00.000Z',
            '2027-03-30T09:00:00.000Z'
        ]);
        expect(getTodoRecurrenceError({ ...rule, months: [2] })).not.toBeNull();
        expect(getTodoRecurrenceError({ ...rule, months: [2], days: [29] })).toBeNull();
    });

    test.each([
        { mode: 'monthly', time: '09:00', day: 1, days: [] },
        { mode: 'monthly', time: '09:00', days: [0] },
        { mode: 'monthly', time: '09:00', days: [32] },
        { mode: 'monthly', time: '09:00', days: [1.5] },
        { mode: 'monthly', time: '09:00', days: [NaN] },
        { mode: 'monthly', time: '09:00', days: Array(1) },
        { mode: 'monthly', time: '09:00', days: '1' },
        { mode: 'monthly', time: '09:00', days: [1], months: [1] },
        { mode: 'yearly', time: '09:00', month: 1, months: [], day: 1 },
        { mode: 'yearly', time: '09:00', months: [0], days: [1] },
        { mode: 'yearly', time: '09:00', months: [13], days: [1] },
        { mode: 'yearly', time: '09:00', months: [1.5], days: [1] },
        { mode: 'yearly', time: '09:00', months: [NaN], days: [1] },
        { mode: 'yearly', time: '09:00', months: '1', days: [1] },
        { mode: 'daily', time: '09:00', days: [1] },
        { mode: 'weekly', time: '09:00', weekdays: [1], months: [1] },
        { mode: 'interval', intervalHours: 1, weekdays: [1], anchorAt: '2026-01-01T00:00:00Z', days: [1] }
    ])('rejects malformed date arrays or unsupported combinations: %j', (rule) => {
        expect(getTodoRecurrenceError(rule)).not.toBeNull();
        expect(matchesTodoRecurrence(rule as TodoRecurrence, new Date('2026-01-01T09:00:00Z'), 'UTC')).toBe(false);
        expect(next(rule as TodoRecurrence, 'UTC', '2026-01-01T00:00:00Z')).toEqual([]);
    });

    test('five-hour intervals retain cadence across midnight and selected-day exclusions', () => {
        const rule: TodoRecurrence = {
            mode: 'interval',
            intervalHours: 5,
            weekdays: [1, 2, 3, 4, 5],
            anchorAt: '2026-10-23T22:00:00Z'
        };
        expect(next(rule, 'UTC', '2026-10-23T21:00:00Z')).toEqual([
            '2026-10-23T22:00:00.000Z',
            '2026-10-26T00:00:00.000Z',
            '2026-10-26T05:00:00.000Z'
        ]);
        expect(matchesTodoRecurrence(rule, new Date('2026-10-26T00:00:17Z'), 'UTC')).toBe(true);
        expect(matchesTodoRecurrence(rule, new Date('2026-10-26T01:00:00Z'), 'UTC')).toBe(false);
    });

    test('elapsed intervals can run at both repeated local hours', () => {
        const rule: TodoRecurrence = {
            mode: 'interval',
            intervalHours: 1,
            weekdays: [0],
            anchorAt: '2026-11-01T05:30:00Z'
        };
        expect(next(rule, 'America/New_York', '2026-11-01T05:00:00Z')).toEqual([
            '2026-11-01T05:30:00.000Z',
            '2026-11-01T06:30:00.000Z',
            '2026-11-01T07:30:00.000Z'
        ]);
    });

    test.each([
        ['hour', '2026-10-20T10:00:00.000Z'],
        ['day', '2026-10-21T09:00:00.000Z'],
        ['week', '2026-10-27T09:00:00.000Z'],
        ['month', '2026-11-20T09:00:00.000Z'],
        ['year', '2027-10-20T09:00:00.000Z']
    ])('structured intervals support %s calendar units', (unit, expected) => {
        const rule: TodoRecurrence = {
            mode: 'interval',
            intervalValue: 1,
            intervalUnit: unit as TodoRecurrence['intervalUnit'],
            anchorAt: '2026-10-20T09:00:00Z'
        };
        expect(getTodoRecurrenceError(rule)).toBeNull();
        expect(next(rule, 'UTC', '2026-10-20T09:01:00Z', 1)).toEqual([expected]);
        expect(matchesTodoRecurrence(rule, new Date(expected), 'UTC')).toBe(true);
    });

    test('structured day intervals follow local calendar time across DST', () => {
        const rule: TodoRecurrence = {
            mode: 'interval',
            intervalValue: 1,
            intervalUnit: 'day',
            anchorAt: '2026-03-07T14:00:00Z'
        };
        expect(next(rule, 'America/New_York', '2026-03-07T13:00:00Z', 2)).toEqual([
            '2026-03-07T14:00:00.000Z',
            '2026-03-08T13:00:00.000Z'
        ]);
    });

    test('calendar day intervals use the chosen time, skip DST gaps, and never run before the anchor', () => {
        const rule: TodoRecurrence = {
            mode: 'interval',
            intervalValue: 1,
            intervalUnit: 'day',
            anchorAt: '2026-03-07T08:00:00Z',
            time: '02:30'
        };
        expect(getTodoRecurrenceError(rule)).toBeNull();
        expect(next(rule, 'America/New_York', '2026-03-06T00:00:00Z')).toEqual([
            '2026-03-09T06:30:00.000Z',
            '2026-03-10T06:30:00.000Z',
            '2026-03-11T06:30:00.000Z'
        ]);
        expect(matchesTodoRecurrence(rule, new Date('2026-03-07T07:30:00Z'), 'America/New_York')).toBe(false);
        expect(matchesTodoRecurrence(rule, new Date('2026-03-09T06:30:42Z'), 'America/New_York')).toBe(true);
    });

    test('two-week intervals allow several weekdays in the anchored Monday-based calendar week', () => {
        const rule: TodoRecurrence = {
            mode: 'interval',
            intervalValue: 2,
            intervalUnit: 'week',
            anchorAt: '2026-12-31T12:00:00Z',
            time: '09:15',
            weekdays: [5, 1, 5]
        };
        expect(getTodoRecurrenceError(rule)).toBeNull();
        expect(next(rule, 'UTC', '2026-12-01T00:00:00Z', 5)).toEqual([
            '2027-01-01T09:15:00.000Z',
            '2027-01-11T09:15:00.000Z',
            '2027-01-15T09:15:00.000Z',
            '2027-01-25T09:15:00.000Z',
            '2027-01-29T09:15:00.000Z'
        ]);
        expect(matchesTodoRecurrence(rule, new Date('2027-01-08T09:15:00Z'), 'UTC')).toBe(false);
        expect(matchesTodoRecurrence(rule, new Date('2027-01-11T09:15:59Z'), 'UTC')).toBe(true);
    });

    test('two-month intervals use selected dates without rolling nonexistent dates into the next month', () => {
        const rule: TodoRecurrence = {
            mode: 'interval',
            intervalValue: 2,
            intervalUnit: 'month',
            anchorAt: '2026-02-05T12:00:00Z',
            time: '09:00',
            days: [31, 15, 31]
        };
        expect(getTodoRecurrenceError(rule)).toBeNull();
        expect(next(rule, 'UTC', '2026-02-01T00:00:00Z', 5)).toEqual([
            '2026-02-15T09:00:00.000Z',
            '2026-04-15T09:00:00.000Z',
            '2026-06-15T09:00:00.000Z',
            '2026-08-15T09:00:00.000Z',
            '2026-08-31T09:00:00.000Z'
        ]);
        expect(matchesTodoRecurrence(rule, new Date('2026-03-15T09:00:00Z'), 'UTC')).toBe(false);
        expect(matchesTodoRecurrence(rule, new Date('2026-08-31T09:00:00Z'), 'UTC')).toBe(true);
        expect(matchesTodoRecurrence(rule, new Date('2026-08-30T09:00:00Z'), 'UTC')).toBe(false);
    });

    test('weekly interval phase follows local calendar weeks across a DST transition', () => {
        const rule: TodoRecurrence = {
            mode: 'interval',
            intervalValue: 2,
            intervalUnit: 'week',
            anchorAt: '2026-03-02T15:00:00Z',
            time: '09:00',
            weekdays: [1, 5]
        };
        expect(next(rule, 'America/New_York', '2026-03-02T15:00:00Z', 4)).toEqual([
            '2026-03-06T14:00:00.000Z',
            '2026-03-16T13:00:00.000Z',
            '2026-03-20T13:00:00.000Z',
            '2026-03-30T13:00:00.000Z'
        ]);
        expect(matchesTodoRecurrence(rule, new Date('2026-03-16T13:00:00Z'), 'America/New_York')).toBe(true);
        expect(matchesTodoRecurrence(rule, new Date('2026-03-09T13:00:00Z'), 'America/New_York')).toBe(false);
    });

    test('an impossible month phase stays empty without converting every date or minute', () => {
        const rule: TodoRecurrence = {
            mode: 'interval',
            intervalValue: 12,
            intervalUnit: 'month',
            anchorAt: '2026-02-01T00:00:00Z',
            time: '09:00',
            days: [31]
        };
        const format = jest.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
        try {
            expect(getTodoRecurrenceError(rule)).toBeNull();
            expect(next(rule, 'UTC', '2026-01-01T00:00:00Z')).toEqual([]);
            expect(format.mock.calls.length).toBeLessThan(10);
        } finally {
            format.mockRestore();
        }
    });

    test('year intervals support multiple months and dates, including leap years and century exceptions', () => {
        const rule: TodoRecurrence = {
            mode: 'interval',
            intervalValue: 4,
            intervalUnit: 'year',
            anchorAt: '2096-02-29T10:00:00Z',
            time: '09:00',
            months: [6, 2, 2],
            days: [31, 29, 29]
        };
        expect(getTodoRecurrenceError(rule)).toBeNull();
        expect(next(rule, 'UTC', '2096-02-01T00:00:00Z', 5)).toEqual([
            '2096-06-29T09:00:00.000Z',
            '2100-06-29T09:00:00.000Z',
            '2104-02-29T09:00:00.000Z',
            '2104-06-29T09:00:00.000Z',
            '2108-02-29T09:00:00.000Z'
        ]);
        expect(matchesTodoRecurrence(rule, new Date('2104-02-29T09:00:00Z'), 'UTC')).toBe(true);
        expect(matchesTodoRecurrence(rule, new Date('2105-06-29T09:00:00Z'), 'UTC')).toBe(false);
    });

    test.each([
        ['America/New_York', '2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z', '01:30'],
        ['Australia/Lord_Howe', '2026-04-04T14:45:00Z', '2026-04-04T15:15:00Z', '01:45']
    ])('calendar intervals run only at the earliest repeated wall time in %s', (zone, first, repeated, time) => {
        const rule: TodoRecurrence = {
            mode: 'interval',
            intervalValue: 1,
            intervalUnit: 'day',
            anchorAt: '2026-01-01T00:00:00Z',
            time
        };
        expect(matchesTodoRecurrence(rule, new Date(first), zone)).toBe(true);
        expect(matchesTodoRecurrence(rule, new Date(repeated), zone)).toBe(false);
        expect(next(rule, zone, first, 1)).not.toContain(new Date(repeated).toISOString());
    });

    test.each([
        ['America/New_York', '2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z', '2026-11-02T06:30:00Z', '01:30'],
        ['Australia/Lord_Howe', '2026-04-04T14:45:00Z', '2026-04-04T15:15:00Z', '2026-04-05T15:15:00Z', '01:45']
    ])(
        'calendar intervals retain an anchor in the second repeated wall time in %s',
        (zone, first, anchorAt, following, time) => {
            const rule: TodoRecurrence = {
                mode: 'interval',
                intervalValue: 1,
                intervalUnit: 'day',
                anchorAt,
                time
            };
            const between = new Date(Date.parse(first) + 15 * 60_000).toISOString();
            expect(next(rule, zone, between, 2)).toEqual([
                new Date(anchorAt).toISOString(),
                new Date(following).toISOString()
            ]);
            expect(matchesTodoRecurrence(rule, new Date(first), zone)).toBe(false);
            expect(matchesTodoRecurrence(rule, new Date(anchorAt), zone)).toBe(true);
            expect(matchesTodoRecurrence(rule, new Date(following), zone)).toBe(true);
            expect(next(rule, zone, anchorAt, 1)).toEqual([new Date(following).toISOString()]);
        }
    );

    test('an anchored repeated wall time does not change which occurrence later calendar intervals use', () => {
        const rule: TodoRecurrence = {
            mode: 'interval',
            intervalValue: 1,
            intervalUnit: 'day',
            anchorAt: '2026-11-01T06:30:00Z',
            time: '01:30'
        };
        expect(next(rule, 'America/New_York', '2027-11-07T05:00:00Z', 1)).toEqual(['2027-11-07T05:30:00.000Z']);
        expect(matchesTodoRecurrence(rule, new Date('2027-11-07T05:30:00Z'), 'America/New_York')).toBe(true);
        expect(matchesTodoRecurrence(rule, new Date('2027-11-07T06:30:00Z'), 'America/New_York')).toBe(false);
    });

    test('calendar interval candidate generation is bounded by periods and agrees with matching', () => {
        const rule: TodoRecurrence = {
            mode: 'interval',
            intervalValue: 4,
            intervalUnit: 'year',
            anchorAt: '2096-02-29T10:00:00Z',
            time: '09:00',
            months: [2],
            days: [29]
        };
        const format = jest.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
        try {
            const runs = next(rule, 'UTC', '2096-02-29T10:00:00Z', 2);
            expect(runs).toEqual(['2104-02-29T09:00:00.000Z', '2108-02-29T09:00:00.000Z']);
            for (const run of runs) expect(matchesTodoRecurrence(rule, new Date(run), 'UTC')).toBe(true);
            expect(format.mock.calls.length).toBeLessThan(100);
        } finally {
            format.mockRestore();
        }
    });

    test.each([
        ['month', '2026-11-20T09:00:00Z', '2026-11-21T09:00:00Z'],
        ['year', '2027-10-20T09:00:00Z', '2027-10-21T09:00:00Z'],
        ['year', '2027-10-20T09:00:00Z', '2027-11-20T09:00:00Z']
    ])('legacy structured %s intervals retain the anchored calendar date', (unit, matching, other) => {
        const rule: TodoRecurrence = {
            mode: 'interval',
            intervalValue: 1,
            intervalUnit: unit as TodoRecurrence['intervalUnit'],
            anchorAt: '2026-10-20T09:00:00Z',
            weekdays: [0, 1, 2, 3, 4, 5, 6]
        };
        expect(matchesTodoRecurrence(rule, new Date(matching), 'UTC')).toBe(true);
        expect(matchesTodoRecurrence(rule, new Date(other), 'UTC')).toBe(false);
        expect(next(rule, 'UTC', '2026-10-20T09:01:00Z', 1)).toEqual([new Date(matching).toISOString()]);
    });

    test('legacy structured month intervals skip missing anchor dates and retain weekday restrictions', () => {
        const rule: TodoRecurrence = {
            mode: 'interval',
            intervalValue: 1,
            intervalUnit: 'month',
            anchorAt: '2026-01-31T09:00:00Z',
            weekdays: [1, 2, 3, 4, 5, 6]
        };
        expect(next(rule, 'UTC', '2026-01-31T10:00:00Z')).toEqual([
            '2026-03-31T09:00:00.000Z',
            '2026-07-31T09:00:00.000Z',
            '2026-08-31T09:00:00.000Z'
        ]);
        expect(matchesTodoRecurrence(rule, new Date('2026-03-31T09:00:00Z'), 'UTC')).toBe(true);
        expect(matchesTodoRecurrence(rule, new Date('2026-05-31T09:00:00Z'), 'UTC')).toBe(false);
    });

    test('a legacy anchor in the repeated local hour cannot preview a time before its anchor', () => {
        const rule: TodoRecurrence = {
            mode: 'interval',
            intervalValue: 1,
            intervalUnit: 'day',
            anchorAt: '2026-11-01T06:30:00Z'
        };
        expect(next(rule, 'America/New_York', '2026-11-01T04:00:00Z', 1)).toEqual(['2026-11-02T06:30:00.000Z']);
        expect(matchesTodoRecurrence(rule, new Date('2026-11-01T05:30:00Z'), 'America/New_York')).toBe(false);
    });

    test.each([
        { intervalUnit: 'hour', time: '09:00' },
        { intervalUnit: 'day', time: '24:00' },
        { intervalUnit: 'day', time: '09:00', weekdays: [1] },
        { intervalUnit: 'day', time: '09:00', days: [1] },
        { intervalUnit: 'week', time: '09:00' },
        { intervalUnit: 'week', time: '09:00', weekdays: [] },
        { intervalUnit: 'week', time: '09:00', weekdays: [7] },
        { intervalUnit: 'week', time: '09:00', weekdays: [1], days: [1] },
        { intervalUnit: 'month', time: '09:00' },
        { intervalUnit: 'month', time: '09:00', days: [] },
        { intervalUnit: 'month', time: '09:00', days: [1], months: [1] },
        { intervalUnit: 'year', time: '09:00', days: [1] },
        { intervalUnit: 'year', time: '09:00', months: [1], days: [] },
        { intervalUnit: 'year', time: '09:00', months: [2], days: [30] },
        { intervalUnit: 'year', time: '09:00', months: [13], days: [1] },
        { intervalUnit: 'year', time: '09:00', months: [1], days: [32] },
        { intervalUnit: 'month', days: [1] },
        { intervalUnit: 'year', months: [1], days: [1] }
    ])('rejects invalid calendar interval fields: %j', (fields) => {
        const rule = { mode: 'interval', intervalValue: 1, anchorAt: '2026-01-01T00:00:00Z', ...fields };
        expect(getTodoRecurrenceError(rule)).not.toBeNull();
        expect(matchesTodoRecurrence(rule as TodoRecurrence, new Date('2026-01-01T09:00:00Z'), 'UTC')).toBe(false);
        expect(next(rule as TodoRecurrence, 'UTC', '2026-01-01T00:00:00Z')).toEqual([]);
    });

    test('interval weekday restrictions use the selected timezone', () => {
        const rule: TodoRecurrence = {
            mode: 'interval',
            intervalHours: 24,
            weekdays: [1],
            anchorAt: '2026-10-25T16:30:00Z'
        };
        expect(next(rule, 'Asia/Shanghai', '2026-10-25T00:00:00Z', 1)).toEqual(['2026-10-25T16:30:00.000Z']);
        expect(matchesTodoRecurrence(rule, new Date('2026-10-25T16:30:00Z'), 'UTC')).toBe(false);
    });

    test('an unreachable interval weekday returns an empty bounded preview', () => {
        const rule: TodoRecurrence = {
            mode: 'interval',
            intervalHours: 168,
            weekdays: [1],
            anchorAt: '2026-10-25T00:00:00Z'
        };
        expect(next(rule, 'UTC', '2026-10-24T00:00:00Z')).toEqual([]);
    });

    test.each(['UTC', 'Asia/Shanghai', 'America/New_York'])(
        'unreachable weekly intervals stay within a bounded candidate budget in %s',
        (zone) => {
            const format = jest.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
            try {
                const rule: TodoRecurrence = {
                    mode: 'interval',
                    intervalHours: 168,
                    weekdays: [2],
                    anchorAt: '2026-10-19T12:00:00Z'
                };
                expect(next(rule, zone, '2026-10-22T00:00:00Z')).toEqual([]);
                // Guard UI previews against unbounded retries or minute scans,
                // without a machine-dependent wall-clock performance assertion.
                expect(format.mock.calls.length).toBeLessThan(22_000);
            } finally {
                format.mockRestore();
            }
        }
    );

    test('invalid timezones and invalid preview counts are harmless', () => {
        const rule: TodoRecurrence = { mode: 'daily', time: '09:00' };
        expect(next(rule, 'Invalid/Zone', '2026-01-01T00:00:00Z')).toEqual([]);
        expect(next(rule, 'UTC', '2026-01-01T00:00:00Z', 0)).toEqual([]);
        expect(matchesTodoRecurrence(rule, new Date('bad'), 'UTC')).toBe(false);
    });
});
