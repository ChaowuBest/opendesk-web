import { BaseWorker } from "../base.js";
import { logger } from '../../utils/logger.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServerConfig, McpToolInfo } from './common.js';

interface McpConnection {
    client: Client;
    tools: { name: string; description: string; inputSchema?: object }[];
    status: 'disconnected' | 'connecting' | 'connected' | 'error';
    error?: string;
}

export default class McpMgrWorker extends BaseWorker {

    private servers: McpServerConfig[] = [];
    private connections: Map<string, McpConnection> = new Map();

    private parseServersFromConfig(): McpServerConfig[] {
        return (this.config as any)?.servers || [];
    }

    async initialize(): Promise<void> {
        this.servers = this.parseServersFromConfig();
        logger.info(`[mcpmgr] Initialized with ${this.servers.length} server configs`);

        for (const server of this.servers) {
            if (server.enabled) {
                this.connectServer(server.id).catch(err => {
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
        const newMap = new Map(newServers.map(s => [s.id, s]));
        const oldMap = new Map(oldServers.map(s => [s.id, s]));

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
                this.connectServer(id).catch(err => {
                    logger.error(`[mcpmgr] Connect failed for ${newServer.name}: ${err.message}`);
                });
            }
        }
    }

    private getConnectionState(id: string): { status: string; error?: string; tools: object[] } {
        const conn = this.connections.get(id);
        if (!conn) return { status: 'disconnected', tools: [] };
        return { status: conn.status, error: conn.error, tools: conn.tools };
    }

    async getServers(): Promise<object[]> {
        return this.servers.map(s => ({
            ...s,
            ...this.getConnectionState(s.id),
        }));
    }

    async connectServer(id: string): Promise<void> {
        const server = this.servers.find(s => s.id === id);
        if (!server) throw new Error('Server not found');

        if (this.connections.has(id)) {
            await this.disconnectServer(id);
        }

        const conn: McpConnection = {
            client: null as any,
            tools: [],
            status: 'connecting',
        };
        this.connections.set(id, conn);
        await this.emitEvent('serversUpdated');

        try {
            const transport = this.createTransport(server);

            const client = new Client({
                name: 'opendesk-mcpmgr',
                version: '1.0.0',
            });

            const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
                return Promise.race([
                    promise,
                    new Promise<never>((_, reject) =>
                        setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
                    ),
                ]);
            };

            logger.info(`[mcpmgr] Connecting to "${server.name}" (${server.transport})...`);
            await withTimeout(client.connect(transport), 30_000, 'connect');

            logger.info(`[mcpmgr] Connected to "${server.name}", listing tools...`);
            const toolsResult = await withTimeout(client.listTools(), 15_000, 'listTools');
            const tools = (toolsResult.tools || []).map(t => ({
                name: t.name,
                description: t.description || '',
                inputSchema: t.inputSchema || {},
            }));

            conn.client = client;
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

    private createTransport(server: McpServerConfig): any {
        const env = { ...process.env, ...(server.env || {}) };

        switch (server.transport) {
            case 'stdio':
                return new StdioClientTransport({
                    command: server.command!,
                    args: server.args || [],
                    cwd: server.cwd || undefined,
                    env,
                });
            case 'sse':
                return new SSEClientTransport(new URL(server.url!), {
                    requestInit: { headers: server.headers || {} },
                });
            case 'streamableHttp':
                return new StreamableHTTPClientTransport(new URL(server.url!), {
                    requestInit: { headers: server.headers || {} },
                });
            default:
                throw new Error(`Unsupported transport: ${server.transport}`);
        }
    }

    async disconnectServer(id: string): Promise<void> {
        const conn = this.connections.get(id);
        if (!conn) return;
        try {
            if (conn.client) await conn.client.close();
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
                    inputSchema: tool.inputSchema || {},
                });
            }
        }
        return tools;
    }

    async callMcpTool(serverId: string, toolName: string, args: object): Promise<string> {
        const conn = this.connections.get(serverId);
        if (!conn || conn.status !== 'connected') {
            throw new Error(`Server ${serverId} is not connected`);
        }

        const result = await conn.client.callTool({ name: toolName, arguments: args });

        if (result.content && Array.isArray(result.content)) {
            return result.content
                .map((c: any) => (c.type === 'text' ? c.text : JSON.stringify(c)))
                .join('\n');
        }
        return JSON.stringify(result);
    }
}
