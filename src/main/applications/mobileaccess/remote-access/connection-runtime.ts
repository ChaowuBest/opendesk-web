/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import { WebSocket } from 'ws';
import type { AcpMessageChannel } from '../acp/mobile/transport/acp-message-stream.js';
import type { HostedAcpConnection } from '../acp/mobile/acp-endpoint/connection-host.js';
import type { RegistrationRuntime, RegistrationCredential, RegistrationQualification } from './registration-runtime.js';
import {
    parseDataDescription,
    parseNetworkFrame,
    captureTurn,
    selectTurn,
    remoteNetworkWsUrl,
    equalTicket,
    equalFingerprint,
    fingerprintBytes,
    utf8Bytes,
    NETWORK_LIMITS,
    type NetworkFrame
} from './network-protocol.js';

export interface SignalingSocket extends AcpMessageChannel {
    readonly opened: Promise<void>;
}

/** Signaling only: no ACP framing, replay buffer, credential headers or compression. */
export function createSignalingSocket(url: string): SignalingSocket {
    const socket = new WebSocket(url, {
        perMessageDeflate: false,
        maxPayload: NETWORK_LIMITS.frame_bytes,
        handshakeTimeout: NETWORK_LIMITS.auth_ms,
        followRedirects: false
    });
    const messages = new Set<(raw: string) => void>();
    const closes = new Set<() => void>();
    const sends = new Set<(error: Error) => void>();
    let ended = false;
    let resolveOpened!: () => void;
    let rejectOpened!: (error: Error) => void;
    const opened = new Promise<void>((resolve, reject) => {
        resolveOpened = resolve;
        rejectOpened = reject;
    });
    const close = () => {
        if (ended) return;
        ended = true;
        const error = new Error('signaling_lost');
        rejectOpened(error);
        for (const reject of sends) reject(error);
        sends.clear();
        messages.clear();
        const listeners = [...closes];
        closes.clear();
        // terminate also aborts an in-progress HTTP upgrade and bounds native buffering.
        socket.terminate();
        for (const listener of listeners) listener();
    };
    socket.once('open', () => {
        if (!ended) resolveOpened();
    });
    socket.on('error', close);
    socket.once('close', close);
    socket.on('message', (data, binary) => {
        if (ended) return;
        if (binary || messages.size === 0) {
            close();
            return;
        }
        const raw = data.toString('utf8');
        for (const listener of messages) listener(raw);
    });
    return {
        opened,
        send: (raw) => {
            if (
                ended ||
                socket.readyState !== WebSocket.OPEN ||
                utf8Bytes(raw) > NETWORK_LIMITS.frame_bytes ||
                socket.bufferedAmount + utf8Bytes(raw) > NETWORK_LIMITS.queue_bytes
            ) {
                close();
                return Promise.reject(new Error('signaling_lost'));
            }
            return new Promise<void>((resolve, reject) => {
                sends.add(reject);
                socket.send(raw, (error) => {
                    sends.delete(reject);
                    if (error || ended) {
                        reject(new Error('signaling_lost'));
                        close();
                    } else resolve();
                });
            });
        },
        onMessage: (listener) => {
            if (!ended) messages.add(listener);
            return () => {
                messages.delete(listener);
            };
        },
        onClose: (listener) => {
            if (ended) listener();
            else closes.add(listener);
            return () => {
                closes.delete(listener);
            };
        },
        close
    };
}

/** The data channel must supply readback from the same stable PeerConnection and its actual channel. */
export interface NetworkHostOwner {
    hostInstanceId: string;
    generation: number;
}

export interface DesktopNetworkTransport {
    readonly instance: object;
    readonly owner: NetworkHostOwner;
    readonly channel: AcpMessageChannel;
    readonly opened: Promise<void>;
    readonly closed: Promise<void>;
    answer(sdp: string): Promise<string>;
    addCandidate(payload: Record<string, unknown> | null): Promise<void>;
    readback(): Promise<{
        instance: object;
        owner: NetworkHostOwner;
        channel: AcpMessageChannel;
        state: 'open' | 'connecting' | 'closed';
        stable: boolean;
        localDescription: string | null;
        remoteDescription: string | null;
    }>;
    /**
     * G1：本地可信激活通知。信令完成全部核验后调用，数据通道才开启业务封装与探测。
     * 绑定本实例，无账号/Ticket 参数，只由当前合法尝试调用；不新增服务器请求、
     * 网络握手或身份判定。同实例重复调用不重置存活基点，已关闭/取消后调用抛错。
     */
    activateTrusted(): void;
    close(): Promise<void>;
}

export interface ConnectionRuntimeOptions {
    signal: AbortSignal;
    registration: RegistrationRuntime;
    createSocket?(url: string): SignalingSocket;
    bridge: {
        /** The supplied data channel implementation must use fingerprint-verifying SCTP-over-DTLS. */
        owner: NetworkHostOwner;
        create(input: {
            attemptId: string;
            signal: AbortSignal;
            iceServers: Array<{ urls: string[]; username: string; credential: string }>;
            candidate(payload: Record<string, unknown> | null): void;
        }): Promise<DesktopNetworkTransport>;
    };
    openConnection(
        channel: AcpMessageChannel,
        context: {
            userId: string;
            deviceId: string;
            runId: string;
            attemptId: string;
            /** 本次受理上报的资格代次，与 accept 帧的 eligibility_generation 一致。 */
            generation: number;
            /** 已核验完成的双方绑定：服务器冻结值的规范小写十六进制摘要。 */
            fingerprints: { pc: string; mobile: string };
        }
    ): HostedAcpConnection;
    allowLoopback?: boolean;
    now?: () => number;
    wallTime?: () => number;
    setTimeout?: (callback: () => void, delay: number) => unknown;
    clearTimeout?: (timer: unknown) => void;
    diagnose?: (event: { code: string; detail?: string; count?: number }) => void;
}

type Notification = {
    socket: SignalingSocket;
    credential: RegistrationCredential;
    epoch?: string;
    id?: string;
    alive: boolean;
    removes: Array<() => void>;
    outbound: Promise<void>;
    queueCount: number;
    queueBytes: number;
    authTimer?: unknown;
    heartbeatTimer?: unknown;
    heartbeat?: {
        receivedAt: number;
        sentAt: number;
        idleMs: number;
        silenceMs: number;
    };
};
type Slot = {
    id: string;
    userId: string;
    notification: Notification;
    qualification: RegistrationQualification;
    deadline: number;
    state: 'pending' | 'negotiating' | 'verifying' | 'active' | 'closing';
    stage: 'present_ticket' | 'confirm' | 'permit' | 'ready_ack' | 'active';
    lifetime: AbortController;
    creating?: Promise<DesktopNetworkTransport>;
    transport?: DesktopNetworkTransport;
    hosted?: HostedAcpConnection;
    secret?: string;
    ticketDeadline?: number;
    answerAt?: number;
    local?: Uint8Array;
    remote?: Uint8Array;
    mid?: string;
    ufrag?: string | null;
    candidateCount: number;
    candidateBytes: number;
    candidatesComplete: boolean;
    localCandidates: Array<Record<string, unknown> | null>;
    localCandidateCount: number;
    localCandidateBytes: number;
    localComplete: boolean;
    answerSent: boolean;
    ticket?: { pc: Uint8Array; mobile: Uint8Array };
    verified: boolean;
    validating: boolean;
    gate: boolean;
    control: string[];
    controlBytes: number;
    chain: Promise<void>;
    queueCount: number;
    queueBytes: number;
    removes: Array<() => void>;
    messages: Set<(message: string) => void>;
    closes: Set<() => void>;
    timer?: unknown;
    ticketTimer?: unknown;
    cleanupTimer?: unknown;
    closing?: Promise<void>;
};

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

const runtimes = new WeakSet<RegistrationRuntime>();

export function composeRegistrationConnection(options: ConnectionRuntimeOptions): { close(): Promise<void> } {
    const connection = createConnectionRuntime(options);
    let closing: Promise<void> | undefined;
    const close = () => {
        if (closing) return closing;
        options.signal.removeEventListener('abort', onAbort);
        // Calling connection.close first synchronously seals its business gate.
        const connectionClosing = connection.close();
        const registrationClosing = Promise.resolve().then(() => options.registration.close());
        closing = Promise.allSettled([connectionClosing, registrationClosing]).then((results) => {
            const failed = results.find((result) => result.status === 'rejected');
            if (failed?.status === 'rejected') throw failed.reason;
        });
        return closing;
    };
    const onAbort = () => {
        void close().catch(() => {
            options.diagnose?.({ code: 'network_cleanup_failed' });
        });
    };
    options.signal.addEventListener('abort', onAbort, { once: true });
    if (options.signal.aborted) onAbort();
    return { close };
}

/** One registration owns one notification socket and one local pending/active/closing slot. */
export function createConnectionRuntime(options: ConnectionRuntimeOptions): { close(): Promise<void> } {
    if (runtimes.has(options.registration)) throw new Error('remote_network_runtime_exists');
    runtimes.add(options.registration);
    const now = options.now ?? (() => performance.now());
    const schedule = options.setTimeout ?? setTimeout;
    const clear = options.clearTimeout ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    // detail 只带有限的来源标签：同一个 code 可能来自好几条路径，没有它诊断无法定位。
    const report = (code: string, detail?: string) => {
        try {
            options.diagnose?.({ code, detail });
        } catch {}
    };
    let stopped = false;
    let notification: Notification | undefined;
    let slot: Slot | undefined;
    let reconnectTimer: unknown;
    let closePromise: Promise<void> | undefined;

    const qualified = (target?: Slot): boolean => {
        const q = options.registration.getQualification();
        return (
            !stopped &&
            q.role === 'current' &&
            q.expiresAt !== null &&
            q.expiresAt > now() &&
            (!target ||
                (q.accountScope === target.qualification.accountScope &&
                    q.runId === target.qualification.runId &&
                    q.deviceId === target.qualification.deviceId &&
                    q.generation === target.qualification.generation))
        );
    };
    const live = (target: Slot): boolean =>
        slot === target &&
        target.state !== 'closing' &&
        qualified(target) &&
        (target.state === 'active' || now() < target.deadline);
    const watchHeartbeat = (connection: Notification) => {
        clear(connection.heartbeatTimer);
        const heartbeat = connection.heartbeat;
        if (!heartbeat || !connection.alive || notification !== connection) return;
        // The server pings after inbound inactivity, so our outbound negotiation can delay it.
        // Local send success is not peer proof: it earns at most one attempt budget without inbound frames.
        const deadline = Math.min(
            Math.max(heartbeat.receivedAt, heartbeat.sentAt) + heartbeat.idleMs,
            heartbeat.receivedAt + heartbeat.silenceMs
        );
        connection.heartbeatTimer = schedule(
            () => {
                if (!connection.alive || notification !== connection || connection.heartbeat !== heartbeat) return;
                if (now() < deadline) {
                    watchHeartbeat(connection);
                    return;
                }
                report('signaling_lost', 'authenticated signaling heartbeat timed out');
                disconnectNotification(connection, 'heartbeat timed out');
            },
            Math.max(0, deadline - now())
        );
    };
    const recordHeartbeatActivity = (connection: Notification, inbound: boolean) => {
        if (!connection.heartbeat || !connection.alive || notification !== connection) return;
        connection.heartbeat = {
            ...connection.heartbeat,
            ...(inbound ? { receivedAt: now() } : { sentAt: now() })
        };
        watchHeartbeat(connection);
    };
    const send = (
        connection: Notification,
        type: string,
        payload: Record<string, unknown>,
        target?: Slot,
        initial = false
    ): Promise<void> => {
        const frame = {
            version: 1,
            type,
            payload,
            ...(!initial ? { server_epoch: connection.epoch, socket_id: connection.id } : {}),
            ...(target ? { attempt_id: target.id } : {})
        };
        const raw = JSON.stringify(frame);
        if (
            !connection.alive ||
            connection.queueCount >= NETWORK_LIMITS.queue_count ||
            connection.queueBytes + utf8Bytes(raw) > NETWORK_LIMITS.queue_bytes
        ) {
            disconnectNotification(connection, 'outbound budget exhausted');
            return Promise.reject(new Error('signaling_lost'));
        }
        connection.queueCount++;
        connection.queueBytes += utf8Bytes(raw);
        const operation = connection.outbound.then(async () => {
            if (!connection.alive) throw new Error('signaling_lost');
            if (target && type !== 'reject' && type !== 'connection_closed' && !live(target)) return;
            let timer: unknown;
            try {
                await Promise.race([
                    connection.socket.send(raw),
                    new Promise<never>((_resolve, reject) => {
                        timer = schedule(() => reject(new Error('signaling_lost')), NETWORK_LIMITS.send_ms);
                    })
                ]);
                if (!initial) recordHeartbeatActivity(connection, false);
            } finally {
                clear(timer);
            }
        });
        connection.outbound = operation.catch(() => {
            disconnectNotification(connection, 'outbound send failed');
        });
        void operation.then(
            () => {
                connection.queueCount--;
                connection.queueBytes -= utf8Bytes(raw);
            },
            () => {
                connection.queueCount--;
                connection.queueBytes -= utf8Bytes(raw);
            }
        );
        return operation;
    };
    const closeSlot = (target: Slot, code: string): Promise<void> => {
        if (target.closing) return target.closing;
        target.state = 'closing';
        target.gate = false;
        target.secret = undefined;
        target.ticket = undefined;
        target.control.length = 0;
        target.controlBytes = 0;
        clear(target.timer);
        clear(target.ticketTimer);
        target.closing = Promise.resolve().then(() => {
            const hostedClosing = Promise.resolve().then(() => target.hosted?.close());
            const networkClosing = (async () => {
                const transport = target.transport ?? (await target.creating?.catch(() => undefined));
                if (transport) {
                    await transport.close();
                    await transport.closed;
                }
            })();
            return Promise.allSettled([hostedClosing, networkClosing]).then((results) => {
                clear(target.cleanupTimer);
                if (results.some((result) => result.status === 'rejected')) {
                    report('connection_cleanup_failed');
                    // Failed isolation never makes the local slot available again.
                    return;
                }
                target.transport = undefined;
                target.creating = undefined;
                target.hosted = undefined;
                if (slot === target) slot = undefined;
            });
        });
        target.lifetime.abort();
        for (const remove of target.removes.splice(0)) {
            try {
                remove();
            } catch {
                report('listener_cleanup_failed');
            }
        }
        for (const listener of target.closes) {
            try {
                listener();
            } catch {
                report('close_listener_failed');
            }
        }
        target.messages.clear();
        target.closes.clear();
        if (target.notification.alive && target.notification.id)
            void send(target.notification, 'connection_closed', { code }, target).catch(() => undefined);
        target.cleanupTimer = schedule(() => report('connection_cleanup_pending'), NETWORK_LIMITS.cleanup_ms);
        return target.closing;
    };
    const fail = (target: Slot, code: string, detail?: string) => {
        report(code, detail);
        void closeSlot(target, code);
    };
    const reconnect = () => {
        if (stopped || reconnectTimer !== undefined || !qualified()) return;
        reconnectTimer = schedule(() => {
            reconnectTimer = undefined;
            startNotification();
        }, NETWORK_LIMITS.reconnect_ms);
    };
    /** reason 是有限来源标签：一条信令 socket 被收回的原因在诊断里必须能分辨。 */
    function disconnectNotification(connection: Notification, reason = 'unspecified') {
        if (!connection.alive) return;
        connection.alive = false;
        clear(connection.authTimer);
        clear(connection.heartbeatTimer);
        connection.heartbeat = undefined;
        for (const remove of connection.removes.splice(0)) {
            try {
                remove();
            } catch {}
        }
        try {
            connection.socket.close();
        } catch {
            report('signaling_close_failed');
        }
        if (notification === connection) notification = undefined;
        if (slot?.notification === connection && slot.state !== 'active')
            fail(slot, 'signaling_lost', `signaling socket dropped: ${reason}`);
        reconnect();
    }
    const queue = (target: Slot, raw: string, operation: () => Promise<void>) => {
        const size = utf8Bytes(raw);
        if (
            ++target.queueCount > NETWORK_LIMITS.queue_count ||
            (target.queueBytes += size) > NETWORK_LIMITS.queue_bytes
        ) {
            fail(target, 'resource_limit');
            return;
        }
        target.chain = target.chain
            .then(async () => {
                if (live(target)) await operation();
            })
            .catch(() => fail(target, 'activation_failed'))
            .finally(() => {
                target.queueCount--;
                target.queueBytes -= size;
            });
    };
    const sendControl = async (target: Slot, type: string) => {
        if (!live(target) || !target.transport) throw new Error('attempt_not_available');
        await target.transport.channel.send(JSON.stringify({ version: 1, type, attempt_id: target.id, payload: {} }));
        if (!live(target)) throw new Error('attempt_not_available');
    };
    const drainControl = (target: Slot) => {
        if (!target.verified || !target.secret || !live(target)) return;
        for (const raw of target.control.splice(0)) queue(target, raw, () => processControl(target, raw));
        target.controlBytes = 0;
    };
    const verify = (target: Slot) => {
        if (!target.ticket || !target.transport || target.validating || target.verified || !live(target)) return;
        target.validating = true;
        const transport = target.transport;
        void (async () => {
            await transport.opened;
            const read = await transport.readback();
            if (!live(target) || target.transport !== transport) return;
            const owner = options.bridge.owner;
            if (
                read.instance !== transport.instance ||
                read.channel !== transport.channel ||
                read.owner.hostInstanceId !== owner.hostInstanceId ||
                read.owner.generation !== owner.generation ||
                transport.owner.hostInstanceId !== owner.hostInstanceId ||
                transport.owner.generation !== owner.generation ||
                !read.stable ||
                read.state !== 'open' ||
                !read.localDescription ||
                !read.remoteDescription
            )
                throw new Error('binding');
            const local = parseDataDescription(read.localDescription),
                remote = parseDataDescription(read.remoteDescription);
            if (
                !target.ticket ||
                !equalFingerprint(local.digest, target.ticket.pc) ||
                !equalFingerprint(remote.digest, target.ticket.mobile)
            )
                throw new Error('binding');
            target.verified = true;
            drainControl(target);
        })().catch(() => {
            if (live(target)) fail(target, 'peer_binding_failed');
        });
    };
    async function processControl(target: Slot, raw: string) {
        const frame = JSON.parse(raw);
        if (
            Object.keys(frame).sort().join(',') !== 'attempt_id,payload,type,version' ||
            frame.version !== 1 ||
            frame.attempt_id !== target.id ||
            !frame.payload ||
            typeof frame.payload !== 'object' ||
            Array.isArray(frame.payload) ||
            frame.type !== target.stage
        )
            throw new Error('control');
        if (frame.type === 'present_ticket') {
            if (
                Object.keys(frame.payload).join(',') !== 'secret' ||
                !target.secret ||
                now() >= (target.ticketDeadline ?? 0) ||
                !equalTicket(frame.payload.secret, target.secret)
            )
                throw new Error('ticket');
            // Comparison and consumption form one synchronous state transition.
            target.secret = undefined;
            target.stage = 'confirm';
            target.state = 'verifying';
            clear(target.ticketTimer);
            await sendControl(target, 'ticket_accepted');
        } else {
            if (Object.keys(frame.payload).length !== 0) throw new Error('control');
            if (frame.type === 'confirm') {
                target.stage = 'permit';
                await send(target.notification, 'activate_request', {}, target);
            } else if (frame.type === 'ready_ack') {
                // G1：核验已在本同步段完成，先通知同一 transport 实例开启数据通道调度，
                // 成功后才发布 active/gate。通知抛错沿 queue 的 activation_failed 出口关闭，
                // 不打开 gate、不交付半成品通道。方法缺失是接线失败，不做可选调用。
                const active = target.transport;
                if (!active || typeof active.activateTrusted !== 'function') throw new Error('activation_failed');
                active.activateTrusted();
                target.stage = 'active';
                target.state = 'active';
                target.gate = true;
                clear(target.timer);
            } else throw new Error('control');
        }
    }
    const onTransportMessage = (target: Slot, raw: string) => {
        if (!live(target)) return;
        let parsed: Record<string, unknown>;
        try {
            parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('frame');
        } catch {
            fail(target, 'invalid_message', `transport frame not json in ${target.state}`);
            return;
        }
        if (parsed.jsonrpc === '2.0') {
            if (target.gate) {
                for (const listener of target.messages) listener(raw);
                return;
            }
            // Queueing behind ready_ack preserves the ordered channel's handshake/ACP boundary.
            queue(target, raw, async () => {
                if (!target.gate) {
                    fail(target, 'invalid_message', `acp before gate in ${target.state}`);
                    return;
                }
                for (const listener of target.messages) listener(raw);
            });
            return;
        }
        if (utf8Bytes(raw) > NETWORK_LIMITS.control_bytes || target.state === 'active') {
            fail(
                target,
                'invalid_message',
                target.state === 'active' ? 'control after activation' : `control too large in ${target.state}`
            );
            return;
        }
        if (!target.verified || !target.ticket) {
            if (
                target.control.length >= NETWORK_LIMITS.control_queue_count ||
                target.controlBytes + utf8Bytes(raw) > NETWORK_LIMITS.control_queue_bytes
            ) {
                fail(target, 'resource_limit', 'pre-trust control queue full');
                return;
            }
            target.control.push(raw);
            target.controlBytes += utf8Bytes(raw);
        } else queue(target, raw, () => processControl(target, raw));
    };
    const acceptIncoming = (connection: Notification, frame: NetworkFrame) => {
        if (slot) {
            void send(connection, 'reject', { code: 'remote_pc_busy' }, { id: frame.attempt_id! } as Slot).catch(
                () => undefined
            );
            return;
        }
        const q = options.registration.getQualification(),
            payload = frame.payload;
        if (
            !qualified() ||
            payload.device_id !== q.deviceId ||
            payload.run_id !== q.runId ||
            connection.credential.accountScope !== q.accountScope
        ) {
            void send(connection, 'reject', { code: 'eligibility_lost' }, { id: frame.attempt_id! } as Slot).catch(
                () => undefined
            );
            return;
        }
        const captured = captureTurn(payload.turn, now(), options.wallTime?.() ?? Date.now());
        const target: Slot = {
            id: frame.attempt_id!,
            userId: String(payload.user_id),
            notification: connection,
            qualification: q,
            deadline: now() + Number(payload.remaining_ms),
            state: 'pending',
            stage: 'present_ticket',
            lifetime: new AbortController(),
            verified: false,
            validating: false,
            gate: false,
            control: [],
            controlBytes: 0,
            chain: Promise.resolve(),
            queueCount: 0,
            queueBytes: 0,
            removes: [],
            messages: new Set(),
            closes: new Set(),
            candidateCount: 0,
            candidateBytes: 0,
            candidatesComplete: false,
            localCandidates: [],
            localCandidateCount: 0,
            localCandidateBytes: 0,
            localComplete: false,
            answerSent: false
        };
        slot = target;
        target.timer = schedule(() => fail(target, 'attempt_expired'), Math.max(0, target.deadline - now()));
        queue(target, '', async () => {
            await send(connection, 'accept', { eligibility_generation: q.generation }, target);
            if (!live(target)) return;
            const turn = selectTurn(captured, now(), target.deadline - now());
            if (turn.reason) report(`turn_${turn.reason}`);
            // Establish cleanup ownership before bridge callbacks can synchronously cancel.
            target.creating = Promise.resolve().then(() =>
                options.bridge.create({
                    attemptId: target.id,
                    signal: target.lifetime.signal,
                    iceServers: turn.iceServers,
                    candidate: (payload) => {
                        if (!live(target)) return;
                        const size = payload ? utf8Bytes(JSON.stringify(payload)) : 0;
                        if (
                            target.localComplete ||
                            (payload &&
                                (++target.localCandidateCount > NETWORK_LIMITS.candidate_count ||
                                    (target.localCandidateBytes += size) > NETWORK_LIMITS.candidate_queue_bytes))
                        ) {
                            fail(target, 'resource_limit');
                            return;
                        }
                        if (!payload) target.localComplete = true;
                        if (!target.answerSent) target.localCandidates.push(payload);
                        else
                            void send(
                                connection,
                                payload ? 'candidate' : 'candidates_complete',
                                payload ?? {},
                                target
                            ).catch(() => fail(target, 'signaling_lost', 'candidate send rejected'));
                    }
                })
            );
            const transport = await target.creating;
            target.transport = transport;
            if (!live(target)) return;
            target.state = 'negotiating';
            target.removes.push(
                transport.channel.onMessage((raw) => onTransportMessage(target, raw)),
                transport.channel.onClose(() => fail(target, 'signaling_lost', 'data channel closed'))
            );
            void transport.closed.then(
                () => {
                    if (live(target)) fail(target, 'signaling_lost', 'data channel transport closed');
                },
                () => {
                    if (live(target)) fail(target, 'activation_failed');
                }
            );
        });
    };
    const receive = (connection: Notification, raw: string) => {
        if (!connection.alive || notification !== connection) return;
        if (utf8Bytes(raw) > (connection.id ? NETWORK_LIMITS.frame_bytes : NETWORK_LIMITS.auth_bytes)) {
            report('resource_limit');
            disconnectNotification(connection, 'inbound frame too large');
            return;
        }
        let frame: NetworkFrame;
        try {
            frame = parseNetworkFrame(JSON.parse(raw), !connection.id);
        } catch {
            disconnectNotification(connection, 'inbound frame rejected');
            return;
        }
        if (!connection.id) {
            if (frame.type === 'auth_ok') {
                clear(connection.authTimer);
                connection.epoch = String(frame.payload.server_epoch);
                connection.id = String(frame.payload.socket_id);
                const limits = frame.payload.limits as Record<string, number>;
                const idleMs = limits.ping_idle_ms + limits.pong_ms + limits.send_ms + limits.scan_ms;
                connection.heartbeat = {
                    receivedAt: now(),
                    sentAt: now(),
                    idleMs,
                    silenceMs: limits.attempt_ms + idleMs
                };
                watchHeartbeat(connection);
            } else if (frame.type === 'auth_failed') {
                if (frame.payload.credential_version === connection.credential.version)
                    options.registration.reportCredentialFailure(connection.credential);
                disconnectNotification(connection, 'auth failed');
            } else disconnectNotification(connection, 'unexpected pre-auth frame');
            return;
        }
        if (frame.server_epoch !== connection.epoch || frame.socket_id !== connection.id) return;
        recordHeartbeatActivity(connection, true);
        if (frame.type === 'ping') {
            void send(connection, 'pong', frame.payload).catch(() => undefined);
            return;
        }
        if (frame.type === 'auth_failed') {
            if (frame.payload.credential_version === connection.credential.version)
                options.registration.reportCredentialFailure(connection.credential);
            return;
        }
        if (frame.type === 'auth_updated') return;
        if (frame.type === 'incoming_connection') {
            acceptIncoming(connection, frame);
            return;
        }
        const target = slot;
        if (!target || target.notification !== connection || frame.attempt_id !== target.id || !live(target)) return;
        // Once ACP is active, only local qualification or the actual channel can revoke it.
        if (target.state === 'active') return;
        if (['attempt_failed', 'cancel', 'connection_closed'].includes(frame.type)) {
            // 这一条是协调方判定的结果，不是本端自己的判断；两者在诊断里必须分得开。
            fail(target, String(frame.payload.code), `ended by coordinator via ${frame.type}`);
            return;
        }
        queue(target, raw, async () => {
            const transport = target.transport;
            if (!transport) throw new Error('missing_transport');
            if (frame.type === 'offer') {
                if (target.remote) throw new Error('duplicate_offer');
                const remote = parseDataDescription(String(frame.payload.sdp));
                target.remote = remote.digest;
                target.mid = remote.mid;
                target.ufrag = remote.ufrag;
                const answer = await transport.answer(String(frame.payload.sdp));
                if (!live(target)) return;
                target.local = parseDataDescription(answer).digest;
                target.answerAt = now();
                await send(connection, 'answer', { sdp: answer }, target);
                if (!live(target)) return;
                while (target.localCandidates.length && live(target)) {
                    const candidate = target.localCandidates.shift();
                    await send(connection, candidate ? 'candidate' : 'candidates_complete', candidate ?? {}, target);
                }
                target.answerSent = true;
            } else if (frame.type === 'candidate' || frame.type === 'candidates_complete') {
                if (
                    !target.remote ||
                    target.candidatesComplete ||
                    (frame.type === 'candidate' &&
                        (frame.payload.sdpMid !== target.mid ||
                            (frame.payload.usernameFragment !== undefined &&
                                target.ufrag !== null &&
                                frame.payload.usernameFragment !== target.ufrag)))
                )
                    throw new Error('candidate');
                if (frame.type === 'candidates_complete') target.candidatesComplete = true;
                else if (
                    ++target.candidateCount > NETWORK_LIMITS.candidate_count ||
                    (target.candidateBytes += utf8Bytes(String(frame.payload.candidate))) >
                        NETWORK_LIMITS.candidate_queue_bytes
                )
                    throw new Error('candidate_limit');
                await transport.addCandidate(frame.type === 'candidate' ? frame.payload : null);
            } else if (frame.type === 'ticket') {
                if (target.ticket || !target.local || !target.remote || target.answerAt === undefined)
                    throw new Error('ticket');
                const pc = fingerprintBytes(frame.payload.pc_fingerprint),
                    mobile = fingerprintBytes(frame.payload.mobile_fingerprint);
                if (!equalFingerprint(pc, target.local) || !equalFingerprint(mobile, target.remote))
                    throw new Error('binding');
                target.ticket = { pc, mobile };
                target.secret = String(frame.payload.secret);
                target.ticketDeadline = Math.min(target.deadline, target.answerAt + Number(frame.payload.valid_for_ms));
                if (now() >= target.ticketDeadline) throw new Error('ticket_expired');
                target.ticketTimer = schedule(() => fail(target, 'ticket_invalid'), target.ticketDeadline - now());
                verify(target);
            } else if (frame.type === 'activate_ok') {
                if (target.stage !== 'permit' || !target.verified || target.secret) throw new Error('activation');
                const channel: AcpMessageChannel = {
                    send: (message) => {
                        if (!live(target) || !target.gate) {
                            fail(target, 'activation_failed');
                            throw new Error('business_gate_closed');
                        }
                        return transport.channel.send(message);
                    },
                    onMessage: (listener) => {
                        target.messages.add(listener);
                        return () => {
                            target.messages.delete(listener);
                        };
                    },
                    onClose: (listener) => {
                        target.closes.add(listener);
                        return () => {
                            target.closes.delete(listener);
                        };
                    },
                    close: () => {
                        void closeSlot(target, 'cancelled');
                    }
                };
                // 指纹来自已核验的冻结 Ticket，不是提交入参或 renderer 自报。
                const verified = target.ticket!;
                target.hosted = options.openConnection(channel, {
                    userId: target.userId,
                    deviceId: target.qualification.deviceId,
                    runId: target.qualification.runId,
                    attemptId: target.id,
                    generation: target.qualification.generation,
                    fingerprints: { pc: hex(verified.pc), mobile: hex(verified.mobile) }
                });
                if (!live(target)) {
                    await target.hosted.close();
                    return;
                }
                target.stage = 'ready_ack';
                await sendControl(target, 'ready');
            } else throw new Error('unexpected_frame');
        });
    };
    function startNotification() {
        if (stopped || notification || !qualified()) return;
        const credential = options.registration.getCredential(),
            q = options.registration.getQualification();
        if (!credential || credential.accountScope !== q.accountScope) return;
        let socket: SignalingSocket;
        try {
            socket = (options.createSocket ?? createSignalingSocket)(
                remoteNetworkWsUrl(credential.baseUrl, options.allowLoopback)
            );
        } catch {
            report('signaling_start_failed');
            reconnect();
            return;
        }
        const connection: Notification = {
            socket,
            credential,
            alive: true,
            removes: [],
            outbound: Promise.resolve(),
            queueCount: 0,
            queueBytes: 0
        };
        notification = connection;
        connection.authTimer = schedule(
            () => disconnectNotification(connection, 'auth timed out'),
            NETWORK_LIMITS.auth_ms
        );
        connection.removes.push(
            socket.onMessage((raw) => receive(connection, raw)),
            socket.onClose(() => disconnectNotification(connection, 'socket closed by peer'))
        );
        void socket.opened
            .then(async () => {
                if (!connection.alive || !qualified()) return;
                await send(
                    connection,
                    'auth',
                    {
                        role: 'pc',
                        access_token: credential.accessToken,
                        credential_version: credential.version,
                        device_id: q.deviceId,
                        run_id: q.runId
                    },
                    undefined,
                    true
                );
            })
            .catch(() => disconnectNotification(connection, 'auth send failed'));
    }
    const removeQualification = options.registration.subscribeQualification(() => {
        if (slot && !qualified(slot)) fail(slot, 'eligibility_lost');
        if (!qualified()) {
            if (notification) disconnectNotification(notification, 'qualification lost');
            clear(reconnectTimer);
            reconnectTimer = undefined;
        } else startNotification();
    });
    const removeCredential = options.registration.subscribeCredential(() => {
        const credential = options.registration.getCredential();
        const connection = notification;
        if (!credential || (connection && connection.credential.accountScope !== credential.accountScope)) {
            if (connection) disconnectNotification(connection, 'account scope changed');
            if (slot) fail(slot, 'eligibility_lost');
        } else if (connection && credential.version !== connection.credential.version) {
            connection.credential = credential;
            if (connection.id)
                void send(connection, 'auth_update', {
                    access_token: credential.accessToken,
                    credential_version: credential.version
                }).catch(() => undefined);
            else disconnectNotification(connection, 'credential rotated before auth');
        }
        startNotification();
    });
    const close = (): Promise<void> => {
        if (closePromise) return closePromise;
        stopped = true;
        removeQualification();
        removeCredential();
        options.signal.removeEventListener('abort', onAbort);
        clear(reconnectTimer);
        const closing = slot ? closeSlot(slot, 'cancelled') : Promise.resolve();
        if (notification) disconnectNotification(notification, 'runtime closing');
        closePromise = closing.then(() => {
            if (slot) throw new Error('network_cleanup_failed');
            runtimes.delete(options.registration);
        });
        return closePromise;
    };
    const onAbort = () => {
        void close().catch(() => report('network_cleanup_failed'));
    };
    options.signal.addEventListener('abort', onAbort, { once: true });
    if (options.signal.aborted) onAbort();
    else startNotification();
    return { close };
}
