import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import TodoMgrWorker from '../../../main/applications/todomgr/worker.js';
import {
    AddGlobalTodoTool,
    GetCurrentTimeTool,
    UpdateGlobalTodoTool
} from '../../../main/applications/todomgr/tools.js';
import { buildTriggerInfo } from '../../../main/applications/todomgr/trigger.js';
import { t } from '../../../main/applications/todomgr/locale/index.js';
import type { TodoTrigger } from '../../../main/applications/todomgr/common.js';

describe('automation task timezones', () => {
    let worker: TodoMgrWorker;
    let tempDir: string;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-03-07T15:00:00Z'));
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-todomgr-timezone-'));
        worker = new TodoMgrWorker('todomgr', tempDir);
        (worker as any).globalTodosPath = path.join(tempDir, 'global_todos.json');
    });

    afterEach(async () => {
        await worker.finalize();
        jest.restoreAllMocks();
        jest.useRealTimers();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    function nextRun(id: string): string {
        return (worker as any).cronJobs.get(id).nextRun().toISOString();
    }

    test('cron runs at the selected wall-clock time through daylight saving changes', async () => {
        const todo = await worker.addGlobalTodo('Morning', 'Run', 'medium', undefined, {
            type: 'cron',
            cronExpression: '0 9 * * *',
            timezone: 'America/New_York'
        } as TodoTrigger);

        expect(nextRun(todo.id)).toBe('2026-03-08T13:00:00.000Z');
        jest.setSystemTime(new Date('2026-10-31T15:00:00Z'));
        expect(nextRun(todo.id)).toBe('2026-11-01T14:00:00.000Z');
        const stored = JSON.parse(fs.readFileSync(path.join(tempDir, 'global_todos.json'), 'utf8'));
        expect(stored.todos[0].trigger.timezone).toBe('America/New_York');
        await (worker as any).loadGlobalTodos();
        (worker as any).startAllTriggers();
        expect(nextRun(todo.id)).toBe('2026-11-01T14:00:00.000Z');
    });

    test.each(['cron', 'scheduled'] as const)(
        'new %s tasks default to the system timezone and retain it after reloading',
        async (type) => {
            const resolvedOptions = new Intl.DateTimeFormat().resolvedOptions();
            jest.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
                ...resolvedOptions,
                timeZone: 'Asia/Shanghai'
            });
            const trigger: TodoTrigger =
                type === 'cron' ? { type, cronExpression: '0 9 * * *' } : { type, triggerAt: '2026-03-08T01:00:00Z' };
            const todo = await worker.addGlobalTodo('Morning', 'Run', 'medium', undefined, trigger);

            expect(todo.trigger).toEqual({ ...trigger, timezone: 'Asia/Shanghai' });
            expect(trigger).not.toHaveProperty('timezone');
            const stored = JSON.parse(fs.readFileSync(path.join(tempDir, 'global_todos.json'), 'utf8'));
            expect(stored.todos[0].trigger).toEqual({ ...trigger, timezone: 'Asia/Shanghai' });
            await (worker as any).loadGlobalTodos();
            (worker as any).startAllTriggers();
            expect((await worker.getGlobalTodoById(todo.id))?.trigger).toEqual({
                ...trigger,
                timezone: 'Asia/Shanghai'
            });
            if (type === 'cron') expect(nextRun(todo.id)).toBe('2026-03-08T01:00:00.000Z');
        }
    );

    test.each(['cron', 'scheduled'] as const)('new %s tasks retain an explicit UTC timezone', async (type) => {
        const resolvedOptions = new Intl.DateTimeFormat().resolvedOptions();
        jest.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
            ...resolvedOptions,
            timeZone: 'Asia/Shanghai'
        });
        const trigger: TodoTrigger =
            type === 'cron'
                ? { type, cronExpression: '0 9 * * *', timezone: 'UTC' }
                : { type, triggerAt: '2026-03-08T01:00:00Z', timezone: 'UTC' };
        const todo = await worker.addGlobalTodo('Morning', 'Run', 'medium', undefined, trigger);

        expect(todo.trigger).toEqual(trigger);
        if (type === 'cron') expect(nextRun(todo.id)).toBe('2026-03-08T09:00:00.000Z');
    });

    test('event tasks do not acquire a timezone', async () => {
        const trigger: TodoTrigger = { type: 'event', bundleName: 'mailbox', eventName: 'newEmailCountsUpdated' };
        const todo = await worker.addGlobalTodo('Mail', 'Run', 'medium', undefined, trigger);

        expect(todo.trigger).toEqual(trigger);
        expect(todo.trigger).not.toHaveProperty('timezone');
    });

    test('updating cron time without a timezone retains the existing wall-clock zone', async () => {
        const todo = await worker.addGlobalTodo('Morning', 'Run', 'medium', undefined, {
            type: 'cron',
            cronExpression: '0 9 * * *',
            timezone: 'Asia/Shanghai'
        });
        const trigger: TodoTrigger = { type: 'cron', cronExpression: '0 10 * * *' };

        const updated = await worker.updateGlobalTodo(todo.id, { trigger });

        expect(updated.trigger).toEqual({ ...trigger, timezone: 'Asia/Shanghai' });
        expect(trigger).not.toHaveProperty('timezone');
        expect(nextRun(todo.id)).toBe('2026-03-08T02:00:00.000Z');
    });

    test('the update tool changes daily frequency while preserving the stored timezone', async () => {
        const todo = await worker.addGlobalTodo('Morning', 'Run', 'medium', undefined, {
            type: 'cron',
            cronExpression: '* * * * *',
            recurrence: { mode: 'daily', time: '09:00' },
            timezone: 'Asia/Shanghai'
        });
        const tool = new UpdateGlobalTodoTool({
            callWorker: async (
                method: string,
                id: string,
                updates: Parameters<TodoMgrWorker['updateGlobalTodo']>[1]
            ) => {
                expect(method).toBe('updateGlobalTodo');
                return worker.updateGlobalTodo(id, updates);
            }
        } as any);

        await (tool as any).handleExecute({
            id: todo.id,
            trigger: { type: 'cron', recurrence: { mode: 'daily', time: '10:00' } }
        });

        const updated = await worker.getGlobalTodoById(todo.id);
        expect(updated?.trigger).toMatchObject({
            timezone: 'Asia/Shanghai',
            recurrence: { mode: 'daily', time: '10:00' }
        });
        const callApp = jest.spyOn(worker as any, 'callApp').mockImplementation(() => {});
        jest.setSystemTime(new Date('2026-03-08T01:00:00Z'));
        await (worker as any).cronJobs.get(todo.id).trigger();
        expect(callApp).not.toHaveBeenCalled();
        jest.setSystemTime(new Date('2026-03-08T02:00:00Z'));
        await (worker as any).cronJobs.get(todo.id).trigger();
        expect(callApp).toHaveBeenCalledTimes(1);
        expect((await worker.getGlobalTodoById(todo.id))?.last_triggered_at).toBe('2026-03-08T02:00:00.000Z');
    });

    test.each(['manual', 'event'] as const)(
        'adding a cron trigger to an existing %s task defaults to the system timezone',
        async (source) => {
            const resolvedOptions = new Intl.DateTimeFormat().resolvedOptions();
            jest.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
                ...resolvedOptions,
                timeZone: 'Asia/Shanghai'
            });
            const todo = await worker.addGlobalTodo(
                'Morning',
                'Run',
                'medium',
                undefined,
                source === 'event' ? { type: 'event', bundleName: 'mailbox', eventName: 'updated' } : undefined
            );

            const updated = await worker.updateGlobalTodo(todo.id, {
                trigger: { type: 'cron', cronExpression: '0 9 * * *' }
            });

            expect(updated.trigger).toMatchObject({ timezone: 'Asia/Shanghai' });
            expect(nextRun(todo.id)).toBe('2026-03-08T01:00:00.000Z');
        }
    );

    test('loading and updating a legacy cron without timezone preserves UTC scheduling', async () => {
        const todo = {
            id: 'legacy-cron',
            title: 'Morning',
            content: 'Run',
            priority: 'medium',
            enabled: true,
            created_at: '2026-03-01T00:00:00Z',
            updated_at: '2026-03-01T00:00:00Z',
            trigger: { type: 'cron', cronExpression: '0 9 * * *' }
        };
        fs.writeFileSync(path.join(tempDir, 'global_todos.json'), JSON.stringify({ version: '1.1', todos: [todo] }));
        await (worker as any).loadGlobalTodos();
        (worker as any).startAllTriggers();

        expect(nextRun(todo.id)).toBe('2026-03-08T09:00:00.000Z');
        const updated = await worker.updateGlobalTodo(todo.id, {
            title: 'Updated',
            trigger: { type: 'cron', cronExpression: '0 10 * * *' }
        });
        expect(updated.trigger).not.toHaveProperty('timezone');
        expect(nextRun(todo.id)).toBe('2026-03-08T10:00:00.000Z');
    });

    test('changing only cron timezone restarts its schedule and clears the previous trigger marker', async () => {
        const todo = await worker.addGlobalTodo('Morning', 'Run', 'medium', undefined, {
            type: 'cron',
            cronExpression: '0 9 * * *',
            timezone: 'Asia/Shanghai'
        } as TodoTrigger);
        await worker.updateGlobalTodo(todo.id, { last_triggered_at: '2026-03-07T01:00:00Z' });

        const updated = await worker.updateGlobalTodo(todo.id, {
            trigger: { type: 'cron', cronExpression: '0 9 * * *', timezone: 'America/New_York' } as TodoTrigger
        });

        expect(nextRun(todo.id)).toBe('2026-03-08T13:00:00.000Z');
        expect(updated.last_triggered_at).toBeUndefined();
    });

    test.each(['cron', 'scheduled'] as const)(
        'rejects invalid %s timezones without persistence changes',
        async (type) => {
            const trigger =
                type === 'cron' ? { type, cronExpression: '0 9 * * *' } : { type, triggerAt: '2026-03-08T01:00:00Z' };
            const invalidTrigger = { ...trigger, timezone: 'Invalid/Timezone' } as TodoTrigger;
            await expect(worker.addGlobalTodo('Invalid', 'Run', 'medium', undefined, invalidTrigger)).rejects.toThrow(
                t('error.timezoneInvalid', { timezone: 'Invalid/Timezone' })
            );
            expect(fs.existsSync(path.join(tempDir, 'global_todos.json'))).toBe(false);

            const todo = await worker.addGlobalTodo('Existing', 'Run', 'medium', undefined, trigger);
            const before = fs.readFileSync(path.join(tempDir, 'global_todos.json'), 'utf8');
            await expect(
                worker.updateGlobalTodo(todo.id, { title: 'Mutated', trigger: invalidTrigger })
            ).rejects.toThrow(t('error.timezoneInvalid', { timezone: 'Invalid/Timezone' }));
            expect((await worker.getGlobalTodoById(todo.id))?.title).toBe('Existing');
            expect(fs.readFileSync(path.join(tempDir, 'global_todos.json'), 'utf8')).toBe(before);
        }
    );

    test.each(['America/New_York', undefined])(
        'one-shot timezone update %s preserves the instant and completion state',
        async (timezone) => {
            const todo = await worker.addGlobalTodo('Once', 'Run', 'medium', undefined, {
                type: 'scheduled',
                triggerAt: '2026-03-07T14:00:00Z',
                timezone: 'Asia/Shanghai'
            } as TodoTrigger);
            const callApp = jest.spyOn(worker as any, 'callApp').mockImplementation(() => {});
            await (worker as any).checkScheduledTriggers();

            const updated = await worker.updateGlobalTodo(todo.id, {
                trigger: {
                    type: 'scheduled',
                    triggerAt: '2026-03-07T14:00:00Z',
                    ...(timezone !== undefined ? { timezone } : {})
                } as TodoTrigger
            });
            await jest.advanceTimersByTimeAsync(500);

            expect(updated.enabled).toBe(false);
            expect(updated.completed_at).toBe('2026-03-07T15:00:00.000Z');
            expect(updated.trigger).toEqual({
                type: 'scheduled',
                triggerAt: '2026-03-07T14:00:00Z',
                timezone: timezone ?? 'Asia/Shanghai'
            });
            expect(callApp).toHaveBeenCalledTimes(1);
        }
    );

    test.each([AddGlobalTodoTool, UpdateGlobalTodoTool])(
        'tool boundary preserves and validates timezone: %p',
        async (Tool) => {
            const callWorker = jest.fn(async () => ({ id: 'id-1' }));
            const tool = new Tool({ callWorker } as any);
            const trigger = { type: 'cron', cronExpression: '0 9 * * *', timezone: 'Asia/Shanghai' };
            await (tool as any).handleExecute({ id: 'id-1', title: 'Morning', content: 'Run', trigger });
            expect(JSON.stringify(callWorker.mock.calls)).toContain('Asia/Shanghai');
            callWorker.mockClear();

            await expect(
                (tool as any).handleExecute({
                    id: 'id-1',
                    title: 'Invalid',
                    content: 'Run',
                    trigger: { ...trigger, timezone: 'Invalid/Timezone' }
                })
            ).rejects.toThrow(t('error.timezoneInvalid', { timezone: 'Invalid/Timezone' }));
            expect(callWorker).not.toHaveBeenCalled();
        }
    );

    test('tool display and trigger context communicate the timezone', async () => {
        const trigger = { type: 'cron', cronExpression: '0 9 * * *', timezone: 'Asia/Shanghai' };
        const tool = new AddGlobalTodoTool({} as any);
        const html = await tool.renderToolCall({
            args_object: { title: 'Morning', trigger },
            status: 'running'
        } as any);
        expect(html).toContain('Asia/Shanghai');
        expect(html).toMatch(/\b0?9:00\b/);
        expect(buildTriggerInfo(trigger)).toContain('Asia/Shanghai');
        expect(
            buildTriggerInfo({ type: 'scheduled', triggerAt: '2026-03-08T01:00:00Z', timezone: 'Asia/Shanghai' })
        ).toContain('Asia/Shanghai');
    });

    test('new cron tool cards default to the system timezone in HTML and CLI', async () => {
        const resolvedOptions = new Intl.DateTimeFormat().resolvedOptions();
        jest.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
            ...resolvedOptions,
            timeZone: 'Asia/Shanghai'
        });
        const tool = new AddGlobalTodoTool({} as any);
        const toolcall = {
            args_object: { title: 'Morning', trigger: { type: 'cron', cronExpression: '0 9 * * *' } },
            status: 'running'
        } as any;

        const html = await tool.renderToolCall(toolcall);
        const cli = tool.renderToolCallCli(toolcall, 160)?.join('\n');
        expect(html).toContain('(Asia/Shanghai)');
        expect(html).toMatch(/\b0?9:00\b/);
        expect(cli).toContain('(Asia/Shanghai)');
        expect(cli).toMatch(/\b0?9:00\b/);
    });

    test('legacy cron update cards and trigger context explicitly identify UTC', async () => {
        const trigger = { type: 'cron', cronExpression: '0 9 * * *' };
        const tool = new UpdateGlobalTodoTool({} as any);
        const html = await tool.renderToolCall({
            args_object: { title: 'Morning', trigger },
            status: 'running'
        } as any);
        const info = buildTriggerInfo(trigger);

        expect(html).toContain('(UTC)');
        expect(html).toMatch(/\b0?9:00\b/);
        expect(info).toContain('(UTC)');
        expect(info).toMatch(/\b0?9:00\b/);
    });

    test('getCurrentTime reports the system IANA timezone for scheduling', async () => {
        const tool = new GetCurrentTimeTool();
        const result = await (tool as any).handleExecute();
        expect(result).toContain(Intl.DateTimeFormat().resolvedOptions().timeZone);
    });
});
