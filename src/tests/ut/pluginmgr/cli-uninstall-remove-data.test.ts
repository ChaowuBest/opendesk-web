import { Command } from 'commander';
import { jest } from '@jest/globals';

/**
 * CLI 卸载命令的数据目录开关：`opendesk plugins uninstall <id> [--remove-data]`。
 * 这里只验证参数到 uninstallPlugin 的映射，落盘行为由 manager 的单测覆盖。
 */

const mockUninstallPlugin = jest.fn<(id: string, options?: { removeData?: boolean }) => Promise<unknown>>(async () => ({
    success: true
}));

describe('pluginmgr CLI uninstall --remove-data', () => {
    let registerPluginsCommand: typeof import('../../../main/tui/subcommands/plugins.js').registerPluginsCommand;

    beforeAll(async () => {
        jest.unstable_mockModule('../../../main/applications/pluginmgr/index.js', () => ({
            disposePluginHost: async () => undefined,
            initializePluginHost: async () => undefined,
            reloadPluginHost: async () => undefined,
            getPluginHost: () => ({ listChannels: () => [], listTools: () => [], listHooks: () => [] }),
            getPluginRuntimeEntry: () => undefined,
            setPluginOptions: jest.fn(),
            setPluginGrantedCapabilities: jest.fn(),
            OPENDESK_PLUGIN_CAPABILITIES: [],
            installPlugin: jest.fn(),
            uninstallPlugin: mockUninstallPlugin,
            listInstalledPlugins: () => [],
            listVisiblePlugins: () => [],
            isPluginEnabledFixed: () => false,
            setPluginEnabled: jest.fn(),
            verifyInstalledPlugin: () => undefined,
            formatPluginInstallError: () => '',
            formatPluginUninstallError: (error: string | undefined) => error ?? ''
        }));
        ({ registerPluginsCommand } = await import('../../../main/tui/subcommands/plugins.js'));
    });

    beforeEach(() => {
        mockUninstallPlugin.mockClear();
        jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
        jest.spyOn(console, 'log').mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    async function runUninstall(args: string[]): Promise<void> {
        const program = new Command();
        registerPluginsCommand(program);
        await program.parseAsync(['node', 'opendesk', 'plugins', 'uninstall', ...args]);
    }

    test('不带开关时保留插件数据目录', async () => {
        await runUninstall(['datadir-probe']);

        expect(mockUninstallPlugin).toHaveBeenCalledWith('datadir-probe', { removeData: false });
    });

    test('--remove-data 时删除插件数据目录', async () => {
        await runUninstall(['datadir-probe', '--remove-data']);

        expect(mockUninstallPlugin).toHaveBeenCalledWith('datadir-probe', { removeData: true });
    });
});
