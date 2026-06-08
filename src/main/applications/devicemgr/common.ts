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

import os from 'node:os';
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
    shells?: string[];
    defaultShell?: string;
    workspace?: string;
    permissions?: Record<string, boolean>;
    pathEnv?: string;
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
    shells: string[];
    defaultShell?: string;
    workspace?: string;
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
    shells?: string[];
    defaultShell?: string;
    workspace?: string;
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
    shells?: string[];
    defaultShell?: string;
    workspace?: string;
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

export const DEFAULT_GATEWAY_HOST = '127.0.0.1';
export const DISABLED_GATEWAY_HOST = 'none';

export type GatewayListenHostOption = {
    value: string;
    label: string;
};

export function normalizeGatewayHost(host: string | undefined | null): string {
    const trimmed = (host ?? '').trim();
    if (!trimmed) return DEFAULT_GATEWAY_HOST;

    const normalized = trimmed.toLowerCase();
    if (normalized === DISABLED_GATEWAY_HOST || normalized === 'off' || normalized === 'disabled' || trimmed === '无') {
        return DISABLED_GATEWAY_HOST;
    }
    if (trimmed === '*') return '0.0.0.0';
    return trimmed;
}

export const DeviceMgrConfigSchema = z.object({
    enabled: z.boolean().describe('启用设备网关服务').default(true),
    host: z.string().describe('WebSocket 监听地址；设置为 none/无 时关闭监听服务').default(DEFAULT_GATEWAY_HOST),
    port: z.number().int().min(1).max(65535).describe('WebSocket 监听端口').default(18789),
    autoApproveLocal: z.boolean().describe('自动审批来自本机的配对请求').default(true)
});

export type DeviceMgrConfig = z.output<typeof DeviceMgrConfigSchema>;

export function normalizeDeviceMgrConfig(config: DeviceMgrConfig): DeviceMgrConfig {
    const host = normalizeGatewayHost(config.host);
    return {
        ...config,
        host,
        enabled: config.enabled && host !== DISABLED_GATEWAY_HOST
    };
}

export function parseDeviceMgrConfig(raw: unknown): DeviceMgrConfig {
    return normalizeDeviceMgrConfig(DeviceMgrConfigSchema.parse(raw ?? {}));
}

export function isDeviceGatewayEnabled(config: DeviceMgrConfig): boolean {
    return config.enabled && normalizeGatewayHost(config.host) !== DISABLED_GATEWAY_HOST;
}

export function listGatewayListenHostOptions(): GatewayListenHostOption[] {
    const options: GatewayListenHostOption[] = [
        { value: DISABLED_GATEWAY_HOST, label: '无（关闭监听服务）' },
        { value: DEFAULT_GATEWAY_HOST, label: `${DEFAULT_GATEWAY_HOST}（仅本机）` },
        { value: '0.0.0.0', label: '0.0.0.0（所有 IPv4 地址）' }
    ];
    const seen = new Set(options.map((option) => option.value));

    for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
        for (const addressInfo of addresses ?? []) {
            if (String(addressInfo.family) !== 'IPv4' || addressInfo.internal) continue;
            if (seen.has(addressInfo.address)) continue;
            seen.add(addressInfo.address);
            options.push({
                value: addressInfo.address,
                label: `${addressInfo.address}（${name}）`
            });
        }
    }

    return options;
}

// ── Protocol Constants ──────────────────────────────────────────────────────

export const PROTOCOL_VERSION = 4;
export const MIN_CLIENT_PROTOCOL_VERSION = 4;
export const HANDSHAKE_TIMEOUT_MS = 30_000;
export const TICK_INTERVAL_MS = 30_000;
export const PENDING_PAIRING_TTL_MS = 5 * 60 * 1000;
export const SIGNATURE_SKEW_MS = 2 * 60 * 1000;
export const DEFAULT_INVOKE_TIMEOUT_MS = 30_000;
export const MAX_PAYLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_BUFFERED_BYTES = 50 * 1024 * 1024;

export const GATEWAY_METHODS = [
    'connect',
    // ── Node methods ─────────────────────────────────────────────────────
    'node.pair.request',
    'node.pair.list',
    'node.pair.approve',
    'node.pair.reject',
    'node.pair.remove',
    'node.pair.verify',
    'node.list',
    'node.describe',
    'node.rename',
    'node.pluginSurface.refresh',
    'node.invoke',
    'node.invoke.result',
    'node.event',
    'node.pending.drain',
    'node.pending.enqueue',
    'node.pending.pull',
    'node.pending.ack',
    // ── Device pairing methods ───────────────────────────────────────────
    'device.pair.list',
    'device.pair.approve',
    'device.pair.reject',
    'device.pair.remove',
    'device.token.rotate',
    'device.token.revoke',
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
    'sessions.describe',
    'sessions.send',
    'sessions.abort',
    'sessions.patch',
    'sessions.pluginPatch',
    'sessions.cleanup',
    'sessions.reset',
    'sessions.delete',
    'sessions.preview',
    'sessions.compact',
    'sessions.compaction.list',
    'sessions.compaction.get',
    'sessions.compaction.branch',
    'sessions.compaction.restore',
    'sessions.messages.subscribe',
    'sessions.messages.unsubscribe',
    'models.list',
    'models.authStatus',
    'tools.catalog',
    'tools.effective',
    'tools.invoke',
    'tasks.list',
    'tasks.get',
    'tasks.cancel',
    'environments.list',
    'environments.status',
    'agents.list',
    'agents.create',
    'agents.update',
    'agents.delete',
    'agents.files.list',
    'agents.files.get',
    'agents.files.set',
    'config.get',
    'config.set',
    'config.apply',
    'config.patch',
    'config.schema',
    'config.schema.lookup',
    'commands.list',
    'send',
    'message.action',
    'agent',
    'agent.identity.get',
    'agent.wait',
    'gateway.identity.get',
    'gateway.restart.preflight',
    'gateway.restart.request',
    'system-presence',
    'system-event',
    'skills.status',
    'skills.search',
    'skills.detail',
    'skills.bins',
    'skills.upload.begin',
    'skills.upload.chunk',
    'skills.upload.commit',
    'skills.install',
    'skills.update',
    'talk.catalog',
    'talk.config',
    'talk.mode',
    'talk.speak',
    'talk.client.create',
    'talk.client.toolCall',
    'talk.session.create',
    'talk.session.join',
    'talk.session.appendAudio',
    'talk.session.startTurn',
    'talk.session.endTurn',
    'talk.session.cancelTurn',
    'talk.session.cancelOutput',
    'talk.session.submitToolResult',
    'talk.session.close',
    'channels.status',
    'channels.start',
    'channels.stop',
    'channels.logout',
    'cron.get',
    'cron.list',
    'cron.status',
    'cron.add',
    'cron.update',
    'cron.remove',
    'cron.run',
    'cron.runs',
    'logs.tail',
    'last-heartbeat',
    'set-heartbeats',
    'wake',
    'update.status',
    'update.run',
    'secrets.reload',
    'secrets.resolve',
    'voicewake.get',
    'voicewake.set',
    'voicewake.routing.get',
    'voicewake.routing.set',
    'exec.approvals.get',
    'exec.approvals.set',
    'exec.approval.get',
    'exec.approval.list',
    'exec.approval.request',
    'exec.approval.waitDecision',
    'exec.approval.resolve',
    'plugin.approval.list',
    'plugin.approval.request',
    'plugin.approval.waitDecision',
    'plugin.approval.resolve',
    'plugins.uiDescriptors',
    'plugins.sessionAction'
];

export const GATEWAY_EVENTS = [
    'connect.challenge',
    'agent',
    'chat',
    'session.message',
    'session.tool',
    'sessions.changed',
    'presence',
    'tick',
    'talk.mode',
    'talk.event',
    'shutdown',
    'health',
    'heartbeat',
    'cron',
    'node.pair.requested',
    'node.pair.resolved',
    'node.invoke.request',
    'device.pair.requested',
    'device.pair.resolved',
    'voicewake.changed',
    'voicewake.routing.changed',
    'exec.approval.requested',
    'exec.approval.resolved',
    'plugin.approval.requested',
    'plugin.approval.resolved',
    'update.available'
];
