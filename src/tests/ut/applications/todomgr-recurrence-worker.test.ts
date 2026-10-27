import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import TodoMgrWorker from '../../../main/applications/todomgr/worker.js';
import type { CronTriggerConfig } from '../../../main/applications/todomgr/common.js';
import type { TodoRecurrence } from '../../../main/applications/todomgr/todo-recurrence.js';

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
        // fake timers 会连带 fake Intl.DateTimeFormat，原型 spy 失效；排除 Intl 使时区 mock 生效。
        jest.useFakeTimers({ doNotFake: ['Intl'] });
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

    test('a wake in the startup execution minute still dispatches once', async () => {
        jest.setSystemTime(new Date('2026-10-22T01:00:12Z'));
        const callApp = jest.spyOn(worker as any, 'callApp').mockImplementation(() => {});
        const todo = await worker.addGlobalTodo('Current execution', 'Run', 'medium', undefined, trigger());

        await job(todo.id).trigger();
        await job(todo.id).trigger();

        expect(callApp).toHaveBeenCalledTimes(1);
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

    test('new recurrence timezone defaults to the system and survives updates that omit timezone', async () => {
        const resolvedOptions = new Intl.DateTimeFormat().resolvedOptions();
        jest.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
            ...resolvedOptions,
            timeZone: 'Asia/Shanghai'
        });
        const { timezone: _timezone, ...withoutZone } = trigger();
        const todo = await worker.addGlobalTodo('Daily', 'Run', 'medium', undefined, withoutZone);
        expect((todo.trigger as CronTriggerConfig).timezone).toBe('Asia/Shanghai');
        const updated = await worker.updateGlobalTodo(todo.id, { trigger: withoutZone });
        expect((updated.trigger as CronTriggerConfig).timezone).toBe('Asia/Shanghai');
        const callApp = jest.spyOn(worker as any, 'callApp').mockImplementation(() => {});
        jest.setSystemTime(new Date('2026-10-22T01:00:00Z'));
        await job(todo.id).trigger();
        expect(callApp).toHaveBeenCalledTimes(1);
        jest.setSystemTime(new Date('2026-10-22T09:00:00Z'));
        await job(todo.id).trigger();
        expect(callApp).toHaveBeenCalledTimes(1);
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

    test('equivalent recurrence updates preserve the marker and running job', async () => {
        const monthly = trigger({ mode: 'monthly', time: '09:00', days: [23, 25] });
        const todo = await worker.addGlobalTodo('Monthly', 'Run', 'medium', undefined, monthly);
        await worker.updateGlobalTodo(todo.id, { last_triggered_at: '2026-10-22T01:00:00Z' });
        const runningJob = job(todo.id);
        const startSpy = jest.spyOn(worker as any, 'startCronJob');

        const updated = await worker.updateGlobalTodo(todo.id, {
            trigger: trigger({ mode: 'monthly', time: '09:00', days: [25, 23, 23] })
        });

        expect(updated.last_triggered_at).toBe('2026-10-22T01:00:00Z');
        expect(startSpy).not.toHaveBeenCalled();
        expect(job(todo.id)).toBe(runningJob);
    });

    test('editing content does not restart an unchanged cron schedule', async () => {
        const todo = await worker.addGlobalTodo('Daily', 'Run', 'medium', undefined, trigger());
        const runningJob = job(todo.id);
        const startSpy = jest.spyOn(worker as any, 'startCronJob');

        await worker.updateGlobalTodo(todo.id, { content: 'Updated run instructions' });

        expect(startSpy).not.toHaveBeenCalled();
        expect(job(todo.id)).toBe(runningJob);
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
