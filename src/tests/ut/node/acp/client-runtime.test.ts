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
import type { AgentTaskRuntimeTurnRequest } from '../../../../main/aikernel/agents/common.js';
import type {
    AcpClientConnection,
    AcpClientHandlers,
    AcpConnectionHandle
} from '../../../../main/aikernel/agents/acp/connection.js';
import { AcpTaskRuntime } from '../../../../main/aikernel/agents/acp/runtime.js';
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
    overrides: Partial<AgentTaskRuntimeTurnRequest> = {}
): AgentTaskRuntimeTurnRequest & { updates: unknown[]; checkpoints: Record<string, unknown>[] } {
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
        requestPermission: async (request) => ({ outcome: 'selected', optionId: request.options[0]?.id }),
        ...overrides,
        updates,
        checkpoints
    };
}

function createRuntime(directory: string, connection: FakeConnection): AcpTaskRuntime {
    return new AcpTaskRuntime(profile, {
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
}

test('ACP runtime creates a session, applies configured parameters, and checkpoints locally', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-acp-runtime-'));
    try {
        const connection = new FakeConnection();
        const runtime = createRuntime(directory, connection);
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
                return { outcome: 'selected', optionId: 'yes' };
            }
        });

        await runtime.runTurn(request);

        assert.equal(bridgedRequest.toolCallId, 'call-1');
        assert.equal(bridgedRequest.resourceType, 'file');
        assert.equal(bridgedRequest.action, 'write');
        assert.deepEqual(
            bridgedRequest.options.map((option: any) => option.id),
            ['yes', 'no']
        );
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
