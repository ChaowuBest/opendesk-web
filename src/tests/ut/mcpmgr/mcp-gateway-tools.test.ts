import { jest } from '@jest/globals';
import { McpMgrApplication } from '../../../main/applications/mcpmgr/app.js';
import {
    MCP_EAGER_DEFINITION_CHAR_BUDGET,
    McpCallToolTool,
    McpGetToolTool,
    McpSearchToolsTool,
    partitionMcpToolsForContext
} from '../../../main/applications/mcpmgr/mcp-gateway-tools.js';
import type { McpToolInfo } from '../../../main/applications/mcpmgr/common.js';
import { ToolCall } from '../../../main/aikernel/messages.js';
import { MCPTool } from '../../../main/applications/mcpmgr/mcp-tool.js';
import { t } from '../../../main/applications/mcpmgr/locale/index.js';

function tool(overrides: Partial<McpToolInfo> = {}): McpToolInfo {
    return {
        serverId: 'arkts-id',
        serverName: 'arkts',
        name: 'search_components',
        description: 'Search HarmonyOS ArkTS component documentation',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string' }
            },
            required: ['query']
        },
        ...overrides
    };
}

describe('MCP layered tool loading', () => {
    test('defers the largest complete server until eager definitions fit the budget', () => {
        const small = tool({
            serverId: 'small-id',
            serverName: 'small',
            name: 'ping',
            description: 'Ping a service'
        });
        const large = [
            tool({ name: 'search_apis', description: 'A'.repeat(800) }),
            tool({ name: 'read_api', description: 'B'.repeat(800) })
        ];

        const partition = partitionMcpToolsForContext([small, ...large], 1_000);

        expect(partition.eager).toEqual([small]);
        expect(partition.deferred).toEqual(large);
    });

    test('budgets the final eager definitions including the injected description', () => {
        const tools = Array.from({ length: 80 }, (_, index) =>
            tool({
                serverId: `server-${index}`,
                serverName: `server-${index}`,
                name: 'ping',
                description: 'Ping a service'
            })
        );

        const partition = partitionMcpToolsForContext(tools);
        const actualSize = partition.eager.reduce(
            (size, candidate) =>
                size +
                JSON.stringify(
                    new MCPTool(
                        candidate.serverName,
                        candidate.name,
                        candidate.description,
                        candidate.inputSchema
                    ).toJSON()
                ).length,
            0
        );

        expect(actualSize).toBeLessThanOrEqual(MCP_EAGER_DEFINITION_CHAR_BUDGET);
        expect(partition.deferred.length).toBeGreaterThan(0);
    });

    test('searches compact metadata, loads one definition, and calls through the gateway', async () => {
        const tools = [
            tool(),
            tool({
                name: 'read_guides',
                description: `Read HarmonyOS development guides ${'verbose '.repeat(100)}`
            })
        ];
        const callTool = jest.fn(async () => 'documentation result');
        const searchTool = new McpSearchToolsTool(tools);
        const getTool = new McpGetToolTool(tools);
        const callGateway = new McpCallToolTool(tools, callTool);
        const initialDefinitions = JSON.stringify([searchTool.toJSON(), getTool.toJSON(), callGateway.toJSON()]);

        expect(initialDefinitions).not.toContain('verbose verbose');
        expect(initialDefinitions.length).toBeLessThan(5_000);
        expect(callGateway.getJsonSchema().properties.description).toEqual(expect.objectContaining({ type: 'string' }));
        expect(searchTool.getJsonSchema().properties.description).toEqual(expect.objectContaining({ type: 'string' }));
        expect(getTool.getJsonSchema().properties.description).toEqual(expect.objectContaining({ type: 'string' }));
        expect(callGateway.getJsonSchema().required).toContain('description');
        expect(searchTool.getJsonSchema().required).toContain('description');
        expect(getTool.getJsonSchema().required).toContain('description');

        const searchResult = await searchTool.execute({ query: 'component', offset: 0, limit: 5 });
        const searchPayload = JSON.parse(searchResult.result);
        expect(searchPayload.tools).toEqual([
            expect.objectContaining({
                serverId: 'arkts-id',
                name: 'search_components'
            })
        ]);
        expect(searchPayload.tools[0].summary.length).toBeLessThanOrEqual(240);
        expect(searchPayload.tools[0]).not.toHaveProperty('inputSchema');

        const definitionResult = await getTool.execute({
            serverId: 'arkts-id',
            toolName: 'search_components'
        });
        expect(JSON.parse(definitionResult.result)).toEqual(
            expect.objectContaining({
                description: 'Search HarmonyOS ArkTS component documentation',
                inputSchema: tools[0].inputSchema
            })
        );

        const callResult = await callGateway.execute({
            serverId: 'arkts-id',
            toolName: 'search_components',
            arguments: { query: 'Button' },
            description: 'Find button components'
        });
        expect(callResult.result).toBe('documentation result');
        expect(callTool).toHaveBeenCalledWith(tools[0], { query: 'Button' });

        const call = new ToolCall(0, 'id', 'mcpCallTool', '{}');
        call.args_object = {
            serverId: 'arkts-id',
            toolName: 'search_components',
            description: 'Find button components'
        };
        const html = await callGateway.renderToolCall(call);
        expect(html).toContain('title="arkts · search_components"');
        expect(html).toContain(t('tool.label'));
        expect(html).toContain('Find button components');
        expect(await searchTool.renderToolCall(call)).toContain(t('tool.label'));
        expect(await getTool.renderToolCall(call)).toContain(t('tool.label'));

        call.status = 'error';
        call.result = 'Gateway failed';
        call.setTool(callGateway);
        const errorHtml = await call.render();
        expect(errorHtml).toContain(t('tool.label'));
        expect(errorHtml).toContain('Find button components');
        expect(errorHtml).toContain('Gateway failed');
    });

    test('automatically unwraps incorrectly nested arguments (common AI mistake with query-wrapping)', async () => {
        const tools = [
            tool({
                inputSchema: {
                    type: 'object',
                    properties: {
                        query: { type: 'string' },
                        top_k: { type: 'integer', default: 5 }
                    },
                    required: ['query']
                }
            })
        ];
        const callTool = jest.fn(async () => 'ok');
        const callGateway = new McpCallToolTool(tools, callTool);

        // AI错误地把参数包装在query下，这是用户报告的问题
        await callGateway.execute({
            serverId: 'arkts-id',
            toolName: 'search_components',
            arguments: { query: { query: '获取所有屏幕显示信息', top_k: 10 } }
        });

        expect(callTool).toHaveBeenCalledWith(tools[0], { query: '获取所有屏幕显示信息', top_k: 10 });
    });

    test('reuses and preserves a server-defined description', async () => {
        const discoveredTools = [
            tool({
                inputSchema: {
                    type: 'object',
                    properties: { description: { type: 'string' }, name: { type: 'string' } },
                    required: ['description', 'name'],
                    additionalProperties: false
                }
            })
        ];
        const callWorker = jest.fn(async (methodName: string) =>
            methodName === 'getDiscoveredTools'
                ? { status: 'ok', data: discoveredTools }
                : { status: 'ok', data: 'called' }
        );
        const app = Object.create(McpMgrApplication.prototype) as McpMgrApplication;
        (app as any).callWorker = callWorker;
        const [toolset] = await app.getToolsets();
        const eager = toolset.getTool('arkts__search_components')!;

        expect(Object.keys(eager.getJsonSchema().properties)).toEqual(['description', 'name']);
        const result = await eager.execute({ description: 'Original data', name: 'item' });
        expect(result.status).toBe('success');
        expect(callWorker).toHaveBeenLastCalledWith('callMcpTool', 'arkts-id', 'search_components', {
            description: 'Original data',
            name: 'item'
        });
    });

    test('does not unwrap when wrapper key does not match nested schema keys', async () => {
        const tools = [tool()];
        const callTool = jest.fn(async () => 'ok');
        const callGateway = new McpCallToolTool(tools, callTool);

        // 当有不匹配的键时，不应该解包
        await callGateway.execute({
            serverId: 'arkts-id',
            toolName: 'search_components',
            arguments: { query: { wrong_key: 'value' } }
        });

        expect(callTool).toHaveBeenCalledWith(tools[0], { query: { wrong_key: 'value' } });
    });

    test('clamps oversized limit instead of rejecting it (AI may pass 20/30 when eager to find tools)', async () => {
        const tools = Array.from({ length: 20 }, (_, i) =>
            tool({ name: `tool_${i}`, description: `tool number ${i}` })
        );
        const searchTool = new McpSearchToolsTool(tools);

        const result = await searchTool.execute({ query: '', offset: 0, limit: 20 });
        const payload = JSON.parse(result.result);

        expect(payload.tools).toHaveLength(10);
        expect(payload.clamped).toBe(true);
        expect(payload.effectiveLimit).toBe(10);
        expect(payload.nextOffset).toBe(10);
        expect(typeof payload.hint).toBe('string');
        expect(payload.hint.length).toBeGreaterThan(0);
    });

    test('application exposes gateway tools instead of a large server definition set', async () => {
        const discoveredTools = [
            tool({
                serverId: 'small-id',
                serverName: 'small',
                name: 'ping',
                description: 'Ping a service'
            }),
            tool({
                name: 'search_components',
                description: 'A'.repeat(20_000)
            })
        ];
        const callWorker = jest.fn(async (methodName: string) => {
            if (methodName === 'getDiscoveredTools') {
                return { status: 'ok', data: discoveredTools };
            }
            if (methodName === 'callMcpTool') {
                return { status: 'ok', data: 'called' };
            }
            return { status: 'error', message: 'unexpected worker method' };
        });
        const app = Object.create(McpMgrApplication.prototype) as McpMgrApplication;
        (app as any).callWorker = callWorker;

        const [toolset] = await app.getToolsets();
        const names = Array.from(toolset.getTools().keys());

        expect(names).toEqual(expect.arrayContaining(['small__ping', 'mcpSearchTools', 'mcpGetTool', 'mcpCallTool']));
        expect(names).not.toContain('arkts__search_components');

        const eager = toolset.getTool('small__ping')!;
        expect(eager.getJsonSchema().properties.description).toEqual(expect.objectContaining({ type: 'string' }));
        const eagerResult = await eager.execute({ query: 'test', description: 'Check availability' });
        expect(eagerResult.status).toBe('success');
        expect(callWorker).toHaveBeenLastCalledWith('callMcpTool', 'small-id', 'ping', {
            query: 'test',
            description: 'Check availability'
        });

        const result = await toolset.callTool('mcpCallTool', {
            serverId: 'arkts-id',
            toolName: 'search_components',
            arguments: { query: 'Button' }
        });
        expect(result.result).toBe('called');
        expect(callWorker).toHaveBeenLastCalledWith('callMcpTool', 'arkts-id', 'search_components', {
            query: 'Button'
        });
    });
});
