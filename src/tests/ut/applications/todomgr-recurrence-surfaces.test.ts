import { jest } from '@jest/globals';
import { describeLegacyRecurrence, describeTodoRecurrence } from '../../../common/utils/recurrence-description.js';
import { createTranslatorForTodoMgr } from '../../../main/applications/todomgr/locale/renderer.js';
import { AddGlobalTodoTool, UpdateGlobalTodoTool } from '../../../main/applications/todomgr/tools.js';
import { buildTriggerInfo } from '../../../main/applications/todomgr/trigger.js';
import { setRuntimeLocale, t as coreT } from '../../../locale/index.js';
import type { TodoRecurrence } from '../../../common/utils/todo-recurrence.js';

describe('automation frequency descriptions and tool input', () => {
    afterEach(() => setRuntimeLocale(null));

    test.each([AddGlobalTodoTool, UpdateGlobalTodoTool])(
        'tools identify the missing weekday instead of listing schedule rules: %p',
        async (Tool) => {
            setRuntimeLocale('zh-CN');
            const callWorker = jest.fn(async () => ({ id: 'id-1' }));
            const tool = new Tool({ callWorker } as any);
            await expect(
                (tool as any).handleExecute({
                    id: 'id-1',
                    title: 'Run',
                    content: 'Run',
                    trigger: {
                        type: 'cron',
                        recurrence: { mode: 'weekly', time: '09:00', weekdays: [] },
                        timezone: 'UTC'
                    }
                })
            ).rejects.toThrow('请选择执行星期。');
            expect(callWorker).not.toHaveBeenCalled();
        }
    );

    test.each(['zh-CN', 'en-US'] as const)('describes the supported periods and intervals in %s', (locale) => {
        const t = createTranslatorForTodoMgr({ locale });
        const rules: TodoRecurrence[] = [
            { mode: 'daily', time: '09:30' },
            { mode: 'weekly', time: '09:30', weekdays: [1, 5] },
            { mode: 'biweekly', time: '09:30', weekdays: [1], anchorDate: '2026-10-19' },
            { mode: 'monthly', time: '09:30', day: 31 },
            { mode: 'yearly', time: '09:30', month: 2, day: 29 },
            { mode: 'interval', intervalHours: 5, weekdays: [1, 2, 3, 4, 5], anchorAt: '2026-10-19T01:00:00Z' }
        ];
        for (const rule of rules) {
            const description = describeTodoRecurrence(rule, t, 'Asia/Shanghai');
            expect(description).toContain('Asia/Shanghai');
            expect(description).not.toMatch(/\$\{|recurrence\.desc\.|\* \*/);
            if (rule.mode !== 'interval') expect(description).toContain('09:30');
        }
        expect(describeTodoRecurrence(rules[2], t, 'Asia/Shanghai')).toContain('2026-10-19');
        expect(describeTodoRecurrence(rules[5], t, 'Asia/Shanghai')).not.toMatch(/起始|starting|2026-10-19|09:00/);
    });

    test('legacy descriptions hide formulas and preserve recognizable simple rules', () => {
        const t = createTranslatorForTodoMgr('zh-CN');
        expect(describeLegacyRecurrence('0 9 * * 1-5', t, 'UTC')).toContain('09:00');
        expect(describeLegacyRecurrence('0 9 * * 1-5', t, 'UTC')).toContain('周五');
        expect(describeLegacyRecurrence('0 9 * * 1,3,5', t, 'UTC')).toContain('周三');
        expect(describeLegacyRecurrence('0 9 1,15 * 1-5', t, 'UTC')).toBe('已保存的高级规则 (UTC)');
        expect(describeLegacyRecurrence('invalid', t, 'UTC')).toBe('已保存的高级规则 (UTC)');
        expect(describeLegacyRecurrence('*/15 * * * *', t, 'UTC')).toContain('15');
    });

    test.each(['zh-CN', 'en-US'] as const)('describes all selected dates and months in %s', (locale) => {
        const t = createTranslatorForTodoMgr({ locale });
        const monthly = describeTodoRecurrence(
            { mode: 'monthly', time: '09:30', days: [31, 1, 15, 1], day: 5 } as TodoRecurrence,
            t,
            'UTC'
        );
        const yearly = describeTodoRecurrence(
            { mode: 'yearly', time: '09:30', months: [6, 3, 6], days: [15, 1], month: 2, day: 5 } as TodoRecurrence,
            t,
            'UTC'
        );
        expect(monthly).toContain(`1${t('recurrence.desc.separator')}15${t('recurrence.desc.separator')}31`);
        expect(yearly).toContain(`${t('date.month.3')}${t('recurrence.desc.separator')}${t('date.month.6')}`);
        expect(yearly).toContain(`1${t('recurrence.desc.separator')}15`);
        expect(yearly).not.toContain(t('date.month.2'));
        expect(monthly).not.toMatch(/\$\{|recurrence\.desc\.|Saved advanced|已保存的高级/);
        expect(yearly).not.toMatch(/\$\{|recurrence\.desc\.|Saved advanced|已保存的高级/);
        expect(describeLegacyRecurrence('30 9 1,15,31 3,6 *', t, 'UTC')).toContain(
            `${t('date.month.3')}${t('recurrence.desc.separator')}${t('date.month.6')}`
        );
    });

    test.each(['zh-CN', 'en-US'] as const)('describes explicit calendar intervals in %s', (locale) => {
        const t = createTranslatorForTodoMgr({ locale });
        const anchorAt = '2026-10-23T02:15:00Z';
        const cases: Array<[TodoRecurrence, string[]]> = [
            [
                { mode: 'interval', intervalValue: 2, intervalUnit: 'day', time: '09:30', anchorAt },
                [locale === 'zh-CN' ? '每隔 2 天 09:30' : 'Every 2 day(s) at 09:30']
            ],
            [
                { mode: 'interval', intervalValue: 3, intervalUnit: 'week', weekdays: [3, 1], time: '14:45', anchorAt },
                [locale === 'zh-CN' ? '每隔 3 周' : 'Every 3 week(s)', t('date.dow.1'), t('date.dow.3'), '14:45']
            ],
            [
                { mode: 'interval', intervalValue: 4, intervalUnit: 'month', days: [15, 1], time: '18:20', anchorAt },
                [
                    locale === 'zh-CN' ? '每隔 4 个月' : 'Every 4 month(s)',
                    `1${t('recurrence.desc.separator')}15`,
                    '18:20'
                ]
            ],
            [
                {
                    mode: 'interval',
                    intervalValue: 2,
                    intervalUnit: 'year',
                    months: [6, 3],
                    days: [15, 1],
                    time: '08:05',
                    anchorAt
                },
                [
                    locale === 'zh-CN' ? '每隔 2 年' : 'Every 2 year(s)',
                    `${t('date.month.3')}${t('recurrence.desc.separator')}${t('date.month.6')}`,
                    `1${t('recurrence.desc.separator')}15`,
                    '08:05'
                ]
            ]
        ];
        for (const [rule, expected] of cases) {
            const description = describeTodoRecurrence(rule, t, 'Asia/Shanghai');
            for (const text of expected) expect(description).toContain(text);
            expect(description).not.toMatch(/起始|starting|2026-10-23|10:15/);
            expect(description).toContain('(Asia/Shanghai)');
            expect(description).not.toMatch(/\$\{|recurrence\.desc\.|Saved advanced|已保存的高级/);
        }
    });

    test.each(['zh-CN', 'en-US'] as const)(
        'preserves older interval descriptions without explicit time in %s',
        (locale) => {
            const t = createTranslatorForTodoMgr({ locale });
            for (const intervalUnit of ['hour', 'day', 'week', 'month', 'year'] as const) {
                const description = describeTodoRecurrence(
                    { mode: 'interval', intervalValue: 2, intervalUnit, anchorAt: '2026-10-23T02:15:00Z' },
                    t,
                    'Asia/Shanghai'
                );
                expect(description).toBe(
                    `${t('recurrence.desc.interval', {
                        days: '',
                        value: 2,
                        unit: t(`renderer.todo.frequency.intervalUnit.${intervalUnit}`)
                    })} (Asia/Shanghai)`
                );
                expect(description).not.toMatch(/起始|starting|2026-10-23|10:15/);
            }
        }
    );

    test.each(['zh-CN', 'en-US'] as const)('describes older intervals with the core translator in %s', (locale) => {
        setRuntimeLocale(locale);
        for (const intervalUnit of ['hour', 'day', 'week', 'month', 'year'] as const) {
            const description = describeTodoRecurrence(
                { mode: 'interval', intervalValue: 2, intervalUnit, anchorAt: '2026-10-23T02:15:00Z' },
                coreT,
                'Asia/Shanghai'
            );
            expect(description).toContain(coreT(`recurrence.desc.intervalUnit.${intervalUnit}`));
            expect(description).not.toMatch(/起始|starting|2026-10-23|10:15/);
            expect(description).not.toMatch(/\$\{|recurrence\.desc\./);
        }
    });

    test.each([AddGlobalTodoTool, UpdateGlobalTodoTool])(
        'tools serialize explicit calendar interval time and selections: %p',
        async (Tool) => {
            const callWorker = jest.fn(async () => ({ id: 'id-1' }));
            const tool = new Tool({ callWorker } as any);
            const anchorAt = '2026-10-23T02:15:00Z';
            for (const recurrence of [
                { mode: 'interval', intervalValue: 2, intervalUnit: 'day', time: '09:30', anchorAt },
                { mode: 'interval', intervalValue: 3, intervalUnit: 'week', time: '14:45', weekdays: [1, 3], anchorAt },
                { mode: 'interval', intervalValue: 4, intervalUnit: 'month', time: '18:20', days: [1, 15], anchorAt },
                {
                    mode: 'interval',
                    intervalValue: 2,
                    intervalUnit: 'year',
                    time: '08:05',
                    months: [3, 6],
                    days: [1, 15],
                    anchorAt
                }
            ]) {
                await (tool as any).handleExecute({
                    id: 'id-1',
                    title: 'Run',
                    content: 'Run',
                    trigger: { type: 'cron', recurrence, timezone: 'Asia/Shanghai' }
                });
                const calls = callWorker.mock.calls;
                const trigger =
                    Tool === AddGlobalTodoTool
                        ? calls[calls.length - 1][5]
                        : (calls[calls.length - 1][2] as any).trigger;
                expect(trigger).toEqual({
                    type: 'cron',
                    recurrence,
                    timezone: 'Asia/Shanghai',
                    cronExpression: '* * * * *'
                });
            }
        }
    );

    test.each([AddGlobalTodoTool, UpdateGlobalTodoTool])(
        'tools retain multi-date and multi-month arrays without stripping them: %p',
        async (Tool) => {
            const callWorker = jest.fn(async () => ({ id: 'id-1' }));
            const tool = new Tool({ callWorker } as any);
            const schema = JSON.parse(JSON.stringify(tool.getJsonSchema()));
            expect(JSON.stringify(schema)).toContain('"days"');
            expect(JSON.stringify(schema)).toContain('"months"');
            for (const recurrence of [
                { mode: 'monthly', time: '09:00', days: [1, 15, 31] },
                { mode: 'yearly', time: '09:00', months: [2, 4], days: [29, 31] },
                { mode: 'yearly', time: '09:00', months: [3, 6], days: [1, 15], day: 5, month: 2 }
            ]) {
                await (tool as any).handleExecute({
                    id: 'id-1',
                    title: 'Run',
                    content: 'Run',
                    trigger: { type: 'cron', recurrence, timezone: 'UTC' }
                });
                const calls = callWorker.mock.calls;
                const trigger =
                    Tool === AddGlobalTodoTool
                        ? calls[calls.length - 1][5]
                        : (calls[calls.length - 1][2] as any).trigger;
                expect(trigger).toEqual({ type: 'cron', recurrence, timezone: 'UTC', cronExpression: '* * * * *' });
            }
        }
    );

    test.each([AddGlobalTodoTool, UpdateGlobalTodoTool])(
        'tools retain recurrence and fill the internal wakeup expression: %p',
        async (Tool) => {
            const callWorker = jest.fn(async () => ({ id: 'id-1' }));
            const tool = new Tool({ callWorker } as any);
            const jsonSchema = tool.getJsonSchema();
            expect(JSON.stringify(jsonSchema)).toContain('intervalHours');
            expect(JSON.stringify(jsonSchema)).toContain('intervalUnit');
            const recurrence = { mode: 'biweekly', time: '09:00', weekdays: [1, 3], anchorDate: '2026-10-19' };
            await (tool as any).handleExecute({
                id: 'id-1',
                title: 'Run',
                content: 'Run',
                trigger: { type: 'cron', recurrence, timezone: 'Asia/Shanghai' }
            });
            const trigger =
                Tool === AddGlobalTodoTool ? callWorker.mock.calls[0][5] : (callWorker.mock.calls[0][2] as any).trigger;
            expect(trigger).toEqual({
                type: 'cron',
                recurrence,
                timezone: 'Asia/Shanghai',
                cronExpression: '* * * * *'
            });
        }
    );

    test.each([AddGlobalTodoTool, UpdateGlobalTodoTool])(
        'tools reject malformed frequency settings before worker calls: %p',
        async (Tool) => {
            const callWorker = jest.fn(async () => ({ id: 'id-1' }));
            const tool = new Tool({ callWorker } as any);
            for (const recurrence of [
                { mode: 'interval', intervalHours: 0, weekdays: [1], anchorAt: '2026-10-19T01:00:00Z' },
                { mode: 'weekly', time: '09:00', weekdays: [] },
                { mode: 'biweekly', time: '09:00', weekdays: [1], anchorDate: '2026-02-30' },
                { mode: 'yearly', time: '09:00', month: 2, day: 30 },
                { mode: 'monthly', time: '09:00', day: 1, days: [] },
                { mode: 'monthly', time: '09:00', days: [1, 32] },
                { mode: 'yearly', time: '09:00', months: [], month: 3, days: [1] },
                { mode: 'yearly', time: '09:00', months: [2, 4], days: [31] },
                { mode: 'yearly', time: '09:00', months: [0, 3], days: [1] },
                { mode: 'daily', time: '09:00', days: [1] },
                {
                    mode: 'interval',
                    intervalValue: 1,
                    intervalUnit: 'hour',
                    time: '09:00',
                    anchorAt: '2026-10-23T02:15:00Z'
                },
                {
                    mode: 'interval',
                    intervalValue: 2,
                    intervalUnit: 'day',
                    time: '25:00',
                    anchorAt: '2026-10-23T02:15:00Z'
                },
                {
                    mode: 'interval',
                    intervalValue: 2,
                    intervalUnit: 'day',
                    time: '09:00',
                    weekdays: [1],
                    anchorAt: '2026-10-23T02:15:00Z'
                },
                {
                    mode: 'interval',
                    intervalValue: 2,
                    intervalUnit: 'week',
                    time: '09:00',
                    weekdays: [],
                    anchorAt: '2026-10-23T02:15:00Z'
                },
                {
                    mode: 'interval',
                    intervalValue: 2,
                    intervalUnit: 'week',
                    time: '09:00',
                    anchorAt: '2026-10-23T02:15:00Z'
                },
                {
                    mode: 'interval',
                    intervalValue: 3,
                    intervalUnit: 'month',
                    time: '09:00',
                    days: [],
                    anchorAt: '2026-10-23T02:15:00Z'
                },
                {
                    mode: 'interval',
                    intervalValue: 3,
                    intervalUnit: 'month',
                    time: '09:00',
                    days: [1, 32],
                    anchorAt: '2026-10-23T02:15:00Z'
                },
                {
                    mode: 'interval',
                    intervalValue: 2,
                    intervalUnit: 'year',
                    time: '09:00',
                    months: [2],
                    days: [30],
                    anchorAt: '2026-10-23T02:15:00Z'
                },
                {
                    mode: 'interval',
                    intervalValue: 2,
                    intervalUnit: 'year',
                    time: '09:00',
                    months: [],
                    days: [1],
                    anchorAt: '2026-10-23T02:15:00Z'
                }
            ]) {
                await expect(
                    (tool as any).handleExecute({
                        id: 'id-1',
                        title: 'Run',
                        content: 'Run',
                        trigger: { type: 'cron', recurrence }
                    })
                ).rejects.toThrow();
            }
            await expect(
                (tool as any).handleExecute({ id: 'id-1', title: 'Run', content: 'Run', trigger: { type: 'cron' } })
            ).rejects.toThrow();
            expect(callWorker).not.toHaveBeenCalled();
        }
    );

    test.each([
        [{ mode: 'daily', time: '09:00' }, '每天 09:00'],
        [{ mode: 'monthly', time: '09:00', days: [1, 15] }, '每月 1、15 日 09:00'],
        [{ mode: 'yearly', time: '09:00', months: [3, 6], days: [1, 15] }, '每年 3月、6月的 1、15 日 09:00'],
        [
            {
                mode: 'interval',
                intervalValue: 2,
                intervalUnit: 'day',
                time: '09:30',
                anchorAt: '2026-10-23T02:15:00Z'
            },
            '每隔 2 天 09:30'
        ],
        [
            {
                mode: 'interval',
                intervalValue: 2,
                intervalUnit: 'week',
                time: '09:30',
                weekdays: [1, 3],
                anchorAt: '2026-10-23T02:15:00Z'
            },
            '每隔 2 周的周一、周三 09:30'
        ],
        [
            {
                mode: 'interval',
                intervalValue: 3,
                intervalUnit: 'month',
                time: '18:20',
                days: [1, 15],
                anchorAt: '2026-10-23T02:15:00Z'
            },
            '每隔 3 个月的 1、15 日 18:20'
        ],
        [
            {
                mode: 'interval',
                intervalValue: 2,
                intervalUnit: 'year',
                time: '08:05',
                months: [3, 6],
                days: [1, 15],
                anchorAt: '2026-10-23T02:15:00Z'
            },
            '每隔 2 年，3月、6月的 1、15 日 08:05'
        ]
    ])('tool cards and execution context show all selected dates: %p', async (recurrence, expected) => {
        setRuntimeLocale('zh-CN');
        const trigger = {
            type: 'cron',
            timezone: 'Asia/Shanghai',
            cronExpression: '* * * * *',
            recurrence
        };
        const html = await new AddGlobalTodoTool({} as any).renderToolCall({
            args_object: { title: 'Morning', trigger },
            status: 'running'
        } as any);
        expect(html).toContain(expected);
        expect(html).not.toContain('* * * * *');
        expect(buildTriggerInfo(trigger)).toContain(expected);
        expect(buildTriggerInfo(trigger)).not.toContain('* * * * *');
    });
});
