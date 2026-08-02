import { describe, expect, jest, test } from '@jest/globals';
import { WorkerRestartController } from '../../../main/applications/worker-restart.js';

describe('WorkerRestartController', () => {
    test('deduplicates error and exit events from the same worker', () => {
        const scheduled: Array<() => void> = [];
        const controller = new WorkerRestartController(5, (callback) => {
            scheduled.push(callback);
            return scheduled.length as unknown as ReturnType<typeof setTimeout>;
        });
        const restart = jest.fn();
        const worker = {};

        const errorDecision = controller.schedule(worker, restart);
        const exitDecision = controller.schedule(worker, restart);
        scheduled[0]();

        expect(errorDecision).toMatchObject({ firstFailure: true, scheduled: true, attempt: 1, delayMs: 1000 });
        expect(exitDecision).toMatchObject({ firstFailure: false, scheduled: false });
        expect(restart).toHaveBeenCalledTimes(1);
    });

    test('keeps retry count across failed worker constructions and stops at the limit', () => {
        const scheduled: Array<() => void> = [];
        const controller = new WorkerRestartController(2, (callback) => {
            scheduled.push(callback);
            return scheduled.length as unknown as ReturnType<typeof setTimeout>;
        });
        const restart = jest.fn();

        expect(controller.schedule({}, restart)).toMatchObject({ scheduled: true, attempt: 1, delayMs: 1000 });
        scheduled.shift()?.();
        expect(controller.schedule({}, restart)).toMatchObject({ scheduled: true, attempt: 2, delayMs: 2000 });
        scheduled.shift()?.();
        expect(controller.schedule({}, restart)).toMatchObject({ scheduled: false, exhausted: true, attempt: 2 });
    });

    test('resets retry count only after the worker is marked stable', () => {
        const scheduled: Array<() => void> = [];
        const controller = new WorkerRestartController(5, (callback) => {
            scheduled.push(callback);
            return scheduled.length as unknown as ReturnType<typeof setTimeout>;
        });

        expect(controller.schedule({}, jest.fn()).attempt).toBe(1);
        scheduled.shift()?.();
        controller.markStable();
        expect(controller.schedule({}, jest.fn())).toMatchObject({ scheduled: true, attempt: 1, delayMs: 1000 });
    });
});
