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
 * 在线节点注册表。
 * 跟踪当前 WebSocket 已连接的节点，支持命令调用和事件推送。
 */

import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import type {
    ConnectParams,
    NodeSession,
    NodeInvokeResult,
    NodeInvokeRequestEvent,
} from './common.js';
import { DEFAULT_INVOKE_TIMEOUT_MS } from './common.js';

type PendingInvoke = {
    nodeId: string;
    command: string;
    resolve: (value: NodeInvokeResult) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
};

export class NodeRegistry {

    private nodesById = new Map<string, NodeSession>();
    private nodesByConn = new Map<string, string>();
    private pendingInvokes = new Map<string, PendingInvoke>();

    /**
     * 注册一个新连接的节点。
     */
    register(socket: WebSocket, connId: string, connect: ConnectParams, remoteIp?: string): NodeSession {
        const nodeId = connect.device?.id ?? connect.client.id;
        const caps = Array.isArray(connect.caps) ? connect.caps : [];
        const commands = Array.isArray(connect.commands) ? connect.commands : [];
        const permissions = typeof connect.permissions === 'object' ? connect.permissions : undefined;

        const session: NodeSession = {
            nodeId,
            connId,
            socket,
            connect,
            displayName: connect.client.displayName,
            platform: connect.client.platform,
            version: connect.client.version,
            deviceFamily: connect.client.deviceFamily,
            modelIdentifier: connect.client.modelIdentifier,
            remoteIp,
            caps,
            commands,
            permissions,
            connectedAtMs: Date.now(),
        };

        this.nodesById.set(nodeId, session);
        this.nodesByConn.set(connId, nodeId);
        return session;
    }

    /**
     * 注销节点（断开连接时调用），同时清理所有挂起的 invoke。
     */
    unregister(connId: string): string | null {
        const nodeId = this.nodesByConn.get(connId);
        if (!nodeId) return null;

        this.nodesByConn.delete(connId);
        this.nodesById.delete(nodeId);

        for (const [id, pending] of this.pendingInvokes.entries()) {
            if (pending.nodeId !== nodeId) continue;
            clearTimeout(pending.timer);
            pending.reject(new Error(`node disconnected (${pending.command})`));
            this.pendingInvokes.delete(id);
        }
        return nodeId;
    }

    listConnected(): NodeSession[] {
        return [...this.nodesById.values()];
    }

    get(nodeId: string): NodeSession | undefined {
        return this.nodesById.get(nodeId);
    }

    getByConn(connId: string): NodeSession | undefined {
        const nodeId = this.nodesByConn.get(connId);
        return nodeId ? this.nodesById.get(nodeId) : undefined;
    }

    /**
     * 向连接的节点发送命令调用。
     * 发送 `node.invoke.request` 事件并等待 `node.invoke.result`。
     */
    async invoke(params: {
        nodeId: string;
        command: string;
        params?: unknown;
        timeoutMs?: number;
        idempotencyKey?: string;
    }): Promise<NodeInvokeResult> {
        const node = this.nodesById.get(params.nodeId);
        if (!node) {
            return {
                ok: false,
                error: { code: 'NOT_CONNECTED', message: 'node not connected' },
            };
        }

        const requestId = randomUUID();
        const eventPayload: NodeInvokeRequestEvent = {
            id: requestId,
            nodeId: params.nodeId,
            command: params.command,
            paramsJSON: params.params !== undefined ? JSON.stringify(params.params) : null,
            timeoutMs: params.timeoutMs,
            idempotencyKey: params.idempotencyKey ?? randomUUID(),
        };

        const sent = this.sendEvent(node, 'node.invoke.request', eventPayload);
        if (!sent) {
            return {
                ok: false,
                error: { code: 'UNAVAILABLE', message: 'failed to send invoke to node' },
            };
        }

        const timeoutMs = typeof params.timeoutMs === 'number' ? params.timeoutMs : DEFAULT_INVOKE_TIMEOUT_MS;
        return new Promise<NodeInvokeResult>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingInvokes.delete(requestId);
                resolve({
                    ok: false,
                    error: { code: 'TIMEOUT', message: 'node invoke timed out' },
                });
            }, timeoutMs);

            this.pendingInvokes.set(requestId, {
                nodeId: params.nodeId,
                command: params.command,
                resolve,
                reject,
                timer,
            });
        });
    }

    /**
     * 处理节点返回的 invoke 结果。
     */
    handleInvokeResult(params: {
        id: string;
        nodeId: string;
        ok: boolean;
        payload?: unknown;
        payloadJSON?: string | null;
        error?: { code?: string; message?: string } | null;
    }): boolean {
        const pending = this.pendingInvokes.get(params.id);
        if (!pending) return false;
        if (pending.nodeId !== params.nodeId) return false;

        clearTimeout(pending.timer);
        this.pendingInvokes.delete(params.id);
        pending.resolve({
            ok: params.ok,
            payload: params.payload,
            payloadJSON: params.payloadJSON ?? null,
            error: params.error ?? null,
        });
        return true;
    }

    /**
     * 向指定节点发送事件。
     */
    sendEventToNode(nodeId: string, event: string, payload?: unknown): boolean {
        const node = this.nodesById.get(nodeId);
        if (!node) return false;
        return this.sendEvent(node, event, payload);
    }

    private sendEvent(node: NodeSession, event: string, payload: unknown): boolean {
        try {
            node.socket.send(JSON.stringify({
                type: 'event',
                event,
                payload,
            }));
            return true;
        } catch {
            return false;
        }
    }
}
