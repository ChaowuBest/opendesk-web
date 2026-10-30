import { jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 准备脚本的执行环境必须与任务终端/Agent 工具一致：
 * 设置里的全局环境变量（environ）与解释器隔离策略都要对 run-prepare.sh 生效，
 * 否则用户在设置里配的 PATH 不起作用，脚本会定位到另一个 python。
 */

const opendeskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-env-'));

type FakeSettingData = {
    environ?: Record<string, string>;
    cli_config?: Record<string, unknown>;
    network_config?: Record<string, unknown>;
};

let settingData: FakeSettingData = {};

jest.unstable_mockModule('../../../main/utils/setting.js', () => ({
    Setting: { getInstance: () => ({ getData: () => settingData }) },
    getOpendeskDirectory: () => opendeskDir
}));

jest.unstable_mockModule('../../../main/utils/logger.js', () => ({
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined }
}));

jest.unstable_mockModule('../../../main/aikernel/states/global.js', () => ({
    GlobalState: {
        getInstance: () => ({
            taskManagerState: {
                createTask: () => {
                    throw new Error('准备脚本阶段不应创建任务');
                }
            }
        })
    }
}));

jest.unstable_mockModule('../../../main/aikernel/agents/registry.js', () => ({
    AgentRegistry: { getMainAgent: () => ({ supportedModes: () => [{ id: 'unlimited' }] }) }
}));

jest.unstable_mockModule('../../../main/aikernel/planning/harness.js', () => ({
    extractAttemptCompletionResult: () => null
}));

/** 捕获引擎传给准备脚本的 env，并立即以失败收尾（不进入任务阶段） */
const capturedEnvs: NodeJS.ProcessEnv[] = [];
jest.unstable_mockModule('../../../main/applications/benchmark/script-runtime.js', () => ({
    runScript: (options: { env: NodeJS.ProcessEnv }) => {
        capturedEnvs.push(options.env);
        return Promise.resolve({ ok: false, code: 1, error: 'stop-here', logError: '' });
    },
    ScriptExecutionError: class extends Error {
        readonly logError: string;

        constructor(message: string, logError = '') {
            super(message);
            this.logError = logError;
        }
    }
}));

const { BenchmarkManager } = await import('../../../main/applications/benchmark/manager.js');
const { setRuntimeLocale } = await import('../../../locale/index.js');

/** 这些变量会被 buildChildProcessEnv 优先复用（如 NPM_CONFIG_PREFIX），清掉才能断言解释器目录前置 */
const ISOLATED_ENV_KEYS = [
    'NPM_CONFIG_PREFIX',
    'PIP_TARGET',
    'UV_CACHE_DIR',
    'UV_TOOL_DIR',
    'UV_TOOL_BIN_DIR',
    'VIRTUAL_ENV'
];
const savedEnv = new Map<string, string | undefined>();

beforeAll(() => {
    for (const key of ISOLATED_ENV_KEYS) {
        savedEnv.set(key, process.env[key]);
        delete process.env[key];
    }
});

afterAll(() => {
    for (const [key, value] of savedEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    fs.rmSync(opendeskDir, { recursive: true, force: true });
});

beforeEach(() => {
    capturedEnvs.length = 0;
    settingData = {};
    setRuntimeLocale('zh-CN');
});

afterEach(() => {
    for (const key of ISOLATED_ENV_KEYS) delete process.env[key];
    setRuntimeLocale(null);
});

/** 造一个只含单个用例（带 run-prepare.sh）的测评集并跑起来，返回捕获到的脚本 env */
async function runSingleCase(envSetting: FakeSettingData): Promise<NodeJS.ProcessEnv> {
    settingData = envSetting;

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-env-run-'));
    const datasetDir = path.join(dataDir, 'datasets', 'ds');
    const trackDir = path.join(datasetDir, 'tracks', 'track-a');
    const caseDir = path.join(trackDir, 'case-1');
    fs.mkdirSync(caseDir, { recursive: true });
    fs.writeFileSync(
        path.join(datasetDir, 'dataset.json'),
        JSON.stringify({ name: 'DS', tracks: [{ id: 'track-a', name: 'track-a' }] })
    );
    fs.writeFileSync(path.join(trackDir, 'track.json'), '{}');
    fs.writeFileSync(path.join(caseDir, 'case.json'), JSON.stringify({ name: 'case-1' }));
    fs.writeFileSync(path.join(caseDir, 'run-prepare.sh'), 'true');
    fs.writeFileSync(path.join(caseDir, 'run.md'), 'run');
    fs.writeFileSync(path.join(caseDir, 'verify.md'), 'verify');
    fs.writeFileSync(
        path.join(datasetDir, 'benchmark-meta.json'),
        JSON.stringify({
            id: 'ds',
            name: 'DS',
            description: '',
            homepage: '',
            version: '1.0',
            importedAt: Date.now(),
            caseCount: 1,
            tracks: [{ id: 'track-a', name: 'track-a', description: '', caseCount: 1 }]
        })
    );

    const manager = new BenchmarkManager(dataDir);
    manager.init();
    const runId = manager.startRun({ datasetId: 'ds', concurrency: 1, runModel: 'model-a', verifyModel: 'model-b' });

    const start = Date.now();
    while (capturedEnvs.length === 0) {
        if (Date.now() - start > 5000) throw new Error('准备脚本未被调用');
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    manager.stopRun(runId);
    fs.rmSync(dataDir, { recursive: true, force: true });
    return capturedEnvs[0];
}

describe('准备脚本执行环境', () => {
    test('设置里的全局环境变量（含 PATH）对准备脚本可见', async () => {
        const scriptPathDir = path.join(opendeskDir, 'custom-python');
        const env = await runSingleCase({
            environ: {
                BENCH_ENV_MARK: 'from-settings',
                PATH: [scriptPathDir, '/usr/bin'].join(path.delimiter)
            },
            cli_config: { use_isolated_python: false, inherit_venv: true },
            network_config: { no_ssl: false, use_proxy: 'none' }
        });

        expect(env.BENCH_ENV_MARK).toBe('from-settings');
        expect((env.PATH ?? '').split(path.delimiter)).toContain(scriptPathDir);
        // BENCH_* 用例上下文仍然完整注入
        expect(env.BENCH_CASE_ID).toBe('case-1');
        expect(env.BENCH_PHASE).toBe('run-prepare');
    });

    test('解释器隔离策略对准备脚本生效：剥离用户 venv 并前置内置解释器目录', async () => {
        const venvDir = path.join(opendeskDir, 'venv');
        process.env.VIRTUAL_ENV = venvDir;
        const env = await runSingleCase({
            environ: {
                PATH: [path.join(venvDir, 'bin'), '/usr/bin'].join(path.delimiter)
            },
            cli_config: { use_isolated_python: true, inherit_venv: false },
            network_config: { no_ssl: false, use_proxy: 'none' }
        });

        expect(env.VIRTUAL_ENV).toBeUndefined();
        const entries = (env.PATH ?? '').split(path.delimiter);
        expect(entries).not.toContain(path.join(venvDir, 'bin'));
        expect(entries).toContain('/usr/bin');
        const npmBinDir =
            process.platform === 'win32'
                ? path.join(opendeskDir, 'interpreters', 'npm-global')
                : path.join(opendeskDir, 'interpreters', 'npm-global', 'bin');
        expect(entries[0]).toBe(npmBinDir);
    });
});
