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

import { BaseTool } from '../../aikernel/tool';
import { ToolCall } from '../../aikernel/messages';
import { Card } from '../../tui/components/card';
import { statusDisplay, truncText } from '../../tui/components/toolcall';
import chalk from 'chalk';
import { z } from 'zod';
import type { McpServerConfig } from './common';

const InstallMcpServerArgsSchema = z.object({
    name: z.string().describe('Server name, e.g., "filesystem", "github", "my-server"'),
    transport: z
        .enum(['stdio', 'sse', 'streamableHttp'])
        .describe('Transport type: stdio for local commands, sse/streamableHttp for remote servers'),
    command: z.string().optional().describe('Command for stdio transport, e.g., "npx", "node", "python", "uvx"'),
    args: z
        .array(z.string())
        .optional()
        .describe('Arguments for stdio transport, e.g., ["-y", "@modelcontextprotocol/server-filesystem", "/path"]'),
    cwd: z.string().optional().describe('Working directory for stdio transport'),
    url: z.string().optional().describe('URL for sse/streamableHttp transport'),
    headers: z.record(z.string(), z.string()).optional().describe('HTTP headers for sse/streamableHttp'),
    env: z.record(z.string(), z.string()).optional().describe('Environment variables'),
    enabled: z.boolean().default(true).describe('Whether to enable the server after installation')
});

export class InstallMcpServerTool extends BaseTool<typeof InstallMcpServerArgsSchema> {
    private mcpApp: any;

    constructor(mcpApp: any) {
        super(
            'installMcpServer',
            'Install a new MCP server with specified configuration. Use this when user wants to add a new MCP server.',
            InstallMcpServerArgsSchema
        );
        this.mcpApp = mcpApp;
        this.setExecutor(this.install.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const name = args?.['name'];
        const transport = args?.['transport'];
        const body: string[] = [];

        if (name) {
            body.push(chalk.dim('服务器: ') + chalk.cyan(String(name)));
        }
        if (transport) {
            body.push(chalk.dim('传输: ') + chalk.yellow(String(transport)));
        }

        if (toolcall.status === 'running') {
            body.push(chalk.dim('  ⏳ 安装中…'));
        } else if (toolcall.status === 'success' && toolcall.result) {
            try {
                const result = JSON.parse(toolcall.result);
                if (result.alreadyExists) {
                    body.push(chalk.dim('  ✨ 服务器已存在: ') + chalk.yellow(result.name));
                } else if (result.warning) {
                    body.push(chalk.dim('  ✓ 安装成功，连接失败: ') + chalk.red(result.warning));
                } else {
                    body.push(chalk.dim('  ✓ 安装成功!'));
                }
            } catch {
                body.push(chalk.dim('  ✓ 安装成功!'));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(toolcall.result, width - 10)));
        }

        return new Card({
            icon: '📦',
            title: '安装 MCP 服务',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async install(args: z.output<typeof InstallMcpServerArgsSchema>): Promise<string> {
        const config: McpServerConfig = {
            id: `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            ...args
        };

        const servers = this.mcpApp.getServersFromConfig();
        const existing = servers.find((s: any) => this.mcpApp.isServerDuplicate(s, config));
        if (existing) {
            return JSON.stringify({
                success: true,
                message: `MCP server "${existing.name}" already exists (ID: ${existing.id})`,
                serverId: existing.id,
                name: existing.name,
                transport: existing.transport,
                alreadyExists: true
            });
        }

        const server = await this.mcpApp.addServer(config);

        if (args.enabled !== false) {
            try {
                await this.mcpApp.callWorker('connectServer', server.id);
                return JSON.stringify({
                    success: true,
                    message: `MCP server "${server.name}" installed and connected successfully`,
                    serverId: server.id,
                    name: server.name,
                    transport: server.transport
                });
            } catch (err: any) {
                return JSON.stringify({
                    success: true,
                    message: `MCP server "${server.name}" installed but connection failed: ${err.message}`,
                    serverId: server.id,
                    name: server.name,
                    transport: server.transport,
                    warning: 'Server installed but not connected. Please check the configuration.'
                });
            }
        }

        return JSON.stringify({
            success: true,
            message: `MCP server "${server.name}" installed successfully`,
            serverId: server.id,
            name: server.name,
            transport: server.transport
        });
    }
}

const ListMcpServersArgsSchema = z.object({});

export class ListMcpServersTool extends BaseTool<typeof ListMcpServersArgsSchema> {
    private mcpApp: any;

    constructor(mcpApp: any) {
        super(
            'listMcpServers',
            'List all installed MCP servers with their status and configuration',
            ListMcpServersArgsSchema
        );
        this.mcpApp = mcpApp;
        this.setExecutor(this.list.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const body: string[] = [];

        if (toolcall.status === 'running') {
            body.push(chalk.dim('  ⏳ 加载中…'));
        } else if (toolcall.status === 'success' && toolcall.result) {
            try {
                const result = JSON.parse(toolcall.result);
                const servers = Array.isArray(result.servers) ? result.servers : [];
                if (servers.length === 0) {
                    body.push(chalk.dim('  暂无已安装的 MCP 服务'));
                } else {
                    body.push(chalk.dim(`  找到 ${chalk.white(String(servers.length))} 个 MCP 服务:`));
                    for (const server of servers.slice(0, 5)) {
                        const statusIcon = server.status === 'connected' ? '✓' : server.status === 'error' ? '✗' : '○';
                        const statusColor =
                            server.status === 'connected'
                                ? chalk.green
                                : server.status === 'error'
                                  ? chalk.red
                                  : chalk.gray;
                        body.push(
                            `    ${statusColor(statusIcon)} ${chalk.cyan(String(server.name))} (${chalk.yellow(String(server.transport))})`
                        );
                    }
                    if (servers.length > 5) {
                        body.push(chalk.dim(`    ... 还有 ${servers.length - 5} 个`));
                    }
                }
            } catch {
                body.push(chalk.dim('  ✓ 已获取 MCP 服务列表'));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(toolcall.result, width - 10)));
        }

        return new Card({
            icon: '📋',
            title: 'MCP 服务列表',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async list(): Promise<string> {
        const result = await this.mcpApp.callWorker('getServers');
        const servers = result.status === 'ok' ? result.data : [];
        return JSON.stringify({ servers });
    }
}

const DeleteMcpServerArgsSchema = z.object({
    nameOrId: z.string().describe('Server name or ID to delete')
});

export class DeleteMcpServerTool extends BaseTool<typeof DeleteMcpServerArgsSchema> {
    private mcpApp: any;

    constructor(mcpApp: any) {
        super('deleteMcpServer', 'Delete an MCP server by name or ID', DeleteMcpServerArgsSchema);
        this.mcpApp = mcpApp;
        this.setExecutor(this.delete.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const nameOrId = args?.['nameOrId'];
        const body: string[] = [];

        if (nameOrId) {
            body.push(chalk.dim('目标: ') + chalk.magenta(String(nameOrId)));
        }

        if (toolcall.status === 'running') {
            body.push(chalk.dim('  ⏳ 删除中…'));
        } else if (toolcall.status === 'success' && toolcall.result) {
            try {
                const result = JSON.parse(toolcall.result);
                body.push(chalk.dim('  ✓ 删除成功: ') + chalk.green(result.name));
            } catch {
                body.push(chalk.dim('  ✓ 删除成功!'));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(toolcall.result, width - 10)));
        }

        return new Card({
            icon: '🗑️',
            title: '删除 MCP 服务',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async delete(args: z.output<typeof DeleteMcpServerArgsSchema>): Promise<string> {
        const servers = this.mcpApp.getServersFromConfig();
        const server = servers.find((s: any) => s.name === args.nameOrId || s.id === args.nameOrId);

        if (!server) {
            throw new Error(`MCP server "${args.nameOrId}" not found`);
        }

        await this.mcpApp.deleteServer(server.id);
        return JSON.stringify({
            success: true,
            message: `MCP server "${server.name}" deleted successfully`,
            serverId: server.id,
            name: server.name
        });
    }
}

const ToggleMcpServerArgsSchema = z.object({
    nameOrId: z.string().describe('Server name or ID to toggle'),
    enabled: z.boolean().describe('Whether to enable (true) or disable (false) the server')
});

export class ToggleMcpServerTool extends BaseTool<typeof ToggleMcpServerArgsSchema> {
    private mcpApp: any;

    constructor(mcpApp: any) {
        super(
            'toggleMcpServer',
            'Toggle an MCP server on/off by name or ID. Set enabled=true to activate the server, enabled=false to deactivate it. The server configuration is preserved.',
            ToggleMcpServerArgsSchema
        );
        this.mcpApp = mcpApp;
        this.setExecutor(this.toggle.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const nameOrId = args?.['nameOrId'];
        const enabled = args?.['enabled'];
        const body: string[] = [];

        if (nameOrId) {
            body.push(chalk.dim('目标: ') + chalk.magenta(String(nameOrId)));
        }
        if (enabled !== undefined) {
            const statusText = enabled ? chalk.green('启用') : chalk.yellow('禁用');
            body.push(chalk.dim('操作: ') + statusText);
        }

        if (toolcall.status === 'running') {
            body.push(chalk.dim('  ⏳ 执行中…'));
        } else if (toolcall.status === 'success' && toolcall.result) {
            try {
                const result = JSON.parse(toolcall.result);
                const icon = result.enabled ? '✓' : '⏸';
                const color = result.enabled ? chalk.green : chalk.yellow;
                body.push(chalk.dim(`  ${icon} `) + color(`${result.name} 已${result.enabled ? '启用' : '禁用'}`));
            } catch {
                body.push(chalk.dim('  ✓ 操作成功!'));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(toolcall.result, width - 10)));
        }

        const icon = enabled ? '▶️' : '⏸️';
        const title = enabled ? '启用 MCP 服务' : '禁用 MCP 服务';
        return new Card({ icon, title, status: statusDisplay(toolcall.status), body }).render(width);
    }

    private async toggle(args: z.output<typeof ToggleMcpServerArgsSchema>): Promise<string> {
        const servers = this.mcpApp.getServersFromConfig();
        const server = servers.find((s: any) => s.name === args.nameOrId || s.id === args.nameOrId);

        if (!server) {
            throw new Error(`MCP server "${args.nameOrId}" not found`);
        }

        if (server.enabled === args.enabled) {
            return JSON.stringify({
                success: true,
                message: `MCP server "${server.name}" is already ${args.enabled ? 'enabled' : 'disabled'}`,
                serverId: server.id,
                name: server.name,
                enabled: args.enabled,
                alreadyInState: true
            });
        }

        if (args.enabled) {
            // 启用服务器：更新配置并尝试连接
            await this.mcpApp.toggleServer(server.id, true);
            try {
                await this.mcpApp.callWorker('connectServer', server.id);
                return JSON.stringify({
                    success: true,
                    message: `MCP server "${server.name}" enabled and connected successfully`,
                    serverId: server.id,
                    name: server.name,
                    enabled: true
                });
            } catch (err: any) {
                return JSON.stringify({
                    success: true,
                    message: `MCP server "${server.name}" enabled but connection failed: ${err.message}`,
                    serverId: server.id,
                    name: server.name,
                    enabled: true,
                    warning: 'Server enabled but not connected. Please check the configuration.'
                });
            }
        } else {
            // 禁用服务器：先断开连接再更新配置
            try {
                await this.mcpApp.callWorker('disconnectServer', server.id);
            } catch {
                // 忽略断开连接的错误
            }

            await this.mcpApp.toggleServer(server.id, false);
            return JSON.stringify({
                success: true,
                message: `MCP server "${server.name}" disabled successfully`,
                serverId: server.id,
                name: server.name,
                enabled: false
            });
        }
    }
}
