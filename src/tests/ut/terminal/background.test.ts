import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { installTimeoutBackgrounding } from '../../../main/applications/terminal/background';

describe('installTimeoutBackgrounding', () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    test('records an integer exit code and clears the backgrounding timer', async () => {
        jest.useFakeTimers();
        const proc = new EventEmitter() as ChildProcess;
        const updateResult = jest.fn();
        const updateResultObject = jest.fn();
        const onFinish = jest.fn();
        const completion = installTimeoutBackgrounding({
            handle: {
                proc,
                detachListeners: jest.fn()
            },
            command: 'true',
            startTime: Date.now(),
            timeout: 30000,
            getOutput: () => 'done',
            result: { updateResult, updateResultObject } as any,
            isKilledByStop: () => false,
            onFinish
        });

        proc.emit('close', 0);

        await expect(completion).resolves.toBe(false);
        expect(updateResult).toHaveBeenCalledWith('done');
        expect(updateResultObject).toHaveBeenCalledWith({ exitCode: 0 });
        expect(onFinish).toHaveBeenCalledTimes(1);
        expect(jest.getTimerCount()).toBe(0);
    });

    test('does not fabricate an exit code when the process emits an error', async () => {
        const proc = new EventEmitter() as ChildProcess;
        const updateResult = jest.fn();
        const updateResultObject = jest.fn();
        const completion = installTimeoutBackgrounding({
            handle: { proc, detachListeners: jest.fn() },
            command: 'broken',
            startTime: Date.now(),
            timeout: 0,
            getOutput: () => '',
            result: { updateResult, updateResultObject } as any,
            isKilledByStop: () => false,
            onFinish: jest.fn()
        });

        proc.emit('error', new Error('spawn failed'));

        await expect(completion).resolves.toBe(false);
        expect(updateResult).toHaveBeenCalledWith('执行命令时出错: spawn failed');
        expect(updateResultObject).not.toHaveBeenCalled();
    });

    test('does not record a non-integer close code', async () => {
        const proc = new EventEmitter() as ChildProcess;
        const updateResultObject = jest.fn();
        const completion = installTimeoutBackgrounding({
            handle: { proc, detachListeners: jest.fn() },
            command: 'odd',
            startTime: Date.now(),
            timeout: 0,
            getOutput: () => 'done',
            result: { updateResult: jest.fn(), updateResultObject } as any,
            isKilledByStop: () => false,
            onFinish: jest.fn()
        });

        proc.emit('close', 0.5);

        await expect(completion).resolves.toBe(false);
        expect(updateResultObject).not.toHaveBeenCalled();
    });
});
