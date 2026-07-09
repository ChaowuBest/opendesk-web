import {
    formatClockDuration,
    formatCompactDuration,
    formatLocalDateTime,
    formatTokens,
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

        expect(formatLocalDateTime('2026-01-01T00:05:06.000Z')).toBe('2026-01-01 08:05:06');
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
