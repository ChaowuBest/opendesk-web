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

import { z } from 'zod';
import type WebSocket from 'ws';

// ── Protocol Frames ─────────────────────────────────────────────────────────

export type RequestFrame = {
    type: 'req';
    id: string;
    method: string;
    params?: unknown;
};

export type ResponseFrame = {
    type: 'res';
    id: string;
    ok: boolean;
    payload?: unknown;
    error?: {
        code: string;
        message: string;
        details?: unknown;
        retryable?: boolean;
        retryAfterMs?: number;
    };
};

export type EventFrame = {
    type: 'event';
    event: string;
    payload?: unknown;
    seq?: number;
    stateVersion?: string;
};

export type ProtocolFrame = RequestFrame | ResponseFrame | EventFrame;

// ── Connect Params ──────────────────────────────────────────────────────────

export type ConnectClientInfo = {
    id: string;
    displayName?: string;
    version: string;
    platform: string;
    deviceFamily?: string;
    modelIdentifier?: string;
    mode: string;
    instanceId?: string;
};

export type ConnectDeviceInfo = {
    id: string;
    publicKey: string;
    signature: string;
    signedAt: number;
    nonce: string;
};

export type ConnectParams = {
    minProtocol: number;
    maxProtocol: number;
    client: ConnectClientInfo;
    role?: string;
    scopes?: string[];
    caps?: string[];
    commands?: string[];
    permissions?: Record<string, boolean>;
    auth?: {
        token?: string;
        bootstrapToken?: string;
        deviceToken?: string;
        password?: string;
    };
    device?: ConnectDeviceInfo;
    locale?: string;
    userAgent?: string;
};

// ── Node Session ────────────────────────────────────────────────────────────

export type NodeSession = {
    nodeId: string;
    connId: string;
    socket: WebSocket;
    connect: ConnectParams;
    displayName?: string;
    platform?: string;
    version?: string;
    deviceFamily?: string;
    modelIdentifier?: string;
    remoteIp?: string;
    caps: string[];
    commands: string[];
    permissions?: Record<string, boolean>;
    connectedAtMs: number;
};

// ── Node Invoke ─────────────────────────────────────────────────────────────

export type NodeInvokeResult = {
    ok: boolean;
    payload?: unknown;
    payloadJSON?: string | null;
    error?: { code?: string; message?: string } | null;
};

export type NodeInvokeRequestEvent = {
    id: string;
    nodeId: string;
    command: string;
    paramsJSON?: string | null;
    timeoutMs?: number;
    idempotencyKey?: string;
};

// ── Pairing ─────────────────────────────────────────────────────────────────

export type PendingPairingRequest = {
    requestId: string;
    nodeId: string;
    displayName?: string;
    platform?: string;
    version?: string;
    deviceFamily?: string;
    modelIdentifier?: string;
    caps?: string[];
    commands?: string[];
    remoteIp?: string;
    silent?: boolean;
    isRepair?: boolean;
    ts: number;
};

export type PairedNode = {
    nodeId: string;
    token: string;
    displayName?: string;
    platform?: string;
    version?: string;
    deviceFamily?: string;
    modelIdentifier?: string;
    caps?: string[];
    commands?: string[];
    remoteIp?: string;
    createdAtMs: number;
    approvedAtMs: number;
    lastConnectedAtMs?: number;
};

export type PairingList = {
    pending: PendingPairingRequest[];
    paired: PairedNode[];
};

// ── Device Identity ─────────────────────────────────────────────────────────

export type GatewayIdentity = {
    deviceId: string;
    publicKeyPem: string;
    privateKeyPem: string;
};

// ── Configuration ───────────────────────────────────────────────────────────

export const DeviceMgrConfigSchema = z.object({
    enabled: z.boolean().describe('启用设备网关服务').default(true),
    port: z.number().describe('WebSocket 监听端口').default(18789),
    autoApproveLocal: z.boolean().describe('自动审批来自本机的配对请求').default(true),
});

export type DeviceMgrConfig = z.output<typeof DeviceMgrConfigSchema>;

// ── Protocol Constants ──────────────────────────────────────────────────────

export const PROTOCOL_VERSION = 3;
export const HANDSHAKE_TIMEOUT_MS = 30_000;
export const TICK_INTERVAL_MS = 15_000;
export const PENDING_PAIRING_TTL_MS = 5 * 60 * 1000;
export const SIGNATURE_SKEW_MS = 2 * 60 * 1000;
export const DEFAULT_INVOKE_TIMEOUT_MS = 30_000;

export const GATEWAY_METHODS = [
    'connect',
    // ── Node methods ─────────────────────────────────────────────────────
    'node.pair.request',
    'node.pair.list',
    'node.pair.approve',
    'node.pair.reject',
    'node.pair.verify',
    'node.list',
    'node.describe',
    'node.rename',
    'node.invoke',
    'node.invoke.result',
    'node.event',
    'node.pending.pull',
    'node.pending.ack',
    // ── OpenClaw-compatible operator methods ──────────────────────────────
    'health',
    'status',
    'chat.send',
    'chat.history',
    'chat.abort',
    'sessions.list',
    'sessions.create',
    'sessions.subscribe',
    'sessions.unsubscribe',
    'sessions.send',
    'sessions.abort',
    'sessions.patch',
    'sessions.reset',
    'sessions.delete',
    'sessions.preview',
    'sessions.compact',
    'sessions.messages.subscribe',
    'sessions.messages.unsubscribe',
    'models.list',
    'tools.catalog',
    'agents.list',
    'agents.create',
    'agents.update',
    'agents.delete',
    'config.get',
    'config.set',
    'config.apply',
    'config.patch',
    'config.schema',
    'send',
    'agent',
    'agent.identity.get',
    'gateway.identity.get',
    'system-presence',
    'system-event',
    'skills.status',
    'skills.bins',
    'talk.config',
    'talk.mode',
    'channels.status',
    'logs.tail',
    'last-heartbeat',
    'set-heartbeats',
    'wake',
];

export const GATEWAY_EVENTS = [
    'connect.challenge',
    'tick',
    'shutdown',
    'node.pair.requested',
    'node.pair.resolved',
    'node.invoke.request',
    'chat',
    'session.message',
    'session.tool',
    'sessions.changed',
    'presence',
    'health',
    'heartbeat',
];
