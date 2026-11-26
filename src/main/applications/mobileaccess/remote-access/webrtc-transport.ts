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
 * 远程网络数据通道：n3-channel-v1 封装、分片重组、跨端消费回报、存活探测与关闭收敛。
 *
 * 本文件的协议语义与 Mobile 的 `src/features/remote/connection/webrtc-transport.ts` 逐条对齐，
 * 共同的边界向量在 `src/tests/ut/node/remote-access/fixtures/n3-channel-v1.json`（本仓为维护源）。
 * 平台细节（Electron renderer / RN 原生）通过 RawDataChannel 注入，协议核心不接触 Electron 或 IPC。
 */

import type { AcpMessageChannel } from '../acp/mobile/transport/acp-message-stream.js';
// 仅类型依赖，运行时被擦除；信令侧的 connection-runtime 不反向依赖本文件。
import type { DesktopNetworkTransport, NetworkHostOwner } from './connection-runtime.js';

/** 全部为编码字节，不是解码后大小。数值来源见 Spec §6.2.1 / §6.3 / §7.2。 */
export const DATA_CHANNEL_LIMITS = {
    /** 每条完整 ACP JSON 的 UTF-8 字节。 */
    message_bytes: 67108864,
    /** 单帧上限目标，含整个 JSON 外层与 Base64。 */
    frame_bytes: 262144,
    /** 本地发送窗口 W。 */
    send_window_bytes: 4194304,
    /** 对端未消费 data 额度。 */
    peer_data_bytes: 4194304,
    peer_data_frames: 64,
    /** 控制预留，不借用业务额度。 */
    control_bytes: 131072,
    control_frames: 128,
    control_frame_bytes: 1024,
    /** 原始桥入口硬上限 = 业务额度 + 控制预留。 */
    raw_bridge_bytes: 4325376,
    raw_bridge_frames: 192,
    /** 存活与等待，全部使用本地单调时间。 */
    probe_interval_ms: 10000,
    probe_timeout_ms: 10000,
    probe_failures: 3,
    probe_quiet_ms: 30000,
    liveness_ms: 60000,
    probe_record_count: 6,
    probe_record_age_ms: 60000,
    send_block_ms: 60000,
    receive_idle_ms: 90000,
    /** blocked 后弥补事件遗漏的有界重查间隔；只唤醒重查，不发放空间、不续期。 */
    drain_recheck_ms: 250,
    /** 可信激活前信令握手直通的队列深度上界，与信令自身的 control_queue_count 一致。 */
    control_queue_depth: 8
} as const;

/**
 * 有限内部分类。经既有关闭接口/诊断衔接，由信令层与手机端映射为用户文案；
 * 不透传原生异常或业务正文，字段本身不可本地化。
 */
export type DataChannelErrorCode =
    | 'message_too_large'
    | 'invalid_frame'
    | 'transport_send_failed'
    | 'transport_contract_violation'
    | 'receive_capacity_exceeded'
    | 'send_stalled'
    | 'receive_stalled'
    | 'peer_unreachable';

export class DataChannelError extends Error {
    readonly code: DataChannelErrorCode;
    constructor(code: DataChannelErrorCode, message: string = code) {
        super(message);
        this.name = 'DataChannelError';
        this.code = code;
    }
}

export type DataChannelFrame =
    | { n3: 1; type: 'data'; id: number; total: number; offset: number; data: string }
    | { n3: 1; type: 'probe'; id: number }
    | { n3: 1; type: 'reply'; id: number }
    | { n3: 1; type: 'consumed'; seq: number };

const encoder = new TextEncoder();
const strictDecoder = new TextDecoder('utf-8', { fatal: true });

export function utf8Length(value: string): number {
    return encoder.encode(value).length;
}

function positiveSafeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function nonNegativeSafeInteger(value: unknown): value is number {
    // Object.is rejects -0, which JSON.parse can produce from "-0".
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

const BASE64_ALPHABET = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Base64 的「形状」：长度为 4 的倍数、标准字母表、填充只在末尾。属于帧结构，在解码层判定。
 * 「规范性」（非零填充位）必须真解码才能知道，属语义层，见 decodeCanonicalBase64。
 */
function isBase64Shape(value: string): boolean {
    return value.length > 0 && value.length % 4 === 0 && BASE64_ALPHABET.test(value);
}

/**
 * 规范 Base64：标准字母表、正确填充、无换行、无 URL-safe 变体，且重新编码后逐字节相同
 * （后者排除非零填充位，例如 "AB==" 这类可解码但非规范的输入）。
 */
export function decodeCanonicalBase64(value: string): Uint8Array | null {
    if (value.length === 0 || value.length % 4 !== 0 || !BASE64_ALPHABET.test(value)) return null;
    let bytes: Buffer;
    try {
        bytes = Buffer.from(value, 'base64');
    } catch {
        return null;
    }
    if (bytes.length === 0) return null;
    if (bytes.toString('base64') !== value) return null;
    return new Uint8Array(bytes);
}

export function encodeBase64(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64');
}

/** 严格解码。任何偏差返回 null，由调用方按 §6.5 收敛；不得退回为 ACP 或信令消息。 */
export function decodeDataChannelFrame(raw: string): DataChannelFrame | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const frame = parsed as Record<string, unknown>;
    if (frame.n3 !== 1) return null;
    const keys = Object.keys(frame).sort().join(',');
    switch (frame.type) {
        case 'data':
            if (keys !== 'data,id,n3,offset,total,type') return null;
            if (!positiveSafeInteger(frame.id)) return null;
            if (!positiveSafeInteger(frame.total)) return null;
            if (!nonNegativeSafeInteger(frame.offset)) return null;
            if (typeof frame.data !== 'string' || !isBase64Shape(frame.data)) return null;
            return frame as DataChannelFrame;
        case 'probe':
        case 'reply':
            if (keys !== 'id,n3,type') return null;
            if (!positiveSafeInteger(frame.id)) return null;
            return frame as DataChannelFrame;
        case 'consumed':
            if (keys !== 'n3,seq,type') return null;
            if (!positiveSafeInteger(frame.seq)) return null;
            return frame as DataChannelFrame;
        default:
            return null;
    }
}

/** 字段顺序即序列化顺序，两端必须一致，fixture 依赖该顺序。 */
export function encodeDataFrame(id: number, total: number, offset: number, data: string): string {
    return JSON.stringify({ n3: 1, type: 'data', id, total, offset, data });
}

export function dataHeaderBytes(id: number, total: number, offset: number): number {
    return utf8Length(encodeDataFrame(id, total, offset, ''));
}

/**
 * Spec §6.4 的分块计算：按本帧实际头部长度扣除空间，以 Base64 四字节组计算可放入的原始字节。
 * 因此原始数据块必然小于 frameCap，不把包装开销加到硬限额之外。
 */
export function planDataBlock(
    id: number,
    total: number,
    offset: number,
    frameCap: number
): { rawBytes: number } | null {
    const budget = frameCap - dataHeaderBytes(id, total, offset);
    if (budget < 4) return null;
    const maxBase64 = Math.floor(budget / 4) * 4;
    const rawBytes = Math.min((maxBase64 / 4) * 3, total - offset);
    return rawBytes > 0 ? { rawBytes } : null;
}

/** 平台注入的原始通道。协议核心只依赖这一层，不感知 Electron / RN。 */
export interface RawChannelEntry {
    readonly entryId: number;
    readonly text: string;
    readonly bytes: number;
}

export type RawChannelSubmitResult =
    | { status: 'accepted'; bufferedAmount: number }
    | { status: 'blocked'; bufferedAmount: number }
    | { status: 'failed'; reason: string }
    /**
     * 受控发送点报告：读 bufferedAmount 到调用底层 send 之间，本通道上还有别的发送。
     * 这时窗口判断依据的读数已经不是发送被度量的读数，按 §6.5 的
     * transport_contract_violation 收敛，不能当普通 failed 重试。
     */
    | { status: 'contract_violation'; reason: string };

export interface RawDataChannel {
    /** 唯一受控发送入口。读 bufferedAmount、判断、调用底层 send 必须在同一原生块内完成。 */
    submit(text: string, windowLimit: number): Promise<RawChannelSubmitResult>;
    /** 释放一条已消费的原始条目；必须在原生计数真正递减之后才 resolve。 */
    release(entryId: number): Promise<boolean>;
    onRaw(listener: (entry: RawChannelEntry) => void): () => void;
    /** 原始桥入口硬上限被突破；对端违规或计量缺陷，按 §6.5 有限关闭。 */
    onOverflow(listener: () => void): () => void;
    onClosed(listener: () => void): () => void;
    /**
     * 底层缓冲排空到低水位的通知。**只唤醒重查，不据其值发放空间、不续任何期限**。
     * 可选：平台没有这个事件时，仍由有界周期重查兜底，只是每次多等一个重查间隔。
     */
    onDrain?(listener: () => void): () => void;
    /** 本端已验证的底层单次发送上限；用于 min(256 KiB, 该值)。 */
    maxMessageBytes(): number | null;
    close(): Promise<void>;
}

export interface DataChannelClock {
    now(): number;
    setTimeout(callback: () => void, delay: number): unknown;
    clearTimeout(timer: unknown): void;
}

export interface DataChannelOptions {
    raw: RawDataChannel;
    clock?: Partial<DataChannelClock>;
    /** 本端交付最终控制帧后暂停处理后续原始输入，直到 activateTrusted 或关闭。 */
    finalControlType: 'ready_ack' | 'ready';
    limits?: Partial<typeof DATA_CHANNEL_LIMITS>;
    diagnose?(event: { code: string; detail?: string; bytes?: number; frames?: number }): void;
}

export interface DataChannel {
    readonly channel: AcpMessageChannel;
    /** G1：信令完成全部核验后调用。同实例重复调用不重置存活基点，已关闭后调用失败。 */
    activateTrusted(): void;
    readonly activated: boolean;
    close(reason?: DataChannelErrorCode): Promise<void>;
    readonly closed: Promise<void>;
    /** 仅供测试与诊断读取，不参与调度判定。 */
    inspect(): DataChannelSnapshot;
}

export interface DataChannelSnapshot {
    activated: boolean;
    terminated: boolean;
    outboundMessageSeq: number;
    expectedInboundMessageSeq: number;
    outboundDataSeq: number;
    consumedInboundDataSeq: number;
    acknowledgedConsumedSeq: number;
    probeSeq: number;
    outstandingPeerBytes: number;
    outstandingPeerFrames: number;
    pendingProbe: number | null;
    pendingReply: number | null;
    pendingConsumed: number | null;
    businessPriority: boolean;
    backlog: boolean;
    probeFailures: number;
    probeRecords: number;
    reassemblyBytes: number;
    heldRawEntries: number;
    frameCap: number;
}

const defaultClock: DataChannelClock = {
    now: () => Date.now(),
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)
};

interface SentDataRecord {
    seq: number;
    bytes: number;
}

interface ProbeRecord {
    id: number;
    submittedAt: number;
}

type Submission =
    | { kind: 'passthrough'; text: string; resolve(): void; reject(error: Error): void }
    | { kind: 'data'; text: string; bytes: number; seq: number; rawBytes: number }
    | { kind: 'probe'; text: string; id: number }
    | { kind: 'reply'; text: string; id: number }
    | { kind: 'consumed'; text: string; seq: number };

export function createDataChannel(options: DataChannelOptions): DataChannel {
    const limits = { ...DATA_CHANNEL_LIMITS, ...options.limits };
    const clock: DataChannelClock = { ...defaultClock, ...options.clock };
    const raw = options.raw;
    const diagnose = options.diagnose ?? (() => undefined);

    // 出站单帧上限 min(256 KiB, 本连接已验证的底层单次发送上限)。未知时不能填 Infinity。
    // 底层上限（PC 的 sctp.maxMessageSize / RN 的远端 SDP max-message-size）要到描述
    // 交换完成后才有值，因此在 G1 可信激活时固定，而不是构造时——构造时连接还没建立。
    let frameCap: number = limits.frame_bytes;
    // 入站检查按本端接收能力，不误用相反方向的值；256 KiB 是任何守约对端的协议上限。
    const inboundFrameCap = limits.frame_bytes;

    let activated = false;
    let terminated = false;
    let terminationError: DataChannelError | null = null;
    /** 原始通道监听器的注销句柄；关闭时必须全部解除，避免旧回调触达新实例。 */
    const disposers: Array<() => void> = [];

    // 阶段处理屏障：交付最终控制帧之后、明确通知或关闭之前，暂停处理后续原始事件。
    let barrier = false;

    const messageListeners = new Set<(message: string) => void>();
    const closeListeners = new Set<(error?: Error) => void>();
    let closeEmitted = false;
    let resolveClosed: () => void = () => undefined;
    const closedPromise = new Promise<void>((resolve) => {
        resolveClosed = resolve;
    });

    // ---- 出站状态 ----
    let outboundMessageSeq = 0;
    let outboundDataSeq = 0;
    let probeSeq = 0;
    let currentSend: {
        bytes: Uint8Array;
        total: number;
        offset: number;
        id: number;
        resolve(): void;
        reject(error: Error): void;
    } | null = null;
    /** 已准备好、等待提交的当前块。保留当前块等待，不预生成整套分块。 */
    let currentBlock: { text: string; bytes: number; rawBytes: number; seq: number } | null = null;
    let inflight: Submission | null = null;
    let pendingProbe: number | null = null;
    let pendingReply: number | null = null;
    let pendingConsumed: number | null = null;
    let businessPriority = false;
    let dataBlockedThisRound = false;
    let waitingForDrain = false;
    let drainTimer: unknown = null;

    // 对端未消费额度：发送端由自己保存的帧记录计算释放，不信任对端自报容量。
    const sentRecords: SentDataRecord[] = [];
    let outstandingPeerBytes = 0;
    let acknowledgedConsumedSeq = 0;
    /** 唯一允许的提前回报暂存：指向当前已跨桥发出、仍在等待真实结果的 data 序号。 */
    let earlyConsumed: number | null = null;

    // ---- 入站状态 ----
    let expectedInboundMessageSeq = 1;
    let consumedInboundDataSeq = 0;
    let reassembly: { id: number; total: number; received: number; buffer: Uint8Array } | null = null;
    /** 屏障期间按原始条目挂起；原始条目仍占原生桥预算，不预解码为 ACP。 */
    const heldRawEntries: RawChannelEntry[] = [];
    let processingRaw = false;

    // ---- 计时 ----
    let blockWaitStartedAt: number | null = null;
    let blockWaitTimer: unknown = null;
    let receiveIdleTimer: unknown = null;
    let probeIntervalTimer: unknown = null;
    let probeTimeoutTimer: unknown = null;
    let currentProbe: ProbeRecord | null = null;
    let lastProbeSubmittedAt = 0;
    const probeRecords: ProbeRecord[] = [];
    let probeFailures = 0;
    let lastValidReplyAt = 0;
    let acceptedReplyId = 0;
    let backlog = false;
    let livenessTimer: unknown = null;

    const clearTimer = (timer: unknown) => {
        if (timer !== null && timer !== undefined) clock.clearTimeout(timer);
    };

    function snapshot(): DataChannelSnapshot {
        return {
            activated,
            terminated,
            outboundMessageSeq,
            expectedInboundMessageSeq,
            outboundDataSeq,
            consumedInboundDataSeq,
            acknowledgedConsumedSeq,
            probeSeq,
            outstandingPeerBytes,
            outstandingPeerFrames: sentRecords.length,
            pendingProbe,
            pendingReply,
            pendingConsumed,
            businessPriority,
            backlog,
            probeFailures,
            probeRecords: probeRecords.length,
            reassemblyBytes: reassembly?.received ?? 0,
            heldRawEntries: heldRawEntries.length,
            frameCap
        };
    }

    /**
     * 同步隔离：先封锁读写，再结束全部等待，发出一次 onClose，最后尝试关闭实际 transport。
     * 迟到成功不得 resolve 或恢复 ready。
     */
    function terminate(code: DataChannelErrorCode | null, detail?: string): void {
        if (terminated) return;
        terminated = true;
        activated = false;
        barrier = false;
        const error = code ? new DataChannelError(code, detail ?? code) : null;
        terminationError = error;
        if (code) diagnose({ code, detail });

        clearTimer(blockWaitTimer);
        clearTimer(receiveIdleTimer);
        clearTimer(probeIntervalTimer);
        clearTimer(probeTimeoutTimer);
        clearTimer(livenessTimer);
        clearTimer(drainTimer);
        blockWaitTimer = receiveIdleTimer = probeIntervalTimer = probeTimeoutTimer = null;
        livenessTimer = drainTimer = null;
        blockWaitStartedAt = null;

        const failure = error ?? new DataChannelError('transport_send_failed', 'channel closed');
        const pendingSend = currentSend;
        currentSend = null;
        currentBlock = null;
        const pendingPassthrough = inflight && inflight.kind === 'passthrough' ? inflight : null;
        inflight = null;
        pendingProbe = pendingReply = pendingConsumed = null;
        businessPriority = false;
        dataBlockedThisRound = false;
        waitingForDrain = false;
        sentRecords.length = 0;
        outstandingPeerBytes = 0;
        earlyConsumed = null;
        probeRecords.length = 0;
        currentProbe = null;
        reassembly = null;
        heldRawEntries.length = 0;
        for (const queued of passthroughQueue) queued.reject(failure);
        passthroughQueue.length = 0;

        pendingSend?.reject(failure);
        pendingPassthrough?.reject(failure);

        if (!closeEmitted) {
            closeEmitted = true;
            for (const listener of [...closeListeners]) {
                try {
                    listener(error ?? undefined);
                } catch {
                    // 关闭通知失败不得阻塞其余清理。
                }
            }
        }
        messageListeners.clear();
        closeListeners.clear();
        for (const dispose of disposers.splice(0)) {
            try {
                dispose();
            } catch {
                // 注销失败不得阻塞其余清理。
            }
        }
        void raw.close().catch(() => undefined);
        resolveClosed();
    }

    // ------------------------------------------------------------------
    // 出站调度
    // ------------------------------------------------------------------

    const passthroughQueue: Array<{ text: string; resolve(): void; reject(error: Error): void }> = [];

    function peerAllowanceAdmits(bytes: number): boolean {
        return (
            outstandingPeerBytes + bytes <= limits.peer_data_bytes && sentRecords.length + 1 <= limits.peer_data_frames
        );
    }

    /** 当前块因任一原因暂停提交时开始同一个 60 秒等待；在原因之间切换不重启计时。 */
    function beginBlockWait(): void {
        if (blockWaitStartedAt !== null) return;
        blockWaitStartedAt = clock.now();
        blockWaitTimer = clock.setTimeout(() => {
            terminate('send_stalled', 'current block exceeded the send block wait');
        }, limits.send_block_ms);
        markBacklog('send-wait');
    }

    function endBlockWait(): void {
        if (blockWaitStartedAt === null) return;
        blockWaitStartedAt = null;
        clearTimer(blockWaitTimer);
        blockWaitTimer = null;
    }

    function scheduleDrainRecheck(): void {
        if (drainTimer !== null || terminated) return;
        drainTimer = clock.setTimeout(() => {
            drainTimer = null;
            if (terminated) return;
            waitingForDrain = false;
            pump();
        }, limits.drain_recheck_ms);
    }

    /** 缓冲事件与排空只唤醒重查，不据其值发放空间，也不续任何期限。 */
    function wakeForDrain(): void {
        if (terminated) return;
        waitingForDrain = false;
        clearTimer(drainTimer);
        drainTimer = null;
        pump();
    }

    function prepareNextBlock(): void {
        if (currentBlock || !currentSend || terminated) return;
        const send = currentSend;
        const plan = planDataBlock(send.id, send.total, send.offset, frameCap);
        if (!plan) {
            terminate('transport_contract_violation', 'frame cap cannot carry a data block');
            return;
        }
        const slice = send.bytes.subarray(send.offset, send.offset + plan.rawBytes);
        const text = encodeDataFrame(send.id, send.total, send.offset, encodeBase64(slice));
        const bytes = utf8Length(text);
        if (bytes > frameCap) {
            terminate('transport_contract_violation', 'serialized data frame exceeds the frame cap');
            return;
        }
        if (outboundDataSeq >= Number.MAX_SAFE_INTEGER) {
            terminate('transport_contract_violation', 'outbound data sequence exhausted');
            return;
        }
        currentBlock = { text, bytes, rawBytes: plan.rawBytes, seq: outboundDataSeq + 1 };
    }

    function pump(): void {
        if (terminated || inflight || waitingForDrain) return;

        // 信令握手帧（可信激活之前的直通）优先于一切数据通道帧。
        if (passthroughQueue.length > 0) {
            const next = passthroughQueue.shift()!;
            void submit({ kind: 'passthrough', text: next.text, resolve: next.resolve, reject: next.reject });
            return;
        }
        if (!activated) return;

        if (pendingProbe !== null) {
            const id = pendingProbe;
            pendingProbe = null;
            void submit({ kind: 'probe', text: JSON.stringify({ n3: 1, type: 'probe', id }), id });
            return;
        }
        if (pendingReply !== null) {
            const id = pendingReply;
            pendingReply = null;
            void submit({ kind: 'reply', text: JSON.stringify({ n3: 1, type: 'reply', id }), id });
            return;
        }

        prepareNextBlock();
        const dataEligible = currentBlock !== null && peerAllowanceAdmits(currentBlock.bytes);

        // 公平轮转：consumed 成功提交后置位业务优先；只有该块本轮实际可提交才暂缓 consumed。
        if (businessPriority && dataEligible && !dataBlockedThisRound) {
            void submitData();
            return;
        }
        if (pendingConsumed !== null) {
            const seq = pendingConsumed;
            pendingConsumed = null;
            dataBlockedThisRound = false;
            void submit({ kind: 'consumed', text: JSON.stringify({ n3: 1, type: 'consumed', seq }), seq });
            return;
        }
        if (dataEligible) {
            void submitData();
            return;
        }
        if (currentBlock) beginBlockWait();
    }

    function submitData(): void {
        const block = currentBlock!;
        // 跨桥前原子预留对端字节/条数并登记本次序号。
        outstandingPeerBytes += block.bytes;
        sentRecords.push({ seq: block.seq, bytes: block.bytes });
        outboundDataSeq = block.seq;
        void submit({
            kind: 'data',
            text: block.text,
            bytes: block.bytes,
            seq: block.seq,
            rawBytes: block.rawBytes
        });
    }

    /** 撤销未真实提交的 data 预留；同一块继续等原期限，该序号可用于其下一次真实提交。 */
    function revertDataReservation(seq: number, bytes: number): void {
        const index = sentRecords.findIndex((record) => record.seq === seq);
        if (index === -1) return;
        sentRecords.splice(index, 1);
        outstandingPeerBytes -= bytes;
        if (outboundDataSeq === seq) outboundDataSeq = seq - 1;
    }

    async function submit(submission: Submission): Promise<void> {
        inflight = submission;
        let result: RawChannelSubmitResult;
        try {
            result = await raw.submit(submission.text, limits.send_window_bytes - frameCap);
        } catch (error) {
            inflight = null;
            if (submission.kind === 'data') revertDataReservation(submission.seq, submission.bytes);
            terminate('transport_send_failed', error instanceof Error ? error.name : 'submit threw');
            return;
        }
        // 迟到结果先检查终态，再结算。
        if (terminated) return;
        inflight = null;

        if (result.status === 'contract_violation') {
            if (submission.kind === 'data') revertDataReservation(submission.seq, submission.bytes);
            terminate('transport_contract_violation', result.reason);
            return;
        }

        if (result.status === 'failed') {
            if (submission.kind === 'data') revertDataReservation(submission.seq, submission.bytes);
            terminate('transport_send_failed', result.reason);
            return;
        }

        if (result.status === 'blocked') {
            if (submission.kind === 'data') {
                // blocked 表示尚未调用底层 send。若已收到指向该序号的提前回报，则是桥合同错误。
                if (earlyConsumed === submission.seq) {
                    terminate('transport_contract_violation', 'consumed reported for a block that was never sent');
                    return;
                }
                revertDataReservation(submission.seq, submission.bytes);
                dataBlockedThisRound = true;
                beginBlockWait();
            } else if (submission.kind === 'passthrough') {
                passthroughQueue.unshift(submission);
                beginBlockWait();
            } else {
                // 控制帧放不下：沿原唤醒/有界重查等待，不建立重试队列。
                restorePendingControl(submission);
                // 这个 60 秒按 §6.3 只属于**当前块**，且只在该块被 native 接受时结束。
                // 没有当前块时不能起这个计时：控制帧 accepted 不会结束它，一次被挡就会
                // 在其后健康、空闲的连接上留下必然到期的 send_stalled。
                // 控制帧自身的饥饿由 §7.1 的存活兜底收敛。
                if (currentBlock) beginBlockWait();
            }
            markBacklog('local-window');
            waitingForDrain = true;
            scheduleDrainRecheck();
            // consumed 让行：blocked 后本轮允许按回报自身大小尝试提交。
            if (submission.kind === 'data' && pendingConsumed !== null) {
                waitingForDrain = false;
                pump();
            }
            return;
        }

        // accepted
        switch (submission.kind) {
            case 'passthrough':
                submission.resolve();
                endBlockWait();
                break;
            case 'data': {
                currentBlock = null;
                endBlockWait();
                businessPriority = false;
                dataBlockedThisRound = false;
                const send = currentSend;
                if (send) {
                    send.offset += submission.rawBytes;
                    if (send.offset >= send.total) {
                        currentSend = null;
                        send.resolve();
                    }
                }
                // 真实 accepted 回来后先确认序号，再结算提前到达的回报。
                if (earlyConsumed !== null) {
                    const seq = earlyConsumed;
                    earlyConsumed = null;
                    applyConsumed(seq);
                }
                break;
            }
            case 'probe':
                startProbeTimeout(submission.id);
                break;
            case 'reply':
                break;
            case 'consumed':
                businessPriority = true;
                break;
        }
        if (!terminated) pump();
    }

    function restorePendingControl(submission: Submission): void {
        if (submission.kind === 'probe') {
            pendingProbe = pendingProbe === null ? submission.id : Math.max(pendingProbe, submission.id);
        } else if (submission.kind === 'reply') {
            pendingReply = pendingReply === null ? submission.id : Math.max(pendingReply, submission.id);
        } else if (submission.kind === 'consumed') {
            pendingConsumed = pendingConsumed === null ? submission.seq : Math.max(pendingConsumed, submission.seq);
        }
    }

    // ------------------------------------------------------------------
    // 对端消费回报
    // ------------------------------------------------------------------

    function applyConsumed(seq: number): void {
        if (seq <= acknowledgedConsumedSeq) return; // 合法重复/旧回报，忽略。
        const highestSent = sentRecords.length > 0 ? sentRecords[sentRecords.length - 1].seq : outboundDataSeq;
        if (seq > highestSent) {
            terminate('transport_contract_violation', 'consumed exceeds the accepted outbound prefix');
            return;
        }
        while (sentRecords.length > 0 && sentRecords[0].seq <= seq) {
            outstandingPeerBytes -= sentRecords[0].bytes;
            sentRecords.shift();
        }
        acknowledgedConsumedSeq = seq;
        if (!terminated) pump();
    }

    function onConsumedFrame(seq: number): void {
        if (seq <= acknowledgedConsumedSeq) return;
        const inflightData = inflight && inflight.kind === 'data' ? inflight : null;
        if (inflightData && seq === inflightData.seq) {
            // 唯一允许的提前暂存：保留一个数，暂不释放任何额度。
            earlyConsumed = seq;
            return;
        }
        applyConsumed(seq);
    }

    // ------------------------------------------------------------------
    // 存活探测
    // ------------------------------------------------------------------

    function markBacklog(_reason: string): void {
        backlog = true;
    }

    function pruneProbeRecords(at: number): void {
        while (probeRecords.length > 0 && at - probeRecords[0].submittedAt >= limits.probe_record_age_ms) {
            probeRecords.shift();
        }
        while (probeRecords.length > limits.probe_record_count) probeRecords.shift();
    }

    /**
     * 单一周期驱动。Spec §7.1：探测周期与前次超时恰好同刻时先结算前次等待，再决定是否
     * 发下一次，避免重叠等待和重复计数。用两个独立定时器会让新探测覆盖 currentProbe，
     * 使旧计时到期时认不出自己那一次，失败永远记不上。
     */
    function scheduleProbe(): void {
        clearTimer(probeIntervalTimer);
        probeIntervalTimer = clock.setTimeout(() => {
            probeIntervalTimer = null;
            if (terminated || !activated) return;
            settleExpiredProbe();
            if (terminated) return;
            scheduleProbe();
            // 上一次探测仍在计时中：一次最多一个等待计时中的探测，本轮不发。
            if (currentProbe !== null) return;
            // 两次实际提交至少间隔 10 秒；定时器积压不补发一串探测。
            if (lastProbeSubmittedAt > 0 && clock.now() - lastProbeSubmittedAt < limits.probe_interval_ms) return;
            if (probeSeq >= Number.MAX_SAFE_INTEGER) {
                terminate('transport_contract_violation', 'probe sequence exhausted');
                return;
            }
            // 调度探测时前面已有待提交或缓冲，属于潜在有序排队。
            if (inflight || currentBlock || passthroughQueue.length > 0) markBacklog('probe-queue');
            probeSeq += 1;
            // 未提交的探测只占待发槽，不计「已发无回」。
            pendingProbe = probeSeq;
            pump();
        }, limits.probe_interval_ms);
    }

    /** 每次计时到期最多记一次失败；不因保留迟到匹配记录再计失败。 */
    function settleExpiredProbe(): void {
        if (currentProbe === null) return;
        if (clock.now() - currentProbe.submittedAt < limits.probe_timeout_ms) return;
        currentProbe = null;
        probeFailures += 1;
        evaluateLiveness();
    }

    /** 从实际受控提交成功开始等待。 */
    function startProbeTimeout(id: number): void {
        const at = clock.now();
        lastProbeSubmittedAt = at;
        pruneProbeRecords(at);
        probeRecords.push({ id, submittedAt: at });
        pruneProbeRecords(at);
        currentProbe = { id, submittedAt: at };
        clearTimer(probeTimeoutTimer);
        probeTimeoutTimer = clock.setTimeout(() => {
            probeTimeoutTimer = null;
            if (terminated) return;
            if (currentProbe !== null && currentProbe.id === id) settleExpiredProbe();
        }, limits.probe_timeout_ms);
    }

    function onReplyFrame(id: number): void {
        const at = clock.now();
        pruneProbeRecords(at);
        const index = probeRecords.findIndex((record) => record.id === id);
        // 结构合法但未发过、已被更新回应覆盖或超出保留期的 reply 直接忽略，不触发额外关闭。
        if (index === -1 || id <= acceptedReplyId) return;
        if (at - probeRecords[index].submittedAt >= limits.probe_record_age_ms) return;
        probeRecords.splice(0, index + 1);
        acceptedReplyId = id;
        lastValidReplyAt = at;
        probeFailures = 0;
        backlog = false;
        if (currentProbe && currentProbe.id === id) {
            currentProbe = null;
            clearTimer(probeTimeoutTimer);
            probeTimeoutTimer = null;
        }
        // 清除后重新检查尚存的本地积压。
        if (inflight || currentBlock || passthroughQueue.length > 0) markBacklog('post-reply-queue');
        restartLivenessFallback();
    }

    function restartLivenessFallback(): void {
        clearTimer(livenessTimer);
        livenessTimer = clock.setTimeout(() => {
            livenessTimer = null;
            if (!terminated) terminate('peer_unreachable', 'no valid liveness reply within the fallback window');
        }, limits.liveness_ms);
    }

    function evaluateLiveness(): void {
        if (terminated) return;
        const at = clock.now();
        if (backlog) return; // 有积压时不由三次失败提前关闭，等同一个 60 秒兜底。
        if (probeFailures >= limits.probe_failures && at - lastValidReplyAt >= limits.probe_quiet_ms) {
            terminate('peer_unreachable', 'three probe timeouts with no valid reply');
        }
    }

    // ------------------------------------------------------------------
    // 入站
    // ------------------------------------------------------------------

    function restartReceiveIdle(): void {
        clearTimer(receiveIdleTimer);
        receiveIdleTimer = clock.setTimeout(() => {
            receiveIdleTimer = null;
            if (!terminated) terminate('receive_stalled', 'reassembly made no progress');
        }, limits.receive_idle_ms);
    }

    function deliverUpstream(message: string): void {
        for (const listener of [...messageListeners]) {
            try {
                listener(message);
            } catch {
                // 上层监听器异常不改变本层状态；失败由上层自己的出口处理。
            }
        }
    }

    /** 严格校验并推进重组；返回 false 表示已按 §6.5 收敛。 */
    function consumeDataFrame(frame: Extract<DataChannelFrame, { type: 'data' }>): boolean {
        if (frame.total > limits.message_bytes) {
            terminate('message_too_large', 'declared total exceeds the message limit');
            return false;
        }
        if (reassembly === null) {
            if (frame.offset !== 0 || frame.id !== expectedInboundMessageSeq) {
                terminate('invalid_frame', 'unexpected new message header');
                return false;
            }
            reassembly = { id: frame.id, total: frame.total, received: 0, buffer: new Uint8Array(frame.total) };
        } else if (
            frame.id !== reassembly.id ||
            frame.total !== reassembly.total ||
            frame.offset !== reassembly.received
        ) {
            terminate('invalid_frame', 'block does not continue the current reassembly');
            return false;
        }
        const decoded = decodeCanonicalBase64(frame.data);
        if (decoded === null) {
            terminate('invalid_frame', 'data is not canonical base64');
            return false;
        }
        if (reassembly.received + decoded.length > reassembly.total) {
            terminate('invalid_frame', 'block exceeds the declared total');
            return false;
        }
        reassembly.buffer.set(decoded, reassembly.received);
        reassembly.received += decoded.length;
        if (reassembly.received < reassembly.total) {
            restartReceiveIdle();
            return true;
        }
        let message: string;
        try {
            message = strictDecoder.decode(reassembly.buffer);
        } catch {
            terminate('invalid_frame', 'reassembled bytes are not valid utf-8');
            return false;
        }
        reassembly = null;
        clearTimer(receiveIdleTimer);
        receiveIdleTimer = null;
        expectedInboundMessageSeq += 1;
        deliverUpstream(message);
        return true;
    }

    /**
     * 单帧消费：校验 → 写入重组（末片则交付）→ 释放该原始帧并取得真实释放完成回报。
     * 只有释放已完成，才累计可回报序号。
     */
    async function processRawEntry(entry: RawChannelEntry): Promise<void> {
        let countsAsData = false;
        if (!activated) {
            // 可信激活前只允许信令的有界握手，其格式/阶段/长度由信令自己校验；
            // 本层只受原始桥预算约束，不另设一套数据通道限制。
            deliverUpstream(entry.text);
            // 看见最终控制帧的类型只暂停处理后续原始事件，不构成激活。
            if (looksLikeFinalControl(entry.text)) barrier = true;
        } else {
            if (entry.bytes > inboundFrameCap) {
                terminate('invalid_frame', 'frame exceeds the inbound frame cap');
                return;
            }
            const frame = decodeDataChannelFrame(entry.text);
            if (frame === null) {
                terminate('invalid_frame', 'frame failed strict decoding');
                return;
            }
            if (frame.type !== 'data' && entry.bytes > limits.control_frame_bytes) {
                terminate('invalid_frame', 'control frame exceeds its limit');
                return;
            }
            switch (frame.type) {
                case 'data':
                    if (!consumeDataFrame(frame)) return;
                    countsAsData = true;
                    markBacklog('inbound-data');
                    break;
                case 'probe':
                    // 新合法探测可替换尚未提交的旧回应；在途参数不变。
                    pendingReply = pendingReply === null ? frame.id : Math.max(pendingReply, frame.id);
                    if (frame.id > acceptedReplyId) markBacklog('inbound-probe');
                    pump();
                    break;
                case 'reply':
                    onReplyFrame(frame.id);
                    break;
                case 'consumed':
                    onConsumedFrame(frame.seq);
                    break;
            }
        }

        let released = false;
        try {
            released = await raw.release(entry.entryId);
        } catch {
            terminate('transport_contract_violation', 'raw release failed');
            return;
        }
        if (terminated) return;
        if (!released) {
            terminate('transport_contract_violation', 'raw release was not acknowledged');
            return;
        }
        if (countsAsData) {
            if (consumedInboundDataSeq >= Number.MAX_SAFE_INTEGER) {
                terminate('transport_contract_violation', 'inbound data sequence exhausted');
                return;
            }
            consumedInboundDataSeq += 1;
            pendingConsumed = consumedInboundDataSeq;
            pump();
        }
    }

    /** 只 peek 类型以决定暂停，不做任何权威判定；信令保持全部格式/阶段/指纹/许可校验。 */
    function looksLikeFinalControl(text: string): boolean {
        try {
            const parsed = JSON.parse(text) as Record<string, unknown>;
            return !!parsed && typeof parsed === 'object' && parsed.type === options.finalControlType;
        } catch {
            return false;
        }
    }

    async function drainRawEntries(): Promise<void> {
        if (processingRaw) return;
        processingRaw = true;
        try {
            while (!terminated && heldRawEntries.length > 0) {
                if (barrier && !activated) break;
                const entry = heldRawEntries.shift()!;
                await processRawEntry(entry);
            }
        } finally {
            processingRaw = false;
        }
    }

    if (raw.onDrain) disposers.push(raw.onDrain(() => wakeForDrain()));
    disposers.push(
        raw.onRaw((entry) => {
            if (terminated) return;
            heldRawEntries.push(entry);
            void drainRawEntries();
        }),
        raw.onOverflow(() => {
            terminate('receive_capacity_exceeded', 'raw bridge entry budget exceeded');
        }),
        raw.onClosed(() => {
            terminate(null);
        })
    );

    // ------------------------------------------------------------------
    // 对上层的公共合同
    // ------------------------------------------------------------------

    function sendPassthrough(message: string): Promise<void> {
        // 数据通道层内不新增无界队列。可信激活前只有信令的有界握手会经过这里，
        // 上层是 await 后再发下一条，因此正常路径上队列深度为 1。
        if (passthroughQueue.length >= limits.control_queue_depth) {
            terminate('transport_contract_violation', 'handshake passthrough queue overflow');
            return Promise.reject(
                new DataChannelError('transport_contract_violation', 'handshake passthrough queue overflow')
            );
        }
        return new Promise<void>((resolve, reject) => {
            passthroughQueue.push({ text: message, resolve, reject });
            pump();
        });
    }

    function sendBusiness(message: string): Promise<void> {
        if (currentSend) {
            // 单业务写入者：前次未结束时再次直接调用属于接线违约，关闭并拒绝两个调用。
            terminate('transport_contract_violation', 'concurrent business send');
            return Promise.reject(new DataChannelError('transport_contract_violation', 'concurrent business send'));
        }
        const bytes = encoder.encode(message);
        if (bytes.length > limits.message_bytes) {
            terminate('message_too_large', 'outbound message exceeds the message limit');
            return Promise.reject(new DataChannelError('message_too_large', 'outbound message too large'));
        }
        if (bytes.length === 0) {
            return Promise.reject(new DataChannelError('invalid_frame', 'empty outbound message'));
        }
        if (outboundMessageSeq >= Number.MAX_SAFE_INTEGER) {
            terminate('transport_contract_violation', 'outbound message sequence exhausted');
            return Promise.reject(new DataChannelError('transport_contract_violation', 'sequence exhausted'));
        }
        outboundMessageSeq += 1;
        return new Promise<void>((resolve, reject) => {
            currentSend = {
                bytes,
                total: bytes.length,
                offset: 0,
                id: outboundMessageSeq,
                resolve,
                reject
            };
            pump();
        });
    }

    const channel: AcpMessageChannel = {
        send(message: string) {
            if (terminated) {
                return Promise.reject(
                    terminationError ?? new DataChannelError('transport_send_failed', 'channel closed')
                );
            }
            return activated ? sendBusiness(message) : sendPassthrough(message);
        },
        onMessage(listener) {
            if (!terminated) messageListeners.add(listener);
            return () => {
                messageListeners.delete(listener);
            };
        },
        onClose(listener) {
            if (closeEmitted) listener(terminationError ?? undefined);
            else closeListeners.add(listener);
            return () => {
                closeListeners.delete(listener);
            };
        },
        close() {
            terminate(null);
        }
    };

    return {
        channel,
        get activated() {
            return activated;
        },
        activateTrusted() {
            if (terminated) throw new DataChannelError('transport_contract_violation', 'activate after close');
            if (activated) return; // 同实例重复调用不重置存活基点。
            const verified = raw.maxMessageBytes();
            if (verified !== null && (!Number.isSafeInteger(verified) || verified < 1))
                throw new DataChannelError('transport_contract_violation', 'invalid verified send limit');
            frameCap = Math.min(limits.frame_bytes, verified ?? limits.frame_bytes);
            activated = true;
            barrier = false;
            lastValidReplyAt = clock.now();
            restartLivenessFallback();
            scheduleProbe();
            void drainRawEntries();
            pump();
        },
        close(reason?: DataChannelErrorCode) {
            terminate(reason ?? null);
            return closedPromise;
        },
        closed: closedPromise,
        inspect: snapshot
    };
}

/**
 * Spec §5.4：从信令交付的合格 turn/UDP 条目派生同地址的无凭据 STUN 条目。
 *
 * 来源条件按 URI 声明判定：scheme 必须是 turn（不是 turns），transport 必须是 udp 或未指定。
 * 大小写不敏感归一化后判断，不做字符串盲替换；正确处理 IPv6 方括号与默认端口。
 * 派生结果只是数据通道的本地运行时配置，不回传信令、不放入 turn.urls、不加入第三方地址。
 */
export function deriveStunServers(
    iceServers: Array<{ urls: string[]; username: string; credential: string }>,
    limit = 4
): string[] {
    const derived: string[] = [];
    const seen = new Set<string>();
    for (const entry of iceServers) {
        for (const url of entry.urls) {
            const parsed = parseTurnUri(url);
            if (!parsed) continue;
            if (parsed.scheme !== 'turn') continue; // turns 不参与明文 STUN 派生
            if (parsed.transport !== null && parsed.transport !== 'udp') continue;
            const stun = `stun:${parsed.host}:${parsed.port}`;
            if (seen.has(stun)) continue;
            seen.add(stun);
            derived.push(stun);
            if (derived.length >= limit) return derived;
        }
    }
    return derived;
}

/** 按 RFC 7065 解析 TURN URI；scheme/transport 大小写不敏感，默认端口 turn:3478 / turns:5349。 */
export function parseTurnUri(
    value: string
): { scheme: 'turn' | 'turns'; host: string; port: number; transport: 'udp' | 'tcp' | null } | null {
    // Spec §5.4：scheme、transport 参数名和值都按大小写不敏感归一化后判断，
    // 因此正则必须带 i 标志；缺了它 `TURN:...?TRANSPORT=UDP` 会被整条丢弃。
    const match = /^(turns?):(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?(?:\?(.*))?$/i.exec(value);
    if (!match) return null;
    const scheme = match[1].toLowerCase() as 'turn' | 'turns';
    const host = match[2];
    const port = match[3] ? Number(match[3]) : scheme === 'turn' ? 3478 : 5349;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    let transport: 'udp' | 'tcp' | null = null;
    if (match[4]) {
        for (const pair of match[4].split('&')) {
            const index = pair.indexOf('=');
            if (index < 0) continue;
            if (pair.slice(0, index).toLowerCase() !== 'transport') continue;
            const raw = pair.slice(index + 1).toLowerCase();
            if (raw !== 'udp' && raw !== 'tcp') return null;
            transport = raw;
        }
    }
    return { scheme, host, port, transport };
}

// ===========================================================================
// Electron 宿主桥：main 侧
//
// main 持有协议核心与全部预算，renderer 只操作本实例的 Chromium 对象并如实回报。
// 平台对象由 main 注入，协议核心不接触 Electron 或 IPC；纯算法可由 node:test 直接测。
// ===========================================================================

/** renderer 事件的发送者身份。main 用它拒绝子 frame / webview 的伪造输入。 */
export interface DesktopEventSender {
    webContentsId: number;
    frameRoutingId: number | null;
}

/** main 与 renderer 之间的受控通道。由 Electron 装配侧实现，测试注入替身。 */
export interface DesktopRendererPort {
    readonly owner: NetworkHostOwner;
    /** Electron 私有发送者校验，不能由公共 owner 字符串代替。 */
    readonly webContentsId: number;
    /** 主 frame 的 routing id；null 表示尚未就绪。 */
    mainFrameRoutingId(): number | null;
    invoke(method: string, payload: Record<string, unknown>): Promise<unknown>;
    onEvent(listener: (sender: DesktopEventSender, payload: Record<string, unknown>) => void): () => void;
}

export interface DesktopBridgeOptions {
    port: DesktopRendererPort;
    clock?: Partial<DataChannelClock>;
    diagnose?(event: { code: string; detail?: string }): void;
}

interface RendererCreateResult {
    instanceId: string;
    maxMessageBytes: number | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * 构造 ConnectionRuntimeOptions['bridge'] 的真实实现。
 * 信令只看到 DesktopNetworkTransport；数据通道的封装、额度与调度都在 main 的协议核心里。
 */
export function createDesktopNetworkBridge(options: DesktopBridgeOptions): {
    owner: NetworkHostOwner;
    create(input: {
        attemptId: string;
        signal: AbortSignal;
        iceServers: Array<{ urls: string[]; username: string; credential: string }>;
        candidate(payload: Record<string, unknown> | null): void;
    }): Promise<DesktopNetworkTransport>;
} {
    const port = options.port;
    const diagnose = options.diagnose ?? (() => undefined);

    return {
        // 实时读取而不是创建时定格：导航/重载/销毁会让代次前进，信令在核验时读到的
        // owner 随之改变，旧代的 transport 因此比对失败而被拒绝。
        get owner() {
            return port.owner;
        },
        async create(input) {
            const owner = { ...port.owner };
            const generation = owner.generation;
            const ownerCurrent = () =>
                port.owner.hostInstanceId === owner.hostInstanceId && port.owner.generation === generation;
            const stunUrls = deriveStunServers(input.iceServers);
            const created = asRecord(
                await port.invoke('create', {
                    attemptId: input.attemptId,
                    generation,
                    // 原 TURN 条目仍使用本端临时凭据；派生的 STUN 条目不带凭据。
                    iceServers: input.iceServers,
                    stunUrls,
                    rawBridgeBytes: DATA_CHANNEL_LIMITS.raw_bridge_bytes,
                    rawBridgeFrames: DATA_CHANNEL_LIMITS.raw_bridge_frames
                })
            );
            if (!created || typeof created.instanceId !== 'string' || created.instanceId.length === 0)
                throw new Error('the remote network renderer did not create an instance');
            if (!ownerCurrent() || input.signal.aborted) {
                await port.invoke('close', { instanceId: created.instanceId, generation }).catch(() => undefined);
                throw new Error('remote network owner invalidated during create');
            }
            const result: RendererCreateResult = {
                instanceId: created.instanceId,
                maxMessageBytes:
                    typeof created.maxMessageBytes === 'number' && Number.isSafeInteger(created.maxMessageBytes)
                        ? created.maxMessageBytes
                        : null
            };
            const instance = { id: result.instanceId };
            // sctp.maxMessageSize 只有在描述交换完成后才有值，因此由 readback 带回并缓存；
            // 信令在核验阶段必定调用过 readback，G1 激活时该值已就绪。
            let verifiedSendLimit: number | null = result.maxMessageBytes;

            let openedResolve!: () => void;
            let openedReject!: (error: Error) => void;
            const opened = new Promise<void>((resolve, reject) => {
                openedResolve = resolve;
                openedReject = reject;
            });
            // 未被消费的 opened 拒绝不应变成未处理拒绝；真实失败仍由 closed/上层出口表达。
            void opened.catch(() => undefined);

            const rawListeners = new Set<(entry: RawChannelEntry) => void>();
            const overflowListeners = new Set<() => void>();
            const closedListeners = new Set<() => void>();
            const drainListeners = new Set<() => void>();
            let rendererClosed = false;

            /**
             * 只接受来自本实例、本代、授权 webContents 主 frame 的事件。
             * 业务页面或其他 webview 不能伪造 readback / 提交结果 / 原始帧。
             */
            const disposeEvents = port.onEvent((sender, payload) => {
                if (!ownerCurrent() || rendererClosed || input.signal.aborted) return;
                if (sender.webContentsId !== port.webContentsId) return;
                const mainFrame = port.mainFrameRoutingId();
                if (mainFrame !== null && sender.frameRoutingId !== null && sender.frameRoutingId !== mainFrame) {
                    diagnose({ code: 'data_channel_bridge_frame_rejected' });
                    return;
                }
                if (payload.instanceId !== result.instanceId) return;
                if (payload.generation !== generation) {
                    diagnose({ code: 'data_channel_bridge_generation_rejected' });
                    return;
                }
                switch (payload.kind) {
                    case 'opened':
                        openedResolve();
                        break;
                    case 'candidate':
                        input.candidate((asRecord(payload.candidate) ?? null) as Record<string, unknown> | null);
                        break;
                    case 'candidateDropped':
                        diagnose({
                            code: 'data_channel_candidate_dropped',
                            detail: typeof payload.reason === 'string' ? payload.reason : 'unknown'
                        });
                        break;
                    case 'raw': {
                        const entryId = payload.entryId;
                        const text = payload.text;
                        const bytes = payload.bytes;
                        if (
                            typeof entryId !== 'number' ||
                            !Number.isSafeInteger(entryId) ||
                            typeof text !== 'string' ||
                            typeof bytes !== 'number' ||
                            !Number.isSafeInteger(bytes)
                        ) {
                            diagnose({ code: 'data_channel_bridge_invalid_raw' });
                            return;
                        }
                        for (const listener of rawListeners) listener({ entryId, text, bytes });
                        break;
                    }
                    case 'drain':
                        for (const listener of drainListeners) listener();
                        break;
                    case 'overflow':
                        for (const listener of overflowListeners) listener();
                        break;
                    case 'closed': {
                        rendererClosed = true;
                        // 关闭来源是排障的关键信息：没有它，main 侧只看得到一个无因由的关闭。
                        const reason = typeof payload.reason === 'string' ? payload.reason : 'unknown';
                        diagnose({ code: 'data_channel_instance_closed', detail: reason });
                        openedReject(new Error('the data channel instance closed before opening'));
                        for (const listener of closedListeners) listener();
                        break;
                    }
                }
            });

            const raw: RawDataChannel = {
                async submit(text, windowLimit) {
                    if (rendererClosed) return { status: 'failed', reason: 'closed' };
                    const value = asRecord(
                        await port.invoke('submit', {
                            instanceId: result.instanceId,
                            generation,
                            text,
                            windowLimit
                        })
                    );
                    if (!value) return { status: 'failed', reason: 'invalid_result' };
                    const buffered =
                        typeof value.bufferedAmount === 'number' && Number.isSafeInteger(value.bufferedAmount)
                            ? value.bufferedAmount
                            : 0;
                    if (value.status === 'accepted') return { status: 'accepted', bufferedAmount: buffered };
                    if (value.status === 'blocked') return { status: 'blocked', bufferedAmount: buffered };
                    return {
                        status: 'failed',
                        reason: typeof value.reason === 'string' ? value.reason : 'unknown'
                    };
                },
                async release(entryId) {
                    if (rendererClosed) return false;
                    const value = asRecord(
                        await port.invoke('release', { instanceId: result.instanceId, generation, entryId })
                    );
                    return value?.released === true;
                },
                onRaw(listener) {
                    rawListeners.add(listener);
                    return () => rawListeners.delete(listener);
                },
                onOverflow(listener) {
                    overflowListeners.add(listener);
                    return () => overflowListeners.delete(listener);
                },
                onClosed(listener) {
                    if (rendererClosed) listener();
                    else closedListeners.add(listener);
                    return () => closedListeners.delete(listener);
                },
                onDrain(listener) {
                    drainListeners.add(listener);
                    return () => drainListeners.delete(listener);
                },
                maxMessageBytes: () => verifiedSendLimit,
                async close() {
                    await port.invoke('close', { instanceId: result.instanceId, generation }).catch(() => undefined);
                }
            };

            const dataChannel = createDataChannel({
                raw,
                clock: options.clock,
                finalControlType: 'ready_ack',
                diagnose: (event) => diagnose({ code: `data_channel_${event.code}`, detail: event.detail })
            });

            const transport: DesktopNetworkTransport = {
                instance,
                owner,
                channel: dataChannel.channel,
                opened,
                closed: dataChannel.closed,
                async answer(sdp) {
                    const value = asRecord(
                        await port.invoke('answer', { instanceId: result.instanceId, generation, sdp })
                    );
                    if (!value || typeof value.sdp !== 'string')
                        throw new Error('the remote network renderer returned no answer');
                    return value.sdp;
                },
                async addCandidate(payload) {
                    await port.invoke('addCandidate', {
                        instanceId: result.instanceId,
                        generation,
                        candidate: payload
                    });
                },
                async readback() {
                    const value = asRecord(
                        await port.invoke('readback', { instanceId: result.instanceId, generation })
                    );
                    if (!value) throw new Error('the remote network renderer returned no readback');
                    if (!ownerCurrent() || input.signal.aborted) throw new Error('remote network owner invalidated');
                    const state = value.state;
                    if (state !== 'open' && state !== 'connecting' && state !== 'closed')
                        throw new Error('the remote network renderer returned an invalid state');
                    if (typeof value.maxMessageBytes === 'number' && Number.isSafeInteger(value.maxMessageBytes))
                        verifiedSendLimit = value.maxMessageBytes;
                    // 读回必须来自应用成功后的本实例；此处只接受本实例句柄与本实例 channel，
                    // 不接受提交入参、缓存成功值或外部自报的替代物。
                    return {
                        instance,
                        owner,
                        channel: dataChannel.channel,
                        state,
                        stable: value.stable === true,
                        localDescription: typeof value.localDescription === 'string' ? value.localDescription : null,
                        remoteDescription: typeof value.remoteDescription === 'string' ? value.remoteDescription : null
                    };
                },
                activateTrusted() {
                    if (!ownerCurrent() || input.signal.aborted) throw new Error('remote network owner invalidated');
                    dataChannel.activateTrusted();
                },
                async close() {
                    disposeEvents();
                    await dataChannel.close();
                }
            };

            input.signal.addEventListener('abort', () => void transport.close().catch(() => undefined), {
                once: true
            });
            return transport;
        }
    };
}
