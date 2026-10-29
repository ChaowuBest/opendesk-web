import { jest } from '@jest/globals';

/**
 * 测评停止链路回归：
 * 1) 停止请求落在任务提交前不丢：任务必须补收到 stop；
 * 2) waitUntilFinished 以 resolveOnStop 等待，stop 后即使任务不自行结束也能立刻返回；
 * 3) 正在执行的准备脚本会被 stop 中止，用例按 stopped 收尾而不是一直挂着。
 */

type FakeTask = {
    task_id: string;
    submitUserMessage: jest.Mock;
    stop: jest.Mock;
    waitUntilFinished: (callback?: unknown, resolveOnStop?: boolean) => Promise<void>;
    rebuildSystemPrompt: () => Promise<void>;
    unload: () => void;
    hooks: { noticeBeforeTaskStart: (task: unknown) => Promise<void> };
    finish: () => void;
    /** 模拟真实 TaskState.stop 的语义：唤醒所有等待者 */
    settle: () => void;
};

const createdTasks: FakeTask[] = [];

function makeFakeTask(id: string, submitGate?: Promise<void>): FakeTask {
    // 与真实 TaskState 一致：任务有 created/running/stopped/finished 四个阶段，
    // submitUserMessage 会无条件把状态置回 running 并启动新 turn（提交前收到的
    // stop 会被提交这一步"复活"），只有 stop()/正常结束才会离开 running。
    let phase: 'created' | 'running' | 'stopped' | 'finished' = 'created';
    const stopWaiters: Array<() => void> = [];
    const finishWaiters: Array<() => void> = [];
    const wake = (waiters: Array<() => void>) => {
        const pending = waiters.splice(0, waiters.length);
        for (const resolve of pending) resolve();
    };
    const finishAll = () => {
        phase = 'finished';
        wake(stopWaiters);
        wake(finishWaiters);
    };
    const task: FakeTask = {
        task_id: id,
        submitUserMessage: jest.fn(async () => {
            // submitGate 用来造「停止请求落在提交过程中」的窗口
            if (submitGate) await submitGate;
            if (phase !== 'finished') phase = 'running';
            return { status: 'ok' };
        }),
        stop: jest.fn(() => {
            phase = 'stopped';
            wake(stopWaiters);
            wake(finishWaiters);
        }),
        waitUntilFinished: (_callback, resolveOnStop) => {
            if (phase !== 'running') return Promise.resolve();
            return new Promise<void>((resolve) => {
                // 与真实语义一致：resolveOnStop 时 stop() 直接唤醒；否则只能等正常结束
                if (resolveOnStop) stopWaiters.push(resolve);
                else finishWaiters.push(resolve);
            });
        },
        rebuildSystemPrompt: async () => undefined,
        unload: () => undefined,
        hooks: { noticeBeforeTaskStart: async () => undefined },
        finish: () => finishAll(),
        settle: () => finishAll()
    };
    createdTasks.push(task);
    return task;
}

const initHarness = jest.fn(async () => undefined);
const taskManagerStub = {
    createTask: jest.fn(() => makeFakeTask(`task-${createdTasks.length + 1}`)),
    initHarness
};
const agentStub = { supportedModes: () => [{ id: 'unlimited' }] };

jest.unstable_mockModule('../../../main/aikernel/states/global.js', () => ({
    GlobalState: { getInstance: () => ({ taskManagerState: taskManagerStub }) }
}));
jest.unstable_mockModule('../../../main/aikernel/agents/registry.js', () => ({
    AgentRegistry: { getMainAgent: () => agentStub }
}));
jest.unstable_mockModule('../../../main/aikernel/planning/harness.js', () => ({
    extractAttemptCompletionResult: () => ({ success: true, result: '{"score": 0.9, "reason": "ok"}' })
}));
jest.unstable_mockModule('../../../main/utils/logger.js', () => ({
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined }
}));

type ScriptRunOptions = {
    scriptPath: string;
    handle?: (script: { abort(): void }) => void;
    timeoutSec: number;
};

/**
 * runScript 桩：把 handle 回调暴露出来，测试用 abort() 驱动「脚本被杀」。
 * abort 后脚本以非零码退出，模拟真实进程被 taskkill/进程组信号终止。
 */
const startedScripts: Array<{ options: ScriptRunOptions; abort: () => void }> = [];
jest.unstable_mockModule('../../../main/applications/benchmark/script-runtime.js', () => ({
    runScript: (options: ScriptRunOptions) =>
        new Promise((resolve) => {
            const script = {
                abort: () => resolve({ ok: false, code: 1, error: 'aborted', logError: '' })
            };
            startedScripts.push({ options, abort: script.abort });
            options.handle?.(script);
        }),
    ScriptExecutionError: class extends Error {
        readonly logError = '';
    }
}));

const { BenchmarkManager } = await import('../../../main/applications/benchmark/manager.js');
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setRuntimeLocale } from '../../../locale/index.js';

beforeEach(() => {
    createdTasks.length = 0;
    startedScripts.length = 0;
    taskManagerStub.createTask.mockClear();
    initHarness.mockClear();
    setRuntimeLocale('zh-CN');
});

afterEach(() => {
    setRuntimeLocale(null);
});

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (!condition()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error('waitFor timed out');
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

/** 造一个测评集：1 个 track、caseCount 个用例；withPrepare 控制是否带挂起式准备脚本 */
function makeDataset(rootDir: string, caseCount: number, withPrepare: boolean): string {
    const trackId = 'track-a';
    fs.mkdirSync(path.join(rootDir, 'tracks', trackId), { recursive: true });
    fs.writeFileSync(
        path.join(rootDir, 'dataset.json'),
        JSON.stringify({
            name: 'DS',
            description: '',
            homepage: '',
            version: '1.0',
            tracks: [{ id: trackId, name: trackId }]
        })
    );
    fs.writeFileSync(path.join(rootDir, 'tracks', trackId, 'track.json'), '{}');
    for (let index = 1; index <= caseCount; index += 1) {
        const caseDir = path.join(rootDir, 'tracks', trackId, `case-${index}`);
        fs.mkdirSync(caseDir, { recursive: true });
        fs.writeFileSync(path.join(caseDir, 'case.json'), JSON.stringify({ name: `case-${index}` }));
        if (withPrepare) {
            fs.writeFileSync(path.join(caseDir, 'run-prepare.sh'), 'sleep 3600');
        }
        fs.writeFileSync(path.join(caseDir, 'run.md'), 'run instruction');
        fs.writeFileSync(path.join(caseDir, 'verify.md'), 'verify instruction');
    }
    return rootDir;
}

function setup(
    caseCount = 2,
    withPrepare = false
): { manager: InstanceType<typeof BenchmarkManager>; datasetId: string } {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-stop-'));
    const manager = new BenchmarkManager(dataDir);
    manager.init();
    const dataset = makeDataset(path.join(dataDir, 'fixture'), caseCount, withPrepare);
    const datasetId = path.basename(dataset);
    const targetDir = path.join(dataDir, 'datasets', datasetId);
    fs.renameSync(dataset, targetDir);
    fs.writeFileSync(
        path.join(targetDir, 'benchmark-meta.json'),
        JSON.stringify({
            id: datasetId,
            name: 'DS',
            description: '',
            homepage: '',
            version: '1.0',
            importedAt: Date.now(),
            caseCount,
            tracks: [{ id: 'track-a', name: 'track-a', description: '', caseCount }]
        })
    );
    return { manager, datasetId };
}

function startRun(manager: InstanceType<typeof BenchmarkManager>, datasetId: string): string {
    return manager.startRun({ datasetId, concurrency: 1, runModel: 'model-a', verifyModel: 'model-b' });
}

describe('benchmark 停止链路', () => {
    test('停止请求落在任务提交前：任务补收 stop，等待方立即返回，用例按 stopped 收尾', async () => {
        const { manager, datasetId } = setup(1);
        // 在 createTask 时就挂住 initHarness，保证 stop() 稳定落在
        // 「任务已创建、尚未提交」的窗口（submit 后再挂会晚一步）
        let releaseHarness: (() => void) | null = null;
        taskManagerStub.createTask.mockImplementationOnce(() => {
            const task = makeFakeTask(`task-${createdTasks.length + 1}`);
            initHarness.mockImplementationOnce(
                () =>
                    new Promise<void>((resolve) => {
                        releaseHarness = resolve;
                    })
            );
            return task;
        });

        const runId = startRun(manager, datasetId);
        await waitFor(() => createdTasks.length === 1);
        const task = createdTasks[0];

        manager.stopRun(runId);
        expect(task.stop).toHaveBeenCalledWith('system');

        releaseHarness?.();
        await waitFor(() => manager.getRun(runId)!.status !== 'running');
        const record = manager.getRun(runId)!;
        expect(record.status).toBe('stopped');
        expect(record.cases[0].status).toBe('stopped');
    });

    test('停止请求落在任务提交过程中：提交把任务置回 running 后引擎再停一刀，用例仍按 stopped 收尾', async () => {
        const { manager, datasetId } = setup(1);
        // submitUserMessage 挂住：让 stop() 稳定落在「提交已开始、尚未返回」的窗口
        let releaseSubmit: (() => void) | null = null;
        const submitGate = new Promise<void>((resolve) => {
            releaseSubmit = resolve;
        });
        taskManagerStub.createTask.mockImplementationOnce(() => makeFakeTask('task-1', submitGate));

        const runId = startRun(manager, datasetId);
        await waitFor(() => createdTasks.length === 1);
        manager.stopRun(runId);
        // 提交返回时任务会被真实 TaskState 置回 running（新的 turn），引擎必须在提交后补停
        releaseSubmit?.();

        await waitFor(() => manager.getRun(runId)!.status !== 'running', 2000);
        const record = manager.getRun(runId)!;
        expect(record.status).toBe('stopped');
        expect(record.cases[0].status).toBe('stopped');
        // 全程没有调用 finish()：收尾只能依赖引擎自己补的那次 stop
        expect(createdTasks[0].stop).toHaveBeenCalledTimes(2);
    });

    test('停止请求落在脚本执行阶段：脚本被 abort，用例按 stopped 收尾', async () => {
        const { manager, datasetId } = setup(2, true);
        const runId = startRun(manager, datasetId);

        await waitFor(() => startedScripts.length === 1);
        expect(manager.getRun(runId)!.cases[0].status).toBe('preparing');

        manager.stopRun(runId);
        await waitFor(() => manager.getRun(runId)!.status !== 'running', 8000);

        const record = manager.getRun(runId)!;
        expect(record.status).toBe('stopped');
        expect(record.cases.map((item) => item.status)).toEqual(['stopped', 'stopped']);
        // 排队中的第二个用例也会被标记为 stopped，不会残留 pending
        expect(record.summary.pending).toBe(0);
    });

    test('任务阶段停止：resolveOnStop 生效，stop 后整轮立即落盘为 stopped', async () => {
        const { manager, datasetId } = setup(1);
        const runId = startRun(manager, datasetId);

        await waitFor(() => createdTasks.length === 1);
        manager.stopRun(runId);

        // 停止标记先落盘，UI 据此显示「正在停止」
        const stopping = manager.getRun(runId)!;
        expect(stopping.stopRequested).toBe(true);

        await waitFor(() => manager.getRun(runId)!.status !== 'running');
        const record = manager.getRun(runId)!;
        expect(record.status).toBe('stopped');
        expect(record.stopRequested).toBeUndefined();
        expect(createdTasks[0].stop).toHaveBeenCalledWith('system');
        // run.json 里不应残留 running 状态的用例
        expect(record.cases.every((item) => item.status === 'stopped')).toBe(true);
    });
});
