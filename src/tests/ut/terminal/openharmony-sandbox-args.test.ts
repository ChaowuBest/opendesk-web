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

    test('回收站排除清单内置 /data/storage/el2，与宿主传入目录合并去重', async () => {
        const launch = await prepareOpenHarmonySandbox({
            shellPath: '/usr/bin/zsh',
            shellArgs: ['-c', 'pwd'],
            command: 'pwd',
            cwd: '/storage/Users/currentUser/workspace',
            taskState: {
                task_id: 'task_oh_05',
                harnessContext: { permission: { getRules: () => undefined } },
                getWorkspace: () => '/storage/Users/currentUser/workspace'
            } as any,
            deleteToTrash: true,
            trashDir: '/tmp/od/trash/task_oh_05',
            trashExcludeDirs: ['/tmp', '/data/storage/el2']
        });
        const args = launch!.args;
        const excluded = args.filter((_, index) => args[index - 1] === '--trash-exclude');
        // 应用沙箱根整体排除：el2 下删除均不入回收站
        expect(excluded).toContain('/data/storage/el2');
        // 宿主清单与内置项重复时只出现一次（原生层条目长度有限）
        expect(excluded.filter((dir) => dir === '/data/storage/el2')).toHaveLength(1);
        expect(excluded).toContain('/tmp');
        expect(args.indexOf('--trash-exclude')).toBeLessThan(args.indexOf('--'));
    });

    test('未传宿主排除清单时仍注入内置 /data/storage/el2', async () => {
        const launch = await prepareOpenHarmonySandbox({
            shellPath: '/usr/bin/zsh',
            shellArgs: ['-c', 'pwd'],
            command: 'pwd',
            cwd: '/storage/Users/currentUser/workspace',
            taskState: {
                task_id: 'task_oh_06',
                harnessContext: { permission: { getRules: () => undefined } },
                getWorkspace: () => '/storage/Users/currentUser/workspace'
            } as any,
            deleteToTrash: true,
            trashDir: '/tmp/od/trash/task_oh_06'
        });
        const args = launch!.args;
        const excluded = args.filter((_, index) => args[index - 1] === '--trash-exclude');
        expect(excluded).toEqual(['/data/storage/el2']);
    });

    test('宿主传入的相对路径不下发（原生层会因此拒绝启动）', async () => {
        const launch = await prepareOpenHarmonySandbox({
            shellPath: '/usr/bin/zsh',
            shellArgs: ['-c', 'pwd'],
            command: 'pwd',
            cwd: '/storage/Users/currentUser/workspace',
            taskState: {
                task_id: 'task_oh_08',
                harnessContext: { permission: { getRules: () => undefined } },
                getWorkspace: () => '/storage/Users/currentUser/workspace'
            } as any,
            deleteToTrash: true,
            trashDir: '/tmp/od/trash/task_oh_08',
            trashExcludeDirs: ['tmp/relative', ' ', '/tmp']
        });
        const args = launch!.args;
        const excluded = args.filter((_, index) => args[index - 1] === '--trash-exclude');
        expect(excluded).toEqual(['/data/storage/el2', '/tmp']);
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

    test('未启用 deleteToTrash 时不注入排除清单（原生层不会走删除分流）', async () => {
        const launch = await prepareOpenHarmonySandbox({
            shellPath: '/usr/bin/zsh',
            shellArgs: ['-c', 'pwd'],
            command: 'pwd',
            cwd: '/storage/Users/currentUser/workspace',
            taskState: {
                task_id: 'task_oh_07',
                harnessContext: { permission: { getRules: () => undefined } },
                getWorkspace: () => '/storage/Users/currentUser/workspace'
            } as any,
            trashDir: '/tmp/od/trash/task_oh_07',
            trashExcludeDirs: ['/tmp']
        });
        const args = launch!.args;
        expect(args).not.toContain('--trash-exclude');
        expect(args).not.toContain('/data/storage/el2');
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
