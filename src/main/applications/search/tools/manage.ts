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
import type { WebSearchChannel } from './webSearch';
import type { AcademicSearchChannel } from './academicSearch';
import chalk from 'chalk';
import { z } from 'zod';

const ConfigureSearchToolArgsSchema = z.object({
    channel: z
        .string()
        .describe(
            '搜索渠道ID，如 "tavily", "brave", "bocha", "exa"（用于设置API密钥），或 "defaultWebSearch" / "defaultAcademicSearch"（用于切换默认渠道），或 "webSearchEnabled" / "academicSearchEnabled"（用于开关搜索工具）'
        ),
    api_key: z.string().optional().describe('API密钥，适用于需要API的搜索渠道'),
    value: z.string().optional().describe('设置默认渠道时的渠道ID值，或设置开关时的 "true"/"false"')
});

export class ConfigureSearchTool extends BaseTool<typeof ConfigureSearchToolArgsSchema> {
    private searchApp: SearchApplication;

    constructor(searchApp: SearchApplication) {
        super(
            'configureSearchTool',
            '配置搜索工具，包括设置渠道API密钥和切换默认搜索引擎。使用此工具来配置Tavily、Brave、博查、Exa等需要API的渠道，或切换默认网页搜索/学术搜索引擎。',
            ConfigureSearchToolArgsSchema,
            undefined,
            { 'zh-CN': '配置搜索工具', 'en-US': 'Configure Search Tool' }
        );
        this.searchApp = searchApp;
        this.setExecutor(this.configure.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const channel = args?.['channel'];
        const body: string[] = [];

        if (channel) {
            body.push(chalk.dim('渠道: ') + chalk.cyan(String(channel)));
        }
        if (args?.['api_key'] !== undefined) {
            body.push(chalk.dim('API密钥: ') + chalk.yellow(args['api_key'] ? '已设置' : '已清空'));
        }
        if (args?.['value'] !== undefined) {
            body.push(chalk.dim('值: ') + chalk.green(String(args['value'])));
        }

        if (toolcall.status === 'running') {
            body.push(chalk.dim('  ⏳ 配置中…'));
        } else if (toolcall.status === 'success' && toolcall.result) {
            try {
                const result = JSON.parse(toolcall.result);
                body.push(chalk.dim('  ✓ ') + chalk.green(result.message));
            } catch {
                body.push(chalk.dim('  ✓ 配置成功!'));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(toolcall.result, width - 10)));
        }

        return new Card({
            icon: '⚙️',
            title: '配置搜索工具',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async configure(args: z.output<typeof ConfigureSearchToolArgsSchema>): Promise<string> {
        const { channel, api_key, value } = args;

        // 设置默认渠道
        if (channel === 'defaultWebSearch' && value) {
            await this.searchApp.setDefaultWebSearch(value as WebSearchChannel);
            return JSON.stringify({
                success: true,
                message: `默认网页搜索引擎已切换为 "${value}"`,
                channel: value
            });
        }

        if (channel === 'defaultAcademicSearch' && value) {
            await this.searchApp.setDefaultAcademicSearch(value as AcademicSearchChannel);
            return JSON.stringify({
                success: true,
                message: `默认学术搜索引擎已切换为 "${value}"`,
                channel: value
            });
        }

        // 切换网页搜索开关
        if (channel === 'webSearchEnabled') {
            const enabled = value === 'true' || value === '1';
            await this.searchApp.setWebSearchEnabled(enabled);
            return JSON.stringify({
                success: true,
                message: `网页搜索工具已${enabled ? '启用' : '关闭'}`,
                channel: 'webSearchEnabled',
                enabled
            });
        }

        // 切换学术搜索开关
        if (channel === 'academicSearchEnabled') {
            const enabled = value === 'true' || value === '1';
            await this.searchApp.setAcademicSearchEnabled(enabled);
            return JSON.stringify({
                success: true,
                message: `学术搜索工具已${enabled ? '启用' : '关闭'}`,
                channel: 'academicSearchEnabled',
                enabled
            });
        }

        // 设置 API Key
        if (api_key !== undefined) {
            await this.searchApp.setChannelApiKey(channel, api_key);
            return JSON.stringify({
                success: true,
                message: `渠道 "${channel}" 的API密钥已${api_key ? '设置' : '清空'}`,
                channel
            });
        }

        throw new Error(`无效的配置参数。使用 channel + value 来切换默认渠道，或 channel + api_key 来设置API密钥。`);
    }
}

const ListSearchToolsArgsSchema = z.object({});

export class ListSearchToolsTool extends BaseTool<typeof ListSearchToolsArgsSchema> {
    private searchApp: SearchApplication;

    constructor(searchApp: SearchApplication) {
        super('listSearchTools', '列出所有可用的搜索渠道及其配置状态', ListSearchToolsArgsSchema, undefined, {
            'zh-CN': '搜索工具列表',
            'en-US': 'List Search Tools'
        });
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
                    body.push(chalk.dim('  暂无搜索渠道'));
                } else {
                    body.push(chalk.dim(`  共 ${chalk.white(String(tools.length))} 个搜索渠道:`));
                    for (const tool of tools) {
                        const apiKeyStatus = tool.needsApiKey
                            ? tool.apiKeyConfigured
                                ? chalk.yellow(' [API已设置]')
                                : chalk.red(' [需要API密钥]')
                            : '';
                        body.push(
                            `    ${chalk.cyan(String(tool.name))} (${chalk.magenta(String(tool.type))})${apiKeyStatus}`
                        );
                    }
                }

                if (result.defaultWebSearch) {
                    body.push(chalk.dim(`  默认网页搜索: ${chalk.white(result.defaultWebSearch)}`));
                }
                if (result.defaultAcademicSearch) {
                    body.push(chalk.dim(`  默认学术搜索: ${chalk.white(result.defaultAcademicSearch)}`));
                }
                body.push(
                    chalk.dim(`  网页搜索: `) + (result.webSearchEnabled ? chalk.green('已启用') : chalk.red('已关闭'))
                );
                body.push(
                    chalk.dim(`  学术搜索: `) +
                        (result.academicSearchEnabled ? chalk.green('已启用') : chalk.red('已关闭'))
                );
            } catch {
                body.push(chalk.dim('  ✓ 已获取搜索渠道列表'));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(toolcall.result, width - 10)));
        }

        return new Card({
            icon: '📋',
            title: '搜索渠道列表',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async list(): Promise<string> {
        const webChannels = this.searchApp.getAvailableWebChannels();
        const academicChannels = this.searchApp.getAcademicChannels();
        const defaultWeb = this.searchApp.getEffectiveWebSearchChannel();
        const defaultAcademic = this.searchApp.getEffectiveAcademicSearchChannel();
        const config = this.searchApp.getConfig();
        const webEnabled = config?.webSearchEnabled ?? true;
        const academicEnabled = config?.academicSearchEnabled ?? true;

        const allChannels = [
            ...webChannels.map((ch) => ({
                id: ch.id,
                name: ch.name,
                description: ch.description,
                type: 'web',
                isDefault: webEnabled && ch.id === defaultWeb,
                needsApiKey: ch.needsApiKey,
                apiKeyConfigured: ch.apiKeyConfigured,
                available: ch.available
            })),
            ...academicChannels.map((ch) => ({
                id: ch.id,
                name: ch.name,
                description: ch.description,
                type: 'academic',
                isDefault: academicEnabled && ch.id === defaultAcademic,
                needsApiKey: false,
                apiKeyConfigured: true,
                available: true
            }))
        ];

        return JSON.stringify({
            tools: allChannels,
            defaultWebSearch: defaultWeb,
            defaultAcademicSearch: defaultAcademic,
            webSearchEnabled: webEnabled,
            academicSearchEnabled: academicEnabled
        });
    }
}

const ToggleSearchToolArgsSchema = z.object({
    id: z.string().describe('要切换的搜索工具ID'),
    enabled: z.boolean().describe('是否启用该工具，true为启用，false为禁用')
});

export class ToggleSearchToolTool extends BaseTool<typeof ToggleSearchToolArgsSchema> {
    private searchApp: SearchApplication;

    constructor(searchApp: SearchApplication) {
        super(
            'toggleSearchTool',
            '切换默认搜索引擎。传入渠道ID将其设为默认，传入空字符串将重置为默认。',
            ToggleSearchToolArgsSchema,
            undefined,
            { 'zh-CN': '启用/停用搜索工具', 'en-US': 'Toggle Search Tool' }
        );
        this.searchApp = searchApp;
        this.setExecutor(this.toggle.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const id = args?.['id'];
        const enabled = args?.['enabled'];
        const body: string[] = [];

        if (id) {
            body.push(chalk.dim('渠道: ') + chalk.cyan(String(id)));
        }
        if (enabled !== undefined) {
            body.push(chalk.dim('操作: ') + (enabled ? chalk.green('设为默认') : chalk.gray('取消')));
        }

        if (toolcall.status === 'running') {
            body.push(chalk.dim('  ⏳ 更新中…'));
        } else if (toolcall.status === 'success' && toolcall.result) {
            try {
                const result = JSON.parse(toolcall.result);
                body.push(chalk.dim('  ✓ ') + chalk.green(result.message));
            } catch {
                body.push(chalk.dim('  ✓ 操作成功!'));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(toolcall.result, width - 10)));
        }

        return new Card({
            icon: '🔄',
            title: '切换默认搜索引擎',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async toggle(args: z.output<typeof ToggleSearchToolArgsSchema>): Promise<string> {
        const { id, enabled } = args;

        if (enabled) {
            // 尝试设为 web 默认搜索
            const webChannels = this.searchApp.getAvailableWebChannels();
            const isWeb = webChannels.some((ch) => ch.id === id);
            if (isWeb) {
                if (!this.searchApp.isChannelAvailable(id)) {
                    throw new Error(`渠道 "${id}" 需要API密钥，请先通过 configureSearchTool 设置API密钥。`);
                }
                await this.searchApp.setDefaultWebSearch(id as WebSearchChannel);
                return JSON.stringify({
                    success: true,
                    message: `默认网页搜索引擎已切换为 "${id}"`,
                    channel: id
                });
            }

            // 尝试设为学术默认搜索
            const academicChannels = this.searchApp.getAcademicChannels();
            const isAcademic = academicChannels.some((ch) => ch.id === id);
            if (isAcademic) {
                await this.searchApp.setDefaultAcademicSearch(id as AcademicSearchChannel);
                return JSON.stringify({
                    success: true,
                    message: `默认学术搜索引擎已切换为 "${id}"`,
                    channel: id
                });
            }

            throw new Error(`未知的搜索渠道 "${id}"`);
        }

        return JSON.stringify({
            success: false,
            message: `取消默认引擎的操作不受支持，请选择其他渠道作为默认。`
        });
    }
}
