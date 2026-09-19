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

const { installTimeoutBackgrounding, ShellTimeoutClock, BackgroundProcessManager } =
    await import('../../../main/applications/terminal/background.js');

describe('ShellTimeoutClock', () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    test('resume continues with the budget left at pause time', () => {
        jest.useFakeTimers();
        const onTimeout = jest.fn();
        const clock = new ShellTimeoutClock(1000, Date.now());
        clock.onTimeout(onTimeout);
        clock.start();
        jest.advanceTimersByTime(600);
        clock.pause();
        // 权限弹窗等待期间经过的 5s 不消耗超时预算
        jest.advanceTimersByTime(5000);
        expect(onTimeout).not.toHaveBeenCalled();
        clock.resume();
        jest.advanceTimersByTime(399);
        expect(onTimeout).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1);
        expect(onTimeout).toHaveBeenCalledTimes(1);
    });

    test('accumulates multiple pause windows and reports active elapsed time', () => {
        jest.useFakeTimers();
        const clock = new ShellTimeoutClock(1000, Date.now());
        clock.onTimeout(jest.fn());
        clock.start();
        jest.advanceTimersByTime(300);
        clock.pause();
        jest.advanceTimersByTime(1000);
        expect(clock.getActiveElapsedMs()).toBe(300);
        clock.resume();
        jest.advanceTimersByTime(300);
        clock.pause();
        jest.advanceTimersByTime(2000);
        expect(clock.getActiveElapsedMs()).toBe(600);
        clock.resume();
        jest.advanceTimersByTime(399);
        expect(clock.hasFired).toBe(false);
        jest.advanceTimersByTime(1);
        expect(clock.hasFired).toBe(true);
    });

    test('never fires when the timeout is disabled', () => {
        jest.useFakeTimers();
        const onTimeout = jest.fn();
        const clock = new ShellTimeoutClock(0, Date.now());
        clock.onTimeout(onTimeout);
        clock.start();
        clock.pause();
        clock.resume();
        jest.advanceTimersByTime(24 * 3600 * 1000);
        expect(onTimeout).not.toHaveBeenCalled();
    });

    test('pause and resume before start do not consume the budget', () => {
        jest.useFakeTimers();
        const onTimeout = jest.fn();
        const clock = new ShellTimeoutClock(1000, Date.now());
        clock.onTimeout(onTimeout);
        clock.pause();
        jest.advanceTimersByTime(500);
        clock.resume();
        clock.start();
        jest.advanceTimersByTime(999);
        expect(onTimeout).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1);
        expect(onTimeout).toHaveBeenCalledTimes(1);
    });

    test('cancel stops the timer and later pause or resume cannot re-arm it', () => {
        jest.useFakeTimers();
        const onTimeout = jest.fn();
        const clock = new ShellTimeoutClock(1000, Date.now());
        clock.onTimeout(onTimeout);
        clock.start();
        jest.advanceTimersByTime(200);
        clock.cancel();
        jest.advanceTimersByTime(10000);
        expect(onTimeout).not.toHaveBeenCalled();
        clock.pause();
        clock.resume();
        jest.advanceTimersByTime(10000);
        expect(onTimeout).not.toHaveBeenCalled();
    });

    test('resume after firing does not restart the timer', () => {
        jest.useFakeTimers();
        const onTimeout = jest.fn();
        const clock = new ShellTimeoutClock(100, Date.now());
        clock.onTimeout(onTimeout);
        clock.start();
        jest.advanceTimersByTime(100);
        clock.resume();
        jest.advanceTimersByTime(1000);
        expect(onTimeout).toHaveBeenCalledTimes(1);
    });

    test('cancel latches: a late resume after settle cannot re-arm the timer', () => {
        jest.useFakeTimers();
        const onTimeout = jest.fn();
        const clock = new ShellTimeoutClock(1000, Date.now());
        clock.onTimeout(onTimeout);
        clock.start();
        jest.advanceTimersByTime(200);
        // 命令在权限弹窗等待期间被终止（settle → cancel），
        // 之后迟到的权限决策触发 resume，不得复活计时器
        clock.pause();
        clock.cancel();
        clock.resume();
        jest.advanceTimersByTime(10000);
        expect(onTimeout).not.toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(0);
        // cancel 之后 start 同样失效
        clock.start();
        jest.advanceTimersByTime(10000);
        expect(onTimeout).not.toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(0);
    });
});

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

    test('keeps the timeout paused while a sandbox permission prompt waits for the user', async () => {
        jest.useFakeTimers();
        const proc = Object.assign(new EventEmitter(), { pid: 424242 }) as unknown as ChildProcess;
        const updateResult = jest.fn();
        const onFinish = jest.fn();
        const clock = new ShellTimeoutClock(1000, Date.now());
        const completion = installTimeoutBackgrounding({
            handle: { proc, detachListeners: jest.fn() },
            command: 'Set-Content D:/workspace/new.txt hi',
            startTime: Date.now(),
            timeout: 1000,
            getOutput: () => '',
            result: { updateResult, updateResultObject: jest.fn() } as any,
            isKilledByStop: () => false,
            clock,
            onFinish
        });

        jest.advanceTimersByTime(300);
        // 沙箱触发权限管控，弹窗等待用户决策：计时暂停，不再有武装的超时计时器
        clock.pause();
        jest.advanceTimersByTime(60000);
        expect(jest.getTimerCount()).toBe(0);
        // 权限被批准：恢复剩余预算（暂停时还剩 700ms）
        clock.resume();
        jest.advanceTimersByTime(699);
        expect(jest.getTimerCount()).toBe(1);
        jest.advanceTimersByTime(1);
        await expect(completion).resolves.toBe(true);
        expect(onFinish).toHaveBeenCalledWith(true);
        // 超时提示中的“已执行”时长排除权限等待时间（实际执行 1.0s，而非 61.3s）
        expect(updateResult.mock.lastCall![0]).toContain('已执行 1.0s');
    });

    test('excludes permission wait time from the backgrounded process elapsed time', async () => {
        jest.useFakeTimers();
        const proc = Object.assign(new EventEmitter(), {
            pid: 424243,
            stdout: new EventEmitter(),
            stderr: new EventEmitter()
        }) as unknown as ChildProcess;
        const clock = new ShellTimeoutClock(1000, Date.now());
        const completion = installTimeoutBackgrounding({
            handle: { proc, detachListeners: jest.fn() },
            command: 'long-running-command',
            startTime: Date.now(),
            timeout: 1000,
            getOutput: () => '',
            result: { updateResult: jest.fn(), updateResultObject: jest.fn() } as any,
            isKilledByStop: () => false,
            clock,
            onFinish: jest.fn()
        });

        jest.advanceTimersByTime(400);
        clock.pause();
        jest.advanceTimersByTime(60000);
        clock.resume();
        jest.advanceTimersByTime(600);
        await expect(completion).resolves.toBe(true);

        const status = BackgroundProcessManager.getInstance().getStatus(424243);
        expect(status.found).toBe(true);
        // checkShellStatus 汇报的已执行时长同样排除 60s 的权限等待
        expect(status.elapsedMs).toBe(1000);
    });

    test('times out normally when no permission prompt interrupts the command', async () => {
        jest.useFakeTimers();
        const proc = Object.assign(new EventEmitter(), { pid: 424244 }) as unknown as ChildProcess;
        const completion = installTimeoutBackgrounding({
            handle: { proc, detachListeners: jest.fn() },
            command: 'sleep',
            startTime: Date.now(),
            timeout: 1000,
            getOutput: () => '',
            result: { updateResult: jest.fn(), updateResultObject: jest.fn() } as any,
            isKilledByStop: () => false,
            onFinish: jest.fn()
        });

        jest.advanceTimersByTime(1000);
        await expect(completion).resolves.toBe(true);
    });
});
