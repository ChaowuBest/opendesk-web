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

import { BaseTool } from '../../../aikernel/tool';
import { ToolCall } from '../../../aikernel/messages';
import { Card } from '../../../tui/components/card';
import { statusDisplay, truncText } from '../../../tui/components/toolcall';
import { type SearchApplication } from '../app';
import chalk from 'chalk';
import { z } from 'zod';


const ConfigureSearchToolArgsSchema = z.object({
    id: z.string().describe('搜索工具的ID，如 "bing", "duckduckgo", "brave", "tavily", "bocha", "exa", "arxiv"'),
    api_key: z.string().optional().describe('API密钥，适用于需要API的搜索工具'),
    enabled: z.boolean().optional().describe('是否启用该搜索工具'),
});

export class ConfigureSearchTool extends BaseTool<typeof ConfigureSearchToolArgsSchema> {
    private searchApp: SearchApplication;

    constructor(searchApp: SearchApplication) {
        super(
            'configureSearchTool',
            '配置搜索工具，包括设置API密钥和启用/禁用状态。使用此工具来配置Brave Search、Tavily Search、Exa Search等需要API的工具。',
            ConfigureSearchToolArgsSchema,
        );
        this.searchApp = searchApp;
        this.setExecutor(this.configure.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const id = args?.['id'];
        const body: string[] = [];

        if (id) {
            body.push(chalk.dim('工具: ') + chalk.cyan(String(id)));
        }
        if (args?.['api_key'] !== undefined) {
            body.push(chalk.dim('API密钥: ') + chalk.yellow(args['api_key'] ? '已设置' : '已清空'));
        }
        if (args?.['enabled'] !== undefined) {
            body.push(chalk.dim('状态: ') + (args['enabled'] ? chalk.green('启用') : chalk.gray('禁用')));
        }

        if (toolcall.status === 'running') {
            body.push(chalk.dim('  ⏳ 配置中…'));
        } else if (toolcall.status === 'success' && toolcall.result) {
            try {
                const result = JSON.parse(toolcall.result);
                body.push(chalk.dim('  ✓ 配置成功: ') + chalk.green(result.name));
            } catch {
                body.push(chalk.dim('  ✓ 配置成功!'));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(toolcall.result, width - 10)));
        }

        return new Card({ icon: '⚙️', title: '配置搜索工具', status: statusDisplay(toolcall.status), body }).render(width);
    }

    private async configure(args: z.output<typeof ConfigureSearchToolArgsSchema>): Promise<string> {
        const tools = this.searchApp.getSearchToolsFromConfig();
        const tool = tools.find((t: any) => t.id === args.id);

        if (!tool) {
            throw new Error(`搜索工具 "${args.id}" 未找到`);
        }

        const updates: any = {};
        if (args.api_key !== undefined) {
            updates.api_key = args.api_key;
        }
        if (args.enabled !== undefined) {
            updates.enabled = args.enabled;
        }

        await this.searchApp.configureSearchTool(args.id, updates);

        return JSON.stringify({
            success: true,
            message: `搜索工具 "${tool.name}" 配置成功`,
            id: tool.id,
            name: tool.name,
        });
    }
}


const ListSearchToolsArgsSchema = z.object({});

export class ListSearchToolsTool extends BaseTool<typeof ListSearchToolsArgsSchema> {
    private searchApp: any;

    constructor(searchApp: any) {
        super(
            'listSearchTools',
            '列出所有可用的搜索工具及其状态和配置信息',
            ListSearchToolsArgsSchema,
        );
        this.searchApp = searchApp;
        this.setExecutor(this.list.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const body: string[] = [];

        if (toolcall.status === 'running') {
            body.push(chalk.dim('  ⏳ 加载中…'));
        } else if (toolcall.status === 'success' && toolcall.result) {
            try {
                const result = JSON.parse(toolcall.result);
                const tools = Array.isArray(result.tools) ? result.tools : [];
                if (tools.length === 0) {
                    body.push(chalk.dim('  暂无搜索工具'));
                } else {
                    body.push(chalk.dim(`  找到 ${chalk.white(String(tools.length))} 个搜索工具:`));
                    for (const tool of tools) {
                        const statusIcon = tool.enabled ? '✓' : '○';
                        const statusColor = tool.enabled ? chalk.green : chalk.gray;
                        const hasApiKey = tool.api_key && tool.api_key.length > 0;
                        const apiKeyIndicator = hasApiKey ? chalk.yellow(' [API已设置]') : '';
                        body.push(`    ${statusColor(statusIcon)} ${chalk.cyan(String(tool.name))} (${chalk.magenta(String(tool.type))})${apiKeyIndicator}`);
                    }
                }
            } catch {
                body.push(chalk.dim('  ✓ 已获取搜索工具列表'));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(toolcall.result, width - 10)));
        }

        return new Card({ icon: '📋', title: '搜索工具列表', status: statusDisplay(toolcall.status), body }).render(width);
    }

    private async list(): Promise<string> {
        const tools = this.searchApp.getSearchToolsFromConfig();
        // 隐藏API密钥的具体值，只显示是否已设置
        const sanitizedTools = tools.map((tool: any) => ({
            ...tool,
            api_key: tool.api_key && tool.api_key.length > 0 ? '****' : '',
        }));
        return JSON.stringify({ tools: sanitizedTools });
    }
}

const ToggleSearchToolArgsSchema = z.object({
    id: z.string().describe('要切换的搜索工具ID'),
    enabled: z.boolean().describe('是否启用该工具，true为启用，false为禁用'),
});

export class ToggleSearchToolTool extends BaseTool<typeof ToggleSearchToolArgsSchema> {
    private searchApp: SearchApplication;

    constructor(searchApp: SearchApplication) {
        super(
            'toggleSearchTool',
            '快速启用或禁用搜索工具，无需修改其他配置',
            ToggleSearchToolArgsSchema,
        );
        this.searchApp = searchApp;
        this.setExecutor(this.toggle.bind(this))
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const id = args?.['id'];
        const enabled = args?.['enabled'];
        const body: string[] = [];

        if (id) {
            body.push(chalk.dim('工具: ') + chalk.cyan(String(id)));
        }
        if (enabled !== undefined) {
            body.push(chalk.dim('操作: ') + (enabled ? chalk.green('启用') : chalk.gray('禁用')));
        }

        if (toolcall.status === 'running') {
            body.push(chalk.dim('  ⏳ 更新中…'));
        } else if (toolcall.status === 'success' && toolcall.result) {
            try {
                const result = JSON.parse(toolcall.result);
                body.push(chalk.dim('  ✓ 操作成功: ') + chalk.green(result.name));
            } catch {
                body.push(chalk.dim('  ✓ 操作成功!'));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(toolcall.result, width - 10)));
        }

        return new Card({ icon: '🔄', title: '切换搜索工具', status: statusDisplay(toolcall.status), body }).render(width);
    }

    private async toggle(args: z.output<typeof ToggleSearchToolArgsSchema>): Promise<string> {
        const tools = this.searchApp.getSearchToolsFromConfig();
        const tool = tools.find((t: any) => t.id === args.id);

        if (!tool) {
            throw new Error(`搜索工具 "${args.id}" 未找到`);
        }

        await this.searchApp.toggleSearchTool(args.id, args.enabled);

        return JSON.stringify({
            success: true,
            message: `搜索工具 "${tool.name}" 已${args.enabled ? '启用' : '禁用'}`,
            id: tool.id,
            name: tool.name,
            enabled: args.enabled,
        });
    }
}
