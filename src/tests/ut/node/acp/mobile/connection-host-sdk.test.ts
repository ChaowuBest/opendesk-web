import test from 'node:test';
import assert from 'node:assert/strict';
import * as acp from '@agentclientprotocol/sdk';
import type { AgentSideConnection, Client, SessionNotification } from '@agentclientprotocol/sdk';
import { InteractionDeliveryChannel } from '../../../../../main/aikernel/interaction/delivery.js';
import type { AskUserDeliveryRequest } from '../../../../../main/aikernel/interaction/delivery.js';
import {
    MobileAcpAgentAdapter,
    type MobileAcpDiagnosticEvent
} from '../../../../../main/applications/mobileaccess/acp/mobile/acp-endpoint/agent-adapter.js';
import { MobileAcpConnectionHost } from '../../../../../main/applications/mobileaccess/acp/mobile/acp-endpoint/connection-host.js';
import {
    RemoteSessionStopError,
    type RemoteSessionService
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/service.js';
import { deriveRunToken } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session-identifiers.js';
import { PublicSessionProjectionError } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session.js';
import type { PublicSessionSyncHandle } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session-sync.js';
import { createAcpMessageStream } from '../../../../../main/applications/mobileaccess/acp/mobile/transport/acp-message-stream.js';
import { createTestChannelPair, TestAcpMessageChannel } from './test-channel.js';

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function createClient(port: TestAcpMessageChannel, handler: Client) {
    const scope = new AbortController();
    const binding = createAcpMessageStream(port, scope);
    const connection = new acp.ClientSideConnection(() => handler, binding.stream);
    return { connection, scope, binding };
}

const quietClient = (): Client => ({
    async requestPermission() {
        return { outcome: { outcome: 'cancelled' } };
    },
    async sessionUpdate() {}
});

const unavailableCapture: RemoteSessionService['beginSessionLoad'] = () => {
    throw new PublicSessionProjectionError('session_unavailable', 'fixture has no load target');
};

const fixtureRemoteSessionService: RemoteSessionService = {
    setSessionModelConfiguration() {
        throw new Error('fixture has no configuration target');
    },
    beginSessionLoad: unavailableCapture,
    stopCurrentRun() {
        throw new Error('fixture has no stop target');
    },
    async startPrompt() {
        throw new Error('fixture has no Prompt target');
    },
    async listSessions() {
        return [];
    }
};
const fixtureHostOptions = {
    remoteSessionService: fixtureRemoteSessionService,
    diagnose: () => undefined
};

const interactionCapability = {
    schemaVersion: 1,
    askUser: 1,
    exitPlanMode: 1,
    permission: 1,
    closed: 1
} as const;

const askRequest = (): AskUserDeliveryRequest => ({
    type: 'askUser',
    requestId: 'ask-1',
    sourceTaskId: 'child-1',
    taskName: 'Child task',
    request: {
        requestId: 'ask-1',
        taskId: 'child-1',
        taskName: 'Child task',
        workspace: '/private/workspace',
        questions: [
            {
                question: 'Choose?',
                header: 'Choice',
                options: [{ label: 'A', description: 'First' }]
            }
        ]
    }
});

function createInteractionService(): RemoteSessionService {
    let phase: PublicSessionSyncHandle['phase'] = 'buffering';
    const sync: PublicSessionSyncHandle = {
        sessionId: 'root-1',
        get phase() {
            return phase;
        },
        installFatalSink() {},
        async activate() {
            phase = 'live';
        },
        stop() {
            phase = 'stopped';
        }
    };
    return {
        ...fixtureRemoteSessionService,
        beginSessionLoad() {
            return {
                snapshot: {
                    sessionId: 'root-1',
                    title: 'Root task',
                    cwd: '/workspace',
                    updatedAt: '2026-09-03T00:00:00.000Z',
                    taskStatus: 'stopped',
                    completionStatus: null,
                    runToken: null,
                    history: { messages: [] }
                },
                sync
            };
        }
    };
}

class ResponseBoundaryAdapter extends MobileAcpAgentAdapter {
    override async prompt(_params: acp.PromptRequest): Promise<acp.PromptResponse> {
        return { stopReason: 'end_turn' };
    }

    override async setSessionConfigOption(
        _params: acp.SetSessionConfigOptionRequest
    ): Promise<acp.SetSessionConfigOptionResponse> {
        return { configOptions: [] };
    }
}

function createResponseBoundaryService(): RemoteSessionService {
    return {
        ...createInteractionService(),
        async listSessions() {
            return [];
        },
        async createSession(input: { workspace: string }) {
            return { kind: 'created' as const, sessionId: 'created-1', workspace: input.workspace };
        },
        async resolveDefaultWorkspace() {
            return { workspace: '/workspace' };
        }
    } as RemoteSessionService;
}

async function openResponseBoundaryHarness(options: { initialize?: boolean } = {}) {
    const [clientPort, serverPort] = createTestChannelPair();
    const service = createResponseBoundaryService();
    let agentConnection!: AgentSideConnection;
    let failClosed!: () => void;
    let adapterCleanupCalls = 0;
    let serverSignal!: AbortSignal;
    const host = new MobileAcpConnectionHost({
        remoteSessionService: service,
        diagnose: () => undefined,
        adapterFactory(args) {
            agentConnection = args.connection;
            failClosed = args.failClosed;
            serverSignal = args.signal;
            return new ResponseBoundaryAdapter(
                args.connection,
                args.signal,
                service,
                () => undefined,
                args.failClosed,
                (cleanup) =>
                    args.registerCleanup(() => {
                        adapterCleanupCalls += 1;
                        cleanup();
                    }),
                'test'
            );
        }
    });
    const hosted = host.open(serverPort, {});
    const client = createClient(clientPort, quietClient()).connection;
    if (options.initialize !== false) {
        await client.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    }
    return {
        clientPort,
        serverPort,
        hosted,
        client,
        get agentConnection() {
            return agentConnection;
        },
        get failClosed() {
            return failClosed;
        },
        get serverSignal() {
            return serverSignal;
        },
        get adapterCleanupCalls() {
            return adapterCleanupCalls;
        }
    };
}

async function assertResponseBoundaryClosed(
    harness: Awaited<ReturnType<typeof openResponseBoundaryHarness>>,
    operation: Promise<unknown>
): Promise<void> {
    await assert.rejects(operation);
    await harness.hosted.closed;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.serverSignal.aborted, true);
    assert.equal(harness.adapterCleanupCalls, 1);
    assert.equal(harness.serverPort.events.filter((event) => event === 'port-close').length, 1);
    assert.equal(harness.clientPort.events.filter((event) => event === 'notify-close').length, 1);

    harness.failClosed();
    harness.serverPort.emitClose(new Error('late transport close'));
    await harness.hosted.close();
    assert.equal(harness.adapterCleanupCalls, 1);
    assert.equal(harness.serverPort.events.filter((event) => event === 'port-close').length, 1);
}

test('formal host and adapter initialize with v1 and public session capabilities', async () => {
    const [clientPort, serverPort] = createTestChannelPair();
    const context = Object.freeze({ testConnection: 'formal' });
    let capturedConnection!: AgentSideConnection;
    let capturedContext!: object;
    let capturedSignal!: AbortSignal;
    const host = new MobileAcpConnectionHost({
        ...fixtureHostOptions,
        agentVersion: '0.3.4',
        adapterFactory(args) {
            capturedConnection = args.connection;
            capturedContext = args.trustedContext;
            capturedSignal = args.signal;
            return new MobileAcpAgentAdapter(
                args.connection,
                args.signal,
                fixtureRemoteSessionService,
                () => undefined,
                args.failClosed,
                args.registerCleanup,
                '0.3.4'
            );
        }
    });
    const hosted = host.open(serverPort, context);
    const client = createClient(clientPort, quietClient());

    const initialized = await client.connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientInfo: { name: 'opendesk-mobile', version: '0.0.1' },
        clientCapabilities: {},
        _meta: { testConnection: 'untrusted-overwrite' }
    });

    assert.equal(initialized.protocolVersion, acp.PROTOCOL_VERSION);
    assert.deepEqual(initialized.agentInfo, { name: 'opendesk', title: 'OpenDesk', version: '0.3.4' });
    assert.deepEqual(initialized.agentCapabilities, { loadSession: true, sessionCapabilities: { list: {} } });
    assert.deepEqual(initialized.authMethods, []);
    assert.equal(capturedContext, context);
    assert.equal((capturedContext as { testConnection: string }).testConnection, 'formal');
    assert.equal(capturedSignal.aborted, false);
    assert.ok(capturedConnection);

    await hosted.close();
});

test('formal Host forwards the one shared interaction channel into its default Adapter', async () => {
    const [clientPort, serverPort] = createTestChannelPair();
    const deliveryChannel = new InteractionDeliveryChannel(() => undefined);
    const host = new MobileAcpConnectionHost({
        ...fixtureHostOptions,
        mobileInteractions: {
            deliveryChannel,
            answerAuthorizer: { authorizeInteractionAnswer() {} }
        }
    });
    const hosted = host.open(serverPort, {});
    const client = createClient(clientPort, quietClient()).connection;
    const interaction = {
        schemaVersion: 1,
        askUser: 1,
        exitPlanMode: 1,
        permission: 1,
        closed: 1
    } as const;

    const initialized = await client.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { _meta: { opendesk: { interaction } } }
    });
    assert.deepEqual(initialized.agentCapabilities?._meta, { opendesk: { interaction } });
    await hosted.close();
});

test('authenticate and newSession stay unsupported while Prompt requires a live loaded session', async () => {
    const [clientPort, serverPort] = createTestChannelPair();
    const host = new MobileAcpConnectionHost(fixtureHostOptions);
    const hosted = host.open(serverPort, {});
    const client = createClient(clientPort, quietClient()).connection;
    await client.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });

    for (const operation of [
        client.authenticate({ methodId: 'none' }),
        client.newSession({ cwd: '/tmp', mcpServers: [] })
    ]) {
        await assert.rejects(operation, (error: unknown) => {
            assert.ok(error instanceof acp.RequestError);
            assert.equal(error.code, -32601);
            return true;
        });
    }
    await assert.rejects(
        client.prompt({ sessionId: 'formal-session', prompt: [{ type: 'text', text: 'not live' }] }),
        (error: unknown) => {
            assert.ok(error instanceof acp.RequestError);
            assert.equal(error.code, -32603);
            assert.deepEqual(error.data, {
                opendesk: { schemaVersion: 1, code: 'session_not_live' }
            });
            return true;
        }
    );
    await hosted.close();
});

test('SDK cancel forwards trusted stop once and leaves the connection usable', async () => {
    const [clientPort, serverPort] = createTestChannelPair();
    let agentConnection!: AgentSideConnection;
    const cancellations: string[] = [];
    const stopCalls: unknown[] = [];
    const token = deriveRunToken('formal-session', 7);
    const stopService: RemoteSessionService = {
        ...fixtureRemoteSessionService,
        stopCurrentRun(sessionId, runToken) {
            stopCalls.push({ sessionId, runToken });
        }
    };
    class ObservingAdapter extends MobileAcpAgentAdapter {
        override async cancel(params: acp.CancelNotification): Promise<void> {
            cancellations.push(params.sessionId);
            await super.cancel(params);
        }
    }
    const host = new MobileAcpConnectionHost({
        ...fixtureHostOptions,
        adapterFactory(args) {
            agentConnection = args.connection;
            return new ObservingAdapter(
                args.connection,
                args.signal,
                stopService,
                () => undefined,
                args.failClosed,
                args.registerCleanup,
                'test'
            );
        }
    });
    const hosted = host.open(serverPort, {});
    const updates: SessionNotification[] = [];
    const client = createClient(clientPort, {
        async requestPermission() {
            return { outcome: { outcome: 'cancelled' } };
        },
        async sessionUpdate(params) {
            updates.push(params);
        }
    }).connection;
    await client.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });

    const permission = await agentConnection.requestPermission({
        sessionId: 'formal-session',
        toolCall: { toolCallId: 'formal-tool', title: 'formal permission', status: 'pending' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
    });
    assert.deepEqual(permission, { outcome: { outcome: 'cancelled' } });

    await agentConnection.sessionUpdate({
        sessionId: 'formal-session',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'formal-update' } }
    });
    await client.cancel({
        sessionId: 'formal-session',
        _meta: { opendesk: { schemaVersion: 1, runToken: token } }
    });
    await new Promise((resolve) => setImmediate(resolve));

    await agentConnection.sessionUpdate({
        sessionId: 'formal-session',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'still-live' } }
    });

    assert.equal(updates[0]?.update.sessionUpdate, 'agent_message_chunk');
    assert.equal(updates[1]?.update.sessionUpdate, 'agent_message_chunk');
    assert.deepEqual(cancellations, ['formal-session']);
    assert.deepEqual(stopCalls, [{ sessionId: 'formal-session', runToken: token }]);
    await hosted.close();
});

test('every cancel refusal is a diagnostic no-op and the live connection survives', async () => {
    const [clientPort, serverPort] = createTestChannelPair();
    let agentConnection!: AgentSideConnection;
    const diagnostics: MobileAcpDiagnosticEvent[] = [];
    const staleToken = deriveRunToken('stale-session', 7);
    const stopService: RemoteSessionService = {
        ...fixtureRemoteSessionService,
        stopCurrentRun(sessionId) {
            if (sessionId === 'stale-session') {
                throw new RemoteSessionStopError('stale_run', { cause: new Error('/private/path') });
            }
            throw new RemoteSessionStopError('unavailable_or_unauthorized', {
                cause: new Error('/private/path')
            });
        }
    };
    const host = new MobileAcpConnectionHost({
        ...fixtureHostOptions,
        adapterFactory(args) {
            agentConnection = args.connection;
            return new MobileAcpAgentAdapter(
                args.connection,
                args.signal,
                stopService,
                (event) => diagnostics.push(event),
                args.failClosed,
                args.registerCleanup,
                'test'
            );
        }
    });
    const hosted = host.open(serverPort, {});
    const updates: SessionNotification[] = [];
    const client = createClient(clientPort, {
        async requestPermission() {
            return { outcome: { outcome: 'cancelled' } };
        },
        async sessionUpdate(params) {
            updates.push(params);
        }
    }).connection;
    await client.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });

    await client.cancel({ sessionId: 'missing-token' });
    await client.cancel({
        sessionId: 'invalid-token',
        _meta: { opendesk: { schemaVersion: 1, runToken: 'bad' } }
    });
    await client.cancel({
        sessionId: 'oversize-token',
        _meta: { opendesk: { schemaVersion: 1, runToken: `rt1_${'x'.repeat(65)}` } }
    });
    for (const sessionId of ['unauthorized-session', 'corrupt-session']) {
        await client.cancel({
            sessionId,
            _meta: { opendesk: { schemaVersion: 1, runToken: deriveRunToken(sessionId, 7) } }
        });
    }
    await client.cancel({
        sessionId: 'stale-session',
        _meta: { opendesk: { schemaVersion: 1, runToken: staleToken } }
    });
    await new Promise((resolve) => setImmediate(resolve));
    await agentConnection.sessionUpdate({
        sessionId: 'private/session',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'still-live' } }
    });

    assert.deepEqual(diagnostics, [
        { code: 'session_cancel_ignored', reason: 'invalid_profile' },
        { code: 'session_cancel_ignored', reason: 'invalid_profile' },
        { code: 'session_cancel_ignored', reason: 'invalid_profile' },
        { code: 'session_cancel_ignored', reason: 'unavailable_or_unauthorized' },
        { code: 'session_cancel_ignored', reason: 'unavailable_or_unauthorized' },
        { code: 'session_cancel_ignored', reason: 'stale_run' }
    ]);
    assert.doesNotMatch(JSON.stringify(diagnostics), /private|token|path/);
    assert.equal(updates.length, 1);
    await hosted.close();
});

test('late SDK cancel for G7 is forwarded once and refused while G8 remains running', async () => {
    const [clientPort, serverPort] = createTestChannelPair();
    const diagnostics: MobileAcpDiagnosticEvent[] = [];
    let stopCalls = 0;
    const serviceDirectory = [
        {
            sessionId: 's1',
            cwd: '/work',
            title: 'Session',
            updatedAt: '2026-08-27T00:00:00.000Z',
            taskStatus: 'running' as const,
            completionStatus: null
        }
    ];
    const expectedDirectory = [
        {
            sessionId: 's1',
            cwd: '/work',
            title: 'Session',
            updatedAt: '2026-08-27T00:00:00.000Z',
            _meta: {
                opendesk: {
                    schemaVersion: 1,
                    taskStatus: 'running',
                    completionStatus: null
                }
            }
        }
    ];
    const service: RemoteSessionService = {
        ...fixtureRemoteSessionService,
        stopCurrentRun(_sessionId, runToken) {
            stopCalls += 1;
            assert.equal(runToken, deriveRunToken('s1', 7));
            throw new RemoteSessionStopError('stale_run');
        },
        async listSessions() {
            return serviceDirectory;
        }
    };
    const host = new MobileAcpConnectionHost({
        remoteSessionService: service,
        diagnose: (event) => diagnostics.push(event)
    });
    const hosted = host.open(serverPort, {});
    const client = createClient(clientPort, quietClient()).connection;
    await client.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });

    await client.cancel({
        sessionId: 's1',
        _meta: { opendesk: { schemaVersion: 1, runToken: deriveRunToken('s1', 7) } }
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stopCalls, 1);
    assert.deepEqual(diagnostics.at(-1), {
        code: 'session_cancel_ignored',
        reason: 'stale_run'
    });
    assert.deepEqual((await client.listSessions({})).sessions, expectedDirectory);
    await hosted.close();
});

test('local running cancel emits state only and invents no prompt response', async () => {
    const [clientPort, serverPort] = createTestChannelPair();
    let agentConnection!: AgentSideConnection;
    const publications: Promise<void>[] = [];
    const token = deriveRunToken('s1', 7);
    const service: RemoteSessionService = {
        ...fixtureRemoteSessionService,
        stopCurrentRun(sessionId, runToken) {
            assert.equal(runToken, token);
            publications.push(
                agentConnection.sessionUpdate({
                    sessionId,
                    update: {
                        sessionUpdate: 'session_info_update',
                        title: 'Session',
                        updatedAt: '2026-08-27T00:00:01.000Z',
                        _meta: {
                            opendesk: {
                                schemaVersion: 1,
                                cwd: '/work',
                                taskStatus: 'stopped',
                                completionStatus: null,
                                runToken: null
                            }
                        }
                    }
                })
            );
        }
    };
    const host = new MobileAcpConnectionHost({
        remoteSessionService: service,
        diagnose: () => undefined,
        adapterFactory(args) {
            agentConnection = args.connection;
            return new MobileAcpAgentAdapter(
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
    const hosted = host.open(serverPort, {});
    const updates: SessionNotification[] = [];
    const client = createClient(clientPort, {
        ...quietClient(),
        async sessionUpdate(value) {
            updates.push(value);
        }
    }).connection;
    await client.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    await client.cancel({
        sessionId: 's1',
        _meta: { opendesk: { schemaVersion: 1, runToken: token } }
    });
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.all(publications);

    assert.equal(updates.length, 1);
    assert.equal(updates[0].update.sessionUpdate, 'session_info_update');
    assert.equal(
        clientPort.sent.some((frame) => frame.includes('stopReason')),
        false
    );
    await hosted.close();
});

test('remote close aborts scope, closes SDK, unbinds listeners and is idempotent', { timeout: 4_000 }, async () => {
    const [clientPort, serverPort] = createTestChannelPair();
    let signal!: AbortSignal;
    const host = new MobileAcpConnectionHost({
        ...fixtureHostOptions,
        adapterFactory(args) {
            signal = args.signal;
            return new MobileAcpAgentAdapter(
                args.connection,
                args.signal,
                fixtureRemoteSessionService,
                () => undefined,
                args.failClosed,
                args.registerCleanup,
                'test'
            );
        }
    });
    const hosted = host.open(serverPort, {});
    createClient(clientPort, quietClient());

    clientPort.close();
    await hosted.closed;

    assert.equal(signal.aborted, true);
    assert.equal(serverPort.listenerCount, 0);
    await hosted.close();
    await hosted.close();
});

test('host close rejects a real SDK pending request even if the handler finishes late', async () => {
    const [clientPort, serverPort] = createTestChannelPair();
    let agentConnection!: AgentSideConnection;
    const permission = deferred<acp.RequestPermissionResponse>();
    const host = new MobileAcpConnectionHost({
        ...fixtureHostOptions,
        adapterFactory(args) {
            agentConnection = args.connection;
            return new MobileAcpAgentAdapter(
                args.connection,
                args.signal,
                fixtureRemoteSessionService,
                () => undefined,
                args.failClosed,
                args.registerCleanup,
                'test'
            );
        }
    });
    const hosted = host.open(serverPort, {});
    const client = createClient(clientPort, {
        async requestPermission() {
            return permission.promise;
        },
        async sessionUpdate() {}
    }).connection;
    await client.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    const pending = agentConnection.requestPermission({
        sessionId: 'formal-session',
        toolCall: { toolCallId: 'formal-tool', title: 'Pending' },
        options: []
    });

    await hosted.close();
    await assert.rejects(pending, /closed/i);
    permission.resolve({ outcome: { outcome: 'cancelled' } });
    await new Promise((resolve) => setImmediate(resolve));
});

test('SDK write failure closes the hosted connection and the underlying port', async () => {
    const [clientPort, serverPort] = createTestChannelPair();
    serverPort.failSendWith = new Error('server send failed');
    const host = new MobileAcpConnectionHost(fixtureHostOptions);
    const hosted = host.open(serverPort, {});
    const client = createClient(clientPort, quietClient()).connection;

    await assert.rejects(
        client.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} }),
        /server send failed|closed/i
    );
    await hosted.closed;
    assert.ok(serverPort.events.includes('port-close'));
});

test(
    'interaction terminal send rejection converges explicit callback and Stream abort into one Host close',
    { timeout: 4_000 },
    async () => {
        const [clientPort, serverPort] = createTestChannelPair();
        const service = createInteractionService();
        const deliveryChannel = new InteractionDeliveryChannel((sourceTaskId) =>
            sourceTaskId === 'child-1' ? 'root-1' : undefined
        );
        let explicitConnectionFailureCalls = 0;
        let adapterCleanupCalls = 0;
        let cleanupObservedPortOpen = false;
        let serverSignal!: AbortSignal;
        let failClosed!: () => void;
        const host = new MobileAcpConnectionHost({
            remoteSessionService: service,
            diagnose: () => undefined,
            mobileInteractions: {
                deliveryChannel,
                answerAuthorizer: { authorizeInteractionAnswer() {} }
            },
            adapterFactory(args) {
                serverSignal = args.signal;
                failClosed = args.failClosed;
                return new MobileAcpAgentAdapter(
                    args.connection,
                    args.signal,
                    service,
                    () => undefined,
                    () => {
                        explicitConnectionFailureCalls += 1;
                        args.failClosed();
                    },
                    (cleanup) =>
                        args.registerCleanup(() => {
                            adapterCleanupCalls += 1;
                            cleanupObservedPortOpen = !serverPort.events.includes('port-close');
                            cleanup();
                        }),
                    'test',
                    undefined,
                    {
                        deliveryChannel,
                        answerAuthorizer: { authorizeInteractionAnswer() {} }
                    }
                );
            }
        });
        const hosted = host.open(serverPort, {});
        const client = createClient(clientPort, {
            ...quietClient(),
            async extMethod(method) {
                if (method === '_opendesk/interaction/ask-user') {
                    return { answers: { 0: ['A'] } };
                }
                throw acp.RequestError.methodNotFound(method);
            }
        }).connection;
        await client.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {
                _meta: {
                    opendesk: {
                        interaction: interactionCapability,
                        interactionFailedTerminal: { schemaVersion: 1 },
                        sessionInvalidation: { schemaVersion: 1 }
                    }
                }
            }
        });
        await client.loadSession({ sessionId: 'root-1', cwd: '/workspace', mcpServers: [] });
        serverPort.rejectNextSend(
            (frame) => 'method' in frame && frame.method === '_opendesk/interaction/closed',
            new Error('terminal wire failed')
        );

        assert.ok(deliveryChannel.publishAskUser(askRequest(), () => true));
        await hosted.closed;
        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(explicitConnectionFailureCalls, 1);
        assert.equal(serverSignal.aborted, true);
        assert.equal(adapterCleanupCalls, 1);
        assert.equal(cleanupObservedPortOpen, true);
        assert.equal(serverPort.events.filter((event) => event === 'port-close').length, 1);
        assert.equal(clientPort.events.filter((event) => event === 'notify-close').length, 1);

        failClosed();
        serverPort.emitClose(new Error('late transport close'));
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(adapterCleanupCalls, 1);
        assert.equal(serverPort.events.filter((event) => event === 'port-close').length, 1);
    }
);

test('real SDK response send rejection matrix closes Host cleanup and port exactly once', async (context) => {
    const responseCases: Array<{
        name: string;
        initialize?: boolean;
        reject(frame: acp.AnyMessage): boolean;
        run(harness: Awaited<ReturnType<typeof openResponseBoundaryHarness>>): Promise<unknown>;
    }> = [
        {
            name: 'initialize-response',
            initialize: false,
            reject: (frame) => 'id' in frame && 'result' in frame,
            run: ({ client }) => client.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} })
        },
        {
            name: 'authenticate-error-response',
            reject: (frame) => 'id' in frame && 'error' in frame,
            run: ({ client }) => client.authenticate({ methodId: 'none' })
        },
        {
            name: 'session-new-response',
            reject: (frame) => 'id' in frame && 'result' in frame,
            run: ({ client }) => client.newSession({ cwd: '/workspace', mcpServers: [] })
        },
        {
            name: 'default-workspace-response',
            reject: (frame) => 'id' in frame && 'result' in frame,
            run: ({ client }) => client.extMethod('_opendesk/session/default-workspace', {})
        },
        {
            name: 'list-response',
            reject: (frame) => 'id' in frame && 'result' in frame,
            run: ({ client }) => client.listSessions({})
        },
        {
            name: 'load-snapshot-sessionUpdate',
            reject: (frame) => 'method' in frame && frame.method === 'session/update',
            run: ({ client }) => client.loadSession({ sessionId: 'root-1', cwd: '/workspace', mcpServers: [] })
        },
        {
            name: 'load-response-after-commit',
            reject: (frame) => 'id' in frame && 'result' in frame,
            run: ({ client }) => client.loadSession({ sessionId: 'root-1', cwd: '/workspace', mcpServers: [] })
        },
        {
            name: 'config-response',
            reject: (frame) => 'id' in frame && 'result' in frame,
            run: ({ client }) =>
                client.setSessionConfigOption({
                    sessionId: 'root-1',
                    configId: 'opendesk.model_effort',
                    value: '["alpha",""]'
                })
        },
        {
            name: 'prompt-response',
            reject: (frame) => 'id' in frame && 'result' in frame,
            run: ({ client }) => client.prompt({ sessionId: 'root-1', prompt: [{ type: 'text', text: 'hello' }] })
        }
    ];

    for (const entry of responseCases) {
        await context.test(entry.name, async () => {
            const harness = await openResponseBoundaryHarness({ initialize: entry.initialize });
            harness.serverPort.rejectNextSend(entry.reject, new Error(`${entry.name} wire failed`));
            await assertResponseBoundaryClosed(harness, entry.run(harness));
        });
    }
});

test('real SDK notification send rejection matrix closes Host cleanup and port exactly once', async (context) => {
    const notificationCases: Array<{
        name: string;
        method: string;
        send(connection: AgentSideConnection): Promise<void>;
        status?: string;
    }> = [
        {
            name: 'live-sessionUpdate',
            method: 'session/update',
            send: (connection) =>
                connection.sessionUpdate({
                    sessionId: 'root-1',
                    update: {
                        sessionUpdate: 'agent_message_chunk',
                        content: { type: 'text', text: 'live' }
                    }
                })
        },
        {
            name: 'prompt-marker-sessionUpdate',
            method: 'session/update',
            send: (connection) =>
                connection.sessionUpdate({
                    sessionId: 'root-1',
                    update: {
                        sessionUpdate: 'agent_message_chunk',
                        content: { type: 'text', text: 'prompt' },
                        _meta: { opendesk: { submissionState: 'accepted' } }
                    }
                })
        },
        ...(['accepted', 'superseded', 'expired', 'cancelled', 'disconnected', 'failed'] as const).map((status) => ({
            name: `interaction-closed-${status}`,
            method: '_opendesk/interaction/closed',
            status,
            send: (connection: AgentSideConnection) =>
                connection.extNotification('_opendesk/interaction/closed', {
                    schemaVersion: 1,
                    requestId: `ask-${status}`,
                    sessionId: 'root-1',
                    interactionType: 'askUser',
                    status
                })
        })),
        {
            name: 'session-invalidation',
            method: '_opendesk/session/invalidated',
            send: (connection) =>
                connection.extNotification('_opendesk/session/invalidated', {
                    schemaVersion: 1,
                    sessionId: 'root-1'
                })
        }
    ];

    for (const entry of notificationCases) {
        await context.test(entry.name, async () => {
            const harness = await openResponseBoundaryHarness();
            harness.serverPort.rejectNextSend(
                (frame) =>
                    'method' in frame &&
                    frame.method === entry.method &&
                    (entry.status === undefined ||
                        ('params' in frame &&
                            typeof frame.params === 'object' &&
                            frame.params !== null &&
                            'status' in frame.params &&
                            frame.params.status === entry.status)),
                new Error(`${entry.name} wire failed`)
            );
            await assertResponseBoundaryClosed(harness, entry.send(harness.agentConnection));
        });
    }
});

test('closed connection A cannot deliver messages or context into connection B', async () => {
    const contexts: object[] = [];
    const host = new MobileAcpConnectionHost({
        ...fixtureHostOptions,
        adapterFactory(args) {
            contexts.push(args.trustedContext);
            return new MobileAcpAgentAdapter(
                args.connection,
                args.signal,
                fixtureRemoteSessionService,
                () => undefined,
                args.failClosed,
                args.registerCleanup,
                'test'
            );
        }
    });
    const [clientA, serverA] = createTestChannelPair();
    const hostedA = host.open(serverA, { id: 'A' });
    createClient(clientA, quietClient());
    await hostedA.close();

    const [clientB, serverB] = createTestChannelPair();
    const hostedB = host.open(serverB, { id: 'B' });
    const connectionB = createClient(clientB, quietClient()).connection;
    const initializedB = await connectionB.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {}
    });
    clientA.emitMessage(JSON.stringify({ jsonrpc: '2.0', id: 99, result: { late: true } }));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(initializedB.protocolVersion, acp.PROTOCOL_VERSION);
    assert.deepEqual(contexts, [{ id: 'A' }, { id: 'B' }]);
    assert.equal(serverA.listenerCount, 0);
    await hostedB.close();
    await host.close();
});
