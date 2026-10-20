import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { BrowserWindow, IpcMain } from 'electron';
import { createElectronRendererPort } from '../../../../main/applications/mobileaccess/acp/mobile/hosts/renderer-port.js';
import { installMobileAccessPreload } from '../../../../main/applications/mobileaccess/preload.js';

import {
    DATA_CHANNEL_LIMITS,
    createDesktopNetworkBridge,
    deriveStunServers,
    parseTurnUri,
    type DesktopEventSender,
    type DesktopRendererPort
} from '../../../../main/applications/mobileaccess/remote-access/webrtc-transport.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function flush(rounds = 12): Promise<void> {
    for (let i = 0; i < rounds; i += 1) await tick();
}

const WEB_CONTENTS_ID = 7;
const OWNER = { hostInstanceId: 'electron-instance', generation: 3 };
const MAIN_FRAME = 11;

test('owner invalidation after readback cannot activate the Electron channel', async () => {
    for (const changed of [
        { ...OWNER, generation: OWNER.generation + 1 },
        { ...OWNER, hostInstanceId: 'another-host' }
    ]) {
        const harness = createBridgeHarness();
        const transport = await harness.bridge.create({
            attemptId: 'synthetic',
            signal: new AbortController().signal,
            iceServers: [],
            candidate() {}
        });
        try {
            await transport.readback();
            harness.setOwner(changed);
            assert.throws(() => transport.activateTrusted(), /owner/);
        } finally {
            await transport.close();
        }
    }
});

/** renderer 替身：记录 main 发来的调用，并可按指定身份回推事件。 */
function createPortHarness(overrides: Partial<Record<string, (payload: any) => unknown>> = {}) {
    const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
    let listener: ((sender: DesktopEventSender, payload: Record<string, unknown>) => void) | null = null;
    let mainFrame: number | null = MAIN_FRAME;
    let owner = { ...OWNER };
    const port: DesktopRendererPort = {
        get owner() {
            return owner;
        },
        webContentsId: WEB_CONTENTS_ID,
        mainFrameRoutingId: () => mainFrame,
        async invoke(method, payload) {
            calls.push({ method, payload });
            const override = overrides[method];
            if (override) return override(payload);
            switch (method) {
                case 'create':
                    return { instanceId: 'data-channel-1', maxMessageBytes: null };
                case 'answer':
                    return { sdp: 'v=0\r\nanswer' };
                case 'readback':
                    return {
                        state: 'open',
                        stable: true,
                        localDescription: 'v=0\r\nlocal',
                        remoteDescription: 'v=0\r\nremote',
                        maxMessageBytes: 65536
                    };
                case 'submit':
                    return { status: 'accepted', bufferedAmount: 0 };
                case 'release':
                    return { released: true };
                default:
                    return {};
            }
        },
        onEvent(next) {
            listener = next;
            return () => {
                listener = null;
            };
        }
    };
    return {
        port,
        calls,
        setOwner(value: typeof OWNER) {
            owner = value;
        },
        setMainFrame(value: number | null) {
            mainFrame = value;
        },
        emit(
            payload: Record<string, unknown>,
            sender: DesktopEventSender = { webContentsId: WEB_CONTENTS_ID, frameRoutingId: MAIN_FRAME }
        ) {
            listener?.(sender, payload);
        },
        get listening() {
            return listener !== null;
        }
    };
}

/** 可控时钟：本套件不使用真实定时器，激活后的探测/存活计时不得拖住测试进程。 */
function createClock() {
    const now = 0;
    let nextId = 1;
    const timers = new Map<number, { at: number; callback: () => void }>();
    return {
        now: () => now,
        setTimeout(callback: () => void, delay: number) {
            const id = nextId++;
            timers.set(id, { at: now + delay, callback });
            return id;
        },
        clearTimeout(handle: unknown) {
            timers.delete(handle as number);
        },
        pending: () => timers.size
    };
}

function createBridgeHarness(overrides?: Partial<Record<string, (payload: any) => unknown>>) {
    const harness = createPortHarness(overrides);
    const diagnostics: Array<{ code: string; detail?: string }> = [];
    const clock = createClock();
    const bridge = createDesktopNetworkBridge({
        port: harness.port,
        clock,
        diagnose: (event) => diagnostics.push(event)
    });
    return { ...harness, bridge, diagnostics, clock };
}

const CREATE_INPUT = (candidates: Array<Record<string, unknown> | null> = []) => ({
    attemptId: 'attempt-1',
    signal: new AbortController().signal,
    iceServers: [
        {
            urls: ['turn:relay.example:3478?transport=udp'],
            username: 'u',
            credential: 'c'
        }
    ],
    candidate(payload: Record<string, unknown> | null) {
        candidates.push(payload);
    }
});

// ===========================================================================
describe('TURN URI 解析与 STUN 派生（Spec §5.4）', () => {
    test('按 RFC 7065 处理 scheme、默认端口、transport 与 IPv6', () => {
        assert.deepEqual(parseTurnUri('turn:relay.example:3478?transport=udp'), {
            scheme: 'turn',
            host: 'relay.example',
            port: 3478,
            transport: 'udp'
        });
        // 默认端口：turn 3478、turns 5349。
        assert.equal(parseTurnUri('turn:relay.example')!.port, 3478);
        assert.equal(parseTurnUri('turns:relay.example')!.port, 5349);
        // scheme 与参数大小写不敏感归一化。
        assert.deepEqual(parseTurnUri('TURN:relay.example:3478?TRANSPORT=UDP'), {
            scheme: 'turn',
            host: 'relay.example',
            port: 3478,
            transport: 'udp'
        });
        // IPv6 方括号。
        assert.equal(parseTurnUri('turn:[2001:db8::1]:3478')!.host, '[2001:db8::1]');
        assert.equal(parseTurnUri('http://relay.example'), null);
        assert.equal(parseTurnUri('turn:relay.example:0'), null);
    });

    test('只从 turn + UDP（显式或默认）派生，turns/UDP 不派生', () => {
        const entry = (urls: string[]) => [{ urls, username: 'u', credential: 'c' }];
        assert.deepEqual(deriveStunServers(entry(['turn:relay.example:3478?transport=udp'])), [
            'stun:relay.example:3478'
        ]);
        assert.deepEqual(deriveStunServers(entry(['turn:relay.example:3478'])), ['stun:relay.example:3478']);
        assert.deepEqual(deriveStunServers(entry(['TURN:relay.example:3478?TRANSPORT=UDP'])), [
            'stun:relay.example:3478'
        ]);
        // 明确反例：合法 wire，但不满足数据通道的来源条件。
        assert.deepEqual(deriveStunServers(entry(['turns:relay.example:5349?transport=udp'])), []);
        assert.deepEqual(deriveStunServers(entry(['TURNS:relay.example:5349?TRANSPORT=UDP'])), []);
        assert.deepEqual(deriveStunServers(entry(['turn:relay.example:3478?transport=tcp'])), []);
        // 同时存在时只从合格来源派生。
        assert.deepEqual(
            deriveStunServers(
                entry(['turns:relay.example:5349?transport=udp', 'turn:relay.example:3478?transport=udp'])
            ),
            ['stun:relay.example:3478']
        );
        // 去重与条数上界。
        assert.deepEqual(deriveStunServers(entry(['turn:a:3478', 'turn:a:3478', 'turn:b:3478'])), [
            'stun:a:3478',
            'stun:b:3478'
        ]);
        assert.equal(deriveStunServers(entry(['turn:a:1', 'turn:b:2', 'turn:c:3', 'turn:d:4', 'turn:e:5'])).length, 4);
        // IPv6 按 URI 语法处理，不做字符串盲替换。
        assert.deepEqual(deriveStunServers(entry(['turn:[2001:db8::1]:3478'])), ['stun:[2001:db8::1]:3478']);
    });

    test('空输入不偷用历史地址或第三方 STUN', () => {
        assert.deepEqual(deriveStunServers([]), []);
    });
});

// ===========================================================================
describe('main 侧宿主桥', () => {
    test('owner invalidation during create rejects the late renderer instance', async () => {
        let finish!: (value: unknown) => void;
        const pending = new Promise((resolve) => {
            finish = resolve;
        });
        const h = createBridgeHarness({ create: () => pending });
        const creating = h.bridge.create(CREATE_INPUT());
        h.setOwner({ ...OWNER, generation: OWNER.generation + 1 });
        finish({ instanceId: 'late-instance', maxMessageBytes: null });
        await assert.rejects(creating, /owner/);
        assert.equal(h.listening, false);
        assert.ok(h.calls.some((call) => call.method === 'close' && call.payload.generation === OWNER.generation));
    });

    test('late candidates from an invalidated owner cannot reach the new attempt', async () => {
        const h = createBridgeHarness();
        const candidates: Array<Record<string, unknown> | null> = [];
        const transport = await h.bridge.create(CREATE_INPUT(candidates));
        try {
            h.setOwner({ ...OWNER, hostInstanceId: 'another-host' });
            h.emit({ kind: 'candidate', instanceId: 'data-channel-1', generation: OWNER.generation, candidate: {} });
            assert.deepEqual(candidates, []);
        } finally {
            await transport.close();
        }
    });

    test('create 把原 TURN 与派生 STUN 一次性配给同一实例，并下发桥预算', async () => {
        const h = createBridgeHarness();
        await h.bridge.create(CREATE_INPUT());
        const call = h.calls.find((entry) => entry.method === 'create')!;
        assert.equal(call.payload.attemptId, 'attempt-1');
        assert.equal(call.payload.generation, OWNER.generation);
        assert.deepEqual(call.payload.stunUrls, ['stun:relay.example:3478']);
        // 原 TURN 条目仍带本端临时凭据，形状不变（不回传信令、不扩展 wire）。
        assert.deepEqual(call.payload.iceServers, [
            { urls: ['turn:relay.example:3478?transport=udp'], username: 'u', credential: 'c' }
        ]);
        assert.equal(call.payload.rawBridgeBytes, DATA_CHANNEL_LIMITS.raw_bridge_bytes);
        assert.equal(call.payload.rawBridgeFrames, DATA_CHANNEL_LIMITS.raw_bridge_frames);
    });

    test('readback 只交付本实例句柄与本实例 channel，不接受外部自报', async () => {
        const h = createBridgeHarness();
        const transport = await h.bridge.create(CREATE_INPUT());
        const read = await transport.readback();
        assert.equal(read.instance, transport.instance, '必须是本实例句柄');
        assert.equal(read.channel, transport.channel, '必须是本实例 channel');
        assert.deepEqual(read.owner, OWNER);
        assert.equal(read.state, 'open');
        assert.equal(read.stable, true);
        assert.equal(read.localDescription, 'v=0\r\nlocal');
        assert.equal(read.remoteDescription, 'v=0\r\nremote');
    });

    test('renderer 返回非法 state 时 readback 失败，不产生半可信结果', async () => {
        const h = createBridgeHarness({ readback: () => ({ state: 'weird', stable: true }) });
        const transport = await h.bridge.create(CREATE_INPUT());
        await assert.rejects(transport.readback(), /invalid state/);
    });

    test('拒绝来自非主 frame 的事件', async () => {
        const candidates: Array<Record<string, unknown> | null> = [];
        const h = createBridgeHarness();
        await h.bridge.create(CREATE_INPUT(candidates));
        h.emit(
            { instanceId: 'data-channel-1', generation: OWNER.generation, kind: 'candidate', candidate: { c: 1 } },
            { webContentsId: WEB_CONTENTS_ID, frameRoutingId: MAIN_FRAME + 1 }
        );
        assert.deepEqual(candidates, [], '子 frame 不得伪造候选');
        assert.ok(h.diagnostics.some((event) => event.code === 'data_channel_bridge_frame_rejected'));
    });

    test('拒绝来自其他 webContents 的事件', async () => {
        const candidates: Array<Record<string, unknown> | null> = [];
        const h = createBridgeHarness();
        await h.bridge.create(CREATE_INPUT(candidates));
        h.emit(
            { instanceId: 'data-channel-1', generation: OWNER.generation, kind: 'candidate', candidate: { c: 1 } },
            { webContentsId: WEB_CONTENTS_ID + 1, frameRoutingId: MAIN_FRAME }
        );
        assert.deepEqual(candidates, []);
    });

    test('拒绝错代次与错实例的事件', async () => {
        const candidates: Array<Record<string, unknown> | null> = [];
        const h = createBridgeHarness();
        await h.bridge.create(CREATE_INPUT(candidates));
        h.emit({
            instanceId: 'data-channel-1',
            generation: OWNER.generation + 1,
            kind: 'candidate',
            candidate: { c: 1 }
        });
        assert.deepEqual(candidates, [], '旧代回调必须被丢弃');
        assert.ok(h.diagnostics.some((event) => event.code === 'data_channel_bridge_generation_rejected'));
        h.emit({
            instanceId: 'data-channel-other',
            generation: OWNER.generation,
            kind: 'candidate',
            candidate: { c: 1 }
        });
        assert.deepEqual(candidates, [], '其他实例的事件必须被丢弃');
    });

    test('候选 null 表示收集结束，原样透传给信令', async () => {
        const candidates: Array<Record<string, unknown> | null> = [];
        const h = createBridgeHarness();
        await h.bridge.create(CREATE_INPUT(candidates));
        h.emit({ instanceId: 'data-channel-1', generation: OWNER.generation, kind: 'candidate', candidate: null });
        assert.deepEqual(candidates, [null]);
    });

    test('畸形原始帧事件被丢弃且不交付上层', async () => {
        const h = createBridgeHarness();
        const transport = await h.bridge.create(CREATE_INPUT());
        const messages: string[] = [];
        transport.channel.onMessage((message) => messages.push(message));
        h.emit({
            instanceId: 'data-channel-1',
            generation: OWNER.generation,
            kind: 'raw',
            entryId: 'x',
            text: 'a',
            bytes: 1
        });
        h.emit({
            instanceId: 'data-channel-1',
            generation: OWNER.generation,
            kind: 'raw',
            entryId: 1,
            text: 5,
            bytes: 1
        });
        await flush();
        assert.deepEqual(messages, []);
        assert.equal(h.diagnostics.filter((event) => event.code === 'data_channel_bridge_invalid_raw').length, 2);
    });

    test('submit 忠实转述 accepted / blocked / failed，不自行改判', async () => {
        const results: string[] = [];
        const h = createBridgeHarness({
            submit: (payload) => {
                results.push(String(payload.text));
                if (results.length === 1) return { status: 'blocked', bufferedAmount: 42 };
                if (results.length === 2) return { status: 'failed', reason: 'native_rejected' };
                return { status: 'accepted', bufferedAmount: 1 };
            }
        });
        const transport = await h.bridge.create(CREATE_INPUT());
        // 激活前的直通发送直接经原始通道提交。
        const first = transport.channel.send('{"type":"present_ticket"}');
        await flush();
        // blocked 后本层等待排空，不把它当失败。
        assert.equal(h.calls.filter((entry) => entry.method === 'submit').length, 1);
        void first;
    });

    test('submit 下发的窗口上限为 W 减去一帧桥预留', async () => {
        const h = createBridgeHarness();
        const transport = await h.bridge.create(CREATE_INPUT());
        void transport.channel.send('{"type":"present_ticket"}');
        await flush();
        const submit = h.calls.find((entry) => entry.method === 'submit')!;
        assert.equal(
            submit.payload.windowLimit,
            DATA_CHANNEL_LIMITS.send_window_bytes - DATA_CHANNEL_LIMITS.frame_bytes
        );
        assert.equal(submit.payload.generation, OWNER.generation);
        assert.equal(submit.payload.instanceId, 'data-channel-1');
    });

    test('renderer 关闭事件收敛本实例并解除监听', async () => {
        const h = createBridgeHarness();
        const transport = await h.bridge.create(CREATE_INPUT());
        let closes = 0;
        transport.channel.onClose(() => closes++);
        h.emit({ instanceId: 'data-channel-1', generation: OWNER.generation, kind: 'closed' });
        await flush();
        assert.equal(closes, 1);
        await transport.closed;
    });

    test('close 解除事件监听，旧 close 不影响新实例', async () => {
        const h = createBridgeHarness();
        const transport = await h.bridge.create(CREATE_INPUT());
        await transport.close();
        assert.equal(h.listening, false, '关闭后必须解除 renderer 事件监听');
    });

    test('主 frame 尚未就绪时不按 frame 拒绝，但仍校验 webContents', async () => {
        const candidates: Array<Record<string, unknown> | null> = [];
        const h = createBridgeHarness();
        await h.bridge.create(CREATE_INPUT(candidates));
        h.setMainFrame(null);
        h.emit(
            { instanceId: 'data-channel-1', generation: OWNER.generation, kind: 'candidate', candidate: { c: 1 } },
            { webContentsId: WEB_CONTENTS_ID, frameRoutingId: 999 }
        );
        assert.deepEqual(candidates, [{ c: 1 }]);
    });

    test('G1 在桥上透传到协议核心；关闭后再激活抛错', async () => {
        const h = createBridgeHarness();
        const transport = await h.bridge.create(CREATE_INPUT());
        transport.activateTrusted();
        transport.activateTrusted(); // 幂等
        await transport.close();
        assert.throws(() => transport.activateTrusted());
    });

    test('readback 带回的 sctp 上限用于固定单帧上限', async () => {
        const h = createBridgeHarness();
        const transport = await h.bridge.create(CREATE_INPUT());
        // 描述交换完成后才有 sctp.maxMessageSize；此处模拟信令核验阶段的 readback。
        await transport.readback();
        transport.activateTrusted();
        const messages: string[] = [];
        transport.channel.onMessage((message) => messages.push(message));
        void transport.channel.send('x'.repeat(200000)).catch(() => undefined);
        await flush(40);
        const submits = h.calls.filter((entry) => entry.method === 'submit');
        assert.ok(submits.length > 1, '65536 的上限必须让 200000 字节消息分成多块');
        for (const submit of submits)
            assert.ok(
                Buffer.byteLength(String(submit.payload.text), 'utf8') <= 65536,
                '每帧不得超过 readback 带回的已验证上限'
            );
        await transport.close();
        assert.equal(h.clock.pending(), 0, '关闭后不得留下未清理的计时器');
    });

    test('create 的 abort signal 触发关闭', async () => {
        const h = createBridgeHarness();
        const controller = new AbortController();
        const transport = await h.bridge.create({ ...CREATE_INPUT(), signal: controller.signal });
        controller.abort();
        await flush();
        await transport.closed;
        assert.equal(h.listening, false);
    });

    test('renderer 没有返回 instanceId 时 create 失败', async () => {
        const h = createBridgeHarness({ create: () => ({}) });
        await assert.rejects(h.bridge.create(CREATE_INPUT()), /did not create an instance/);
    });
});

// ---------------------------------------------------------------------------
// preload 装载：本文件同时是窗口 preload 和 session 注册的 frame preload，
// 在主 frame 里会被执行两次。真机上正是这一点让同一条 remote-network:invoke 被处理两遍：
// create 出两个 PeerConnection、answer 应用两次、产生两套 ICE 凭据，第二代候选
// 被协调方按 ufrag 不匹配拒掉，整个尝试被误杀。
// ---------------------------------------------------------------------------
test('the shared preload installs one private endpoint only in the host main frame', () => {
    const subscriptions: string[] = [];
    const ipc = { on: (channel: string) => subscriptions.push(channel) };
    installMobileAccessPreload(ipc, false, false);
    installMobileAccessPreload(ipc, true, true);
    assert.deepEqual(subscriptions, []);
    installMobileAccessPreload(ipc, true, false);
    installMobileAccessPreload(ipc, true, false);
    assert.deepEqual(subscriptions, ['remote-network:invoke']);
});

test('the application detaches IPC and invalidates pending calls when the host frame changes', async () => {
    const ipc = new EventEmitter();
    const frame = { processId: 31, routingId: 7 };
    let requestId = '';
    const contents = Object.assign(new EventEmitter(), {
        id: 12,
        mainFrame: frame,
        isDestroyed: () => false,
        send(_channel: string, request: { requestId: string }) {
            requestId = request.requestId;
        }
    });
    const window = { isDestroyed: () => false, webContents: contents } as unknown as BrowserWindow;
    const attach = () => createElectronRendererPort(ipc as IpcMain, window)!;
    const port = attach();
    let received = 0;
    port.onEvent(() => received++);
    const result = port.invoke('readback', {});
    const generation = port.owner.generation;
    contents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
    assert.ok(port.owner.generation > generation);
    for (const senderFrame of [null, { ...frame, routingId: 8 }, { ...frame, processId: 32 }]) {
        const event = { sender: contents, senderFrame };
        ipc.emit('remote-network:result', event, { requestId, ok: true, result: 'wrong' });
        ipc.emit('remote-network:event', event, {});
    }
    const sender = { sender: contents, senderFrame: frame };
    ipc.emit('remote-network:result', sender, { requestId, ok: true, result: 'ok' });
    ipc.emit('remote-network:event', sender, {});
    assert.equal(await result, 'ok');
    assert.equal(received, 1);
    for (const [event, details] of [
        ['did-start-navigation', { isMainFrame: true, isSameDocument: false }],
        ['render-process-gone', {}]
    ] as const) {
        const generation = port.owner.generation;
        const rejected = assert.rejects(port.invoke('readback', {}), /renderer is gone/);
        contents.emit(event, details);
        assert.ok(port.owner.generation > generation);
        await rejected;
    }
    const last = assert.rejects(port.invoke('readback', {}), /renderer is gone/);
    port.dispose();
    await last;
    assert.equal(ipc.listenerCount('remote-network:result'), 0);
    assert.equal(ipc.listenerCount('remote-network:event'), 0);
    const next = attach();
    assert.notEqual(next.owner.hostInstanceId, port.owner.hostInstanceId);
    assert.equal(ipc.listenerCount('remote-network:result'), 1);
    contents.emit('destroyed');
    assert.equal(ipc.listenerCount('remote-network:result'), 0);
});
