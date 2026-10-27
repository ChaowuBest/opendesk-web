import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import TodoMgrWorker from '../../../main/applications/todomgr/worker.js';
import { GetCurrentTimeTool, UpdateGlobalTodoTool } from '../../../main/applications/todomgr/tools.js';
import type { TodoTrigger } from '../../../main/applications/todomgr/common.js';

describe('automation task timezones', () => {
    let worker: TodoMgrWorker;
    let tempDir: string;

    beforeEach(() => {
        // fake timers 会连带 fake Intl.DateTimeFormat；排除 Intl 保持真实时区与 DST 行为。
        jest.useFakeTimers({ doNotFake: ['Intl'] });
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

    test('getCurrentTime reports the system IANA timezone for scheduling', async () => {
        const tool = new GetCurrentTimeTool();
        const result = await (tool as any).handleExecute();
        expect(result).toContain(Intl.DateTimeFormat().resolvedOptions().timeZone);
    });
});
