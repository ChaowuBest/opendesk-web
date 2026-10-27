import {
    getRecurrenceValidationIssue,
    getRecurrenceValidationMessage
} from '../../../main/applications/todomgr/recurrence-validation.js';
import { createTranslatorForTodoMgr } from '../../../main/applications/todomgr/locale/renderer.js';

const zh = createTranslatorForTodoMgr('zh-CN');
const en = createTranslatorForTodoMgr('en-US');
const anchorAt = '2026-10-23T01:00:00Z';

describe('actionable recurrence validation messages', () => {
    test.each([
        [null, 'frequency'],
        [{ mode: 'weekly', weekdays: [], time: '09:00' }, 'weekdays'],
        [{ mode: 'yearly', months: [], days: [], time: '' }, 'months'],
        [{ mode: 'monthly', days: [], time: '09:00' }, 'days'],
        [{ mode: 'daily', time: '' }, 'time'],
        [{ mode: 'interval', intervalValue: 0, intervalUnit: 'day', anchorAt }, 'intervalValue'],
        [{ mode: 'biweekly', weekdays: [1], time: '09:00', anchorDate: 'invalid' }, 'anchorDate'],
        [{ mode: 'interval', intervalValue: 1, intervalUnit: 'day', anchorAt: 'invalid' }, 'anchorAt'],
        [{ mode: 'yearly', months: [2], days: [30], time: '09:00' }, 'days']
    ])('associates an actionable message with its input field: %j', (rule, field) => {
        expect(getRecurrenceValidationIssue(rule, zh)).toEqual({
            field,
            message: getRecurrenceValidationMessage(rule, zh)
        });
    });

    test('does not associate a validation issue with a valid schedule', () => {
        expect(getRecurrenceValidationIssue({ mode: 'daily', time: '09:00' }, zh)).toBeNull();
    });

    test.each([
        [{ mode: 'weekly', time: '09:00', weekdays: [] }, '请选择执行星期。'],
        [{ mode: 'biweekly', time: '09:00', weekdays: [], anchorDate: '2026-10-23' }, '请选择执行星期。'],
        [{ mode: 'monthly', time: '09:00', days: [] }, '请选择日期。'],
        [{ mode: 'monthly', time: '09:00', days: [32] }, '请选择日期。'],
        [{ mode: 'yearly', time: '09:00', months: [], days: [5] }, '请选择月份。'],
        [{ mode: 'yearly', time: '09:00', months: [13], days: [5] }, '请选择月份。'],
        [{ mode: 'yearly', time: '09:00', months: [1], days: [] }, '请选择日期。'],
        [{ mode: 'daily', time: '' }, '请选择有效的执行时间。'],
        [{ mode: 'daily', time: '24:00' }, '请选择有效的执行时间。']
    ])('identifies only the field that needs correction: %j', (rule, message) => {
        expect(getRecurrenceValidationMessage(rule, zh)).toBe(message);
    });

    test('reports missing yearly months before dates or time', () => {
        const rule = { mode: 'yearly', months: [], days: [], time: '' };
        expect(getRecurrenceValidationMessage(rule, zh)).toBe('请选择月份。');
        expect(getRecurrenceValidationMessage({ ...rule, months: [1] }, zh)).toBe('请选择日期。');
        expect(getRecurrenceValidationMessage({ ...rule, months: [1], days: [5] }, zh)).toBe('请选择有效的执行时间。');
    });

    test.each([
        [{ intervalUnit: 'week', weekdays: [] }, '请选择执行星期。'],
        [{ intervalUnit: 'month', days: [] }, '请选择日期。'],
        [{ intervalUnit: 'year', months: [], days: [] }, '请选择月份。'],
        [{ intervalUnit: 'year', months: [2], days: [] }, '请选择日期。'],
        [{ intervalUnit: 'day' }, '请选择有效的执行时间。']
    ])('identifies missing calendar interval details: %j', (details, message) => {
        expect(
            getRecurrenceValidationMessage({ mode: 'interval', intervalValue: 1, anchorAt, time: '', ...details }, zh)
        ).toBe(message);
    });

    test.each([undefined, 0, -1, 1.5, 10001, NaN, Infinity, '2'])(
        'explains the permitted structured interval value: %s',
        (intervalValue) => {
            expect(
                getRecurrenceValidationMessage({ mode: 'interval', intervalValue, intervalUnit: 'day', anchorAt }, zh)
            ).toBe('间隔值请输入 1–10000 之间的整数。');
        }
    );

    test.each([0, 8761, 1.5])('keeps the legacy hourly interval limit: %s', (intervalHours) => {
        expect(getRecurrenceValidationMessage({ mode: 'interval', intervalHours, weekdays: [1], anchorAt }, zh)).toBe(
            '间隔值请输入 1–8760 之间的整数。'
        );
    });

    test('asks for the interval unit without listing unrelated fields', () => {
        expect(getRecurrenceValidationMessage({ mode: 'interval', intervalValue: 1, anchorAt }, zh)).toBe(
            '请选择间隔单位。'
        );
        expect(
            getRecurrenceValidationMessage({ mode: 'interval', intervalValue: 1, intervalUnit: 'minute', anchorAt }, en)
        ).toBe('Choose an interval unit.');
    });

    test.each([
        [{ mode: 'biweekly', weekdays: [1], time: '09:00', anchorDate: '2026-02-30' }, '请选择有效的起始日期。'],
        [{ mode: 'yearly', time: '09:00', months: [2], days: [30, 31] }, '所选月份没有该日期，请重新选择日期。']
    ])('explains invalid anchors and impossible dates: %j', (rule, message) => {
        expect(getRecurrenceValidationMessage(rule, zh)).toBe(message);
    });

    test.each([
        { mode: 'daily', time: '09:00' },
        { mode: 'yearly', month: 2, day: 29, time: '09:00' },
        { mode: 'yearly', months: [2, 3], days: [31], time: '09:00' },
        { mode: 'interval', intervalHours: 1, weekdays: [1], anchorAt },
        { mode: 'interval', intervalValue: 1, intervalUnit: 'day', anchorAt },
        { mode: 'interval', intervalValue: 10000, intervalUnit: 'year', anchorAt }
    ])('does not add requirements to valid schedules or legacy intervals: %j', (rule) => {
        expect(getRecurrenceValidationMessage(rule, zh)).toBeNull();
    });

    test('explicit empty arrays take priority over legacy scalar selections', () => {
        expect(
            getRecurrenceValidationMessage({ mode: 'yearly', month: 1, months: [], day: 1, time: '09:00' }, zh)
        ).toBe('请选择月份。');
        expect(getRecurrenceValidationMessage({ mode: 'monthly', day: 1, days: [], time: '09:00' }, zh)).toBe(
            '请选择日期。'
        );
    });

    test('uses the localized brief fallback for unsupported or irrelevant fields', () => {
        for (const rule of [null, [], { mode: 'unknown' }, { mode: 'daily', time: '09:00', days: [1] }]) {
            expect(getRecurrenceValidationMessage(rule, zh)).toBe('执行频率无效，请检查设置。');
            expect(getRecurrenceValidationMessage(rule, en)).toBe('Invalid frequency. Check the settings.');
        }
    });

    test('translates the specific missing field', () => {
        expect(getRecurrenceValidationMessage({ mode: 'weekly', weekdays: [], time: '09:00' }, en)).toBe(
            'Choose execution weekdays.'
        );
        expect(getRecurrenceValidationMessage({ mode: 'yearly', months: [], days: [], time: '' }, en)).toBe(
            'Choose months.'
        );
    });
});
