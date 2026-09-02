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

import { BaseApplication, EventDecl } from '../base';
import { t } from './locale/index.js';
import { BaseToolset } from '../../aikernel/tool';
import { z } from 'zod';
import { Setting } from '../../utils/setting.js';
import {
    DeleteMcpServerTool,
    GetMcpRegistryEntryTool,
    ImportMcpServersFromJsonTool,
    InstallMcpServerFromRegistryTool,
    InstallMcpServerTool,
    ListMcpRegistriesTool,
    ListMcpServersTool,
    ReconnectMcpServerTool,
    SearchMcpRegistryTool,
    ToggleMcpServerTool,
    UpdateMcpServerTool
} from './tools.js';
import { MCPTool } from './mcp-tool.js';
import {
    McpCallToolTool,
    McpGetToolTool,
    McpSearchToolsTool,
    partitionMcpToolsForContext
} from './mcp-gateway-tools.js';
import { Skill } from '../../aikernel/skill.js';
import type { McpServerConfig, McpServerState, McpToolInfo } from './common.js';
import McpMgrWorker from './worker';
import { MANAGE_MCP_SKILL } from './skills.js';
import { parseJsonWithRepair } from '../../../utils/json.js';
import { t as globalT } from '../../../locale/index.js';
import {
    getRegistriesInfo,
    getRegistry,
    parseInstallUrl,
    searchRegistry,
    type SearchResult
} from './registry/index.js';
import { createHash } from 'crypto';
import { logger } from '../../utils/logger.js';
import { getProvidedMcpServers, onMcpServerProvidersChanged } from './provider.js';
import {
    getHarmonyLocalRuntimeFeatureAvailability,
    getHarmonyStdioCommandAvailability,
    type HarmonyLocalRuntimeFeatureAvailability
} from '../../../platforms/bridges/harmonyos/local-runtime.js';

function getLocalRuntimeUnavailableMessage(availability: HarmonyLocalRuntimeFeatureAvailability): string {
    return availability.reason === 'tablet-local-runtime-disabled'
        ? globalT('harmony.localRuntime.tabletUnavailable')
        : globalT('harmony.localRuntime.pcMissing', { capabilities: availability.missing.join(', ') });
}

const McpServerConfigSchema = z.object({
    id: z.string().describe('服务唯一标识符（自动生成）').default(''),
    name: z.string().describe('MCP 显示名称，如 filesystem、github 等').default(''),
    transport: z
        .enum(['stdio', 'sse', 'streamableHttp'])
        .describe('传输协议类型：stdio 本地命令行进程，sse 服务器推送事件，streamableHttp 流式 HTTP')
        .default('stdio'),
    enabled: z.boolean().describe('是否启用该 MCP').default(true),
    command: z.string().describe('stdio 传输时执行的命令，如 npx、node、python 等').optional(),
    args: z.array(z.string()).describe('stdio 传输时的命令行参数列表').default([]),
    cwd: z.string().describe('stdio 传输时的工作目录路径').optional(),
    url: z.string().describe('sse/streamableHttp 传输时的服务端 URL 地址').optional(),
    env: z.record(z.string(), z.string()).describe('stdio 传输时附加的环境变量键值对').default({}),
    headers: z.record(z.string(), z.string()).describe('sse/streamableHttp 传输时附加的 HTTP 请求头').default({}),
    source: z.string().optional().describe('MCP 配置来源'),
    registryId: z.string().optional().describe('来源 MCP Registry ID'),
    registryMcpId: z.string().optional().describe('来源 MCP Registry 条目 ID')
});

const McpMgrConfigSchema = z.object({
    servers: z.array(McpServerConfigSchema).describe('MCP 配置列表').default([])
});

const AgentMcpServerConfigSchema = z
    .object({
        id: z.string().optional(),
        name: z.string().trim().min(1),
        transport: z.enum(['stdio', 'sse', 'streamableHttp']).default('stdio'),
        enabled: z.boolean().default(true),
        command: z.string().optional(),
        args: z.array(z.string()).default([]),
        cwd: z.string().optional(),
        url: z.string().optional(),
        env: z.record(z.string(), z.string()).default({}),
        headers: z.record(z.string(), z.string()).default({})
    })
    .superRefine((server, context) => {
        if (server.transport === 'stdio' && !server.command) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'command is required for stdio transport',
                path: ['command']
            });
        }
        if ((server.transport === 'sse' || server.transport === 'streamableHttp') && !server.url) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                message: `url is required for ${server.transport} transport`,
                path: ['url']
            });
        }
    });

const AgentMcpConfigSchema = z.object({
    servers: z.array(AgentMcpServerConfigSchema).default([])
});

export interface AgentMcpRegistration {
    agentId: string;
    config: unknown;
}

export class McpMgrApplication extends BaseApplication {
    private readonly disposeProviderListener: () => void;

    constructor() {
        super('mcpmgr');
        this.disposeProviderListener = onMcpServerProvidersChanged(() => {
            this.sendEventToSubscribers('serversUpdated');
        });
    }

    getName(): string {
        return t('app.name');
    }

    static getWorkerClass() {
        return McpMgrWorker;
    }

    static getConfigSchema(): z.ZodObject<any> {
        return McpMgrConfigSchema;
    }

    public getServersFromConfig(): McpServerConfig[] {
        const config = this.getConfig() as z.output<typeof McpMgrConfigSchema>;
        return JSON.parse(JSON.stringify(config?.servers || []));
    }

    async getServersForUI(): Promise<McpServerState[]> {
        let configured: McpServerState[] = [];
        try {
            const result = await this.callWorker('getServers');
            if (result.status === 'ok') configured = result.data as McpServerState[];
        } catch {
            configured = [];
        }
        return [...configured, ...(await getProvidedMcpServers())];
    }

    private saveServersToConfig(servers: McpServerConfig[]): void {
        const setting = Setting.getInstance();
        const fullData = JSON.parse(JSON.stringify(setting.data));
        if (!fullData.applications) fullData.applications = {};
        fullData.applications[this.bundleName] = {
            ...fullData.applications[this.bundleName],
            servers
        };
        setting.setData(fullData);
    }

    /**
     * 原子替换所有由 AgentOffice 提供的 agent 专属 MCP server。
     * 这些配置只存在于运行时，不写入 MCPMgr 的通用用户配置。
     */
    async replaceAgentServers(registrations: AgentMcpRegistration[]): Promise<void> {
        const servers: McpServerConfig[] = [];

        for (const registration of registrations) {
            try {
                const parsed = AgentMcpConfigSchema.parse(registration.config);
                const seenNames = new Set<string>();
                for (const server of parsed.servers) {
                    if (!server.enabled) continue;
                    if (seenNames.has(server.name)) {
                        logger.warn(
                            `MCPMgr: duplicate MCP server name "${server.name}" for agent ${registration.agentId}, skipping`
                        );
                        continue;
                    }
                    seenNames.add(server.name);
                    const sourceId = server.id?.trim() || server.name;
                    const id = `agent_${createHash('sha256')
                        .update(`${registration.agentId}\0${sourceId}`)
                        .digest('hex')
                        .slice(0, 24)}`;
                    servers.push({
                        ...server,
                        id,
                        source: 'Agent',
                        agentIds: [registration.agentId]
                    });
                }
            } catch (error) {
                logger.warn(`MCPMgr: invalid MCP config for agent ${registration.agentId}, skipping: ${error}`);
            }
        }

        const result = await this.callWorker('replaceAgentServers', servers);
        if (result.status !== 'ok') {
            throw new Error(result.message || 'Failed to register custom agent MCP servers');
        }
    }

    public isServerDuplicate(a: McpServerConfig, b: McpServerConfig): boolean {
        // 名称相同直接认为是重复
        if (a.name === b.name) return true;

        // stdio 传输：检查 command + args 是否相同
        if (a.transport === 'stdio' && b.transport === 'stdio') {
            if (a.command === b.command && JSON.stringify(a.args) === JSON.stringify(b.args)) {
                return true;
            }
        }

        // sse/streamableHttp 传输：检查 url 是否相同
        if (
            (a.transport === 'sse' || a.transport === 'streamableHttp') &&
            (b.transport === 'sse' || b.transport === 'streamableHttp')
        ) {
            if (a.url === b.url) {
                return true;
            }
        }

        return false;
    }

    async addServer(config: McpServerConfig): Promise<McpServerConfig> {
        this.assertServerLocalRuntimeAvailable(config);
        const servers = this.getServersFromConfig();

        // 检查是否已存在相同配置的服务器
        const duplicate = servers.find((s) => this.isServerDuplicate(s, config));
        if (duplicate) {
            throw new Error(`MCP server "${config.name}" already exists with similar configuration`);
        }

        config.id = `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        servers.push(config);
        this.saveServersToConfig(servers);
        this.sendEventToSubscribers('serversUpdated');
        return config;
    }

    async updateServer(id: string, updates: Partial<McpServerConfig>): Promise<void> {
        const servers = this.getServersFromConfig();
        const idx = servers.findIndex((s) => s.id === id);
        if (idx === -1) throw new Error('Server not found');
        const updatedServer = { ...servers[idx], ...updates, id };
        this.assertServerLocalRuntimeAvailable(updatedServer);
        servers[idx] = updatedServer;
        this.saveServersToConfig(servers);
        this.sendEventToSubscribers('serversUpdated');
    }

    async deleteServer(id: string): Promise<void> {
        const servers = this.getServersFromConfig().filter((s) => s.id !== id);
        this.saveServersToConfig(servers);
        this.sendEventToSubscribers('serversUpdated');
    }

    async toggleServer(id: string, enabled: boolean): Promise<void> {
        const servers = this.getServersFromConfig();
        const server = servers.find((s) => s.id === id);
        if (!server) throw new Error('Server not found');
        if (enabled) this.assertServerLocalRuntimeAvailable(server);
        server.enabled = enabled;
        this.saveServersToConfig(servers);
        this.sendEventToSubscribers('serversUpdated');
    }

    async importFromJson(jsonConfig: string): Promise<number> {
        const parsed = JSON.parse(jsonConfig);
        const mcpServers = parsed.mcpServers || parsed;
        const servers = this.getServersFromConfig();
        let imported = 0;

        for (const [name, cfg] of Object.entries(mcpServers) as [string, any][]) {
            const config: McpServerConfig = {
                id: `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                name,
                transport: 'stdio',
                enabled: true,
                command: cfg.command,
                args: cfg.args || [],
                env: cfg.env || {}
            };
            if (cfg.url) {
                config.transport = cfg.url?.includes('/sse') ? 'sse' : 'streamableHttp';
                config.url = cfg.url;
                config.headers = cfg.headers || {};
            }
            this.assertServerLocalRuntimeAvailable(config);
            servers.push(config);
            imported++;
        }

        this.saveServersToConfig(servers);
        this.sendEventToSubscribers('serversUpdated');
        return imported;
    }

    private assertServerLocalRuntimeAvailable(server: McpServerConfig): void {
        if (server.transport !== 'stdio') return;
        const availability = getHarmonyStdioCommandAvailability(server.command);
        if (!availability.available) throw new Error(getLocalRuntimeUnavailableMessage(availability));
    }

    getLocalRuntimeStatus(): { available: boolean; reason: string | null; message: string | null } {
        const availability = getHarmonyLocalRuntimeFeatureAvailability('stdio-mcp');
        return {
            available: availability.available,
            reason: availability.reason,
            message: availability.available ? null : getLocalRuntimeUnavailableMessage(availability)
        };
    }

    getMcpRegistries() {
        return getRegistriesInfo();
    }

    async searchMcpRegistry(
        registryId: string,
        query: string = '',
        page: number = 1,
        limit: number = 30,
        cursor?: string
    ): Promise<SearchResult> {
        return searchRegistry(registryId, { query, page, limit, cursor });
    }

    async getRegistryMcpDetail(registryId: string, id: string) {
        const registry = getRegistry(registryId);
        if (!registry) throw new Error(`未知 MCP Registry: ${registryId}`);
        return registry.getDetail(id);
    }

    private parseMcpServerConfiguration(raw: string): Record<string, any> {
        const trimmed = raw
            .trim()
            .replace(/^```(?:json)?\s*/i, '')
            .replace(/\s*```$/i, '');
        const jsonStart = trimmed.indexOf('{');
        const jsonEnd = trimmed.lastIndexOf('}');
        const jsonText = jsonStart >= 0 && jsonEnd > jsonStart ? trimmed.slice(jsonStart, jsonEnd + 1) : trimmed;

        return parseJsonWithRepair<Record<string, any>>(jsonText);
    }

    private buildServerConfigFromMcpEntry(
        name: string,
        entry: Record<string, any>,
        source: Pick<McpServerConfig, 'source' | 'registryId' | 'registryMcpId'>
    ): McpServerConfig {
        const hasUrl = typeof entry.url === 'string' && entry.url.trim().length > 0;
        const explicitTransport = typeof entry.transport === 'string' ? entry.transport : entry.type;
        const normalizedTransport =
            typeof explicitTransport === 'string' ? explicitTransport.toLowerCase().replace(/[_-]/g, '') : '';
        const transport: McpServerConfig['transport'] =
            normalizedTransport === 'sse' || normalizedTransport === 'streamablehttp' || normalizedTransport === 'stdio'
                ? normalizedTransport === 'streamablehttp'
                    ? 'streamableHttp'
                    : normalizedTransport
                : hasUrl
                  ? entry.url.includes('/sse')
                      ? 'sse'
                      : 'streamableHttp'
                  : 'stdio';

        const config: McpServerConfig = {
            id: '',
            name: entry.name || name,
            transport,
            enabled: entry.enabled ?? !entry.disabled,
            env: entry.env || {},
            headers: entry.headers || {},
            ...source
        };

        if (transport === 'stdio') {
            config.command = entry.command;
            config.args = Array.isArray(entry.args) ? entry.args.map(String) : [];
            if (entry.cwd) config.cwd = String(entry.cwd);
            if (!config.command) throw new Error(`MCP "${config.name}" 缺少 command`);
        } else {
            config.url = entry.url;
            if (!config.url) throw new Error(`MCP "${config.name}" 缺少 url`);
        }

        return config;
    }

    private parseServerConfigsFromRegistryConfig(
        raw: string,
        source: Pick<McpServerConfig, 'source' | 'registryId' | 'registryMcpId'>
    ): McpServerConfig[] {
        if (!raw?.trim()) return [];
        const parsed = this.parseMcpServerConfiguration(raw);
        const servers = parsed.mcpServers || parsed.servers || parsed;
        if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
            throw new Error('MCP 配置中未找到 mcpServers 对象');
        }

        return Object.entries(servers).map(([name, entry]) =>
            this.buildServerConfigFromMcpEntry(name, (entry || {}) as Record<string, any>, source)
        );
    }

    async installFromRegistry(installUrl: string, force: boolean = false) {
        const parsed = parseInstallUrl(installUrl);
        if (!parsed) throw new Error(`无法识别 MCP Registry 安装地址: ${installUrl}`);

        const registry = getRegistry(parsed.registryId);
        if (!registry) throw new Error(`未知 MCP Registry: ${parsed.registryId}`);

        const detail = await registry.getDetail(parsed.id);
        if (!detail) throw new Error('未找到该 MCP');
        if (!detail.configuration) throw new Error(`${detail.source} MCP "${detail.name}" 未提供可安装配置`);

        const configs = this.parseServerConfigsFromRegistryConfig(detail.configuration, {
            source: detail.source,
            registryId: parsed.registryId,
            registryMcpId: detail.id
        });
        if (configs.length === 0) throw new Error(`${detail.source} MCP "${detail.name}" 未提供可安装 MCP server`);

        const installed: McpServerConfig[] = [];
        const updated: McpServerConfig[] = [];
        const skipped: McpServerConfig[] = [];

        for (const config of configs) {
            const existing = this.getServersFromConfig().find((server) => this.isServerDuplicate(server, config));
            if (existing) {
                if (force) {
                    await this.updateServer(existing.id, config);
                    updated.push({ ...config, id: existing.id });
                } else {
                    skipped.push(existing);
                }
                continue;
            }

            installed.push(await this.addServer(config));
        }

        return {
            success: true,
            name: detail.name,
            installed,
            updated,
            skipped,
            message:
                installed.length > 0 || updated.length > 0
                    ? `已安装 ${installed.length} 个，更新 ${updated.length} 个，跳过 ${skipped.length} 个`
                    : `未安装新 MCP，已存在 ${skipped.length} 个相同配置`
        };
    }

    async getToolsets(): Promise<BaseToolset[]> {
        const toolsets: BaseToolset[] = [];

        // 1. 现有的 MCP 工具（来自已连接的服务器）
        let tools: McpToolInfo[];
        try {
            const result = await this.callWorker('getDiscoveredTools');
            if (result.status !== 'ok') return [];
            tools = result.data as McpToolInfo[];
        } catch {
            tools = [];
        }

        if (tools && tools.length > 0) {
            const { eager, deferred } = partitionMcpToolsForContext(tools);
            const toolset = new BaseToolset('mcpmgr');
            for (const tool of eager) {
                let schema: z.ZodType;
                try {
                    schema = z.fromJSONSchema(tool.inputSchema as any);
                } catch {
                    schema = z.object({}).passthrough();
                }

                // 使用 MCPTool 替代 BaseTool，提供专门的渲染逻辑
                const toolNamespace =
                    tool.agentIds === undefined ? tool.serverName : `${tool.serverName}_${tool.serverId.slice(-8)}`;
                const mcpTool = new MCPTool(
                    tool.serverName,
                    tool.name,
                    tool.description,
                    schema,
                    tool.agentIds,
                    toolNamespace
                );

                const serverId = tool.serverId;
                const toolName = tool.name;
                mcpTool.setExecutor(async (args) => {
                    const result = await this.callWorker('callMcpTool', serverId, toolName, args);
                    if (result.status !== 'ok') throw new Error(result.message || globalT('mcpmgr.toolCallFailed'));
                    return result.data as string;
                });

                toolset.addTool(mcpTool);
            }

            if (deferred.length > 0) {
                toolset.addTool(new McpSearchToolsTool(deferred));
                toolset.addTool(new McpGetToolTool(deferred));
                toolset.addTool(
                    new McpCallToolTool(deferred, async (tool, args) => {
                        const result = await this.callWorker('callMcpTool', tool.serverId, tool.name, args);
                        if (result.status !== 'ok') throw new Error(result.message || globalT('mcpmgr.toolCallFailed'));
                        return result.data as string;
                    })
                );
            }
            toolsets.push(toolset);
        }

        return toolsets;
    }

    async getSkills(): Promise<Skill[]> {
        const mcpManageSkill = Skill.parseMd(MANAGE_MCP_SKILL);
        const mcpManageToolset = new BaseToolset('mcp-manage');

        mcpManageToolset.addTool(new InstallMcpServerTool(this));
        mcpManageToolset.addTool(new ListMcpServersTool(this));
        mcpManageToolset.addTool(new UpdateMcpServerTool(this));
        mcpManageToolset.addTool(new ReconnectMcpServerTool(this));
        mcpManageToolset.addTool(new DeleteMcpServerTool(this));
        mcpManageToolset.addTool(new ToggleMcpServerTool(this));
        mcpManageToolset.addTool(new ImportMcpServersFromJsonTool(this));
        mcpManageToolset.addTool(new ListMcpRegistriesTool(this));
        mcpManageToolset.addTool(new SearchMcpRegistryTool(this));
        mcpManageToolset.addTool(new GetMcpRegistryEntryTool(this));
        mcpManageToolset.addTool(new InstallMcpServerFromRegistryTool(this));
        mcpManageSkill.toolsets = [mcpManageToolset];
        return [mcpManageSkill];
    }

    /**
     * 获取应用能够注册的事件
     */
    async getSupportedEvents(): Promise<EventDecl[]> {
        return [
            {
                eventName: 'serversUpdated',
                eventDescription: 'MCP 列表更新事件，当添加、删除、修改配置或连接状态变化时触发'
            }
        ];
    }

    async beforeExit(): Promise<void> {
        this.disposeProviderListener();
    }
}
