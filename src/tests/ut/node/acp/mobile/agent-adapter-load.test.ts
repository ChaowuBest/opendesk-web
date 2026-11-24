import assert from 'node:assert/strict';
import test from 'node:test';
import * as acp from '@agentclientprotocol/sdk';
import type { AgentSideConnection, Client } from '@agentclientprotocol/sdk';
import {
    InteractionDeliveryChannel,
    type InteractionDeliveryEndpoint
} from '../../../../../main/aikernel/interaction/delivery.js';
import { MobileAcpAgentAdapter } from '../../../../../main/applications/mobileaccess/acp/mobile/acp-endpoint/agent-adapter.js';
import { MobileAcpConnectionHost } from '../../../../../main/applications/mobileaccess/acp/mobile/acp-endpoint/connection-host.js';
import { PromptUpdateGate } from '../../../../../main/applications/mobileaccess/acp/mobile/acp-endpoint/prompt-update-gate.js';
import { SessionNotificationEncoder } from '../../../../../main/applications/mobileaccess/acp/mobile/acp-endpoint/session-notification-encoder.js';
import { MobileInteractionDeliveryEndpoint } from '../../../../../main/applications/mobileaccess/acp/mobile/interaction/delivery-endpoint.js';
import {
    PublicSessionProjectionError,
    type PublicSessionState,
    type PublicSessionUpdate
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session.js';
import type { PublicSessionIdentifierPlanFactory } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session-identifiers.js';
import type { RemoteSessionService } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/service.js';
import { deriveRunToken } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session-identifiers.js';
import type {
    PublicSessionSyncHandle,
    PublicSessionSyncPhase
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session-sync.js';
import { createAcpMessageStream } from '../../../../../main/applications/mobileaccess/acp/mobile/transport/acp-message-stream.js';
import { createTestChannelPair, TestAcpMessageChannel } from './test-channel.js';

const STATE: PublicSessionState = {
    sessionId: 's1',
    title: 'Session',
    cwd: '/authoritative',
    updatedAt: '2026-08-22T00:00:00.000Z',
    taskStatus: 'running',
    completionStatus: null,
    runToken: deriveRunToken('s1', 1),
    history: {
        messages: [
            {
                role: 'assistant',
                messageId: '550e8400-e29b-41d4-a716-446655440000',
                parts: [{ type: 'text', text: 'hello' }]
            }
        ]
    }
};

function openDeskMeta(notification: acp.SessionNotification): Record<string, unknown> {
    const meta = notification.update._meta;
    assert.ok(meta && typeof meta === 'object');
    const openDesk = (meta as Record<string, unknown>).opendesk;
    assert.ok(openDesk && typeof openDesk === 'object');
    return openDesk as Record<string, unknown>;
}

function clientHandler(events: acp.SessionNotification[]): Client {
    return {
        async requestPermission() {
            return { outcome: { outcome: 'cancelled' } };
        },
        async sessionUpdate(params) {
            events.push(params);
        }
    };
}

function connectClient(port: TestAcpMessageChannel, events: acp.SessionNotification[]) {
    const binding = createAcpMessageStream(port, new AbortController());
    return new acp.ClientSideConnection(() => clientHandler(events), binding.stream);
}

async function openPair(service: RemoteSessionService) {
    const host = new MobileAcpConnectionHost({
        remoteSessionService: service,
        diagnose: () => undefined,
        agentVersion: 'test'
    });
    const [clientPort, serverPort] = createTestChannelPair();
    const hosted = host.open(serverPort, Object.freeze({ connectionId: 'trusted' }));
    const events: acp.SessionNotification[] = [];
    const client = connectClient(clientPort, events);
    const initialized = await client.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: 'test', version: '1' }
    });
    return { hosted, client, events, initialized };
}

function inertFeed(sessionId: string): PublicSessionSyncHandle {
    let phase: PublicSessionSyncPhase = 'buffering';
    return {
        sessionId,
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
}

function serviceWithCapture(capture: RemoteSessionService['beginSessionLoad']): RemoteSessionService {
    return {
        setSessionModelConfiguration() {
            throw new Error('fixture has no configuration target');
        },
        stopCurrentRun() {
            throw new Error('fixture has no stop target');
        },
        async listSessions() {
            return [];
        },
        async startPrompt() {
            throw new Error('fixture has no Prompt target');
        },
        beginSessionLoad: capture
    };
}

const INTERACTION_CAPABILITY = {
    schemaVersion: 1,
    askUser: 1,
    exitPlanMode: 1,
    permission: 1,
    closed: 1
} as const;

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (predicate()) return;
        await new Promise((resolve) => setImmediate(resolve));
    }
    assert.fail('condition did not become true');
}

function stateFor(sessionId: string): PublicSessionState {
    return {
        ...structuredClone(STATE),
        sessionId,
        title: sessionId,
        runToken: deriveRunToken(sessionId, 1)
    };
}

class MatrixFeed implements PublicSessionSyncHandle {
    phase: PublicSessionSyncPhase = 'buffering';
    private fatalSink?: (error: Error) => void;
    private readonly activation = deferred<void>();
    private activationPending = false;
    private stopped = false;

    constructor(
        readonly sessionId: string,
        private readonly events: string[],
        private readonly deferActivation: boolean
    ) {}

    installFatalSink(sink: (error: Error) => void): void {
        this.fatalSink = sink;
    }

    async activate(_consumer: (update: PublicSessionUpdate) => Promise<void>): Promise<void> {
        this.events.push(`sync-activate:${this.sessionId}`);
        if (this.deferActivation) {
            this.activationPending = true;
            try {
                await this.activation.promise;
            } finally {
                this.activationPending = false;
            }
        }
        if (this.stopped) throw new Error('sync stopped during activation');
        this.phase = 'live';
    }

    releaseActivation(): void {
        this.activation.resolve();
    }

    fail(): void {
        if (this.stopped) return;
        this.events.push(`sync-fatal:${this.sessionId}`);
        this.fatalSink?.(new Error(`controlled fatal: ${this.sessionId}`));
    }

    stop(reason = new Error('sync stopped')): void {
        if (this.stopped) return;
        this.stopped = true;
        this.phase = 'stopped';
        this.events.push(`sync-stop:${this.sessionId}`);
        if (this.activationPending) this.activation.reject(reason);
    }
}

class RecordingDeliveryChannel extends InteractionDeliveryChannel {
    constructor(private readonly events: string[]) {
        super(() => undefined);
    }

    override registerEndpoint(endpoint: InteractionDeliveryEndpoint): () => void {
        this.events.push(`endpoint-register:${endpoint.sessionId}`);
        const unregister = super.registerEndpoint(endpoint);
        return () => {
            this.events.push(`unregister:${endpoint.sessionId}`);
            unregister();
        };
    }

    override notifyEndpointReady(): void {
        this.events.push('endpoint-ready');
        super.notifyEndpointReady();
    }
}

test('a Provider that fails its re-offer cannot fail the session load that announced readiness', async () => {
    const fixture = await createMatrixFixture();
    fixture.deliveryChannel.subscribeEndpointReady(() => {
        throw new Error('provider re-offer failed');
    });
    let reachedSecondProvider = false;
    fixture.deliveryChannel.subscribeEndpointReady(() => {
        reachedSecondProvider = true;
    });
    await assert.doesNotReject(fixture.adapter.loadSession(loadRequest('A')));
    assert.equal(fixture.events.includes('endpoint-ready'), true);
    assert.equal(reachedSecondProvider, true);
    assert.equal(fixture.events.includes('fail-closed'), false);
    // The load really committed: switching away now releases A's endpoint.
    fixture.events.length = 0;
    fixture.failedBegins.add('B');
    await assert.rejects(fixture.adapter.loadSession(loadRequest('B')));
    assert.equal(fixture.events.includes('unregister:A'), true);
});

async function createMatrixFixture(options: { loadDeadlineMs?: number } = {}) {
    const events: string[] = [];
    const updates: acp.SessionNotification[] = [];
    const feeds = new Map<string, MatrixFeed>();
    const failedBegins = new Set<string>();
    const deferredActivations = new Set<string>();
    const controller = new AbortController();
    let cleanup: () => void = () => undefined;
    let listSessions: RemoteSessionService['listSessions'] = async () => [];
    let startPrompt: RemoteSessionService['startPrompt'] = async () => {
        throw new Error('fixture prompt was not configured');
    };
    let sendUpdate = async (_notification: acp.SessionNotification): Promise<void> => undefined;
    const service: RemoteSessionService = {
        setSessionModelConfiguration() {
            throw new Error('fixture has no configuration target');
        },
        stopCurrentRun() {
            throw new Error('fixture has no stop target');
        },
        listSessions(query) {
            return listSessions(query);
        },
        startPrompt(sessionId, text, interactive) {
            return startPrompt(sessionId, text, interactive);
        },
        beginSessionLoad(sessionId) {
            events.push(`begin:${sessionId}`);
            if (failedBegins.has(sessionId)) throw new Error(`injected begin failure for ${sessionId}`);
            const feed = new MatrixFeed(sessionId, events, deferredActivations.has(sessionId));
            feeds.set(sessionId, feed);
            return { snapshot: stateFor(sessionId), sync: feed };
        }
    };
    const connection = {
        async sessionUpdate(notification: acp.SessionNotification) {
            updates.push(notification);
            events.push(`update:${notification.sessionId}`);
            await sendUpdate(notification);
        },
        async extMethod() {
            return {};
        },
        async extNotification() {},
        async requestPermission() {
            return { outcome: { outcome: 'cancelled' as const } };
        }
    } as unknown as AgentSideConnection;
    const deliveryChannel = new RecordingDeliveryChannel(events);
    const adapter = new MobileAcpAgentAdapter(
        connection,
        controller.signal,
        service,
        () => undefined,
        () => events.push('fail-closed'),
        (callback) => {
            cleanup = callback;
        },
        'test',
        options.loadDeadlineMs ?? 30_000,
        {
            deliveryChannel,
            answerAuthorizer: { authorizeInteractionAnswer() {} }
        }
    );
    await adapter.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { _meta: { opendesk: { interaction: INTERACTION_CAPABILITY } } }
    });
    return {
        adapter,
        controller,
        deliveryChannel,
        events,
        failedBegins,
        feeds,
        updates,
        cleanup: () => cleanup(),
        deferActivation: (sessionId: string) => deferredActivations.add(sessionId),
        setListSessions: (handler: RemoteSessionService['listSessions']) => {
            listSessions = handler;
        },
        setStartPrompt: (handler: RemoteSessionService['startPrompt']) => {
            startPrompt = handler;
        },
        setSendUpdate: (handler: (notification: acp.SessionNotification) => Promise<void>) => {
            sendUpdate = handler;
        }
    };
}

const loadRequest = (sessionId: string): acp.LoadSessionRequest => ({
    sessionId,
    cwd: '/workspace',
    mcpServers: []
});

test('advertises load and sends the complete snapshot before returning empty response', async () => {
    const seenFactories: PublicSessionIdentifierPlanFactory[] = [];
    const pair = await openPair(
        serviceWithCapture((sessionId, factory) => {
            assert.equal(sessionId, 's1');
            seenFactories.push(factory);
            return { snapshot: STATE, sync: inertFeed('s1') };
        })
    );
    assert.deepEqual(pair.initialized.agentCapabilities, { loadSession: true, sessionCapabilities: { list: {} } });
    const response = await pair.client.loadSession({ sessionId: 's1', cwd: '/request-only', mcpServers: [] });
    assert.deepEqual(response, {});
    assert.equal(seenFactories.length, 1);
    assert.deepEqual(
        pair.events.map((value) => value.update.sessionUpdate),
        ['session_info_update', 'agent_message_chunk']
    );
    assert.equal(openDeskMeta(pair.events[0]).cwd, '/authoritative');
    await pair.hosted.close();
});

test('rejects unsupported params before RSS and maps only sanitized product codes', async () => {
    let calls = 0;
    let failure: 'session_unavailable' | 'session_too_large' | 'session_load_failed' = 'session_unavailable';
    const pair = await openPair(
        serviceWithCapture(() => {
            calls += 1;
            throw new PublicSessionProjectionError(failure, '/secret/path token=secret');
        })
    );
    for (const params of [
        { sessionId: 's1', cwd: 'relative', mcpServers: [] },
        { sessionId: 's1', cwd: '/work', mcpServers: [], additionalDirectories: ['/extra'] }
    ] as acp.LoadSessionRequest[]) {
        await assert.rejects(pair.client.loadSession(params), (error: unknown) => {
            assert.equal((error as acp.RequestError).code, -32602);
            return true;
        });
    }
    assert.equal(calls, 0);
    for (failure of ['session_unavailable', 'session_too_large', 'session_load_failed'] as const) {
        await assert.rejects(
            pair.client.loadSession({ sessionId: 's1', cwd: '/work', mcpServers: [] }),
            (error: unknown) => {
                const requestError = error as acp.RequestError;
                assert.equal(requestError.code, -32603);
                assert.deepEqual(requestError.data, { opendesk: { schemaVersion: 1, code: failure } });
                assert.equal(requestError.message.includes('/secret/path'), false);
                return true;
            }
        );
    }
    await pair.hosted.close();
});

test('SDK 1.3 normalizes a malformed MCP member before the Adapter', async () => {
    let calls = 0;
    const pair = await openPair(
        serviceWithCapture(() => {
            calls += 1;
            return { snapshot: STATE, sync: inertFeed('s1') };
        })
    );

    await assert.doesNotReject(
        pair.client.loadSession({
            sessionId: 's1',
            cwd: '/work',
            mcpServers: [{}]
        } as acp.LoadSessionRequest)
    );
    assert.equal(calls, 1);
    await pair.hosted.close();
});

test('Adapter rejects a legal nonempty MCP server before RSS', async () => {
    let calls = 0;
    const adapter = new MobileAcpAgentAdapter(
        {} as acp.AgentSideConnection,
        new AbortController().signal,
        serviceWithCapture(() => {
            calls += 1;
            return { snapshot: STATE, sync: inertFeed('s1') };
        }),
        () => undefined,
        () => undefined,
        () => undefined
    );

    await assert.rejects(
        adapter.loadSession({
            sessionId: 's1',
            cwd: '/workspace',
            mcpServers: [{ name: 'fixture', command: '/bin/true', args: [], env: [] }]
        }),
        (error: unknown) => error instanceof acp.RequestError && error.code === -32602
    );
    assert.equal(calls, 0);
});

test('awaits every snapshot notification before sending the next', async () => {
    let releaseFirstSend!: () => void;
    const firstSend = new Promise<void>((resolve) => {
        releaseFirstSend = resolve;
    });
    let calls = 0;
    const [clientPort, serverPort] = createTestChannelPair();
    const host = new MobileAcpConnectionHost({
        remoteSessionService: serviceWithCapture(() => ({ snapshot: STATE, sync: inertFeed('s1') })),
        diagnose: () => undefined
    });
    const hosted = host.open(serverPort, {});
    const binding = createAcpMessageStream(clientPort, new AbortController());
    const client = new acp.ClientSideConnection(
        () => ({
            async requestPermission() {
                return { outcome: { outcome: 'cancelled' } };
            },
            async sessionUpdate() {
                calls += 1;
            }
        }),
        binding.stream
    );
    await client.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    let writes = 0;
    serverPort.beforeSend = async () => {
        writes += 1;
        if (writes === 1) await firstSend;
    };
    const loading = client.loadSession({ sessionId: 's1', cwd: '/work', mcpServers: [] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 0);
    assert.equal(writes, 1);
    releaseFirstSend();
    await loading;
    assert.equal(calls, 2);
    assert.equal(writes, 3);
    await hosted.close();
});

test('deadline stops before a second notification and clears the active load', async () => {
    const connection = {
        async sessionUpdate() {
            return new Promise<void>(() => undefined);
        }
    } as unknown as acp.AgentSideConnection;
    const adapter = new MobileAcpAgentAdapter(
        connection,
        new AbortController().signal,
        serviceWithCapture(() => ({ snapshot: STATE, sync: inertFeed('s1') })),
        () => undefined,
        () => undefined,
        () => undefined,
        'test',
        10
    );
    await assert.rejects(adapter.loadSession({ sessionId: 's1', cwd: '/work', mcpServers: [] }), (error: unknown) => {
        assert.deepEqual((error as acp.RequestError).data, {
            opendesk: { schemaVersion: 1, code: 'session_load_failed' }
        });
        return true;
    });
});

test('sanitizes an unexpected RSS error and diagnoses it exactly once', async () => {
    const diagnostics: unknown[] = [];
    const [clientPort, serverPort] = createTestChannelPair();
    const host = new MobileAcpConnectionHost({
        remoteSessionService: serviceWithCapture(() => {
            throw new Error('/secret/path token=private');
        }),
        diagnose: (event) => diagnostics.push(event)
    });
    const hosted = host.open(serverPort, {});
    const events: acp.SessionNotification[] = [];
    const client = connectClient(clientPort, events);
    await client.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    await assert.rejects(client.loadSession({ sessionId: 's1', cwd: '/work', mcpServers: [] }), (error: unknown) => {
        const requestError = error as acp.RequestError;
        assert.equal(requestError.code, -32603);
        assert.deepEqual(requestError.data, {
            opendesk: { schemaVersion: 1, code: 'session_load_failed' }
        });
        assert.equal(requestError.message.includes('/secret/path'), false);
        return true;
    });
    assert.equal(diagnostics.length, 1);
    assert.equal((diagnostics[0] as { code?: unknown }).code, 'session_load_failed');
    await hosted.close();
});

test('covers the ActiveLoadAttempt and LoadedSession failure matrix through public behavior', async (t) => {
    let activeEvents: string[] | undefined;
    const stoppedGates = new WeakSet<PromptUpdateGate>();
    const disposedEncoders = new WeakSet<SessionNotificationEncoder>();
    const disposedEndpoints = new WeakSet<MobileInteractionDeliveryEndpoint>();
    const originalGateStop = PromptUpdateGate.prototype.stop;
    const originalEncoderDispose = SessionNotificationEncoder.prototype.dispose;
    const originalEndpointDispose = MobileInteractionDeliveryEndpoint.prototype.dispose;

    PromptUpdateGate.prototype.stop = function (reason?: Error): void {
        if (!stoppedGates.has(this)) {
            stoppedGates.add(this);
            activeEvents?.push('gate-stop');
        }
        originalGateStop.call(this, reason);
    };
    SessionNotificationEncoder.prototype.dispose = function (): void {
        if (!disposedEncoders.has(this)) {
            disposedEncoders.add(this);
            activeEvents?.push('encoder-dispose');
        }
        originalEncoderDispose.call(this);
    };
    MobileInteractionDeliveryEndpoint.prototype.dispose = function (): void {
        if (!disposedEndpoints.has(this)) {
            disposedEndpoints.add(this);
            activeEvents?.push(`endpoint-dispose:${this.sessionId}`);
        }
        originalEndpointDispose.call(this);
    };

    const cases: Array<{ name: string; run(): Promise<void> }> = [
        {
            name: 'old A is fully disposed before a failed B load and is never restored',
            async run() {
                const fixture = await createMatrixFixture();
                activeEvents = fixture.events;
                await fixture.adapter.loadSession(loadRequest('A'));
                // Providers may only re-offer a pending request after the load committed, never at registration.
                assert.deepEqual(
                    fixture.events.filter((event) => event.startsWith('endpoint-')),
                    ['endpoint-register:A', 'endpoint-ready']
                );
                fixture.events.length = 0;
                fixture.failedBegins.add('B');

                await assert.rejects(fixture.adapter.loadSession(loadRequest('B')), (error: unknown) => {
                    assert.deepEqual((error as acp.RequestError).data, {
                        opendesk: { schemaVersion: 1, code: 'session_load_failed' }
                    });
                    return true;
                });
                assert.deepEqual(fixture.events, [
                    'unregister:A',
                    'endpoint-dispose:A',
                    'sync-stop:A',
                    'gate-stop',
                    'encoder-dispose',
                    'begin:B'
                ]);
                // A load that never commits must not announce readiness.
                assert.equal(fixture.events.includes('endpoint-ready'), false);
                await assert.rejects(fixture.adapter.prompt({ sessionId: 'A', prompt: [{ type: 'text', text: 'x' }] }));
                await assert.rejects(fixture.adapter.prompt({ sessionId: 'B', prompt: [{ type: 'text', text: 'x' }] }));
                assert.equal(fixture.events.includes('fail-closed'), false);
            }
        },
        {
            name: 'deadline settles the waiter and a late snapshot send cannot output or commit',
            async run() {
                const fixture = await createMatrixFixture({ loadDeadlineMs: 10 });
                activeEvents = fixture.events;
                const firstSend = deferred<void>();
                let sends = 0;
                fixture.setSendUpdate(async () => {
                    sends += 1;
                    if (sends === 1) await firstSend.promise;
                });

                await assert.rejects(fixture.adapter.loadSession(loadRequest('A')), (error: unknown) => {
                    assert.deepEqual((error as acp.RequestError).data, {
                        opendesk: { schemaVersion: 1, code: 'session_load_failed' }
                    });
                    return true;
                });
                assert.equal(sends, 1);
                assert.deepEqual(
                    fixture.events.filter(
                        (event) =>
                            event.startsWith('sync-stop:') ||
                            event === 'gate-stop' ||
                            event === 'encoder-dispose' ||
                            event.startsWith('endpoint-')
                    ),
                    ['sync-stop:A', 'encoder-dispose']
                );

                firstSend.resolve();
                await new Promise((resolve) => setImmediate(resolve));
                await new Promise((resolve) => setImmediate(resolve));
                assert.equal(sends, 1);
                assert.equal(
                    fixture.events.some((event) => event === 'endpoint-register:A'),
                    false
                );
                assert.equal(fixture.events.includes('fail-closed'), false);
                await assert.doesNotReject(fixture.adapter.listSessions({}));
            }
        },
        {
            name: 'a sync fatal before commit settles activation and disposes only attempt resources',
            async run() {
                const fixture = await createMatrixFixture();
                activeEvents = fixture.events;
                fixture.deferActivation('A');
                const loading = fixture.adapter.loadSession(loadRequest('A'));
                await waitFor(() => fixture.events.includes('sync-activate:A'));
                fixture.feeds.get('A')!.fail();

                await assert.rejects(loading, (error: unknown) => {
                    assert.deepEqual((error as acp.RequestError).data, {
                        opendesk: { schemaVersion: 1, code: 'session_load_failed' }
                    });
                    return true;
                });
                assert.deepEqual(fixture.events.slice(-4), [
                    'sync-fatal:A',
                    'sync-stop:A',
                    'gate-stop',
                    'encoder-dispose'
                ]);
                assert.equal(
                    fixture.events.some((event) => event.startsWith('endpoint-')),
                    false
                );
                assert.equal(fixture.events.includes('fail-closed'), false);
            }
        },
        {
            name: 'a sync fatal after commit disposes loaded resources in order and fails closed once',
            async run() {
                const fixture = await createMatrixFixture();
                activeEvents = fixture.events;
                await fixture.adapter.loadSession(loadRequest('A'));
                fixture.events.length = 0;

                fixture.feeds.get('A')!.fail();
                fixture.feeds.get('A')!.fail();
                assert.deepEqual(fixture.events, [
                    'sync-fatal:A',
                    'unregister:A',
                    'endpoint-dispose:A',
                    'sync-stop:A',
                    'gate-stop',
                    'encoder-dispose',
                    'fail-closed'
                ]);
                await assert.rejects(fixture.adapter.prompt({ sessionId: 'A', prompt: [{ type: 'text', text: 'x' }] }));
            }
        },
        {
            name: 'connection close during list settles the waiter and rejects a late directory result',
            async run() {
                const fixture = await createMatrixFixture();
                activeEvents = fixture.events;
                await fixture.adapter.loadSession(loadRequest('A'));
                const listing = deferred<Awaited<ReturnType<RemoteSessionService['listSessions']>>>();
                fixture.setListSessions(() => listing.promise);
                fixture.events.length = 0;
                const response = fixture.adapter.listSessions({});
                await new Promise((resolve) => setImmediate(resolve));

                fixture.cleanup();
                fixture.controller.abort(new Error('connection closed'));
                await assert.rejects(response, (error: unknown) => (error as acp.RequestError).code === -32000);
                assert.deepEqual(fixture.events, [
                    'unregister:A',
                    'endpoint-dispose:A',
                    'sync-stop:A',
                    'gate-stop',
                    'encoder-dispose'
                ]);

                listing.resolve([
                    {
                        sessionId: 'late',
                        cwd: '/late',
                        title: 'late',
                        updatedAt: '2026-08-22T00:00:00.000Z',
                        taskStatus: 'running',
                        completionStatus: null
                    }
                ]);
                await new Promise((resolve) => setImmediate(resolve));
                assert.equal(fixture.events.includes('fail-closed'), false);
            }
        },
        {
            name: 'disconnect with an active prompt settles once and ignores a late start result',
            async run() {
                const fixture = await createMatrixFixture();
                activeEvents = fixture.events;
                await fixture.adapter.loadSession(loadRequest('A'));
                const started = deferred<Awaited<ReturnType<RemoteSessionService['startPrompt']>>>();
                let starts = 0;
                fixture.setStartPrompt(async () => {
                    starts += 1;
                    return started.promise;
                });
                fixture.events.length = 0;
                const prompt = fixture.adapter.prompt({ sessionId: 'A', prompt: [{ type: 'text', text: 'hello' }] });
                await new Promise((resolve) => setImmediate(resolve));

                fixture.cleanup();
                fixture.controller.abort(new Error('connection closed'));
                await assert.rejects(prompt, (error: unknown) => (error as acp.RequestError).code === -32000);
                assert.equal(starts, 1);
                assert.deepEqual(fixture.events, [
                    'unregister:A',
                    'endpoint-dispose:A',
                    'sync-stop:A',
                    'gate-stop',
                    'encoder-dispose'
                ]);

                started.resolve({
                    kind: 'started',
                    userMessageId: 'late-user',
                    completion: Promise.resolve({ stoppedByUser: false })
                });
                await new Promise((resolve) => setImmediate(resolve));
                assert.equal(starts, 1);
                assert.equal(fixture.updates.length, 2);
                assert.equal(fixture.events.includes('fail-closed'), false);
            }
        },
        {
            name: 'unsubscribe and repeated host cleanup dispose every resource and physical channel once',
            async run() {
                const events: string[] = [];
                activeEvents = events;
                const feed = new MatrixFeed('A', events, false);
                const deliveryChannel = new RecordingDeliveryChannel(events);
                const host = new MobileAcpConnectionHost({
                    remoteSessionService: serviceWithCapture(() => ({ snapshot: stateFor('A'), sync: feed })),
                    diagnose: () => undefined,
                    mobileInteractions: {
                        deliveryChannel,
                        answerAuthorizer: { authorizeInteractionAnswer() {} }
                    }
                });
                const [clientPort, serverPort] = createTestChannelPair();
                const hosted = host.open(serverPort, {});
                const client = connectClient(clientPort, []);
                await client.initialize({
                    protocolVersion: acp.PROTOCOL_VERSION,
                    clientCapabilities: { _meta: { opendesk: { interaction: INTERACTION_CAPABILITY } } }
                });
                await client.loadSession(loadRequest('A'));
                events.length = 0;

                await client.extNotification('_opendesk/session/unsubscribe', { sessionId: 'A' });
                await client.extNotification('_opendesk/session/unsubscribe', { sessionId: 'A' });
                await Promise.all([hosted.close(), hosted.close()]);
                await host.close();
                await Promise.all([hosted.closed, client.closed]);

                assert.deepEqual(events, [
                    'unregister:A',
                    'endpoint-dispose:A',
                    'sync-stop:A',
                    'gate-stop',
                    'encoder-dispose'
                ]);
                assert.equal(serverPort.events.filter((event) => event === 'port-close').length, 1);
                assert.equal(serverPort.listenerCount, 0);
                assert.equal(clientPort.listenerCount, 0);
            }
        }
    ];

    try {
        for (const scenario of cases) {
            await t.test(scenario.name, scenario.run);
        }
    } finally {
        activeEvents = undefined;
        PromptUpdateGate.prototype.stop = originalGateStop;
        SessionNotificationEncoder.prototype.dispose = originalEncoderDispose;
        MobileInteractionDeliveryEndpoint.prototype.dispose = originalEndpointDispose;
    }
});
