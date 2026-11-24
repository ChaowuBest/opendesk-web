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

import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

export const NETWORK_LIMITS = {
    attempt_ms: 60000,
    ticket_ms: 30000,
    auth_ms: 5000,
    auth_bytes: 16384,
    frame_bytes: 131072,
    sdp_bytes: 65536,
    candidate_count: 256,
    candidate_bytes: 4096,
    candidate_queue_bytes: 262144,
    control_bytes: 1024,
    control_queue_count: 8,
    control_queue_bytes: 8192,
    queue_count: 64,
    queue_bytes: 262144,
    send_ms: 5000,
    ping_idle_ms: 30000,
    pong_ms: 10000,
    reconnect_ms: 5000,
    ws_count: 256,
    unauthenticated_count: 32,
    pc_ws_per_user: 16,
    mobile_ws_per_user: 4,
    attempt_count: 128,
    attempts_per_user: 4,
    scan_ms: 1000,
    cleanup_ms: 3000
} as const;
const PAYLOAD_FIELDS: Record<string, readonly string[]> = {
    auth: ['role access_token credential_version', 'device_id run_id'],
    auth_ok: ['version server_epoch socket_id limits', ''],
    error: ['code', 'request_id attempt_id credential_version'],
    auth_failed: ['code credential_version', ''],
    connect_request: ['request_id device_id remaining_ms', ''],
    attempt_created: ['request_id device_id run_id remaining_ms', ''],
    incoming_connection: ['user_id device_id run_id remaining_ms turn', ''],
    accept: ['eligibility_generation', ''],
    reject: ['code', ''],
    attempt_accepted: ['device_id run_id remaining_ms turn', ''],
    offer: ['sdp', ''],
    answer: ['sdp', ''],
    candidate: ['candidate sdpMid sdpMLineIndex', 'usernameFragment'],
    candidates_complete: ['', ''],
    ticket: ['secret valid_for_ms mobile_fingerprint pc_fingerprint', ''],
    activate_request: ['', ''],
    activate_ok: ['', ''],
    auth_update: ['access_token credential_version', ''],
    auth_updated: ['credential_version', ''],
    ping: ['nonce', ''],
    pong: ['nonce', ''],
    cancel: ['code', ''],
    connection_closed: ['code', ''],
    attempt_failed: ['code', 'request_id attempt_id']
};
export type NetworkCode =
    | 'remote_pc_busy'
    | 'auth_invalid'
    | 'account_disabled'
    | 'remote_pc_unavailable'
    | 'attempt_not_available'
    | 'eligibility_lost'
    | 'peer_auth_invalid'
    | 'attempt_expired'
    | 'attempt_state_conflict'
    | 'signaling_lost'
    | 'invalid_message'
    | 'resource_limit'
    | 'ticket_invalid'
    | 'peer_binding_failed'
    | 'activation_failed'
    | 'unsupported_version'
    | 'cancelled';
export class NetworkProtocolError extends Error {
    constructor(public readonly code: NetworkCode = 'invalid_message') {
        super(code);
    }
}
export type Fingerprint = { algorithm: 'sha-256'; digest: string };
export type TurnConfiguration =
    | {
          status: 'available';
          urls: string[];
          username: string;
          credential: string;
          expires_at: number;
          valid_for_ms: number;
      }
    | { status: 'unavailable'; reason: 'not_configured' | 'configuration_invalid' | 'issuance_failed' };
export type NetworkFrame = {
    version: 1;
    type: string;
    payload: Record<string, unknown>;
    server_epoch?: string;
    socket_id?: string;
    attempt_id?: string;
};
const CODES = new Set(
    'remote_pc_busy auth_invalid account_disabled remote_pc_unavailable attempt_not_available eligibility_lost peer_auth_invalid attempt_expired attempt_state_conflict signaling_lost invalid_message resource_limit ticket_invalid peer_binding_failed activation_failed unsupported_version cancelled'.split(
        ' '
    )
);
const CONNECTION_TYPES = new Set('error auth_failed connect_request auth_update auth_updated ping pong'.split(' '));
function requireValue(condition: unknown): asserts condition {
    if (!condition) throw new NetworkProtocolError();
}
function record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function integer(value: unknown, min = 0, max: number = Number.MAX_SAFE_INTEGER): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}
export function utf8Bytes(value: string): number {
    return new TextEncoder().encode(value).length;
}
function text(value: unknown, maximum: number): value is string {
    return typeof value === 'string' && utf8Bytes(value) > 0 && utf8Bytes(value) <= maximum;
}
function exact(value: Record<string, unknown>, keys: string[]): void {
    requireValue(Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)));
}
export function isNetworkUuid(value: unknown): value is string {
    return typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
}
export function fingerprintBytes(value: unknown): Uint8Array {
    requireValue(record(value));
    exact(value, ['algorithm', 'digest']);
    requireValue(
        value.algorithm === 'sha-256' &&
            typeof value.digest === 'string' &&
            /^[0-9a-f]{2}(?::[0-9a-f]{2}){31}$/i.test(value.digest)
    );
    return Uint8Array.from(value.digest.split(':').map((byte) => parseInt(byte, 16)));
}
export function equalFingerprint(a: Uint8Array, b: Uint8Array): boolean {
    return a.length === 32 && b.length === 32 && a.every((value, i) => value === b[i]);
}
export function validateTurn(value: unknown): TurnConfiguration {
    requireValue(record(value));
    if (value.status === 'unavailable') {
        exact(value, ['status', 'reason']);
        requireValue(['not_configured', 'configuration_invalid', 'issuance_failed'].includes(value.reason as string));
    } else {
        requireValue(value.status === 'available');
        exact(value, ['status', 'urls', 'username', 'credential', 'expires_at', 'valid_for_ms']);
        requireValue(Array.isArray(value.urls) && value.urls.length >= 1 && value.urls.length <= 4);
        for (const url of value.urls) {
            requireValue(text(url, 1024));
            const match = /^turns?:(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::([0-9]+))?(?:\?transport=(udp|tcp))?$/i.exec(url);
            requireValue(match);
            const [, host, port] = match;
            requireValue(!port || (port.length <= 5 && integer(Number(port), 1, 65535)));
            requireValue(
                host.startsWith('[')
                    ? isIP(host.slice(1, -1)) === 6
                    : host
                          .replace(/\.$/, '')
                          .split('.')
                          .every((part) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(part))
            );
        }
        requireValue(text(value.username, 256) && text(value.credential, 256));
        requireValue(integer(value.expires_at, 1) && integer(value.valid_for_ms, 1));
    }
    requireValue(utf8Bytes(JSON.stringify(value)) <= 8192);
    return value as TurnConfiguration;
}
export function captureTurn(
    value: unknown,
    now: number,
    wallTime: number
): { turn: TurnConfiguration; deadline: number } {
    const turn = validateTurn(value);
    const remaining =
        turn.status === 'available' ? Math.min(turn.valid_for_ms, (turn.expires_at - wallTime / 1000) * 1000) : 0;
    return { turn, deadline: now + Math.max(0, remaining) };
}
export function selectTurn(
    captured: ReturnType<typeof captureTurn>,
    now: number,
    remainingBudget: number
): { iceServers: Array<{ urls: string[]; username: string; credential: string }>; reason?: string } {
    const { turn, deadline } = captured;
    if (turn.status === 'unavailable') return { iceServers: [], reason: turn.reason };
    const remain = deadline - now;
    if (remain <= 0) return { iceServers: [], reason: 'expired' };
    if (remain < remainingBudget) return { iceServers: [], reason: 'insufficient_lifetime' };
    return { iceServers: [{ urls: [...turn.urls], username: turn.username, credential: turn.credential }] };
}
export function parseDataDescription(sdp: string): { digest: Uint8Array; mid: string; ufrag: string | null } {
    requireValue(text(sdp, 65536));
    const lines = sdp.replace(/\r\n/g, '\n').split('\n').filter(Boolean);
    const media = lines.map((line, i) => ({ line, i })).filter((item) => item.line.startsWith('m='));
    requireValue(media.length === 1);
    const { line, i: mediaIndex } = media[0];
    const parts = line.split(/\s+/);
    requireValue(
        parts.length === 4 &&
            parts[0] === 'm=application' &&
            /^[0-9]+$/.test(parts[1]) &&
            integer(Number(parts[1]), 1, 65535) &&
            ['UDP/DTLS/SCTP', 'TCP/DTLS/SCTP'].includes(parts[2]) &&
            parts[3] === 'webrtc-datachannel'
    );
    const mids = lines.map((line, i) => ({ line, i })).filter((item) => item.line.startsWith('a=mid:'));
    requireValue(mids.length === 1 && mids[0].i > mediaIndex && /^[^\s:]+$/.test(mids[0].line.slice(6)));
    const mid = mids[0].line.slice(6);
    const bundles = lines.map((line, i) => ({ line, i })).filter((item) => item.line.startsWith('a=group:BUNDLE'));
    requireValue(
        bundles.length <= 1 && bundles.every((item) => item.i < mediaIndex && item.line.slice(15).trim() === mid)
    );
    const ufrags = lines.filter((line) => line.startsWith('a=ice-ufrag:')).map((line) => line.slice(12));
    requireValue(ufrags.length <= 1 && ufrags.every((value) => /^[a-z0-9+/]+$/i.test(value)));
    const fingerprints = lines.filter((line) => line.startsWith('a=fingerprint:'));
    requireValue(fingerprints.length === 1);
    const match = /^a=fingerprint:sha-256 ([0-9a-f]{2}(?::[0-9a-f]{2}){31})$/i.exec(fingerprints[0]);
    requireValue(match);
    return { digest: fingerprintBytes({ algorithm: 'sha-256', digest: match[1] }), mid, ufrag: ufrags[0] ?? null };
}
export function parseNetworkFrame(value: unknown, initial = false): NetworkFrame {
    requireValue(record(value) && integer(value.version));
    if (value.version !== 1) throw new NetworkProtocolError('unsupported_version');
    requireValue(typeof value.type === 'string' && Object.hasOwn(PAYLOAD_FIELDS, value.type));
    const type = value.type;
    const keys = ['version', 'type', 'payload'];
    if (initial) requireValue(['auth', 'auth_ok', 'error', 'auth_failed'].includes(type));
    else {
        requireValue(!['auth', 'auth_ok'].includes(type));
        keys.push('server_epoch', 'socket_id');
        if (!CONNECTION_TYPES.has(type)) keys.push('attempt_id');
    }
    exact(value, keys);
    for (const key of ['server_epoch', 'socket_id', 'attempt_id'])
        if (key in value) requireValue(isNetworkUuid(value[key]));
    requireValue(record(value.payload));
    const payload = value.payload;
    const [required, optional] = PAYLOAD_FIELDS[type].map((fields) => fields.split(' ').filter(Boolean));
    requireValue(
        required.every((key) => Object.hasOwn(payload, key)) &&
            Object.keys(payload).every((key) => required.includes(key) || optional.includes(key))
    );
    if (type === 'auth') {
        requireValue(['pc', 'mobile'].includes(payload.role as string));
        requireValue(
            payload.role === 'pc'
                ? 'device_id' in payload && 'run_id' in payload
                : !('device_id' in payload || 'run_id' in payload)
        );
    }
    for (const [key, field] of Object.entries(payload)) {
        if (['request_id', 'attempt_id', 'socket_id', 'server_epoch', 'run_id', 'nonce'].includes(key))
            requireValue(isNetworkUuid(field));
        else if (['device_id', 'user_id', 'sdpMid', 'usernameFragment'].includes(key)) requireValue(text(field, 128));
        else if (key === 'access_token') requireValue(text(field, 16384));
        else if (['credential_version', 'eligibility_generation'].includes(key)) requireValue(integer(field));
        else if (key === 'remaining_ms') requireValue(integer(field, 1, 60000));
        else if (key === 'valid_for_ms') requireValue(integer(field, 1, 30000));
        else if (key === 'sdpMLineIndex') requireValue(field === 0);
        else if (key === 'sdp') requireValue(text(field, 65536));
        else if (key === 'candidate') requireValue(text(field, 4096));
        else if (key === 'secret')
            requireValue(typeof field === 'string' && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(field));
        else if (['mobile_fingerprint', 'pc_fingerprint'].includes(key)) fingerprintBytes(field);
        else if (key === 'turn') validateTurn(field);
        else if (key === 'version') requireValue(field === 1);
        else if (key === 'limits') {
            requireValue(record(field));
            exact(field, Object.keys(NETWORK_LIMITS));
            for (const [name, max] of Object.entries(NETWORK_LIMITS)) requireValue(integer(field[name], 1, max));
        } else if (key === 'code') {
            requireValue(typeof field === 'string');
            if (type === 'auth_failed') requireValue(['auth_invalid', 'account_disabled'].includes(field));
            else if (type === 'cancel') requireValue(field === 'cancelled');
            else if (type === 'reject') requireValue(text(field, 64));
            else requireValue(CODES.has(field));
        }
    }
    requireValue(utf8Bytes(JSON.stringify(value)) <= (initial ? 16384 : 131072));
    return value as NetworkFrame;
}
function decodeTicket(value: string): Uint8Array | undefined {
    if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return;
    const result = Buffer.from(value, 'base64url');
    if (result.length !== 32 || result.toString('base64url') !== value) return;
    return result;
}
export function equalTicket(a: string, b: string): boolean {
    const left = decodeTicket(a),
        right = decodeTicket(b);
    return !!left && !!right && timingSafeEqual(left, right);
}
export function remoteNetworkWsUrl(baseUrl: string, allowLoopback = false): string {
    const url = new URL(baseUrl);
    requireValue(!url.username && !url.password && !url.search && !url.hash);
    requireValue(
        url.protocol === 'https:' ||
            (allowLoopback && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    );
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/remote-network/ws`;
    return url.toString();
}
