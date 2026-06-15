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
import { BaseToolset } from '../../aikernel/tool';
import { z } from 'zod';
import { Setting } from '../../utils/setting.js';
import { InstallMcpServerTool, ListMcpServersTool, DeleteMcpServerTool, ToggleMcpServerTool } from './tools';
import { MCPTool } from './mcp-tool.js';
import { Skill } from '../../aikernel/skill.js';
import type { McpServerConfig, McpToolInfo } from './common.js';
import McpMgrWorker from './worker';
import { MANAGE_MCP_SKILL } from './skills.js';
import { jsonrepair } from 'jsonrepair';
import {
    getRegistriesInfo,
    getRegistry,
    parseInstallUrl,
    searchRegistry,
    type SearchResult
} from './registry/index.js';

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

export class McpMgrApplication extends BaseApplication {
    constructor() {
        super('mcpmgr', 'MCP管理');
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
        servers[idx] = { ...servers[idx], ...updates, id };
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
            servers.push(config);
            imported++;
        }

        this.saveServersToConfig(servers);
        this.sendEventToSubscribers('serversUpdated');
        return imported;
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

        try {
            return JSON.parse(jsonText);
        } catch {
            return JSON.parse(jsonrepair(jsonText));
        }
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
            const toolset = new BaseToolset('mcpmgr');
            for (const tool of tools) {
                let schema: z.ZodType;
                try {
                    schema = z.fromJSONSchema(tool.inputSchema as any);
                } catch {
                    schema = z.object({}).passthrough();
                }

                // 使用 MCPTool 替代 BaseTool，提供专门的渲染逻辑
                const mcpTool = new MCPTool(tool.serverName, tool.name, tool.description, schema);

                const serverId = tool.serverId;
                const toolName = tool.name;
                mcpTool.setExecutor(async (args) => {
                    const result = await this.callWorker('callMcpTool', serverId, toolName, args);
                    if (result.status !== 'ok') throw new Error(result.message || 'MCP tool call failed');
                    return result.data as string;
                });

                toolset.addTool(mcpTool);
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
        mcpManageToolset.addTool(new DeleteMcpServerTool(this));
        mcpManageToolset.addTool(new ToggleMcpServerTool(this));
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
}
