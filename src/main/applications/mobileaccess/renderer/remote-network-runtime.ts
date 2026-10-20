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

/**
 * 远程网络的 renderer 运行适配：只操作本实例的 Chromium 对象并如实回报。
 *
 * 这里不持账号、Ticket、资格或任何授权状态，也不做身份判定；协议核心、分片、额度与
 * 调度全部在 main 的 `src/main/applications/mobileaccess/remote-access/webrtc-transport.ts` 里。
 * 由 preload 在主窗口主 frame 私有加载，不暴露通用 ipcRenderer，业务页面无法自由调用。
 */

export interface RendererHostChannel {
    /** 向 main 发送本实例事件。 */
    emit(payload: Record<string, unknown>): void;
    /** 注册来自 main 的方法调用处理器。 */
    handle(handler: (method: string, payload: Record<string, unknown>) => Promise<unknown>): void;
}

interface RawEntry {
    entryId: number;
    text: string;
    bytes: number;
}

interface Instance {
    id: string;
    generation: number;
    connection: RTCPeerConnection;
    /**
     * 本端实际发给对端的那份描述里的 ice-ufrag。ICE 代理在网络变化时会自行重新
     * 收集并**连 localDescription 的凭据一起换掉**，所以判定基准必须是已经协商出去
     * 的那一份，而不是当前 localDescription。
     */
    negotiatedUfrag: string | null;
    channel: RTCDataChannel | null;
    closed: boolean;
    /** 原始桥入口硬上限，由 main 下发；在复制/投递前检查，不先无界 dispatch 再计数。 */
    maxRawBytes: number;
    maxRawFrames: number;
    outstandingBytes: number;
    outstandingFrames: number;
    /** 只转交一个原始事件在途，其余保留为有界原始字节，不提前解析整个队列。 */
    pending: RawEntry[];
    inFlight: RawEntry | null;
    nextEntryId: number;
    overflowed: boolean;
}

const textEncoder = new TextEncoder();
const byteLength = (value: string) => textEncoder.encode(value).length;

export function createRemoteNetworkRuntime(host: RendererHostChannel): { dispose(): void } {
    const instances = new Map<string, Instance>();
    let nextInstance = 1;

    const emit = (instance: Instance, payload: Record<string, unknown>) => {
        if (instance.closed && payload.kind !== 'closed') return;
        host.emit({ instanceId: instance.id, generation: instance.generation, ...payload });
    };

    /** 发布下一条原始条目；同一时刻只有一条在途。 */
    const publishNext = (instance: Instance) => {
        if (instance.closed || instance.inFlight || instance.pending.length === 0) return;
        const entry = instance.pending.shift()!;
        instance.inFlight = entry;
        emit(instance, { kind: 'raw', entryId: entry.entryId, text: entry.text, bytes: entry.bytes });
    };

    const acceptRaw = (instance: Instance, text: string) => {
        if (instance.closed || instance.overflowed) return;
        const bytes = byteLength(text);
        // 原子检查合计字节/条数，超出则不复制、不发布，发一次 overflow 后停止投递。
        if (
            instance.outstandingBytes + bytes > instance.maxRawBytes ||
            instance.outstandingFrames + 1 > instance.maxRawFrames
        ) {
            instance.overflowed = true;
            emit(instance, { kind: 'overflow' });
            return;
        }
        instance.outstandingBytes += bytes;
        instance.outstandingFrames += 1;
        instance.pending.push({ entryId: instance.nextEntryId++, text, bytes });
        publishNext(instance);
    };

    const bindChannel = (instance: Instance, channel: RTCDataChannel) => {
        if (instance.channel) {
            // 只接受一条 ordered/reliable DataChannel；多余的一律拒绝。
            try {
                channel.close();
            } catch {
                // 关闭多余通道失败不改变本实例状态。
            }
            return;
        }
        instance.channel = channel;
        channel.binaryType = 'arraybuffer';
        // 排空到低水位只用来唤醒 main 重查，不携带任何容量数值。
        channel.bufferedAmountLowThreshold = 0;
        channel.onbufferedamountlow = () => emit(instance, { kind: 'drain' });
        channel.onopen = () => emit(instance, { kind: 'opened' });
        channel.onmessage = (event: MessageEvent) => {
            if (typeof event.data !== 'string') {
                // 数据通道只在这条链路上承载文字帧；二进制输入是违约输入。
                instance.overflowed = true;
                emit(instance, { kind: 'overflow' });
                return;
            }
            acceptRaw(instance, event.data);
        };
        channel.onclose = () => closeInstance(instance, 'channel_closed');
        channel.onerror = () => closeInstance(instance, 'channel_error');
        if (channel.readyState === 'open') emit(instance, { kind: 'opened' });
    };

    /** reason 只是有限分类标签，用于上报关闭来源；不带地址、SDP 或原始异常。 */
    /** 当前本地描述里的 ice-ufrag；取不到时返回 null，调用方不做判断。 */
    const localUfrag = (connection: RTCPeerConnection): string | null => {
        const sdp = connection.localDescription?.sdp;
        if (!sdp) return null;
        // SDP 用 CRLF，$ 不会在 \r 前匹配；这里不锚定行尾。
        const matched = /^a=ice-ufrag:([^\s]+)/m.exec(sdp);
        return matched ? matched[1] : null;
    };

    const closeInstance = (instance: Instance, reason = 'requested') => {
        if (instance.closed) return;
        instance.closed = true;
        instance.pending.length = 0;
        instance.inFlight = null;
        instance.outstandingBytes = 0;
        instance.outstandingFrames = 0;
        try {
            instance.channel?.close();
        } catch {
            // 关闭失败仍然继续清理并上报。
        }
        try {
            instance.connection.close();
        } catch {
            // 同上。
        }
        emit(instance, { kind: 'closed', reason });
        instances.delete(instance.id);
    };

    const lookup = (payload: Record<string, unknown>): Instance => {
        const instance = instances.get(String(payload.instanceId));
        if (!instance) throw new Error('unknown data channel instance');
        if (instance.generation !== payload.generation) throw new Error('stale data channel generation');
        return instance;
    };

    host.handle(async (method, payload) => {
        switch (method) {
            case 'create': {
                const id = `data-channel-${nextInstance++}`;
                const turn = Array.isArray(payload.iceServers) ? payload.iceServers : [];
                const stun = Array.isArray(payload.stunUrls) ? (payload.stunUrls as string[]) : [];
                // 原 TURN 条目使用本端临时凭据；派生的 STUN 条目不带凭据，一次性配给同一实例。
                const iceServers: RTCIceServer[] = [
                    ...(turn as Array<{ urls: string[]; username: string; credential: string }>),
                    ...stun.map((urls) => ({ urls }))
                ];
                const connection = new RTCPeerConnection({ iceServers });
                const instance: Instance = {
                    id,
                    generation: Number(payload.generation),
                    connection,
                    negotiatedUfrag: null,
                    channel: null,
                    closed: false,
                    maxRawBytes: Number(payload.rawBridgeBytes),
                    maxRawFrames: Number(payload.rawBridgeFrames),
                    outstandingBytes: 0,
                    outstandingFrames: 0,
                    pending: [],
                    inFlight: null,
                    nextEntryId: 1,
                    overflowed: false
                };
                instances.set(id, instance);
                connection.onicecandidate = (event) => {
                    const candidate = event.candidate ? event.candidate.toJSON() : null;
                    if (
                        candidate &&
                        typeof candidate.usernameFragment === 'string' &&
                        instance.negotiatedUfrag !== null &&
                        candidate.usernameFragment !== instance.negotiatedUfrag
                    ) {
                        // 本端从不 restartIce、不重新协商，这些属于另一个 ICE 代次的候选
                        // 对本次协商无用；发出去还会被协调方按不匹配拒掉、误杀整个尝试。
                        emit(instance, { kind: 'candidateDropped', reason: 'ufrag_mismatch' });
                        return;
                    }
                    emit(instance, { kind: 'candidate', candidate });
                };
                connection.onconnectionstatechange = () => {
                    const state = connection.connectionState;
                    if (state === 'failed' || state === 'closed') closeInstance(instance, `pc_${state}`);
                };
                // PC 是应答方：手机创建数据通道，本端只接受这一条，不主动创建。
                connection.ondatachannel = (event) => bindChannel(instance, event.channel);
                return { instanceId: id, maxMessageBytes: null };
            }
            case 'answer': {
                const instance = lookup(payload);
                await instance.connection.setRemoteDescription({
                    type: 'offer',
                    sdp: String(payload.sdp)
                });
                const answer = await instance.connection.createAnswer();
                await instance.connection.setLocalDescription(answer);
                const local = instance.connection.localDescription;
                if (!local) throw new Error('no local description after applying the answer');
                // 发出去的这一份就是协商基准，后续候选按它过滤。
                instance.negotiatedUfrag = localUfrag(instance.connection);
                return { sdp: local.sdp };
            }
            case 'addCandidate': {
                const instance = lookup(payload);
                const candidate = payload.candidate;
                // null 表示候选收集结束，按 WebRTC 语义传入 undefined 结束。
                await instance.connection.addIceCandidate(candidate ? (candidate as RTCIceCandidateInit) : undefined);
                return {};
            }
            case 'readback': {
                const instance = lookup(payload);
                // 读回必须来自应用成功后的本实例当前属性，不用提交入参或缓存成功值替代。
                const connection = instance.connection;
                const channel = instance.channel;
                return {
                    state:
                        channel?.readyState === 'open'
                            ? 'open'
                            : channel?.readyState === 'closed' || channel?.readyState === 'closing'
                              ? 'closed'
                              : 'connecting',
                    stable: connection.signalingState === 'stable',
                    localDescription: connection.localDescription?.sdp ?? null,
                    remoteDescription: connection.remoteDescription?.sdp ?? null,
                    // 实际可用的单次发送上限，由本实例的 SCTP 协商结果给出。
                    maxMessageBytes:
                        typeof connection.sctp?.maxMessageSize === 'number' &&
                        Number.isSafeInteger(connection.sctp.maxMessageSize)
                            ? connection.sctp.maxMessageSize
                            : null
                };
            }
            case 'submit': {
                const instance = lookup(payload);
                const channel = instance.channel;
                if (instance.closed) return { status: 'failed', reason: 'closed' };
                if (!channel || channel.readyState !== 'open') return { status: 'failed', reason: 'not_open' };
                const text = String(payload.text);
                const bytes = byteLength(text);
                // 读 bufferedAmount、判断、调用 send 在这一个同步段内完成，
                // renderer 是单线程，期间不会有其他本地发送插入。
                const buffered = channel.bufferedAmount;
                if (buffered + bytes > Number(payload.windowLimit))
                    return { status: 'blocked', bufferedAmount: buffered, bytes };
                try {
                    channel.send(text);
                } catch {
                    return { status: 'failed', reason: 'native_rejected' };
                }
                return { status: 'accepted', bufferedAmount: buffered, bytes };
            }
            case 'release': {
                const instance = lookup(payload);
                const entryId = Number(payload.entryId);
                if (!instance.inFlight || instance.inFlight.entryId !== entryId)
                    return { released: false, reason: 'unknown_entry' };
                instance.outstandingBytes -= instance.inFlight.bytes;
                instance.outstandingFrames -= 1;
                instance.inFlight = null;
                publishNext(instance);
                return {
                    released: true,
                    outstandingBytes: instance.outstandingBytes,
                    outstandingFrames: instance.outstandingFrames
                };
            }
            case 'close': {
                const instance = instances.get(String(payload.instanceId));
                if (instance) closeInstance(instance);
                return {};
            }
            default:
                throw new Error('unknown remote network method');
        }
    });

    return {
        dispose() {
            for (const instance of [...instances.values()]) closeInstance(instance);
            instances.clear();
        }
    };
}
