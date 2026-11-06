import { jest } from '@jest/globals';

/**
 * 「重新运行单个用例」回归：
 * 重跑必须发生在原 run 记录内（appendToRunId），其他用例的历史状态原样保留；
 * 返回值是原 runId，不再是新建的只含单用例的记录。
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
/** 验证任务返回的评分结果；置 null 表示拿不到评分（用例会 failed） */
let completionResult: string | null = '{"score": 0.9, "reason": "ok"}';

jest.unstable_mockModule('../../../main/aikernel/planning/harness.js', () => ({
    extractAttemptCompletionResult: () => (completionResult ? { success: true, result: completionResult } : null)
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
// engine 每个用例收尾都会真实 spawn shell 量目录（见 recordCaseUsage），
// 并行负载下会拖慢任务创建节奏、打穿 waitFor 的 5s 预算，必须 mock 掉
const getDiskUsage = jest.fn<(target: string) => Promise<{ bytes: number; kind: 'allocated' }>>();
jest.unstable_mockModule('../../../main/utils/shell-helper.js', () => ({ getDiskUsage }));

const { BenchmarkManager } = await import('../../../main/applications/benchmark/manager.js');
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setRuntimeLocale } from '../../../locale/index.js';

beforeEach(() => {
    createdTasks.length = 0;
    completionResult = '{"score": 0.9, "reason": "ok"}';
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

/** 1 个 track、2 个用例的最小测评集，无准备脚本 */
function makeDataset(rootDir: string): string {
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
    for (let index = 1; index <= 2; index += 1) {
        const caseDir = path.join(rootDir, 'tracks', trackId, `case-${index}`);
        fs.mkdirSync(caseDir, { recursive: true });
        fs.writeFileSync(path.join(caseDir, 'case.json'), JSON.stringify({ name: `case-${index}` }));
        fs.writeFileSync(path.join(caseDir, 'run.md'), 'run instruction');
        fs.writeFileSync(path.join(caseDir, 'verify.md'), 'verify instruction');
    }
    return rootDir;
}

function setup(): { manager: InstanceType<typeof BenchmarkManager>; datasetId: string } {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-rerun-'));
    const manager = new BenchmarkManager(dataDir);
    manager.init();
    const dataset = makeDataset(path.join(dataDir, 'fixture'));
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
            caseCount: 2,
            tracks: [{ id: 'track-a', name: 'track-a', description: '', caseCount: 2 }]
        })
    );
    return { manager, datasetId };
}

async function runAll(manager: InstanceType<typeof BenchmarkManager>, datasetId: string): Promise<string> {
    const runId = manager.startRun({ datasetId, concurrency: 1, runModel: 'model-a', verifyModel: 'model-b' });
    // 2 用例 × (运行任务 + 验证任务)，并发 1 顺序执行
    for (let index = 0; index < 4; index += 1) {
        await waitFor(() => createdTasks.length > index);
        createdTasks[index].finish();
    }
    await waitFor(() => manager.getRun(runId)!.status !== 'running');
    return runId;
}

describe('benchmark 原地重跑单个用例', () => {
    test('重跑返回原 runId，其他用例的历史结果保留', async () => {
        const { manager, datasetId } = setup();
        const runId = await runAll(manager, datasetId);
        const finished = manager.getRun(runId)!;
        expect(finished.status).toBe('completed');
        expect(finished.cases.map((item) => item.status)).toEqual(['done', 'done']);

        const returned = manager.startRun({
            datasetId,
            concurrency: 1,
            runModel: 'model-a',
            verifyModel: 'model-b',
            caseKeys: ['track-a/case-1'],
            appendToRunId: runId
        });
        expect(returned).toBe(runId);

        // rerun 的执行链在 startRun 返回前就会同步创建第一个任务
        await waitFor(() => createdTasks.length === 5);
        const record = manager.getRun(runId)!;
        expect(record.status).toBe('running');
        const case1 = record.cases.find((item) => item.key === 'track-a/case-1')!;
        const case2 = record.cases.find((item) => item.key === 'track-a/case-2')!;
        // 重跑用例已重新执行（startRun 返回前执行链就会同步开跑），上次的得分被清空
        expect(case1.status).toBe('running');
        expect(case1.score).toBeNull();
        expect(case2.status).toBe('done');
        expect(case2.ratio).toBeCloseTo(0.9);

        createdTasks[4].finish();
        // 重跑用例还有验证任务
        await waitFor(() => createdTasks.length === 6);
        createdTasks[5].finish();
        await waitFor(() => manager.getRun(runId)!.status !== 'running');
        const rerunDone = manager.getRun(runId)!;
        expect(rerunDone.status).toBe('completed');
        expect(rerunDone.cases.find((item) => item.key === 'track-a/case-2')!.status).toBe('done');
    });

    test('运行中的 run 不允许原地重跑', async () => {
        const { manager, datasetId } = setup();
        const runId = manager.startRun({ datasetId, concurrency: 1, runModel: 'model-a', verifyModel: 'model-b' });
        await waitFor(() => createdTasks.length === 1);

        expect(() =>
            manager.startRun({
                datasetId,
                concurrency: 1,
                runModel: 'model-a',
                verifyModel: 'model-b',
                caseKeys: ['track-a/case-2'],
                appendToRunId: runId
            })
        ).toThrow();

        // 用例只验证「运行中禁止重跑」，启动的 run 自身要收尾：停止 run 并让挂起的
        // 任务结束，否则引擎里的超时定时器与 pending waitUntilFinished 会留到测试结束后，
        // 使 jest worker 无法优雅退出
        manager.stopRun(runId);
        createdTasks.forEach((task) => task.finish());
    });

    test('重跑失败不会把整轮历史判成失败：其它用例仍跑通时整轮保持完成', async () => {
        const { manager, datasetId } = setup();
        const runId = await runAll(manager, datasetId);
        expect(manager.getRun(runId)!.status).toBe('completed');

        // 让验证任务拿不到评分：重跑的用例必然 failed
        completionResult = null;
        manager.startRun({
            datasetId,
            concurrency: 1,
            runModel: 'model-a',
            verifyModel: 'model-b',
            caseKeys: ['track-a/case-1'],
            appendToRunId: runId
        });
        await waitFor(() => createdTasks.length === 5);
        createdTasks[4].finish();
        await waitFor(() => createdTasks.length === 6);
        createdTasks[5].finish();
        await waitFor(() => manager.getRun(runId)!.status !== 'running');

        const record = manager.getRun(runId)!;
        expect(record.cases.find((item) => item.key === 'track-a/case-1')!.status).toBe('failed');
        expect(record.cases.find((item) => item.key === 'track-a/case-2')!.status).toBe('done');
        // 整轮状态按全部用例算：还有跑通的用例时不能标成失败，否则历史里 9 完成 1 失败
        // 的一轮会显示「失败」，总分却还在
        expect(record.status).toBe('completed');
    });

    test('appendToRunId 指向不存在的记录时报错', async () => {
        const { manager, datasetId } = setup();
        expect(() =>
            manager.startRun({
                datasetId,
                concurrency: 1,
                runModel: 'model-a',
                verifyModel: 'model-b',
                caseKeys: ['track-a/case-1'],
                appendToRunId: 'run-not-exist'
            })
        ).toThrow();
    });
});
