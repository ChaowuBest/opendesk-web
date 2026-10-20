import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
    DATA_CHANNEL_LIMITS,
    DataChannelError,
    createDataChannel,
    decodeCanonicalBase64,
    decodeDataChannelFrame,
    encodeDataFrame,
    dataHeaderBytes,
    planDataBlock,
    utf8Length,
    type DataChannel,
    type RawDataChannel,
    type RawChannelEntry,
    type RawChannelSubmitResult
} from '../../../../main/applications/mobileaccess/remote-access/webrtc-transport.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, 'fixtures/n3-channel-v1.json'), 'utf8'));

for (const mode of ['LF', 'CRLF', 'missing marker', 'duplicate marker']) {
    test(`manual transport derivation protects the Mobile adapter: ${mode}`, () => {
        const root = mkdtempSync(join(tmpdir(), 'opendesk-derive-'));
        try {
            const file = join(root, 'src/features/remote/connection/webrtc-transport.ts');
            mkdirSync(dirname(file), { recursive: true });
            const eol = mode === 'CRLF' ? '\r\n' : '\n';
            const marker = [
                '// ===== 以上为从 PC 维护源机械派生的协议核心，请勿手改 =====',
                '// ===== 以下为手写的 RN 平台适配，重新派生时原样保留 =====', ''
            ].join(eol);
            const adapter = Buffer.from('// 手机专用' + eol + 'const handWritten = true;');
            const prefix = mode === 'missing marker' ? '' : marker.repeat(mode === 'duplicate marker' ? 2 : 1);
            const before = Buffer.concat([Buffer.from('old core' + eol + prefix), adapter]);
            writeFileSync(file, before);
            const script = join(here, '../../../../main/applications/mobileaccess/scripts/derive-mobile-webrtc-transport.mjs');
            const result = spawnSync(process.execPath, [script, '--mobile-root', root], { encoding: 'utf8' });
            const after = readFileSync(file);
            if (mode === 'missing marker' || mode === 'duplicate marker') {
                assert.notEqual(result.status, 0);
                assert.match(result.stderr, /分界标记/);
                assert.deepEqual(after, before);
            } else {
                assert.equal(result.status, 0, result.stderr);
                const boundary = after.indexOf(Buffer.from(marker));
                assert.notEqual(boundary, -1);
                assert.match(after.subarray(0, boundary).toString(), /DATA_CHANNEL_LIMITS/);
                assert.deepEqual(after.subarray(boundary + Buffer.byteLength(marker)), adapter);
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
}

// ---------------------------------------------------------------------------
// 可控时钟：单调时间由测试推进，不使用真实定时器。
// ---------------------------------------------------------------------------
interface Timer {
    id: number;
    at: number;
    callback: () => void;
    cancelled: boolean;
}

function createClock() {
    let now = 0;
    let nextId = 1;
    const timers: Timer[] = [];
    return {
        now: () => now,
        setTimeout(callback: () => void, delay: number) {
            const timer: Timer = { id: nextId++, at: now + delay, callback, cancelled: false };
            timers.push(timer);
            return timer.id;
        },
        clearTimeout(handle: unknown) {
            const timer = timers.find((entry) => entry.id === handle);
            if (timer) timer.cancelled = true;
        },
        /** 推进到 target，按到期顺序结算；同刻多个定时器按注册顺序。 */
        async advance(ms: number) {
            const target = now + ms;
            for (;;) {
                const due = timers
                    .filter((timer) => !timer.cancelled && timer.at <= target)
                    .sort((a, b) => a.at - b.at || a.id - b.id)[0];
                if (!due) break;
                now = due.at;
                due.cancelled = true;
                timers.splice(timers.indexOf(due), 1);
                due.callback();
                await flush();
            }
            now = target;
            await flush();
        },
        pending: () => timers.filter((timer) => !timer.cancelled).length
    };
}

/** 排空微任务与 setImmediate，让异步 submit/release 的链条跑完。 */
async function flush(rounds = 12): Promise<void> {
    for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// 可控原始通道：按实际字节维护有序 FIFO、真实 bufferedAmount 与单在途释放。
// ---------------------------------------------------------------------------
interface FakeRawOptions {
    maxMessageBytes?: number | null;
    /** 每次 submit 之后是否立即排空；false 表示由测试显式 drain。 */
    autoDrain?: boolean;
    /** 释放回报延迟到测试显式调用。 */
    manualRelease?: boolean;
    onSubmit?(text: string): void;
}

function createFakeRaw(options: FakeRawOptions = {}) {
    const autoDrain = options.autoDrain ?? true;
    const rawListeners = new Set<(entry: RawChannelEntry) => void>();
    const overflowListeners = new Set<() => void>();
    const closedListeners = new Set<() => void>();
    const submitted: string[] = [];
    let bufferedAmount = 0;
    let closed = false;
    let nextEntryId = 1;
    let failNext: string | null = null;
    let violateNext: string | null = null;
    let outstandingBytes = 0;
    let outstandingFrames = 0;
    const pendingReleases = new Map<number, () => void>();
    const deliveredEntries = new Set<number>();

    const channel: RawDataChannel = {
        async submit(text: string, windowLimit: number): Promise<RawChannelSubmitResult> {
            if (closed) return { status: 'failed', reason: 'closed' };
            if (failNext) {
                const reason = failNext;
                failNext = null;
                return { status: 'failed', reason };
            }
            if (violateNext) {
                const reason = violateNext;
                violateNext = null;
                return { status: 'contract_violation', reason };
            }
            const bytes = utf8Length(text);
            if (bufferedAmount + bytes > windowLimit) return { status: 'blocked', bufferedAmount };
            bufferedAmount += bytes;
            submitted.push(text);
            options.onSubmit?.(text);
            if (autoDrain) bufferedAmount -= bytes;
            return { status: 'accepted', bufferedAmount };
        },
        async release(entryId: number): Promise<boolean> {
            if (!deliveredEntries.has(entryId)) return false;
            if (options.manualRelease) {
                await new Promise<void>((resolve) => pendingReleases.set(entryId, resolve));
            }
            deliveredEntries.delete(entryId);
            outstandingFrames -= 1;
            return true;
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
            closedListeners.add(listener);
            return () => closedListeners.delete(listener);
        },
        maxMessageBytes: () => options.maxMessageBytes ?? null,
        async close() {
            closed = true;
        }
    };

    return {
        channel,
        submitted,
        get bufferedAmount() {
            return bufferedAmount;
        },
        get outstandingFrames() {
            return outstandingFrames;
        },
        get closed() {
            return closed;
        },
        /** 模拟原生把一条原始条目投递到 JS；返回其 entryId。 */
        deliver(text: string): number {
            const entryId = nextEntryId++;
            const bytes = utf8Length(text);
            outstandingBytes += bytes;
            outstandingFrames += 1;
            deliveredEntries.add(entryId);
            for (const listener of rawListeners) listener({ entryId, text, bytes });
            return entryId;
        },
        completeRelease(entryId: number) {
            pendingReleases.get(entryId)?.();
            pendingReleases.delete(entryId);
        },
        pendingReleaseCount: () => pendingReleases.size,
        overflow() {
            for (const listener of overflowListeners) listener();
        },
        remoteClose() {
            for (const listener of closedListeners) listener();
        },
        failNextSubmit(reason: string) {
            failNext = reason;
        },
        /** 原生提交点报告：区间内有别的本地发送插入（单写入者合同被破坏）。 */
        violateNextSubmit(reason: string) {
            violateNext = reason;
        },
        /** 手动排空已提交字节，模拟原生缓冲下降。 */
        drain(bytes = Number.POSITIVE_INFINITY) {
            bufferedAmount = Math.max(0, bufferedAmount - bytes);
        },
        setBuffered(value: number) {
            bufferedAmount = value;
        }
    };
}

interface Harness {
    raw: ReturnType<typeof createFakeRaw>;
    clock: ReturnType<typeof createClock>;
    channel: DataChannel;
    messages: string[];
    closes: Array<Error | undefined>;
    diagnostics: Array<{ code: string; detail?: string }>;
}

function createHarness(
    rawOptions: FakeRawOptions = {},
    finalControlType: 'ready_ack' | 'ready' = 'ready_ack',
    harnessOptions: { autoReplyProbes?: boolean } = {}
): Harness {
    let deliverBack: ((text: string) => number) | null = null;
    const raw = createFakeRaw({
        ...rawOptions,
        onSubmit(text) {
            rawOptions.onSubmit?.(text);
            if (!harnessOptions.autoReplyProbes) return;
            let frame: { type?: string; id?: number };
            try {
                frame = JSON.parse(text);
            } catch {
                return;
            }
            // 对端立刻回应探测，使存活始终健康，从而把发送/接收期限单独隔离出来测。
            if (frame.type === 'probe' && typeof frame.id === 'number') {
                const id = frame.id;
                setImmediate(() => deliverBack?.(JSON.stringify({ n3: 1, type: 'reply', id })));
            }
        }
    });
    deliverBack = raw.deliver;
    const clock = createClock();
    const messages: string[] = [];
    const closes: Array<Error | undefined> = [];
    const diagnostics: Array<{ code: string; detail?: string }> = [];
    const channel = createDataChannel({
        raw: raw.channel,
        clock,
        finalControlType,
        diagnose: (event) => diagnostics.push(event)
    });
    channel.channel.onMessage((message) => messages.push(message));
    channel.channel.onClose((error) => closes.push(error));
    return { raw, clock, channel, messages, closes, diagnostics };
}

/** 跳过可信激活之前的直通阶段，让测试直接进入数据通道调度。 */
async function activate(harness: Harness): Promise<void> {
    harness.channel.activateTrusted();
    await flush();
}

// ===========================================================================
describe('n3-channel-v1 帧编解码', () => {
    test('fixture 的全部非法帧都被严格拒绝，且拒绝层次与 stage 标注一致', () => {
        const decodeStage = fixture.invalid_frames.filter((e: any) => e.stage === 'decode');
        for (const entry of decodeStage) {
            assert.equal(decodeDataChannelFrame(entry.raw), null, `${entry.name} 应当被解码层拒绝`);
            assert.equal(entry.reason, 'invalid_frame');
        }
        const semanticStage = fixture.invalid_frames.filter((e: any) => e.stage === 'semantic');
        for (const entry of semanticStage) {
            // 结构合法，由重组/容量检查按各自 reason 收敛。
            assert.notEqual(decodeDataChannelFrame(entry.raw), null, `${entry.name} 结构上应当合法`);
        }
        assert.equal(
            decodeStage.length + semanticStage.length,
            fixture.invalid_frames.length,
            '每条反例都必须标注 stage'
        );
        assert.ok(decodeStage.length >= 21, `解码层反例只有 ${decodeStage.length} 条`);
        assert.equal(semanticStage.length, 2);
    });

    test('语义层反例在真实通道上按各自分类收敛', async () => {
        for (const entry of fixture.invalid_frames.filter((e: any) => e.stage === 'semantic')) {
            const h = createHarness();
            await activate(h);
            h.raw.deliver(entry.raw);
            await flush(20);
            assert.equal(h.closes.length, 1, `${entry.name} 应当关闭`);
            assert.equal((h.closes[0] as DataChannelError).code, entry.reason, entry.name);
        }
    });

    test('fixture 的控制帧字节与实现一致', () => {
        for (const entry of fixture.control_frames) {
            assert.equal(JSON.stringify(entry.frame), entry.serialized, entry.name);
            assert.equal(utf8Length(entry.serialized), entry.bytes, entry.name);
            assert.deepEqual(decodeDataChannelFrame(entry.serialized), entry.frame, entry.name);
            assert.ok(entry.bytes <= DATA_CHANNEL_LIMITS.control_frame_bytes, `${entry.name} 超出控制帧上限`);
        }
    });

    test('data 头部字节的可达上下界与 fixture 一致', () => {
        const min = fixture.data_header_bytes.min;
        const max = fixture.data_header_bytes.max;
        assert.equal(dataHeaderBytes(min.id, min.total, min.offset), min.bytes);
        assert.equal(dataHeaderBytes(max.id, max.total, max.offset), max.bytes);
        assert.equal(min.bytes, 60);
        assert.equal(max.bytes, 89);
    });

    test('规范 Base64：非零填充位与 URL-safe 变体都被拒绝', () => {
        assert.deepEqual(decodeCanonicalBase64('aGVsbG8='), new Uint8Array(Buffer.from('hello')));
        assert.equal(decodeCanonicalBase64('AB=='), null, '非零填充位必须拒绝');
        assert.equal(decodeCanonicalBase64('-_8='), null, 'URL-safe 字母表必须拒绝');
        assert.equal(decodeCanonicalBase64('aGVsbG8'), null, '长度非 4 的倍数必须拒绝');
        assert.equal(decodeCanonicalBase64(''), null);
        assert.equal(decodeCanonicalBase64('aGVs bG8='), null, '空白必须拒绝');
    });

    test('分块算法逐块复现 fixture 的全部向量', () => {
        for (const vector of fixture.chunking) {
            const bytes = new TextEncoder().encode(vector.message);
            assert.equal(bytes.length, vector.message_bytes, vector.name);
            let offset = 0;
            for (const expected of vector.blocks) {
                const plan = planDataBlock(vector.id, vector.message_bytes, offset, vector.frame_cap);
                assert.ok(plan, `${vector.name} offset=${offset} 应当能规划出一个块`);
                assert.equal(plan!.rawBytes, expected.raw_bytes, `${vector.name} offset=${offset} 原始字节`);
                const slice = bytes.subarray(offset, offset + plan!.rawBytes);
                const text = encodeDataFrame(
                    vector.id,
                    vector.message_bytes,
                    offset,
                    Buffer.from(slice).toString('base64')
                );
                assert.equal(text, expected.serialized, `${vector.name} offset=${offset} 序列化`);
                assert.equal(utf8Length(text), expected.bytes, `${vector.name} offset=${offset} 字节`);
                assert.ok(utf8Length(text) <= vector.frame_cap, `${vector.name} 超出帧上限`);
                offset += plan!.rawBytes;
            }
            assert.equal(offset, vector.message_bytes, `${vector.name} 未覆盖完整消息`);
        }
    });

    test('中文与 emoji 向量确实切开了多字节码点', () => {
        const chinese = fixture.chunking.find((v: any) => v.name === 'chinese_across_blocks');
        const emoji = fixture.chunking.find((v: any) => v.name === 'emoji_across_blocks');
        assert.equal(chinese.splits_code_point, true);
        assert.equal(emoji.splits_code_point, true);
        assert.ok(chinese.blocks.some((b: any) => !b.standalone_decodable));
        assert.ok(emoji.blocks.some((b: any) => !b.standalone_decodable));
    });
});

// ===========================================================================
describe('G1 可信激活与阶段屏障', () => {
    test('激活前直通信令握手文字，不做数据通道封装', async () => {
        const h = createHarness();
        const sent = h.channel.channel.send('{"type":"present_ticket"}');
        await flush();
        assert.deepEqual(h.raw.submitted, ['{"type":"present_ticket"}']);
        await sent;
        h.raw.deliver('{"type":"ticket_accepted"}');
        await flush();
        assert.deepEqual(h.messages, ['{"type":"ticket_accepted"}']);
    });

    test('交付最终控制帧后暂停处理后续原始输入，直到明确通知', async () => {
        const h = createHarness();
        h.raw.deliver('{"type":"ready_ack","attempt_id":"a"}');
        await flush();
        assert.deepEqual(h.messages, ['{"type":"ready_ack","attempt_id":"a"}']);

        // 紧随其后的首块业务必须被屏障挡住，不得在激活前解析。
        const block = encodeDataFrame(1, 5, 0, Buffer.from('hello').toString('base64'));
        h.raw.deliver(block);
        await flush();
        assert.equal(h.messages.length, 1, '激活前不得交付业务消息');
        assert.equal(h.channel.inspect().heldRawEntries, 1, '原始帧应当被挂起');

        await activate(h);
        assert.deepEqual(h.messages, ['{"type":"ready_ack","attempt_id":"a"}', 'hello']);
    });

    test('看见最终控制帧类型本身不构成激活', async () => {
        const h = createHarness();
        h.raw.deliver('{"type":"ready_ack"}');
        await flush();
        assert.equal(h.channel.activated, false);
    });

    test('重复激活不重置存活基点，也不清零计数', async () => {
        const h = createHarness();
        await activate(h);
        await h.clock.advance(25000);
        const before = h.channel.inspect();
        h.channel.activateTrusted();
        await flush();
        const after = h.channel.inspect();
        assert.equal(after.probeSeq, before.probeSeq);
        assert.equal(after.outboundMessageSeq, before.outboundMessageSeq);
    });

    test('关闭之后激活失败', async () => {
        const h = createHarness();
        await h.channel.close();
        assert.throws(() => h.channel.activateTrusted(), DataChannelError);
    });
});

// ===========================================================================
describe('分片、重组与顺序', () => {
    test('单块与多块消息完整往返，包含跨块多字节字符', async () => {
        const h = createHarness({ maxMessageBytes: 80 });
        await activate(h);
        const message = fixture.chunking.find((v: any) => v.name === 'chinese_across_blocks').message;
        const sent = h.channel.channel.send(message);
        await flush(40);
        await sent;
        // 把自己发出的帧原样喂回入站，验证两侧算法一致。
        const frames = [...h.raw.submitted];
        const rx = createHarness({ maxMessageBytes: 80 });
        await activate(rx);
        for (const frame of frames.filter((f) => JSON.parse(f).type === 'data')) {
            rx.raw.deliver(frame);
            await flush();
        }
        assert.deepEqual(rx.messages, [message]);
    });

    test('fixture 的顺序反例逐条按预期收敛或交付', async () => {
        for (const vector of fixture.sequencing) {
            const h = createHarness();
            await activate(h);
            // 含 consumed 的向量需要本端先真实发出过 data，否则该回报本身就是非法的未来编号。
            const needsOutbound = vector.frames.some((f: any) => f.type === 'consumed');
            if (needsOutbound) {
                await h.channel.channel.send('seed');
                await flush(20);
            }
            for (let index = 0; index < vector.frames.length; index += 1) {
                h.raw.deliver(JSON.stringify(vector.frames[index]));
                await flush();
                if (vector.reject_at === index) {
                    assert.equal(h.closes.length, 1, `${vector.name} 应当在第 ${index} 帧关闭`);
                    assert.equal((h.closes[0] as DataChannelError).code, vector.reason, `${vector.name} 错误分类`);
                }
            }
            if (vector.reject_at === null) {
                assert.equal(h.closes.length, 0, `${vector.name} 不应关闭`);
                if (vector.delivers) assert.deepEqual(h.messages, [vector.delivers], vector.name);
                if (vector.delivers_all) assert.deepEqual(h.messages, vector.delivers_all, vector.name);
            }
        }
    });

    test('期望接收序号只在完整消息交付后递增', async () => {
        const h = createHarness();
        await activate(h);
        assert.equal(h.channel.inspect().expectedInboundMessageSeq, 1);
        h.raw.deliver(encodeDataFrame(1, 6, 0, Buffer.from('abc').toString('base64')));
        await flush();
        assert.equal(h.channel.inspect().expectedInboundMessageSeq, 1, '未收齐不得递增');
        h.raw.deliver(encodeDataFrame(1, 6, 3, Buffer.from('def').toString('base64')));
        await flush();
        assert.equal(h.channel.inspect().expectedInboundMessageSeq, 2);
        assert.deepEqual(h.messages, ['abcdef']);
    });

    test('超过 64 MiB 的出站消息在提交前失败并关闭', async () => {
        const h = createHarness();
        await activate(h);
        const oversize = 'a'.repeat(DATA_CHANNEL_LIMITS.message_bytes + 1);
        await assert.rejects(h.channel.channel.send(oversize), (error: DataChannelError) => {
            assert.equal(error.code, 'message_too_large');
            return true;
        });
        assert.equal(h.raw.submitted.length, 0, '超限消息不得发出任何一块');
        assert.equal(h.closes.length, 1);
    });

    test('声明 total 超限的入站帧按 message_too_large 收敛', async () => {
        const h = createHarness();
        await activate(h);
        h.raw.deliver(
            encodeDataFrame(1, DATA_CHANNEL_LIMITS.message_bytes + 1, 0, Buffer.from('a').toString('base64'))
        );
        await flush();
        assert.equal((h.closes[0] as DataChannelError).code, 'message_too_large');
    });
});

// ===========================================================================
describe('单业务写入者', () => {
    test('前次 send 未结束时并发调用被识别为接线违约，两个调用都被拒绝', async () => {
        const h = createHarness({ autoDrain: false });
        await activate(h);
        h.raw.setBuffered(DATA_CHANNEL_LIMITS.send_window_bytes); // 让第一条卡住
        const first = h.channel.channel.send('first message');
        await flush();
        const second = h.channel.channel.send('second message');
        await assert.rejects(second, (error: DataChannelError) => {
            assert.equal(error.code, 'transport_contract_violation');
            return true;
        });
        await assert.rejects(first, (error: DataChannelError) => {
            assert.equal(error.code, 'transport_contract_violation');
            return true;
        });
        assert.equal(h.closes.length, 1, 'onClose 只发一次');
    });

    test('send 直到全部块受控提交完成才 resolve', async () => {
        const h = createHarness({ maxMessageBytes: 80, autoDrain: false });
        await activate(h);
        let settled = false;
        // 让窗口只剩一个块的余量：第一块进得去，其后必须等排空。
        h.raw.setBuffered(DATA_CHANNEL_LIMITS.send_window_bytes - 80 - 80);
        const message = 'abcdefghijklmnopqrstuvwxyz0123456789';
        const sent = h.channel.channel.send(message).then(() => {
            settled = true;
        });
        await flush(40);
        assert.equal(settled, false, '窗口不足时不得提前 resolve');
        const dataFrames = h.raw.submitted.filter((f) => JSON.parse(f).type === 'data').length;
        assert.ok(dataFrames >= 1, '第一块应当已提交');
        assert.ok(dataFrames < 3, `窗口不足时不应提交全部块，实际 ${dataFrames}`);
        h.raw.drain();
        await h.clock.advance(DATA_CHANNEL_LIMITS.drain_recheck_ms * 4);
        await flush(60);
        await sent;
        assert.equal(settled, true);
    });
});

// ===========================================================================
describe('对端消费额度与提前回报', () => {
    test('未取得回报时发送在 64 帧上界停住，收到 consumed 后继续', async () => {
        // 小帧上限让一条消息产生大量帧，从而先触及 64 帧而不是 4 MiB。
        const h = createHarness({ maxMessageBytes: 80 });
        await activate(h);
        const message = 'x'.repeat(12 * 100); // 每块 12 原始字节 -> 100 块
        let done = false;
        void h.channel.channel.send(message).then(() => {
            done = true;
        });
        await flush(400);
        const state = h.channel.inspect();
        assert.equal(state.outstandingPeerFrames, DATA_CHANNEL_LIMITS.peer_data_frames, '应当停在 64 帧');
        assert.equal(done, false);

        // 累计前缀回报释放额度。
        h.raw.deliver(JSON.stringify({ n3: 1, type: 'consumed', seq: 64 }));
        await flush(400);
        assert.ok(h.channel.inspect().outstandingPeerFrames <= DATA_CHANNEL_LIMITS.peer_data_frames);
        assert.ok(h.channel.inspect().acknowledgedConsumedSeq >= 64);
    });

    test('重复与更旧的 consumed 不二次释放', async () => {
        const h = createHarness({ maxMessageBytes: 80 });
        await activate(h);
        void h.channel.channel.send('x'.repeat(12 * 10));
        await flush(200);
        h.raw.deliver(JSON.stringify({ n3: 1, type: 'consumed', seq: 5 }));
        await flush(50);
        const after = h.channel.inspect().outstandingPeerBytes;
        h.raw.deliver(JSON.stringify({ n3: 1, type: 'consumed', seq: 5 }));
        h.raw.deliver(JSON.stringify({ n3: 1, type: 'consumed', seq: 3 }));
        await flush(50);
        assert.equal(h.channel.inspect().outstandingPeerBytes, after, '旧回报不得再次释放');
        assert.equal(h.channel.inspect().acknowledgedConsumedSeq, 5);
        assert.equal(h.closes.length, 0, '合法旧回报不是协议错误');
    });

    test('超过已发上界的 consumed 是非法回报，失败关闭', async () => {
        const h = createHarness();
        await activate(h);
        await h.channel.channel.send('hello');
        await flush();
        h.raw.deliver(JSON.stringify({ n3: 1, type: 'consumed', seq: 9999 }));
        await flush();
        assert.equal((h.closes[0] as DataChannelError).code, 'transport_contract_violation');
    });

    test('consumed 不因完整消息 send resolve 而清零额度', async () => {
        const h = createHarness();
        await activate(h);
        await h.channel.channel.send('hello');
        await flush(20);
        const state = h.channel.inspect();
        assert.equal(state.outstandingPeerFrames, 1, 'send 完成后额度记录仍保留');
        assert.ok(state.outstandingPeerBytes > 0);
    });
});

// ===========================================================================
describe('存活探测与积压判据', () => {
    test('无积压时连续三次超时且至少 30 秒无有效回应才关闭', async () => {
        const h = createHarness();
        await activate(h);
        await h.clock.advance(10000); // 提交探测 1
        assert.equal(h.channel.inspect().probeSeq, 1);
        await h.clock.advance(10000); // 探测 1 超时 + 提交探测 2
        await h.clock.advance(10000);
        await h.clock.advance(10000);
        assert.ok(h.channel.inspect().probeFailures >= 3, '应当累计三次失败');
        assert.equal(h.closes.length, 1);
        assert.equal((h.closes[0] as DataChannelError).code, 'peer_unreachable');
    });

    test('有效回应清零失败计数', async () => {
        const h = createHarness();
        await activate(h);
        await h.clock.advance(10000);
        const probeId = h.channel.inspect().probeSeq;
        await h.clock.advance(10000); // 一次失败
        assert.equal(h.channel.inspect().probeFailures, 1);
        h.raw.deliver(JSON.stringify({ n3: 1, type: 'reply', id: probeId }));
        await flush();
        assert.equal(h.channel.inspect().probeFailures, 0);
        assert.equal(h.closes.length, 0);
    });

    test('未发过、重复与已被覆盖的回应都被忽略，且不触发关闭', async () => {
        const h = createHarness();
        await activate(h);
        await h.clock.advance(10000);
        const first = h.channel.inspect().probeSeq;
        h.raw.deliver(JSON.stringify({ n3: 1, type: 'reply', id: 999 })); // 未发过
        await flush();
        assert.equal(h.closes.length, 0, '未发过的回应不是格式错误');
        h.raw.deliver(JSON.stringify({ n3: 1, type: 'reply', id: first }));
        await flush();
        h.raw.deliver(JSON.stringify({ n3: 1, type: 'reply', id: first })); // 重复
        await flush();
        assert.equal(h.closes.length, 0);
    });

    test('超出 60 秒保留期的迟到回应无效', async () => {
        const h = createHarness();
        await activate(h);
        await h.clock.advance(10000);
        const probeId = h.channel.inspect().probeSeq;
        await h.clock.advance(61000);
        const closedAlready = h.closes.length > 0;
        if (!closedAlready) {
            h.raw.deliver(JSON.stringify({ n3: 1, type: 'reply', id: probeId }));
            await flush();
        }
        // 无论走三次规则还是 60 秒兜底，过期回应都不能救活连接。
        assert.ok(h.closes.length >= 1);
    });

    test('探测记录最多保留 6 条', async () => {
        const h = createHarness();
        await activate(h);
        for (let i = 0; i < 5; i += 1) {
            await h.clock.advance(10000);
            const id = h.channel.inspect().probeSeq;
            h.raw.deliver(JSON.stringify({ n3: 1, type: 'reply', id }));
            await flush();
        }
        assert.ok(h.channel.inspect().probeRecords <= DATA_CHANNEL_LIMITS.probe_record_count);
    });

    test('收到对端 probe 时合并待发 reply 槽，不追加队列', async () => {
        const h = createHarness({ autoDrain: false });
        await activate(h);
        h.raw.setBuffered(DATA_CHANNEL_LIMITS.send_window_bytes);
        h.raw.deliver(JSON.stringify({ n3: 1, type: 'probe', id: 1 }));
        await flush();
        h.raw.deliver(JSON.stringify({ n3: 1, type: 'probe', id: 2 }));
        await flush();
        assert.equal(h.channel.inspect().pendingReply, 2, '待发槽应合并为最新编号');
    });
});

// ===========================================================================
describe('等待期限', () => {
    /**
     * 存活规则与发送/接收期限是三条独立期限。这些用例用自动回应把存活保持健康，
     * 从而单独隔离被测的那一条；不是为了凑满 60/90 秒而暂停正式关闭条件。
     */
    test('当前块阻塞满 60 秒后关闭，期间存活始终健康', async () => {
        // 窗口只剩 4 KiB：小控制帧仍能提交（探测/回应照常往返），整块 data 进不去。
        const headroom = 4096;
        const h = createHarness({ autoDrain: false }, 'ready_ack', { autoReplyProbes: true });
        await activate(h);
        h.raw.setBuffered(DATA_CHANNEL_LIMITS.send_window_bytes - DATA_CHANNEL_LIMITS.frame_bytes - headroom);
        void h.channel.channel.send('x'.repeat(DATA_CHANNEL_LIMITS.frame_bytes)).catch(() => undefined);
        await flush(40);
        await h.clock.advance(30000);
        assert.equal(h.closes.length, 0, '存活健康时不得提前关闭');
        assert.ok(h.channel.inspect().probeSeq >= 2, '期间探测应当仍在往返');
        await h.clock.advance(31000);
        assert.equal(h.closes.length, 1);
        assert.equal((h.closes[0] as DataChannelError).code, 'send_stalled');
    });

    test('控制帧一次 blocked 之后恢复、且此后没有业务数据，连接必须存活', async () => {
        // 回归：Spec §6.3 把这 60 秒定义为**当前块**的期限，「直到该块真正被本端
        // native 接受才结束」。控制帧自己的饥饿由 §7.1 的存活兜底收敛。
        // 若控制帧 blocked 也启动这个等待，它就永远没有对应的结束点——
        // 典型场景是刚发完一条大消息、原生缓冲仍接近满，探测被挡一次，
        // 随后缓冲排空、探测恢复正常往返，但业务侧空闲，60 秒后健康连接被误关。
        const h = createHarness({ autoDrain: false }, 'ready_ack', { autoReplyProbes: true });
        await activate(h);
        // 缓冲填到窗口上沿：连最小的控制帧也放不下。
        h.raw.setBuffered(DATA_CHANNEL_LIMITS.send_window_bytes - DATA_CHANNEL_LIMITS.frame_bytes);
        await h.clock.advance(DATA_CHANNEL_LIMITS.probe_interval_ms);
        await flush(20);
        const blockedProbes = h.raw.submitted.length;
        // 缓冲排空：此后所有提交都能成功，探测正常往返。
        h.raw.drain();
        await h.clock.advance(DATA_CHANNEL_LIMITS.send_block_ms + 5000);
        assert.ok(h.raw.submitted.length > blockedProbes, '排空后探测应当恢复提交');
        assert.equal(h.closes.length, 0, '控制帧被挡一次不得给一条其后健康、空闲的连接留下 send_stalled 计时');
        assert.equal(h.channel.inspect().terminated, false);
    });

    test('接收无进展满 90 秒后关闭，期间存活始终健康', async () => {
        const h = createHarness({}, 'ready_ack', { autoReplyProbes: true });
        await activate(h);
        h.raw.deliver(encodeDataFrame(1, 100, 0, Buffer.from('abc').toString('base64')));
        await flush(20);
        await h.clock.advance(80000);
        assert.equal(h.closes.length, 0, '存活健康时 90 秒未到不得关闭');
        await h.clock.advance(11000);
        assert.equal((h.closes[0] as DataChannelError).code, 'receive_stalled');
    });

    test('有效后续块重置 90 秒，consumed 不重置', async () => {
        const h = createHarness({}, 'ready_ack', { autoReplyProbes: true });
        await activate(h);
        h.raw.deliver(encodeDataFrame(1, 9, 0, Buffer.from('abc').toString('base64')));
        await flush(20);
        await h.clock.advance(60000);
        // 有效后续块重置计时。
        h.raw.deliver(encodeDataFrame(1, 9, 3, Buffer.from('def').toString('base64')));
        await flush(20);
        await h.clock.advance(60000);
        assert.equal(h.closes.length, 0, '有效后续块应当重置 90 秒');

        // consumed 不推进本方向重组，因此不重置。
        await h.channel.channel.send('seed');
        await flush(20);
        h.raw.deliver(JSON.stringify({ n3: 1, type: 'consumed', seq: 1 }));
        await flush(20);
        await h.clock.advance(31000);
        assert.ok(
            h.closes.some((error) => (error as DataChannelError)?.code === 'receive_stalled'),
            'consumed 不得续接收无进展期限'
        );
    });
});

// ===========================================================================
describe('错误收敛与关闭', () => {
    test('原生提交失败时全部等待以同一分类拒绝，onClose 只发一次', async () => {
        const h = createHarness();
        await activate(h);
        h.raw.failNextSubmit('native_rejected');
        await assert.rejects(h.channel.channel.send('hello'), (error: DataChannelError) => {
            assert.equal(error.code, 'transport_send_failed');
            return true;
        });
        assert.equal(h.closes.length, 1);
        assert.equal((h.closes[0] as DataChannelError).code, 'transport_send_failed');
        await assert.rejects(h.channel.channel.send('again'));
    });

    test('提交点报告单写入者被破坏时按 transport_contract_violation 关闭', async () => {
        const h = createHarness();
        await activate(h);
        h.raw.violateNextSubmit('single_writer_violation');
        await assert.rejects(h.channel.channel.send('hello'), (error: DataChannelError) => {
            assert.equal(error.code, 'transport_contract_violation');
            return true;
        });
        assert.equal(h.closes.length, 1);
        assert.equal((h.closes[0] as DataChannelError).code, 'transport_contract_violation');
        // 不是可以继续等待的普通 blocked/failed：后续发送立即失败。
        await assert.rejects(h.channel.channel.send('again'));
    });

    test('桥入口预算突破按 receive_capacity_exceeded 关闭', async () => {
        const h = createHarness();
        await activate(h);
        h.raw.overflow();
        await flush();
        assert.equal((h.closes[0] as DataChannelError).code, 'receive_capacity_exceeded');
    });

    test('关闭幂等，且关闭后不再交付入站消息', async () => {
        const h = createHarness();
        await activate(h);
        await h.channel.close();
        await h.channel.close();
        assert.equal(h.closes.length, 1);
        h.raw.deliver(encodeDataFrame(1, 5, 0, Buffer.from('hello').toString('base64')));
        await flush();
        assert.equal(h.messages.length, 0);
    });

    test('对端关闭原始通道时本层同步收敛', async () => {
        const h = createHarness();
        await activate(h);
        h.raw.remoteClose();
        await flush();
        assert.equal(h.closes.length, 1);
        assert.equal(h.channel.inspect().terminated, true);
    });
});

// ===========================================================================
describe('接收释放与消费回报', () => {
    test('只有原生释放真实完成后才生成 consumed', async () => {
        const h = createHarness({ manualRelease: true });
        await activate(h);
        const entryId = h.raw.deliver(encodeDataFrame(1, 5, 0, Buffer.from('hello').toString('base64')));
        await flush();
        assert.equal(h.channel.inspect().pendingConsumed, null, '释放未完成前不得回报');
        assert.equal(h.channel.inspect().consumedInboundDataSeq, 0);
        h.raw.completeRelease(entryId);
        await flush(20);
        assert.equal(h.channel.inspect().consumedInboundDataSeq, 1);
    });

    test('控制帧不计入消费序号', async () => {
        const h = createHarness();
        await activate(h);
        h.raw.deliver(JSON.stringify({ n3: 1, type: 'probe', id: 1 }));
        await flush(20);
        assert.equal(h.channel.inspect().consumedInboundDataSeq, 0, 'probe 不是 data 帧');
        h.raw.deliver(encodeDataFrame(1, 5, 0, Buffer.from('hello').toString('base64')));
        await flush(20);
        assert.equal(h.channel.inspect().consumedInboundDataSeq, 1);
    });
});
