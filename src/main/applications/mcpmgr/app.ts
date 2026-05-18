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

const McpServerConfigSchema = z.object({
    id: z.string().describe('服务唯一标识符（自动生成）').default(''),
    name: z.string().describe('MCP 服务显示名称，如 filesystem、github 等').default(''),
    transport: z
        .enum(['stdio', 'sse', 'streamableHttp'])
        .describe('传输协议类型：stdio 本地命令行进程，sse 服务器推送事件，streamableHttp 流式 HTTP')
        .default('stdio'),
    enabled: z.boolean().describe('是否启用该 MCP 服务').default(true),
    command: z.string().describe('stdio 传输时执行的命令，如 npx、node、python 等').optional(),
    args: z.array(z.string()).describe('stdio 传输时的命令行参数列表').default([]),
    cwd: z.string().describe('stdio 传输时的工作目录路径').optional(),
    url: z.string().describe('sse/streamableHttp 传输时的服务端 URL 地址').optional(),
    env: z.record(z.string(), z.string()).describe('stdio 传输时附加的环境变量键值对').default({}),
    headers: z.record(z.string(), z.string()).describe('sse/streamableHttp 传输时附加的 HTTP 请求头').default({})
});

const McpMgrConfigSchema = z.object({
    servers: z.array(McpServerConfigSchema).describe('MCP 服务配置列表').default([])
});

export class McpMgrApplication extends BaseApplication {
    constructor() {
        super('mcpmgr', 'MCP 服务');
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
                eventDescription: 'MCP服务器列表更新事件，当添加、删除、修改服务器配置或连接状态变化时触发'
            }
        ];
    }
}
