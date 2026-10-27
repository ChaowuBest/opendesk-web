import { jest } from '@jest/globals';
import {
    describeLegacyRecurrence,
    describeTodoRecurrence
} from '../../../main/applications/todomgr/recurrence-description.js';
import { createTranslatorForTodoMgr } from '../../../main/applications/todomgr/locale/renderer.js';
import { AddGlobalTodoTool, UpdateGlobalTodoTool } from '../../../main/applications/todomgr/tools.js';
import { setRuntimeLocale } from '../../../locale/index.js';
import type { TodoRecurrence } from '../../../main/applications/todomgr/todo-recurrence.js';

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
                { mode: 'monthly', time: '09:00', days: [1, 32] },
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
                    intervalUnit: 'week',
                    time: '09:00',
                    weekdays: [],
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
});
