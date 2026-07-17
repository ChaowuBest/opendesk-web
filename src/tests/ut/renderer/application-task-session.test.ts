import { describe, expect, jest, test } from '@jest/globals';
import { ApplicationTaskSession } from '../../../renderer/scripts/application-task-session.js';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

describe('application task session', () => {
    test('coalesces concurrent initial task creation', async () => {
        const task = deferred<string>();
        const createTask = jest.fn(() => task.promise);
        const mountTask = jest.fn(async () => undefined);
        const session = new ApplicationTaskSession({
            createTask,
            mountTask,
            unmountTask: jest.fn(async () => undefined)
        });

        const first = session.ensureTask();
        const second = session.ensureTask();
        task.resolve('task-1');

        await expect(first).resolves.toBe('task-1');
        await expect(second).resolves.toBe('task-1');
        expect(createTask).toHaveBeenCalledTimes(1);
        expect(mountTask).toHaveBeenCalledTimes(1);
        expect(session.taskId).toBe('task-1');
    });

    test('coalesces rapid new-task actions and switches context once', async () => {
        const createTask = jest.fn<() => Promise<string>>();
        createTask.mockResolvedValueOnce('task-1').mockResolvedValueOnce('task-2');
        const mountTask = jest.fn(async () => undefined);
        const unmountTask = jest.fn(async () => undefined);
        const session = new ApplicationTaskSession({ createTask, mountTask, unmountTask });
        await session.ensureTask();

        const firstSwitch = session.startNewTask();
        const secondSwitch = session.startNewTask();

        await expect(firstSwitch).resolves.toBe('task-2');
        await expect(secondSwitch).resolves.toBe('task-2');
        expect(createTask).toHaveBeenCalledTimes(2);
        expect(unmountTask).toHaveBeenCalledTimes(1);
        expect(mountTask).toHaveBeenNthCalledWith(1, 'task-1');
        expect(mountTask).toHaveBeenNthCalledWith(2, 'task-2');
        expect(session.taskId).toBe('task-2');
    });

    test('makes ensureTask wait for an in-flight context switch', async () => {
        const nextTask = deferred<string>();
        const createTask = jest
            .fn<() => Promise<string>>()
            .mockResolvedValueOnce('task-1')
            .mockImplementationOnce(() => nextTask.promise);
        const session = new ApplicationTaskSession({
            createTask,
            mountTask: jest.fn(async () => undefined),
            unmountTask: jest.fn(async () => undefined)
        });
        await session.ensureTask();

        const switching = session.startNewTask();
        const ensuring = session.ensureTask();
        nextTask.resolve('task-2');

        await expect(switching).resolves.toBe('task-2');
        await expect(ensuring).resolves.toBe('task-2');
        expect(session.taskId).toBe('task-2');
    });

    test('clears a failed mount so the next attempt can recover', async () => {
        const createTask = jest
            .fn<() => Promise<string>>()
            .mockResolvedValueOnce('task-broken')
            .mockResolvedValueOnce('task-recovered');
        const mountTask = jest.fn(async (taskId: string) => {
            if (taskId === 'task-broken') {
                throw new Error('mount failed');
            }
        });
        const unmountTask = jest.fn(async () => undefined);
        const discardTask = jest.fn(async () => undefined);
        const session = new ApplicationTaskSession({ createTask, mountTask, unmountTask, discardTask });

        await expect(session.ensureTask()).rejects.toThrow('mount failed');
        expect(session.taskId).toBeNull();
        expect(discardTask).toHaveBeenCalledWith('task-broken');
        await expect(session.ensureTask()).resolves.toBe('task-recovered');
        expect(unmountTask).toHaveBeenCalledTimes(1);
        expect(session.taskId).toBe('task-recovered');
    });

    test('recovers a new-task switch when initial creation fails', async () => {
        const initialTask = deferred<string>();
        const createTask = jest
            .fn<() => Promise<string>>()
            .mockImplementationOnce(() => initialTask.promise)
            .mockResolvedValueOnce('task-recovered');
        const session = new ApplicationTaskSession({
            createTask,
            mountTask: jest.fn(async () => undefined),
            unmountTask: jest.fn(async () => undefined)
        });

        const initialCreation = session.ensureTask();
        const switching = session.startNewTask();
        initialTask.reject(new Error('create failed'));

        await expect(initialCreation).rejects.toThrow('create failed');
        await expect(switching).resolves.toBe('task-recovered');
        expect(createTask).toHaveBeenCalledTimes(2);
        expect(session.taskId).toBe('task-recovered');
    });
});
