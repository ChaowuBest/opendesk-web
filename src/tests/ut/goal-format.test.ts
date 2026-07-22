import {
    formatClockDuration,
    formatCompactDuration,
    formatLocalDateTime,
    formatTokens,
    getGoalElapsedMs,
    getGoalEvaluationStatusLabelKey,
    getGoalStatusMeta
} from '../../common/goal/format.js';

describe('goal formatting helpers', () => {
    const originalTimezone = process.env.TZ;

    afterEach(() => {
        if (originalTimezone === undefined) {
            delete process.env.TZ;
        } else {
            process.env.TZ = originalTimezone;
        }
    });

    test('formats ISO timestamps in the local timezone', () => {
        process.env.TZ = 'Asia/Shanghai';

        // Compute expected value dynamically from Date local time methods, instead of
        // hardcoding UTC+8 offset. This makes the test work on CI environments where
        // Asia/Shanghai timezone data may not be installed (fallback to UTC).
        const date = new Date('2026-01-01T00:05:06.000Z');
        const expected = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;

        expect(formatLocalDateTime('2026-01-01T00:05:06.000Z')).toBe(expected);
    });

    test('keeps invalid timestamp values unchanged', () => {
        expect(formatLocalDateTime('not-a-date')).toBe('not-a-date');
    });

    test('formats clock durations for TUI goal panels', () => {
        expect(formatClockDuration(0)).toBe('00:00');
        expect(formatClockDuration(65_000)).toBe('01:05');
        expect(formatClockDuration(3_665_000)).toBe('01:01:05');
    });

    test('formats compact durations for GUI task artifacts', () => {
        expect(formatCompactDuration(-1)).toBe('');
        expect(formatCompactDuration(850)).toBe('850ms');
        expect(formatCompactDuration(12_000)).toBe('12s');
        expect(formatCompactDuration(65_000)).toBe('1m05s');
        expect(formatCompactDuration(3_900_000)).toBe('1h05m');
    });

    test('formats token counts', () => {
        expect(formatTokens(0)).toBe('0');
        expect(formatTokens(999)).toBe('999');
        expect(formatTokens(1_200)).toBe('1.2K');
        expect(formatTokens(1_500_000)).toBe('1.5M');
    });

    test('starts goal elapsed time at first execution instead of creation', () => {
        const createdAt = '2026-01-01T00:00:00.000Z';
        const startedAt = '2026-01-01T00:00:05.000Z';
        const newlyCreatedGoal = { status: 'active', createdAt, executionStarted: false } as const;
        const awaitingGoal = { status: 'active', createdAt, awaitingContextEntry: true } as const;
        const activeGoal = { status: 'active', createdAt, startedAt } as const;
        const awaitingEditedGoal = {
            status: 'active',
            createdAt,
            startedAt,
            executionStarted: true,
            awaitingContextEntry: true
        } as const;
        const pausedGoal = { status: 'paused', createdAt, startedAt } as const;
        const blockedGoal = { status: 'blocked', createdAt, startedAt } as const;

        expect(getGoalElapsedMs(newlyCreatedGoal, { now: Date.parse('2026-01-01T00:00:10.000Z') })).toBe(0);
        expect(getGoalElapsedMs(awaitingGoal, { now: Date.parse('2026-01-01T00:00:10.000Z') })).toBe(0);
        expect(getGoalElapsedMs(activeGoal, { now: Date.parse('2026-01-01T00:00:10.000Z') })).toBe(5_000);
        expect(getGoalElapsedMs(awaitingEditedGoal, { now: Date.parse('2026-01-01T00:00:11.000Z') })).toBe(6_000);
        expect(getGoalElapsedMs(pausedGoal, { now: Date.parse('2026-01-01T00:00:12.000Z') })).toBe(7_000);
        expect(getGoalElapsedMs(blockedGoal, { now: Date.parse('2026-01-01T00:00:14.000Z') })).toBe(9_000);
    });

    test('freezes terminal goals and falls back for legacy elapsed data', () => {
        const createdAt = '2026-01-01T00:00:00.000Z';
        const startedAt = '2026-01-01T00:00:05.000Z';

        expect(
            getGoalElapsedMs({
                status: 'complete',
                createdAt,
                startedAt,
                completedAt: '2026-01-01T00:00:12.000Z'
            })
        ).toBe(7_000);
        expect(
            getGoalElapsedMs({
                status: 'cleared',
                createdAt,
                startedAt,
                clearedAt: '2026-01-01T00:00:14.000Z'
            })
        ).toBe(9_000);
        expect(getGoalElapsedMs({ status: 'active', createdAt }, { now: Date.parse('2026-01-01T00:00:03.000Z') })).toBe(
            3_000
        );
        expect(getGoalElapsedMs({ status: 'active', createdAt: 'bad-date' })).toBe(0);
        expect(
            getGoalElapsedMs({
                status: 'complete',
                createdAt,
                startedAt,
                completedAt: '2025-12-31T23:59:59.000Z'
            })
        ).toBe(0);
    });

    test('returns stable goal status metadata', () => {
        expect(getGoalStatusMeta('active')).toEqual({
            labelKey: 'goal.label.status.active',
            fallbackLabel: 'active',
            icon: '◉',
            color: '#00E676'
        });
        expect(getGoalStatusMeta('cleared').labelKey).toBe('goal.label.status.cleared');
        expect(getGoalEvaluationStatusLabelKey('met')).toBe('goal.label.evaluation.met');
    });
});
