import { zhCn as calendarZhCn } from '../../../main/applications/calendar/locale/zh-cn.js';
import { enUs as calendarEnUs } from '../../../main/applications/calendar/locale/en-us.js';
import { t as calendarT } from '../../../main/applications/calendar/locale/index.js';
import { createTranslatorForCalendar } from '../../../main/applications/calendar/locale/renderer.js';
import { setRuntimeLocale } from '../../../locale/index.js';

function keyDiff(a: Record<string, string>, b: Record<string, string>): string[] {
    const missingInB = Object.keys(a).filter((k) => !(k in b));
    const missingInA = Object.keys(b).filter((k) => !(k in a));
    return [...missingInB, ...missingInA];
}

describe('calendar locale', () => {
    afterEach(() => {
        setRuntimeLocale(null);
    });

    test('per-app zh-CN and en-US dictionaries have identical key sets', () => {
        expect(keyDiff(calendarZhCn, calendarEnUs)).toEqual([]);
    });

    test('renderer dictionaries are provided by the per-app locale files', () => {
        const rendererKeys = Object.keys(calendarZhCn).filter((k) => k.startsWith('renderer.calendar.'));
        expect(rendererKeys.length).toBeGreaterThan(0);
    });

    test('main-process t() follows the active locale (zh-CN / en-US)', () => {
        setRuntimeLocale('zh-CN');
        expect(calendarT('app.name')).toBe('日历');

        setRuntimeLocale('en-US');
        expect(calendarT('app.name')).toBe('Calendar');
    });

    test('main-process t() interpolates params', () => {
        setRuntimeLocale('en-US');
        expect(calendarT('status.todayCount', { count: 3 })).toBe('3 today');
        expect(calendarT('date.format.full', { year: 2026, month: 9, day: 9, monthName: 'Sep' })).toBe('Sep 9, 2026');

        setRuntimeLocale('zh-CN');
        expect(calendarT('status.todayCount', { count: 3 })).toBe('今日 3 项');
        expect(calendarT('date.format.full', { year: 2026, month: 9, day: 9, monthName: '9月' })).toBe('2026年9月9日');
    });

    test('main-process t() returns the key itself for unknown keys', () => {
        expect(calendarT('calendar.does.not.exist')).toBe('calendar.does.not.exist');
    });

    test('renderer translator resolves locale from setting and interpolates params', () => {
        expect(createTranslatorForCalendar({ locale: 'zh-CN' })('renderer.calendar.today')).toBe('今天');
        expect(createTranslatorForCalendar({ locale: 'en-US' })('renderer.calendar.today')).toBe('Today');
        expect(createTranslatorForCalendar({ locale: 'en-US' })('renderer.calendar.more', { count: 2 })).toBe(
            '+2 more…'
        );
    });
});
