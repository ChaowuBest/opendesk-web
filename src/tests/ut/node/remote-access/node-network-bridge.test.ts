import assert from 'node:assert/strict';
import test from 'node:test';
import { RTCPeerConnection } from 'werift';
import type { RTCDataChannel } from 'werift';
import { createNodeNetworkBridge } from '../../../../main/applications/mobileaccess/remote-access/node-network-bridge.js';
import type { NodeNetworkBridgeOptions } from '../../../../main/applications/mobileaccess/remote-access/node-network-bridge.js';

const owner = { hostInstanceId: 'node-contract', generation: 1 };
const input = (signal = new AbortController().signal) => ({
    attemptId: 'synthetic-attempt',
    signal,
    iceServers: [],
    candidate() {}
});
const deadline = async <T>(operation: Promise<T>, milliseconds = 5000): Promise<T> => {
    let timer: ReturnType<typeof setTimeout>;
    try {
        return await Promise.race([
            operation,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('test deadline')), milliseconds);
            })
        ]);
    } finally {
        clearTimeout(timer!);
    }
};

async function pair(options: Partial<NodeNetworkBridgeOptions> = {}, maximum = 16384, badFingerprint = false) {
    const peer = new RTCPeerConnection({ iceServers: [], iceUseIpv6: false, maxMessageSize: maximum });
    const channel = peer.createDataChannel('acp', { ordered: true });
    const lifetime = new AbortController();
    const transport = await createNodeNetworkBridge({ owner: { ...owner }, ...options }).create(input(lifetime.signal));
    try {
        await peer.setLocalDescription(await peer.createOffer());
        let offer = peer.localDescription!.sdp;
        if (badFingerprint)
            offer = offer.replace(
                /a=fingerprint:sha-256 [^\r\n]+/g,
                'a=fingerprint:sha-256 ' + Array(32).fill('FF').join(':')
            );
        const answer = await transport.answer(offer);
        await peer.setRemoteDescription({ type: 'answer', sdp: answer });
        return {
            peer,
            channel,
            lifetime,
            transport,
            async close() {
                await transport.close();
                await peer.close();
            }
        };
    } catch (error) {
        await transport.close();
        await peer.close();
        throw error;
    }
}

test('already cancelled initialization cannot create a usable transport', async () => {
    const parent = new AbortController();
    parent.abort();
    const bridge = createNodeNetworkBridge({ owner });
    let late: Awaited<ReturnType<typeof bridge.create>> | undefined;
    try {
        await assert.rejects(
            bridge.create(input(parent.signal)).then((value) => {
                late = value;
                return value;
            }),
            /closed|cancel/
        );
    } finally {
        await late?.close();
    }
});

test('invalid injected receive limits cannot disable the hard capacity bound', async () => {
    for (const receiveLimits of [
        { bytes: NaN, frames: 2 },
        { bytes: 200, frames: -1 },
        { bytes: Infinity, frames: 2 }
    ]) {
        let actual: Awaited<ReturnType<ReturnType<typeof createNodeNetworkBridge>['create']>> | undefined;
        try {
            await assert.rejects(
                createNodeNetworkBridge({ owner, receiveLimits })
                    .create(input())
                    .then((value) => {
                        actual = value;
                        return value;
                    }),
                /receive_limits/
            );
        } finally {
            await actual?.close();
        }
    }
});

for (const ordered of [true, false]) {
    test(`real ordered=${ordered} channel has actual readback and enforces reliability`, async () => {
        const peer = new RTCPeerConnection({ iceServers: [], iceUseIpv6: false });
        const data = peer.createDataChannel('acp', { ordered });
        const bridge = createNodeNetworkBridge({ owner });
        const transport = await bridge.create(input());
        try {
            await peer.setLocalDescription(await peer.createOffer());
            const answer = await transport.answer(peer.localDescription!.sdp);
            await peer.setRemoteDescription({ type: 'answer', sdp: answer });
            if (!ordered) {
                await assert.rejects(deadline(transport.opened), /closed|reliab/);
                return;
            }
            await deadline(transport.opened);
            const read = await transport.readback();
            assert.equal(read.instance, transport.instance);
            assert.equal(read.channel, transport.channel);
            assert.deepEqual(read.owner, owner);
            assert.equal(read.state, 'open');
            assert.equal(read.stable, true);
            assert.equal(read.localDescription, (transport.instance as RTCPeerConnection).localDescription!.sdp);
            assert.equal(read.remoteDescription, (transport.instance as RTCPeerConnection).remoteDescription!.sdp);
            assert.equal(data.ordered, true);
            transport.activateTrusted();
            await transport.close();
            assert.throws(() => transport.activateTrusted());
        } finally {
            await transport.close();
            await peer.close();
        }
    });
}

test('actual DTLS certificate mismatch never opens or activates', async () => {
    const p = await pair({}, 16384, true);
    try {
        await assert.rejects(deadline(p.transport.opened), /closed/);
        assert.throws(() => p.transport.activateTrusted());
    } finally {
        await p.close();
    }
});

test('actual negotiated limit, synchronous library buffering and bidirectional shared framing', async () => {
    const p = await pair();
    try {
        await deadline(p.transport.opened);
        const pc = p.transport.instance as RTCPeerConnection;
        const actual = Object.values(pc.sctpTransport!.dataChannels)[0] as RTCDataChannel;
        assert.equal(pc.sctpTransport!.remoteMaxMessageSize, 16384);
        const sent: Array<{ bytes: number; before: number; after: number }> = [];
        const original = actual.send.bind(actual);
        actual.send = (text) => {
            const before = actual.bufferedAmount;
            original(text);
            sent.push({ bytes: Buffer.byteLength(text), before, after: actual.bufferedAmount });
        };
        p.transport.activateTrusted();
        const frames: string[] = [];
        p.channel.onMessage.subscribe((value) => {
            if (typeof value === 'string') frames.push(value);
        });
        await deadline(p.transport.channel.send('x'.repeat(100000)));
        for (let attempts = 0; attempts < 100 && frames.length < sent.length; attempts++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.ok(sent.length > 1, 'shared core fragments against the actual remote limit');
        assert.ok(sent.every((record) => record.bytes <= 16384 && record.after >= record.before));
        assert.ok(
            sent.some((record) => record.after > record.before),
            'library bufferedAmount changes during synchronous submit'
        );
        assert.ok(frames.every((raw) => JSON.parse(raw).n3 === 1));
        let received!: (text: string) => void;
        const message = new Promise<string>((resolve) => {
            received = resolve;
        });
        p.transport.channel.onMessage(received);
        const text = '{"jsonrpc":"2.0","id":1,"method":"initialize"}';
        p.channel.send(
            JSON.stringify({
                n3: 1,
                type: 'data',
                id: 1,
                total: Buffer.byteLength(text),
                offset: 0,
                data: Buffer.from(text).toString('base64')
            })
        );
        assert.equal(await deadline(message), text);
    } finally {
        await p.close();
    }
});

test('pending plus in-flight receive entries stay bounded behind the trusted activation barrier', async () => {
    const codes: string[] = [];
    const p = await pair({ receiveLimits: { bytes: 200, frames: 2 }, diagnose: (event) => codes.push(event.code) });
    try {
        await deadline(p.transport.opened);
        for (let index = 0; index < 8; index++) p.channel.send('{"type":"ready_ack"}');
        await deadline(p.transport.closed);
        assert.ok(codes.includes('data_channel_receive_capacity_exceeded'));
        assert.throws(() => p.transport.activateTrusted());
    } finally {
        await p.close();
    }
});

test('binary messages and a second real channel are isolated', async () => {
    for (const invalid of ['binary', 'second']) {
        const p = await pair();
        try {
            await deadline(p.transport.opened);
            if (invalid === 'binary') p.channel.send(Buffer.from('synthetic binary'));
            else p.peer.createDataChannel('second', { ordered: true });
            await deadline(p.transport.closed);
            assert.throws(() => p.transport.activateTrusted());
        } finally {
            await p.close();
        }
    }
});

test('owner mutation and abort reject late readback, candidates and activation', async () => {
    const mutable = { ...owner };
    const p = await pair({
        owner: mutable,
        diagnose() {
            throw new Error('diagnostic failure');
        }
    });
    try {
        await deadline(p.transport.opened);
        const oldRead = await p.transport.readback();
        mutable.generation++;
        assert.equal(oldRead.owner.generation, 1);
        await assert.rejects(p.transport.readback(), /closed/);
        assert.throws(() => p.transport.activateTrusted());
        p.lifetime.abort();
        await deadline(p.transport.close());
        assert.equal((p.transport.instance as RTCPeerConnection).connectionState, 'closed');
    } finally {
        await p.close();
    }
});

test('actual buffering blocks shared submit until real queue drain and wakes at low water', async () => {
    const p = await pair({}, 4194304);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    try {
        await deadline(p.transport.opened);
        const pc = p.transport.instance as RTCPeerConnection;
        const actual = Object.values(pc.sctpTransport!.dataChannels)[0] as RTCDataChannel;
        const sctp = pc.sctpTransport!.sctp;
        const original = sctp.send.bind(sctp);
        sctp.send = async (...args: Parameters<typeof sctp.send>) => {
            await gate;
            return original(...args);
        };
        // A real library enqueue holds the window; bufferedAmount is never replaced or fabricated.
        for (let i = 0; i < 16; i++) actual.send(Buffer.alloc(262144));
        assert.equal(actual.bufferedAmount, 4194304);
        let sends = 0,
            drains = 0;
        const originalSend = actual.send.bind(actual);
        actual.send = (text) => {
            sends++;
            originalSend(text);
        };
        actual.bufferedAmountLow.subscribe(() => {
            drains++;
        });
        p.transport.activateTrusted();
        let settled = false;
        const sending = p.transport.channel.send('synthetic').then(() => {
            settled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 80));
        assert.equal(settled, false);
        assert.equal(sends, 0);
        release();
        await deadline(sending, 15000);
        assert.ok(sends > 0);
        for (let i = 0; i < 300 && actual.bufferedAmount > 0; i++)
            await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(actual.bufferedAmount, 0);
        assert.ok(drains > 0);
    } finally {
        release();
        await p.close();
    }
});
