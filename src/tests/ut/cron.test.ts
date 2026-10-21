import { describe, expect, test } from '@jest/globals';
import { describeCron, type CronDescribeLabels } from '../../main/utils/cron.js';

describe('cron weekday descriptions', () => {
    test.each(['1-5/2', 'MON-FRI', '1,3-5', 'MON,WED,FRI', '1#2', '*/2'])(
        'preserves complex weekday expression %s without partial parsing',
        (dow) => {
            expect(describeCron(`0 9 * * ${dow}`, undefined, 'Asia/Shanghai')).toBe(`${dow} 9:00 (Asia/Shanghai)`);
        }
    );

    test.each([
        ['1', '每周一'],
        ['1-5', '周一-周五'],
        ['1,3,5', '周一/周三/周五'],
        ['7', '每周日'],
        ['5-7', '周五-周日'],
        ['1,7', '周一/周日']
    ])('translates numeric weekday expression %s', (dow, expected) => {
        expect(describeCron(`0 9 * * ${dow}`, undefined, 'UTC')).toBe(`${expected} 9:00 (UTC)`);
    });

    test('uses injected weekday names and preserves complex fields for every locale', () => {
        const labels: CronDescribeLabels = {
            dowNames: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
            everyDowTemplate: 'Every ${day}',
            dowTemplate: '${day}',
            monthlyDomTemplate: 'Day ${day}',
            monthTemplate: 'Month ${month}',
            hourTemplate: 'Hour ${hour}',
            minuteTemplate: 'Minute ${minute}',
            everyMinute: 'Every minute'
        };

        expect(describeCron('0 9 * * 7', labels, 'UTC')).toBe('Every Sun 9:00 (UTC)');
        expect(describeCron('0 9 * * MON-FRI', labels, 'UTC')).toBe('MON-FRI 9:00 (UTC)');
    });
});
