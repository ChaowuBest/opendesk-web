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
 * OpenClaw Node Protocol v4 WebSocket 网关服务器。
 * 实现完整的握手、认证、配对、命令调用和事件推送。
 */

import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { logger } from '../../utils/logger.js';
import { NodeRegistry } from './node-registry.js';
import { PairingStore } from './pairing.js';
import {
    loadOrCreateGatewayIdentity,
    generateNonce,
    verifyDeviceSignature,
    deriveDeviceId,
    buildDeviceAuthPayloadV3,
    buildDeviceAuthPayloadV2,
    base64UrlEncode,
    generatePairingToken
} from './device-identity.js';
import type {
    RequestFrame,
    ResponseFrame,
    EventFrame,
    ConnectParams,
    GatewayIdentity,
    DeviceMgrConfig
} from './common.js';
import {
    PROTOCOL_VERSION,
    MIN_CLIENT_PROTOCOL_VERSION,
    HANDSHAKE_TIMEOUT_MS,
    TICK_INTERVAL_MS,
    SIGNATURE_SKEW_MS,
    MAX_PAYLOAD_BYTES,
    MAX_BUFFERED_BYTES,
    GATEWAY_METHODS,
    GATEWAY_EVENTS,
    normalizeGatewayHost
} from './common.js';
import { NotificationManager } from '../../utils/notificationmgr.js';
import { t } from '../../../locale/index.js';

const TAG = '[devicemgr:gateway]';

export type ConnectionState = {
    connId: string;
    socket: WebSocket;
    remoteIp?: string;
    handshakeState: 'pending' | 'connected' | 'failed';
    challengeNonce: string;
    challengeTs: number;
    connectParams?: ConnectParams;
    handshakeTimer?: ReturnType<typeof setTimeout>;
    tickTimer?: ReturnType<typeof setInterval>;
};

export type GatewayEventCallback = (event: string, payload: unknown) => void;

/**
 * Handler signature for gateway RPC methods.
 * Receives the connection, frame, and a `respond` helper.
 */
export type GatewayMethodHandler = (
    conn: ConnectionState,
    frame: RequestFrame,
    params: any,
    respond: (ok: boolean, payload?: unknown, error?: { code: string; message: string; details?: unknown }) => void
) => void | Promise<void>;

export class DeviceGateway {
    private wss: WebSocketServer | null = null;
    private identity!: GatewayIdentity;
    private nodeRegistry = new NodeRegistry();
    private pairingStore!: PairingStore;
    private connections = new Map<string, ConnectionState>();
    private config: DeviceMgrConfig;
    private dataDir: string;
    private eventCallback?: GatewayEventCallback;
    private methodHandlers = new Map<string, GatewayMethodHandler>();

    constructor(dataDir: string, config: DeviceMgrConfig) {
        this.dataDir = dataDir;
        this.config = config;
    }

    /**
     * 外部回调，用于将事件转发到 OpenDesk 应用事件系统。
     */
    onEvent(callback: GatewayEventCallback): void {
        this.eventCallback = callback;
    }

    getNodeRegistry(): NodeRegistry {
        return this.nodeRegistry;
    }

    getPairingStore(): PairingStore {
        return this.pairingStore;
    }

    getIdentity(): GatewayIdentity {
        return this.identity;
    }

    /**
     * 注册一个 RPC 方法处理器。客户端调用 `method` 时将路由到 handler。
     */
    registerMethod(method: string, handler: GatewayMethodHandler): void {
        this.methodHandlers.set(method, handler);
    }

    /**
     * 批量注册方法处理器。
     */
    registerMethods(handlers: Record<string, GatewayMethodHandler>): void {
        for (const [method, handler] of Object.entries(handlers)) {
            this.methodHandlers.set(method, handler);
        }
    }

    isRunning(): boolean {
        return this.wss !== null;
    }

    getPort(): number {
        return this.config.port;
    }

    getHost(): string {
        return normalizeGatewayHost(this.config.host);
    }

    // ── Lifecycle ───────────────────────────────────────────────────────

    async start(): Promise<void> {
        if (this.wss) return;

        this.identity = loadOrCreateGatewayIdentity(this.dataDir);
        this.pairingStore = new PairingStore(this.dataDir);

        logger.info(`${TAG} 网关身份: ${this.identity.deviceId}`);

        return new Promise<void>((resolve, reject) => {
            const host = this.getHost();
            let settled = false;

            this.wss = new WebSocketServer({ host, port: this.config.port }, () => {
                settled = true;
                logger.info(`${TAG} WebSocket 网关已启动，监听 ${host}:${this.config.port}`);
                resolve();
            });

            this.wss.on('error', (err) => {
                logger.error(`${TAG} WebSocket 服务器错误: ${err.message}`);
                if (!settled) {
                    const failedServer = this.wss;
                    this.wss = null;
                    try {
                        failedServer?.close();
                    } catch {
                        /* best-effort cleanup after listen failure */
                    }
                    reject(err);
                }
            });

            this.wss.on('connection', (socket, req) => {
                this.handleConnection(socket, req);
            });
        });
    }

    async stop(): Promise<void> {
        if (!this.wss) return;

        // Broadcast shutdown event
        for (const conn of this.connections.values()) {
            if (conn.handshakeState === 'connected') {
                this.sendEvent(conn.socket, 'shutdown', { reason: 'server_stopping' });
            }
            if (conn.handshakeTimer) clearTimeout(conn.handshakeTimer);
            if (conn.tickTimer) clearInterval(conn.tickTimer);
            conn.socket.close(1001, 'server stopping');
        }
        this.connections.clear();

        return new Promise<void>((resolve) => {
            this.wss!.close(() => {
                logger.info(`${TAG} WebSocket 网关已停止`);
                this.wss = null;
                resolve();
            });
        });
    }

    updateConfig(config: DeviceMgrConfig): void {
        this.config = config;
    }

    // ── Connection handling ─────────────────────────────────────────────

    private handleConnection(socket: WebSocket, req: import('http').IncomingMessage): void {
        const connId = randomUUID();
        const remoteIp = req.socket.remoteAddress;
        const nonce = generateNonce();

        logger.info(`${TAG} 新连接 ${connId} from ${remoteIp}`);

        const conn: ConnectionState = {
            connId,
            socket,
            remoteIp,
            handshakeState: 'pending',
            challengeNonce: nonce,
            challengeTs: Date.now()
        };
        this.connections.set(connId, conn);

        // Send challenge immediately
        this.sendEvent(socket, 'connect.challenge', {
            nonce,
            ts: conn.challengeTs
        });

        // Handshake timeout
        conn.handshakeTimer = setTimeout(() => {
            if (conn.handshakeState === 'pending') {
                logger.warn(`${TAG} 握手超时 ${connId}`);
                conn.handshakeState = 'failed';
                socket.close(4408, 'handshake timeout');
            }
        }, HANDSHAKE_TIMEOUT_MS);

        socket.on('message', (data) => {
            this.handleMessage(conn, data);
        });

        socket.on('close', (code, reason) => {
            logger.info(`${TAG} 连接关闭 ${connId} code=${code} reason=${reason?.toString()}`);
            this.handleDisconnect(conn);
        });

        socket.on('error', (err) => {
            logger.error(`${TAG} 连接错误 ${connId}: ${err.message}`);
        });
    }

    private handleDisconnect(conn: ConnectionState): void {
        // 防止重复处理（stop() 中 socket.close() 和 wss.close() 可能各自触发 close 事件）
        if (!this.connections.delete(conn.connId)) return;

        if (conn.handshakeTimer) clearTimeout(conn.handshakeTimer);
        if (conn.tickTimer) clearInterval(conn.tickTimer);

        const nodeId = this.nodeRegistry.unregister(conn.connId);
        if (nodeId) {
            logger.info(`${TAG} 节点断开 ${nodeId}`);
            this.emitGatewayEvent('device:disconnected', { nodeId, connId: conn.connId });
            // 发送断联通知
            const displayName = conn.connectParams?.client?.displayName ?? nodeId;
            NotificationManager.getInstance().info(
                '设备管理',
                t('device.notification.disconnected'),
                t('device.notification.disconnected-detail', { displayName })
            );
        }
    }

    // ── Message dispatch ────────────────────────────────────────────────

    private handleMessage(conn: ConnectionState, data: import('ws').RawData): void {
        let frame: RequestFrame;
        try {
            frame = JSON.parse(data.toString());
        } catch {
            logger.warn(`${TAG} 无法解析消息 ${conn.connId}`);
            return;
        }

        if (frame.type !== 'req') {
            logger.warn(`${TAG} 未知帧类型 ${conn.connId}: ${(frame as any).type}`);
            return;
        }

        if (conn.handshakeState === 'pending') {
            if (frame.method === 'connect') {
                this.handleConnect(conn, frame);
            } else {
                this.sendResponse(conn.socket, frame.id, false, undefined, {
                    code: 'NOT_AUTHENTICATED',
                    message: 'must send connect request first'
                });
            }
            return;
        }

        this.routeMethod(conn, frame);
    }

    private routeMethod(conn: ConnectionState, frame: RequestFrame): void {
        const method = frame.method;
        const params = frame.params as any;
        const respond = (
            ok: boolean,
            payload?: unknown,
            error?: { code: string; message: string; details?: unknown }
        ) => {
            this.sendResponse(conn.socket, frame.id, ok, payload, error);
        };

        // Check external registered handlers first
        const externalHandler = this.methodHandlers.get(method);
        if (externalHandler) {
            try {
                const result = externalHandler(conn, frame, params, respond);
                if (result instanceof Promise) {
                    result.catch((err: any) => {
                        respond(false, undefined, {
                            code: 'INTERNAL_ERROR',
                            message: err?.message || 'handler error'
                        });
                    });
                }
            } catch (err: any) {
                respond(false, undefined, {
                    code: 'INTERNAL_ERROR',
                    message: err?.message || 'handler error'
                });
            }
            return;
        }

        // Built-in node methods
        switch (method) {
            case 'node.pair.request':
                this.handlePairRequest(conn, frame, params);
                break;
            case 'node.pair.list':
                this.handlePairList(conn, frame);
                break;
            case 'node.pair.approve':
                this.handlePairApprove(conn, frame, params);
                break;
            case 'node.pair.reject':
                this.handlePairReject(conn, frame, params);
                break;
            case 'node.pair.verify':
                this.handlePairVerify(conn, frame, params);
                break;
            case 'node.list':
                this.handleNodeList(conn, frame);
                break;
            case 'node.describe':
                this.handleNodeDescribe(conn, frame, params);
                break;
            case 'node.rename':
                this.handleNodeRename(conn, frame, params);
                break;
            case 'node.invoke':
                this.handleNodeInvoke(conn, frame, params);
                break;
            case 'node.invoke.result':
                this.handleNodeInvokeResult(conn, frame, params);
                break;
            case 'node.event':
                this.handleNodeEvent(conn, frame, params);
                break;
            case 'node.pluginSurface.refresh':
                respond(true, {});
                break;
            case 'node.pending.drain':
                respond(true, { items: [], hasMore: false });
                break;
            case 'node.pending.pull':
                respond(true, { items: [], hasMore: false });
                break;
            case 'node.pending.ack':
                respond(true, {});
                break;
            case 'skills.bins':
                respond(true, { bins: [] });
                break;
            default:
                respond(false, undefined, {
                    code: 'METHOD_NOT_FOUND',
                    message: `unknown method: ${method}`
                });
        }
    }

    // ── Handshake: connect ──────────────────────────────────────────────

    private handleConnect(conn: ConnectionState, frame: RequestFrame): void {
        const params = frame.params as ConnectParams;
        if (!params) {
            this.sendResponse(conn.socket, frame.id, false, undefined, {
                code: 'INVALID_PARAMS',
                message: 'connect params required'
            });
            return;
        }

        // Protocol version negotiation (v4: require client supports at least MIN_CLIENT_PROTOCOL_VERSION)
        const minP = params.minProtocol ?? 1;
        const maxP = params.maxProtocol ?? PROTOCOL_VERSION;
        if (PROTOCOL_VERSION < minP || maxP < MIN_CLIENT_PROTOCOL_VERSION) {
            this.sendResponse(conn.socket, frame.id, false, undefined, {
                code: 'PROTOCOL_MISMATCH',
                message: `server protocol ${PROTOCOL_VERSION} (min ${MIN_CLIENT_PROTOCOL_VERSION}) not compatible with client range [${minP}, ${maxP}]`
            });
            conn.socket.close(4002, 'protocol mismatch');
            return;
        }

        // Verify device signature if provided
        const authResult = this.verifyAuth(conn, params);
        if (!authResult.ok) {
            this.sendResponse(conn.socket, frame.id, false, undefined, {
                code: authResult.code!,
                message: authResult.message!,
                details: authResult.details
            });
            if (authResult.closeConnection) {
                conn.handshakeState = 'failed';
                conn.socket.close(4001, authResult.code);
            }
            return;
        }

        // Clear handshake timer
        if (conn.handshakeTimer) {
            clearTimeout(conn.handshakeTimer);
            conn.handshakeTimer = undefined;
        }

        conn.handshakeState = 'connected';
        conn.connectParams = params;

        // Register as a node if role is 'node'
        const isNode = params.role === 'node' || params.client.mode === 'node';
        let deviceToken: string | undefined;
        if (isNode) {
            const session = this.nodeRegistry.register(conn.socket, conn.connId, params, conn.remoteIp);
            logger.info(`${TAG} 节点已注册: ${session.nodeId} (${session.displayName ?? 'unknown'})`);

            // Update pairing metadata
            const nodeId = session.nodeId;
            this.pairingStore.updateLastConnected(nodeId, {
                version: params.client.version,
                platform: params.client.platform,
                deviceFamily: params.client.deviceFamily,
                caps: session.caps,
                commands: session.commands,
                shells: session.shells,
                defaultShell: session.defaultShell,
                workspace: session.workspace,
                remoteIp: conn.remoteIp
            });

            deviceToken = generatePairingToken();
            this.emitGatewayEvent('device:connected', {
                nodeId: session.nodeId,
                displayName: session.displayName,
                platform: session.platform,
                commands: session.commands,
                shells: session.shells,
                defaultShell: session.defaultShell,
                workspace: session.workspace
            });
            // 发送连接通知
            const displayName = session.displayName ?? session.nodeId;
            NotificationManager.getInstance().info(
                '设备管理',
                t('device.notification.connected'),
                t('device.notification.connected-detail', { displayName })
            );
        }

        // Start tick heartbeat
        conn.tickTimer = setInterval(() => {
            if (conn.socket.readyState === conn.socket.OPEN) {
                this.sendEvent(conn.socket, 'tick', { ts: Date.now() });
            }
        }, TICK_INTERVAL_MS);

        // Send hello-ok (OpenClaw v4 compatible)
        this.sendResponse(conn.socket, frame.id, true, {
            type: 'hello-ok',
            protocol: PROTOCOL_VERSION,
            server: {
                version: '1.0.0',
                connId: conn.connId
            },
            features: {
                methods: GATEWAY_METHODS,
                events: GATEWAY_EVENTS
            },
            snapshot: {
                sessions: [],
                presence: []
            },
            auth: {
                deviceToken,
                role: params.role ?? 'node',
                scopes: params.scopes ?? [],
                issuedAtMs: Date.now()
            },
            policy: {
                maxPayload: MAX_PAYLOAD_BYTES,
                maxBufferedBytes: MAX_BUFFERED_BYTES,
                tickIntervalMs: TICK_INTERVAL_MS
            }
        });
    }

    /**
     * 验证连接认证：设备签名 + token。
     */
    private verifyAuth(
        conn: ConnectionState,
        params: ConnectParams
    ): {
        ok: boolean;
        code?: string;
        message?: string;
        details?: unknown;
        closeConnection?: boolean;
    } {
        const device = params.device;
        const auth = params.auth;

        // No device block means anonymous (for pairing flow or unauthenticated connect)
        if (!device) {
            // Allow anonymous connections, they can only pair
            return { ok: true };
        }

        // Validate device.nonce matches challenge
        if (!device.nonce) {
            return {
                ok: false,
                code: 'DEVICE_AUTH_NONCE_REQUIRED',
                message: 'device nonce required',
                closeConnection: true
            };
        }

        if (device.nonce !== conn.challengeNonce) {
            return {
                ok: false,
                code: 'DEVICE_AUTH_NONCE_MISMATCH',
                message: 'device nonce mismatch',
                closeConnection: true
            };
        }

        // Verify device.id matches publicKey
        if (device.publicKey) {
            const derivedId = deriveDeviceId(device.publicKey);
            if (derivedId && device.id && derivedId !== device.id) {
                return {
                    ok: false,
                    code: 'DEVICE_AUTH_DEVICE_ID_MISMATCH',
                    message: 'device identity mismatch',
                    closeConnection: true
                };
            }
        }

        // Verify timestamp skew
        if (device.signedAt) {
            const skew = Math.abs(Date.now() - device.signedAt);
            if (skew > SIGNATURE_SKEW_MS) {
                return {
                    ok: false,
                    code: 'DEVICE_AUTH_SIGNATURE_EXPIRED',
                    message: 'device signature expired',
                    closeConnection: true
                };
            }
        }

        // Verify signature
        if (device.publicKey && device.signature) {
            const role = params.role ?? 'node';
            const scopes = params.scopes ?? [];
            const token = auth?.token ?? auth?.deviceToken ?? '';

            // Try V3 first, then V2
            const payloadV3 = buildDeviceAuthPayloadV3({
                deviceId: device.id,
                clientId: params.client.id,
                clientMode: params.client.mode,
                role,
                scopes,
                signedAtMs: device.signedAt,
                token,
                nonce: device.nonce,
                platform: params.client.platform,
                deviceFamily: params.client.deviceFamily
            });

            let valid = verifyDeviceSignature(device.publicKey, payloadV3, device.signature);

            if (!valid) {
                const payloadV2 = buildDeviceAuthPayloadV2({
                    deviceId: device.id,
                    clientId: params.client.id,
                    clientMode: params.client.mode,
                    role,
                    scopes,
                    signedAtMs: device.signedAt,
                    token,
                    nonce: device.nonce
                });
                valid = verifyDeviceSignature(device.publicKey, payloadV2, device.signature);
            }

            if (!valid) {
                return {
                    ok: false,
                    code: 'DEVICE_AUTH_SIGNATURE_INVALID',
                    message: 'device signature invalid',
                    closeConnection: true
                };
            }
        }

        // If token provided, verify against pairing store
        if (auth?.token && device.id) {
            const result = this.pairingStore.verifyToken(device.id, auth.token);
            if (!result.ok) {
                // Token invalid, but connection is still valid (can re-pair)
                logger.warn(`${TAG} 无效的配对 token for device ${device.id}`);
            }
        }

        return { ok: true };
    }

    // ── Pairing methods ─────────────────────────────────────────────────

    private handlePairRequest(conn: ConnectionState, frame: RequestFrame, params: any): void {
        try {
            const result = this.pairingStore.requestPairing({
                nodeId: params.nodeId,
                displayName: params.displayName,
                platform: params.platform,
                version: params.version,
                deviceFamily: params.deviceFamily,
                modelIdentifier: params.modelIdentifier,
                caps: params.caps,
                commands: params.commands,
                shells: params.shells,
                defaultShell: params.defaultShell,
                workspace: params.workspace,
                remoteIp: conn.remoteIp,
                silent: params.silent
            });

            // Auto-approve local connections if configured
            if (result.created && this.config.autoApproveLocal && this.isLocalConnection(conn.remoteIp)) {
                const approveResult = this.pairingStore.approve(result.request.requestId);
                if (approveResult) {
                    logger.info(`${TAG} 自动审批本地配对: ${approveResult.node.nodeId}`);
                    // 发送配对成功通知
                    const displayName = approveResult.node.displayName ?? approveResult.node.nodeId;
                    NotificationManager.getInstance().info(
                        '设备管理',
                        t('device.notification.pairing-approved'),
                        t('device.notification.pairing-approved-detail', { displayName })
                    );
                    this.sendResponse(conn.socket, frame.id, true, {
                        status: 'approved',
                        request: result.request,
                        node: {
                            nodeId: approveResult.node.nodeId,
                            token: approveResult.node.token
                        },
                        created: true
                    });
                    this.broadcastToOperators('node.pair.resolved', {
                        requestId: result.request.requestId,
                        nodeId: approveResult.node.nodeId,
                        action: 'approved'
                    });
                    return;
                }
            }

            this.sendResponse(conn.socket, frame.id, true, result);

            if (result.created) {
                this.emitGatewayEvent('device:pairing-requested', {
                    requestId: result.request.requestId,
                    nodeId: result.request.nodeId,
                    displayName: result.request.displayName,
                    platform: result.request.platform
                });
                this.broadcastToOperators('node.pair.requested', result.request);
            }
        } catch (err: any) {
            this.sendResponse(conn.socket, frame.id, false, undefined, {
                code: 'PAIRING_ERROR',
                message: err?.message || 'pairing request failed'
            });
        }
    }

    private handlePairList(conn: ConnectionState, frame: RequestFrame): void {
        const list = this.pairingStore.list();
        // Strip tokens from paired list for security
        const sanitized = {
            pending: list.pending,
            paired: list.paired.map((n) => ({
                nodeId: n.nodeId,
                displayName: n.displayName,
                platform: n.platform,
                version: n.version,
                deviceFamily: n.deviceFamily,
                caps: n.caps,
                commands: n.commands,
                shells: n.shells,
                defaultShell: n.defaultShell,
                workspace: n.workspace,
                approvedAtMs: n.approvedAtMs,
                lastConnectedAtMs: n.lastConnectedAtMs
            }))
        };
        this.sendResponse(conn.socket, frame.id, true, sanitized);
    }

    private handlePairApprove(conn: ConnectionState, frame: RequestFrame, params: any): void {
        const result = this.pairingStore.approve(params.requestId);
        if (!result) {
            this.sendResponse(conn.socket, frame.id, false, undefined, {
                code: 'NOT_FOUND',
                message: 'pending request not found'
            });
            return;
        }
        this.sendResponse(conn.socket, frame.id, true, result);
        // 发送配对成功通知
        const displayName = result.node.displayName ?? result.node.nodeId;
        NotificationManager.getInstance().info(
            '设备管理',
            t('device.notification.pairing-approved'),
            t('device.notification.pairing-approved-detail', { displayName })
        );
        this.broadcastToOperators('node.pair.resolved', {
            requestId: result.requestId,
            nodeId: result.node.nodeId,
            action: 'approved'
        });
    }

    private handlePairReject(conn: ConnectionState, frame: RequestFrame, params: any): void {
        const result = this.pairingStore.reject(params.requestId);
        if (!result) {
            this.sendResponse(conn.socket, frame.id, false, undefined, {
                code: 'NOT_FOUND',
                message: 'pending request not found'
            });
            return;
        }
        this.sendResponse(conn.socket, frame.id, true, result);
        this.broadcastToOperators('node.pair.resolved', {
            requestId: result.requestId,
            nodeId: result.nodeId,
            action: 'rejected'
        });
    }

    private handlePairVerify(conn: ConnectionState, frame: RequestFrame, params: any): void {
        const result = this.pairingStore.verifyToken(params.nodeId, params.token);
        this.sendResponse(conn.socket, frame.id, true, {
            ok: result.ok,
            node: result.node
                ? {
                      nodeId: result.node.nodeId,
                      displayName: result.node.displayName,
                      platform: result.node.platform
                  }
                : undefined
        });
    }

    // ── Node management methods ─────────────────────────────────────────

    private handleNodeList(conn: ConnectionState, frame: RequestFrame): void {
        const connected = this.nodeRegistry.listConnected();
        const nodes = connected.map((n) => ({
            nodeId: n.nodeId,
            displayName: n.displayName,
            platform: n.platform,
            version: n.version,
            deviceFamily: n.deviceFamily,
            modelIdentifier: n.modelIdentifier,
            caps: n.caps,
            commands: n.commands,
            shells: n.shells,
            defaultShell: n.defaultShell,
            workspace: n.workspace,
            connectedAtMs: n.connectedAtMs
        }));
        this.sendResponse(conn.socket, frame.id, true, { nodes });
    }

    private handleNodeDescribe(conn: ConnectionState, frame: RequestFrame, params: any): void {
        const session = this.nodeRegistry.get(params.nodeId);
        if (!session) {
            const paired = this.pairingStore.getPaired(params.nodeId);
            if (paired) {
                this.sendResponse(conn.socket, frame.id, true, {
                    ...paired,
                    token: undefined,
                    connected: false
                });
                return;
            }
            this.sendResponse(conn.socket, frame.id, false, undefined, {
                code: 'NOT_FOUND',
                message: 'node not found'
            });
            return;
        }
        this.sendResponse(conn.socket, frame.id, true, {
            nodeId: session.nodeId,
            displayName: session.displayName,
            platform: session.platform,
            version: session.version,
            deviceFamily: session.deviceFamily,
            modelIdentifier: session.modelIdentifier,
            caps: session.caps,
            commands: session.commands,
            shells: session.shells,
            defaultShell: session.defaultShell,
            workspace: session.workspace,
            permissions: session.permissions,
            remoteIp: session.remoteIp,
            connectedAtMs: session.connectedAtMs,
            connected: true
        });
    }

    private handleNodeRename(conn: ConnectionState, frame: RequestFrame, params: any): void {
        const result = this.pairingStore.rename(params.nodeId, params.displayName);
        if (!result) {
            this.sendResponse(conn.socket, frame.id, false, undefined, {
                code: 'NOT_FOUND',
                message: 'paired node not found'
            });
            return;
        }
        this.sendResponse(conn.socket, frame.id, true, {
            nodeId: result.nodeId,
            displayName: result.displayName
        });
    }

    // ── Node invoke methods ─────────────────────────────────────────────

    private async handleNodeInvoke(conn: ConnectionState, frame: RequestFrame, params: any): Promise<void> {
        try {
            const result = await this.nodeRegistry.invoke({
                nodeId: params.nodeId,
                command: params.command,
                params: params.params,
                timeoutMs: params.timeoutMs,
                idempotencyKey: params.idempotencyKey
            });

            this.sendResponse(conn.socket, frame.id, true, result);

            this.emitGatewayEvent('device:command-result', {
                nodeId: params.nodeId,
                command: params.command,
                ok: result.ok
            });
        } catch (err: any) {
            this.sendResponse(conn.socket, frame.id, false, undefined, {
                code: 'INVOKE_ERROR',
                message: err?.message || 'invoke failed'
            });
        }
    }

    private handleNodeInvokeResult(conn: ConnectionState, frame: RequestFrame, params: any): void {
        const handled = this.nodeRegistry.handleInvokeResult({
            id: params.id,
            nodeId: params.nodeId,
            ok: params.ok,
            payload: params.payload,
            payloadJSON: params.payloadJSON,
            error: params.error
        });
        this.sendResponse(conn.socket, frame.id, true, { handled });
    }

    private handleNodeEvent(conn: ConnectionState, frame: RequestFrame, params: any): void {
        const eventName = params?.event;
        logger.info(`${TAG} 收到节点事件: ${eventName}`);

        // Handle node.presence.alive for keepalive tracking
        if (eventName === 'node.presence.alive') {
            const nodeId = conn.connectParams?.device?.id ?? conn.connectParams?.client?.id;
            if (nodeId) {
                this.pairingStore?.updateLastConnected(nodeId, {
                    remoteIp: conn.remoteIp
                });
            }
        }

        this.emitGatewayEvent('node:event', {
            connId: conn.connId,
            event: eventName,
            payload: params?.payload ?? params?.payloadJSON
        });

        this.sendResponse(conn.socket, frame.id, true, {});
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    private sendResponse(
        socket: WebSocket,
        id: string,
        ok: boolean,
        payload?: unknown,
        error?: { code: string; message: string; details?: unknown }
    ): void {
        const frame: ResponseFrame = { type: 'res', id, ok };
        if (ok) frame.payload = payload;
        else frame.error = error;
        try {
            socket.send(JSON.stringify(frame));
        } catch {
            // connection may already be closed
        }
    }

    /**
     * 向指定 WebSocket 发送事件帧。
     * 也可通过 sendEventToConnection(connId, ...) 按连接ID发送。
     */
    sendEvent(socket: WebSocket, event: string, payload?: unknown): void {
        const frame: EventFrame = { type: 'event', event, payload };
        try {
            socket.send(JSON.stringify(frame));
        } catch {
            // connection may already be closed
        }
    }

    /**
     * 按连接ID向客户端推送事件。
     * 如果连接不存在或已断开则静默忽略。
     */
    sendEventToConnection(connId: string, event: string, payload?: unknown): void {
        const conn = this.connections.get(connId);
        if (conn && conn.socket.readyState === conn.socket.OPEN) {
            this.sendEvent(conn.socket, event, payload);
        }
    }

    private broadcastToOperators(event: string, payload: unknown): void {
        for (const conn of this.connections.values()) {
            if (conn.handshakeState !== 'connected') continue;
            const role = conn.connectParams?.role;
            if (role === 'operator' || role === undefined) {
                this.sendEvent(conn.socket, event, payload);
            }
        }
    }

    private isLocalConnection(remoteIp?: string): boolean {
        if (!remoteIp) return false;
        return (
            remoteIp === '127.0.0.1' ||
            remoteIp === '::1' ||
            remoteIp === '::ffff:127.0.0.1' ||
            remoteIp === 'localhost'
        );
    }

    private emitGatewayEvent(event: string, payload: unknown): void {
        if (this.eventCallback) {
            try {
                this.eventCallback(event, payload);
            } catch {
                /* ignore callback errors */
            }
        }
    }
}
