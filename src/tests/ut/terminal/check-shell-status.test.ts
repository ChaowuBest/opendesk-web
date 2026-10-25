import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import type { TaskState } from '../../../main/aikernel/states/tasks.js';
import {
    BackgroundProcessManager,
    type BackgroundProcessStatus,
    type StatusPollGate
} from '../../../main/applications/terminal/background.js';
import { CheckShellStatusTool, MAX_STATUS_WAIT_MS } from '../../../main/applications/terminal/shells/status.js';

const allowedGate: StatusPollGate = {
    allowed: true,
    cooldownMs: 0,
    blockedCount: 0,
    sinceLastPollMs: 0
};

const runningStatus: BackgroundProcessStatus = {
    found: true,
    finished: false,
    exitCode: null,
    output: 'working',
    elapsedMs: 2500,
    command: 'long-job'
};

const completedStatus: BackgroundProcessStatus = {
    ...runningStatus,
    finished: true,
    exitCode: 0,
    output: 'done',
    elapsedMs: 3000
};

function mockManager(statuses: BackgroundProcessStatus[]) {
    const getStatus = jest.fn<() => BackgroundProcessStatus>();
    for (const status of statuses) {
        getStatus.mockReturnValueOnce(status);
    }
    getStatus.mockReturnValue(statuses.at(-1)!);

    const manager = {
        getStatus,
        waitForFinish: jest.fn<(pid: number, waitMs: number, signal?: AbortSignal) => Promise<boolean>>(),
        killProcess: jest.fn<(pid: number) => boolean>(),
        beginStatusPoll: jest.fn<(pid: number) => StatusPollGate>(),
        completeStatusPoll: jest.fn<(pid: number) => void>()
    };
    manager.waitForFinish.mockResolvedValue(false);
    manager.killProcess.mockReturnValue(true);
    manager.beginStatusPoll.mockReturnValue(allowedGate);
    jest.spyOn(BackgroundProcessManager, 'getInstance').mockReturnValue(manager as unknown as BackgroundProcessManager);
    return manager;
}

function registerRunningProcess(manager: BackgroundProcessManager, pid: number): ChildProcess {
    const proc = new EventEmitter() as ChildProcess;
    Object.defineProperty(proc, 'pid', { value: pid });
    manager.register(proc, 'long-job', '', Date.now());
    return proc;
}

afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
});

describe('BackgroundProcessManager.waitForFinish', () => {
    test('returns early on completion, honours short bounds, and leaves no timers behind', async () => {
        jest.useFakeTimers();
        jest.setSystemTime(0);
        const manager = new BackgroundProcessManager();
        const proc = registerRunningProcess(manager, 60001);

        const waiting = manager.waitForFinish(60001, MAX_STATUS_WAIT_MS);
        proc.emit('close', 0);
        await jest.advanceTimersByTimeAsync(200);

        await expect(waiting).resolves.toBe(true);
        expect(jest.now()).toBe(200);
        expect(jest.getTimerCount()).toBe(0);

        // 等待上限小于轮询间隔时不得超出上限
        registerRunningProcess(manager, 60002);
        const bounded = manager.waitForFinish(60002, 50);
        await jest.advanceTimersByTimeAsync(50);

        await expect(bounded).resolves.toBe(false);
        expect(jest.now()).toBe(250);
        expect(jest.getTimerCount()).toBe(0);
    });

    test('ends promptly and clears its timer when the task signal is aborted', async () => {
        jest.useFakeTimers();
        jest.setSystemTime(0);
        const manager = new BackgroundProcessManager();
        registerRunningProcess(manager, 60003);
        const controller = new AbortController();

        const waiting = manager.waitForFinish(60003, MAX_STATUS_WAIT_MS, controller.signal);
        controller.abort();

        await expect(waiting).resolves.toBe(false);
        expect(jest.now()).toBe(0);
        expect(jest.getTimerCount()).toBe(0);
    });
});

describe('CheckShellStatusTool waitMs', () => {
    test('rejects out-of-range waits and stays immediate when waitMs is omitted or zero', async () => {
        const tool = new CheckShellStatusTool('powershell', false);
        expect(tool.validateArgs({ pid: 42, kill: false, waitMs: MAX_STATUS_WAIT_MS }).success).toBe(true);
        expect(tool.validateArgs({ pid: 42, kill: false, waitMs: MAX_STATUS_WAIT_MS + 1 }).success).toBe(false);
        expect(tool.validateArgs({ pid: 42, kill: false, waitMs: -1 }).success).toBe(false);
        expect(tool.validateArgs({ pid: 42, kill: false, waitMs: 1.5 }).success).toBe(false);

        const immediate: Array<{ pid: number; kill: boolean; waitMs?: number }> = [
            { pid: 42, kill: false },
            { pid: 42, kill: false, waitMs: 0 }
        ];
        for (const args of immediate) {
            jest.restoreAllMocks();
            const manager = mockManager([runningStatus]);

            const result = await tool.execute(args);

            expect(manager.getStatus).toHaveBeenCalledTimes(1);
            expect(manager.waitForFinish).not.toHaveBeenCalled();
            expect(result.result).toContain('进程状态: 仍在执行中');
        }

        jest.restoreAllMocks();
        const partialContextManager = mockManager([runningStatus]);

        const partialContextResult = await tool.execute({ pid: 42, kill: false, waitMs: 0 }, undefined, {
            getWorkspace: () => '/tmp'
        } as TaskState);

        expect(partialContextResult.status).toBe('success');
        expect(partialContextManager.getStatus).toHaveBeenCalledTimes(1);
        expect(partialContextManager.waitForFinish).not.toHaveBeenCalled();
        expect(partialContextResult.result).toContain('进程状态: 仍在执行中');
    });

    test('waits once, returns the refreshed status, and surfaces cancellation as an error', async () => {
        const tool = new CheckShellStatusTool('powershell', false);
        const controller = new AbortController();
        const taskState = { getAbortSignal: () => controller.signal } as TaskState;
        const args = { pid: 42, kill: false, waitMs: MAX_STATUS_WAIT_MS };

        const manager = mockManager([runningStatus, completedStatus]);
        manager.waitForFinish.mockResolvedValue(true);

        const refreshed = await tool.execute(args, undefined, taskState);

        expect(manager.waitForFinish).toHaveBeenCalledWith(42, MAX_STATUS_WAIT_MS, controller.signal);
        expect(refreshed.result).toContain('进程状态: 已完成');

        jest.restoreAllMocks();
        const aborted = mockManager([runningStatus]);
        aborted.waitForFinish.mockImplementation(async () => {
            controller.abort();
            return false;
        });

        const stopped = await tool.execute(args, undefined, taskState);

        expect(stopped.status).toBe('error');
        expect(stopped.result).toContain('任务已停止');
    });
});

describe('CheckShellStatusTool poll throttle', () => {
    test('rejects a throttled poll before waiting and records nothing', async () => {
        const tool = new CheckShellStatusTool('powershell', false);
        const manager = mockManager([runningStatus]);
        manager.beginStatusPoll.mockReturnValue({
            allowed: false,
            cooldownMs: 180_000,
            blockedCount: 2,
            sinceLastPollMs: 60_000
        });

        const throttled = await tool.execute({ pid: 42, kill: false, waitMs: MAX_STATUS_WAIT_MS });

        expect(throttled.status).toBe('error');
        expect(throttled.result).toContain('限流');
        expect(throttled.result).toContain('kill=true');
        expect(manager.waitForFinish).not.toHaveBeenCalled();
        expect(manager.completeStatusPoll).not.toHaveBeenCalled();
    });

    test('kill bypasses the throttle entirely', async () => {
        const tool = new CheckShellStatusTool('powershell', false);
        const manager = mockManager([runningStatus]);
        manager.beginStatusPoll.mockReturnValue({
            allowed: false,
            cooldownMs: 180_000,
            blockedCount: 3,
            sinceLastPollMs: 5_000
        });

        const killed = await tool.execute({ pid: 42, kill: true });

        expect(killed.status).toBe('success');
        expect(manager.beginStatusPoll).not.toHaveBeenCalled();
        expect(manager.killProcess).toHaveBeenCalledWith(42);
    });

    test('records an allowed poll after the status refresh', async () => {
        const tool = new CheckShellStatusTool('powershell', false);
        const manager = mockManager([runningStatus]);

        const result = await tool.execute({ pid: 42, kill: false, waitMs: 0 });

        expect(result.status).toBe('success');
        expect(manager.beginStatusPoll).toHaveBeenCalledWith(42);
        expect(manager.completeStatusPoll).toHaveBeenCalledWith(42);
    });

    test('does not record a poll when the pid is unknown', async () => {
        const tool = new CheckShellStatusTool('powershell', false);
        const manager = mockManager([{ ...runningStatus, found: false }]);

        const result = await tool.execute({ pid: 42, kill: false, waitMs: 0 });

        expect(result.result).toContain('未找到');
        expect(manager.completeStatusPoll).not.toHaveBeenCalled();
    });

    test('rejects the second unchanged poll of a silent process with a real manager', async () => {
        jest.useFakeTimers();
        jest.setSystemTime(0);
        const manager = new BackgroundProcessManager();
        jest.spyOn(BackgroundProcessManager, 'getInstance').mockReturnValue(manager);
        const proc = new EventEmitter() as ChildProcess;
        Object.defineProperty(proc, 'pid', { value: 72001 });
        manager.register(proc, 'long-job', '', Date.now());

        const tool = new CheckShellStatusTool('powershell', false);
        const first = await tool.execute({ pid: 72001, kill: false, waitMs: 0 });
        expect(first.status).toBe('success');
        expect(first.result).toContain('进程状态: 仍在执行中');

        jest.setSystemTime(30_000);
        const second = await tool.execute({ pid: 72001, kill: false, waitMs: 0 });
        expect(second.status).toBe('error');
        expect(second.result).toContain('限流');

        // 进程完成后查询放行
        jest.setSystemTime(60_000);
        proc.emit('close', 0);
        const third = await tool.execute({ pid: 72001, kill: false, waitMs: 0 });
        expect(third.status).toBe('success');
        expect(third.result).toContain('进程状态: 已完成');
    });
});

describe('CheckShellStatusTool.renderToolCallCli', () => {
    test('renders long tool output without crashing and keeps only the last 10 lines', () => {
        const tool = new CheckShellStatusTool('powershell', false);
        const lines = Array.from({ length: 25 }, (_, i) => `line-${i + 1}`);
        const rendered = tool.renderToolCallCli(
            { args_object: { pid: 60001 }, result: lines.join('\n'), status: 'completed' } as any,
            80
        );

        expect(rendered).toBeDefined();
        const text = rendered!.join('\n');
        expect(text).toContain('共 25 行');
        expect(text).toContain('line-25');
        expect(text).not.toContain('line-15');
    });
});
