import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import TodoMgrWorker from '../../../main/applications/todomgr/worker.js';
import type { CronTriggerConfig } from '../../../main/applications/todomgr/common.js';
import type { TodoRecurrence } from '../../../common/utils/todo-recurrence.js';

describe('visual todo recurrence worker scheduling', () => {
    let worker: TodoMgrWorker;
    let dir: string;
    const rule: TodoRecurrence = { mode: 'daily', time: '09:00' };
    function trigger(recurrence: TodoRecurrence = rule): CronTriggerConfig {
        return { type: 'cron', cronExpression: '* * * * *', timezone: 'Asia/Shanghai', recurrence };
    }
    function job(id: string): any {
        return (worker as any).cronJobs.get(id);
    }
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-10-22T00:00:00Z'));
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-recurrence-worker-'));
        worker = new TodoMgrWorker('todomgr', dir);
        (worker as any).globalTodosPath = path.join(dir, 'global_todos.json');
    });
    afterEach(async () => {
        await worker.finalize();
        jest.restoreAllMocks();
        jest.useRealTimers();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('minute wakes only persist and dispatch on the selected local execution time, with model routing intact', async () => {
        const callApp = jest.spyOn(worker as any, 'callApp').mockImplementation(() => {});
        const todo = await worker.addGlobalTodo(
            'Daily',
            'Run',
            'medium',
            undefined,
            trigger(),
            undefined,
            undefined,
            'test-model',
            'high'
        );
        const before = fs.readFileSync(path.join(dir, 'global_todos.json'), 'utf8');
        await job(todo.id).trigger();
        expect(callApp).not.toHaveBeenCalled();
        expect(fs.readFileSync(path.join(dir, 'global_todos.json'), 'utf8')).toBe(before);
        jest.setSystemTime(new Date('2026-10-22T01:00:12Z'));
        await job(todo.id).trigger();
        await job(todo.id).trigger();
        expect(callApp).toHaveBeenCalledTimes(1);
        expect(callApp).toHaveBeenCalledWith(
            'triggerTodoTask',
            todo.id,
            'Daily',
            'Run',
            todo.trigger,
            undefined,
            undefined,
            'test-model',
            'high'
        );
        expect(todo.last_triggered_at).toBe('2026-10-22T01:00:12.000Z');
    });

    test('a recurrence persists unchanged and survives worker reload', async () => {
        const todo = await worker.addGlobalTodo('Daily', 'Run', 'medium', undefined, trigger());
        await worker.finalize();
        await (worker as any).loadGlobalTodos();
        (worker as any).startAllTriggers();
        const restored = await worker.getGlobalTodoById(todo.id);
        expect(restored?.trigger).toEqual(trigger());
        expect(job(todo.id).nextRun().toISOString()).toBe('2026-10-22T00:01:00.000Z');
        const callApp = jest.spyOn(worker as any, 'callApp').mockImplementation(() => {});
        jest.setSystemTime(new Date('2026-10-22T01:00:00Z'));
        await job(todo.id).trigger();
        expect(callApp).toHaveBeenCalledTimes(1);
        await (worker as any).loadGlobalTodos();
        (worker as any).startAllTriggers();
        await job(todo.id).trigger();
        expect(callApp).toHaveBeenCalledTimes(1);
    });

    test.each([
        {
            recurrence: { mode: 'monthly', time: '09:00', days: [25, 23, 23] } as TodoRecurrence,
            excluded: '2026-10-24T01:00:00Z',
            next: '2026-10-25T01:00:00Z'
        },
        {
            recurrence: { mode: 'yearly', time: '09:00', months: [12, 10, 10], days: [25, 23, 23] } as TodoRecurrence,
            excluded: '2026-11-23T01:00:00Z',
            next: '2026-12-23T01:00:00Z'
        }
    ])(
        'multiple calendar selections survive reload and control actual callbacks: $recurrence.mode',
        async ({ recurrence, excluded, next }) => {
            const selectedTrigger = trigger(recurrence);
            const todo = await worker.addGlobalTodo('Multiple dates', 'Run', 'medium', undefined, selectedTrigger);
            const stored = JSON.parse(fs.readFileSync(path.join(dir, 'global_todos.json'), 'utf8'));
            expect(stored.todos.find((entry: { id: string }) => entry.id === todo.id).trigger).toEqual(selectedTrigger);
            await worker.finalize();
            await (worker as any).loadGlobalTodos();
            (worker as any).startAllTriggers();
            expect((await worker.getGlobalTodoById(todo.id))?.trigger).toEqual(selectedTrigger);
            const callApp = jest.spyOn(worker as any, 'callApp').mockImplementation(() => {});
            jest.setSystemTime(new Date('2026-10-23T01:00:00Z'));
            await job(todo.id).trigger();
            await job(todo.id).trigger();
            expect(callApp).toHaveBeenCalledTimes(1);
            jest.setSystemTime(new Date(excluded));
            await job(todo.id).trigger();
            expect(callApp).toHaveBeenCalledTimes(1);
            jest.setSystemTime(new Date(next));
            await job(todo.id).trigger();
            expect(callApp).toHaveBeenCalledTimes(2);
        }
    );

    test('clock rewinds and disabled schedules do not replay previously saved executions', async () => {
        const todo = await worker.addGlobalTodo('Daily', 'Run', 'medium', undefined, trigger());
        const callApp = jest.spyOn(worker as any, 'callApp').mockImplementation(() => {});
        jest.setSystemTime(new Date('2026-10-24T01:00:00Z'));
        await job(todo.id).trigger();
        jest.setSystemTime(new Date('2026-10-23T01:00:00Z'));
        await job(todo.id).trigger();
        expect(callApp).toHaveBeenCalledTimes(1);
        await worker.updateGlobalTodo(todo.id, { enabled: false });
        expect(job(todo.id)).toBeUndefined();
    });

    test('new recurrence timezone defaults to the system while updates without timezone retain legacy UTC semantics', async () => {
        const resolvedOptions = new Intl.DateTimeFormat().resolvedOptions();
        jest.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
            ...resolvedOptions,
            timeZone: 'Asia/Shanghai'
        });
        const { timezone: _timezone, ...withoutZone } = trigger();
        const todo = await worker.addGlobalTodo('Daily', 'Run', 'medium', undefined, withoutZone);
        expect((todo.trigger as CronTriggerConfig).timezone).toBe('Asia/Shanghai');
        const updated = await worker.updateGlobalTodo(todo.id, { trigger: withoutZone });
        expect(updated.trigger).not.toHaveProperty('timezone');
        const callApp = jest.spyOn(worker as any, 'callApp').mockImplementation(() => {});
        jest.setSystemTime(new Date('2026-10-22T01:00:00Z'));
        await job(todo.id).trigger();
        expect(callApp).not.toHaveBeenCalled();
        jest.setSystemTime(new Date('2026-10-22T09:00:00Z'));
        await job(todo.id).trigger();
        expect(callApp).toHaveBeenCalledTimes(1);
    });

    test.each([
        { mode: 'weekly', time: '09:00', weekdays: [] },
        { mode: 'daily', time: '09:00', weekdays: [1] },
        { mode: 'monthly', time: '09:00', day: 1, days: [] },
        { mode: 'yearly', time: '09:00', months: [2], days: [30, 31] },
        { mode: 'interval', intervalHours: 168, weekdays: [1], anchorAt: '2026-10-25T00:00:00Z' }
    ])('rejects malformed or unreachable recurrences before mutating state: %j', async (recurrence) => {
        const invalid = { ...trigger(recurrence as TodoRecurrence), timezone: 'UTC' };
        await expect(worker.addGlobalTodo('Bad', 'Run', 'medium', undefined, invalid)).rejects.toThrow();
        expect(await worker.listGlobalTodos()).toEqual([]);
        expect(fs.existsSync(path.join(dir, 'global_todos.json'))).toBe(false);
        const todo = await worker.addGlobalTodo('Original', 'Run', 'medium', undefined, trigger());
        const before = fs.readFileSync(path.join(dir, 'global_todos.json'), 'utf8');
        await expect(worker.updateGlobalTodo(todo.id, { title: 'Mutated', trigger: invalid })).rejects.toThrow();
        expect((await worker.getGlobalTodoById(todo.id))?.title).toBe('Original');
        expect(fs.readFileSync(path.join(dir, 'global_todos.json'), 'utf8')).toBe(before);
    });

    test('editing only recurrence resets its prior marker and changes the matching schedule', async () => {
        const todo = await worker.addGlobalTodo('Daily', 'Run', 'medium', undefined, trigger());
        await worker.updateGlobalTodo(todo.id, { last_triggered_at: '2026-10-21T01:00:00Z' });
        const updated = await worker.updateGlobalTodo(todo.id, { trigger: trigger({ mode: 'daily', time: '10:00' }) });
        expect(updated.last_triggered_at).toBeUndefined();
        const callApp = jest.spyOn(worker as any, 'callApp').mockImplementation(() => {});
        jest.setSystemTime(new Date('2026-10-22T01:00:00Z'));
        await job(todo.id).trigger();
        expect(callApp).not.toHaveBeenCalled();
        jest.setSystemTime(new Date('2026-10-22T02:00:00Z'));
        await job(todo.id).trigger();
        expect(callApp).toHaveBeenCalledTimes(1);
    });

    test('calendar overlap runs once while elapsed-hour intervals can run twice', async () => {
        const callApp = jest.spyOn(worker as any, 'callApp').mockImplementation(() => {});
        const daily = await worker.addGlobalTodo('Daily', 'Run', 'medium', undefined, {
            ...trigger({ mode: 'daily', time: '01:30' }),
            timezone: 'America/New_York'
        });
        const elapsed = await worker.addGlobalTodo('Interval', 'Run', 'medium', undefined, {
            ...trigger({ mode: 'interval', intervalHours: 1, weekdays: [0], anchorAt: '2026-11-01T05:30:00Z' }),
            timezone: 'America/New_York'
        });
        for (const instant of ['2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z']) {
            jest.setSystemTime(new Date(instant));
            await job(daily.id).trigger();
            await job(elapsed.id).trigger();
        }
        expect(callApp.mock.calls.filter((call) => call[1] === daily.id)).toHaveLength(1);
        expect(callApp.mock.calls.filter((call) => call[1] === elapsed.id)).toHaveLength(2);
    });
});
