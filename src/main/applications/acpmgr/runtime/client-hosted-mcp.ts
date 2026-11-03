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

import type {
    ConnectMcpRequest,
    ConnectMcpResponse,
    DisconnectMcpRequest,
    DisconnectMcpResponse,
    MessageMcpNotification,
    MessageMcpRequest
} from '@agentclientprotocol/sdk/experimental/v2';
import path from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { JSONRPCMessage, RequestId } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ClientWorkspaceRuntime } from './client-workspace.js';
import { OPENDESK_RUNTIME_VERSION } from '../../../utils/version.js';
import { t } from '../../../../locale/index.js';

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const MAX_COMMAND_TIMEOUT_MS = 30 * 60_000;
const MAX_MCP_CONNECTIONS = 8;

export interface AcpMcpPeer {
    request(params: MessageMcpRequest): Promise<unknown>;
    notify(params: MessageMcpNotification): Promise<void>;
}

export interface ClientHostedWorkspaceMcpOptions {
    serverId: string;
    workspace: ClientWorkspaceRuntime;
    sessionId: string;
}

interface PendingMcpRequest {
    resolve(value: unknown): void;
    reject(error: Error): void;
}

interface HostedMcpConnection {
    connectionId: string;
    peer: AcpMcpPeer;
    transport: InMemoryTransport;
    server: McpServer;
    pending: Map<RequestId, PendingMcpRequest>;
    nextRequestId: number;
}

function mcpError(message: string): Error {
    return new Error(message);
}

function asParams(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * SDK 对 JSONRPCResultResponse 的 result 要求是「对象 + 可选 _meta」。
 * peer.request 返回的 result 在类型上是 unknown，这里显式声明收窄目标，
 * 让断言有明确的落点（运行时不改写值，仍是原样透传）。
 */
type McpResultPayload = {
    [key: string]: unknown;
    _meta?: {
        progressToken?: string | number;
        'io.modelcontextprotocol/related-task'?: { taskId: string };
    };
};

export class ClientHostedWorkspaceMcp {
    readonly descriptor: { type: 'acp'; name: string; serverId: string };
    private readonly connections = new Map<string, HostedMcpConnection>();

    constructor(private readonly options: ClientHostedWorkspaceMcpOptions) {
        this.descriptor = { type: 'acp', name: 'OpenDesk workspace', serverId: options.serverId };
    }

    async connect(params: ConnectMcpRequest, peer: AcpMcpPeer): Promise<ConnectMcpResponse> {
        if (params.serverId !== this.options.serverId) throw mcpError(t('acpmgr.error.clientMcpServerNotFound'));
        if (this.connections.size >= MAX_MCP_CONNECTIONS) {
            throw mcpError(t('acpmgr.error.clientMcpConnectionLimit'));
        }
        const connectionId = crypto.randomUUID();
        const [transport, serverTransport] = InMemoryTransport.createLinkedPair();
        const connection: HostedMcpConnection = {
            connectionId,
            peer,
            transport,
            server: this.createServer(),
            pending: new Map(),
            nextRequestId: 0
        };
        transport.onmessage = (message) => this.handleServerMessage(connection, message);
        transport.onerror = (error) => this.failPending(connection, error);
        transport.onclose = () => this.failPending(connection, mcpError(t('acpmgr.error.clientMcpConnectionClosed')));
        await transport.start();
        await connection.server.connect(serverTransport);
        this.connections.set(connectionId, connection);
        return { connectionId };
    }

    async message(params: MessageMcpRequest): Promise<unknown> {
        const connection = this.requireConnection(params.connectionId);
        const id = ++connection.nextRequestId;
        const response = new Promise<unknown>((resolve, reject) => {
            connection.pending.set(id, { resolve, reject });
        });
        try {
            await connection.transport.send({
                jsonrpc: '2.0',
                id,
                method: params.method,
                ...(params.params ? { params: params.params } : {})
            });
        } catch (error) {
            connection.pending.delete(id);
            throw error;
        }
        return response;
    }

    async notify(params: MessageMcpNotification): Promise<void> {
        const connection = this.requireConnection(params.connectionId);
        await connection.transport.send({
            jsonrpc: '2.0',
            method: params.method,
            ...(params.params ? { params: params.params } : {})
        });
    }

    async disconnect(params: DisconnectMcpRequest): Promise<DisconnectMcpResponse> {
        const connection = this.requireConnection(params.connectionId);
        this.connections.delete(params.connectionId);
        await connection.server.close();
        this.failPending(connection, mcpError(t('acpmgr.error.clientMcpConnectionClosed')));
        return {};
    }

    async close(): Promise<void> {
        const connections = [...this.connections.values()];
        this.connections.clear();
        await Promise.allSettled(connections.map((connection) => connection.server.close()));
        for (const connection of connections) {
            this.failPending(connection, mcpError(t('acpmgr.error.clientMcpConnectionClosed')));
        }
    }

    private createServer(): McpServer {
        const server = new McpServer(
            { name: 'opendesk-workspace', version: OPENDESK_RUNTIME_VERSION },
            { capabilities: { tools: {} } }
        );
        server.registerTool(
            'read_text_file',
            {
                description: 'Read a UTF-8 text file inside the OpenDesk workspace',
                inputSchema: {
                    path: z.string(),
                    line: z.number().int().positive().optional(),
                    limit: z.number().int().nonnegative().optional()
                },
                annotations: { readOnlyHint: true, openWorldHint: false }
            },
            async ({ path, line, limit }) => {
                const result = await this.options.workspace.readTextFile({
                    sessionId: this.options.sessionId,
                    path: this.workspacePath(path),
                    ...(line !== undefined ? { line } : {}),
                    ...(limit !== undefined ? { limit } : {})
                });
                return { content: [{ type: 'text', text: result.content }] };
            }
        );
        server.registerTool(
            'write_text_file',
            {
                description: 'Create or replace a UTF-8 text file inside the OpenDesk workspace',
                inputSchema: { path: z.string(), content: z.string() },
                annotations: { destructiveHint: true, openWorldHint: false }
            },
            async ({ path, content }) => {
                const resolvedPath = this.workspacePath(path);
                await this.options.workspace.writeTextFile({
                    sessionId: this.options.sessionId,
                    path: resolvedPath,
                    content
                });
                return { content: [{ type: 'text', text: JSON.stringify({ path: resolvedPath, written: true }) }] };
            }
        );
        server.registerTool(
            'list_directory',
            {
                description: 'List entries in a directory inside the OpenDesk workspace',
                inputSchema: { path: z.string().optional() },
                annotations: { readOnlyHint: true, openWorldHint: false }
            },
            async ({ path }) => {
                const entries = await this.options.workspace.listDirectory(
                    this.options.sessionId,
                    this.workspacePath(path ?? '.')
                );
                return { content: [{ type: 'text', text: JSON.stringify({ entries }) }] };
            }
        );
        server.registerTool(
            'run_command',
            {
                description: 'Run one executable without a shell inside the OpenDesk workspace',
                inputSchema: {
                    command: z.string().min(1),
                    args: z.array(z.string()).optional(),
                    cwd: z.string().optional(),
                    env: z.record(z.string(), z.string()).optional(),
                    timeoutMs: z.number().int().positive().max(MAX_COMMAND_TIMEOUT_MS).optional(),
                    outputByteLimit: z.number().int().positive().optional()
                },
                annotations: { destructiveHint: true, openWorldHint: false }
            },
            async ({ command, args, cwd, env, timeoutMs, outputByteLimit }) => {
                const created = await this.options.workspace.createTerminal({
                    sessionId: this.options.sessionId,
                    command,
                    args,
                    cwd: this.workspacePath(cwd ?? '.'),
                    env: env ? Object.entries(env).map(([name, value]) => ({ name, value })) : undefined,
                    outputByteLimit
                });
                const timeout = Math.min(timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS);
                let timedOut = false;
                const timer = setTimeout(() => {
                    timedOut = true;
                    void this.options.workspace.killTerminal({
                        sessionId: this.options.sessionId,
                        terminalId: created.terminalId
                    });
                }, timeout);
                try {
                    const exit = await this.options.workspace.waitForTerminalExit({
                        sessionId: this.options.sessionId,
                        terminalId: created.terminalId
                    });
                    const output = await this.options.workspace.terminalOutput({
                        sessionId: this.options.sessionId,
                        terminalId: created.terminalId
                    });
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({ ...exit, ...output, timedOut })
                            }
                        ]
                    };
                } finally {
                    clearTimeout(timer);
                    await this.options.workspace.releaseTerminal({
                        sessionId: this.options.sessionId,
                        terminalId: created.terminalId
                    });
                }
            }
        );
        return server;
    }

    private handleServerMessage(connection: HostedMcpConnection, message: JSONRPCMessage): void {
        if ('id' in message && ('result' in message || 'error' in message)) {
            // SDK 的 JSONRPCErrorResponseSchema 把 id 声明为可选（协议允许解析错误响应的 id 缺省/为 null），
            // 这种响应不可能是某个 pending 请求的回执，直接丢弃（与 get(undefined) 必然未命中的既有行为一致）。
            const requestId = message.id;
            if (requestId === undefined) return;
            const pending = connection.pending.get(requestId);
            if (!pending) return;
            connection.pending.delete(requestId);
            if ('error' in message) {
                pending.reject(mcpError(message.error.message));
            } else {
                pending.resolve(message.result);
            }
            return;
        }
        if (!('method' in message)) return;
        if ('id' in message) {
            void connection.peer
                .request({
                    connectionId: connection.connectionId,
                    method: message.method,
                    params: asParams(message.params)
                })
                .then(
                    // peer.request 的 result 是 unknown 的 JSON-RPC 结果，透传前按协议形状（SDK 的
                    // JSONRPCResultResponse.result：对象 + 可选 _meta）断言，值本身原样透传
                    (result) =>
                        connection.transport.send({
                            jsonrpc: '2.0',
                            id: message.id,
                            result: result as McpResultPayload
                        }),
                    (error) =>
                        connection.transport.send({
                            jsonrpc: '2.0',
                            id: message.id,
                            error: { code: -32603, message: error instanceof Error ? error.message : String(error) }
                        })
                );
            return;
        }
        void connection.peer.notify({
            connectionId: connection.connectionId,
            method: message.method,
            params: asParams(message.params)
        });
    }

    private requireConnection(connectionId: string): HostedMcpConnection {
        const connection = this.connections.get(connectionId);
        if (!connection) throw mcpError(t('acpmgr.error.clientMcpConnectionNotFound'));
        return connection;
    }

    private workspacePath(input: string): string {
        return path.isAbsolute(input) ? input : path.resolve(this.options.workspace.root, input);
    }

    private failPending(connection: HostedMcpConnection, error: Error): void {
        for (const pending of connection.pending.values()) pending.reject(error);
        connection.pending.clear();
    }
}
