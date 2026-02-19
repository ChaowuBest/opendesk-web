import { BaseApplication } from "../base";
import { BaseTool, BaseToolset } from "../../agents/tool";
import { z } from 'zod';
import { Setting } from '../../utils/setting.js';
import McpMgrWorker from "./worker";
import type { McpServerConfig, McpToolInfo } from './common.js';

const McpServerConfigSchema = z.object({
    id: z.string().describe('服务唯一标识符（自动生成）').default(''),
    name: z.string().describe('MCP 服务显示名称，如 filesystem、github 等').default(''),
    transport: z.enum(['stdio', 'sse', 'streamableHttp'])
        .describe('传输协议类型：stdio 本地命令行进程，sse 服务器推送事件，streamableHttp 流式 HTTP')
        .default('stdio'),
    enabled: z.boolean().describe('是否启用该 MCP 服务').default(true),
    command: z.string().describe('stdio 传输时执行的命令，如 npx、node、python 等').optional(),
    args: z.array(z.string()).describe('stdio 传输时的命令行参数列表').default([]),
    cwd: z.string().describe('stdio 传输时的工作目录路径').optional(),
    url: z.string().describe('sse/streamableHttp 传输时的服务端 URL 地址').optional(),
    env: z.record(z.string(), z.string()).describe('stdio 传输时附加的环境变量键值对').default({}),
    headers: z.record(z.string(), z.string()).describe('sse/streamableHttp 传输时附加的 HTTP 请求头').default({}),
});

const McpMgrConfigSchema = z.object({
    servers: z.array(McpServerConfigSchema).describe('MCP 服务配置列表').default([]),
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

    private getServersFromConfig(): McpServerConfig[] {
        const config = this.getConfig() as z.output<typeof McpMgrConfigSchema>;
        return JSON.parse(JSON.stringify(config?.servers || []));
    }

    private saveServersToConfig(servers: McpServerConfig[]): void {
        const setting = Setting.getInstance();
        const fullData = JSON.parse(JSON.stringify(setting.data));
        if (!fullData.applications) fullData.applications = {};
        fullData.applications[this.bundleName] = {
            ...fullData.applications[this.bundleName],
            servers,
        };
        setting.setData(fullData);
    }

    async addServer(config: McpServerConfig): Promise<McpServerConfig> {
        const servers = this.getServersFromConfig();
        config.id = `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        servers.push(config);
        this.saveServersToConfig(servers);
        this.sendEventToSubscribers('serversUpdated');
        return config;
    }

    async updateServer(id: string, updates: Partial<McpServerConfig>): Promise<void> {
        const servers = this.getServersFromConfig();
        const idx = servers.findIndex(s => s.id === id);
        if (idx === -1) throw new Error('Server not found');
        servers[idx] = { ...servers[idx], ...updates, id };
        this.saveServersToConfig(servers);
        this.sendEventToSubscribers('serversUpdated');
    }

    async deleteServer(id: string): Promise<void> {
        const servers = this.getServersFromConfig().filter(s => s.id !== id);
        this.saveServersToConfig(servers);
        this.sendEventToSubscribers('serversUpdated');
    }

    async toggleServer(id: string, enabled: boolean): Promise<void> {
        const servers = this.getServersFromConfig();
        const server = servers.find(s => s.id === id);
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
                env: cfg.env || {},
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
        let tools: McpToolInfo[];
        try {
            const result = await this.callWorker('getDiscoveredTools');
            if (result.status !== 'ok') return [];
            tools = result.data as McpToolInfo[];
        } catch {
            return [];
        }
        if (!tools || tools.length === 0) return [];

        const toolset = new BaseToolset('mcpmgr');

        for (const tool of tools) {
            const safeName = `${tool.serverName.replace(/[^a-zA-Z0-9_]/g, '_')}__${tool.name}`;
            let schema: z.ZodType;
            try {
                schema = z.fromJSONSchema(tool.inputSchema as any);
            } catch {
                schema = z.object({}).passthrough();
            }

            const baseTool = new BaseTool(
                safeName,
                `[MCP: ${tool.serverName}] ${tool.description}`,
                schema,
            );

            const serverId = tool.serverId;
            const toolName = tool.name;
            baseTool.setExecutor(async (args) => {
                const result = await this.callWorker('callMcpTool', serverId, toolName, args);
                if (result.status !== 'ok') throw new Error(result.message || 'MCP tool call failed');
                return result.data as string;
            });

            toolset.addTool(baseTool);
        }

        return [toolset];
    }
}
