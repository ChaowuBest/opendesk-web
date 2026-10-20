import { randomUUID } from 'node:crypto';
import { createDataChannel, DATA_CHANNEL_LIMITS } from '../../../../../main/applications/mobileaccess/remote-access/webrtc-transport.js';
import type { RawDataChannel, RawChannelEntry } from '../../../../../main/applications/mobileaccess/remote-access/webrtc-transport.js';

/** Real browser peer, with bounded browser-side entries and read/check/send in one browser turn. */
export async function chromiumOfferingPeer(context: any, input: {
    signal: AbortSignal;
    iceServers: Array<{ urls: string[]; username: string; credential: string }>;
    candidate(payload: Record<string, unknown> | null): void;
}, relay = false, localMaximum?: number) {
    const page = await context.newPage();
    await page.goto('about:blank');
    let ended = false, maximum: number | null = null;
    const messages = new Set<(entry: RawChannelEntry) => void>();
    const closed = new Set<() => void>(), overflow = new Set<() => void>(), drains = new Set<() => void>();
    let resolveOpened!: () => void, rejectOpened!: (error: Error) => void;
    const opened = new Promise<void>((resolve, reject) => { resolveOpened = resolve; rejectOpened = reject; });
    void opened.catch(() => undefined);
    const binding = `peer_${randomUUID().replaceAll('-', '')}`;
    await page.exposeBinding(binding, (_source: unknown, event: any) => {
        if (ended) return;
        if (event.kind === 'candidate') input.candidate(event.value);
        if (event.kind === 'open') { maximum = event.maximum; resolveOpened(); }
        if (event.kind === 'raw') for (const listener of messages) listener(event.entry);
        if (event.kind === 'overflow') for (const listener of overflow) listener();
        if (event.kind === 'drain') for (const listener of drains) listener();
        if (event.kind === 'closed') for (const listener of closed) listener();
    });
    await page.evaluate(({ binding, servers, relay, limits }: any) => {
        const w = window as any;
        w.pc = new RTCPeerConnection({ iceServers: servers, iceTransportPolicy: relay ? 'relay' : 'all' });
        w.dc = w.pc.createDataChannel('acp', { ordered: true });
        w.entries = new Map(); w.pending = []; w.inFlight = null; w.next = 1; w.bytes = 0; w.accepting = true;
        w.maximumIncomingBytes = 0; w.fragmentedMessages = new Set();
        w.notify = (event: any) => { if (w.accepting) void w[binding](event); };
        w.pump = () => {
            if (!w.accepting || !w.listen || w.inFlight !== null || !w.pending.length) return;
            w.inFlight = w.pending.shift(); w.notify({ kind: 'raw', entry: w.entries.get(w.inFlight) });
        };
        w.pc.onicecandidate = (event: any) => w.notify({ kind: 'candidate', value: event.candidate?.toJSON() ?? null });
        w.dc.onopen = () => w.notify({ kind: 'open', maximum: w.pc.sctp.maxMessageSize });
        w.dc.onclose = () => w.notify({ kind: 'closed' });
        w.dc.bufferedAmountLowThreshold = limits.send_window_bytes / 2;
        w.dc.onbufferedamountlow = () => w.notify({ kind: 'drain' });
        w.dc.onmessage = ({ data }: any) => {
            if (!w.accepting) return;
            const size = typeof data === 'string' ? new TextEncoder().encode(data).length : Infinity;
            w.maximumIncomingBytes = Math.max(w.maximumIncomingBytes, size);
            if (typeof data === 'string') { const frame = JSON.parse(data); if (frame.n3 === 1 && frame.type === 'data' && frame.offset > 0) w.fragmentedMessages.add(frame.id); }
            if (w.bytes + size > limits.raw_bridge_bytes || w.entries.size >= limits.raw_bridge_frames) { w.notify({ kind: 'overflow' }); return; }
            const entry = { entryId: w.next++, text: data, bytes: size };
            w.entries.set(entry.entryId, entry); w.pending.push(entry.entryId); w.bytes += size; w.pump();
        };
    }, { binding, servers: input.iceServers, relay, limits: DATA_CHANNEL_LIMITS });
    let closing: Promise<void> | undefined;
    const close = () => {
        if (closing) return closing;
        ended = true; input.signal.removeEventListener('abort', onAbort);
        rejectOpened(Error('chromium peer closed'));
        closing = (async () => {
            try { await page.evaluate(() => { const w = window as any; w.accepting = false; w.entries.clear(); w.pending.length = 0; w.pc.close(); }); } catch {}
            for (const listener of closed) listener();
            await page.close();
        })();
        return closing;
    };
    const raw: RawDataChannel = {
        async submit(text, limit) {
            if (ended) return { status: 'failed', reason: 'closed' };
            return page.evaluate(({ text, limit }: any) => {
                const w = window as any; const size = new TextEncoder().encode(text).length;
                if (!w.accepting || w.dc.readyState !== 'open') return { status: 'failed', reason: 'closed' };
                if (w.dc.bufferedAmount + size > limit) return { status: 'blocked', bufferedAmount: w.dc.bufferedAmount };
                w.dc.send(text); return { status: 'accepted', bufferedAmount: w.dc.bufferedAmount };
            }, { text, limit });
        },
        async release(id) {
            if (ended) return false;
            return page.evaluate((id: number) => { const w = window as any; if (id !== w.inFlight || !w.entries.has(id)) return false;
                w.bytes -= w.entries.get(id).bytes; w.entries.delete(id); w.inFlight = null; queueMicrotask(w.pump); return true; }, id);
        },
        onRaw(listener) { messages.add(listener); void page.evaluate(() => { const w = window as any; w.listen = true; w.pump(); }).catch(() => undefined); return () => { messages.delete(listener); }; },
        onClosed(listener) { closed.add(listener); return () => { closed.delete(listener); }; },
        onOverflow(listener) { overflow.add(listener); return () => { overflow.delete(listener); }; },
        onDrain(listener) { drains.add(listener); return () => { drains.delete(listener); }; },
        maxMessageBytes: () => maximum, close
    };
    const data = createDataChannel({ raw, finalControlType: 'ready' });
    function onAbort() { void close(); }
    input.signal.addEventListener('abort', onAbort, { once: true });
    if (input.signal.aborted) onAbort();
    return {
        instance: page, channel: data.channel, opened, closed: data.closed,
        async offer() {
            return page.evaluate(async (maximum: number | undefined) => { const w = window as any; const offer = await w.pc.createOffer();
                if (maximum !== undefined) offer.sdp = offer.sdp.replace(/a=max-message-size:\d+/g, `a=max-message-size:${maximum}`);
                await w.pc.setLocalDescription(offer);
                if (w.pc.iceGatheringState !== 'complete') await new Promise<void>((resolve) => { w.pc.addEventListener('icegatheringstatechange', () => { if (w.pc.iceGatheringState === 'complete') resolve(); }); });
                return w.pc.localDescription.sdp; }, localMaximum);
        },
        async answer(sdp: string) { await page.evaluate((sdp: string) => (window as any).pc.setRemoteDescription({ type: 'answer', sdp }), sdp); },
        async addCandidate(payload: Record<string, unknown> | null) { await page.evaluate((candidate: any) => (window as any).pc.addIceCandidate(candidate), payload); },
        async readback() {
            const actual = await page.evaluate(() => { const w = window as any; return { state: w.dc.readyState, stable: w.pc.signalingState === 'stable', localDescription: w.pc.localDescription?.sdp ?? null, remoteDescription: w.pc.remoteDescription?.sdp ?? null }; });
            return { ...actual, instance: page, channel: data.channel };
        },
        activateTrusted() { if (ended) throw Error('chromium peer closed'); data.activateTrusted(); }, close,
        async inspect() {
            return page.evaluate(async () => {
                const w = window as any; const stats = await w.pc.getStats();
                const transport = [...stats.values()].find((value: any) => value.type === 'transport' && value.selectedCandidatePairId) as any;
                const pair = transport && stats.get(transport.selectedCandidatePairId);
                const local = pair && stats.get(pair.localCandidateId), remote = pair && stats.get(pair.remoteCandidateId);
                return { ordered: w.dc.ordered, reliable: w.dc.maxRetransmits === null && w.dc.maxPacketLifeTime === null,
                    maximum: w.pc.sctp.maxMessageSize, maximumIncomingBytes: w.maximumIncomingBytes, fragmentedMessages: w.fragmentedMessages.size,
                    localMaximum: Number(/a=max-message-size:(\d+)/.exec(w.pc.localDescription.sdp)?.[1]), localType: local?.candidateType, remoteType: remote?.candidateType,
                    remotePort: remote?.port, state: pair?.state, sent: pair?.bytesSent, received: pair?.bytesReceived };
            });
        }
    };
}
