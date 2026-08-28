import { formatOutputElapsed } from '../../../common/output-duration.js';

const translations: Record<string, string> = {
    'output.duration.elapsed.seconds': 'Elapsed ${seconds}s',
    'output.duration.elapsed.minutes': 'Elapsed ${minutes}m',
    'output.duration.elapsed.minutesSeconds': 'Elapsed ${minutes}m ${seconds}s',
    'output.duration.elapsed.hours': 'Elapsed ${hours}h',
    'output.duration.elapsed.hoursSeconds': 'Elapsed ${hours}h ${seconds}s',
    'output.duration.elapsed.hoursMinutes': 'Elapsed ${hours}h ${minutes}m',
    'output.duration.elapsed.hoursMinutesSeconds': 'Elapsed ${hours}h ${minutes}m ${seconds}s'
};

const translate = (key: string, params?: Record<string, string | number>) => {
    let value = translations[key] ?? key;
    for (const [name, replacement] of Object.entries(params ?? {})) {
        value = value.replaceAll(`\${${name}}`, String(replacement));
    }
    return value;
};

describe('formatOutputElapsed', () => {
    test.each([
        [0, 'Elapsed 0s'],
        [2.4, 'Elapsed 2s'],
        [65, 'Elapsed 1m 5s'],
        [3600, 'Elapsed 1h'],
        [3601, 'Elapsed 1h 1s'],
        [3661, 'Elapsed 1h 1m 1s']
    ] as const)('formats %s seconds as a localized human duration', (seconds, expected) => {
        expect(formatOutputElapsed(seconds, translate)).toBe(expected);
    });

    test.each([undefined, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid duration %s', (seconds) => {
        expect(formatOutputElapsed(seconds, translate)).toBe('');
    });
});
