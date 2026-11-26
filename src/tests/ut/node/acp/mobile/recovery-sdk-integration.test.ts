import assert from 'node:assert/strict';
import test from 'node:test';
import * as acp from '@agentclientprotocol/sdk';
import type { Client } from '@agentclientprotocol/sdk';
import { MobileAcpAgentAdapter } from '../../../../../main/applications/mobileaccess/acp/mobile/acp-endpoint/agent-adapter.js';
import { MobileAcpConnectionHost } from '../../../../../main/applications/mobileaccess/acp/mobile/acp-endpoint/connection-host.js';
import {
    PublicSessionProjectionError,
    type PublicSessionState
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session.js';
import type {
    PublicSessionSyncHandle,
    PublicSessionSyncPhase
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session-sync.js';
import type { RemoteSessionService } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/service.js';
import { createAcpMessageStream } from '../../../../../main/applications/mobileaccess/acp/mobile/transport/acp-message-stream.js';
import { createTestChannelPair } from './test-channel.js';

const MESSAGE_ID = '550e8400-e29b-41d4-a716-446655440000';

class StaticSync implements PublicSessionSyncHandle {
    phase: PublicSessionSyncPhase = 'buffering';

    constructor(readonly sessionId: string) {}

    installFatalSink(): void {}

    async activate(): Promise<void> {
        this.phase = 'live';
    }

    stop(): void {
        this.phase = 'stopped';
    }
}

function snapshot(text: string): PublicSessionState {
    return {
        sessionId: 's1',
        title: 'Session',
        cwd: '/isolated/workspace',
        updatedAt: '2026-09-03T00:00:00.000Z',
        taskStatus: 'stopped',
        completionStatus: 'success',
        runToken: null,
        history: {
            messages: [
                {
                    role: 'assistant',
                    messageId: MESSAGE_ID,
                    parts: [{ type: 'text', text }]
                }
            ]
        }
    };
}

function serviceFor(connectionName: string): RemoteSessionService {
    return {
        async listSessions() {
            return [
                {
                    sessionId: 's1',
                    cwd: '/isolated/workspace',
                    title: 'Session',
                    updatedAt: '2026-09-03T00:00:00.000Z',
                    taskStatus: 'stopped',
                    completionStatus: 'success'
                }
            ];
        },
        beginSessionLoad(sessionId) {
            if (sessionId === 'missing') {
                throw new PublicSessionProjectionError('session_unavailable', 'missing fixture session');
            }
            return {
                snapshot: snapshot(`snapshot-${connectionName}`),
                sync: new StaticSync('s1')
            };
        },
        stopCurrentRun() {
            throw new Error('fixture has no running task');
        },
        async startPrompt() {
            throw new Error('fixture has no Prompt target');
        },
        setSessionModelConfiguration() {
            throw new Error('fixture has no configuration target');
        }
    };
}

test('real SDK Host keeps a domain load failure nonfatal and isolates C1 from C2', async () => {
    const trace: string[] = [];
    const host = new MobileAcpConnectionHost<{ connectionName: string }>({
        remoteSessionService: serviceFor('unused'),
        diagnose: () => undefined,
        adapterFactory(args) {
            const name = args.trustedContext.connectionName;
            const service = serviceFor(name);
            class TracingAdapter extends MobileAcpAgentAdapter {
                override async initialize(params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
                    trace.push(`initialize:${name}`);
                    return super.initialize(params);
                }

                override async listSessions(params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
                    trace.push(`list:${name}`);
                    return super.listSessions(params);
                }

                override async loadSession(params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> {
                    trace.push(`load:${name}:${params.sessionId}`);
                    return super.loadSession(params);
                }
            }
            return new TracingAdapter(
                args.connection,
                args.signal,
                service,
                () => undefined,
                args.failClosed,
                args.registerCleanup,
                'test'
            );
        }
    });

    const open = async (connectionName: string) => {
        const [clientChannel, serverChannel] = createTestChannelPair();
        const hosted = host.open(serverChannel, { connectionName });
        const updates: acp.SessionNotification[] = [];
        const binding = createAcpMessageStream(clientChannel, new AbortController());
        const client = new acp.ClientSideConnection(
            (): Client => ({
                async requestPermission() {
                    return { outcome: { outcome: 'cancelled' } };
                },
                async sessionUpdate(value) {
                    updates.push(value);
                }
            }),
            binding.stream
        );
        await client.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
        return { client, hosted, updates };
    };

    const c1 = await open('c1');
    await assert.rejects(
        c1.client.loadSession({ sessionId: 'missing', cwd: '/isolated/workspace', mcpServers: [] }),
        (error: unknown) =>
            error instanceof acp.RequestError &&
            (error.data as { opendesk?: { code?: string } } | undefined)?.opendesk?.code === 'session_unavailable'
    );
    const rowsAfterFailure = await c1.client.listSessions({});
    assert.equal(rowsAfterFailure.sessions.length, 1);
    await c1.client.loadSession({ sessionId: 's1', cwd: '/isolated/workspace', mcpServers: [] });
    assert.equal(c1.updates.length, 2);
    await c1.hosted.close();

    const c2 = await open('c2');
    await c2.client.listSessions({});
    await c2.client.loadSession({ sessionId: 's1', cwd: '/isolated/workspace', mcpServers: [] });
    assert.equal(c2.updates.length, 2);
    assert.match(JSON.stringify(c2.updates), /snapshot-c2/);
    assert.doesNotMatch(JSON.stringify(c2.updates), /snapshot-c1/);
    assert.deepEqual(trace, [
        'initialize:c1',
        'load:c1:missing',
        'list:c1',
        'load:c1:s1',
        'initialize:c2',
        'list:c2',
        'load:c2:s1'
    ]);
    await c2.hosted.close();
    await host.close();
});
