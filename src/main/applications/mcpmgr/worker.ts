import { BaseWorker } from '../base';
import { logger } from '../../utils/logger.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { McpServerConfig, McpToolInfo } from './common.js';
import { getPlatform } from '../../../platforms/base.js';

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
    private servers: McpServerConfig[] = [];
    private connections: Map<string, McpConnection> = new Map();
    private currentWorkspace?: string;

    private parseServersFromConfig(): McpServerConfig[] {
        return (this.config as any)?.servers || [];
    }

    async initialize(): Promise<void> {
        this.servers = this.parseServersFromConfig();
        logger.info(`[mcpmgr] Initialized with ${this.servers.length} server configs`);

        for (const server of this.servers) {
            if (server.enabled) {
                this.connectServer(server.id).catch((err) => {
                    logger.error(`[mcpmgr] Auto-connect failed for ${server.name}: ${err.message}`);
                });
            }
        }
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
        const newServers = this.parseServersFromConfig();
        const oldServers = this.servers;
        this.servers = newServers;
        await this.syncConnections(newServers, oldServers);
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
                this.connectServer(id).catch((err) => {
                    logger.error(`[mcpmgr] Connect failed for ${newServer.name}: ${err.message}`);
                });
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

        const conn: McpConnection = {
            client: null as any,
            tools: [],
            status: 'connecting'
        };
        this.connections.set(id, conn);
        await this.emitEvent('serversUpdated');

        try {
            const transport = this.createTransport(server);

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

            logger.info(`[mcpmgr] Connected to "${server.name}", discovered ${tools.length} tools`);
        } catch (err: any) {
            conn.status = 'error';
            conn.error = err.message;
            logger.error(`[mcpmgr] Connection to "${server.name}" failed: ${err.message}`);
        }

        await this.emitEvent('serversUpdated');
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
                // 继承系统环境变量，并合并用户自定义的环境变量
                const env: Record<string, string> = {};
                for (const [key, value] of Object.entries(process.env)) {
                    if (value !== undefined) {
                        env[key] = value;
                    }
                }
                for (const [key, value] of Object.entries(server.env || {})) {
                    env[key] = value;
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
                return new SSEClientTransport(new URL(server.url!), {
                    requestInit: { headers: server.headers || {} },
                    fetch: proxyFetch
                });
            }
            case 'streamableHttp': {
                const proxyFetch = this.createProxyFetch();
                return new StreamableHTTPClientTransport(new URL(server.url!), {
                    requestInit: { headers: server.headers || {} },
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
                    inputSchema: tool.inputSchema || {}
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

        const result = await conn.client.callTool({ name: toolName, arguments: args });

        if (result.content && Array.isArray(result.content)) {
            return result.content.map((c: any) => (c.type === 'text' ? c.text : JSON.stringify(c))).join('\n');
        }
        return JSON.stringify(result);
    }
}
