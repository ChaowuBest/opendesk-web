import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { BaseTool, BaseToolset } from '../../../main/aikernel/tool.js';
import { TaskManagerState } from '../../../main/aikernel/task/manager.js';
import { TaskState } from '../../../main/aikernel/states/tasks.js';
import { buildToolsetsForTask } from '../../../main/aikernel/task/tool-resolver.js';
import { McpMgrApplication } from '../../../main/applications/mcpmgr/app.js';
import McpMgrWorker from '../../../main/applications/mcpmgr/worker.js';

function createApplicationToolset(): BaseToolset {
    const toolset = new BaseToolset('test');
    const universal = new BaseTool('universal', 'universal', z.object({}));
    const alphaOnly = new BaseTool('alphaOnly', 'alpha only', z.object({}));
    alphaOnly.agentIds = ['/agents/alpha'];
    const betaOnly = new BaseTool('betaOnly', 'beta only', z.object({}));
    betaOnly.agentIds = ['/agents/beta'];
    const hidden = new BaseTool('hidden', 'hidden', z.object({}));
    hidden.agentIds = [];
    toolset.addTools(universal, alphaOnly, betaOnly, hidden);
    return toolset;
}

async function applicationToolNames(agentId?: string): Promise<string[]> {
    const manager = new TaskManagerState();
    manager.toolsetProvider = {
        listAvailableToolsets: async () => [createApplicationToolset()]
    };
    const task = new TaskState(manager, 'parent-task');
    task.agentId = agentId;
    const toolsets = await buildToolsetsForTask(task);
    return [...(toolsets.find((toolset) => toolset.name === 'test')?.tools.keys() ?? [])];
}

test('agent tool exposure keeps universal tools and only the matching agent-scoped tools', async () => {
    assert.deepEqual(await applicationToolNames('/agents/alpha'), ['universal', 'alphaOnly']);
    assert.deepEqual(await applicationToolNames('/agents/beta'), ['universal', 'betaOnly']);
    assert.deepEqual(await applicationToolNames(), ['universal']);
});

test('MCPMgr parses agent MCP configs and attaches the source agent id without persisting them', async () => {
    const application = new McpMgrApplication();
    let workerMethod = '';
    let workerServers: Array<Record<string, unknown>> = [];
    application.setRegistry({
        callWorker: async (_bundleName: string, methodName: string, servers: Array<Record<string, unknown>>) => {
            workerMethod = methodName;
            workerServers = servers;
            return { status: 'ok', data: undefined };
        }
    });

    await application.replaceAgentServers([
        {
            agentId: '/agents/alpha',
            config: {
                servers: [
                    {
                        id: 'filesystem',
                        name: 'filesystem',
                        command: 'npx',
                        args: ['server-filesystem']
                    },
                    {
                        name: 'disabled',
                        enabled: false,
                        command: 'disabled'
                    }
                ]
            }
        },
        {
            agentId: '/agents/invalid',
            config: {
                servers: [{ name: 'missing-command' }]
            }
        }
    ]);

    assert.equal(workerMethod, 'replaceAgentServers');
    assert.equal(workerServers.length, 1);
    assert.deepEqual(workerServers[0].agentIds, ['/agents/alpha']);
    assert.equal(workerServers[0].name, 'filesystem');
    assert.match(String(workerServers[0].id), /^agent_[0-9a-f]{24}$/);
});

test('agent MCP tools use stable server-specific namespaces to avoid cross-agent collisions', async () => {
    const application = new McpMgrApplication();
    application.setRegistry({
        callWorker: async (_bundleName: string, methodName: string) => {
            assert.equal(methodName, 'getDiscoveredTools');
            return {
                status: 'ok',
                data: [
                    {
                        serverId: 'agent_aaaaaaaa',
                        serverName: 'filesystem',
                        name: 'read_file',
                        description: 'Read a file for alpha',
                        inputSchema: { type: 'object', properties: {} },
                        agentIds: ['/agents/alpha']
                    },
                    {
                        serverId: 'agent_bbbbbbbb',
                        serverName: 'filesystem',
                        name: 'read_file',
                        description: 'Read a file for beta',
                        inputSchema: { type: 'object', properties: {} },
                        agentIds: ['/agents/beta']
                    }
                ]
            };
        }
    });

    const [toolset] = await application.getToolsets();
    assert.deepEqual([...toolset.tools.keys()], ['filesystem_aaaaaaaa__read_file', 'filesystem_bbbbbbbb__read_file']);
});

test('BaseTool JSON round-trip preserves agent exposure metadata', () => {
    const tool = new BaseTool('scoped', 'scoped tool', z.object({}));
    tool.agentIds = ['/agents/alpha'];
    const restored = BaseTool.fromJSON(tool.toJSON());
    assert.deepEqual(restored.agentIds, ['/agents/alpha']);
});

test('MCPMgr worker lists both configured and agent-provided MCP servers', async () => {
    const worker = new McpMgrWorker('mcpmgr', '/tmp/mcpmgr-agent-tools-test');
    await worker.applicationConfigChanged({
        servers: [
            {
                id: 'configured',
                name: 'configured',
                transport: 'stdio',
                enabled: false
            }
        ]
    });
    await worker.replaceAgentServers([
        {
            id: 'agent-server',
            name: 'agent-server',
            transport: 'stdio',
            enabled: false,
            agentIds: ['/agents/alpha']
        }
    ]);

    const servers = (await worker.getServers()) as Array<{ id: string; agentIds?: string[] }>;
    assert.deepEqual(
        servers.map((server) => ({ id: server.id, agentIds: server.agentIds })),
        [
            { id: 'configured', agentIds: undefined },
            { id: 'agent-server', agentIds: ['/agents/alpha'] }
        ]
    );
});
