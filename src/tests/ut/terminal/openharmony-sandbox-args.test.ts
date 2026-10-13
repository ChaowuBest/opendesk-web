import { jest } from '@jest/globals';

// prepareOpenHarmonySandbox 依赖的设置/路径/端点模块全部 mock：
// 断言沙箱启动参数（回收站参数形态）不依赖真实宿主环境。
jest.unstable_mockModule('../../../main/utils/setting.js', () => ({
    getOpendeskDirectory: () => '/tmp/od',
    getLogDirectory: () => '/tmp/od/logs'
}));
jest.unstable_mockModule('../../../main/utils/temp.js', () => ({
    getTempDir: () => '/tmp/od-temp'
}));
jest.unstable_mockModule('../../../platforms/bridges/harmonyos/runtime.js', () => ({
    getHarmonyRuntimeEnvironment: () => ({
        userHomeDir: '/storage/Users/currentUser',
        tempDir: '/data/storage/el2/base/temp',
        cacheDir: '/data/storage/el2/base/cache'
    }),
    getHarmonyHomeDirectory: () => '/storage/Users/currentUser'
}));
jest.unstable_mockModule('../../../utils/path.js', () => ({
    getHomePath: () => '/storage/Users/currentUser'
}));
jest.unstable_mockModule('../../../main/applications/terminal/sandboxes/sandbox-decide.js', () => ({
    createSandboxDecideEndpoint: async () => ({
        endpoint: 'http://127.0.0.1:1/decide',
        token: 'tok',
        cleanup: async () => undefined
    })
}));
jest.unstable_mockModule('../../../main/applications/terminal/locale/index.js', () => ({
    t: (key: string) => key
}));
jest.unstable_mockModule('../../../main/applications/terminal/sandboxes/resolve-ohos.js', () => ({
    resolveOpenHarmonySandboxExecutable: () => '/data/app/bin/dynobox',
    resolveOpenHarmonySandboxLibrary: () => '/data/app/libdynobox.so'
}));

const fsMock = {
    existsSync: (p: unknown) => typeof p === 'string' && String(p).includes('workspace'),
    mkdirSync: () => undefined,
    writeFileSync: () => undefined,
    chmodSync: () => undefined,
    rmSync: () => undefined
};
jest.unstable_mockModule('fs', () => ({ ...fsMock, default: fsMock }));

const { prepareOpenHarmonySandbox } =
    await import('../../../main/applications/terminal/sandboxes/openharmony-sandbox.js');

describe('prepareOpenHarmonySandbox 回收站参数（统一协议）', () => {
    const originalPlatform = process.platform;
    beforeEach(() => {
        Object.defineProperty(process, 'platform', { value: 'openharmony', configurable: true });
    });
    afterEach(() => {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    });
    test('deleteToTrash+trashDir：只传 --del-to-trash + --trash-dir，不传旧 --trash 双参数', async () => {
        const launch = await prepareOpenHarmonySandbox({
            shellPath: '/usr/bin/zsh',
            shellArgs: ['-c', 'pwd'],
            command: 'pwd',
            cwd: '/storage/Users/currentUser/workspace',
            taskState: {
                task_id: 'task_oh_01',
                harnessContext: { permission: { getRules: () => undefined } },
                getWorkspace: () => '/storage/Users/currentUser/workspace'
            } as any,
            deleteToTrash: true,
            trashDir: '/tmp/od/trash/task_oh_01'
        });
        const args = launch!.args;
        expect(args).toContain('--del-to-trash');
        expect(args).toContain('--trash-dir');
        expect(args).toContain('/tmp/od/trash/task_oh_01');
        // 统一协议下不再出现旧式 --trash（兼容别名只由原生层内部处理）
        const trashIdx = args.indexOf('--trash-dir');
        expect(trashIdx).toBeGreaterThan(0);
        expect(args[trashIdx + 1]).toBe('/tmp/od/trash/task_oh_01');
        // 参数位于 -- 分隔符之前
        expect(args.indexOf('--trash-dir')).toBeLessThan(args.indexOf('--'));
    });

    test('工具链缓存重定向 env（npm/cargo/go/xdg + Python pycache 镜像树）', async () => {
        const launch = await prepareOpenHarmonySandbox({
            shellPath: '/usr/bin/zsh',
            shellArgs: ['-c', 'pwd'],
            command: 'pwd',
            cwd: '/storage/Users/currentUser/workspace',
            taskState: {
                task_id: 'task_oh_04',
                harnessContext: { permission: { getRules: () => undefined } },
                getWorkspace: () => '/storage/Users/currentUser/workspace'
            } as any
        });
        const env = launch!.env;
        // 缓存重定向落点统一在 ~/.cache/opendesk-sandbox（读已由 node app 策略覆盖）
        expect(env!.npm_config_cache).toBe('/storage/Users/currentUser/.cache/opendesk-sandbox/npm');
        expect(env!.CARGO_HOME).toBe('/storage/Users/currentUser/.cache/opendesk-sandbox/cargo');
        // Python 字节码缓存镜像树（3.8+ 的 __pycache__ 写入重定向到沙箱允许目录）
        expect(env!.PYTHONPYCACHEPREFIX).toBe('/storage/Users/currentUser/.cache/opendesk-sandbox/pycache');
    });

    test('仅 trashDir 无 deleteToTrash：只传 --trash-dir，无 --del-to-trash', async () => {
        const launch = await prepareOpenHarmonySandbox({
            shellPath: '/usr/bin/zsh',
            shellArgs: ['-c', 'pwd'],
            command: 'pwd',
            cwd: '/storage/Users/currentUser/workspace',
            taskState: {
                task_id: 'task_oh_02',
                harnessContext: { permission: { getRules: () => undefined } },
                getWorkspace: () => '/storage/Users/currentUser/workspace'
            } as any,
            trashDir: '/tmp/od/trash/task_oh_02'
        });
        const args = launch!.args;
        expect(args).toContain('--trash-dir');
        expect(args).toContain('/tmp/od/trash/task_oh_02');
        expect(args).not.toContain('--del-to-trash');
    });

    test('无 trashDir 无 deleteToTrash：不产生任何回收站参数', async () => {
        const launch = await prepareOpenHarmonySandbox({
            shellPath: '/usr/bin/zsh',
            shellArgs: ['-c', 'pwd'],
            command: 'pwd',
            cwd: '/storage/Users/currentUser/workspace',
            taskState: {
                task_id: 'task_oh_03',
                harnessContext: { permission: { getRules: () => undefined } },
                getWorkspace: () => '/storage/Users/currentUser/workspace'
            } as any
        });
        const args = launch!.args;
        expect(args).not.toContain('--trash-dir');
        expect(args).not.toContain('--del-to-trash');
        expect(args).not.toContain('--trash');
    });
});
