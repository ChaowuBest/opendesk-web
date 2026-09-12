import { fileURLToPath } from 'url';
import { jest } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getPluginHost } from '../../../main/applications/pluginmgr/runtime/host.js';
import {
    disposePluginMcpRuntime,
    getPluginMcpServerStates,
    getPluginMcpToolsets
} from '../../../main/applications/pluginmgr/runtime/mcp.js';
import { definePlugin } from '../../../../packages/plugin-sdk/src/index.js';

describe('PluginMcpRuntime', () => {
    const server = fileURLToPath(new URL('./fixtures/plugin-mcp-server.mjs', import.meta.url));

    afterEach(async () => {
        jest.restoreAllMocks();
        await getPluginHost().dispose();
        await disposePluginMcpRuntime();
    });

    test('发现、调用并在插件停用后撤销 stdio MCP 工具', async () => {
        await getPluginHost().activate(
            definePlugin({
                id: 'mcp-contributor',
                displayName: 'MCP Contributor',
                setup(ctx) {
                    ctx.mcps.registerServer({
                        name: 'echo-server',
                        transport: 'stdio',
                        command: process.execPath,
                        args: [server]
                    });
                }
            }),
            { origin: 'test:mcp-runtime' }
        );

        await expect(getPluginMcpServerStates()).resolves.toEqual([
            expect.objectContaining({
                name: 'echo-server',
                source: 'MCP Contributor',
                providerId: 'pluginMgr',
                readOnly: true,
                status: 'connected',
                tools: [expect.objectContaining({ name: 'echo' })]
            })
        ]);
        const toolsets = await getPluginMcpToolsets(process.cwd());
        expect(getPluginHost().get('mcp-contributor')?.diagnostics).toEqual([]);
        const tool = toolsets[0]?.getTool('echo_server__echo');
        const callTool = jest.spyOn(Client.prototype, 'callTool');
        const result = await tool?.execute({ text: 'OpenDesk' });
        expect(callTool).toHaveBeenCalledWith({ name: 'echo', arguments: { text: 'OpenDesk' } }, undefined, {
            timeout: 180_000,
            resetTimeoutOnProgress: true,
            maxTotalTimeout: 300_000
        });

        expect(toolsets[0]?.name).toBe('plugin-mcp-mcp-contributor');
        expect(`${toolsets[0]?.name}-${tool?.name}`).toMatch(/^[a-zA-Z0-9_-]+$/);
        expect(result?.result).toBe('echo:OpenDesk');

        await getPluginHost().deactivate('mcp-contributor');
        await expect(tool?.execute({ text: 'after-dispose' })).resolves.toMatchObject({
            status: 'error',
            result: 'plugin.mcp_not_connected'
        });
        await expect(getPluginMcpToolsets(process.cwd())).resolves.toEqual([]);
        await expect(getPluginMcpServerStates()).resolves.toEqual([]);
    });

    test('插件未声明显示名时 MCP 来源回退到插件 ID', async () => {
        await getPluginHost().activate(
            definePlugin({
                id: 'mcp-without-display-name',
                capabilities: ['mcp'],
                setup(ctx) {
                    ctx.mcps.registerServer({
                        name: 'fallback-server',
                        transport: 'stdio',
                        command: process.execPath,
                        args: [server]
                    });
                }
            }),
            { origin: 'test:mcp-runtime-fallback' }
        );

        await expect(getPluginMcpServerStates()).resolves.toEqual([
            expect.objectContaining({
                source: 'mcp-without-display-name',
                providerId: 'pluginMgr'
            })
        ]);
    });
});
