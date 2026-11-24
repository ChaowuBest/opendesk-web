import { RTCPeerConnection } from 'werift';
import { createDataChannel, DATA_CHANNEL_LIMITS, utf8Length } from '../../../../../main/applications/mobileaccess/remote-access/webrtc-transport.js';
import type { RawChannelEntry, RawDataChannel } from '../../../../../main/applications/mobileaccess/remote-access/webrtc-transport.js';

/** Real offering peer for cross-repository tests; no simulated SDP or channel state. */
export async function createOfferingPeer(input: {
    signal: AbortSignal;
    iceServers: Array<{ urls: string[]; username: string; credential: string }>;
    candidate(payload: Record<string, unknown> | null): void;
}) {
    const pc = new RTCPeerConnection({ iceServers: input.iceServers, iceUseIpv6: false });
    const dc = pc.createDataChannel('acp', { ordered: true });
    let stopped = false;
    let closing: Promise<void> | undefined;
    const rawListeners = new Set<(entry: RawChannelEntry) => void>();
    const closeListeners = new Set<() => void>();
    const overflow = new Set<() => void>();
    const drains = new Set<() => void>();
    let next = 1;
    const entries: RawChannelEntry[] = [];
    let inFlight: RawChannelEntry | undefined;
    let bytes = 0;
    let openedResolve!: () => void, openedReject!: (error: Error) => void;
    const opened = new Promise<void>((resolve, reject) => { openedResolve = resolve; openedReject = reject; });
    void opened.catch(() => undefined);
    const pump = () => { if (!stopped && !inFlight && rawListeners.size && entries.length) { inFlight = entries.shift(); rawListeners.values().next().value!(inFlight!); } };
    const close = () => {
        if (closing) return closing;
        stopped = true;
        input.signal.removeEventListener('abort', onAbort);
        closing = Promise.resolve().then(() => pc.close());
        openedReject(Error('offering peer closed'));
        for (const listener of closeListeners) listener();
        entries.length = 0; inFlight = undefined; bytes = 0;
        return closing;
    };
    const raw: RawDataChannel = {
        async submit(text, limit) {
            if (stopped || dc.readyState !== 'open') return { status: 'failed', reason: 'closed' };
            if (dc.bufferedAmount + utf8Length(text) > limit) return { status: 'blocked', bufferedAmount: dc.bufferedAmount };
            dc.send(text); return { status: 'accepted', bufferedAmount: dc.bufferedAmount };
        },
        async release(id) {
            if (stopped || inFlight?.entryId !== id) return false;
            bytes -= inFlight.bytes; inFlight = undefined; queueMicrotask(pump); return true;
        },
        onRaw(listener) { rawListeners.add(listener); pump(); return () => { rawListeners.delete(listener); }; },
        onOverflow(listener) { overflow.add(listener); return () => { overflow.delete(listener); }; },
        onClosed(listener) { closeListeners.add(listener); return () => { closeListeners.delete(listener); }; },
        onDrain(listener) { drains.add(listener); return () => { drains.delete(listener); }; },
        maxMessageBytes() { return pc.sctpTransport?.remoteMaxMessageSize ?? null; }, close
    };
    const data = createDataChannel({ raw, finalControlType: 'ready' });
    dc.onMessage.subscribe((text) => {
        if (stopped) return;
        if (typeof text !== 'string' || bytes + utf8Length(text) > DATA_CHANNEL_LIMITS.raw_bridge_bytes || entries.length + (inFlight ? 1 : 0) >= DATA_CHANNEL_LIMITS.raw_bridge_frames) {
            for (const listener of overflow) listener(); void data.close(); return;
        }
        const entry = { entryId: next++, text, bytes: utf8Length(text) };
        bytes += entry.bytes; entries.push(entry); pump();
    });
    dc.stateChange.subscribe((state) => { if (state === 'open') openedResolve(); if (state === 'closed') void close(); });
    dc.bufferedAmountLowThreshold = DATA_CHANNEL_LIMITS.send_window_bytes / 2;
    dc.bufferedAmountLow.subscribe(() => { if (!stopped) for (const listener of drains) listener(); });
    pc.onIceCandidate.subscribe((candidate) => { if (!stopped) input.candidate(candidate?.toJSON() ?? null); });
    const onAbort = () => { void close(); };
    input.signal.addEventListener('abort', onAbort, { once: true });
    if (input.signal.aborted) onAbort();
    return {
        instance: pc, channel: data.channel, opened, closed: data.closed,
        async offer() { await pc.setLocalDescription(await pc.createOffer()); return pc.localDescription!.sdp; },
        async answer(sdp: string) { await pc.setRemoteDescription({ type: 'answer', sdp }); },
        async addCandidate(payload: Record<string, unknown> | null) { await pc.addIceCandidate(payload); },
        async readback() { return { instance: pc, channel: data.channel, state: dc.readyState === 'open' ? 'open' : 'connecting', stable: pc.signalingState === 'stable', localDescription: pc.localDescription?.sdp ?? null, remoteDescription: pc.remoteDescription?.sdp ?? null }; },
        activateTrusted() { if (stopped || dc.readyState !== 'open' || pc.signalingState !== 'stable') throw Error('peer not open'); data.activateTrusted(); },
        close
    };
}
