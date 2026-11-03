import { jest } from '@jest/globals';

/**
 * 运行占用（工作空间磁盘用量）的对外语义：
 * - 跑着的轮次返回 null（不扫盘，避免和用例自己的 git/编译抢 IO）；
 * - 已结束的轮次量的是整个 runs/<runId> 目录，界面文案才能和目录实际大小对上；
 * - 目录不存在 / runId 缺失按 0 算，不能抛；
 * - 5 分钟缓存内的重复查询不重新扫盘，手动刷新清缓存后才重算。
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

/** 造一轮运行：run.json + cases/ 下若干文件，返回这轮占用的真实字节数 */
function makeRun(dataDir: string, runId: string, status: string, caseBytes: number[]): number {
    const runDir = path.join(dataDir, 'runs', runId);
    fs.mkdirSync(path.join(runDir, 'cases', 'track-a', 'case-1'), { recursive: true });
    const runJson = JSON.stringify({ id: runId, status });
    fs.writeFileSync(path.join(runDir, 'run.json'), runJson);
    let total = Buffer.byteLength(runJson);
    caseBytes.forEach((size, index) => {
        fs.writeFileSync(path.join(runDir, 'cases', 'track-a', 'case-1', `file-${index}.bin`), Buffer.alloc(size));
        total += size;
    });
    return total;
}

describe('getRunWorkspaceUsage', () => {
    test('已结束的轮次返回整个 run 目录的字节数（含 run.json）', async () => {
        const { manager, dataDir } = setup();
        const expected = makeRun(dataDir, 'run-done', 'finished', [1024, 2048]);
        await expect(manager.getRunWorkspaceUsage('run-done')).resolves.toBe(expected);
    });

    test('运行中的轮次不扫盘，返回 null', async () => {
        const { manager, dataDir } = setup();
        makeRun(dataDir, 'run-live', 'running', [1024]);
        await expect(manager.getRunWorkspaceUsage('run-live')).resolves.toBeNull();
    });

    test('目录不存在时返回 0，不抛', async () => {
        const { manager } = setup();
        await expect(manager.getRunWorkspaceUsage('run-missing')).resolves.toBe(0);
    });

    test('非法 runId 不会拼到 runsDir 之外', async () => {
        const { manager } = setup();
        await expect(manager.getRunWorkspaceUsage('../escape')).resolves.toBe(0);
    });

    test('缓存期内不重新扫盘，清缓存后拿到新值', async () => {
        const { manager, dataDir } = setup();
        makeRun(dataDir, 'run-cache', 'finished', [512]);
        const first = await manager.getRunWorkspaceUsage('run-cache');
        // 追加文件后，缓存期内仍是旧值
        fs.writeFileSync(
            path.join(dataDir, 'runs', 'run-cache', 'cases', 'track-a', 'case-1', 'extra.bin'),
            Buffer.alloc(4096)
        );
        await expect(manager.getRunWorkspaceUsage('run-cache')).resolves.toBe(first);
        manager.clearRunWorkspaceUsageCache();
        await expect(manager.getRunWorkspaceUsage('run-cache')).resolves.toBe(first + 4096);
    });
});
