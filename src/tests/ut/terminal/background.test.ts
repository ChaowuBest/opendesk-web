import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BoundedOutputBuffer, TERMINAL_OUTPUT_MAX_CHARS } from '../../../main/applications/terminal/output-buffer.js';

// setting.ts 含 create(import.meta.url) 写法，ts-jest 编译为 CJS 后与 require 标识符冲突，mock 掉
// （background.ts 经 shellExec.ts 间接依赖 setting.ts）
jest.unstable_mockModule('../../../main/utils/setting.js', () => ({
    Setting: class {
        static getInstance() {
            return {
                getData: () => {
                    throw new Error('Setting not initialized in test');
                },
                getEffectiveWorkspace: () => '/'
            };
        }
    },
    getOpendeskDirectory: () => '/tmp/opendesk-test'
}));

const { installTimeoutBackgrounding } = await import('../../../main/applications/terminal/background.js');

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

    test('formats completed and timed-out output without changing the original buffer', async () => {
        jest.useFakeTimers();
        const formatOutput = jest.fn((output: string) => `${output}\n\nSandbox path hint`);
        const completed = new EventEmitter() as ChildProcess;
        const updateCompleted = jest.fn();
        const completedResult = installTimeoutBackgrounding({
            handle: { proc: completed, detachListeners: jest.fn() },
            command: 'read-file',
            startTime: Date.now(),
            timeout: 1000,
            getOutput: () => 'Access is denied: C:\\file.txt',
            formatOutput,
            result: { updateResult: updateCompleted, updateResultObject: jest.fn() } as any,
            isKilledByStop: () => false,
            onFinish: jest.fn()
        });
        completed.emit('close', 1);
        await expect(completedResult).resolves.toBe(false);
        expect(updateCompleted).toHaveBeenCalledWith('Access is denied: C:\\file.txt\n\nSandbox path hint');

        const timedOut = Object.assign(new EventEmitter(), {
            pid: 987655,
            stdout: new EventEmitter(),
            stderr: new EventEmitter()
        }) as unknown as ChildProcess;
        const updateTimedOut = jest.fn();
        const timedOutResult = installTimeoutBackgrounding({
            handle: { proc: timedOut, detachListeners: jest.fn() },
            command: 'read-file',
            startTime: Date.now(),
            timeout: 1000,
            getOutput: () => 'Access is denied: C:\\file.txt',
            formatOutput,
            result: { updateResult: updateTimedOut, updateResultObject: jest.fn() } as any,
            isKilledByStop: () => false,
            onFinish: jest.fn()
        });
        jest.advanceTimersByTime(1000);
        await expect(timedOutResult).resolves.toBe(true);
        expect(updateTimedOut.mock.lastCall![0]).toContain('Access is denied: C:\\file.txt\n\nSandbox path hint');
        expect(formatOutput).toHaveBeenCalledWith('Access is denied: C:\\file.txt');
    });

    test('keeps the complete artifact when a truncated command moves to the background', async () => {
        jest.useFakeTimers();
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-background-output-'));
        const artifactPath = path.join(directory, 'terminal.log');
        const stdout = new EventEmitter();
        const stderr = new EventEmitter();
        const proc = Object.assign(new EventEmitter(), {
            pid: 987654,
            stdout,
            stderr
        }) as unknown as ChildProcess;
        const buffer = new BoundedOutputBuffer('', 'truncated', artifactPath, 'saved');
        const foregroundOutput = 'a'.repeat(TERMINAL_OUTPUT_MAX_CHARS + 1);
        const backgroundOutput = 'background tail';
        buffer.append(foregroundOutput);
        const onFinish = jest.fn((backgrounded?: boolean) => {
            if (!backgrounded) buffer.closeArtifact();
        });

        try {
            const completion = installTimeoutBackgrounding({
                handle: { proc, detachListeners: jest.fn() },
                command: 'long-running-command',
                startTime: Date.now(),
                timeout: 1000,
                getOutput: () => buffer.getText(),
                getOutputBuffer: () => buffer,
                result: { updateResult: jest.fn(), updateResultObject: jest.fn() } as any,
                isKilledByStop: () => false,
                onFinish
            });

            jest.advanceTimersByTime(1000);
            await expect(completion).resolves.toBe(true);
            expect(onFinish).toHaveBeenCalledWith(true);

            stdout.emit('data', Buffer.from(backgroundOutput));
            proc.emit('close', 0);

            expect(fs.readFileSync(artifactPath, 'utf8')).toBe(foregroundOutput + backgroundOutput);
        } finally {
            buffer.closeArtifact();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
});
