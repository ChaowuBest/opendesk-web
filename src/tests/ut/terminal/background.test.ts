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

    /**
     * 事件/定时器回调抛错时，仍然必须结算。
     *
     * 回归背景：这些回调由子进程事件或定时器触发，异常不会被 Promise 捕获。一旦跳过
     * settle()，工具会永久挂起——closeArtifact 不被调用（artifact 不落盘、
     * tmp 文件不释放）、runningProcesses / stopPromises 不清理、stop() 等不到 close。
     */
    describe('回调抛错仍然结算', () => {
        let warnSpy: ReturnType<typeof jest.spyOn>;

        beforeEach(() => {
            warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        });

        afterEach(() => {
            warnSpy.mockRestore();
        });

        test('超时后台接管失败（detachListeners 抛错）→ 结算为未后台化并清理', async () => {
            jest.useFakeTimers();
            const proc = new EventEmitter() as ChildProcess;
            const onFinish = jest.fn();
            const completion = installTimeoutBackgrounding({
                handle: {
                    proc,
                    detachListeners: () => {
                        throw new Error('detach exploded');
                    }
                },
                command: 'hang',
                startTime: Date.now(),
                timeout: 1000,
                getOutput: () => 'partial output',
                result: { updateResult: jest.fn(), updateResultObject: jest.fn() } as any,
                isKilledByStop: () => false,
                onFinish
            });

            jest.advanceTimersByTime(1000);

            await expect(completion).resolves.toBe(false);
            // 未后台化 → onFinish(false) 会让调用方关闭 artifact
            expect(onFinish).toHaveBeenCalledWith(false);
            expect(jest.getTimerCount()).toBe(0);
            expect(warnSpy).toHaveBeenCalled();
        });

        test('进程缺少 pid 时不能误判为接管成功（否则 artifact 再也没人关）', async () => {
            jest.useFakeTimers();
            const proc = new EventEmitter() as ChildProcess;
            const onFinish = jest.fn();
            const completion = installTimeoutBackgrounding({
                handle: { proc, detachListeners: jest.fn() },
                command: 'no-pid',
                startTime: Date.now(),
                timeout: 1000,
                getOutput: () => 'out',
                result: { updateResult: jest.fn(), updateResultObject: jest.fn() } as any,
                isKilledByStop: () => false,
                onFinish
            });

            jest.advanceTimersByTime(1000);

            await expect(completion).resolves.toBe(false);
            expect(onFinish).toHaveBeenCalledWith(false);
            expect(jest.getTimerCount()).toBe(0);
        });

        test('关闭回调里的格式化抛错 → 仍然结算', async () => {
            jest.useFakeTimers();
            const proc = new EventEmitter() as ChildProcess;
            const onFinish = jest.fn();
            const completion = installTimeoutBackgrounding({
                handle: { proc, detachListeners: jest.fn() },
                command: 'odd-output',
                startTime: Date.now(),
                timeout: 30000,
                getOutput: () => 'out',
                formatOutput: () => {
                    throw new Error('format exploded');
                },
                result: { updateResult: jest.fn(), updateResultObject: jest.fn() } as any,
                isKilledByStop: () => false,
                onFinish
            });

            proc.emit('close', 0);

            await expect(completion).resolves.toBe(false);
            expect(onFinish).toHaveBeenCalledTimes(1);
            expect(jest.getTimerCount()).toBe(0);
        });

        test('onFinish 清理逻辑抛错也必须 resolve，不能让工具挂住', async () => {
            jest.useFakeTimers();
            const proc = new EventEmitter() as ChildProcess;
            const completion = installTimeoutBackgrounding({
                handle: { proc, detachListeners: jest.fn() },
                command: 'cleanup-boom',
                startTime: Date.now(),
                timeout: 30000,
                getOutput: () => 'done',
                result: { updateResult: jest.fn(), updateResultObject: jest.fn() } as any,
                isKilledByStop: () => false,
                onFinish: () => {
                    throw new Error('cleanup exploded');
                }
            });

            proc.emit('close', 0);

            await expect(completion).resolves.toBe(false);
            expect(jest.getTimerCount()).toBe(0);
        });
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
            if (!backgrounded) void buffer.closeArtifact();
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

            // artifact 写入已改为异步流：等待落盘完成后再断言（fake timers 会拦住
            // 流事件的 nextTick 派发，这里先切回真实定时器）
            jest.useRealTimers();
            await buffer.closeArtifact();
            expect(fs.readFileSync(artifactPath, 'utf8')).toBe(foregroundOutput + backgroundOutput);
        } finally {
            jest.useRealTimers();
            await buffer.closeArtifact();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    test('终态更新清掉 live tick 残留的 outputDelta，避免渲染端重复追加', async () => {
        jest.useFakeTimers();
        const stdout = new EventEmitter();
        const proc = Object.assign(new EventEmitter(), {
            pid: 555,
            stdout,
            stderr: new EventEmitter()
        }) as unknown as ChildProcess;
        // 模拟上一次 live tick 留在 ToolResult 上的增量字段
        const result = {
            outputDelta: 'stale tail',
            outputReset: true,
            updateResult: jest.fn(),
            updateResultObject: jest.fn()
        } as any;

        const completion = installTimeoutBackgrounding({
            handle: { proc, detachListeners: jest.fn() },
            command: 'ls',
            startTime: Date.now(),
            timeout: 5000,
            getOutput: () => 'final output',
            result,
            isKilledByStop: () => false,
            onFinish: jest.fn()
        });

        proc.emit('close', 0);
        await expect(completion).resolves.toBe(false);

        expect(result.updateResult).toHaveBeenCalledWith('final output');
        expect(result.outputDelta).toBeUndefined();
        expect(result.outputReset).toBeUndefined();
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

    describe('silent output hints', () => {
        test('appends a buffered-pipeline hint when a piped command times out with no output', async () => {
            jest.useFakeTimers();
            const proc = Object.assign(new EventEmitter(), { pid: 424250 }) as unknown as ChildProcess;
            const updateResult = jest.fn();
            const completion = installTimeoutBackgrounding({
                handle: { proc, detachListeners: jest.fn() },
                command: 'npm run build-cli 2>&1 | Select-Object -Last 6; npm run build 2>&1 | Select-Object -Last 6',
                startTime: Date.now(),
                timeout: 1000,
                getOutput: () => '',
                result: { updateResult, updateResultObject: jest.fn() } as any,
                isKilledByStop: () => false,
                onFinish: jest.fn()
            });

            jest.advanceTimersByTime(1000);
            await expect(completion).resolves.toBe(true);
            const message = updateResult.mock.lastCall![0] as string;
            expect(message).toContain('(暂无输出)');
            // 缓冲类管道让输出在命令结束前完全不可见，必须向模型说明并给出可见性替代方案
            expect(message).toContain('Select-Object');
            expect(message).toContain('结束前无法观察进度');
            expect(message).toContain('kill=true');
        });

        test('appends a generic silence hint for non-buffering commands with no output', async () => {
            jest.useFakeTimers();
            const proc = Object.assign(new EventEmitter(), { pid: 424251 }) as unknown as ChildProcess;
            const updateResult = jest.fn();
            const completion = installTimeoutBackgrounding({
                handle: { proc, detachListeners: jest.fn() },
                command: 'long-running-build',
                startTime: Date.now(),
                timeout: 1000,
                getOutput: () => '',
                result: { updateResult, updateResultObject: jest.fn() } as any,
                isKilledByStop: () => false,
                onFinish: jest.fn()
            });

            jest.advanceTimersByTime(1000);
            await expect(completion).resolves.toBe(true);
            const message = updateResult.mock.lastCall![0] as string;
            expect(message).toContain('没有任何输出');
            expect(message).toContain('kill=true');
            expect(message).not.toContain('不代表卡死');
        });

        test('does not append a silence hint when the command already produced output', async () => {
            jest.useFakeTimers();
            const proc = Object.assign(new EventEmitter(), { pid: 424252 }) as unknown as ChildProcess;
            const updateResult = jest.fn();
            const completion = installTimeoutBackgrounding({
                handle: { proc, detachListeners: jest.fn() },
                command: 'npm run build-cli 2>&1 | Select-Object -Last 6',
                startTime: Date.now(),
                timeout: 1000,
                getOutput: () => 'built in 12s',
                result: { updateResult, updateResultObject: jest.fn() } as any,
                isKilledByStop: () => false,
                onFinish: jest.fn()
            });

            jest.advanceTimersByTime(1000);
            await expect(completion).resolves.toBe(true);
            const message = updateResult.mock.lastCall![0] as string;
            expect(message).toContain('built in 12s');
            expect(message).not.toContain('不代表卡死');
            expect(message).not.toContain('没有任何输出');
        });
    });
});

describe('BackgroundProcessManager status poll gate', () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    function registerPollProc(manager: InstanceType<typeof BackgroundProcessManager>, pid: number): ChildProcess {
        const proc = Object.assign(new EventEmitter(), {
            pid,
            stdout: new EventEmitter(),
            stderr: new EventEmitter()
        }) as unknown as ChildProcess;
        manager.register(proc, 'long-job', '', Date.now());
        return proc;
    }

    test('allows the first poll, blocks unchanged-output polls within the cooldown, and escalates on retries', () => {
        jest.useFakeTimers();
        jest.setSystemTime(0);
        const manager = new BackgroundProcessManager();
        registerPollProc(manager, 71001);

        // 首次查询始终放行
        expect(manager.beginStatusPoll(71001).allowed).toBe(true);
        manager.completeStatusPoll(71001);

        // 60s 后再次查询，输出仍无变化：落在 90s 冷却窗口内，拒绝
        jest.setSystemTime(60_000);
        const first = manager.beginStatusPoll(71001);
        expect(first.allowed).toBe(false);
        expect(first.blockedCount).toBe(1);

        // 连续重试继续升级冷却；被拒绝的查询不移动冷却基准（以 0 时刻起算）
        jest.setSystemTime(70_000);
        const second = manager.beginStatusPoll(71001);
        expect(second.allowed).toBe(false);
        expect(second.blockedCount).toBe(2);
        expect(second.sinceLastPollMs).toBe(70_000);

        // 两次拒绝后冷却 360s，等过窗口后放行
        jest.setSystemTime(70_000 + 360_000);
        expect(manager.beginStatusPoll(71001).allowed).toBe(true);
        manager.completeStatusPoll(71001);

        // 放行的查询清零连续拒绝计数，冷却回到基准 90s
        jest.setSystemTime(70_000 + 360_000 + 60_000);
        const after = manager.beginStatusPoll(71001);
        expect(after.allowed).toBe(false);
        expect(after.blockedCount).toBe(1);
    });

    test('allows polling immediately when the output changed', () => {
        jest.useFakeTimers();
        jest.setSystemTime(0);
        const manager = new BackgroundProcessManager();
        const proc = registerPollProc(manager, 71002);

        expect(manager.beginStatusPoll(71002).allowed).toBe(true);
        manager.completeStatusPoll(71002);

        // 输出有新增：不受冷却限制（健康构建的进度轮询永远放行）
        jest.setSystemTime(10_000);
        proc.stdout!.emit('data', Buffer.from('progress line\n'));
        expect(manager.beginStatusPoll(71002).allowed).toBe(true);
    });

    test('bypasses the gate for finished processes and unknown pids', () => {
        jest.useFakeTimers();
        jest.setSystemTime(0);
        const manager = new BackgroundProcessManager();
        const proc = registerPollProc(manager, 71003);

        expect(manager.beginStatusPoll(71003).allowed).toBe(true);
        manager.completeStatusPoll(71003);

        jest.setSystemTime(5_000);
        proc.emit('close', 0);
        expect(manager.beginStatusPoll(71003).allowed).toBe(true);
        expect(manager.beginStatusPoll(999999).allowed).toBe(true);
    });

    test('completeStatusPoll is a safe no-op for unknown pids and finished entries', () => {
        jest.useFakeTimers();
        jest.setSystemTime(0);
        const manager = new BackgroundProcessManager();
        const proc = registerPollProc(manager, 71004);

        // 未经 begin 的直接记录也要落快照，供下一次闸门比较
        manager.completeStatusPoll(71004);
        expect(() => manager.completeStatusPoll(719999)).not.toThrow();

        jest.setSystemTime(200_000);
        expect(manager.beginStatusPoll(71004).allowed).toBe(true);

        jest.setSystemTime(201_000);
        proc.emit('exit', 0);
        manager.completeStatusPoll(71004);
        expect(manager.beginStatusPoll(71004).allowed).toBe(true);
    });
});
