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
import type { AcpTaskRuntimeTurnRequest } from '../../../../main/applications/acpmgr/runtime/types.js';
import type {
    AcpClientConnection,
    AcpClientHandlers,
    AcpConnectionHandle
} from '../../../../main/applications/acpmgr/runtime/connection.js';
import { AcpTaskRuntime } from '../../../../main/applications/acpmgr/runtime/session.js';
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

    async initialize(params: InitializeRequest): Promise<any> {
        this.calls.push({ method: 'initialize', params });
        return {
            protocolVersion: 1,
            agentCapabilities: this.capabilities,
            agentInfo: { name: 'fake-agent', version: '1.0.0' }
        };
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
        assert.deepEqual(initialize.clientCapabilities, {});
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
            terminal: true
        });
        assert.equal(session.cwd, directory);
        assert.equal(typeof connection.handlers?.readTextFile, 'function');
        assert.equal(typeof connection.handlers?.createTerminal, 'function');
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
            session: { ...profile.session, mcpBindings: [{ serverId: 'new-mcp', location: 'agent' }] }
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
