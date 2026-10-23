import { jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import TodoMgrWorker from '../../../main/applications/todomgr/worker.js';
import type { TodoRecurrence } from '../../../common/utils/todo-recurrence.js';

describe('TodoMgr recurrence timers after a delayed wake', () => {
    let worker: TodoMgrWorker;
    let tempDir: string;
    let dispatch: ReturnType<typeof jest.spyOn>;

    function job(todoId: string): any {
        return (worker as any).cronJobs.get(todoId);
    }

    async function addRecurrence(recurrence: TodoRecurrence = { mode: 'daily', time: '09:00' }, timezone = 'UTC') {
        return worker.addGlobalTodo('Daily', 'Run', 'medium', undefined, {
            type: 'cron',
            cronExpression: '* * * * *',
            timezone,
            recurrence
        });
    }

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-10-23T08:59:59Z'));
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-recurrence-late-wake-'));
        worker = new TodoMgrWorker('todomgr', tempDir);
        (worker as any).globalTodosPath = path.join(tempDir, 'global_todos.json');
        dispatch = jest.spyOn(worker as any, 'callApp').mockImplementation(() => {});
        jest.spyOn(worker as any, 'emitEvent').mockImplementation(async () => {});
    });

    afterEach(async () => {
        await worker.finalize();
        jest.restoreAllMocks();
        jest.useRealTimers();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('dispatches the overdue 09:00 run once like legacy cron and skips duplicate and following-minute wakes', async () => {
        const legacy = await worker.addGlobalTodo('Legacy daily', 'Run', 'medium', undefined, {
            type: 'cron',
            cronExpression: '0 9 * * *',
            timezone: 'UTC'
        });
        const recurrence = await addRecurrence();

        // Keep the actual Croner timers pending while advancing wall time, as after sleep or a blocked event loop.
        jest.setSystemTime(new Date('2026-10-23T09:01:01Z'));
        await jest.advanceTimersByTimeAsync(1000);

        expect({
            legacy: dispatch.mock.calls.filter((call) => call[1] === legacy.id).length,
            recurrence: dispatch.mock.calls.filter((call) => call[1] === recurrence.id).length
        }).toEqual({ legacy: 1, recurrence: 1 });
        expect(recurrence.last_triggered_at).toBe('2026-10-23T09:01:02.000Z');

        await job(recurrence.id).trigger();
        await jest.advanceTimersByTimeAsync(60_000);
        await job(recurrence.id).trigger();
        expect(dispatch).toHaveBeenCalledTimes(2);
    });

    test('coalesces a long live suspension without scanning every missed minute or replaying a backlog', async () => {
        const todo = await addRecurrence();
        const formatParts = jest.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');

        jest.setSystemTime(new Date('2031-10-23T09:01:01Z'));
        await jest.advanceTimersByTimeAsync(1000);

        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(formatParts.mock.calls.length).toBeLessThan(100);
        await jest.advanceTimersByTimeAsync(60_000);
        await job(todo.id).trigger();
        expect(dispatch).toHaveBeenCalledTimes(1);

        jest.setSystemTime(new Date('2031-10-24T09:00:00Z'));
        await job(todo.id).trigger();
        expect(dispatch).toHaveBeenCalledTimes(2);
    });

    test('a delayed elapsed-hour run retains its original anchor cadence', async () => {
        const todo = await addRecurrence({
            mode: 'interval',
            intervalValue: 5,
            intervalUnit: 'hour',
            anchorAt: '2026-10-23T09:00:00Z'
        });

        jest.setSystemTime(new Date('2026-10-23T11:01:01Z'));
        await jest.advanceTimersByTimeAsync(1000);
        expect(dispatch).toHaveBeenCalledTimes(1);

        jest.setSystemTime(new Date('2026-10-23T13:59:29Z'));
        await jest.advanceTimersByTimeAsync(30_000);
        expect(dispatch).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(1000);
        expect(dispatch).toHaveBeenCalledTimes(2);
        expect(todo.last_triggered_at).toBe('2026-10-23T14:00:00.000Z');
    });

    test('recovers the first DST overlap occurrence once and does not replay it after a clock rewind', async () => {
        jest.setSystemTime(new Date('2026-11-01T05:29:59Z'));
        const todo = await addRecurrence({ mode: 'daily', time: '01:30' }, 'America/New_York');

        jest.setSystemTime(new Date('2026-11-01T06:30:01Z'));
        await jest.advanceTimersByTimeAsync(1000);
        expect(dispatch).toHaveBeenCalledTimes(1);
        await job(todo.id).trigger();
        expect(dispatch).toHaveBeenCalledTimes(1);

        jest.setSystemTime(new Date('2026-11-01T05:30:00Z'));
        await job(todo.id).trigger();
        jest.setSystemTime(new Date('2026-11-01T06:31:00Z'));
        await job(todo.id).trigger();
        expect(dispatch).toHaveBeenCalledTimes(1);

        jest.setSystemTime(new Date('2026-11-02T06:30:00Z'));
        await job(todo.id).trigger();
        expect(dispatch).toHaveBeenCalledTimes(2);
    });

    test('does not invent an execution in the spring DST gap when a timer wakes late', async () => {
        jest.setSystemTime(new Date('2026-03-08T06:59:59Z'));
        const todo = await addRecurrence({ mode: 'daily', time: '02:30' }, 'America/New_York');

        jest.setSystemTime(new Date('2026-03-08T07:31:01Z'));
        await jest.advanceTimersByTimeAsync(1000);
        expect(dispatch).not.toHaveBeenCalled();

        jest.setSystemTime(new Date('2026-03-09T06:30:00Z'));
        await job(todo.id).trigger();
        expect(dispatch).toHaveBeenCalledTimes(1);
    });

    test('starting a fresh job after a restart does not catch up schedules from the stopped period', async () => {
        const todo = await addRecurrence();
        await worker.finalize();
        jest.setSystemTime(new Date('2026-10-23T09:01:01Z'));
        await (worker as any).loadGlobalTodos();
        (worker as any).startAllTriggers();

        await jest.advanceTimersByTimeAsync(60_000);
        await job(todo.id).trigger();
        expect(dispatch).not.toHaveBeenCalled();
    });
});
