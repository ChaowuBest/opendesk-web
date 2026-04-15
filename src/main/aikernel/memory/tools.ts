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

import { z } from 'zod';
import chalk from 'chalk';
import { BaseTool, BaseToolset } from '../tool';
import { ToolCall } from '../messages';
import { Card } from '../../tui/components/card';
import { statusDisplay, truncText } from '../../tui/components/toolcall';
import { MemoryRegistry } from './registry';
import { MEMORY_CATEGORY_LABELS, type MemoryScope } from './common';
import type { TaskState } from '../states/tasks';

// ═══════════════════ addMemory ═══════════════════

const AddMemoryArgsSchema = z.object({
    name: z.string().describe('记忆名称（简短标题，如"用户偏好：代码风格"）'),
    content: z.string().describe('记忆内容，使用 Markdown 格式。应包含完整的信息，足够未来使用时理解上下文'),
    keywords: z.array(z.string()).describe('关键词列表，用于后续检索（如 ["TypeScript", "ESLint", "代码风格"]）'),
    summary: z.string().describe('记忆摘要（一句话概括记忆的核心内容）'),
    category: z
        .enum(['user_preference', 'important_fact', 'key_decision', 'useful_context'])
        .describe(
            '记忆分类: user_preference(用户偏好), important_fact(重要事实), key_decision(关键决策), useful_context(有用上下文)'
        ),
    scope: z
        .enum(['global', 'workspace'])
        .describe('记忆存储范围: global(全局，如个人偏好/通用知识/日程), workspace(当前工作区，如项目信息/架构设计)')
});

export class AddMemoryTool extends BaseTool<typeof AddMemoryArgsSchema> {
    constructor() {
        super(
            'addMemory',
            '将重要信息保存为长期记忆。系统使用 AI 自动检测重复记忆：如有重复则智能合并更新，如新记忆已被完全覆盖则跳过。' +
                '记忆范围: global(个人偏好/通用知识) 或 workspace(项目相关信息)',
            AddMemoryArgsSchema
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as z.output<typeof AddMemoryArgsSchema> | undefined;
        const body: string[] = [];

        if (args) {
            body.push(chalk.dim('名称: ') + truncText(String(args.name), width - 20));
            const scopeLabel = args.scope === 'global' ? '🌍 全局' : '📂 工作区';
            const categoryLabel = MEMORY_CATEGORY_LABELS[args.category] || args.category;
            body.push(chalk.dim('范围: ') + scopeLabel + chalk.dim(' · 分类: ') + categoryLabel);
            if (args.keywords?.length) {
                body.push(chalk.dim('关键词: ') + chalk.cyan(args.keywords.join(', ')));
            }
            if (args.summary) {
                body.push(chalk.dim('摘要: ') + truncText(String(args.summary), width - 20));
            }
        }

        if (toolcall.status === 'success' && toolcall.result) {
            try {
                const result = JSON.parse(toolcall.result);
                const actionLabel =
                    result.action === 'updated'
                        ? '已智能合并更新'
                        : result.action === 'skipped'
                          ? '已跳过（信息已存在）'
                          : '已保存';
                body.push(chalk.greenBright(`  ✓ ${actionLabel}`));
            } catch {
                body.push(chalk.greenBright('  ✓ 记忆已保存'));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        }

        return new Card({
            icon: '🧠',
            title: '添加记忆',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async handleExecute(args: z.output<typeof AddMemoryArgsSchema>, taskState?: TaskState): Promise<string> {
        const registry = MemoryRegistry.getInstance();
        const scope = args.scope as MemoryScope;

        const result = await registry.smartAdd(
            scope,
            args.name,
            args.content,
            args.keywords,
            args.summary,
            args.category,
            taskState?.task_id
        );

        return JSON.stringify({
            success: true,
            action: result.action,
            uid: result.uid,
            scope,
            name: result.name
        });
    }
}

// ═══════════════════ searchMemory ═══════════════════

const SearchMemoryArgsSchema = z.object({
    query: z.string().describe('搜索查询词，用自然语言描述你想查找的记忆内容，系统将使用 AI 语义匹配')
});

export class SearchMemoryTool extends BaseTool<typeof SearchMemoryArgsSchema> {
    constructor() {
        super(
            'searchMemory',
            '使用 AI 语义搜索检索相关的长期记忆。根据查询语义在全局和工作区记忆中搜索，' +
                '返回经过 AI 重排的高相关性记忆内容。可用于在执行任务前获取相关背景知识、用户偏好或历史决策',
            SearchMemoryArgsSchema
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as z.output<typeof SearchMemoryArgsSchema> | undefined;
        const body: string[] = [];

        if (args?.query) {
            body.push(chalk.dim('查询: ') + chalk.cyan(truncText(String(args.query), width - 20)));
        }

        if (toolcall.status === 'running') {
            body.push(chalk.dim('  ⏳ AI 语义搜索中…'));
        } else if (toolcall.status === 'success' && toolcall.result) {
            try {
                const result = JSON.parse(toolcall.result);
                const count = result.count ?? 0;
                if (count === 0) {
                    body.push(chalk.dim('  未找到相关记忆'));
                } else {
                    body.push(chalk.dim(`  找到 ${chalk.white(String(count))} 条相关记忆`));
                    const memories = result.memories ?? [];
                    for (const mem of memories.slice(0, 3)) {
                        const scopeIcon = mem.scope === 'global' ? '🌍' : '📂';
                        const relLabel = chalk.dim(`[${mem.relevance}/10]`);
                        body.push(`    ${scopeIcon} ${relLabel} ${truncText(String(mem.name), width - 30)}`);
                    }
                    if (memories.length > 3) {
                        body.push(chalk.dim(`    ... 还有 ${memories.length - 3} 条`));
                    }
                }
            } catch {
                body.push(chalk.dim('  ✓ 已检索记忆'));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        }

        return new Card({
            icon: '🔍',
            title: '搜索记忆',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async handleExecute(args: z.output<typeof SearchMemoryArgsSchema>): Promise<string> {
        const registry = MemoryRegistry.getInstance();
        const results = await registry.smartSearch(args.query);

        if (results.length === 0) {
            return JSON.stringify({
                success: true,
                count: 0,
                memories: [],
                content: '未找到相关记忆。'
            });
        }

        const topResults = results.slice(0, 10);
        const memoriesForContext = topResults.map((r) => ({ scope: r.scope, meta: r.meta }));
        const formattedContent = registry.formatMemoriesForContext(memoriesForContext);

        return JSON.stringify({
            success: true,
            count: topResults.length,
            memories: topResults.map((r) => ({
                uid: r.meta.uid,
                name: r.meta.name,
                scope: r.scope,
                category: r.meta.category,
                relevance: r.relevance
            })),
            content: formattedContent
        });
    }
}

// ═══════════════════ deleteMemory ═══════════════════

const DeleteMemoryArgsSchema = z.object({
    uid: z.string().describe('要删除的记忆的 UID')
});

export class DeleteMemoryTool extends BaseTool<typeof DeleteMemoryArgsSchema> {
    constructor() {
        super('deleteMemory', '删除指定的长期记忆。根据记忆的 UID 进行删除', DeleteMemoryArgsSchema);
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const body: string[] = [];

        if (args?.uid) {
            body.push(chalk.dim('UID: ') + chalk.cyan(String(args.uid)));
        }

        if (toolcall.status === 'success') {
            body.push(chalk.greenBright('  ✓ 记忆已删除'));
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        }

        return new Card({
            icon: '🗑',
            title: '删除记忆',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async handleExecute(args: z.output<typeof DeleteMemoryArgsSchema>): Promise<string> {
        const registry = MemoryRegistry.getInstance();
        const deleted = registry.deleteMemory(args.uid);
        if (deleted) {
            return JSON.stringify({ success: true, uid: args.uid });
        } else {
            throw new Error(`未找到 UID 为 "${args.uid}" 的记忆`);
        }
    }
}

// ═══════════════════ Toolset ═══════════════════

export function createMemoryToolset(): BaseToolset {
    const toolset = new BaseToolset('memory');
    toolset.addTools(new AddMemoryTool(), new SearchMemoryTool(), new DeleteMemoryTool());
    return toolset;
}
