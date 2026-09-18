import { jest } from '@jest/globals';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import type { McpServerConfig } from '../../../main/applications/mcpmgr/common';

const fetchMock = jest.fn();

jest.unstable_mockModule('../../../platforms/base', () => ({
    getPlatform: () => ({
        fetch: fetchMock
    })
}));

// ModelScope MCP 注册表实现已迁移到内置插件 modelscope（按品牌划分）；
// 这里直接针对插件的注册表定义（与主进程消费的是同一份实现）做回归。
const MODELSCOPE_MODULE_PATH = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../../resources/plugins/modelscope/mcp-registry.mjs'
);

async function loadModelScopeDefinition() {
    const module = (await import(`${pathToFileURL(MODELSCOPE_MODULE_PATH).href}?t=${Date.now()}`)) as {
        createModelScopeMcpRegistryDefinition: (registryApi: { fetch: typeof fetchMock }) => any;
    };
    return module.createModelScopeMcpRegistryDefinition({ fetch: fetchMock as unknown as typeof fetch });
}

function jsonResponse(data: unknown): Response {
    return {
        ok: true,
        status: 200,
        json: async () => data
    } as Response;
}

function mcpAggResponse(mcps: any[], total = mcps.length) {
    return {
        Code: 200,
        Success: true,
        Message: 'success',
        Data: {
            Data: {
                Mcp: {
                    McpServers: mcps,
                    TotalCount: total
                }
            }
        }
    };
}

describe('ModelScope MCP registry', () => {
    beforeEach(() => {
        fetchMock.mockReset();
    });

    test('maps official MCP aggregate response instead of studio entries', async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse(
                mcpAggResponse(
                    [
                        {
                            Name: 'fetch',
                            Path: '@modelcontextprotocol',
                            ChineseName: 'Fetch网页内容抓取',
                            Abstract: 'Fetch web content',
                            Hosted: true,
                            FromSite: 'github',
                            FromSitePath: 'modelcontextprotocol',
                            FromSiteUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
                            Stars: 763,
                            ViewCount: 511369,
                            Category: ['browser-automation'],
                            Tags: ['web'],
                            ServerConfig: [
                                {
                                    mcpServers: {
                                        fetch: {
                                            command: 'uvx',
                                            args: ['mcp-server-fetch']
                                        }
                                    }
                                }
                            ]
                        },
                        {
                            Name: 'Fetch-Browser',
                            Path: '@TheSethRose',
                            ChineseName: 'Fetch-浏览器',
                            Abstract: 'Browser fetch',
                            Hosted: false,
                            ServerConfig: []
                        }
                    ],
                    9631
                )
            )
        );

        const registry = await loadModelScopeDefinition();
        const result = await registry.search({ query: 'fetch', page: 1, limit: 30 });

        expect(result.total).toBe(9631);
        expect(result.mcps[0]).toEqual(
            expect.objectContaining({
                id: '@modelcontextprotocol/fetch',
                name: 'Fetch网页内容抓取',
                repository: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
                deployType: 'Hosted',
                serverType: 'stdio',
                stars: 763,
                views: 511369,
                canInstall: true
            })
        );
        expect(result.mcps[0].configuration).toContain('"command": "uvx"');
        expect(result.mcps[1]).toEqual(
            expect.objectContaining({
                id: '@TheSethRose/Fetch-Browser',
                canInstall: false
            })
        );
        expect(fetchMock).toHaveBeenCalledWith(
            'https://www.modelscope.cn/api/v1/dolphin/agg',
            expect.objectContaining({
                method: 'PUT',
                body: JSON.stringify({
                    PageSize: 30,
                    PageNumber: 1,
                    Query: 'fetch',
                    Criterion: []
                })
            })
        );
    });

    test('sorts search results by favorite count', async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse(
                mcpAggResponse([
                    {
                        Name: 'low-stars',
                        Path: 'demo',
                        Stars: 3
                    },
                    {
                        Name: 'top-stars',
                        Path: 'demo',
                        Stars: 88
                    },
                    {
                        Name: 'middle-stars',
                        Path: 'demo',
                        StarCount: '17'
                    }
                ])
            )
        );

        const registry = await loadModelScopeDefinition();
        const result = await registry.search({ page: 1, limit: 30 });

        expect(result.mcps.map((mcp) => mcp.id)).toEqual(['demo/top-stars', 'demo/middle-stars', 'demo/low-stars']);
    });

    test('getDetail selects the exact Path and Name pair for duplicate names', async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse(
                mcpAggResponse([
                    {
                        Name: 'fetch',
                        Path: 'someone',
                        ChineseName: 'Other Fetch',
                        ServerConfig: [
                            {
                                mcpServers: {
                                    fetch: {
                                        command: 'python',
                                        args: ['-m', 'other_fetch']
                                    }
                                }
                            }
                        ]
                    },
                    {
                        Name: 'fetch',
                        Path: '@modelcontextprotocol',
                        ChineseName: 'Fetch网页内容抓取',
                        StreamableHTTPServerConfig: [
                            {
                                mcpServers: {
                                    fetch: {
                                        type: 'streamable_http',
                                        url: 'https://example.com/mcp'
                                    }
                                }
                            }
                        ],
                        ServerConfig: [
                            {
                                mcpServers: {
                                    fetch: {
                                        command: 'uvx',
                                        args: ['mcp-server-fetch']
                                    }
                                }
                            }
                        ]
                    }
                ])
            )
        );

        const registry = await loadModelScopeDefinition();
        const detail = await registry.getDetail('@modelcontextprotocol/fetch');

        expect(detail).toEqual(
            expect.objectContaining({
                id: '@modelcontextprotocol/fetch',
                name: 'Fetch网页内容抓取',
                serverType: 'streamableHttp',
                canInstall: true
            })
        );
        expect(detail?.configuration).toContain('"type": "streamable_http"');
        expect(detail?.configuration).toContain('"url": "https://example.com/mcp"');
    });

    test('installs a ModelScope MCP server into local config and deleteServer removes it', async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse(
                mcpAggResponse([
                    {
                        Name: 'fetch',
                        Path: '@modelcontextprotocol',
                        ChineseName: 'Fetch网页内容抓取',
                        ServerConfig: [
                            {
                                mcpServers: {
                                    fetch: {
                                        command: 'uvx',
                                        args: ['mcp-server-fetch'],
                                        env: {
                                            FETCH_TIMEOUT: '10'
                                        }
                                    }
                                }
                            }
                        ]
                    }
                ])
            )
        );

        // 与主进程一致：插件贡献的注册表经 ContributedMCPRegistry 适配后进 allRegistries
        const [{ ContributedMCPRegistry }, { allRegistries }, { McpMgrApplication }] = await Promise.all([
            import('../../../main/applications/mcpmgr/registry/contributed'),
            import('../../../main/applications/mcpmgr/registry/index'),
            import('../../../main/applications/mcpmgr/app')
        ]);
        const definition = await loadModelScopeDefinition();
        const adapter = new ContributedMCPRegistry(definition);
        const originalRegistries = [...allRegistries];
        allRegistries.splice(0, allRegistries.length, adapter);

        try {
            const app = Object.create(McpMgrApplication.prototype) as McpMgrApplication;
            let servers: McpServerConfig[] = [];

            jest.spyOn(app, 'getServersFromConfig').mockImplementation(() => JSON.parse(JSON.stringify(servers)));
            const saveServersToConfig = jest.fn((nextServers: McpServerConfig[]) => {
                servers = JSON.parse(JSON.stringify(nextServers));
            });
            (app as any).saveServersToConfig = saveServersToConfig;
            (app as any).sendEventToSubscribers = jest.fn();

            const result = await app.installFromRegistry('modelscope-mcp:%40modelcontextprotocol%2Ffetch');

            expect(result.installed).toHaveLength(1);
            expect(servers).toHaveLength(1);
            expect(servers[0]).toEqual(
                expect.objectContaining({
                    name: 'fetch',
                    transport: 'stdio',
                    command: 'uvx',
                    args: ['mcp-server-fetch'],
                    env: {
                        FETCH_TIMEOUT: '10'
                    },
                    source: 'modelscope',
                    registryId: 'modelscope-mcp',
                    registryMcpId: '@modelcontextprotocol/fetch'
                })
            );
            expect(servers[0].id).toMatch(/^mcp_/);

            await app.deleteServer(servers[0].id);

            expect(servers).toEqual([]);
            expect(saveServersToConfig).toHaveBeenCalledTimes(2);
        } finally {
            allRegistries.splice(0, allRegistries.length, ...originalRegistries);
        }
    });
});
