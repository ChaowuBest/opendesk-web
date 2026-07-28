import { jest } from '@jest/globals';
import { McpMgrApplication } from '../../../main/applications/mcpmgr/app.js';
import {
    McpCallToolTool,
    McpGetToolTool,
    McpSearchToolsTool,
    partitionMcpToolsForContext
} from '../../../main/applications/mcpmgr/mcp-gateway-tools.js';
import type { McpToolInfo } from '../../../main/applications/mcpmgr/common.js';

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
            arguments: { query: 'Button' }
        });
        expect(callResult.result).toBe('documentation result');
        expect(callTool).toHaveBeenCalledWith(tools[0], { query: 'Button' });
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
