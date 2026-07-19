import { jest } from '@jest/globals';
import { McpMgrApplication } from '../../../main/applications/mcpmgr/app.js';
import {
    DeleteMcpServerTool,
    GetMcpRegistryEntryTool,
    ImportMcpServersFromJsonTool,
    InstallMcpServerFromRegistryTool,
    InstallMcpServerTool,
    ListMcpRegistriesTool,
    ListMcpServersTool,
    ReconnectMcpServerTool,
    SearchMcpRegistryTool,
    ToggleMcpServerTool,
    UpdateMcpServerTool
} from '../../../main/applications/mcpmgr/tools.js';
import type { McpServerConfig } from '../../../main/applications/mcpmgr/common.js';

function createMcpApp(overrides: Record<string, any> = {}) {
    const addServer = jest.fn(async (config: McpServerConfig) => ({
        ...config,
        id: 'server-1'
    }));

    return {
        getServersFromConfig: jest.fn(() => []),
        isServerDuplicate: jest.fn(() => false),
        addServer,
        callWorker: jest.fn(),
        ...overrides
    };
}

describe('InstallMcpServerTool', () => {
    test('exports schema for all supported transports', () => {
        const app = createMcpApp();
        const tool = new InstallMcpServerTool(app);

        const json = tool.toJSON();
        const paramsText = JSON.stringify(json.params);

        expect(paramsText).toContain('stdio');
        expect(paramsText).toContain('sse');
        expect(paramsText).toContain('streamableHttp');
    });

    test('accepts stdio command configuration', async () => {
        const app = createMcpApp();
        const tool = new InstallMcpServerTool(app);

        const result = await tool.execute({
            name: 'filesystem',
            transport: 'stdio',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
            env: {
                DEBUG: '1'
            },
            enabled: false
        });

        expect(result.status).toBe('success');
        expect(app.addServer).toHaveBeenCalledWith(
            expect.objectContaining({
                name: 'filesystem',
                transport: 'stdio',
                command: 'npx',
                args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
                env: {
                    DEBUG: '1'
                }
            })
        );
        expect(app.callWorker).not.toHaveBeenCalled();
        expect(JSON.parse(result.result)).toEqual(
            expect.objectContaining({
                success: true,
                name: 'filesystem',
                transport: 'stdio'
            })
        );
    });

    test('rejects stdio configuration without command', async () => {
        const app = createMcpApp();
        const tool = new InstallMcpServerTool(app);

        const result = await tool.execute({
            name: 'filesystem',
            transport: 'stdio',
            enabled: false
        } as any);

        expect(result.status).toBe('error');
        expect(result.result).toContain('command');
        expect(app.addServer).not.toHaveBeenCalled();
    });

    test('rejects remote configuration without url', async () => {
        const app = createMcpApp();
        const tool = new InstallMcpServerTool(app);

        const result = await tool.execute({
            name: 'remote-server',
            transport: 'streamableHttp',
            enabled: false
        } as any);

        expect(result.status).toBe('error');
        expect(result.result).toContain('url');
        expect(app.addServer).not.toHaveBeenCalled();
    });

    test('accepts streamableHttp URL configuration', async () => {
        const app = createMcpApp();
        const tool = new InstallMcpServerTool(app);

        const result = await tool.execute({
            name: 'remote-server',
            transport: 'streamableHttp',
            url: 'https://example.com/mcp',
            headers: {
                Authorization: 'Bearer token'
            },
            enabled: false
        });

        expect(result.status).toBe('success');
        expect(app.addServer).toHaveBeenCalledWith(
            expect.objectContaining({
                name: 'remote-server',
                transport: 'streamableHttp',
                url: 'https://example.com/mcp',
                headers: {
                    Authorization: 'Bearer token'
                }
            })
        );
        expect(JSON.parse(result.result)).toEqual(
            expect.objectContaining({
                success: true,
                name: 'remote-server',
                transport: 'streamableHttp'
            })
        );
    });
});

describe('MCP management skill toolset', () => {
    test('registers tools covering GUI MCP management actions', async () => {
        const app = Object.create(McpMgrApplication.prototype) as McpMgrApplication;

        const skills = await app.getSkills();
        const toolNames = Array.from(skills[0].toolsets[0].tools.keys());

        expect(toolNames).toEqual(
            expect.arrayContaining([
                'installMcpServer',
                'listMcpServers',
                'updateMcpServer',
                'reconnectMcpServer',
                'deleteMcpServer',
                'toggleMcpServer',
                'importMcpServersFromJson',
                'listMcpRegistries',
                'searchMcpRegistry',
                'getMcpRegistryEntry',
                'installMcpServerFromRegistry'
            ])
        );
    });

    test('exports all management tools to JSON schema', async () => {
        const app = Object.create(McpMgrApplication.prototype) as McpMgrApplication;

        const skills = await app.getSkills();
        const json = skills[0].toolsets[0].toJSON();
        const toolNames = json.tools.map((tool: any) => tool.name);

        expect(toolNames).toEqual(
            expect.arrayContaining([
                'updateMcpServer',
                'reconnectMcpServer',
                'importMcpServersFromJson',
                'listMcpRegistries',
                'searchMcpRegistry',
                'getMcpRegistryEntry',
                'installMcpServerFromRegistry'
            ])
        );
        expect(JSON.stringify(json)).toContain('streamableHttp');
    });
});

describe('MCP registry management tools', () => {
    test('lists configured MCP registries', async () => {
        const app = createMcpApp({
            getMcpRegistries: jest.fn(() => [
                {
                    id: 'matrix',
                    label: 'Matrix MCPs',
                    icon: '◇',
                    slogan: 'Registry'
                }
            ])
        });
        const tool = new ListMcpRegistriesTool(app);

        const result = await tool.execute({});

        expect(result.status).toBe('success');
        expect(JSON.parse(result.result)).toEqual({
            registries: [
                {
                    id: 'matrix',
                    label: 'Matrix MCPs',
                    icon: '◇',
                    slogan: 'Registry'
                }
            ]
        });
    });

    test('searches MCP registry with pagination arguments', async () => {
        const searchMcpRegistry = jest.fn(async () => ({
            mcps: [
                {
                    id: 'fetch',
                    name: 'fetch',
                    source: 'matrix',
                    installUrl: 'matrix:fetch',
                    canInstall: true
                }
            ],
            total: 1,
            hasMore: false
        }));
        const app = createMcpApp({ searchMcpRegistry });
        const tool = new SearchMcpRegistryTool(app);

        const result = await tool.execute({
            registryId: 'matrix',
            query: 'fetch',
            page: 2,
            limit: 10,
            cursor: 'next'
        });

        expect(result.status).toBe('success');
        expect(searchMcpRegistry).toHaveBeenCalledWith('matrix', 'fetch', 2, 10, 'next');
        expect(JSON.parse(result.result)).toEqual(
            expect.objectContaining({
                total: 1,
                hasMore: false
            })
        );
    });

    test('gets registry entry detail', async () => {
        const app = createMcpApp({
            getRegistryMcpDetail: jest.fn(async () => ({
                id: 'fetch',
                name: 'fetch',
                source: 'matrix',
                installUrl: 'matrix:fetch',
                configuration: '{ "mcpServers": {} }',
                canInstall: true
            }))
        });
        const tool = new GetMcpRegistryEntryTool(app);

        const result = await tool.execute({
            registryId: 'matrix',
            id: 'fetch'
        });

        expect(result.status).toBe('success');
        expect(JSON.parse(result.result).entry).toEqual(
            expect.objectContaining({
                id: 'fetch',
                installUrl: 'matrix:fetch'
            })
        );
    });

    test('installs registry entry by registry ID and entry ID', async () => {
        const installFromRegistry = jest.fn(async () => ({
            success: true,
            installed: [{ id: 'mcp_fetch', name: 'fetch' }],
            updated: [],
            skipped: []
        }));
        const app = createMcpApp({
            getRegistryMcpDetail: jest.fn(async () => ({
                id: 'fetch',
                name: 'fetch',
                source: 'matrix',
                installUrl: 'matrix:fetch',
                canInstall: true
            })),
            installFromRegistry
        });
        const tool = new InstallMcpServerFromRegistryTool(app);

        const result = await tool.execute({
            registryId: 'matrix',
            id: 'fetch',
            force: true
        });

        expect(result.status).toBe('success');
        expect(installFromRegistry).toHaveBeenCalledWith('matrix:fetch', true);
        expect(JSON.parse(result.result)).toEqual(
            expect.objectContaining({
                success: true
            })
        );
    });
});

describe('MCP server configuration management tools', () => {
    test('lists installed MCP servers with worker state', async () => {
        const callWorker = jest.fn(async () => ({
            status: 'ok',
            data: [
                {
                    id: 'mcp_fetch',
                    name: 'fetch',
                    transport: 'stdio',
                    enabled: true,
                    status: 'connected',
                    tools: []
                }
            ]
        }));
        const app = createMcpApp({ callWorker });
        const tool = new ListMcpServersTool(app);

        const result = await tool.execute({});

        expect(result.status).toBe('success');
        expect(callWorker).toHaveBeenCalledWith('getServers');
        expect(JSON.parse(result.result).servers).toEqual([
            expect.objectContaining({
                id: 'mcp_fetch',
                name: 'fetch',
                status: 'connected'
            })
        ]);
    });

    test('imports MCP servers from JSON config', async () => {
        const importFromJson = jest.fn(async () => 2);
        const app = createMcpApp({ importFromJson });
        const tool = new ImportMcpServersFromJsonTool(app);

        const result = await tool.execute({
            jsonConfig: '{ "mcpServers": { "fetch": { "command": "uvx", "args": ["mcp-server-fetch"] } } }'
        });

        expect(result.status).toBe('success');
        expect(importFromJson).toHaveBeenCalledWith(
            '{ "mcpServers": { "fetch": { "command": "uvx", "args": ["mcp-server-fetch"] } } }'
        );
        expect(JSON.parse(result.result)).toEqual(
            expect.objectContaining({
                success: true,
                imported: 2
            })
        );
    });

    test('updates installed stdio server configuration by name', async () => {
        const server: McpServerConfig = {
            id: 'mcp_fetch',
            name: 'fetch',
            transport: 'stdio',
            enabled: true,
            command: 'uvx',
            args: ['mcp-server-fetch'],
            env: {}
        };
        const updateServer = jest.fn(async () => undefined);
        const app = createMcpApp({
            getServersFromConfig: jest.fn(() => [server]),
            updateServer
        });
        const tool = new UpdateMcpServerTool(app);

        const result = await tool.execute({
            nameOrId: 'fetch',
            name: 'fetch-renamed',
            args: ['mcp-server-fetch', '--ignore-robots-txt'],
            env: {
                FETCH_TIMEOUT: '10'
            }
        });

        expect(result.status).toBe('success');
        expect(updateServer).toHaveBeenCalledWith(
            'mcp_fetch',
            expect.objectContaining({
                id: 'mcp_fetch',
                name: 'fetch-renamed',
                transport: 'stdio',
                command: 'uvx',
                args: ['mcp-server-fetch', '--ignore-robots-txt'],
                env: {
                    FETCH_TIMEOUT: '10'
                }
            })
        );
    });

    test('rejects update that would leave remote transport without url', async () => {
        const server: McpServerConfig = {
            id: 'mcp_fetch',
            name: 'fetch',
            transport: 'stdio',
            enabled: true,
            command: 'uvx',
            args: ['mcp-server-fetch'],
            env: {}
        };
        const updateServer = jest.fn(async () => undefined);
        const app = createMcpApp({
            getServersFromConfig: jest.fn(() => [server]),
            updateServer
        });
        const tool = new UpdateMcpServerTool(app);

        const result = await tool.execute({
            nameOrId: 'fetch',
            transport: 'streamableHttp'
        });

        expect(result.status).toBe('error');
        expect(result.result).toContain('url');
        expect(updateServer).not.toHaveBeenCalled();
    });

    test('reconnects installed server by name', async () => {
        const server: McpServerConfig = {
            id: 'mcp_fetch',
            name: 'fetch',
            transport: 'stdio',
            enabled: true,
            command: 'uvx',
            args: ['mcp-server-fetch'],
            env: {}
        };
        const callWorker = jest.fn(async () => undefined);
        const app = createMcpApp({
            getServersFromConfig: jest.fn(() => [server]),
            callWorker
        });
        const tool = new ReconnectMcpServerTool(app);

        const result = await tool.execute({
            nameOrId: 'fetch'
        });

        expect(result.status).toBe('success');
        expect(callWorker).toHaveBeenCalledWith('reconnectServer', 'mcp_fetch');
    });

    test('deletes installed server by name', async () => {
        const server: McpServerConfig = {
            id: 'mcp_fetch',
            name: 'fetch',
            transport: 'stdio',
            enabled: true,
            command: 'uvx',
            args: ['mcp-server-fetch'],
            env: {}
        };
        const deleteServer = jest.fn(async () => undefined);
        const app = createMcpApp({
            getServersFromConfig: jest.fn(() => [server]),
            deleteServer
        });
        const tool = new DeleteMcpServerTool(app);

        const result = await tool.execute({
            nameOrId: 'fetch'
        });

        expect(result.status).toBe('success');
        expect(deleteServer).toHaveBeenCalledWith('mcp_fetch');
    });

    test('disables installed server and disconnects it', async () => {
        const server: McpServerConfig = {
            id: 'mcp_fetch',
            name: 'fetch',
            transport: 'stdio',
            enabled: true,
            command: 'uvx',
            args: ['mcp-server-fetch'],
            env: {}
        };
        const callWorker = jest.fn(async () => undefined);
        const toggleServer = jest.fn(async () => undefined);
        const app = createMcpApp({
            getServersFromConfig: jest.fn(() => [server]),
            callWorker,
            toggleServer
        });
        const tool = new ToggleMcpServerTool(app);

        const result = await tool.execute({
            nameOrId: 'fetch',
            enabled: false
        });

        expect(result.status).toBe('success');
        expect(callWorker).toHaveBeenCalledWith('disconnectServer', 'mcp_fetch');
        expect(toggleServer).toHaveBeenCalledWith('mcp_fetch', false);
    });

    test('enables installed server and connects it', async () => {
        const server: McpServerConfig = {
            id: 'mcp_fetch',
            name: 'fetch',
            transport: 'stdio',
            enabled: false,
            command: 'uvx',
            args: ['mcp-server-fetch'],
            env: {}
        };
        const callWorker = jest.fn(async () => undefined);
        const toggleServer = jest.fn(async () => undefined);
        const app = createMcpApp({
            getServersFromConfig: jest.fn(() => [server]),
            callWorker,
            toggleServer
        });
        const tool = new ToggleMcpServerTool(app);

        const result = await tool.execute({
            nameOrId: 'fetch',
            enabled: true
        });

        expect(result.status).toBe('success');
        expect(toggleServer).toHaveBeenCalledWith('mcp_fetch', true);
        expect(callWorker).toHaveBeenCalledWith('connectServer', 'mcp_fetch');
    });
});
