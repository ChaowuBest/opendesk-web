import { jest } from '@jest/globals';

/**
 * 磁盘占用的记账语义：
 * - listRuns 的 usageBytes 是各用例记账值之和，读列表不扫盘；
 * - 老记录（没有 usageBytes）后台回填一次并写回 run.json，之后永久读记录；
 * - rescanRunUsage 是唯一的重扫入口：删掉工作空间后能把数字改小并落盘；
 * - 运行中的轮次跳过重扫，避免和它自己的 git/编译抢 IO。
 */

jest.unstable_mockModule('../../../main/aikernel/states/global.js', () => ({
    GlobalState: { getInstance: () => ({ taskManagerState: { createTask: jest.fn(), initHarness: jest.fn() } }) }
}));
jest.unstable_mockModule('../../../main/aikernel/agents/registry.js', () => ({
    AgentRegistry: { getMainAgent: () => ({ supportedModes: () => [{ id: 'unlimited' }] }) }
}));
jest.unstable_mockModule('../../../main/aikernel/planning/harness.js', () => ({
    extractAttemptCompletionResult: () => null
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

function setup(): { manager: InstanceType<typeof BenchmarkManager>; dataDir: string } {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-usage-'));
    const manager = new BenchmarkManager(dataDir);
    manager.init();
    return { manager, dataDir };
}

interface FakeCase {
    key: string;
    /** 用例目录里实际写入的字节数 */
    fileBytes: number;
    /** run.json 里记的账；不传表示这是没有记账字段的老记录 */
    usageBytes?: number;
}

/** 造一轮运行：run.json + cases/<key>/ 下的真实文件，返回 run 目录 */
function makeRun(dataDir: string, runId: string, status: string, cases: FakeCase[]): string {
    const runDir = path.join(dataDir, 'runs', runId);
    const records = cases.map((item) => {
        const caseDir = path.join(runDir, 'cases', item.key);
        fs.mkdirSync(caseDir, { recursive: true });
        fs.writeFileSync(path.join(caseDir, 'artifact.bin'), Buffer.alloc(item.fileBytes));
        return {
            key: item.key,
            trackId: 'track-a',
            trackName: 'A',
            caseId: item.key,
            name: item.key,
            weight: 1,
            status: 'done',
            score: 1,
            ratio: 1,
            reason: '',
            error: '',
            logError: '',
            runTaskId: null,
            verifyTaskId: null,
            startedAt: 1,
            finishedAt: 2,
            dir: path.join('cases', item.key),
            ...(item.usageBytes === undefined ? {} : { usageBytes: item.usageBytes })
        };
    });
    const run = {
        id: runId,
        datasetId: 'dataset-1',
        datasetName: 'Dataset',
        createdAt: 1,
        startedAt: 1,
        finishedAt: 2,
        status,
        concurrency: 1,
        runModel: 'm',
        verifyModel: 'v',
        tracks: ['track-a'],
        cases: records,
        summary: {
            total: records.length,
            pending: 0,
            running: 0,
            completed: records.length,
            failed: 0,
            stopped: 0,
            totalScore: records.length,
            maxScore: records.length,
            avgRatio: 1,
            avgDurationMs: 1
        }
    };
    fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(run));
    return runDir;
}

function readRunJson(runDir: string): { cases: Array<{ usageBytes?: number }> } {
    return JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
}

describe('listRuns 的磁盘占用', () => {
    test('usageBytes 是各用例记账值之和', async () => {
        const { manager, dataDir } = setup();
        makeRun(dataDir, 'run-sum', 'completed', [
            { key: 'a', fileBytes: 10, usageBytes: 100 },
            { key: 'b', fileBytes: 10, usageBytes: 20 }
        ]);
        expect(manager.listRuns()[0].usageBytes).toBe(120);
    });

    test('老记录没有记账字段时按 0 显示，读列表不触发扫盘', async () => {
        const { manager, dataDir } = setup();
        const runDir = makeRun(dataDir, 'run-legacy', 'completed', [
            { key: 'a', fileBytes: 1024 },
            { key: 'b', fileBytes: 2048 }
        ]);
        expect(manager.listRuns()[0].usageBytes).toBe(0);
        // 不做隐式回填：文件里仍然没有记账字段，补全只能靠手动刷新
        await new Promise((resolve) => setTimeout(resolve, 80));
        expect(readRunJson(runDir).cases.every((item) => typeof item.usageBytes !== 'number')).toBe(true);
    });
});

describe('rescanRunUsage', () => {
    test('删掉工作空间后重扫把数字改小并写回', async () => {
        const { manager, dataDir } = setup();
        const runDir = makeRun(dataDir, 'run-rescan', 'completed', [{ key: 'a', fileBytes: 1024, usageBytes: 9999 }]);
        // 模拟用户手动清掉工作空间产物
        fs.rmSync(path.join(runDir, 'cases', 'a', 'artifact.bin'));
        expect(manager.listRuns()[0].usageBytes).toBe(9999);
        await manager.rescanRunUsage();
        expect(manager.listRuns()[0].usageBytes).toBe(0);
        expect(readRunJson(runDir).cases[0].usageBytes).toBe(0);
    });

    test('跳过运行中的轮次', async () => {
        const { manager, dataDir } = setup();
        const runDir = makeRun(dataDir, 'run-busy', 'running', [{ key: 'a', fileBytes: 10, usageBytes: 999 }]);
        const scanned = await manager.rescanRunUsage();
        expect(scanned).toBe(0);
        expect(readRunJson(runDir).cases[0].usageBytes).toBe(999);
    });

    test('数字没变化时不重复写回', async () => {
        const { manager, dataDir } = setup();
        const runDir = makeRun(dataDir, 'run-same', 'completed', [{ key: 'a', fileBytes: 512, usageBytes: 512 }]);
        expect(await manager.rescanRunUsage()).toBe(0);
        expect(readRunJson(runDir).cases[0].usageBytes).toBe(512);
    });

    test('删除整轮后不再出现在列表里', async () => {
        const { manager, dataDir } = setup();
        makeRun(dataDir, 'run-drop', 'completed', [{ key: 'a', fileBytes: 16, usageBytes: 16 }]);
        expect(manager.listRuns()).toHaveLength(1);
        manager.deleteRun('run-drop');
        expect(manager.listRuns()).toHaveLength(0);
    });
});
