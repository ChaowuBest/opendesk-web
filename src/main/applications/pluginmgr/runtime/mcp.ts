/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { BaseTool, BaseToolset } from '../../../aikernel/tool.js';
import { getPlatform } from '../../../../platforms/base.js';
import { mergeGlobalEnviron } from '../../../utils/shellExec.js';
import { logger } from '../../../utils/logger.js';
import { notifyMcpServerProvidersChanged, registerMcpServerProvider } from '../../mcpmgr/provider.js';
import type { McpServerState } from '../../mcpmgr/common.js';
import { getPluginHost, type VisiblePluginContribution } from './host.js';
import { getLocale } from '../../../../locale/index.js';
import {
    resolvePluginDisplayName,
    type PluginMcpServerDefinition
} from '../../../../../packages/plugin-sdk/src/index.js';
import { sanitizeModelToolName } from './tool-names.js';

interface DiscoveredTool {
    name: string;
    description: string;
    inputSchema: object;
}

interface Connection {
    client: Client;
    tools: DiscoveredTool[];
    connecting?: Promise<void>;
}

function safeName(value: string): string {
    return value.replace(/[^a-zA-Z0-9_]/g, '_');
}

function formatMcpResult(result: Awaited<ReturnType<Client['callTool']>>): string {
    if (!Array.isArray(result.content)) return JSON.stringify(result);
    return result.content
        .map((content) => (content.type === 'text' ? content.text : JSON.stringify(content)))
        .join('\n');
}

class PluginMcpRuntime {
    private readonly connections = new Map<string, Connection>();
    private readonly retryAfter = new Map<string, number>();
    private readonly lastErrors = new Map<string, string>();

    constructor() {
        getPluginHost().onMcpServerRemoved(async (id) => {
            await this.disconnect(id);
            notifyPluginMcpServersChanged();
        });
    }

    async getToolsets(workspace?: string): Promise<BaseToolset[]> {
        await this.prune();
        const contributions = getPluginHost().listMcpServers();
        await Promise.all(contributions.map((contribution) => this.ensureConnected(contribution, workspace)));

        const grouped = new Map<string, BaseToolset>();
        for (const contribution of contributions) {
            const connection = this.connections.get(contribution.id);
            if (!connection) continue;
            const toolset =
                grouped.get(contribution.pluginId) ??
                new BaseToolset(`plugin-mcp-${sanitizeModelToolName(contribution.pluginId)}`);
            grouped.set(contribution.pluginId, toolset);
            for (const discovered of connection.tools) {
                let parameters: z.ZodType;
                try {
                    parameters = z.fromJSONSchema(discovered.inputSchema as any);
                } catch {
                    parameters = z.object({}).passthrough();
                }
                const tool = new BaseTool(
                    `${safeName(contribution.definition.name)}__${safeName(discovered.name)}`,
                    `[MCP: ${contribution.definition.name}] ${discovered.description}`,
                    parameters
                );
                tool.setExecutor(async (args) => {
                    if (!getPluginHost().hasMcpServer(contribution.id)) {
                        throw new Error('plugin.mcp_not_connected');
                    }
                    const active = this.connections.get(contribution.id);
                    if (!active) throw new Error('plugin.mcp_not_connected');
                    const result = await active.client.callTool(
                        {
                            name: discovered.name,
                            arguments: args as Record<string, unknown>
                        },
                        undefined,
                        { timeout: 180_000, resetTimeoutOnProgress: true, maxTotalTimeout: 300_000 }
                    );
                    return formatMcpResult(result);
                });
                toolset.addTool(tool);
            }
        }
        return Array.from(grouped.values());
    }

    async getServers(): Promise<McpServerState[]> {
        await this.prune();
        const contributions = getPluginHost().listMcpServers();
        await Promise.all(contributions.map((contribution) => this.ensureConnected(contribution)));
        return contributions.map((contribution) => {
            const definition = contribution.definition;
            const pluginName =
                resolvePluginDisplayName(getPluginHost().get(contribution.pluginId)?.displayName, getLocale()) ??
                contribution.pluginId;
            const connection = this.connections.get(contribution.id);
            const status = connection?.connecting
                ? 'connecting'
                : connection
                  ? 'connected'
                  : this.lastErrors.has(contribution.id)
                    ? 'error'
                    : 'disconnected';
            return {
                id: contribution.id,
                name: definition.name,
                transport: definition.transport,
                enabled: true,
                command: definition.transport === 'stdio' ? definition.command : undefined,
                args: definition.transport === 'stdio' ? definition.args : undefined,
                cwd: definition.transport === 'stdio' ? definition.cwd : undefined,
                url: definition.transport === 'stdio' ? undefined : definition.url,
                env: definition.transport === 'stdio' ? definition.env : undefined,
                headers: definition.transport === 'stdio' ? undefined : definition.headers,
                source: pluginName,
                providerId: 'pluginMgr',
                readOnly: true,
                status,
                error: this.lastErrors.get(contribution.id),
                tools: connection?.tools ?? []
            };
        });
    }

    async dispose(): Promise<void> {
        const connections = Array.from(this.connections.values());
        this.connections.clear();
        this.retryAfter.clear();
        this.lastErrors.clear();
        await Promise.allSettled(
            connections.map((connection) =>
                this.withTimeout(connection.client.close(), 3_000, 'plugin.mcp_close_timeout')
            )
        );
    }

    private async prune(): Promise<void> {
        const stale = Array.from(this.connections.entries()).filter(([id]) => !getPluginHost().hasMcpServer(id));
        for (const [id] of stale) await this.disconnect(id);
    }

    private async disconnect(id: string): Promise<void> {
        const connection = this.connections.get(id);
        this.connections.delete(id);
        this.retryAfter.delete(id);
        this.lastErrors.delete(id);
        if (!connection) return;
        await this.withTimeout(connection.client.close(), 3_000, 'plugin.mcp_close_timeout').catch(() => undefined);
    }

    private async ensureConnected(
        contribution: VisiblePluginContribution<PluginMcpServerDefinition>,
        workspace?: string
    ): Promise<void> {
        const existing = this.connections.get(contribution.id);
        if (existing?.connecting) return await existing.connecting;
        if (existing) return;
        if ((this.retryAfter.get(contribution.id) ?? 0) > Date.now()) return;

        const client = new Client({ name: `opendesk-plugin-${contribution.pluginId}`, version: '1.0.0' });
        const connection: Connection = { client, tools: [] };
        this.connections.set(contribution.id, connection);
        connection.connecting = (async () => {
            client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
                await this.refreshTools(connection).catch((error) => {
                    logger.error('Plugin MCP tool refresh failed', error);
                });
            });
            await this.withTimeout(
                client.connect(this.createTransport(contribution.definition, workspace)),
                15_000,
                'plugin.mcp_connect_timeout'
            );
            await this.withTimeout(this.refreshTools(connection), 10_000, 'plugin.mcp_list_tools_timeout');
            this.retryAfter.delete(contribution.id);
            this.lastErrors.delete(contribution.id);
        })()
            .catch(async (error) => {
                this.connections.delete(contribution.id);
                this.retryAfter.set(contribution.id, Date.now() + 30_000);
                this.lastErrors.set(contribution.id, error instanceof Error ? error.message : String(error));
                getPluginHost().recordMcpError(contribution.id, error);
                await this.withTimeout(client.close(), 3_000, 'plugin.mcp_close_timeout').catch(() => undefined);
                logger.error(
                    `Plugin MCP connection failed: ${contribution.pluginId}:${contribution.definition.name}`,
                    error
                );
            })
            .finally(() => {
                connection.connecting = undefined;
                notifyPluginMcpServersChanged();
            });
        await connection.connecting;
    }

    private async refreshTools(connection: Connection): Promise<void> {
        const result = await connection.client.listTools();
        connection.tools = (result.tools ?? []).map((tool) => ({
            name: tool.name,
            description: tool.description ?? '',
            inputSchema: tool.inputSchema ?? {}
        }));
        notifyPluginMcpServersChanged();
    }

    private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, code: string): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(code)), timeoutMs);
            timer.unref?.();
        });
        return await Promise.race([promise, timeout]).finally(() => {
            if (timer) clearTimeout(timer);
        });
    }

    private createTransport(definition: PluginMcpServerDefinition, workspace?: string) {
        if (definition.transport === 'stdio') {
            const env: Record<string, string> = {};
            let mergedEnv: NodeJS.ProcessEnv = process.env;
            try {
                mergedEnv = mergeGlobalEnviron() ?? process.env;
            } catch {
                // Headless embedding may register plugins before a platform implementation is initialized.
            }
            for (const [key, value] of Object.entries(mergedEnv)) {
                if (value !== undefined) env[key] = value;
            }
            Object.assign(env, definition.env ?? {});
            const transport = new StdioClientTransport({
                command: definition.command,
                args: definition.args ?? [],
                cwd: definition.cwd ?? workspace,
                env,
                stderr: 'pipe'
            });
            transport.stderr?.resume();
            return transport;
        }
        const fetch = (url: URL | string, init?: RequestInit) =>
            getPlatform().fetch(typeof url === 'string' ? url : url.href, init);
        if (definition.transport === 'sse') {
            return new SSEClientTransport(new URL(definition.url), {
                requestInit: { headers: definition.headers ?? {} },
                fetch
            });
        }
        return new StreamableHTTPClientTransport(new URL(definition.url), {
            requestInit: { headers: definition.headers ?? {} },
            fetch
        });
    }
}

const pluginMcpRuntime = new PluginMcpRuntime();
let disposeProvider: (() => void) | undefined;

export function initializePluginMcpProvider(): void {
    disposeProvider ??= registerMcpServerProvider({
        id: 'pluginmgr',
        getServers: () => pluginMcpRuntime.getServers()
    });
}

export function disposePluginMcpProvider(): void {
    disposeProvider?.();
    disposeProvider = undefined;
}

export function notifyPluginMcpServersChanged(): void {
    notifyMcpServerProvidersChanged();
}

export function getPluginMcpToolsets(workspace?: string): Promise<BaseToolset[]> {
    return pluginMcpRuntime.getToolsets(workspace);
}

export function getPluginMcpServerStates(): Promise<McpServerState[]> {
    return pluginMcpRuntime.getServers();
}

export function disposePluginMcpRuntime(): Promise<void> {
    return pluginMcpRuntime.dispose();
}
