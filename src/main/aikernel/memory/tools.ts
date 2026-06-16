/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import { z } from 'zod';
import chalk from 'chalk';
import { BaseTool, BaseToolset } from '../tool.js';
import { ToolCall } from '../messages.js';
import { Card } from '../../tui/components/card.js';
import { statusDisplay, truncText } from '../../tui/components/toolcall.js';
import { FactorialMemoryStore } from './store.js';
import { UpdateUserPortraitTool } from './user_portrait.js';
import type { TaskState } from '../states/tasks.js';

export const ADD_MEMORY_TOOL_NAME = 'addMemory';
export const REMOVE_MEMORY_TOOL_NAME = 'removeMemory';
export const SEARCH_MEMORY_TOOL_NAME = 'searchMemory';
export const GET_MEMORY_TOOL_NAME = 'getMemory';

const AddMemoryArgsSchema = z.object({
    scope: z
        .enum(['workspace', 'global'])
        .describe('记忆范围：workspace 表示当前工作空间相关记忆，global 表示与工作空间无关的全局记忆'),
    title: z.string().min(1).describe('记忆内容的一句话标题'),
    content: z.string().min(1).describe('原子化的记忆内容文本')
});

class AddMemoryTool extends BaseTool<typeof AddMemoryArgsSchema> {
    constructor() {
        super(
            ADD_MEMORY_TOOL_NAME,
            '创建一条关键事实记忆片段并保存到 memory.json。每条记忆应尽量原子化，不要承载多件独立事情。',
            AddMemoryArgsSchema
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as z.output<typeof AddMemoryArgsSchema> | undefined;
        const body: string[] = [];
        if (args) {
            body.push(chalk.dim('范围: ') + (args.scope === 'global' ? '全局' : '工作区'));
            body.push(chalk.dim('标题: ') + truncText(args.title, width - 16));
        }
        if (toolcall.status === 'success' && toolcall.result) {
            try {
                const result = JSON.parse(toolcall.result);
                body.push(chalk.greenBright(`  ✓ 已创建 ${result.uid}`));
            } catch {
                body.push(chalk.greenBright('  ✓ 已创建记忆'));
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
        const registry = FactorialMemoryStore.getInstance(taskState?.getWorkspace() || undefined);
        const result = await registry.addMemory(args.scope, args.title, args.content);
        return JSON.stringify(result);
    }
}

const RemoveMemoryArgsSchema = z.object({
    uid: z.string().min(1).describe('要删除的记忆 UID')
});

class RemoveMemoryTool extends BaseTool<typeof RemoveMemoryArgsSchema> {
    constructor() {
        super(
            REMOVE_MEMORY_TOOL_NAME,
            '根据 UID 删除一条关键事实记忆片段。只会修改 memory.json。',
            RemoveMemoryArgsSchema
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as z.output<typeof RemoveMemoryArgsSchema> | undefined;
        const body: string[] = [];
        if (args?.uid) {
            body.push(chalk.dim('UID: ') + chalk.cyan(args.uid));
        }
        if (toolcall.status === 'success' && toolcall.result) {
            try {
                const result = JSON.parse(toolcall.result);
                body.push(result.removed ? chalk.greenBright('  ✓ 已删除') : chalk.yellowBright('  未找到该记忆'));
            } catch {
                body.push(chalk.greenBright('  ✓ 已处理'));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        }

        return new Card({
            icon: '⌫',
            title: '删除记忆',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async handleExecute(args: z.output<typeof RemoveMemoryArgsSchema>, taskState?: TaskState): Promise<string> {
        const registry = FactorialMemoryStore.getInstance(taskState?.getWorkspace() || undefined);
        return JSON.stringify(await registry.removeMemory(args.uid));
    }
}

const SearchMemoryArgsSchema = z.object({
    keyword: z.string().min(1).describe('用于搜索记忆标题和内容的关键词')
});

class SearchMemoryTool extends BaseTool<typeof SearchMemoryArgsSchema> {
    constructor() {
        super(
            SEARCH_MEMORY_TOOL_NAME,
            '按关键词搜索全局和工作区关键事实记忆。返回 JSON 列表，仅包含匹配记忆的 uid 和 title。',
            SearchMemoryArgsSchema
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as z.output<typeof SearchMemoryArgsSchema> | undefined;
        const body: string[] = [];
        if (args?.keyword) {
            body.push(chalk.dim('关键词: ') + chalk.cyan(truncText(args.keyword, width - 18)));
        }
        if (toolcall.status === 'success' && toolcall.result) {
            try {
                const result = JSON.parse(toolcall.result);
                body.push(chalk.dim(`  找到 ${result.length} 条记忆`));
                for (const item of result.slice(0, 3)) {
                    body.push(`    ${truncText(String(item.title), width - 8)}`);
                }
            } catch {
                body.push(chalk.dim('  ✓ 已搜索'));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        }

        return new Card({
            icon: '⌕',
            title: '搜索记忆',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async handleExecute(args: z.output<typeof SearchMemoryArgsSchema>, taskState?: TaskState): Promise<string> {
        const registry = FactorialMemoryStore.getInstance(taskState?.getWorkspace() || undefined);
        return JSON.stringify(await registry.searchMemory(args.keyword));
    }
}

const GetMemoryArgsSchema = z.object({
    uid: z.string().min(1).describe('要读取全文的记忆 UID')
});

class GetMemoryTool extends BaseTool<typeof GetMemoryArgsSchema> {
    constructor() {
        super(
            GET_MEMORY_TOOL_NAME,
            '根据 UID 获取一条关键事实记忆的全文。读取成功时该记忆热度会加 1。',
            GetMemoryArgsSchema
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as z.output<typeof GetMemoryArgsSchema> | undefined;
        const body: string[] = [];
        if (args?.uid) {
            body.push(chalk.dim('UID: ') + chalk.cyan(args.uid));
        }
        if (toolcall.status === 'success' && toolcall.result) {
            try {
                const result = JSON.parse(toolcall.result);
                body.push(
                    result.found
                        ? chalk.greenBright(`  ✓ ${truncText(result.title, width - 8)}`)
                        : chalk.yellowBright('  未找到该记忆')
                );
            } catch {
                body.push(chalk.dim('  ✓ 已读取'));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        }

        return new Card({
            icon: '◇',
            title: '读取记忆',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async handleExecute(args: z.output<typeof GetMemoryArgsSchema>, taskState?: TaskState): Promise<string> {
        const registry = FactorialMemoryStore.getInstance(taskState?.getWorkspace() || undefined);
        const memory = await registry.getMemory(args.uid, { incrementHeat: true });
        if (!memory) {
            return JSON.stringify({
                found: false,
                uid: args.uid
            });
        }

        return JSON.stringify({
            found: true,
            scope: memory.scope,
            ...memory.chunk
        });
    }
}

export function createMemoryToolset(): BaseToolset {
    const toolset = new BaseToolset('memory');
    toolset.addTools(
        new AddMemoryTool(),
        new RemoveMemoryTool(),
        new SearchMemoryTool(),
        new GetMemoryTool(),
        new UpdateUserPortraitTool()
    );
    return toolset;
}
