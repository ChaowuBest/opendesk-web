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
import { toErrorMessage } from '../../../common/utils/error.js';
import iconv from 'iconv-lite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { McpServerConfig, McpToolInfo } from './common.js';
import { getPlatform } from '../../../platforms/base.js';
import { buildChildProcessEnv } from '../../utils/shellExec.js';
import { t } from './locale/index.js';
// platformT：读取主 locale 中跨应用共享的平台词条（harmony.localRuntime.*）
import { t as platformT } from '../../../locale/index.js';
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
        ? platformT('harmony.localRuntime.tabletUnavailable')
        : platformT('harmony.localRuntime.pcMissing', { capabilities: availability.missing.join(', ') });
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

/**
 * 技能内部 MCP server 的空闲自动断开时长：连续该时长内没有任何工具调用就断开
 * 连接以释放 stdio 子进程等资源；后续工具调用会按需重连（懒加载自愈）。
 */
const PLUGIN_SKILL_MCP_IDLE_DISCONNECT_MS = 30 * 60 * 1000;

export default class McpMgrWorker extends BaseWorker {
    private readonly localRuntimeState: HarmonyLocalRuntimeState | null;
    private servers: McpServerConfig[] = [];
    private configuredServers: McpServerConfig[] = [];
    private agentServers: McpServerConfig[] = [];
    /** 插件技能注入的内部 MCP server（运行时存在，不写入用户配置；随插件启停全量同步） */
    private pluginSkillServers: McpServerConfig[] = [];
    private pendingAgentConnections = new Map<string, Promise<void>>();
    private connections: Map<string, McpConnection> = new Map();
    /** 进行中的建连（按 server id 去重）：懒加载的并发触发（技能加载/技能详情）不会重复建连或泄漏传输 */
    private connectingServers = new Map<string, Promise<void>>();
    /**
     * 技能内部 server 的空闲断开计时器（按 server id）：连接成功时启动、工具调用时重置，
     * 连续空闲超时后自动断开以释放 stdio 子进程等资源
     */
    private pluginSkillIdleTimers = new Map<string, ReturnType<typeof setTimeout>>();
    /**
     * 插件技能内部 server 配置变更的串行队列：replace（插件全量同步）与 ensure（技能加载补齐）
     * 来自并发路径，串行化避免两者在 syncConnections 的 await 点交错后用过期视图互相断连
     */
    private pluginSkillMutationQueue: Promise<void> = Promise.resolve();
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

    private recomposeServers(): void {
        this.servers = [...this.configuredServers, ...this.agentServers, ...this.pluginSkillServers];
    }

    async initialize(): Promise<void> {
        this.configuredServers = this.parseServersFromConfig();
        this.recomposeServers();
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
        const oldServers = this.servers;
        this.recomposeServers();
        await this.syncConnections(this.servers, oldServers);
        await this.emitEvent('serversUpdated');
    }

    async replaceAgentServers(servers: McpServerConfig[]): Promise<void> {
        const oldServers = this.servers;
        this.agentServers = servers.map((server) => ({
            ...server,
            agentIds: server.agentIds ? [...server.agentIds] : []
        }));
        this.recomposeServers();
        await this.syncConnections(this.servers, oldServers);
        await this.emitEvent('serversUpdated');
    }

    /**
     * 原子替换插件技能注入的内部 MCP server。
     *
     * 与 replaceAgentServers 同语义的全量替换，但只注册配置、不触发建连：内部 server 的
     * 连接是懒加载的，延迟到技能加载（ensurePluginSkillServers）或技能详情展示
     * （connectPluginSkillServers）时进行，避免启动即拉起一批插件子进程。
     */
    async replacePluginSkillServers(servers: McpServerConfig[]): Promise<void> {
        await this.enqueuePluginSkillMutation(() =>
            this.applyPluginSkillServers(
                servers.map((server) => ({ ...server })),
                true,
                false
            )
        );
    }

    /**
     * 幂等补齐插件技能注入的内部 MCP server，并确保其已连接（技能加载/详情展示路径）。
     *
     * 以 id 为键合并：缺失的补上、配置变化的触发重连，其余保持不变。配置未变化的
     * server 不经 syncConnections 建连，这里对已登记但尚未连接的兜底建连——全量同步
     * （replace）只登记不建连，首次技能加载必须在此拿到可用连接。
     * 同时承担全局 worker 重启后的自愈（新 worker 会丢失运行时注入的 server）。
     */
    async ensurePluginSkillServers(servers: McpServerConfig[]): Promise<void> {
        await this.enqueuePluginSkillMutation(async () => {
            const merged = new Map(this.pluginSkillServers.map((server) => [server.id, server]));
            for (const server of servers) {
                merged.set(server.id, { ...server });
            }
            await this.applyPluginSkillServers([...merged.values()], false, true);
            await Promise.all(
                servers.filter((server) => server.enabled !== false).map((server) => this.ensureServerConnected(server))
            );
        });
    }

    /**
     * 确保指定插件技能的内部 MCP server 已连接（技能详情展示前的懒加载触发点）。
     *
     * 配置来自此前 replace/ensure 注入的清单；目标已连接/连接中时是幂等快速返回。
     */
    async connectPluginSkillServers(pluginId: string, skillName: string): Promise<void> {
        const targets = this.pluginSkillServers.filter(
            (server) => server.pluginId === pluginId && server.pluginSkillName === skillName && server.enabled
        );
        await Promise.all(targets.map((server) => this.ensureServerConnected(server)));
    }

    /** server 已连接/连接中时不重复建连；未连接或上次失败时拉起连接（懒加载路径共用） */
    private async ensureServerConnected(server: McpServerConfig): Promise<void> {
        const conn = this.connections.get(server.id);
        if (conn && (conn.status === 'connected' || conn.status === 'connecting')) return;
        try {
            await this.connectServer(server.id);
        } catch (err) {
            logger.error(`[mcpmgr] Connect failed for ${server.name}: ${toErrorMessage(err)}`);
        }
    }

    /**
     * 启动/重置技能内部 server 的空闲断开计时器。
     * 连接成功与每次工具调用都会触达这里；非内部 server 直接忽略。
     */
    private armPluginSkillIdleTimer(id: string): void {
        const server = this.servers.find((s) => s.id === id);
        if (!server || server.pluginSkillName === undefined) return;
        this.clearPluginSkillIdleTimer(id);
        const timer = setTimeout(() => {
            this.pluginSkillIdleTimers.delete(id);
            void this.disconnectIdlePluginSkillServer(id);
        }, PLUGIN_SKILL_MCP_IDLE_DISCONNECT_MS);
        timer.unref?.();
        this.pluginSkillIdleTimers.set(id, timer);
    }

    private clearPluginSkillIdleTimer(id: string): void {
        const timer = this.pluginSkillIdleTimers.get(id);
        if (timer !== undefined) {
            clearTimeout(timer);
            this.pluginSkillIdleTimers.delete(id);
        }
    }

    /** 空闲超时回调：连接已不在（或已非连接态）时跳过，否则断开并广播状态 */
    private async disconnectIdlePluginSkillServer(id: string): Promise<void> {
        const server = this.servers.find((s) => s.id === id);
        const conn = this.connections.get(id);
        if (!server || server.pluginSkillName === undefined) return;
        if (!conn || conn.status !== 'connected') return;
        logger.info(
            `[mcpmgr] Plugin skill MCP server "${server.name}" (${id}) disconnected after ${PLUGIN_SKILL_MCP_IDLE_DISCONNECT_MS / 60000}min idle`
        );
        await this.disconnectServer(id);
        await this.emitEvent('serversUpdated');
    }

    /** 插件技能内部 server 的配置变更串行执行；单次失败不阻塞后续操作 */
    private enqueuePluginSkillMutation<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.pluginSkillMutationQueue.then(operation, operation);
        this.pluginSkillMutationQueue = result.then(
            () => undefined,
            () => undefined
        );
        return result;
    }

    private async applyPluginSkillServers(
        servers: McpServerConfig[],
        alwaysApply: boolean,
        autoConnect: boolean
    ): Promise<void> {
        const next = servers.map((server) => ({ ...server, enabled: server.enabled !== false }));
        if (!alwaysApply && JSON.stringify(next) === JSON.stringify(this.pluginSkillServers)) return;
        const oldServers = this.servers;
        this.pluginSkillServers = next;
        this.recomposeServers();
        // 懒加载：autoConnect=false 的全量同步跳过内部 server 的自动建连（已连接的配置变更仍会断开旧连接）
        await this.syncConnections(
            this.servers,
            oldServers,
            autoConnect ? undefined : (server) => server.pluginSkillName !== undefined
        );
        await this.emitEvent('serversUpdated');
    }

    private async syncConnections(
        newServers: McpServerConfig[],
        oldServers: McpServerConfig[],
        skipAutoConnect?: (server: McpServerConfig) => boolean
    ): Promise<void> {
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

            if (configChanged && this.connections.has(id)) {
                await this.disconnectServer(id);
            }

            // skipAutoConnect：懒加载的 server 只做配置登记与旧连接清理，不主动建连
            if (configChanged && !skipAutoConnect?.(newServer)) {
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
            // 懒加载的技能内部 server：从未建连过的不随 workspace 切换主动拉起
            .filter((server) => server.pluginSkillName === undefined || this.connections.has(server.id))
            .map((server) =>
                this.connectServer(server.id, workspace).catch((err) => {
                    logger.error(`[mcpmgr] Workspace reconnect failed for ${server.name}: ${err.message}`);
                })
            );

        await Promise.allSettled(reconnects);
    }

    async connectServer(id: string, workspace?: string): Promise<void> {
        const inFlight = this.connectingServers.get(id);
        if (inFlight) return inFlight;
        const connection = this.doConnectServer(id, workspace).finally(() => {
            if (this.connectingServers.get(id) === connection) this.connectingServers.delete(id);
        });
        this.connectingServers.set(id, connection);
        return connection;
    }

    private async doConnectServer(id: string, workspace?: string): Promise<void> {
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
            // 技能内部 server 从连接成功起计时，连续空闲超时后自动断开
            this.armPluginSkillIdleTimer(id);

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
            parts.push(t('error.commandNotFound', { command: server.command || '?' }));
            parts.push(t('error.checkRuntimeInstalled'));
        } else {
            parts.push(err.message || t('error.unknownError'));
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
                (transport.stderr as NodeJS.ReadableStream | null)?.resume();
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
        this.clearPluginSkillIdleTimer(id);
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
            // 技能内部挂载的 MCP 不进入全局工具视角：其工具只通过所属 Skill 渐进式披露，
            // 全局任务工具集与 MCP 网关工具（搜索/调用）都不应看到它们
            if (server.pluginSkillName !== undefined) continue;
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
        const server = this.servers.find((s) => s.id === serverId);
        if (!server) {
            throw new Error(`MCP server ${serverId} not found`);
        }

        let conn = this.connections.get(serverId);
        // 技能内部 server 懒加载自愈：历史任务里已披露过的技能工具再次被调用、
        // 或空闲自动断开/worker 重启后连接丢失时，由工具调用按需重连。
        // 走 connectServer 而非 ensureServerConnected：有建连在途时等待其完成而不是立即报“连接中”
        if (server.pluginSkillName !== undefined && (!conn || conn.status !== 'connected')) {
            await this.connectServer(serverId).catch((err) => {
                logger.error(`[mcpmgr] Connect failed for ${server.name}: ${toErrorMessage(err)}`);
            });
            conn = this.connections.get(serverId);
        }
        if (!conn || conn.status !== 'connected') {
            throw new Error(this.describeServerUnavailable(server, conn));
        }
        // 本次调用即活跃：重置空闲断开计时
        this.armPluginSkillIdleTimer(serverId);

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

    /**
     * server 不可调用的错误描述。面向模型与工具结果展示：
     * 带上 server 展示名与底层连接失败原因（conn.error 含 stderr 诊断），
     * 让模型/用户能据实重试或排查，而不是只看到一个哈希 id。
     */
    private describeServerUnavailable(server: McpServerConfig, conn?: McpConnection): string {
        const scope =
            server.pluginSkillName !== undefined
                ? `"${server.name}" (plugin skill "${server.pluginSkillName}")`
                : `"${server.name}"`;
        if (conn?.status === 'error' && conn.error) {
            return `MCP server ${scope} is not connected. Last connect attempt failed: ${conn.error}`;
        }
        if (conn?.status === 'connecting') {
            return `MCP server ${scope} is still connecting; retry shortly`;
        }
        return `MCP server ${scope} is not connected`;
    }
}
