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
import { t } from './locale/index.js';
import type { McpServerConfig } from './common.js';

const McpTransportSchema = z.enum(['stdio', 'sse', 'streamableHttp']);

const InstallMcpServerBaseArgsShape = {
    name: z.string().trim().min(1).describe('Server name, e.g., "filesystem", "github", "my-server"'),
    enabled: z.boolean().default(true).describe('Whether to enable the server after installation')
};

const StdioInstallMcpServerArgsSchema = z.object({
    ...InstallMcpServerBaseArgsShape,
    transport: z.literal('stdio').describe('Use stdio for local command-line MCP servers'),
    command: z
        .string()
        .trim()
        .min(1)
        .describe('Required command for stdio transport, e.g., "npx", "node", "python", "uvx"'),
    args: z
        .array(z.string())
        .default([])
        .describe('Arguments for stdio transport, e.g., ["-y", "@modelcontextprotocol/server-filesystem", "/path"]'),
    cwd: z.string().trim().min(1).optional().describe('Optional working directory for stdio transport'),
    env: z.record(z.string(), z.string()).default({}).describe('Environment variables for stdio transport')
});

const SseInstallMcpServerArgsSchema = z.object({
    ...InstallMcpServerBaseArgsShape,
    transport: z.literal('sse').describe('Use sse for remote Server-Sent Events MCP servers'),
    url: z.string().trim().min(1).describe('Required URL for sse transport'),
    headers: z.record(z.string(), z.string()).default({}).describe('HTTP headers for sse transport')
});

const StreamableHttpInstallMcpServerArgsSchema = z.object({
    ...InstallMcpServerBaseArgsShape,
    transport: z.literal('streamableHttp').describe('Use streamableHttp for remote Streamable HTTP MCP servers'),
    url: z.string().trim().min(1).describe('Required URL for streamableHttp transport'),
    headers: z.record(z.string(), z.string()).default({}).describe('HTTP headers for streamableHttp transport')
});

const InstallMcpServerArgsSchema = z.discriminatedUnion('transport', [
    StdioInstallMcpServerArgsSchema,
    SseInstallMcpServerArgsSchema,
    StreamableHttpInstallMcpServerArgsSchema
]);

function findServerByNameOrId(servers: McpServerConfig[], nameOrId: string): McpServerConfig | undefined {
    return servers.find((server) => server.name === nameOrId || server.id === nameOrId);
}

function validateServerConfig(config: Partial<McpServerConfig> & Pick<McpServerConfig, 'transport'>): void {
    if (config.transport === 'stdio') {
        if (!config.command?.trim()) {
            throw new Error(`MCP server "${config.name || config.id || ''}" requires command for stdio transport`);
        }
        return;
    }

    if (!config.url?.trim()) {
        throw new Error(
            `MCP server "${config.name || config.id || ''}" requires url for ${config.transport} transport`
        );
    }
}

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
            body.push(chalk.dim(t('cli.install.server')) + chalk.cyan(String(name)));
        }
        if (transport) {
            body.push(chalk.dim(t('cli.install.transport')) + chalk.yellow(String(transport)));
        }

        if (toolcall.status === 'running') {
            body.push(chalk.dim(`  ⏳ ${t('cli.install.running')}`));
        } else if (toolcall.status === 'success' && toolcall.result) {
            try {
                const result = JSON.parse(toolcall.result);
                if (result.alreadyExists) {
                    body.push(chalk.dim('  ✨ ' + t('cli.install.exists')) + chalk.yellow(result.name));
                } else if (result.warning) {
                    body.push(chalk.dim('  ✓ ' + t('cli.install.successConnectFailed')) + chalk.red(result.warning));
                } else {
                    body.push(chalk.dim(`  ✓ ${t('cli.install.success')}`));
                }
            } catch {
                body.push(chalk.dim(`  ✓ ${t('cli.install.success')}`));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(toolcall.result, width - 10)));
        }

        return new Card({
            icon: '📦',
            title: t('cli.install.cardTitle'),
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
            body.push(chalk.dim(`  ⏳ ${t('cli.list.loading')}`));
        } else if (toolcall.status === 'success' && toolcall.result) {
            try {
                const result = JSON.parse(toolcall.result);
                const servers = Array.isArray(result.servers) ? result.servers : [];
                if (servers.length === 0) {
                    body.push(chalk.dim(`  ${t('cli.list.empty')}`));
                } else {
                    body.push(chalk.dim(`  ${t('cli.list.found', { count: chalk.white(String(servers.length)) })}`));
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
                        body.push(chalk.dim(`    ${t('cli.list.more', { count: servers.length - 5 })}`));
                    }
                }
            } catch {
                body.push(chalk.dim(`  ✓ ${t('cli.list.success')}`));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(toolcall.result, width - 10)));
        }

        return new Card({
            icon: '📋',
            title: t('cli.list.cardTitle'),
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

const ListMcpRegistriesArgsSchema = z.object({});

export class ListMcpRegistriesTool extends BaseTool<typeof ListMcpRegistriesArgsSchema> {
    private mcpApp: any;

    constructor(mcpApp: any) {
        super(
            'listMcpRegistries',
            'List MCP registries available in the MCP marketplace, including registry IDs used by searchMcpRegistry.',
            ListMcpRegistriesArgsSchema
        );
        this.mcpApp = mcpApp;
        this.setExecutor(this.list.bind(this));
    }

    private async list(): Promise<string> {
        const registries = await this.mcpApp.getMcpRegistries();
        return JSON.stringify({ registries });
    }
}

const SearchMcpRegistryArgsSchema = z.object({
    registryId: z.string().trim().min(1).describe('Registry ID from listMcpRegistries, e.g., "matrix"'),
    query: z.string().default('').describe('Search keyword. Use an empty string to list popular/default entries.'),
    page: z.number().int().min(1).default(1).describe('Page number, starting from 1'),
    limit: z.number().int().min(1).max(60).default(30).describe('Maximum entries to return'),
    cursor: z.string().optional().describe('Optional registry cursor for cursor-based pagination')
});

export class SearchMcpRegistryTool extends BaseTool<typeof SearchMcpRegistryArgsSchema> {
    private mcpApp: any;

    constructor(mcpApp: any) {
        super(
            'searchMcpRegistry',
            'Search an MCP registry marketplace for MCP servers. Use listMcpRegistries first if the registry ID is unknown.',
            SearchMcpRegistryArgsSchema
        );
        this.mcpApp = mcpApp;
        this.setExecutor(this.search.bind(this));
    }

    private async search(args: z.output<typeof SearchMcpRegistryArgsSchema>): Promise<string> {
        const result = await this.mcpApp.searchMcpRegistry(
            args.registryId,
            args.query,
            args.page,
            args.limit,
            args.cursor
        );
        return JSON.stringify(result);
    }
}

const GetMcpRegistryEntryArgsSchema = z.object({
    registryId: z.string().trim().min(1).describe('Registry ID from listMcpRegistries'),
    id: z.string().trim().min(1).describe('MCP entry ID returned by searchMcpRegistry')
});

export class GetMcpRegistryEntryTool extends BaseTool<typeof GetMcpRegistryEntryArgsSchema> {
    private mcpApp: any;

    constructor(mcpApp: any) {
        super(
            'getMcpRegistryEntry',
            'Get full details and install configuration for one MCP registry entry.',
            GetMcpRegistryEntryArgsSchema
        );
        this.mcpApp = mcpApp;
        this.setExecutor(this.getDetail.bind(this));
    }

    private async getDetail(args: z.output<typeof GetMcpRegistryEntryArgsSchema>): Promise<string> {
        const entry = await this.mcpApp.getRegistryMcpDetail(args.registryId, args.id);
        if (!entry) {
            throw new Error(`MCP registry entry "${args.id}" not found in registry "${args.registryId}"`);
        }
        return JSON.stringify({ entry });
    }
}

const InstallMcpServerFromRegistryArgsSchema = z.union([
    z.object({
        installUrl: z.string().trim().min(1).describe('Install URL returned by searchMcpRegistry, e.g., "matrix:<id>"'),
        registryId: z.string().trim().min(1).optional().describe('Registry ID from listMcpRegistries'),
        id: z.string().trim().min(1).optional().describe('MCP entry ID returned by searchMcpRegistry'),
        force: z
            .boolean()
            .default(false)
            .describe('When true, update an existing matching MCP server instead of skipping it')
    }),
    z.object({
        installUrl: z
            .string()
            .trim()
            .min(1)
            .optional()
            .describe('Install URL returned by searchMcpRegistry, e.g., "matrix:<id>"'),
        registryId: z.string().trim().min(1).describe('Registry ID from listMcpRegistries'),
        id: z.string().trim().min(1).describe('MCP entry ID returned by searchMcpRegistry'),
        force: z
            .boolean()
            .default(false)
            .describe('When true, update an existing matching MCP server instead of skipping it')
    })
]);

export class InstallMcpServerFromRegistryTool extends BaseTool<typeof InstallMcpServerFromRegistryArgsSchema> {
    private mcpApp: any;

    constructor(mcpApp: any) {
        super(
            'installMcpServerFromRegistry',
            'Install an MCP server from a registry marketplace entry. Use searchMcpRegistry to find entries first.',
            InstallMcpServerFromRegistryArgsSchema
        );
        this.mcpApp = mcpApp;
        this.setExecutor(this.install.bind(this));
    }

    private async resolveInstallUrl(args: z.output<typeof InstallMcpServerFromRegistryArgsSchema>): Promise<string> {
        if (args.installUrl) return args.installUrl;
        const entry = await this.mcpApp.getRegistryMcpDetail(args.registryId, args.id);
        if (!entry) {
            throw new Error(`MCP registry entry "${args.id}" not found in registry "${args.registryId}"`);
        }
        if (!entry.canInstall || !entry.installUrl) {
            throw new Error(`MCP registry entry "${entry.name || entry.id}" does not provide installable config`);
        }
        return entry.installUrl;
    }

    private async install(args: z.output<typeof InstallMcpServerFromRegistryArgsSchema>): Promise<string> {
        const installUrl = await this.resolveInstallUrl(args);
        const result = await this.mcpApp.installFromRegistry(installUrl, args.force);
        return JSON.stringify(result);
    }
}

const ImportMcpServersFromJsonArgsSchema = z.object({
    jsonConfig: z
        .string()
        .trim()
        .min(1)
        .describe('MCP JSON config, such as Claude Desktop/Cursor config with an mcpServers object')
});

export class ImportMcpServersFromJsonTool extends BaseTool<typeof ImportMcpServersFromJsonArgsSchema> {
    private mcpApp: any;

    constructor(mcpApp: any) {
        super(
            'importMcpServersFromJson',
            'Import MCP server configurations from JSON, including Claude Desktop or Cursor mcpServers config.',
            ImportMcpServersFromJsonArgsSchema
        );
        this.mcpApp = mcpApp;
        this.setExecutor(this.importJson.bind(this));
    }

    private async importJson(args: z.output<typeof ImportMcpServersFromJsonArgsSchema>): Promise<string> {
        const imported = await this.mcpApp.importFromJson(args.jsonConfig);
        return JSON.stringify({
            success: true,
            imported,
            message: `Imported ${imported} MCP server${imported === 1 ? '' : 's'} from JSON config`
        });
    }
}

const UpdateMcpServerArgsSchema = z.object({
    nameOrId: z.string().trim().min(1).describe('Existing MCP server name or ID to update'),
    name: z.string().trim().min(1).optional().describe('New server display name'),
    transport: McpTransportSchema.optional().describe('New transport type'),
    enabled: z.boolean().optional().describe('Whether this MCP server should be enabled'),
    command: z.string().trim().min(1).optional().describe('Command for stdio transport'),
    args: z.array(z.string()).optional().describe('Arguments for stdio transport'),
    cwd: z.string().optional().describe('Working directory for stdio transport. Use an empty string to clear it.'),
    url: z.string().trim().min(1).optional().describe('URL for sse/streamableHttp transport'),
    env: z.record(z.string(), z.string()).optional().describe('Environment variables for stdio transport'),
    headers: z.record(z.string(), z.string()).optional().describe('HTTP headers for sse/streamableHttp transport')
});

export class UpdateMcpServerTool extends BaseTool<typeof UpdateMcpServerArgsSchema> {
    private mcpApp: any;

    constructor(mcpApp: any) {
        super(
            'updateMcpServer',
            'Edit an installed MCP server configuration by name or ID. Supports the same fields as the GUI editor.',
            UpdateMcpServerArgsSchema
        );
        this.mcpApp = mcpApp;
        this.setExecutor(this.update.bind(this));
    }

    private async update(args: z.output<typeof UpdateMcpServerArgsSchema>): Promise<string> {
        const servers = this.mcpApp.getServersFromConfig();
        const server = findServerByNameOrId(servers, args.nameOrId);
        if (!server) {
            throw new Error(`MCP server "${args.nameOrId}" not found`);
        }

        const updates: Partial<McpServerConfig> = {};
        if (args.name !== undefined) updates.name = args.name;
        if (args.transport !== undefined) updates.transport = args.transport;
        if (args.enabled !== undefined) updates.enabled = args.enabled;
        if (args.command !== undefined) updates.command = args.command;
        if (args.args !== undefined) updates.args = args.args;
        if (args.cwd !== undefined) updates.cwd = args.cwd.trim() ? args.cwd : undefined;
        if (args.url !== undefined) updates.url = args.url;
        if (args.env !== undefined) updates.env = args.env;
        if (args.headers !== undefined) updates.headers = args.headers;

        const merged: McpServerConfig = {
            ...server,
            ...updates,
            transport: updates.transport || server.transport
        };

        if (merged.transport === 'stdio') {
            merged.url = undefined;
            merged.headers = undefined;
            merged.args = merged.args || [];
            merged.env = merged.env || {};
        } else {
            merged.command = undefined;
            merged.args = [];
            merged.cwd = undefined;
            merged.env = {};
            merged.headers = merged.headers || {};
        }

        validateServerConfig(merged);
        await this.mcpApp.updateServer(server.id, merged);

        return JSON.stringify({
            success: true,
            message: `MCP server "${merged.name}" updated successfully`,
            serverId: server.id,
            name: merged.name,
            transport: merged.transport,
            enabled: merged.enabled
        });
    }
}

const ReconnectMcpServerArgsSchema = z.object({
    nameOrId: z.string().trim().min(1).describe('Installed MCP server name or ID to reconnect')
});

export class ReconnectMcpServerTool extends BaseTool<typeof ReconnectMcpServerArgsSchema> {
    private mcpApp: any;

    constructor(mcpApp: any) {
        super(
            'reconnectMcpServer',
            'Reconnect an installed MCP server by name or ID, matching the GUI reconnect action.',
            ReconnectMcpServerArgsSchema
        );
        this.mcpApp = mcpApp;
        this.setExecutor(this.reconnect.bind(this));
    }

    private async reconnect(args: z.output<typeof ReconnectMcpServerArgsSchema>): Promise<string> {
        const servers = this.mcpApp.getServersFromConfig();
        const server = findServerByNameOrId(servers, args.nameOrId);
        if (!server) {
            throw new Error(`MCP server "${args.nameOrId}" not found`);
        }

        await this.mcpApp.callWorker('reconnectServer', server.id);
        return JSON.stringify({
            success: true,
            message: `MCP server "${server.name}" reconnected successfully`,
            serverId: server.id,
            name: server.name
        });
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
            body.push(chalk.dim(t('cli.delete.target')) + chalk.magenta(String(nameOrId)));
        }

        if (toolcall.status === 'running') {
            body.push(chalk.dim(`  ⏳ ${t('cli.delete.running')}`));
        } else if (toolcall.status === 'success' && toolcall.result) {
            try {
                const result = JSON.parse(toolcall.result);
                body.push(chalk.dim('  ✓ ' + t('cli.delete.successWithName')) + chalk.green(result.name));
            } catch {
                body.push(chalk.dim(`  ✓ ${t('cli.delete.success')}`));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(toolcall.result, width - 10)));
        }

        return new Card({
            icon: '🗑️',
            title: t('cli.delete.cardTitle'),
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
            body.push(chalk.dim(t('cli.delete.target')) + chalk.magenta(String(nameOrId)));
        }
        if (enabled !== undefined) {
            const statusText = enabled ? chalk.green(t('cli.toggle.enable')) : chalk.yellow(t('cli.toggle.disable'));
            body.push(chalk.dim(t('cli.toggle.operation')) + statusText);
        }

        if (toolcall.status === 'running') {
            body.push(chalk.dim(`  ⏳ ${t('cli.toggle.running')}`));
        } else if (toolcall.status === 'success' && toolcall.result) {
            try {
                const result = JSON.parse(toolcall.result);
                const icon = result.enabled ? '✓' : '⏸';
                const color = result.enabled ? chalk.green : chalk.yellow;
                body.push(
                    chalk.dim(`  ${icon} `) +
                        color(
                            t(result.enabled ? 'cli.toggle.result.enabled' : 'cli.toggle.result.disabled', {
                                name: result.name
                            })
                        )
                );
            } catch {
                body.push(chalk.dim(`  ✓ ${t('cli.toggle.success')}`));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(toolcall.result, width - 10)));
        }

        const icon = enabled ? '▶️' : '⏸️';
        const title = enabled ? t('cli.toggle.cardTitle.enabled') : t('cli.toggle.cardTitle.disabled');
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
