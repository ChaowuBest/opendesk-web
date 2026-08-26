import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
    InitializeRequest,
    NewSessionRequest,
    PromptRequest,
    RequestPermissionRequest
} from '@agentclientprotocol/sdk';
import * as acpV2 from '@agentclientprotocol/sdk/experimental/v2';
import type { AcpTaskRuntimeTurnRequest } from '../../../../main/applications/acpmgr/runtime/types.js';
import type {
    AcpClientConnection,
    AcpClientHandlers,
    AcpConnectionHandle
} from '../../../../main/applications/acpmgr/runtime/connection.js';
import { AcpTaskRuntime } from '../../../../main/applications/acpmgr/runtime/session.js';
import { createV2ConnectionHandle } from '../../../../main/applications/acpmgr/runtime/connection-v2.js';
import { AcpAgentProfileSchema } from '../../../../main/applications/acpmgr/common.js';

const profile = AcpAgentProfileSchema.parse({
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Test Agent',
    transport: { type: 'stdio', command: 'test-agent' },
    session: { modeId: 'code', configOptions: { reasoning: 'high', autoApprove: false } }
});

class FakeConnection implements AcpClientConnection {
    calls: Array<{ method: string; params: unknown }> = [];
    handlers?: AcpClientHandlers;
    capabilities: any = { sessionCapabilities: { resume: {} }, loadSession: true };
    authMethods: any[] = [];

    async initialize(params: InitializeRequest): Promise<any> {
        this.calls.push({ method: 'initialize', params });
        return {
            protocolVersion: 1,
            agentCapabilities: this.capabilities,
            authMethods: this.authMethods,
            agentInfo: { name: 'fake-agent', version: '1.0.0' }
        };
    }

    async authenticate(params: any): Promise<any> {
        this.calls.push({ method: 'authenticate', params });
        return {};
    }

    async newSession(params: NewSessionRequest): Promise<any> {
        this.calls.push({ method: 'session/new', params });
        return { sessionId: 'session-1' };
    }

    async loadSession(params: any): Promise<any> {
        this.calls.push({ method: 'session/load', params });
        return {};
    }

    async resumeSession(params: any): Promise<any> {
        this.calls.push({ method: 'session/resume', params });
        return {};
    }

    async setSessionMode(params: any): Promise<any> {
        this.calls.push({ method: 'session/set_mode', params });
        return {};
    }

    async setSessionConfigOption(params: any): Promise<any> {
        this.calls.push({ method: 'session/set_config_option', params });
        return { configOptions: [] };
    }

    async prompt(params: PromptRequest): Promise<any> {
        this.calls.push({ method: 'session/prompt', params });
        await this.handlers?.sessionUpdate({
            sessionId: params.sessionId,
            update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Remote answer' }
            }
        });
        return { stopReason: 'end_turn' };
    }

    async cancel(params: any): Promise<void> {
        this.calls.push({ method: 'session/cancel', params });
    }
}

function makeRequest(
    overrides: Partial<AcpTaskRuntimeTurnRequest> = {}
): AcpTaskRuntimeTurnRequest & { updates: unknown[]; checkpoints: Record<string, unknown>[] } {
    const updates: unknown[] = [];
    const checkpoints: Record<string, unknown>[] = [];
    return {
        taskId: 'task-1',
        prompt: 'Do work',
        workspace: '/workspace',
        signal: new AbortController().signal,
        onUpdate: async (update) => {
            updates.push(update);
        },
        checkpoint: async (state) => {
            checkpoints.push(structuredClone(state));
        },
        requestPermission: async (request) => ({
            outcome: request.options[0]
                ? { outcome: 'selected', optionId: request.options[0].optionId }
                : { outcome: 'cancelled' }
        }),
        ...overrides,
        updates,
        checkpoints
    };
}

function createRuntime(
    directory: string,
    connection: FakeConnection,
    logs: string[] = [],
    runtimeProfile = profile
): AcpTaskRuntime {
    return new AcpTaskRuntime(runtimeProfile, {
        artifactDirectory: () => directory,
        createConnection: async (_profile, handlers): Promise<AcpConnectionHandle> => {
            connection.handlers = handlers;
            return {
                connection,
                closed: new Promise(() => undefined),
                close: async () => undefined
            };
        },
        resolveMcpServers: async () => [],
        log: {
            info: (message) => logs.push(message),
            warn: (message) => logs.push(message)
        }
    });
}

test('ACP HTTP Agent execution uses the configured remote cwd and advertises no Client runtime', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-acp-remote-workspace-'));
    try {
        const connection = new FakeConnection();
        const remoteProfile = AcpAgentProfileSchema.parse({
            ...profile,
            transport: { type: 'streamableHttp', url: 'https://agent.example.com/acp' },
            execution: {
                location: 'agent',
                workspace: { strategy: 'fixed', path: '/srv/workspaces/project', platform: 'posix' }
            }
        });
        const runtime = createRuntime(directory, connection, [], remoteProfile);
        const request = makeRequest({ workspace: 'D:\\private\\project' });

        const result = await runtime.runTurn(request);

        const initialize = connection.calls.find((call) => call.method === 'initialize')?.params as InitializeRequest;
        const session = connection.calls.find((call) => call.method === 'session/new')?.params as NewSessionRequest;
        assert.deepEqual(initialize.clientCapabilities, { session: { configOptions: { boolean: {} } } });
        assert.equal(session.cwd, '/srv/workspaces/project');
        assert.equal((result.state as any).executionLocation, 'agent');
        assert.equal((result.state as any).sessionCwd, '/srv/workspaces/project');
        assert.equal(typeof (result.state as any).executionFingerprint, 'string');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('ACP HTTP Client execution advertises v1 filesystem and terminal capabilities', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-acp-client-workspace-'));
    try {
        const connection = new FakeConnection();
        const localProfile = AcpAgentProfileSchema.parse({
            ...profile,
            transport: { type: 'streamableHttp', url: 'https://agent.example.com/acp' },
            execution: {
                location: 'client',
                workspace: { strategy: 'task' },
                compatibility: 'required'
            }
        });
        const runtime = createRuntime(directory, connection, [], localProfile);

        await runtime.runTurn(makeRequest({ workspace: directory }));

        const initialize = connection.calls.find((call) => call.method === 'initialize')?.params as InitializeRequest;
        const session = connection.calls.find((call) => call.method === 'session/new')?.params as NewSessionRequest;
        assert.deepEqual(initialize.clientCapabilities, {
            fs: { readTextFile: true, writeTextFile: true },
            terminal: true,
            session: { configOptions: { boolean: {} } }
        });
        assert.equal(session.cwd, directory);
        assert.equal(typeof connection.handlers?.readTextFile, 'function');
        assert.equal(typeof connection.handlers?.createTerminal, 'function');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('ACP v2 runtime serves the local workspace to a remote Agent through MCP-over-ACP', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-acp-v2-runtime-'));
    const file = path.join(directory, 'message.txt');
    fs.writeFileSync(file, 'hello from OpenDesk');
    let mcpConnectionId = '';
    try {
        const v2Profile = AcpAgentProfileSchema.parse({
            ...profile,
            protocolVersion: 2,
            transport: { type: 'streamableHttp', url: 'https://agent.example.com/acp' },
            execution: {
                location: 'client',
                workspace: { strategy: 'task' },
                compatibility: 'required',
                agentSessionCwd: { path: '/agent/workspace', platform: 'posix' }
            },
            session: { configOptions: {}, mcpBindings: [] }
        });
        const agent = acpV2
            .agent({ name: 'workspace-reader' })
            .onRequest(acpV2.methods.agent.initialize, () => ({
                protocolVersion: 2,
                info: { name: 'workspace-reader', version: '1.0.0' },
                capabilities: { session: { mcp: { acp: {} } } }
            }))
            .onRequest(acpV2.methods.agent.session.new, async (context) => {
                const workspaceServer = context.params.mcpServers?.find((server) => server.type === 'acp') as
                    | acpV2.McpServerAcp
                    | undefined;
                assert.ok(workspaceServer);
                const connected = await context.client.request(acpV2.methods.client.mcp.connect, {
                    serverId: workspaceServer.serverId
                });
                mcpConnectionId = connected.connectionId;
                await context.client.request(acpV2.methods.client.mcp.message, {
                    connectionId: mcpConnectionId,
                    method: 'initialize',
                    params: {
                        protocolVersion: '2025-11-25',
                        capabilities: {},
                        clientInfo: { name: 'workspace-reader', version: '1.0.0' }
                    }
                });
                await context.client.notify(acpV2.methods.client.mcp.message, {
                    connectionId: mcpConnectionId,
                    method: 'notifications/initialized'
                });
                return { sessionId: 'session-v2', configOptions: [] };
            })
            .onRequest(acpV2.methods.agent.session.prompt, async (context) => {
                const result = (await context.client.request(acpV2.methods.client.mcp.message, {
                    connectionId: mcpConnectionId,
                    method: 'tools/call',
                    params: { name: 'read_text_file', arguments: { path: 'message.txt' } }
                })) as any;
                await context.client.notify(acpV2.methods.client.session.update, {
                    sessionId: context.params.sessionId,
                    update: {
                        sessionUpdate: 'agent_message_chunk',
                        messageId: 'message-v2',
                        content: { type: 'text', text: result.content[0].text }
                    }
                });
                await context.client.notify(acpV2.methods.client.session.update, {
                    sessionId: context.params.sessionId,
                    update: { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' }
                });
                return {};
            })
            .onRequest(acpV2.methods.agent.session.setConfigOption, () => ({ configOptions: [] }))
            .onRequest(acpV2.methods.agent.session.resume, () => ({ configOptions: [] }))
            .onRequest(acpV2.methods.agent.session.close, () => ({}))
            .onNotification(acpV2.methods.agent.session.cancel, () => undefined);
        const runtime = new AcpTaskRuntime(v2Profile, {
            artifactDirectory: () => directory,
            createConnection: async (configuredProfile, handlers) =>
                createV2ConnectionHandle(configuredProfile, handlers, agent),
            resolveMcpServers: async () => []
        });
        const request = makeRequest({
            workspace: directory,
            requestPermission: async (permission) => ({
                outcome: { outcome: 'selected', optionId: permission.options[0].optionId }
            })
        });

        const result = await runtime.runTurn(request);

        assert.equal(result.stopReason, 'completed');
        assert.deepEqual(request.updates, [
            { type: 'message_delta', text: 'hello from OpenDesk', messageId: 'message-v2' }
        ]);
        await runtime.dispose();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('ACP runtime creates a session, applies configured parameters, and checkpoints locally', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-acp-runtime-'));
    try {
        const connection = new FakeConnection();
        const logs: string[] = [];
        const runtime = createRuntime(directory, connection, logs);
        const request = makeRequest();

        const result = await runtime.runTurn(request);

        assert.equal(result.stopReason, 'completed');
        assert.deepEqual(request.updates, [{ type: 'message_delta', text: 'Remote answer' }]);
        assert.deepEqual(
            connection.calls.map((call) => call.method),
            [
                'initialize',
                'session/new',
                'session/set_mode',
                'session/set_config_option',
                'session/set_config_option',
                'session/prompt'
            ]
        );
        assert.equal((result.state as any).sessionId, 'session-1');
        assert.equal((result.state as any).phase, 'idle');
        assert.equal((result.state as any).safeProfile.transport.type, 'stdio');
        assert.equal('env' in (result.state as any).safeProfile.transport, false);
        assert.ok(request.checkpoints.length >= 3);
        assert.ok(fs.existsSync(path.join(directory, 'acp', 'events.jsonl')));
        assert.ok(logs.some((message) => message.includes('dispatch started') && message.includes(profile.id)));
        assert.ok(logs.some((message) => message.includes('dispatch completed') && message.includes('task-1')));
        assert.ok(logs.every((message) => !message.includes(request.prompt)));
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('ACP runtime authenticates with the configured protocol method before creating a session', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-acp-auth-'));
    try {
        const connection = new FakeConnection();
        connection.authMethods = [{ id: 'agent-login', name: 'Agent login' }];
        const authenticatedProfile = AcpAgentProfileSchema.parse({
            ...profile,
            session: { ...profile.session, authMethodId: 'agent-login' }
        });
        const runtime = createRuntime(directory, connection, [], authenticatedProfile);

        await runtime.runTurn(makeRequest());

        assert.deepEqual(
            connection.calls.slice(0, 3).map((call) => call.method),
            ['initialize', 'authenticate', 'session/new']
        );
        assert.deepEqual(connection.calls[1].params, { methodId: 'agent-login' });
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('ACP runtime times out connection initialization', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-acp-connect-timeout-'));
    try {
        const connection = new FakeConnection();
        connection.initialize = async (params) => {
            connection.calls.push({ method: 'initialize', params });
            return new Promise(() => undefined);
        };
        const timeoutProfile = AcpAgentProfileSchema.parse({
            ...profile,
            reconnect: { enabled: false, maxAttempts: 0, initialDelayMs: 0, maxDelayMs: 0 },
            timeouts: { connectMs: 100, promptMs: 1000 }
        });
        const runtime = createRuntime(directory, connection, [], timeoutProfile);

        await assert.rejects(runtime.runTurn(makeRequest()), /timed out|超时/i);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('ACP runtime cancels a prompt that exceeds its configured timeout', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-acp-prompt-timeout-'));
    try {
        const connection = new FakeConnection();
        connection.prompt = async (params) => {
            connection.calls.push({ method: 'session/prompt', params });
            return new Promise(() => undefined);
        };
        const timeoutProfile = AcpAgentProfileSchema.parse({
            ...profile,
            reconnect: { enabled: false, maxAttempts: 0, initialDelayMs: 0, maxDelayMs: 0 },
            timeouts: { connectMs: 1000, promptMs: 100 }
        });
        const runtime = createRuntime(directory, connection, [], timeoutProfile);

        await assert.rejects(runtime.runTurn(makeRequest()), /timed out|超时/i);
        assert.equal(
            connection.calls.some((call) => call.method === 'session/cancel'),
            true
        );
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('ACP runtime rejects a configured value that the Agent no longer advertises', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-acp-runtime-invalid-option-'));
    try {
        const connection = new FakeConnection();
        connection.newSession = async (params: NewSessionRequest): Promise<any> => {
            connection.calls.push({ method: 'session/new', params });
            return {
                sessionId: 'session-1',
                configOptions: [
                    {
                        id: 'model',
                        name: 'Model',
                        type: 'select',
                        currentValue: 'provider/available',
                        options: [{ value: 'provider/available', name: 'Available' }]
                    }
                ]
            };
        };
        const invalidProfile = AcpAgentProfileSchema.parse({
            ...profile,
            session: { configOptions: { model: 'provider/removed' } }
        });
        const runtime = new AcpTaskRuntime(invalidProfile, {
            artifactDirectory: () => directory,
            createConnection: async (_profile, handlers): Promise<AcpConnectionHandle> => {
                connection.handlers = handlers;
                return {
                    connection,
                    closed: new Promise(() => undefined),
                    close: async () => undefined
                };
            },
            resolveMcpServers: async () => []
        });

        await assert.rejects(
            () => runtime.runTurn(makeRequest()),
            /does not support value|不支持值|not advertised|未被 Agent 公布/
        );
        assert.deepEqual(
            connection.calls.map((call) => call.method),
            ['initialize', 'session/new']
        );
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('ACP runtime resumes an idle persisted session without creating a new one', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-acp-resume-'));
    try {
        const connection = new FakeConnection();
        const runtime = createRuntime(directory, connection);
        const request = makeRequest({
            persistedState: {
                schemaVersion: 1,
                profileId: profile.id,
                sessionId: 'saved-session',
                phase: 'idle'
            }
        });

        await runtime.runTurn(request);

        assert.equal(
            connection.calls.some((call) => call.method === 'session/resume'),
            true
        );
        assert.equal(
            connection.calls.some((call) => call.method === 'session/new'),
            false
        );
        assert.equal(
            (connection.calls.find((call) => call.method === 'session/prompt')?.params as any).sessionId,
            'saved-session'
        );
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('ACP runtime starts a new session when the persisted execution fingerprint changed', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-acp-fingerprint-'));
    try {
        const firstConnection = new FakeConnection();
        const firstRuntime = createRuntime(directory, firstConnection);
        const firstResult = await firstRuntime.runTurn(makeRequest({ workspace: directory }));

        const nextConnection = new FakeConnection();
        const changedProfile = AcpAgentProfileSchema.parse({
            ...profile,
            execution: {
                location: 'client',
                workspace: { strategy: 'fixed', path: directory },
                compatibility: 'required'
            },
            session: {
                ...profile.session,
                mcpPolicy: 'custom',
                mcpBindings: [{ serverId: 'new-mcp', location: 'agent' }]
            }
        });
        const nextRuntime = createRuntime(directory, nextConnection, [], changedProfile);
        await nextRuntime.runTurn(makeRequest({ workspace: directory, persistedState: firstResult.state }));

        assert.equal(
            nextConnection.calls.some((call) => call.method === 'session/new'),
            true
        );
        assert.equal(
            nextConnection.calls.some((call) => call.method === 'session/resume'),
            false
        );
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('ACP runtime clears the active turn when workspace mapping fails before connection', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-acp-workspace-failure-'));
    try {
        const connection = new FakeConnection();
        const mappedProfile = AcpAgentProfileSchema.parse({
            ...profile,
            transport: { type: 'streamableHttp', url: 'https://agent.example.com/acp' },
            execution: {
                location: 'agent',
                workspace: {
                    strategy: 'mapped',
                    localRoot: directory,
                    remoteRoot: '/workspace',
                    platform: 'posix'
                }
            }
        });
        const runtime = createRuntime(directory, connection, [], mappedProfile);
        const outside = path.resolve(directory, '..', 'outside');

        await assert.rejects(runtime.runTurn(makeRequest({ workspace: outside })), /mapping|映射/i);
        await assert.rejects(runtime.runTurn(makeRequest({ workspace: outside })), /mapping|映射/i);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('ACP runtime loads an uncertain session and does not blindly resend a failed prompt', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-acp-load-'));
    try {
        const connection = new FakeConnection();
        connection.prompt = async (params) => {
            connection.calls.push({ method: 'session/prompt', params });
            throw new Error('connection closed');
        };
        const runtime = createRuntime(directory, connection);
        const first = makeRequest();
        await assert.rejects(runtime.runTurn(first), /connection closed/);
        assert.equal((first.checkpoints.at(-1) as any).phase, 'uncertain');

        const nextConnection = new FakeConnection();
        const nextRuntime = createRuntime(directory, nextConnection);
        const next = makeRequest({ persistedState: first.checkpoints.at(-1) });
        await nextRuntime.runTurn(next);

        assert.equal(
            nextConnection.calls.some((call) => call.method === 'session/load'),
            true
        );
        assert.equal(nextConnection.calls.filter((call) => call.method === 'session/prompt').length, 1);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('ACP runtime preserves an uncertain checkpoint when reconnect initialization fails', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-acp-reconnect-fail-'));
    try {
        const connection = new FakeConnection();
        connection.initialize = async (params) => {
            connection.calls.push({ method: 'initialize', params });
            throw new Error('agent unavailable');
        };
        const runtime = createRuntime(directory, connection);
        const request = makeRequest({
            persistedState: {
                schemaVersion: 1,
                profileId: profile.id,
                sessionId: 'uncertain-session',
                phase: 'uncertain'
            }
        });

        await assert.rejects(runtime.runTurn(request), /agent unavailable/);

        assert.equal((request.checkpoints.at(-1) as any).phase, 'uncertain');
        assert.equal((request.checkpoints.at(-1) as any).sessionId, 'uncertain-session');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('ACP runtime reconnects before the next turn when an idle transport closes', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-acp-idle-close-'));
    try {
        const connections = [new FakeConnection(), new FakeConnection()];
        let connectionIndex = 0;
        let closeTransport: (() => void) | undefined;
        const runtime = new AcpTaskRuntime(profile, {
            artifactDirectory: () => directory,
            createConnection: async (_profile, handlers): Promise<AcpConnectionHandle> => {
                const connection = connections[connectionIndex++];
                connection.handlers = handlers;
                return {
                    connection,
                    closed: new Promise<void>((resolve) => {
                        closeTransport = resolve;
                    }),
                    close: async () => undefined
                };
            },
            resolveMcpServers: async () => []
        });

        const first = makeRequest();
        const firstResult = await runtime.runTurn(first);
        closeTransport?.();
        await Promise.resolve();
        const second = makeRequest({ persistedState: firstResult.state });
        await runtime.runTurn(second);

        assert.equal(connectionIndex, 2);
        assert.equal(
            connections[1].calls.some((call) => call.method === 'session/resume'),
            true
        );
        assert.equal(connections[0].calls.filter((call) => call.method === 'session/prompt').length, 1);
        assert.equal(connections[1].calls.filter((call) => call.method === 'session/prompt').length, 1);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('ACP v2 reconnect rebuilds the Client-hosted MCP runtime after initialization failure', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-acp-v2-retry-mcp-'));
    try {
        const v2Profile = AcpAgentProfileSchema.parse({
            ...profile,
            protocolVersion: 2,
            transport: { type: 'streamableHttp', url: 'https://agent.example.com/acp' },
            execution: {
                location: 'client',
                workspace: { strategy: 'task' },
                compatibility: 'required',
                agentSessionCwd: { path: '/agent/workspace', platform: 'posix' }
            },
            reconnect: { enabled: true, maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 },
            timeouts: { connectMs: 1000, promptMs: 1000 }
        });
        let attempt = 0;
        const hostedServers: unknown[] = [];
        const runtime = new AcpTaskRuntime(v2Profile, {
            artifactDirectory: () => directory,
            sleep: async () => undefined,
            createConnection: async (_configuredProfile, handlers): Promise<AcpConnectionHandle> => {
                attempt += 1;
                hostedServers.push(handlers.clientMcpServer);
                const connection = new FakeConnection();
                connection.initialize = async (params) => {
                    connection.calls.push({ method: 'initialize', params });
                    if (attempt === 1) throw new Error('retry initialization');
                    return {
                        protocolVersion: 2,
                        agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } }
                    };
                };
                connection.handlers = handlers;
                return {
                    connection,
                    closed: new Promise(() => undefined),
                    close: async () => undefined
                };
            },
            resolveMcpServers: async () => []
        });

        await runtime.runTurn(makeRequest({ workspace: directory }));

        assert.equal(attempt, 2);
        assert.ok(hostedServers[0]);
        assert.ok(hostedServers[1]);
        assert.notEqual((hostedServers[0] as any).serverId, (hostedServers[1] as any).serverId);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('ACP runtime bridges exact permission option ids through the host prompt queue', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-acp-permission-'));
    try {
        const connection = new FakeConnection();
        connection.prompt = async (params) => {
            connection.calls.push({ method: 'session/prompt', params });
            const permission: RequestPermissionRequest = {
                sessionId: params.sessionId,
                toolCall: {
                    toolCallId: 'call-1',
                    title: 'Edit file',
                    kind: 'edit',
                    locations: [{ path: '/workspace/a.ts' }]
                },
                options: [
                    { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
                    { optionId: 'no', name: 'Reject', kind: 'reject_once' }
                ]
            };
            const response = await connection.handlers?.requestPermission(permission);
            assert.deepEqual(response, { outcome: { outcome: 'selected', optionId: 'yes' } });
            return { stopReason: 'end_turn' };
        };
        const runtime = createRuntime(directory, connection);
        let bridgedRequest: any;
        const request = makeRequest({
            requestPermission: async (permission) => {
                bridgedRequest = permission;
                return { outcome: { outcome: 'selected', optionId: 'yes' } };
            }
        });

        await runtime.runTurn(request);

        assert.equal(bridgedRequest.toolCall.toolCallId, 'call-1');
        assert.equal(bridgedRequest.toolCall.kind, 'edit');
        assert.deepEqual(
            bridgedRequest.options.map((option: any) => option.optionId),
            ['yes', 'no']
        );
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
