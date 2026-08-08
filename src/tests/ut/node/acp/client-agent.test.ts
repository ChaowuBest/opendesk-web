import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRegistry } from '../../../../main/aikernel/agents/registry.js';
import { createAcpAgentDeclarations, resolveAcpMcpServers } from '../../../../main/applications/acpmgr/agent.js';
import { AcpAgentProfileSchema, AcpMgrConfigSchema } from '../../../../main/applications/acpmgr/common.js';

const enabledProfile = AcpAgentProfileSchema.parse({
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Codex ACP',
    dispatchable: true,
    whenToUse: 'Use for repository changes',
    transport: { type: 'stdio', command: 'codex', args: ['acp'] }
});

const disabledProfile = AcpAgentProfileSchema.parse({
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Paused Remote',
    enabled: false,
    dispatchable: true,
    transport: { type: 'streamableHttp', url: 'https://agents.example.com/acp' }
});

test('ACP profiles become scoped AgentDecl instances and disabled profiles remain resolvable', async (context) => {
    const agents = createAcpAgentDeclarations([enabledProfile, disabledProfile], async () => []);
    await AgentRegistry.replaceApplicationAgents([{ bundleName: 'acpmgr', agents }]);
    context.after(async () => AgentRegistry.unloadApplicationAgents());

    const enabled = AgentRegistry.getAgent(`acpmgr:${enabledProfile.id}`);
    const disabled = AgentRegistry.getAgent(`acpmgr:${disabledProfile.id}`);
    assert.equal(enabled?.dispatchable, true);
    assert.equal(enabled?.whenToUse, 'Use for repository changes');
    assert.equal(enabled?.createTaskRuntime({} as any)?.kind, 'acp');
    assert.equal(disabled?.dispatchable, false);
    assert.ok(disabled, 'disabled profiles stay registered so saved tasks do not fall back to main');
});

test('ACP manager config rejects duplicate stable profile ids', () => {
    assert.throws(() => AcpMgrConfigSchema.parse({ agents: [enabledProfile, enabledProfile] }), /duplicate/i);
});

test('selected MCP manager entries are converted to ACP SDK server shapes', () => {
    const profile = AcpAgentProfileSchema.parse({
        ...enabledProfile,
        session: { mcpServerIds: ['stdio-1', 'http-1'] }
    });
    const result = resolveAcpMcpServers(
        profile,
        [
            {
                id: 'stdio-1',
                name: 'filesystem',
                enabled: true,
                transport: 'stdio',
                command: 'node',
                args: ['server.js'],
                env: { TOKEN: '${env:MCP_TOKEN}' },
                headers: {}
            },
            {
                id: 'http-1',
                name: 'remote-mcp',
                enabled: true,
                transport: 'streamableHttp',
                url: 'https://mcp.example.com',
                args: [],
                env: {},
                headers: { Authorization: 'Bearer ${env:MCP_TOKEN}' }
            },
            {
                id: 'ignored',
                name: 'ignored',
                enabled: true,
                transport: 'stdio',
                command: 'ignored',
                args: [],
                env: {},
                headers: {}
            }
        ],
        { MCP_TOKEN: 'secret' }
    );

    assert.deepEqual(result, [
        {
            name: 'filesystem',
            command: 'node',
            args: ['server.js'],
            env: [{ name: 'TOKEN', value: 'secret' }]
        },
        {
            type: 'http',
            name: 'remote-mcp',
            url: 'https://mcp.example.com',
            headers: [{ name: 'Authorization', value: 'Bearer secret' }]
        }
    ]);
});
