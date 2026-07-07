import { formatLocalDateTime } from '../../../renderer/components/goal-time-format.js';

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

        expect(formatLocalDateTime('2026-01-01T00:05:06.000Z')).toBe('2026-01-01 08:05:06');
    });

    test('keeps invalid timestamp values unchanged', () => {
        expect(formatLocalDateTime('not-a-date')).toBe('not-a-date');
    });
});
