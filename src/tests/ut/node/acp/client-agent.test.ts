import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { RequestError } from '@agentclientprotocol/sdk';
import { AgentRegistry } from '../../../../main/aikernel/agents/registry.js';
import {
    ACP_ACTIVE_PROFILE_IDS_ENV,
    addActiveAcpProfile,
    getActiveAcpProfileIds
} from '../../../../main/applications/acpmgr/runtime/connection.js';
import {
    AcpAgentDecl,
    createAcpAgentDeclarations,
    resolveAcpMcpServers
} from '../../../../main/applications/acpmgr/agent.js';
import { AcpMgrApplication } from '../../../../main/applications/acpmgr/app.js';
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
    assert.equal(enabled instanceof AcpAgentDecl, true);
    assert.equal(disabled?.dispatchable, false);
    assert.ok(disabled, 'disabled profiles stay registered so saved tasks do not fall back to main');
});

test('ACP manager registers configured agents during lazy application loading', async (context) => {
    const logs: string[] = [];
    const application = new AcpMgrApplication({
        log: {
            info: (message) => logs.push(message),
            error: (message) => logs.push(message)
        }
    });
    application.getConfig = () => ({ agents: [enabledProfile] });
    context.after(async () => AgentRegistry.unloadApplicationAgents());

    await application.ensureLoaded();

    assert.ok(AgentRegistry.getAgent(`acpmgr:${enabledProfile.id}`));
    assert.ok(logs.some((message) => message.includes('agent added') && message.includes(enabledProfile.id)));
    assert.ok(
        logs.some((message) => message.includes('registration completed') && message.includes(enabledProfile.name))
    );
    assert.ok(logs.some((message) => message.includes('registry refresh completed')));
    assert.ok(logs.every((message) => !message.includes(enabledProfile.transport.command)));
});

test('ACP dispatch ancestry is inherited without mutating the source environment', () => {
    const environ = { [ACP_ACTIVE_PROFILE_IDS_ENV]: JSON.stringify([enabledProfile.id]) };

    const childEnviron = addActiveAcpProfile(environ, disabledProfile.id);

    assert.deepEqual([...getActiveAcpProfileIds(childEnviron)], [enabledProfile.id, disabledProfile.id]);
    assert.deepEqual([...getActiveAcpProfileIds(environ)], [enabledProfile.id]);
});

test('ACP manager keeps an active ancestor profile registered but prevents recursive dispatch', async (context) => {
    const previous = process.env[ACP_ACTIVE_PROFILE_IDS_ENV];
    process.env[ACP_ACTIVE_PROFILE_IDS_ENV] = JSON.stringify([enabledProfile.id]);
    const application = new AcpMgrApplication();
    application.getConfig = () => ({ agents: [enabledProfile] });
    context.after(async () => AgentRegistry.unloadApplicationAgents());

    try {
        await application.ensureLoaded();

        const agent = AgentRegistry.getAgent(`acpmgr:${enabledProfile.id}`);
        assert.ok(agent);
        assert.equal(agent.dispatchable, false);
    } finally {
        if (previous === undefined) {
            delete process.env[ACP_ACTIVE_PROFILE_IDS_ENV];
        } else {
            process.env[ACP_ACTIVE_PROFILE_IDS_ENV] = previous;
        }
    }
});

test('ACP manager refreshes registered agents after its configuration changes', async (context) => {
    const application = new AcpMgrApplication();
    let config = { agents: [enabledProfile] };
    application.getConfig = () => config;
    context.after(async () => AgentRegistry.unloadApplicationAgents());

    await application.ensureLoaded();
    config = { agents: [disabledProfile] };
    application.onConfigChanged();
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(AgentRegistry.getAgent(`acpmgr:${enabledProfile.id}`), undefined);
    assert.ok(AgentRegistry.getAgent(`acpmgr:${disabledProfile.id}`));
});

test('ACP manager config rejects duplicate stable profile ids', () => {
    assert.throws(() => AcpMgrConfigSchema.parse({ agents: [enabledProfile, enabledProfile] }), /duplicate/i);
});

test('ACP agent test creates a disposable session and exposes its configuration', async () => {
    const calls: string[] = [];
    const application = new AcpMgrApplication({
        createConnection: async () => ({
            connection: {
                initialize: async () => {
                    calls.push('initialize');
                    return {
                        protocolVersion: 1,
                        agentCapabilities: { sessionCapabilities: { close: {} } },
                        authMethods: [{ id: 'login', name: 'Login', description: 'Run login' }],
                        agentInfo: { name: 'Fake Agent', version: '1.0.0' }
                    };
                },
                newSession: async (params: { cwd: string; mcpServers: unknown[] }) => {
                    calls.push(`session/new:${params.cwd}:${params.mcpServers.length}`);
                    return {
                        sessionId: 'temporary-session',
                        configOptions: [
                            {
                                id: 'model',
                                name: 'Model',
                                type: 'select',
                                category: 'model',
                                currentValue: 'provider/model',
                                options: [{ value: 'provider/model', name: 'Model' }]
                            }
                        ]
                    };
                },
                closeSession: async (params: { sessionId: string }) => {
                    calls.push(`session/close:${params.sessionId}`);
                }
            } as any,
            closed: Promise.resolve(),
            close: async () => {
                calls.push('transport/close');
            }
        }),
        log: { info: () => undefined, error: () => undefined }
    });

    const result = await application.testAgent(enabledProfile, 'D:/workspace');

    assert.equal((result.agentInfo as any).name, 'Fake Agent');
    assert.equal((result.authMethods as any[]).length, 1);
    assert.equal((result.configOptions as any[])[0].category, 'model');
    assert.deepEqual(calls, [
        'initialize',
        `session/new:${path.resolve('D:/workspace')}:0`,
        'session/close:temporary-session',
        'transport/close'
    ]);
});

test('ACP agent test skips unsupported session close and always releases resources', async () => {
    const calls: string[] = [];
    const application = new AcpMgrApplication({
        createConnection: async () => ({
            connection: {
                initialize: async () => ({ protocolVersion: 1, agentCapabilities: {} }),
                newSession: async () => ({ sessionId: 'baseline-session' }),
                closeSession: async () => {
                    calls.push('session/close');
                    throw new Error('must not be called');
                }
            } as any,
            closed: new Promise(() => undefined),
            close: async () => {
                calls.push('transport/close');
            }
        }),
        log: { info: () => undefined, error: () => undefined }
    });

    const result = await application.testAgent(enabledProfile, process.cwd());

    assert.equal(result.sessionId, 'baseline-session');
    assert.deepEqual(calls, ['transport/close']);
});

test('ACP agent test releases the transport when supported session close fails', async () => {
    const calls: string[] = [];
    const application = new AcpMgrApplication({
        createConnection: async () => ({
            connection: {
                initialize: async () => ({
                    protocolVersion: 1,
                    agentCapabilities: { sessionCapabilities: { close: {} } }
                }),
                newSession: async () => ({ sessionId: 'close-failure-session' }),
                closeSession: async () => {
                    calls.push('session/close');
                    throw new Error('cleanup failure');
                }
            } as any,
            closed: new Promise(() => undefined),
            close: async () => {
                calls.push('transport/close');
            }
        }),
        log: { info: () => undefined, error: () => undefined }
    });

    const result = await application.testAgent(enabledProfile, process.cwd());

    assert.equal(result.sessionId, 'close-failure-session');
    assert.deepEqual(calls, ['session/close', 'transport/close']);
});

test('ACP agent test authenticates and validates configured MCP servers', async () => {
    const calls: Array<{ method: string; params?: any }> = [];
    const application = new AcpMgrApplication({
        createConnection: async () => ({
            connection: {
                initialize: async () => ({
                    protocolVersion: 1,
                    agentCapabilities: {},
                    authMethods: [{ id: 'agent-login', name: 'Agent login' }]
                }),
                authenticate: async (params: any) => {
                    calls.push({ method: 'authenticate', params });
                    return {};
                },
                newSession: async (params: any) => {
                    calls.push({ method: 'session/new', params });
                    return { sessionId: 'authenticated-session' };
                }
            } as any,
            closed: new Promise(() => undefined),
            close: async () => undefined
        }),
        log: { info: () => undefined, error: () => undefined }
    });
    (application as any).resolveMcpServers = async () => [
        { name: 'filesystem', command: 'node', args: ['server.js'], env: [] }
    ];
    const authenticatedProfile = AcpAgentProfileSchema.parse({
        ...enabledProfile,
        session: {
            authMethodId: 'agent-login',
            mcpBindings: [{ serverId: 'filesystem', location: 'agent' }]
        }
    });

    await application.testAgent(authenticatedProfile, process.cwd());

    assert.deepEqual(calls[0], { method: 'authenticate', params: { methodId: 'agent-login' } });
    assert.equal(calls[1].params.mcpServers.length, 1);
});

test('ACP agent test returns authentication choices when session creation requires login', async () => {
    const application = new AcpMgrApplication({
        createConnection: async () => ({
            connection: {
                initialize: async () => ({
                    protocolVersion: 1,
                    agentCapabilities: {},
                    authMethods: [{ id: 'agent-login', name: 'Agent login' }]
                }),
                newSession: async () => {
                    throw RequestError.authRequired();
                }
            } as any,
            closed: new Promise(() => undefined),
            close: async () => undefined
        }),
        log: { info: () => undefined, error: () => undefined }
    });

    const result = await application.testAgent(enabledProfile, process.cwd());

    assert.equal(result.authenticationRequired, true);
    assert.equal(result.sessionId, null);
    assert.equal((result.authMethods as any[])[0].id, 'agent-login');
});

test('selected MCP manager entries are converted to ACP SDK server shapes', () => {
    const profile = AcpAgentProfileSchema.parse({
        ...enabledProfile,
        session: {
            mcpBindings: [
                { serverId: 'stdio-1', location: 'agent' },
                { serverId: 'http-1', location: 'agent' }
            ]
        }
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

test('external MCP policy defaults to none and can inherit all enabled workspace servers', () => {
    const servers = [
        {
            id: 'enabled-stdio',
            name: 'enabled',
            enabled: true,
            transport: 'stdio' as const,
            command: 'node',
            args: ['server.js'],
            env: {},
            headers: {}
        },
        {
            id: 'disabled-http',
            name: 'disabled',
            enabled: false,
            transport: 'streamableHttp' as const,
            url: 'https://mcp.example.com',
            args: [],
            env: {},
            headers: {}
        }
    ];
    const none = AcpAgentProfileSchema.parse({
        ...enabledProfile,
        session: { mcpPolicy: 'none', mcpBindings: [{ serverId: 'enabled-stdio', location: 'agent' }] }
    });
    const inherited = AcpAgentProfileSchema.parse({
        ...enabledProfile,
        session: { mcpPolicy: 'enabled' }
    });

    assert.deepEqual(resolveAcpMcpServers(none, servers), []);
    assert.deepEqual(resolveAcpMcpServers(inherited, servers), [
        { name: 'enabled', command: 'node', args: ['server.js'], env: [] }
    ]);
});

test('Client-side MCP bindings are rejected until an OpenDesk proxy transport exists', () => {
    const profile = AcpAgentProfileSchema.parse({
        ...enabledProfile,
        session: { mcpBindings: [{ serverId: 'stdio-1', location: 'client' }] }
    });

    assert.throws(
        () =>
            resolveAcpMcpServers(profile, [
                {
                    id: 'stdio-1',
                    name: 'filesystem',
                    enabled: true,
                    transport: 'stdio',
                    command: 'node',
                    args: ['server.js'],
                    env: {},
                    headers: {}
                }
            ]),
        /proxy|代理|client/i
    );
});
