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
import { type KnowledgeBaseApplication } from '../app';
import chalk from 'chalk';
import { z } from 'zod';

const ListLibraryProvidersArgsSchema = z.object({});

export class ListLibraryProvidersTool extends BaseTool<typeof ListLibraryProvidersArgsSchema> {
    private app: KnowledgeBaseApplication;

    constructor(app: KnowledgeBaseApplication) {
        super('listLibraryProviders', '列出所有知识库服务商及其启用状态和配置信息', ListLibraryProvidersArgsSchema);
        this.app = app;
        this.setExecutor(this.list.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const body: string[] = [];
        if (toolcall.status === 'running') {
            body.push(chalk.dim('  加载中...'));
        } else if (toolcall.status === 'success' && toolcall.result) {
            try {
                const result = JSON.parse(toolcall.result);
                const providers = Array.isArray(result.providers) ? result.providers : [];
                body.push(chalk.dim(`  找到 ${chalk.white(String(providers.length))} 个服务商:`));
                for (const p of providers) {
                    const icon = p.enabled ? chalk.green('✓') : chalk.gray('○');
                    const apiInfo = p.has_api_key ? chalk.yellow(' [API已设置]') : '';
                    body.push(`    ${icon} ${chalk.cyan(p.name)} (${chalk.magenta(p.id)})${apiInfo}`);
                }
            } catch {
                body.push(chalk.dim('  已获取服务商列表'));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(toolcall.result, width - 10)));
        }
        return new Card({
            icon: '📚',
            title: '知识库服务商列表',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async list(): Promise<string> {
        const providers = this.app.getProviderStatusList();
        return JSON.stringify({ providers });
    }
}

const ConfigureLibraryProviderArgsSchema = z.object({
    id: z.string().describe('服务商ID，如 "zhipu"'),
    api_key: z.string().optional().describe('API密钥'),
    enabled: z.boolean().optional().describe('是否启用该服务商')
});

export class ConfigureLibraryProviderTool extends BaseTool<typeof ConfigureLibraryProviderArgsSchema> {
    private app: KnowledgeBaseApplication;

    constructor(app: KnowledgeBaseApplication) {
        super(
            'configureLibraryProvider',
            '配置知识库服务商，包括设置API密钥和启用/禁用',
            ConfigureLibraryProviderArgsSchema
        );
        this.app = app;
        this.setExecutor(this.configure.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const body: string[] = [];
        if (args?.id) body.push(chalk.dim('服务商: ') + chalk.cyan(String(args.id)));
        if (args?.api_key !== undefined)
            body.push(chalk.dim('API密钥: ') + chalk.yellow(args.api_key ? '已设置' : '已清空'));
        if (args?.enabled !== undefined)
            body.push(chalk.dim('状态: ') + (args.enabled ? chalk.green('启用') : chalk.gray('禁用')));

        if (toolcall.status === 'running') {
            body.push(chalk.dim('  配置中...'));
        } else if (toolcall.status === 'success') {
            body.push(chalk.dim('  配置成功'));
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(toolcall.result, width - 10)));
        }
        return new Card({
            icon: '⚙️',
            title: '配置知识库服务商',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async configure(args: z.output<typeof ConfigureLibraryProviderArgsSchema>): Promise<string> {
        this.app.configureProvider(args.id, {
            api_key: args.api_key,
            enabled: args.enabled
        });
        const providers = this.app.getProviderStatusList();
        const p = providers.find((x) => x.id === args.id);
        return JSON.stringify({
            success: true,
            message: `服务商 "${p?.name || args.id}" 配置成功`,
            provider: p
        });
    }
}

const ToggleLibraryProviderArgsSchema = z.object({
    id: z.string().describe('服务商ID'),
    enabled: z.boolean().describe('是否启用')
});

export class ToggleLibraryProviderTool extends BaseTool<typeof ToggleLibraryProviderArgsSchema> {
    private app: KnowledgeBaseApplication;

    constructor(app: KnowledgeBaseApplication) {
        super('toggleLibraryProvider', '快速启用或禁用知识库服务商', ToggleLibraryProviderArgsSchema);
        this.app = app;
        this.setExecutor(this.toggle.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const body: string[] = [];
        if (args?.id) body.push(chalk.dim('服务商: ') + chalk.cyan(String(args.id)));
        if (args?.enabled !== undefined)
            body.push(chalk.dim('操作: ') + (args.enabled ? chalk.green('启用') : chalk.gray('禁用')));

        if (toolcall.status === 'running') {
            body.push(chalk.dim('  更新中...'));
        } else if (toolcall.status === 'success') {
            body.push(chalk.dim('  操作成功'));
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(toolcall.result, width - 10)));
        }
        return new Card({
            icon: '🔄',
            title: '切换知识库服务商',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async toggle(args: z.output<typeof ToggleLibraryProviderArgsSchema>): Promise<string> {
        this.app.configureProvider(args.id, { enabled: args.enabled });
        const providers = this.app.getProviderStatusList();
        const p = providers.find((x) => x.id === args.id);
        return JSON.stringify({
            success: true,
            message: `服务商 "${p?.name || args.id}" 已${args.enabled ? '启用' : '禁用'}`
        });
    }
}

const CreateKnowledgeBaseArgsSchema = z.object({
    provider_id: z.string().describe('服务商ID，如 "zhipu"'),
    name: z.string().describe('知识库名称'),
    description: z.string().optional().describe('知识库描述')
});

export class CreateKnowledgeBaseTool extends BaseTool<typeof CreateKnowledgeBaseArgsSchema> {
    private app: KnowledgeBaseApplication;

    constructor(app: KnowledgeBaseApplication) {
        super('createKnowledgeBase', '在指定服务商下创建新的知识库', CreateKnowledgeBaseArgsSchema);
        this.app = app;
        this.setExecutor(this.create.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const body: string[] = [];
        if (args?.name) body.push(chalk.dim('名称: ') + chalk.cyan(String(args.name)));
        if (args?.provider_id) body.push(chalk.dim('服务商: ') + chalk.magenta(String(args.provider_id)));

        if (toolcall.status === 'running') {
            body.push(chalk.dim('  创建中...'));
        } else if (toolcall.status === 'success' && toolcall.result) {
            try {
                const r = JSON.parse(toolcall.result);
                body.push(chalk.dim('  创建成功, ID: ') + chalk.green(r.knowledge_base_id));
            } catch {
                body.push(chalk.dim('  创建成功'));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(toolcall.result, width - 10)));
        }
        return new Card({
            icon: '📖',
            title: '创建知识库',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async create(args: z.output<typeof CreateKnowledgeBaseArgsSchema>): Promise<string> {
        const provider = this.app.getProvider(args.provider_id);
        if (!provider) throw new Error(`服务商 "${args.provider_id}" 不存在`);
        if (!provider.isConfigured()) throw new Error(`服务商 "${args.provider_id}" 未配置API密钥`);

        const kb = await provider.createKnowledgeBase(args.name, args.description);
        return JSON.stringify({
            success: true,
            knowledge_base_id: kb.id,
            name: kb.name,
            message: `知识库 "${args.name}" 创建成功`
        });
    }
}

const DeleteKnowledgeBaseArgsSchema = z.object({
    provider_id: z.string().describe('服务商ID'),
    knowledge_base_id: z.string().describe('知识库ID')
});

export class DeleteKnowledgeBaseTool extends BaseTool<typeof DeleteKnowledgeBaseArgsSchema> {
    private app: KnowledgeBaseApplication;

    constructor(app: KnowledgeBaseApplication) {
        super('deleteKnowledgeBase', '删除指定服务商下的知识库', DeleteKnowledgeBaseArgsSchema);
        this.app = app;
        this.setExecutor(this.delete.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const body: string[] = [];
        if (args?.knowledge_base_id) body.push(chalk.dim('知识库ID: ') + chalk.cyan(String(args.knowledge_base_id)));
        if (toolcall.status === 'running') {
            body.push(chalk.dim('  删除中...'));
        } else if (toolcall.status === 'success') {
            body.push(chalk.dim('  删除成功'));
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(toolcall.result, width - 10)));
        }
        return new Card({
            icon: '🗑️',
            title: '删除知识库',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async delete(args: z.output<typeof DeleteKnowledgeBaseArgsSchema>): Promise<string> {
        const provider = this.app.getProvider(args.provider_id);
        if (!provider) throw new Error(`服务商 "${args.provider_id}" 不存在`);
        if (!provider.isConfigured()) throw new Error(`服务商 "${args.provider_id}" 未配置API密钥`);

        await provider.deleteKnowledgeBase(args.knowledge_base_id);
        return JSON.stringify({
            success: true,
            message: `知识库 "${args.knowledge_base_id}" 已删除`
        });
    }
}
