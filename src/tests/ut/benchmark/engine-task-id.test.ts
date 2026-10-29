import { jest } from '@jest/globals';

/**
 * 测评引擎 taskId 上报时机回归：
 * 运行/验证任务的 taskId 必须在任务创建后立即写入 run.json，
 * 而不是等任务跑完——否则测评界面里「正在运行」的用例拿不到可跳转的任务。
 * 走真实 BenchmarkManager 的落盘链路，只把任务内核换成可控桩。
 */

type FakeTask = {
    task_id: string;
    submitUserMessage: jest.Mock;
    stop: jest.Mock;
    waitUntilFinished: () => Promise<void>;
    rebuildSystemPrompt: () => Promise<void>;
    unload: () => void;
    hooks: { noticeBeforeTaskStart: (task: unknown) => Promise<void> };
    finish: () => void;
};

const createdTasks: FakeTask[] = [];

function makeFakeTask(id: string): FakeTask {
    // 与真实 TaskState 相同的事件语义：结束后才注册的 waiter 也要立即放行
    let settled = false;
    let waiters: Array<() => void> = [];
    const settle = () => {
        settled = true;
        const pending = waiters;
        waiters = [];
        for (const resolve of pending) resolve();
    };
    return {
        task_id: id,
        submitUserMessage: jest.fn(async () => ({ status: 'ok' })),
        stop: jest.fn(() => settle()),
        waitUntilFinished: () => (settled ? Promise.resolve() : new Promise<void>((resolve) => waiters.push(resolve))),
        rebuildSystemPrompt: async () => undefined,
        unload: () => undefined,
        hooks: { noticeBeforeTaskStart: async () => undefined },
        finish: () => settle()
    };
}

const initHarness = jest.fn(async () => undefined);
const taskManagerStub = {
    createTask: jest.fn(() => {
        const task = makeFakeTask(`task-${createdTasks.length + 1}`);
        createdTasks.push(task);
        return task;
    }),
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
jest.unstable_mockModule('../../../main/applications/benchmark/script-runtime.js', () => ({
    runScript: async () => ({ ok: true, code: 0, error: '', logError: '' }),
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

/** 造一个最小可运行的测评集：1 个 track、1 个用例，用例无准备脚本 */
function makeDataset(rootDir: string): string {
    const trackId = 'track-a';
    const caseDir = path.join(rootDir, 'tracks', trackId, 'case-1');
    fs.mkdirSync(caseDir, { recursive: true });
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
    fs.writeFileSync(path.join(caseDir, 'case.json'), JSON.stringify({ name: 'case-1' }));
    fs.writeFileSync(path.join(caseDir, 'run.md'), 'run instruction');
    fs.writeFileSync(path.join(caseDir, 'verify.md'), 'verify instruction');
    return rootDir;
}

function setup(): { manager: InstanceType<typeof BenchmarkManager>; datasetId: string } {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-engine-'));
    const manager = new BenchmarkManager(dataDir);
    manager.init();
    const dataset = makeDataset(path.join(dataDir, 'fixture'));
    // 导入走压缩包路径太重，这里直接把 fixture 目录塞进 datasets/ 并补 meta
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
            caseCount: 1,
            tracks: [{ id: 'track-a', name: 'track-a', description: '', caseCount: 1 }]
        })
    );
    return { manager, datasetId };
}

function startRun(manager: InstanceType<typeof BenchmarkManager>, datasetId: string): string {
    return manager.startRun({
        datasetId,
        concurrency: 1,
        runModel: 'model-a',
        verifyModel: 'model-b'
    });
}

describe('benchmark engine taskId 上报时机', () => {
    test('运行任务的 taskId 在任务创建后立即写入运行记录', async () => {
        const { manager, datasetId } = setup();
        const runId = startRun(manager, datasetId);

        await waitFor(() => createdTasks.length === 1);
        const record = manager.getRun(runId)!;
        expect(record).not.toBeNull();
        expect(record.cases[0].status).toBe('running');
        expect(record.cases[0].runTaskId).toBe('task-1');
        expect(record.cases[0].verifyTaskId).toBeNull();

        createdTasks[0].finish();
        await waitFor(() => createdTasks.length === 2);
        // 收尾：验证任务也要结束，否则引擎里会留着一个 1800s 的用例超时定时器，
        // jest worker 迟迟不能退出（单跑该文件表现为进程挂住，全量跑表现为强制退出告警）
        createdTasks[1].finish();
        await waitFor(() => manager.getRun(runId)!.status !== 'running');
    });

    test('验证任务的 taskId 同样在创建后立即可见，跑完后得分落盘', async () => {
        const { manager, datasetId } = setup();
        const runId = startRun(manager, datasetId);

        await waitFor(() => createdTasks.length === 1);
        createdTasks[0].finish();
        await waitFor(() => createdTasks.length === 2);

        const verifying = manager.getRun(runId)!;
        expect(verifying.cases[0].status).toBe('verifying');
        expect(verifying.cases[0].runTaskId).toBe('task-1');
        expect(verifying.cases[0].verifyTaskId).toBe('task-2');

        createdTasks[1].finish();
        await waitFor(() => manager.getRun(runId)!.status !== 'running');
        const finished = manager.getRun(runId)!;
        expect(finished.cases[0].status).toBe('done');
        expect(finished.cases[0].ratio).toBeCloseTo(0.9);
        expect(finished.cases[0].runTaskId).toBe('task-1');
        expect(finished.cases[0].verifyTaskId).toBe('task-2');
    });

    test('中途停止后，已创建任务的任务 id 保留在记录里', async () => {
        const { manager, datasetId } = setup();
        const runId = startRun(manager, datasetId);

        await waitFor(() => createdTasks.length === 1);
        manager.stopRun(runId);

        await waitFor(() => manager.getRun(runId)!.status !== 'running');
        const stopped = manager.getRun(runId)!;
        expect(createdTasks[0].stop).toHaveBeenCalledWith('system');
        expect(stopped.cases[0].status).toBe('stopped');
        expect(stopped.cases[0].runTaskId).toBe('task-1');
    });
});
