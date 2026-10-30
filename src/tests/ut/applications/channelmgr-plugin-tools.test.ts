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

const mockInstallPlugin = jest.fn<() => Promise<{ success: boolean; id?: string; error?: string }>>();
const mockUninstallPlugin = jest.fn<() => Promise<{ success: boolean; error?: string }>>();
const mockSetPluginEnabled = jest.fn<() => boolean>();
const mockReloadPluginHost = jest.fn<() => Promise<void>>();
const mockApplyPluginEnabledChange = jest.fn<() => Promise<void>>();

jest.unstable_mockModule('../../../main/applications/pluginmgr/index.js', () => ({
    installPlugin: mockInstallPlugin,
    uninstallPlugin: mockUninstallPlugin,
    listInstalledPlugins: jest.fn(),
    listVisiblePlugins: jest.fn(),
    setPluginEnabled: mockSetPluginEnabled,
    reloadPluginHost: mockReloadPluginHost,
    applyPluginEnabledChange: mockApplyPluginEnabledChange
}));

jest.unstable_mockModule('../../../main/applications/channelmgr/app.js', () => ({
    ChannelMgrApplication: class {},
    resolveChannelDisplayName: (id: string) => id
}));

jest.unstable_mockModule('../../../main/applications/channelmgr/pairing.js', () => ({
    getPendingRequests: jest.fn(),
    getApprovedUsers: jest.fn(),
    approveUser: jest.fn(),
    revokeUser: jest.fn(),
    removePairingRequest: jest.fn()
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

const { InstallChannelPluginTool, UninstallChannelPluginTool, ToggleChannelPluginTool } =
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
        expect(mockReloadPluginHost).not.toHaveBeenCalled();
        expect(app.reloadChannels).not.toHaveBeenCalled();
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
