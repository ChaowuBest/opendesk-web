import { jest } from '@jest/globals';
import type { SpawnSyncReturns } from 'child_process';
import os from 'node:os';
import path from 'node:path';

// setting.ts 含 create(import.meta.url) 写法，ts-jest 编译为 CJS 后与 require 标识符冲突，mock 掉
jest.unstable_mockModule('../../../main/utils/setting.js', () => {
    // 用真实系统临时目录而非硬编码 POSIX /tmp：硬编码路径在 Windows 解析到
    // 当前盘根（宿主 D:\tmp 可写，沙箱卷合成根 Z:\tmp 只读）导致沙箱内 mkdir 失败。
    const tmp = path.join(os.tmpdir(), 'opendesk-test');
    return {
        Setting: class {
            static afterSetDataCallbacks: unknown[] = [];
            static getInstance() {
                return {
                    data: { locale: 'zh-CN' },
                    // TerminalApplication 构造时通过 shell 选择读取 task_config
                    getData: () => ({ task_config: {} }),
                    getEffectiveWorkspace: () => '/'
                };
            }
        },
        getOpendeskDirectory: () => tmp,
        getLogDirectory: () => path.join(tmp, 'logs'),
        getTaskToolResultDirectory: () => path.join(tmp, 'tool-results'),
        getTrashRootDirectory: () => path.join(tmp, 'trash'),
        getTaskTrashDirectory: (taskId: string) => path.join(tmp, 'trash', taskId)
    };
});

jest.unstable_mockModule('../../../main/aikernel/states/global.js', () => ({
    GlobalState: class {
        static getCurrentInstance() {
            return undefined;
        }
    }
}));

// 通过 fs/child_process mock 控制 findOpenHarmonyZsh 的探测结果
const existsSyncMock = jest.fn((p: unknown) => typeof p === 'string' && String(p).endsWith('/zsh'));

jest.unstable_mockModule('fs', () => {
    const fsMock = {
        existsSync: (p: unknown) => existsSyncMock(p),
        accessSync: () => undefined,
        mkdirSync: () => undefined,
        constants: { X_OK: 1 }
    };
    return { ...fsMock, default: fsMock };
});

const spawnSyncMock = jest.fn(() => ({ status: 0, error: undefined }) as SpawnSyncReturns<Buffer>);

const childProcessMock = {
    execFile: jest.fn(),
    execFileSync: jest.fn(),
    spawn: jest.fn(),
    spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
    execSync: jest.fn()
};
jest.unstable_mockModule('child_process', () => childProcessMock);
jest.unstable_mockModule('node:child_process', () => childProcessMock);

// bash 回退路径来自 local-runtime state，mock 为可控；默认 null（无门控限制，也不提供 bash 路径）
const localRuntimeStateMock = jest.fn((): unknown => null);

jest.unstable_mockModule('../../../platforms/bridges/harmonyos/local-runtime.js', () => ({
    getHarmonyLocalRuntimeState: () => localRuntimeStateMock(),
    // 真实 gate 的简化版：tablet 一律不可用，PC 由具体测试通过 state 控制可用性
    getHarmonyLocalRuntimeFeatureAvailability: (_feature: string, state: unknown) =>
        (state as { variant?: string } | null)?.variant === 'tablet'
            ? { available: false, reason: 'tablet-local-runtime-disabled', missing: [] }
            : { available: true, reason: null, missing: [] }
}));

const { TerminalApplication } = await import('../../../main/applications/terminal/app.js');

describe('TerminalApplication toolset on OpenHarmony', () => {
    const originalPlatform = process.platform;

    beforeEach(() => {
        Object.defineProperty(process, 'platform', { value: 'openharmony', configurable: true });
        existsSyncMock.mockReset();
        existsSyncMock.mockImplementation((p: unknown) => typeof p === 'string' && String(p).endsWith('/zsh'));
        spawnSyncMock.mockClear();
        spawnSyncMock.mockImplementation(() => ({ status: 0, error: undefined }) as SpawnSyncReturns<Buffer>);
        localRuntimeStateMock.mockReset();
        localRuntimeStateMock.mockImplementation((): unknown => null);
    });

    afterEach(() => {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    });

    test('registers ExecuteZshTool when zsh is runnable', async () => {
        const app = new TerminalApplication();
        const toolsets = await app.getToolsets();
        const toolset = toolsets[0];

        expect(toolset.hasTool('executeZsh')).toBe(true);
        expect(toolset.hasTool('executeBash')).toBe(false);
        expect(toolset.hasTool('checkShellStatus')).toBe(true);
    });

    test('registers no shell tool on Harmony tablet even when zsh is runnable', async () => {
        localRuntimeStateMock.mockImplementation(() => ({
            variant: 'tablet',
            capabilities: { zsh: false, bash: false, node: false, python: false, uv: false },
            commands: {},
            sources: {},
            missing: ['zsh', 'bash', 'node', 'python', 'uv'],
            status: 'tablet-disabled'
        }));

        const app = new TerminalApplication();
        const toolsets = await app.getToolsets();

        expect(toolsets).toHaveLength(0);
        expect(spawnSyncMock).not.toHaveBeenCalled();
    });

    test('registers ExecuteBashTool when state provides no zsh but a verified HNP bash', async () => {
        // zsh 探测失败（如 "Error relocating"）→ state 快照中无 zsh；HNP bash 由 local-runtime state 提供
        existsSyncMock.mockImplementation((p: unknown) => typeof p === 'string' && String(p).endsWith('/bash'));
        spawnSyncMock.mockImplementation((cmd: string) =>
            cmd === '/usr/bin/zsh'
                ? ({ status: 127, error: undefined } as SpawnSyncReturns<Buffer>)
                : ({ status: 0, error: undefined } as SpawnSyncReturns<Buffer>)
        );
        localRuntimeStateMock.mockImplementation(() => ({
            variant: 'pc',
            capabilities: { zsh: false, bash: true, node: false, python: false, uv: false },
            commands: { bash: '/data/service/hnp/bin/bash' },
            missing: [],
            status: 'available'
        }));

        const app = new TerminalApplication();
        const toolsets = await app.getToolsets();
        const toolset = toolsets[0];

        expect(toolset.hasTool('executeZsh')).toBe(false);
        expect(toolset.hasTool('executeBash')).toBe(true);
        expect(toolset.hasTool('checkShellStatus')).toBe(true);
    });

    test('registers bash when zsh is not runnable and state is absent', async () => {
        // CLI 无宿主快照时也探测本机 bash，作为 zsh 的回退。
        existsSyncMock.mockImplementation((p: unknown) => typeof p === 'string' && String(p).endsWith('/bash'));
        spawnSyncMock.mockImplementation((cmd: string) =>
            cmd === '/usr/bin/zsh'
                ? ({ status: 127, error: undefined } as SpawnSyncReturns<Buffer>)
                : ({ status: 0, error: undefined } as SpawnSyncReturns<Buffer>)
        );

        const app = new TerminalApplication();
        const toolsets = await app.getToolsets();

        expect(toolsets).toHaveLength(1);
        expect(toolsets[0].hasTool('executeBash')).toBe(true);
    });

    test('registers no shell tool when neither zsh nor bash is available', async () => {
        // zsh 运行验证失败、local-runtime state 未提供 bash 路径
        existsSyncMock.mockImplementation(() => false);
        spawnSyncMock.mockImplementation(() => ({ status: 127, error: undefined }) as SpawnSyncReturns<Buffer>);

        const app = new TerminalApplication();
        const toolsets = await app.getToolsets();

        // 无执行工具时不注册 checkShellStatus，整个 toolset 为空
        expect(toolsets).toHaveLength(0);
    });
});
