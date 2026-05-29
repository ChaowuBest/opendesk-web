import { jest } from '@jest/globals';
import { McpRoutes } from '../../../main/server/routes/mcp.js';
import { ApplicationRegistry } from '../../../main/applications/registry.js';
import type { McpServerConfig, McpServerState } from '../../../main/applications/mcpmgr/common.js';

function server(config: Partial<McpServerConfig>): McpServerConfig {
    return {
        id: config.id || config.name || 'server',
        name: config.name || config.id || 'server',
        transport: config.transport || 'stdio',
        enabled: config.enabled ?? true,
        command: config.command,
        args: config.args || [],
        cwd: config.cwd,
        url: config.url,
        env: config.env || {},
        headers: config.headers || {}
    };
}

describe('opencode MCP routes', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('returns an empty status map when mcpmgr is unavailable', async () => {
        jest.spyOn(ApplicationRegistry, 'getApplication').mockReturnValue(undefined);

        const response = await McpRoutes().request('/mcp');

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({});
    });

    test('maps worker server states to opencode status map', async () => {
        const mcpApp = {
            callWorker: jest.fn(async () => ({
                status: 'ok',
                data: [
                    { ...server({ id: 'mcp_1', name: 'filesystem' }), status: 'connected', tools: [] },
                    { ...server({ id: 'mcp_2', name: 'github' }), status: 'error', error: 'boom', tools: [] },
                    { ...server({ id: 'mcp_3', name: 'fetch' }), status: 'disconnected', tools: [] }
                ] satisfies McpServerState[]
            })),
            getServersFromConfig: jest.fn(),
            sendEventToSubscribers: jest.fn()
        };
        jest.spyOn(ApplicationRegistry, 'getApplication').mockReturnValue(mcpApp as any);

        const response = await McpRoutes().request('/mcp');

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            filesystem: { status: 'connected' },
            github: { status: 'failed', error: 'boom' },
            fetch: { status: 'disabled' }
        });
        expect(mcpApp.callWorker).toHaveBeenCalledWith('getServers');
    });

    test('falls back to configured servers when worker is unavailable', async () => {
        const mcpApp = {
            callWorker: jest.fn(async () => {
                throw new Error('worker missing');
            }),
            getServersFromConfig: jest.fn(() => [
                server({ id: 'mcp_1', name: 'filesystem', enabled: true }),
                server({ id: 'mcp_2', name: 'github', enabled: false })
            ]),
            sendEventToSubscribers: jest.fn()
        };
        jest.spyOn(ApplicationRegistry, 'getApplication').mockReturnValue(mcpApp as any);

        const response = await McpRoutes().request('/mcp');

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            filesystem: { status: 'disabled' },
            github: { status: 'disabled' }
        });
    });

    test('connects MCP server by opencode name', async () => {
        const mcpApp = {
            callWorker: jest.fn(async () => ({ status: 'ok' })),
            getServersFromConfig: jest.fn(() => [server({ id: 'mcp_1', name: 'filesystem' })]),
            sendEventToSubscribers: jest.fn()
        };
        jest.spyOn(ApplicationRegistry, 'getApplication').mockReturnValue(mcpApp as any);

        const response = await McpRoutes().request('/mcp/filesystem/connect', { method: 'POST' });

        expect(response.status).toBe(200);
        expect(await response.json()).toBe(true);
        expect(mcpApp.callWorker).toHaveBeenCalledWith('connectServer', 'mcp_1');
        expect(mcpApp.sendEventToSubscribers).toHaveBeenCalledWith('serversUpdated');
    });

    test('disconnects MCP server by opencode name', async () => {
        const mcpApp = {
            callWorker: jest.fn(async () => ({ status: 'ok' })),
            getServersFromConfig: jest.fn(() => [server({ id: 'mcp_1', name: 'filesystem' })]),
            sendEventToSubscribers: jest.fn()
        };
        jest.spyOn(ApplicationRegistry, 'getApplication').mockReturnValue(mcpApp as any);

        const response = await McpRoutes().request('/mcp/filesystem/disconnect', { method: 'POST' });

        expect(response.status).toBe(200);
        expect(await response.json()).toBe(true);
        expect(mcpApp.callWorker).toHaveBeenCalledWith('disconnectServer', 'mcp_1');
        expect(mcpApp.sendEventToSubscribers).toHaveBeenCalledWith('serversUpdated');
    });

    test('returns opencode not-found error shape for missing MCP server', async () => {
        const mcpApp = {
            callWorker: jest.fn(),
            getServersFromConfig: jest.fn(() => []),
            sendEventToSubscribers: jest.fn()
        };
        jest.spyOn(ApplicationRegistry, 'getApplication').mockReturnValue(mcpApp as any);

        const response = await McpRoutes().request('/mcp/missing/connect', { method: 'POST' });

        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({
            _tag: 'McpServerNotFoundError',
            name: 'missing',
            message: 'MCP server not found: missing'
        });
    });
});
