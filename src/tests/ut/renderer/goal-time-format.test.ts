import { formatLocalDateTime, getGoalEvaluationDisplayTimestamp } from '../../../common/goal/format.js';

describe('goal time formatting', () => {
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

    test('uses startedAt as the display timestamp for evaluation start cards', () => {
        expect(
            getGoalEvaluationDisplayTimestamp({
                phase: 'start',
                startedAt: '2026-07-09T10:00:00.000Z',
                updatedAt: '2026-07-09T10:01:00.000Z',
                evaluatedAt: '2026-07-09T10:02:00.000Z'
            })
        ).toBe('2026-07-09T10:00:00.000Z');
    });

    test('uses evaluatedAt as the display timestamp for evaluation result cards', () => {
        expect(
            getGoalEvaluationDisplayTimestamp({
                phase: 'end',
                startedAt: '2026-07-09T10:00:00.000Z',
                updatedAt: '2026-07-09T10:01:00.000Z',
                evaluatedAt: '2026-07-09T10:02:00.000Z'
            })
        ).toBe('2026-07-09T10:02:00.000Z');
    });
});
