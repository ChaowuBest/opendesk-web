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

import { RTCPeerConnection, debug as weriftDebug } from 'werift';
import type { RTCDataChannel, RTCPeerConnectionConfig } from 'werift';
import type { ConnectionRuntimeOptions, NetworkHostOwner } from './connection-runtime.js';
import { createDataChannel, deriveStunServers, DATA_CHANNEL_LIMITS, utf8Length } from './webrtc-transport.js';
import type { RawDataChannel, RawChannelEntry, DataChannelClock } from './webrtc-transport.js';

// The fixed runtime's raw debug output includes TURN credentials and SDP. Filter its
// shared debug sink rather than changing DEBUG or the frozen vendor input; other namespaces remain available.
const dependencyLog = weriftDebug.log;
weriftDebug.log = function (this: { namespace: string }, ...args: unknown[]): void {
    if (this.namespace.startsWith('werift') || this.namespace.startsWith('packages/rtp/')) return;
    dependencyLog.apply(this, args);
};

export interface NodeNetworkBridgeOptions {
    owner: NetworkHostOwner;
    clock?: Partial<DataChannelClock>;
    diagnose?(event: { code: string; detail?: string }): void;
    /** Tests can configure real peers; production always uses the fixed runtime. */
    createPeer?(configuration: RTCPeerConnectionConfig): RTCPeerConnection;
    receiveLimits?: { bytes: number; frames: number };
}

export function createNodeNetworkBridge(options: NodeNetworkBridgeOptions): ConnectionRuntimeOptions['bridge'] {
    const diagnose = (event: { code: string; detail?: string }) => {
        try {
            options.diagnose?.(event);
        } catch {
            /* Diagnostics never change lifetime or authorization. */
        }
    };
    return {
        get owner() {
            return { ...options.owner };
        },
        async create(input) {
            if (input.signal.aborted) throw new Error('node_transport_cancelled');
            if (
                options.receiveLimits &&
                (!Number.isSafeInteger(options.receiveLimits.bytes) ||
                    options.receiveLimits.bytes < 0 ||
                    !Number.isSafeInteger(options.receiveLimits.frames) ||
                    options.receiveLimits.frames < 0)
            )
                throw new Error('node_receive_limits_invalid');
            const owner = Object.freeze({ ...options.owner });
            const configuration: RTCPeerConnectionConfig = {
                iceServers: [...input.iceServers, ...deriveStunServers(input.iceServers).map((url) => ({ urls: url }))],
                maxMessageSize: DATA_CHANNEL_LIMITS.frame_bytes
            };
            const pc = options.createPeer?.(configuration) ?? new RTCPeerConnection(configuration);
            let dc: RTCDataChannel | undefined;
            let isolated = false;
            let peerClose: Promise<void> | undefined;
            const disposers: Array<() => void> = [];
            const rawListeners = new Set<(entry: RawChannelEntry) => void>();
            const overflowListeners = new Set<() => void>();
            const closedListeners = new Set<() => void>();
            const drainListeners = new Set<() => void>();
            const entries = new Map<number, RawChannelEntry>();
            const pending: number[] = [];
            let inFlight: number | undefined;
            let nextEntry = 1;
            let bytes = 0;
            const byteLimit = Math.min(
                options.receiveLimits?.bytes ?? DATA_CHANNEL_LIMITS.raw_bridge_bytes,
                DATA_CHANNEL_LIMITS.raw_bridge_bytes
            );
            const frameLimit = Math.min(
                options.receiveLimits?.frames ?? DATA_CHANNEL_LIMITS.raw_bridge_frames,
                DATA_CHANNEL_LIMITS.raw_bridge_frames
            );
            let resolveOpened!: () => void;
            let rejectOpened!: (error: Error) => void;
            const opened = new Promise<void>((resolve, reject) => {
                resolveOpened = resolve;
                rejectOpened = reject;
            });
            void opened.catch(() => undefined);
            const alive = () =>
                !isolated &&
                !input.signal.aborted &&
                owner.hostInstanceId === options.owner.hostInstanceId &&
                owner.generation === options.owner.generation;
            const check = () => {
                if (!alive()) throw new Error('node_transport_closed');
            };
            const closePeer = (): Promise<void> => {
                if (peerClose) return peerClose;
                isolated = true;
                // Establish the shared close promise before notifying any synchronous consumer.
                peerClose = Promise.resolve().then(() => pc.close());
                void peerClose.catch(() => diagnose({ code: 'node_peer_close_failed' }));
                input.signal.removeEventListener('abort', abort);
                for (const dispose of disposers.splice(0)) dispose();
                entries.clear();
                pending.length = 0;
                inFlight = undefined;
                bytes = 0;
                rejectOpened(new Error('node_transport_closed'));
                const listeners = [...closedListeners];
                closedListeners.clear();
                rawListeners.clear();
                overflowListeners.clear();
                drainListeners.clear();
                for (const listener of listeners) listener();
                return peerClose;
            };
            const pump = () => {
                if (!alive() || inFlight !== undefined || rawListeners.size === 0 || pending.length === 0) return;
                inFlight = pending.shift()!;
                const entry = entries.get(inFlight)!;
                rawListeners.values().next().value!(entry);
            };
            const raw: RawDataChannel = {
                async submit(text, windowLimit) {
                    if (!alive() || dc?.readyState !== 'open') return { status: 'failed', reason: 'closed' };
                    const size = utf8Length(text);
                    const buffered = dc.bufferedAmount;
                    const maximum = raw.maxMessageBytes();
                    if (
                        !Number.isSafeInteger(windowLimit) ||
                        windowLimit < 0 ||
                        !Number.isSafeInteger(buffered) ||
                        buffered < 0 ||
                        maximum === null ||
                        size > maximum
                    )
                        return { status: 'failed', reason: 'invalid_send_limit' };
                    if (buffered + size > windowLimit) return { status: 'blocked', bufferedAmount: buffered };
                    // This is the sole send entry: actual bufferedAmount/check/send share one JS turn.
                    try {
                        dc.send(text);
                    } catch {
                        return { status: 'failed', reason: 'send_failed' };
                    }
                    return { status: 'accepted', bufferedAmount: dc.bufferedAmount };
                },
                async release(entryId) {
                    if (!alive() || entryId !== inFlight) return false;
                    const entry = entries.get(entryId);
                    if (!entry) return false;
                    entries.delete(entryId);
                    bytes -= entry.bytes;
                    inFlight = undefined;
                    queueMicrotask(pump);
                    return true;
                },
                onRaw(listener) {
                    if (rawListeners.size > 0) throw new Error('node_raw_multiple_consumers');
                    if (alive()) rawListeners.add(listener);
                    pump();
                    return () => {
                        rawListeners.delete(listener);
                    };
                },
                onOverflow(listener) {
                    overflowListeners.add(listener);
                    return () => {
                        overflowListeners.delete(listener);
                    };
                },
                onClosed(listener) {
                    if (isolated) listener();
                    else closedListeners.add(listener);
                    return () => {
                        closedListeners.delete(listener);
                    };
                },
                onDrain(listener) {
                    drainListeners.add(listener);
                    return () => {
                        drainListeners.delete(listener);
                    };
                },
                maxMessageBytes() {
                    const maximum = pc.sctpTransport?.remoteMaxMessageSize;
                    if (maximum === undefined || !Number.isSafeInteger(maximum) || maximum < 0) return null;
                    // Zero is the negotiated unlimited case, still capped by the shared frame budget.
                    return maximum === 0
                        ? DATA_CHANNEL_LIMITS.frame_bytes
                        : Math.min(maximum, DATA_CHANNEL_LIMITS.frame_bytes);
                },
                close: closePeer
            };
            const data = createDataChannel({
                raw,
                clock: options.clock,
                finalControlType: 'ready_ack',
                diagnose: (event) => diagnose({ code: `data_channel_${event.code}`, detail: event.detail })
            });
            const close = () => {
                const operation = closePeer();
                void data.close();
                return operation;
            };
            function abort() {
                void close().catch(() => undefined);
            }
            input.signal.addEventListener('abort', abort, { once: true });
            if (input.signal.aborted) abort();
            disposers.push(
                pc.onIceCandidate.subscribe((candidate) => {
                    if (alive()) input.candidate(candidate?.toJSON() ?? null);
                }).unSubscribe
            );
            disposers.push(
                pc.connectionStateChange.subscribe((state) => {
                    if (state === 'failed' || state === 'closed') abort();
                }).unSubscribe
            );
            disposers.push(
                pc.onDataChannel.subscribe((channel) => {
                    if (
                        !alive() ||
                        dc ||
                        !channel.ordered ||
                        channel.maxRetransmits != null ||
                        channel.maxPacketLifeTime != null
                    ) {
                        diagnose({ code: 'node_data_channel_reliability_rejected' });
                        abort();
                        return;
                    }
                    dc = channel;
                    channel.bufferedAmountLowThreshold = Math.floor(DATA_CHANNEL_LIMITS.send_window_bytes / 2);
                    disposers.push(
                        channel.bufferedAmountLow.subscribe(() => {
                            if (alive()) for (const listener of drainListeners) listener();
                        }).unSubscribe
                    );
                    disposers.push(
                        channel.stateChange.subscribe((state) => {
                            if (!alive()) return;
                            if (state === 'open') resolveOpened();
                            if (state === 'closed' || state === 'closing') abort();
                        }).unSubscribe
                    );
                    disposers.push(
                        channel.onMessage.subscribe((message) => {
                            if (!alive()) return;
                            if (typeof message !== 'string') {
                                void data.close('invalid_frame');
                                return;
                            }
                            const size = utf8Length(message);
                            if (
                                bytes + size > byteLimit ||
                                entries.size + 1 > frameLimit ||
                                nextEntry >= Number.MAX_SAFE_INTEGER
                            ) {
                                for (const listener of [...overflowListeners]) listener();
                                void data.close('receive_capacity_exceeded');
                                return;
                            }
                            const entry = { entryId: nextEntry++, text: message, bytes: size };
                            entries.set(entry.entryId, entry);
                            pending.push(entry.entryId);
                            bytes += size;
                            pump();
                        }).unSubscribe
                    );
                    if (channel.readyState === 'open') resolveOpened();
                }).unSubscribe
            );
            return {
                instance: pc,
                owner,
                channel: data.channel,
                opened,
                closed: data.closed,
                async answer(sdp) {
                    check();
                    await pc.setRemoteDescription({ type: 'offer', sdp });
                    check();
                    await pc.setLocalDescription(await pc.createAnswer());
                    check();
                    if (!pc.localDescription) throw new Error('node_answer_unavailable');
                    return pc.localDescription.sdp;
                },
                async addCandidate(payload) {
                    check();
                    await pc.addIceCandidate(payload);
                    check();
                },
                async readback() {
                    check();
                    return {
                        instance: pc,
                        owner,
                        channel: data.channel,
                        state: dc?.readyState === 'open' && pc.connectionState === 'connected' ? 'open' : 'connecting',
                        stable: pc.signalingState === 'stable',
                        localDescription: pc.localDescription?.sdp ?? null,
                        remoteDescription: pc.remoteDescription?.sdp ?? null
                    };
                },
                activateTrusted() {
                    check();
                    if (
                        dc?.readyState !== 'open' ||
                        pc.connectionState !== 'connected' ||
                        pc.signalingState !== 'stable'
                    )
                        throw new Error('node_transport_not_open');
                    data.activateTrusted();
                },
                close
            };
        }
    };
}
