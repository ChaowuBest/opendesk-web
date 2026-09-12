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

import { BaseWorker } from '../base';
import { logger } from '../../utils/logger.js';
import iconv from 'iconv-lite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { McpServerConfig, McpToolInfo } from './common.js';
import { getPlatform } from '../../../platforms/base.js';
import { buildChildProcessEnv } from '../../utils/shellExec.js';
import { t } from '../../../locale/index.js';
import {
    getHarmonyLocalRuntimeState,
    getHarmonyStdioCommandAvailability,
    type HarmonyLocalRuntimeFeatureAvailability,
    type HarmonyLocalRuntimeState
} from '../../../platforms/bridges/harmonyos/local-runtime.js';

export function getMcpServerLocalRuntimeAvailability(
    server: McpServerConfig,
    state: HarmonyLocalRuntimeState | null = getHarmonyLocalRuntimeState()
): HarmonyLocalRuntimeFeatureAvailability {
    return server.transport === 'stdio'
        ? getHarmonyStdioCommandAvailability(server.command, state)
        : { available: true, reason: null, missing: [] };
}

function getLocalRuntimeUnavailableMessage(availability: HarmonyLocalRuntimeFeatureAvailability): string {
    return availability.reason === 'tablet-local-runtime-disabled'
        ? t('harmony.localRuntime.tabletUnavailable')
        : t('harmony.localRuntime.pcMissing', { capabilities: availability.missing.join(', ') });
}

interface McpConnection {
    client: Client;
    tools: { name: string; description: string; inputSchema?: object }[];
    status: 'disconnected' | 'connecting' | 'connected' | 'error';
    error?: string;
    refreshingTools?: Promise<void>;
    toolsChangedCount?: number;
    lastToolsChangedAt?: string;
}

export default class McpMgrWorker extends BaseWorker {
    private readonly localRuntimeState: HarmonyLocalRuntimeState | null;
    private servers: McpServerConfig[] = [];
    private configuredServers: McpServerConfig[] = [];
    private agentServers: McpServerConfig[] = [];
    private pendingAgentConnections = new Map<string, Promise<void>>();
    private connections: Map<string, McpConnection> = new Map();
    private currentWorkspace?: string;

    constructor(
        bundleName: string,
        appDataDirectory: string,
        localRuntimeState: HarmonyLocalRuntimeState | null = getHarmonyLocalRuntimeState()
    ) {
        super(bundleName, appDataDirectory);
        this.localRuntimeState = localRuntimeState;
    }

    private parseServersFromConfig(): McpServerConfig[] {
        return (this.config as any)?.servers || [];
    }

    async initialize(): Promise<void> {
        this.configuredServers = this.parseServersFromConfig();
        this.servers = [...this.configuredServers];
        logger.info(`[mcpmgr] Initialized with ${this.servers.length} server configs`);

        // 启动时自动连接已启用的 server，失败后延迟重试
        for (const server of this.servers) {
            if (server.enabled) {
                const availability = getMcpServerLocalRuntimeAvailability(server, this.localRuntimeState);
                if (!availability.available) {
                    this.setLocalRuntimeUnavailable(server, availability);
                    continue;
                }
                this.autoConnectWithRetry(server.id, server.name);
            }
        }
    }

    private setLocalRuntimeUnavailable(
        server: McpServerConfig,
        availability: HarmonyLocalRuntimeFeatureAvailability
    ): void {
        const error = getLocalRuntimeUnavailableMessage(availability);
        this.connections.set(server.id, {
            client: null as any,
            tools: [],
            status: 'error',
            error
        });
        logger.warn(`[mcpmgr] Local runtime unavailable for "${server.name}": ${availability.reason}`);
    }

    /**
     * 启动时自动重连：首次失败后延迟 3s / 10s 各重试一次，
     * 应对某些 MCP 命令（如 npx）在应用启动时 PATH 尚未就绪的场景。
     */
    private autoConnectWithRetry(id: string, name: string, attempt: number = 1): void {
        const delays = [0, 3_000, 10_000];
        const delay = delays[attempt - 1] ?? 0;

        setTimeout(() => {
            this.connectServer(id).catch((err) => {
                logger.error(`[mcpmgr] Auto-connect failed for "${name}" (attempt ${attempt}): ${err.message}`);
                if (attempt < delays.length) {
                    this.autoConnectWithRetry(id, name, attempt + 1);
                }
            });
        }, delay);
    }

    async finalize(): Promise<void> {
        const tasks = [];
        for (const [id] of this.connections) {
            tasks.push(this.disconnectServer(id));
        }
        await Promise.allSettled(tasks);
    }

    async applicationConfigChanged(config: object): Promise<void> {
        await super.applicationConfigChanged(config);
        this.configuredServers = this.parseServersFromConfig();
        const newServers = [...this.configuredServers, ...this.agentServers];
        const oldServers = this.servers;
        this.servers = newServers;
        await this.syncConnections(newServers, oldServers);
        await this.emitEvent('serversUpdated');
    }

    async replaceAgentServers(servers: McpServerConfig[]): Promise<void> {
        const oldServers = this.servers;
        this.agentServers = servers.map((server) => ({
            ...server,
            agentIds: server.agentIds ? [...server.agentIds] : []
        }));
        this.servers = [...this.configuredServers, ...this.agentServers];
        await this.syncConnections(this.servers, oldServers);
        await this.emitEvent('serversUpdated');
    }

    private async syncConnections(newServers: McpServerConfig[], oldServers: McpServerConfig[]): Promise<void> {
        const newMap = new Map(newServers.map((s) => [s.id, s]));
        const oldMap = new Map(oldServers.map((s) => [s.id, s]));

        for (const [id] of oldMap) {
            const newServer = newMap.get(id);
            if (!newServer || !newServer.enabled) {
                if (this.connections.has(id)) {
                    await this.disconnectServer(id);
                }
            }
        }

        for (const [id, newServer] of newMap) {
            if (!newServer.enabled) continue;
            const oldServer = oldMap.get(id);
            const configChanged = !oldServer || JSON.stringify(newServer) !== JSON.stringify(oldServer);

            if (configChanged) {
                if (this.connections.has(id)) {
                    await this.disconnectServer(id);
                }
                const connection = this.connectServer(id).catch((err) => {
                    logger.error(`[mcpmgr] Connect failed for ${newServer.name}: ${err.message}`);
                });
                if (newServer.agentIds !== undefined) {
                    const trackedConnection: Promise<void> = connection.finally(() => {
                        if (this.pendingAgentConnections.get(id) === trackedConnection) {
                            this.pendingAgentConnections.delete(id);
                        }
                    });
                    this.pendingAgentConnections.set(id, trackedConnection);
                }
            }
        }
    }

    private getConnectionState(id: string): {
        status: string;
        error?: string;
        tools: object[];
        toolsChangedCount?: number;
        lastToolsChangedAt?: string;
    } {
        const conn = this.connections.get(id);
        if (!conn) return { status: 'disconnected', tools: [] };
        return {
            status: conn.status,
            error: conn.error,
            tools: conn.tools,
            toolsChangedCount: conn.toolsChangedCount,
            lastToolsChangedAt: conn.lastToolsChangedAt
        };
    }

    async getServers(): Promise<object[]> {
        return this.servers.map((s) => ({
            ...s,
            ...this.getConnectionState(s.id)
        }));
    }

    async ensureWorkspace(workspace: string): Promise<void> {
        if (!workspace || this.currentWorkspace === workspace) return;

        this.currentWorkspace = workspace;
        const reconnects = this.servers
            .filter((server) => server.enabled && server.transport === 'stdio' && !server.cwd)
            .map((server) =>
                this.connectServer(server.id, workspace).catch((err) => {
                    logger.error(`[mcpmgr] Workspace reconnect failed for ${server.name}: ${err.message}`);
                })
            );

        await Promise.allSettled(reconnects);
    }

    async connectServer(id: string, workspace?: string): Promise<void> {
        const server = this.servers.find((s) => s.id === id);
        if (!server) throw new Error('Server not found');

        if (workspace) {
            this.currentWorkspace = workspace;
        }

        if (this.connections.has(id)) {
            await this.disconnectServer(id);
        }

        const availability = getMcpServerLocalRuntimeAvailability(server, this.localRuntimeState);
        if (!availability.available) {
            this.setLocalRuntimeUnavailable(server, availability);
            await this.emitEvent('serversUpdated');
            return;
        }

        const conn: McpConnection = {
            client: null as any,
            tools: [],
            status: 'connecting'
        };
        this.connections.set(id, conn);
        await this.emitEvent('serversUpdated');

        // 收集 stdio 子进程的 stderr，用于诊断连接失败原因
        const stderrChunks: string[] = [];

        try {
            const transport = this.createTransport(server);

            if (transport.stderr) {
                transport.stderr.on('data', (chunk: Buffer) => {
                    stderrChunks.push(chunk.toString());
                });
            }

            const client = new Client({
                name: 'opendesk-mcpmgr',
                version: '1.0.0'
            });

            conn.client = client;
            client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
                this.handleToolsListChanged(server.id).catch((err) => {
                    logger.warn(`[mcpmgr] Failed to refresh tools for "${server.name}": ${err.message}`);
                });
            });

            logger.info(`[mcpmgr] Connecting to "${server.name}" (${server.transport})...`);
            await this.withTimeout(client.connect(transport), 30_000, 'connect');

            logger.info(`[mcpmgr] Connected to "${server.name}", listing tools...`);
            const tools = await this.listClientTools(client);

            conn.tools = tools;
            conn.status = 'connected';
            // 连接成功后不再需要收集 stderr
            if (transport.stderr) {
                transport.stderr.removeAllListeners('data');
            }

            logger.info(`[mcpmgr] Connected to "${server.name}", discovered ${tools.length} tools`);
        } catch (err: any) {
            conn.status = 'error';
            conn.error = this.buildConnectionError(server, err, stderrChunks || []);
            logger.error(`[mcpmgr] Connection to "${server.name}" failed: ${conn.error}`);
        }

        await this.emitEvent('serversUpdated');
    }

    /**
     * 构建用户友好的连接错误信息。
     * - 检测 ENOENT（命令未找到）给出明确的路径提示
     * - 附加上子进程 stderr 中的关键诊断信息
     */
    private buildConnectionError(server: McpServerConfig, err: any, stderrChunks: string[]): string {
        const parts: string[] = [];

        // 检测命令未找到 (ENOENT)
        if (err.code === 'ENOENT' || err.message?.includes('ENOENT') || err.message?.includes('spawn')) {
            parts.push(`命令未找到: ${server.command || '(未知)'}`);
            parts.push('请确认命令路径正确且已安装对应的运行时（如 Node.js、Python、uvx 等）');
        } else {
            parts.push(err.message || '未知错误');
        }

        // 附加 stderr 中的关键信息（过滤掉空行和纯空白行）
        const stderrText = stderrChunks.join('').trim();
        if (stderrText) {
            // 截取前 500 字符，避免日志过长
            const truncated = stderrText.length > 500 ? stderrText.slice(0, 500) + '…' : stderrText;
            parts.push(`[stderr] ${truncated}`);
        }

        return parts.join('\n');
    }

    private withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
            timeout.unref?.();
        });
        return Promise.race([promise, timeoutPromise]).finally(() => {
            if (timeout) clearTimeout(timeout);
        });
    }

    private async listClientTools(
        client: Client
    ): Promise<{ name: string; description: string; inputSchema?: object }[]> {
        const toolsResult = await this.withTimeout(client.listTools(), 15_000, 'listTools');
        return (toolsResult.tools || []).map((t) => ({
            name: t.name,
            description: t.description || '',
            inputSchema: t.inputSchema || {}
        }));
    }

    private async handleToolsListChanged(id: string): Promise<void> {
        const server = this.servers.find((s) => s.id === id);
        const conn = this.connections.get(id);
        if (!server || !conn || !conn.client || conn.status !== 'connected') return;

        if (conn.refreshingTools) {
            await conn.refreshingTools;
            return;
        }

        conn.refreshingTools = (async () => {
            logger.info(`[mcpmgr] "${server.name}" sent tools/list_changed notification, refreshing tools...`);
            conn.tools = await this.listClientTools(conn.client);
            conn.error = undefined;
            conn.toolsChangedCount = (conn.toolsChangedCount || 0) + 1;
            conn.lastToolsChangedAt = new Date().toISOString();
            logger.info(`[mcpmgr] Refreshed "${server.name}" tools, discovered ${conn.tools.length} tools`);
            await this.emitEvent('serversUpdated');
        })().finally(() => {
            conn.refreshingTools = undefined;
        });

        await conn.refreshingTools;
    }

    /**
     * 创建支持系统代理的 fetch 函数。
     * 委托给平台 fetch，由各平台继承系统代理配置。
     */
    private createProxyFetch(): ((url: URL | string, init?: RequestInit) => Promise<Response>) | undefined {
        return (url: URL | string, init?: RequestInit) => {
            const urlString = typeof url === 'string' ? url : url instanceof URL ? url.href : (url as Request).url;
            return getPlatform().fetch(urlString, init);
        };
    }

    private createTransport(server: McpServerConfig): any {
        switch (server.transport) {
            case 'stdio': {
                const env: Record<string, string> = {};
                for (const [key, value] of Object.entries(buildChildProcessEnv(server.env))) {
                    if (value !== undefined) {
                        env[key] = value;
                    }
                }
                const transport = new StdioClientTransport({
                    command: server.command!,
                    args: server.args || [],
                    cwd: server.cwd || this.currentWorkspace || undefined,
                    env,
                    stderr: 'pipe' // 捕获子进程stderr，避免泄漏到主进程stdout/stderr
                });
                transport.stderr?.resume();
                return transport;
            }
            case 'sse': {
                const proxyFetch = this.createProxyFetch();
                const serverHeaders = server.headers
                    ? Object.fromEntries(
                          Object.entries(server.headers).map(([k, v]) => [
                              k,
                              iconv.encode(v, 'latin1').toString('latin1')
                          ])
                      )
                    : {};
                return new SSEClientTransport(new URL(server.url!), {
                    requestInit: { headers: serverHeaders },
                    fetch: proxyFetch
                });
            }
            case 'streamableHttp': {
                const proxyFetch = this.createProxyFetch();
                const serverHeaders = server.headers
                    ? Object.fromEntries(
                          Object.entries(server.headers).map(([k, v]) => [
                              k,
                              iconv.encode(v, 'latin1').toString('latin1')
                          ])
                      )
                    : {};
                return new StreamableHTTPClientTransport(new URL(server.url!), {
                    requestInit: { headers: serverHeaders },
                    fetch: proxyFetch
                });
            }
            default:
                throw new Error(`Unsupported transport: ${server.transport}`);
        }
    }

    async disconnectServer(id: string): Promise<void> {
        const conn = this.connections.get(id);
        if (!conn) return;
        try {
            if (conn.client) await this.withTimeout(conn.client.close(), 6_000, 'disconnect');
        } catch (e: any) {
            logger.warn(`[mcpmgr] Error closing client for ${id}: ${e.message}`);
        }
        this.connections.delete(id);
    }

    async reconnectServer(id: string): Promise<void> {
        await this.disconnectServer(id);
        await this.connectServer(id);
    }

    async getDiscoveredTools(): Promise<McpToolInfo[]> {
        await Promise.allSettled(this.pendingAgentConnections.values());
        const tools: McpToolInfo[] = [];
        for (const server of this.servers) {
            if (!server.enabled) continue;
            const conn = this.connections.get(server.id);
            if (!conn || conn.status !== 'connected') continue;
            for (const tool of conn.tools) {
                tools.push({
                    serverId: server.id,
                    serverName: server.name,
                    name: tool.name,
                    description: tool.description,
                    inputSchema: tool.inputSchema || {},
                    agentIds: server.agentIds
                });
            }
        }
        return tools;
    }

    async callMcpTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<string> {
        const conn = this.connections.get(serverId);
        if (!conn || conn.status !== 'connected') {
            throw new Error(`Server ${serverId} is not connected`);
        }

        const result = await conn.client.callTool({ name: toolName, arguments: args }, undefined, {
            timeout: 180_000,
            resetTimeoutOnProgress: true,
            maxTotalTimeout: 300_000
        });

        if (result.content && Array.isArray(result.content)) {
            return result.content.map((c: any) => (c.type === 'text' ? c.text : JSON.stringify(c))).join('\n');
        }
        return JSON.stringify(result);
    }
}
