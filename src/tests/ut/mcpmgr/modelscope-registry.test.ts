import { jest } from '@jest/globals';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import type { McpServerConfig } from '../../../main/applications/mcpmgr/common';
// 顶层静态 import（jest 30 对"动态 import() 链里的 node_modules CJS 依赖（zod）"
// 会报 module not been linked；静态 import 走正常模块注册，无此限制）。
import { ContributedMCPRegistry } from '../../../main/applications/mcpmgr/registry/contributed.js';
import { allRegistries } from '../../../main/applications/mcpmgr/registry/index.js';
import { McpMgrApplication } from '../../../main/applications/mcpmgr/app.js';

const fetchMock = jest.fn();

// 注意：不使用 jest.unstable_mockModule——它会把 jest 拉入 mockModule 的 ESM
// 模块上下文，导致动态 import 主进程模块（mcpmgr/app 依赖 zod）时报
// "module not been linked"。fetchMock 已显式传给插件注册表定义，无需 mock
// platforms/base；app/contributed/index 也不依赖该 mock。

// ModelScope MCP 注册表实现已迁移到内置插件 modelscope（按品牌划分）；
// 这里直接针对插件的注册表定义（与主进程消费的是同一份实现）做回归。
const MODELSCOPE_MODULE_PATH = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../../resources/plugins/modelscope/mcp-registry.mjs'
);

async function loadModelScopeDefinition(fetchImpl: typeof fetchMock = fetchMock) {
    const module = (await import(`${pathToFileURL(MODELSCOPE_MODULE_PATH).href}?t=${Date.now()}`)) as {
        createModelScopeMcpRegistryDefinition: (registryApi: { fetch: typeof fetchMock }) => any;
    };
    return module.createModelScopeMcpRegistryDefinition({ fetch: fetchImpl as unknown as typeof fetch });
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
            'https://www.modelscope.cn/api/v1/dolphin/mcpServers',
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

    test('翻页时不会重复返回同一批 MCP', async () => {
        // 复刻 ModelScope 线上接口契约：/dolphin/agg 是聚合接口，会忽略 PageSize / PageNumber
        // 固定返回同一批 top 数据；只有 /dolphin/mcpServers 会真正按页切片。
        // 早期实现请求了 agg，导致市场列表翻页时反复出现相同条目。
        const all = Array.from({ length: 45 }, (_, index) => ({
            Name: `server-${index + 1}`,
            Path: 'demo',
            ChineseName: `MCP ${index + 1}`,
            Stars: 100 - index,
            ServerConfig: [{ mcpServers: { demo: { command: 'node', args: ['server.js'] } } }]
        }));
        const apiFetch = jest.fn(async (input: string, init?: any) => {
            const request = JSON.parse(init.body);
            const isAgg = String(input).endsWith('/api/v1/dolphin/agg');
            const pageSize = isAgg ? 10 : request.PageSize;
            const pageNumber = isAgg ? 1 : request.PageNumber;
            const start = (pageNumber - 1) * pageSize;
            const bucket = { McpServers: all.slice(start, start + pageSize), TotalCount: all.length };
            return jsonResponse({
                Code: 200,
                Message: 'success',
                Data: isAgg ? { Data: { Mcp: bucket } } : { McpServer: bucket }
            });
        });

        const registry = await loadModelScopeDefinition(apiFetch as unknown as typeof fetchMock);
        const firstPage = await registry.search({ page: 1, limit: 20 });
        const secondPage = await registry.search({ page: 2, limit: 20 });
        const thirdPage = await registry.search({ page: 3, limit: 20 });

        const ids = [...firstPage.mcps, ...secondPage.mcps, ...thirdPage.mcps].map((mcp) => mcp.id);
        expect(ids).toHaveLength(45);
        expect(new Set(ids).size).toBe(45);
        expect(thirdPage.hasMore).toBe(false);
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
        // （静态 import 已提供三个符号，避免动态 import 触发 zod 链接问题）
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

    test('市场里的中文名在安装后作为 displayName 保留，配置技术名不被替换', async () => {
        // 真实数据（ModelScope「天眼查MCP」）：配置里的 key 是内部技术名 tyc-mcp，
        // 市场展示名是 ChineseName。安装后用户看到的必须是展示名，否则就是安装前后改名。
        fetchMock.mockResolvedValueOnce(
            jsonResponse(
                mcpAggResponse([
                    {
                        Name: 'tyc-mcp',
                        Path: 'TianYanCha',
                        ChineseName: '天眼查MCP',
                        ServerConfig: [
                            {
                                mcpServers: {
                                    'tyc-mcp': {
                                        command: 'npx',
                                        args: [
                                            '-y',
                                            'mcp-remote',
                                            'https://mcp.tianyancha.com/v1',
                                            '--header',
                                            'Authorization:${YOUR_API_KEY}'
                                        ]
                                    }
                                }
                            }
                        ]
                    }
                ])
            )
        );

        const definition = await loadModelScopeDefinition();
        const adapter = new ContributedMCPRegistry(definition);
        const originalRegistries = [...allRegistries];
        allRegistries.splice(0, allRegistries.length, adapter);

        try {
            const app = Object.create(McpMgrApplication.prototype) as McpMgrApplication;
            let servers: McpServerConfig[] = [];

            jest.spyOn(app, 'getServersFromConfig').mockImplementation(() => JSON.parse(JSON.stringify(servers)));
            (app as any).saveServersToConfig = jest.fn((nextServers: McpServerConfig[]) => {
                servers = JSON.parse(JSON.stringify(nextServers));
            });
            (app as any).sendEventToSubscribers = jest.fn();

            await app.installFromRegistry(`modelscope-mcp:${encodeURIComponent('TianYanCha/tyc-mcp')}`);

            expect(servers).toHaveLength(1);
            expect(servers[0]).toEqual(
                expect.objectContaining({
                    name: 'tyc-mcp',
                    displayName: '天眼查MCP',
                    command: 'npx'
                })
            );
        } finally {
            allRegistries.splice(0, allRegistries.length, ...originalRegistries);
        }
    });
});
