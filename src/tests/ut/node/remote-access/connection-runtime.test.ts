import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { startMobileHostComposition } from '../../../../main/applications/mobileaccess/acp/mobile/host-composition.js';
import { createInteractionDeliveryRuntime } from '../../../../main/aikernel/interaction/delivery.js';
import { createInteractionSessionScopeResolver } from '../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/session-projector.js';
import {
    createConnectionRuntime,
    createSignalingSocket,
    composeRegistrationConnection,
    type ConnectionRuntimeOptions,
    type DesktopNetworkTransport
} from '../../../../main/applications/mobileaccess/remote-access/connection-runtime.js';
import type { RegistrationQualification } from '../../../../main/applications/mobileaccess/remote-access/registration-runtime.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/remote-network-v1.json', import.meta.url), 'utf8'));
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('production signaling adapter exchanges text without compression and rejects binary input', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: true });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    let client: ReturnType<typeof createSignalingSocket> | undefined;
    try {
        const peerPromise = new Promise<import('ws').WebSocket>((resolve) => server.once('connection', resolve));
        client = createSignalingSocket(`ws://127.0.0.1:${address.port}/api/v1/remote-network/ws`);
        const messages: string[] = [];
        client.onMessage((raw) => messages.push(raw));
        let closed = 0;
        const closing = new Promise<void>((resolve) =>
            client!.onClose(() => {
                closed++;
                resolve();
            })
        );
        await client.opened;
        const peer = await peerPromise;
        assert.equal(peer.extensions, '');
        const received = new Promise<string>((resolve) => peer.once('message', (data) => resolve(data.toString())));
        await client.send('{"type":"synthetic"}');
        assert.equal(await received, '{"type":"synthetic"}');
        peer.send(Buffer.from('binary'), { binary: true });
        await closing;
        client.close();
        assert.equal(closed, 1);
        assert.deepEqual(messages, []);
        await assert.rejects(async () => client!.send('{}'), /signaling_lost/);
    } finally {
        client?.close();
        for (const peer of server.clients) peer.terminate();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

test('production composition defaults to the real signaling socket without a test factory', async () => {
    const h = harness();
    await h.runtime.close();
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const credential = h.options.registration.getCredential()!;
    h.options.registration.getCredential = () => ({
        ...credential,
        baseUrl: `http://127.0.0.1:${address.port}/api/v1`
    });
    let composition: { close(): Promise<void> } | undefined;
    try {
        const auth = new Promise<any>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('formal signaling was not started')), 300);
            server.once('connection', (peer) =>
                peer.once('message', (raw) => {
                    clearTimeout(timeout);
                    resolve(JSON.parse(raw.toString()));
                })
            );
        });
        composition = composeRegistrationConnection({ ...h.options, createSocket: undefined, allowLoopback: true });
        assert.equal((await auth).type, 'auth');
        assert.equal(h.transports.length, 0, 'WS startup does not bypass data channel acceptance');
    } finally {
        await composition?.close();
        for (const peer of server.clients) peer.terminate();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

test('production composition passes trusted ACP to the real Host and releases only that connection', async () => {
    const h = harness();
    await h.runtime.close();
    h.sockets.length = 0;
    let network!: { close(): Promise<void> };
    let registrationCloses = 0;
    h.options.registration.close = async () => {
        registrationCloses++;
    };
    const composition = await startMobileHostComposition({
        hostCapabilities: {
            getTaskList: () => [],
            getTaskLoadResult: () => ({ task: undefined, corrupted: false }),
            getDefaultWorkspace: () => '/isolated-test',
            subscribeTaskUpdates: () => () => undefined,
            subscribeTaskManagerUpdates: () => () => undefined,
            sessionModelSource: {
                listConfiguredModelAliases: () => [],
                resolveChatModel: () => undefined,
                resolveEffectiveDefaultModel: () => ({ kind: 'unconfigured' })
            }
        },
        interactionRuntime: createInteractionDeliveryRuntime(createInteractionSessionScopeResolver(() => [])),
        signal: new AbortController().signal,
        diagnose: () => undefined,
        startNetwork: async ({ signal, openConnection }) => {
            network = composeRegistrationConnection({ ...h.options, signal, openConnection });
            return network;
        }
    });
    try {
        await h.start();
        await h.incoming();
        await h.ticket();
        await h.readback();
        await h.activate();
        assert.equal(h.transports[0].raw.sent.at(-1).type, 'ready');
        h.transports[0].raw.receive(h.control('ready_ack'));
        h.transports[0].raw.receive({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: 1, clientCapabilities: {} }
        });
        await tick();
        await tick();
        assert.equal(h.transports[0].raw.sent.find((frame) => frame.id === 1)?.result.protocolVersion, 1);
        h.revoke();
        await tick();
        assert.equal(h.transports[0].closeCalls, 1);
        assert.equal(registrationCloses, 0, 'a phone disconnect does not stop the registration or Host composition');
    } finally {
        await composition.close();
    }
    assert.equal(registrationCloses, 1);
});
function deferred<T = void>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}
class Channel {
    sent: any[] = [];
    messages = new Set<(message: string) => void>();
    closes = new Set<() => void>();
    opened = Promise.resolve();
    ended = false;
    send(message: string) {
        this.sent.push(JSON.parse(message));
    }
    onMessage(listener: (message: string) => void) {
        this.messages.add(listener);
        return () => {
            this.messages.delete(listener);
        };
    }
    onClose(listener: () => void) {
        this.closes.add(listener);
        return () => {
            this.closes.delete(listener);
        };
    }
    receive(message: unknown) {
        for (const listener of this.messages) listener(JSON.stringify(message));
    }
    close() {
        if (this.ended) return;
        this.ended = true;
        for (const listener of this.closes) listener();
    }
}
function harness(expiresAt = 90000) {
    let now = 0;
    const timers = new Set<{ callback: () => void; at: number }>();
    let q: RegistrationQualification = {
        deviceId: 'pc',
        runId: randomUUID(),
        accountScope: 'scope',
        role: 'current',
        generation: 1,
        expiresAt,
        reason: 'confirmed'
    };
    const qualificationListeners = new Set<(value: RegistrationQualification) => void>();
    const credential = {
        accountScope: 'scope',
        baseUrl: 'https://example.test/api/v1',
        accessToken: 'test-credential',
        version: 0
    };
    const credentialListeners = new Set<() => void>();
    const sockets: Channel[] = [],
        transports: Array<
            DesktopNetworkTransport & {
                raw: Channel;
                done: ReturnType<typeof deferred<void>>;
                read: ReturnType<typeof deferred<any>>;
                closeCalls: number;
            }
        > = [];
    const received: string[] = [];
    // G1 激活的全局次序计数，用于断言激活排在核验之后、gate 打开之前。
    let activationOrder = 0;
    const trustedContexts: any[] = [];
    const gateChannels: any[] = [];
    let holdClose = false;
    const abort = new AbortController();
    const owner = { hostInstanceId: 'host-9', generation: 3 };
    const options: ConnectionRuntimeOptions = {
        signal: abort.signal,
        registration: {
            getQualification: () => ({ ...q }),
            subscribeQualification: (listener) => {
                qualificationListeners.add(listener);
                return () => {
                    qualificationListeners.delete(listener);
                };
            },
            getCredential: () => ({ ...credential }),
            subscribeCredential: (listener) => {
                credentialListeners.add(listener);
                return () => {
                    credentialListeners.delete(listener);
                };
            },
            reportCredentialFailure: () => undefined,
            suspend: () => undefined,
            resume: () => undefined,
            close: async () => undefined
        },
        createSocket: () => {
            const socket = new Channel();
            sockets.push(socket);
            return socket;
        },
        bridge: {
            owner,
            create: async () => {
                const raw = new Channel(),
                    done = deferred(),
                    read = deferred<any>();
                const transport = {
                    instance: {},
                    owner,
                    channel: raw,
                    raw,
                    done,
                    read,
                    closeCalls: 0,
                    // G1 可观察记录：记录调用次序/次数与调用时的通道状态。
                    // 不能用空函数放行——空函数证明不了激活确实发生在信令核验完成之后。
                    activations: [] as Array<{ order: number; closed: boolean; businessDelivered: number }>,
                    opened: Promise.resolve(),
                    closed: done.promise,
                    answer: async () => fixture.sdp.valid[0],
                    addCandidate: async () => undefined,
                    readback: () => read.promise,
                    activateTrusted: () => {
                        transport.activations.push({
                            order: ++activationOrder,
                            closed: transport.closeCalls > 0,
                            // 激活必须发生在 gate 打开之前：此刻上层还不该收到任何业务消息。
                            businessDelivered: received.length
                        });
                    },
                    close: async () => {
                        transport.closeCalls++;
                        raw.close();
                        if (!holdClose) done.resolve();
                        await done.promise;
                    }
                };
                transports.push(transport);
                return transport;
            }
        },
        openConnection: (channel, context) => {
            gateChannels.push(channel);
            trustedContexts.push(context);
            channel.onMessage((message) => received.push(message));
            return { closed: Promise.resolve(), close: async () => undefined };
        },
        now: () => now,
        wallTime: () => 0,
        setTimeout: (callback, delay) => {
            const timer = { callback, at: now + delay };
            timers.add(timer);
            return timer;
        },
        clearTimeout: (timer) => {
            timers.delete(timer as any);
        }
    };
    const runtime = createConnectionRuntime(options);
    const epoch = randomUUID(),
        socketId = randomUUID(),
        attemptId = randomUUID();
    const frame = (type: string, payload: Record<string, unknown> = {}, id = attemptId) => ({
        version: 1,
        type,
        server_epoch: epoch,
        socket_id: socketId,
        attempt_id: id,
        payload
    });
    const control = (type: string, payload: Record<string, unknown> = {}) => ({
        version: 1,
        type,
        attempt_id: attemptId,
        payload
    });
    return {
        runtime,
        sockets,
        transports,
        received,
        gateChannels,
        trustedContexts,
        options,
        timers,
        abort,
        frame,
        control,
        attemptId,
        rotateCredential: () => {
            credential.version++;
            for (const listener of credentialListeners) listener();
        },
        setHoldClose: () => {
            holdClose = true;
        },
        revoke: () => {
            q = { ...q, role: null, generation: q.generation + 1 };
            for (const listener of qualificationListeners) listener(q);
        },
        advance: async (ms: number) => {
            now += ms;
            for (const timer of [...timers])
                if (timer.at <= now) {
                    timers.delete(timer);
                    timer.callback();
                }
            await tick();
        },
        start: async (
            limits = fixture.frames.find((frame: any) => frame.value.type === 'auth_ok').value.payload.limits
        ) => {
            await tick();
            assert.equal(sockets.length, 1, 'current registration creates exactly one notification WS');
            assert.equal(sockets[0].sent[0]?.type, 'auth');
            sockets[0].receive({
                version: 1,
                type: 'auth_ok',
                payload: {
                    version: 1,
                    server_epoch: epoch,
                    socket_id: socketId,
                    limits
                }
            });
            await tick();
        },
        incoming: async (
            id = attemptId,
            turn: unknown = { status: 'unavailable', reason: 'not_configured' },
            remainingMs = 60000
        ) => {
            sockets[0].receive(
                frame(
                    'incoming_connection',
                    {
                        user_id: '1',
                        device_id: 'pc',
                        run_id: q.runId,
                        remaining_ms: remainingMs,
                        turn
                    },
                    id
                )
            );
            await tick();
        },
        ticket: async () => {
            sockets[0].receive(frame('offer', { sdp: fixture.sdp.valid[0] }));
            await tick();
            const digest = fixture.sdp.valid[0].match(/a=fingerprint:sha-256 ([^\r\n]+)/i)[1];
            sockets[0].receive(
                frame('ticket', {
                    secret: fixture.ticket.secret,
                    valid_for_ms: 30000,
                    mobile_fingerprint: { algorithm: 'sha-256', digest },
                    pc_fingerprint: { algorithm: 'sha-256', digest }
                })
            );
            await tick();
        },
        readback: async (overrides = {}) => {
            const transport = transports[0];
            transport.read.resolve({
                instance: transport.instance,
                owner,
                channel: transport.channel,
                state: 'open',
                stable: true,
                localDescription: fixture.sdp.valid[0],
                remoteDescription: fixture.sdp.valid[0],
                ...overrides
            });
            await tick();
        },
        activate: async () => {
            transports[0].raw.receive(control('present_ticket', { secret: fixture.ticket.secret }));
            await tick();
            transports[0].raw.receive(control('confirm'));
            await tick();
            sockets[0].receive(frame('activate_ok'));
            await tick();
        }
    };
}

test('PC accepts one slot before creating the data channel and admits ACP only after ready_ack', async () => {
    const h = harness();
    try {
        await h.start();
        assert.equal(h.transports.length, 0);
        await h.incoming();
        assert.equal(h.sockets[0].sent.at(-1).type, 'accept');
        assert.equal(h.transports.length, 1);
        await h.incoming(randomUUID());
        assert.equal(h.sockets[0].sent.at(-1).payload.code, 'remote_pc_busy');
        await h.ticket();
        await h.readback();
        await h.activate();
        assert.equal(h.gateChannels.length, 1);
        assert.equal(h.transports[0].raw.sent.at(-1).type, 'ready');
        assert.deepEqual(h.received, []);
        h.transports[0].raw.receive(h.control('ready_ack'));
        await tick();
        h.transports[0].raw.receive({ jsonrpc: '2.0', method: 'initialize' });
        await tick();
        assert.equal(h.received.length, 1);
        h.revoke();
        h.transports[0].raw.receive({ jsonrpc: '2.0', method: 'session/prompt' });
        assert.equal(h.received.length, 1, 'revocation closes business gate synchronously');
    } finally {
        await h.runtime.close();
    }
});

for (const [name, overrides] of Object.entries({
    'wrong owner': { owner: { hostInstanceId: 'host-10', generation: 3 } },
    'wrong generation': { owner: { hostInstanceId: 'host-9', generation: 4 } },
    'empty local': { localDescription: null },
    'empty remote': { remoteDescription: null },
    unstable: { stable: false },
    'ICE without open': { state: 'connecting' },
    'extra media': { remoteDescription: fixture.sdp.valid[0] + '\r\nm=audio 9 UDP/TLS/RTP/SAVPF 0\r\n' },
    'different fingerprint': {
        localDescription: fixture.sdp.valid[0].replace(
            /a=fingerprint:[^\r\n]+/i,
            'a=fingerprint:sha-256 ' + Array(32).fill('FF').join(':')
        )
    }
})) {
    test(`PC rejects ${name} readback before Ticket consumption`, async () => {
        const h = harness();
        try {
            await h.start();
            await h.incoming();
            await h.ticket();
            h.transports[0].raw.receive(h.control('present_ticket', { secret: fixture.ticket.secret }));
            await h.readback(overrides);
            assert.deepEqual(h.transports[0].raw.sent, []);
            assert.equal(h.gateChannels.length, 0);
            assert.equal(h.transports[0].closeCalls, 1);
        } finally {
            await h.runtime.close();
        }
    });
}

test('PC answer-time Ticket expiry closes before the original total deadline', async () => {
    const h = harness();
    try {
        await h.start();
        await h.incoming();
        await h.advance(5000);
        await h.ticket();
        await h.readback();
        await h.advance(30000);
        h.transports[0].raw.receive(h.control('present_ticket', { secret: fixture.ticket.secret }));
        await tick();
        assert.deepEqual(h.transports[0].raw.sent, []);
        assert.equal(h.transports[0].closeCalls, 1);
    } finally {
        await h.runtime.close();
    }
});

test('PC cannot reuse a consumed Ticket when confirm is duplicated', async () => {
    const h = harness();
    try {
        await h.start();
        await h.incoming();
        await h.ticket();
        await h.readback();
        h.transports[0].raw.receive(h.control('present_ticket', { secret: fixture.ticket.secret }));
        await tick();
        h.transports[0].raw.receive(h.control('present_ticket', { secret: fixture.ticket.secret }));
        await tick();
        assert.equal(h.transports[0].raw.sent.filter((frame) => frame.type === 'ticket_accepted').length, 1);
        assert.equal(h.transports[0].closeCalls, 1);
        assert.equal(h.gateChannels.length, 0);
    } finally {
        await h.runtime.close();
    }
});

test('active channel survives notification loss and exactly one reconnect waits five seconds', async () => {
    const h = harness();
    try {
        await h.start();
        await h.incoming();
        await h.ticket();
        await h.readback();
        await h.activate();
        h.transports[0].raw.receive(h.control('ready_ack'));
        await tick();
        h.sockets[0].receive(h.frame('attempt_failed', { code: 'attempt_not_available' }));
        h.sockets[0].receive(h.frame('cancel', { code: 'cancelled' }));
        await tick();
        assert.equal(h.transports[0].closeCalls, 0, 'late coordination failures cannot revoke an active channel');
        h.sockets[0].close();
        h.sockets[0].close();
        await tick();
        assert.equal(h.transports[0].closeCalls, 0);
        await h.advance(4999);
        assert.equal(h.sockets.length, 1);
        await h.advance(1);
        assert.equal(h.sockets.length, 2);
        assert.equal(h.transports[0].closeCalls, 0);
    } finally {
        await h.runtime.close();
    }
});

const heartbeatLimits = fixture.frames.find((frame: any) => frame.value.type === 'auth_ok').value.payload.limits;
const heartbeatWindow =
    heartbeatLimits.ping_idle_ms + heartbeatLimits.pong_ms + heartbeatLimits.send_ms + heartbeatLimits.scan_ms;
function signalingFrame(h: ReturnType<typeof harness>, type: string, payload: Record<string, unknown> = {}) {
    const frame = h.frame(type, payload);
    delete (frame as Partial<typeof frame>).attempt_id;
    return frame;
}

test('authenticated signaling silence closes the socket and reconnects once with registration still valid', async () => {
    const h = harness(1e9);
    const diagnostics: Array<{ code: string; detail?: string }> = [];
    h.options.diagnose = (event) => diagnostics.push(event);
    try {
        await h.start();
        await h.advance(heartbeatWindow - 1);
        assert.equal(h.sockets[0].ended, false);
        await h.advance(1);
        assert.equal(h.sockets[0].ended, true);
        assert.equal(h.sockets[0].messages.size, 0);
        assert.equal(h.sockets[0].closes.size, 0);
        assert.ok(diagnostics.some((event) => event.detail?.includes('heartbeat timed out')));
        await h.advance(4999);
        assert.equal(h.sockets.length, 1);
        await h.advance(1);
        assert.equal(h.sockets.length, 2);
        assert.equal(h.sockets[1].sent[0].type, 'auth');
    } finally {
        await h.runtime.close();
    }
});

test('signaling watchdog uses the authenticated server heartbeat limits', async () => {
    const h = harness();
    const limits = { ...heartbeatLimits, ping_idle_ms: 10000, pong_ms: 2000, send_ms: 1000, scan_ms: 500 };
    try {
        await h.start(limits);
        await h.advance(13499);
        assert.equal(h.sockets[0].ended, false);
        await h.advance(1);
        assert.equal(h.sockets[0].ended, true);
    } finally {
        await h.runtime.close();
    }
});

test('normal authenticated pings keep signaling alive across multiple watchdog windows', async () => {
    const h = harness(1e9);
    try {
        await h.start();
        for (let i = 0; i < 5; i++) {
            await h.advance(31000);
            const nonce = randomUUID();
            h.sockets[0].receive(signalingFrame(h, 'ping', { nonce }));
            await tick();
            assert.equal(h.sockets[0].sent.at(-1).type, 'pong');
            assert.equal(h.sockets[0].sent.at(-1).payload.nonce, nonce);
            assert.equal(h.sockets[0].ended, false);
        }
        assert.equal(h.sockets.length, 1);
        await h.advance(heartbeatWindow);
        assert.equal(h.sockets[0].ended, true);
    } finally {
        await h.runtime.close();
    }
});

test('a queued timeout from before a valid ping cannot close the refreshed notification', async () => {
    const h = harness();
    try {
        await h.start();
        const lateTimer = [...h.timers][0].callback;
        await h.advance(40000);
        h.sockets[0].receive(signalingFrame(h, 'ping', { nonce: randomUUID() }));
        await tick();
        await h.advance(heartbeatWindow - 40000);
        lateTimer();
        assert.equal(h.sockets[0].ended, false);
        await h.advance(40000);
        assert.equal(h.sockets[0].ended, true);
    } finally {
        await h.runtime.close();
    }
});

test('production signaling adapter replaces a silent authenticated TCP connection without peer close', async () => {
    const h = harness(1e9);
    await h.runtime.close();
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const credential = h.options.registration.getCredential()!;
    h.options.registration.getCredential = () => ({
        ...credential,
        baseUrl: `http://127.0.0.1:${address.port}/api/v1`
    });
    const peers: Array<import('ws').WebSocket> = [];
    server.on('connection', (peer) => {
        peers.push(peer);
        peer.once('message', (raw) => {
            assert.equal(JSON.parse(raw.toString()).type, 'auth');
            peer.send(
                JSON.stringify({
                    version: 1,
                    type: 'auth_ok',
                    payload: {
                        version: 1,
                        server_epoch: randomUUID(),
                        socket_id: randomUUID(),
                        limits: heartbeatLimits
                    }
                })
            );
        });
    });
    const until = async (check: () => boolean) => {
        for (let i = 0; i < 100; i++) {
            if (check()) return;
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
        assert.fail('isolated signaling socket condition timed out');
    };
    const runtime = createConnectionRuntime({ ...h.options, createSocket: undefined, allowLoopback: true });
    try {
        await until(() => [...h.timers].some((timer) => timer.at === heartbeatWindow));
        assert.equal(peers.length, 1);
        assert.equal(peers[0].readyState, peers[0].OPEN);
        await h.advance(heartbeatWindow);
        await until(() => peers[0].readyState === peers[0].CLOSED);
        await h.advance(5000);
        await until(() => peers.length === 2 && [...h.timers].some((timer) => timer.at === 2 * heartbeatWindow + 5000));
        assert.equal(peers[1].readyState, peers[1].OPEN);
    } finally {
        await runtime.close();
        for (const peer of server.clients) peer.terminate();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

test('validated credential acknowledgements also renew signaling liveness', async () => {
    const h = harness(1e9);
    try {
        await h.start();
        await h.advance(40000);
        h.rotateCredential();
        await tick();
        assert.equal(h.sockets[0].sent.at(-1).type, 'auth_update');
        h.sockets[0].receive(signalingFrame(h, 'auth_updated', { credential_version: 1 }));
        await tick();
        await h.advance(heartbeatWindow - 1);
        assert.equal(h.sockets[0].ended, false);
        await h.advance(1);
        assert.equal(h.sockets[0].ended, true);
    } finally {
        await h.runtime.close();
    }
});

test('outbound negotiation permits the server to postpone its idle ping', async () => {
    const h = harness(1e9);
    try {
        await h.start();
        await h.advance(40000);
        await h.incoming();
        await h.advance(20000);
        h.sockets[0].receive(h.frame('offer', { sdp: fixture.sdp.valid[0] }));
        await tick();
        assert.equal(h.sockets[0].sent.at(-1).type, 'answer');
        await h.advance(31000);
        assert.equal(h.sockets[0].ended, false);
        h.sockets[0].receive(signalingFrame(h, 'ping', { nonce: randomUUID() }));
        await tick();
        assert.equal(h.sockets[0].ended, false);
        assert.equal(h.sockets.length, 1);
    } finally {
        await h.runtime.close();
    }
});

test('outbound success alone cannot postpone authenticated silence indefinitely', async () => {
    const h = harness(1e9);
    try {
        await h.start();
        for (let i = 0; i < 3; i++) {
            await h.advance(35000);
            h.rotateCredential();
            await tick();
            assert.equal(h.sockets[0].ended, false);
        }
        await h.advance(heartbeatLimits.attempt_ms + heartbeatWindow - 105000);
        assert.equal(h.sockets[0].ended, true);
        await h.advance(5000);
        assert.equal(h.sockets.length, 2);
    } finally {
        await h.runtime.close();
    }
});

for (const field of ['server_epoch', 'socket_id'] as const) {
    test(`a ping from another ${field} cannot refresh the signaling watchdog`, async () => {
        const h = harness();
        try {
            await h.start();
            await h.advance(40000);
            h.sockets[0].receive({ ...signalingFrame(h, 'ping', { nonce: randomUUID() }), [field]: randomUUID() });
            await tick();
            assert.equal(h.sockets[0].sent.filter((frame) => frame.type === 'pong').length, 0);
            await h.advance(heartbeatWindow - 40000);
            assert.equal(h.sockets[0].ended, true);
        } finally {
            await h.runtime.close();
        }
    });
}

test('watchdog recovery preserves active ACP and ignores late events from the retired notification', async () => {
    const h = harness(1e9);
    try {
        await h.start();
        await h.incoming();
        await h.ticket();
        await h.readback();
        await h.activate();
        h.transports[0].raw.receive(h.control('ready_ack'));
        await tick();
        const lateMessage = [...h.sockets[0].messages][0];
        const lateClose = [...h.sockets[0].closes][0];
        const lateTimer = [...h.timers].find((timer) => timer.at === heartbeatWindow)!.callback;
        await h.advance(heartbeatWindow);
        assert.equal(h.sockets[0].ended, true);
        assert.equal(h.transports[0].closeCalls, 0);
        await h.advance(5000);
        h.sockets[1].receive({
            version: 1,
            type: 'auth_ok',
            payload: {
                version: 1,
                server_epoch: randomUUID(),
                socket_id: randomUUID(),
                limits: heartbeatLimits
            }
        });
        lateTimer();
        lateClose();
        lateMessage(JSON.stringify(signalingFrame(h, 'ping', { nonce: randomUUID() })));
        await tick();
        assert.equal(h.sockets[1].ended, false);
        assert.equal(h.sockets[1].sent.filter((frame) => frame.type === 'pong').length, 0);
        h.transports[0].raw.receive({ jsonrpc: '2.0', method: 'session/notification', params: {} });
        await tick();
        assert.equal(h.received.length, 1);
        assert.equal(h.transports[0].closeCalls, 0);
        await h.advance(heartbeatWindow - 1);
        assert.equal(h.sockets[1].ended, false);
        await h.advance(1);
        assert.equal(h.sockets[1].ended, true, 'old events cannot renew the replacement notification');
    } finally {
        await h.runtime.close();
    }
});

test('signaling watchdog loss releases an unfinished negotiation', async () => {
    const h = harness(1e9);
    try {
        await h.start();
        await h.incoming();
        await h.advance(heartbeatWindow);
        assert.equal(h.sockets[0].ended, true);
        assert.equal(h.transports[0].closeCalls, 1);
        await h.advance(5000);
        assert.equal(h.sockets.length, 2);
    } finally {
        await h.runtime.close();
    }
});

for (const stop of ['close', 'abort', 'revoke'] as const) {
    test(`${stop} clears the signaling watchdog and prevents further reconnects`, async () => {
        const h = harness(1e9);
        try {
            await h.start();
            const lateTimer = [...h.timers][0].callback;
            if (stop === 'close') await h.runtime.close();
            else if (stop === 'abort') h.abort.abort();
            else h.revoke();
            await tick();
            assert.equal(h.timers.size, 0);
            lateTimer();
            await h.advance(120000);
            assert.equal(h.sockets.length, 1);
            assert.equal(h.sockets[0].ended, true);
        } finally {
            await h.runtime.close();
        }
    });
}

test('explicit close cancels the watchdog and still schedules exactly one reconnect', async () => {
    const h = harness(1e9);
    try {
        await h.start();
        const lateTimer = [...h.timers][0].callback;
        h.sockets[0].close();
        h.sockets[0].close();
        lateTimer();
        await h.advance(5000);
        assert.equal(h.sockets.length, 2);
        assert.equal(h.timers.size, 1, 'only the replacement authentication deadline remains');
    } finally {
        await h.runtime.close();
    }
});

test('notification auth handshake has a finite deadline even if the server stays silent', async () => {
    const h = harness();
    try {
        await tick();
        assert.equal(h.sockets.length, 1);
        await h.advance(5000);
        assert.equal(h.sockets[0].ended, true);
    } finally {
        await h.runtime.close();
    }
});

test('local ICE emitted during construction waits behind the answer on the authenticated WS', async () => {
    const h = harness();
    const create = h.options.bridge.create;
    h.options.bridge.create = async (input) => {
        input.candidate({ candidate: 'candidate:synthetic', sdpMid: 'data', sdpMLineIndex: 0 });
        input.candidate(null);
        return create(input);
    };
    try {
        await h.start();
        await h.incoming();
        assert.equal(
            h.sockets[0].sent.some((frame) => frame.type === 'candidate'),
            false
        );
        await h.ticket();
        const types = h.sockets[0].sent.map((frame) => frame.type);
        assert.ok(types.indexOf('answer') < types.indexOf('candidate'));
        assert.ok(types.indexOf('candidate') < types.indexOf('candidates_complete'));
    } finally {
        await h.runtime.close();
    }
});

test('a synchronously rejected bridge still closes its late instance before releasing the slot', async () => {
    const h = harness();
    const create = h.options.bridge.create;
    h.options.bridge.create = async (input) => {
        for (let i = 0; i < 257; i++)
            input.candidate({ candidate: `candidate:${i}`, sdpMid: 'data', sdpMLineIndex: 0 });
        return create(input);
    };
    try {
        await h.start();
        await h.incoming();
        await tick();
        assert.equal(h.transports[0].closeCalls, 1);
    } finally {
        await h.runtime.close();
    }
});

test('ICE completion cannot overtake buffered candidates while the writer is blocked', async () => {
    const h = harness();
    const create = h.options.bridge.create;
    let emit!: (candidate: Record<string, unknown> | null) => void;
    h.options.bridge.create = async (input) => {
        emit = input.candidate;
        for (const candidate of ['candidate:first', 'candidate:second'])
            emit({ candidate, sdpMid: 'data', sdpMLineIndex: 0 });
        return create(input);
    };
    const blocked = deferred();
    try {
        await h.start();
        await h.incoming();
        const socket = h.sockets[0];
        const send = socket.send.bind(socket);
        socket.send = (raw) => {
            send(raw);
            if (JSON.parse(raw).payload.candidate === 'candidate:first') return blocked.promise;
        };
        socket.receive(h.frame('offer', { sdp: fixture.sdp.valid[0] }));
        await tick();
        emit(null);
        blocked.resolve();
        await tick();
        assert.deepEqual(
            socket.sent
                .filter((frame) => ['candidate', 'candidates_complete'].includes(frame.type))
                .map((frame) => frame.payload.candidate ?? frame.type),
            ['candidate:first', 'candidate:second', 'candidates_complete']
        );
    } finally {
        blocked.resolve();
        await h.runtime.close();
    }
});

test('candidate end marker is single-use and later candidates terminate negotiation', async () => {
    const h = harness();
    try {
        await h.start();
        await h.incoming();
        await h.ticket();
        h.sockets[0].receive(h.frame('candidates_complete'));
        await tick();
        h.sockets[0].receive(h.frame('candidate', { candidate: 'candidate:test', sdpMid: 'data', sdpMLineIndex: 0 }));
        await tick();
        assert.equal(h.transports[0].closeCalls, 1);
    } finally {
        await h.runtime.close();
    }
});

test('active ACP messages use data channel business capacity instead of signaling queue limits', async () => {
    const h = harness();
    try {
        await h.start();
        await h.incoming();
        await h.ticket();
        await h.readback();
        await h.activate();
        h.transports[0].raw.receive(h.control('ready_ack'));
        await tick();
        h.transports[0].raw.receive({ jsonrpc: '2.0', method: 'session/prompt', params: { text: 'x'.repeat(300000) } });
        await tick();
        assert.equal(h.received.length, 1);
        assert.equal(h.transports[0].closeCalls, 0);
    } finally {
        await h.runtime.close();
    }
});

test('expired outbound work does not send an answer after its notification queue unblocks', async () => {
    const h = harness();
    const held = deferred();
    try {
        await h.start();
        await h.incoming();
        const original = h.sockets[0].send.bind(h.sockets[0]);
        h.sockets[0].send = (message) => {
            original(message);
            return held.promise;
        };
        const ping = h.frame('ping', { nonce: randomUUID() });
        delete (ping as Partial<typeof ping>).attempt_id;
        h.sockets[0].receive(ping);
        await tick();
        h.sockets[0].receive(h.frame('offer', { sdp: fixture.sdp.valid[0] }));
        await tick();
        h.revoke();
        held.resolve();
        await tick();
        assert.equal(h.sockets[0].sent.filter((frame) => frame.type === 'answer').length, 0);
    } finally {
        held.resolve();
        await h.runtime.close();
    }
});

test('registration and connection composition closes both sides exactly once despite a rejection', async () => {
    const h = harness();
    await h.runtime.close();
    let registrationCloses = 0;
    h.options.registration.close = async () => {
        registrationCloses++;
        throw new Error('synthetic cleanup');
    };
    const composed = composeRegistrationConnection(h.options);
    await tick();
    const closing = composed.close();
    assert.equal(composed.close(), closing);
    await assert.rejects(closing, /synthetic cleanup/);
    assert.equal(registrationCloses, 1);
    assert.equal(h.sockets.at(-1)!.ended, true);
});

test('readback from another instance never consumes Ticket or opens the Host', async () => {
    const h = harness();
    try {
        await h.start();
        await h.incoming();
        await h.ticket();
        h.transports[0].raw.receive(h.control('present_ticket', { secret: fixture.ticket.secret }));
        await tick();
        assert.equal(h.transports[0].raw.sent.length, 0);
        await h.readback({ instance: {} });
        assert.equal(h.transports[0].raw.sent.length, 0);
        assert.equal(h.gateChannels.length, 0);
        assert.equal(h.transports[0].closeCalls, 1);
    } finally {
        await h.runtime.close();
    }
});

test('closing slot stays busy until transport isolation completes', async () => {
    const h = harness();
    try {
        await h.start();
        await h.incoming();
        h.setHoldClose();
        h.transports[0].raw.receive({ jsonrpc: '2.0', method: 'initialize' });
        await tick();
        await h.incoming(randomUUID());
        assert.equal(h.sockets[0].sent.at(-1).payload.code, 'remote_pc_busy');
        assert.equal(h.transports.length, 1);
        h.transports[0].done.resolve();
        await tick();
        await h.incoming(randomUUID());
        assert.equal(h.transports.length, 2);
        h.transports[1].done.resolve();
    } finally {
        for (const transport of h.transports) transport.done.resolve();
        await h.runtime.close();
    }
});

test('failed isolation cannot be bypassed by restarting the same registration runtime', async () => {
    const h = harness();
    await h.start();
    await h.incoming();
    h.transports[0].close = async () => {
        throw new Error('synthetic isolation failure');
    };
    const closing = h.runtime.close();
    await assert.rejects(closing, /network_cleanup_failed/);
    assert.throws(() => createConnectionRuntime(h.options), /remote_network_runtime_exists/);
    assert.equal(h.sockets.length, 1);
});

test('abort-driven channel close cannot enter connection cleanup twice', async () => {
    const h = harness();
    const create = h.options.bridge.create;
    h.options.bridge.create = async (input) => {
        const transport = await create(input);
        input.signal.addEventListener('abort', () => transport.channel.close());
        return transport;
    };
    await h.start();
    await h.incoming();
    await h.runtime.close();
    assert.equal(h.transports[0].closeCalls, 1);
});

test('signaling limit counts raw whitespace before JSON decoding', async () => {
    const h = harness();
    try {
        await h.start();
        const frame = h.frame('ping', { nonce: randomUUID() });
        delete (frame as Partial<typeof frame>).attempt_id;
        const raw = ' '.repeat(131072) + JSON.stringify(frame);
        for (const receive of h.sockets[0].messages) receive(raw);
        await tick();
        assert.equal(h.sockets[0].ended, true);
    } finally {
        await h.runtime.close();
    }
});

// --- F2：PC 侧 TURN available 分支的门禁覆盖（合同替身，非真实签发器） ---

const AVAILABLE_TURN = fixture.turn.valid[0];

function captureIceServers(h: ReturnType<typeof harness>) {
    const calls: Array<Array<{ urls: string[]; username: string; credential: string }>> = [];
    const create = h.options.bridge.create;
    h.options.bridge.create = async (input: any) => {
        calls.push(input.iceServers);
        return create(input);
    };
    return calls;
}

function captureDiagnostics(h: ReturnType<typeof harness>) {
    const codes: string[] = [];
    h.options.diagnose = (event: { code: string }) => codes.push(event.code);
    return codes;
}

test('available TURN with enough margin reaches bridge.create as non-empty iceServers', async () => {
    const h = harness();
    const iceServers = captureIceServers(h);
    const codes = captureDiagnostics(h);
    try {
        await h.start();
        await h.incoming(undefined, AVAILABLE_TURN);
        assert.equal(h.transports.length, 1, 'transport is created on the available path');
        assert.deepEqual(iceServers, [
            [
                {
                    urls: AVAILABLE_TURN.urls,
                    username: AVAILABLE_TURN.username,
                    credential: AVAILABLE_TURN.credential
                }
            ]
        ]);
        assert.ok(
            !codes.some((code) => code.startsWith('turn_')),
            'the available path emits no TURN degradation diagnostic'
        );
    } finally {
        await h.runtime.close();
    }
});

test('insufficient TURN lifetime falls back to direct connection with an attributable diagnostic', async () => {
    const h = harness();
    const iceServers = captureIceServers(h);
    const codes = captureDiagnostics(h);
    try {
        await h.start();
        // 余量 30 秒 < 本次剩余建连预算 60 秒。
        await h.incoming(undefined, { ...AVAILABLE_TURN, valid_for_ms: 30000 });
        assert.deepEqual(iceServers, [[]], 'no ICE server configuration is handed to the bridge');
        assert.ok(codes.includes('turn_insufficient_lifetime'));
        assert.equal(h.transports.length, 1, 'direct connection still proceeds');
        assert.ok(h.sockets[0].sent.some((f: any) => f.type === 'accept'));
    } finally {
        await h.runtime.close();
    }
});

test('TURN already expired on arrival falls back to direct connection', async () => {
    const h = harness();
    const iceServers = captureIceServers(h);
    const codes = captureDiagnostics(h);
    try {
        // 墙钟已越过 expires_at；wallTime 为惰性读取，构造后赋值即可生效。
        h.options.wallTime = () => (AVAILABLE_TURN.expires_at + 1) * 1000;
        await h.start();
        await h.incoming(undefined, AVAILABLE_TURN);
        assert.deepEqual(iceServers, [[]]);
        assert.ok(codes.includes('turn_expired'));
        assert.equal(h.transports.length, 1, 'direct connection still proceeds');
    } finally {
        await h.runtime.close();
    }
});

test('credentials expiring after creation neither close nor reissue the peer connection', async () => {
    const h = harness();
    const iceServers = captureIceServers(h);
    try {
        await h.start();
        await h.incoming(undefined, AVAILABLE_TURN);
        assert.equal(iceServers[0].length, 1, 'created with the available configuration');
        // 先完成握手到 active：此后本次建连预算不再关闭通道，才谈得上越过凭据到期。
        await h.ticket();
        await h.readback();
        await h.activate();
        h.transports[0].raw.receive(h.control('ready_ack'));
        await tick();
        const transport: any = h.transports[0];
        // 越过该份凭据的 valid_for_ms（1 小时）后，通道必须仍然存活。
        await h.advance(AVAILABLE_TURN.valid_for_ms + 60000);
        assert.equal(h.transports.length, 1, 'no second PeerConnection is created');
        assert.equal(transport.closeCalls, 0, 'an expiring credential never closes a live transport');
        assert.equal(
            typeof (transport as Record<string, unknown>).setConfiguration,
            'undefined',
            'the runtime never reaches for a reconfiguration hook'
        );
    } finally {
        await h.runtime.close();
    }
});

test('TURN diagnostics never carry the credential material', async () => {
    const h = harness();
    const events: Array<{ code: string }> = [];
    h.options.diagnose = (event: { code: string }) => events.push(event);
    try {
        await h.start();
        await h.incoming(undefined, { ...AVAILABLE_TURN, valid_for_ms: 30000 });
        const blob = JSON.stringify(events);
        assert.ok(!blob.includes(AVAILABLE_TURN.username), 'no username in diagnostics');
        assert.ok(!blob.includes(AVAILABLE_TURN.credential), 'no credential in diagnostics');
        assert.ok(!blob.includes('turn:'), 'no TURN URL in diagnostics');
        assert.ok(
            events.every((event) =>
                Object.keys(event).every((key) => key === 'code' || key === 'count' || key === 'detail')
            ),
            'diagnostics carry only code/count/detail'
        );
        // detail 只允许有限的来源标签：短、纯文本、不含地址/凭据/原始异常。
        for (const event of events as Array<{ detail?: unknown }>) {
            if (event.detail === undefined) continue;
            assert.equal(typeof event.detail, 'string');
            const detail = event.detail as string;
            assert.ok(detail.length <= 64, `detail stays bounded: ${detail}`);
            assert.ok(!/\/\/|@|\d+\.\d+\.\d+\.\d+/.test(detail), `detail carries no address-like material: ${detail}`);
        }
    } finally {
        await h.runtime.close();
    }
});

// --- F5：交付给 openConnection 的可信上下文必须带资格代次与已核验的双方绑定 ---

test('the trusted context carries the accepted generation and the verified peer fingerprints', async () => {
    const h = harness();
    try {
        await h.start();
        await h.incoming();
        const accept = h.sockets[0].sent.find((f: any) => f.type === 'accept');
        assert.ok(accept, 'the runtime reported its eligibility generation on accept');
        await h.ticket();
        await h.readback();
        await h.activate();
        assert.equal(h.gateChannels.length, 1, 'openConnection ran once');
        const context = h.trustedContexts[0];
        assert.equal(context.generation, accept.payload.eligibility_generation);
        // 服务器冻结值来自 ticket 帧；本次 fixture 的两端使用同一 SDP，因此摘要相同。
        const frozen = fixture.sdp.valid[0]
            .match(/a=fingerprint:sha-256 ([^\r\n]+)/i)[1]
            .replace(/:/g, '')
            .toLowerCase();
        assert.equal(context.fingerprints.pc, frozen);
        assert.equal(context.fingerprints.mobile, frozen);
        assert.equal(context.fingerprints.pc.length, 64, 'canonical 32-byte lowercase hex');
        assert.match(context.fingerprints.pc, /^[0-9a-f]{64}$/);
        // 原有四项保持不变。
        assert.equal(context.userId, '1');
        assert.equal(context.deviceId, 'pc');
        assert.equal(context.attemptId, h.attemptId);
    } finally {
        await h.runtime.close();
    }
});

// ---------------------------------------------------------------------------
// G1：本地可信激活通知（数据通道接入时补齐的接口，信令核验权威不变）
// ---------------------------------------------------------------------------

test('G1 在合法 ready_ack 处恰好通知一次，且在 gate 打开之前', async () => {
    const h = harness();
    try {
        await h.start();
        await h.incoming();
        await h.ticket();
        await h.readback();
        await h.activate();
        const transport = h.transports[0];
        assert.equal(transport.activations.length, 0, 'ready_ack 之前不得激活');
        assert.equal(h.gateChannels.length, 1);

        transport.raw.receive(h.control('ready_ack'));
        await tick();
        assert.equal(transport.activations.length, 1, '恰好通知一次');
        assert.equal(transport.activations[0].closed, false, '通知时通道必须仍然存活');
        assert.equal(transport.activations[0].businessDelivered, 0, '通知时上层不得已收到业务消息');

        // 激活之后 ACP 才被接纳。
        transport.raw.receive({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
        await tick();
        assert.ok(h.received.length >= 1, 'ready_ack 之后业务消息才进入上层');
    } finally {
        await h.runtime.close();
    }
});

test('握手未走完不通知：present_ticket / confirm 阶段都不激活', async () => {
    const h = harness();
    try {
        await h.start();
        await h.incoming();
        await h.ticket();
        await h.readback();
        h.transports[0].raw.receive(h.control('present_ticket', { secret: fixture.ticket.secret }));
        await tick();
        assert.equal(h.transports[0].activations.length, 0);
        h.transports[0].raw.receive(h.control('confirm'));
        await tick();
        assert.equal(h.transports[0].activations.length, 0);
    } finally {
        await h.runtime.close();
    }
});

test('重复 ready_ack 不重复通知，也不重置基点', async () => {
    const h = harness();
    try {
        await h.start();
        await h.incoming();
        await h.ticket();
        await h.readback();
        await h.activate();
        h.transports[0].raw.receive(h.control('ready_ack'));
        await tick();
        assert.equal(h.transports[0].activations.length, 1);
        // 第二条 ready_ack 此时阶段已是 active，按既有信令规则被拒，不会再次通知。
        h.transports[0].raw.receive(h.control('ready_ack'));
        await tick();
        assert.equal(h.transports[0].activations.length, 1, '不得重复通知');
    } finally {
        await h.runtime.close();
    }
});

test('通知抛错时不打开 gate、不交付业务，沿 activation_failed 关闭', async () => {
    const h = harness();
    try {
        await h.start();
        await h.incoming();
        await h.ticket();
        await h.readback();
        await h.activate();
        const transport = h.transports[0];
        transport.activateTrusted = () => {
            throw new Error('native activation refused');
        };
        const before = h.received.length;
        transport.raw.receive(h.control('ready_ack'));
        await tick();
        await tick();
        transport.raw.receive({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
        await tick();
        assert.equal(h.received.length, before, '通知失败后不得交付任何业务消息');
        assert.ok(transport.closeCalls >= 1, '应当沿关闭出口收敛');
    } finally {
        await h.runtime.close();
    }
});

test('缺少 activateTrusted 是接线失败，不以可选调用放行', async () => {
    const h = harness();
    try {
        await h.start();
        await h.incoming();
        await h.ticket();
        await h.readback();
        await h.activate();
        const transport = h.transports[0];
        delete (transport as any).activateTrusted;
        const before = h.received.length;
        transport.raw.receive(h.control('ready_ack'));
        await tick();
        await tick();
        transport.raw.receive({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
        await tick();
        assert.equal(h.received.length, before, '缺方法不得放行业务');
        assert.ok(transport.closeCalls >= 1);
    } finally {
        await h.runtime.close();
    }
});
