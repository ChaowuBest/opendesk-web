import { jest, describe, test, expect, beforeEach } from '@jest/globals';

/**
 * 回归测试：installChannelPlugin / uninstallChannelPlugin / toggleChannelPlugin
 * 在修改插件注册表后，必须先让插件宿主应用变更（reloadPluginHost 全量重载或
 * toggle 的 applyPluginEnabledChange 差量启停，使 ctx.channels.register 执行、
 * channel 出现在宿主运行时），再 reloadChannels()/syncChannelsWithPluginHost()
 * 收集渠道。修复前缺少宿主侧变更，导致新安装的插件虽然已写入注册表，
 * 但 GUI 系统设置页 / 运行时均收集不到对应 channel。
 */

// ── mock 模块（unstable_mockModule 不提升，变量需先初始化） ─────────────────

const mockInstallPlugin =
    jest.fn<() => Promise<{ success: boolean; id?: string; error?: string; errorCode?: string }>>();
const mockUninstallPlugin = jest.fn<() => Promise<{ success: boolean; error?: string }>>();
const mockIsPluginEnabledFixed = jest.fn<() => boolean>();
const mockSetPluginEnabled = jest.fn<() => boolean>();
const mockReloadPluginHost = jest.fn<() => Promise<void>>();
const mockApplyPluginEnabledChange = jest.fn<() => Promise<void>>();
const mockListVisiblePlugins = jest.fn<() => unknown[]>();
// 与真实实现同口径：宿主版本不满足时给出带版本范围的升级引导，其余错误走通用文案
const mockFormatPluginInstallError = jest.fn<(result: { errorCode?: string }) => string>((result) =>
    result?.errorCode === 'host_version_too_old'
        ? '该插件要求的 OpenDesk 版本高于当前版本，无法安装。请将 OpenDesk 升级到最新版本后重试。'
        : '插件安装失败，请查看应用日志了解详细信息。'
);
const mockFormatPluginInstallException = jest.fn<(error: unknown) => string | undefined>((error) => {
    const message = typeof error === 'string' ? error : error instanceof Error ? error.message : String(error);
    return message.startsWith('plugin.install_host_version:')
        ? '该插件需要 OpenDesk ≥ 99.0.0，当前版本 0.4.1 不满足要求。请将 OpenDesk 升级到最新版本后重试。'
        : undefined;
});

jest.unstable_mockModule('../../../main/applications/pluginmgr/index.js', () => ({
    installPlugin: mockInstallPlugin,
    uninstallPlugin: mockUninstallPlugin,
    listInstalledPlugins: jest.fn(),
    listVisiblePlugins: mockListVisiblePlugins,
    isPluginEnabledFixed: mockIsPluginEnabledFixed,
    setPluginEnabled: mockSetPluginEnabled,
    reloadPluginHost: mockReloadPluginHost,
    applyPluginEnabledChange: mockApplyPluginEnabledChange,
    formatPluginInstallError: mockFormatPluginInstallError,
    formatPluginInstallException: mockFormatPluginInstallException
}));

jest.unstable_mockModule('../../../main/applications/channelmgr/app.js', () => ({
    ChannelMgrApplication: class {},
    resolveChannelDisplayName: (id: string) => id
}));

jest.unstable_mockModule('../../../main/applications/channelmgr/feishu-auth.js', () => ({
    feishuAuthInit: jest.fn(),
    feishuAuthBegin: jest.fn(),
    feishuAuthPoll: jest.fn()
}));

jest.unstable_mockModule('../../../main/utils/logger.js', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));

// BaseTool 使用轻量实现，仅覆盖构造 / setExecutor / execute 语义
jest.unstable_mockModule('../../../main/aikernel/tool.js', () => {
    class MockBaseTool {
        name: string;
        description: string;
        params: any;
        executor?: (args: any) => Promise<string>;
        constructor(name: string, description: string, params: any) {
            this.name = name;
            this.description = description;
            this.params = params;
        }
        setExecutor(executor: (args: any) => Promise<string>) {
            this.executor = executor;
            return this;
        }
        async execute(args: unknown): Promise<{ status: string; result: string }> {
            const parsed = this.params.safeParse(args);
            if (!parsed.success) return { status: 'error', result: 'validation failed' };
            return { status: 'success', result: await this.executor!(parsed.data) };
        }
    }
    return { BaseTool: MockBaseTool, ToolResult: class {} };
});

jest.unstable_mockModule('../../../main/aikernel/messages.js', () => ({
    ToolCall: class {},
    AssistantMessage: class {}
}));

// ── 动态导入（mock 注册后执行） ─────────────────────────────────────────────

const { InstallChannelPluginTool, UninstallChannelPluginTool, ToggleChannelPluginTool, ListChannelPluginsTool } =
    (await import('../../../main/applications/channelmgr/tools.js')) as any;

interface FakeApp {
    reloadChannels: ReturnType<typeof jest.fn>;
    syncChannelsWithPluginHost: ReturnType<typeof jest.fn>;
}

function makeApp(): FakeApp {
    return {
        reloadChannels: jest.fn<() => Promise<void>>(async () => {}),
        syncChannelsWithPluginHost: jest.fn<(id?: string, operation?: string) => Promise<void>>(async () => {})
    };
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('channelmgr 插件管理工具的宿主重载顺序', () => {
    test('installChannelPlugin 成功后先 reloadPluginHost 再 reloadChannels', async () => {
        mockInstallPlugin.mockResolvedValue({ success: true, id: 'my-channel' });
        const app = makeApp();
        const tool = new InstallChannelPluginTool(app);

        const result = await tool.execute({ spec: 'some-channel-plugin' });

        expect(result.status).toBe('success');
        expect(mockInstallPlugin).toHaveBeenCalledWith('some-channel-plugin');
        expect(mockReloadPluginHost).toHaveBeenCalledTimes(1);
        expect(app.reloadChannels).toHaveBeenCalledTimes(1);
        expect(mockReloadPluginHost.mock.invocationCallOrder[0]).toBeLessThan(
            app.reloadChannels.mock.invocationCallOrder[0]
        );
    });

    test('installChannelPlugin 安装失败时不触发宿主重载', async () => {
        mockInstallPlugin.mockResolvedValue({ success: false, error: 'install error' });
        const app = makeApp();
        const tool = new InstallChannelPluginTool(app);

        const result = await tool.execute({ spec: 'bad-plugin' });

        expect(result.result).toContain('插件安装失败');
        // 非宿主版本失败保留底层原因，而不是被通用文案吞掉
        expect(result.result).toContain('install error');
        expect(mockReloadPluginHost).not.toHaveBeenCalled();
        expect(app.reloadChannels).not.toHaveBeenCalled();
    });

    test('installChannelPlugin 宿主版本不满足时给出带版本范围的升级引导', async () => {
        mockInstallPlugin.mockResolvedValue({
            success: false,
            error: 'plugin.install_host_version:too_old:≥ 99.0.0:0.4.1',
            errorCode: 'host_version_too_old'
        });
        const app = makeApp();
        const tool = new InstallChannelPluginTool(app);

        const result = await tool.execute({ spec: 'future-plugin' });

        // 与 CLI / 插件工具同一段文案：带插件要求的范围与当前宿主版本
        expect(result.result).toContain('需要 OpenDesk ≥ 99.0.0');
        expect(result.result).toContain('当前版本 0.4.1');
        expect(result.result).not.toContain('plugin.install_host_version');
        expect(mockReloadPluginHost).not.toHaveBeenCalled();
    });

    test('uninstallChannelPlugin 成功后先 reloadPluginHost 再 reloadChannels', async () => {
        mockUninstallPlugin.mockResolvedValue({ success: true });
        const app = makeApp();
        const tool = new UninstallChannelPluginTool(app);

        const result = await tool.execute({ id: 'my-channel' });

        expect(result.status).toBe('success');
        expect(mockUninstallPlugin).toHaveBeenCalledWith('my-channel');
        expect(mockReloadPluginHost).toHaveBeenCalledTimes(1);
        expect(app.reloadChannels).toHaveBeenCalledTimes(1);
        expect(mockReloadPluginHost.mock.invocationCallOrder[0]).toBeLessThan(
            app.reloadChannels.mock.invocationCallOrder[0]
        );
    });

    test('toggleChannelPlugin 启用成功后差量应用启停再同步渠道', async () => {
        mockSetPluginEnabled.mockReturnValue(true);
        const app = makeApp();
        const tool = new ToggleChannelPluginTool(app as any);

        const result = await tool.execute({ id: 'my-channel', enabled: true });

        expect(result.status).toBe('success');
        expect(mockSetPluginEnabled).toHaveBeenCalledWith('my-channel', true);
        expect(mockApplyPluginEnabledChange).toHaveBeenCalledTimes(1);
        expect(app.syncChannelsWithPluginHost).toHaveBeenCalledWith('my-channel', 'enable');
        expect(mockApplyPluginEnabledChange.mock.invocationCallOrder[0]).toBeLessThan(
            (app.syncChannelsWithPluginHost as any).mock.invocationCallOrder[0]
        );
    });

    test('toggleChannelPlugin 未找到插件时不触发宿主重载', async () => {
        mockSetPluginEnabled.mockReturnValue(false);
        const app = makeApp();
        const tool = new ToggleChannelPluginTool(app as any);

        const result = await tool.execute({ id: 'missing', enabled: true });

        expect(result.result).toContain('未找到插件');
        expect(mockApplyPluginEnabledChange).not.toHaveBeenCalled();
        expect(app.syncChannelsWithPluginHost).not.toHaveBeenCalled();
    });

    test('toggleChannelPlugin 拒绝修改清单固定启停的插件', async () => {
        // mockReturnValueOnce：clearAllMocks 不会清除 mockReturnValue，避免污染后续用例
        mockIsPluginEnabledFixed.mockReturnValueOnce(true);
        const app = makeApp();
        const tool = new ToggleChannelPluginTool(app as any);

        const result = await tool.execute({ id: 'opencodego', enabled: false });

        expect(result.result).toContain('无法修改');
        expect(mockSetPluginEnabled).not.toHaveBeenCalled();
        expect(mockApplyPluginEnabledChange).not.toHaveBeenCalled();
        expect(app.syncChannelsWithPluginHost).not.toHaveBeenCalled();
    });

    test('listChannelPlugins 标明由清单固定启停的插件', async () => {
        mockListVisiblePlugins.mockReturnValueOnce([
            {
                id: 'opencodego',
                source: 'builtin',
                path: '/dist/plugins/opencodego',
                enabled: true,
                options: {},
                system: true
            },
            { id: 'feishu', source: 'builtin', path: '/dist/plugins/feishu', enabled: true, options: {}, system: false }
        ]);
        const tool = new ListChannelPluginsTool();

        const result = await tool.execute({});

        expect(result.status).toBe('success');
        expect(result.result).toContain('[由清单固定启停]');
        const feishuLine = result.result.split('\n').find((line) => line.includes('feishu'));
        expect(feishuLine).toBeDefined();
        expect(feishuLine).not.toContain('由清单固定启停');
    });

    test('toggleChannelPlugin 启用失败时回滚注册表且不同步渠道', async () => {
        mockSetPluginEnabled.mockReturnValue(true);
        mockApplyPluginEnabledChange.mockRejectedValueOnce(new Error('plugin.activate_failed'));
        const app = makeApp();
        const tool = new ToggleChannelPluginTool(app as any);

        const result = await tool.execute({ id: 'broken-channel', enabled: true });

        expect(result.result).toContain('插件启用失败');
        // 注册表回滚为禁用，避免留下「已启用但未生效」的状态
        expect(mockSetPluginEnabled).toHaveBeenLastCalledWith('broken-channel', false);
        expect(app.syncChannelsWithPluginHost).not.toHaveBeenCalled();
    });
});

describe('setChannelConfig 不覆盖账号运行时设置', () => {
    interface FakeConfigApp {
        saved: Record<string, any>;
        getConfig: () => Record<string, any>;
        setConfig: (next: Record<string, any>) => void;
        reloadChannels: ReturnType<typeof jest.fn>;
    }

    function makeConfigApp(initial: Record<string, any>): FakeConfigApp {
        const app: FakeConfigApp = {
            saved: initial,
            getConfig: () => app.saved,
            setConfig: (next) => {
                app.saved = next;
            },
            reloadChannels: jest.fn<() => Promise<void>>(async () => {})
        };
        return app;
    }

    test('替换渠道连接参数时保留用户维护的 accountRuntime（含分发策略）', async () => {
        const { SetChannelConfigTool } = await import('../../../main/applications/channelmgr/tools.js');
        const accountRuntime = {
            'bot-1': { workspace: '/ws', dispatchPolicy: { mode: 'sticky', timeoutMinutes: 1440 } }
        };
        const app = makeConfigApp({ feishu: { appId: 'old', accountRuntime } });
        const tool = new SetChannelConfigTool(app as any);

        const result: any = await tool.execute({ channelId: 'feishu', config: { appId: 'new', appSecret: 's' } });

        expect(result.status).toBe('success');
        expect(app.saved.feishu).toEqual({ appId: 'new', appSecret: 's', accountRuntime });
    });

    test('调用方显式给出 accountRuntime 时以它为准', async () => {
        const { SetChannelConfigTool } = await import('../../../main/applications/channelmgr/tools.js');
        const app = makeConfigApp({ feishu: { accountRuntime: { 'bot-1': { workspace: '/old' } } } });
        const tool = new SetChannelConfigTool(app as any);

        await tool.execute({ channelId: 'feishu', config: { accountRuntime: { 'bot-2': { model: 'x' } } } });

        expect(app.saved.feishu.accountRuntime).toEqual({ 'bot-2': { model: 'x' } });
    });
});
