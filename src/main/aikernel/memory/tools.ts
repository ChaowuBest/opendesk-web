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
import { truncText } from '../../tui/components/toolcall.js';
import { FactorialMemoryStore } from './store.js';
import { UpdateUserPortraitTool } from './user_portrait.js';
import type { TaskState } from '../states/tasks.js';
import {
    appendCliError,
    cliField,
    memoryScopeLabel,
    metaRowHtml,
    parseToolResult,
    renderMemoryCardCli,
    renderMemoryCardHtml,
    textBlockHtml,
    truncMemoryText
} from './tool_render.js';
import { t } from '../../../locale/index.js';
import { escapeHtml } from '../../../common/utils/escape.js';

export const ADD_MEMORY_TOOL_NAME = 'addMemory';
export const REMOVE_MEMORY_TOOL_NAME = 'removeMemory';
export const SEARCH_MEMORY_TOOL_NAME = 'searchMemory';
export const GET_MEMORY_TOOL_NAME = 'getMemory';

const AddMemoryArgsSchema = z.object({
    scope: z
        .enum(['workspace', 'global'])
        .describe('记忆范围：workspace 表示当前工作空间相关记忆，global 表示与工作空间无关的全局记忆'),
    title: z.string().trim().min(1).optional().describe('记忆内容的一句话标题；省略时会根据 content 自动生成'),
    content: z.string().trim().min(1).describe('原子化的记忆内容文本')
});

function buildDefaultMemoryTitle(content: string): string {
    return truncMemoryText(content.replace(/\s+/g, ' ').trim(), 48);
}

class AddMemoryTool extends BaseTool<typeof AddMemoryArgsSchema> {
    constructor() {
        super(
            ADD_MEMORY_TOOL_NAME,
            '创建一条关键事实记忆片段并保存到 memory.json。只保存长期关键事实；用户身份、个人偏好、沟通风格和长期协作偏好应写入 user.md，而不是 memory.json。每条记忆应尽量原子化，不要承载多件独立事情。',
            AddMemoryArgsSchema
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as z.output<typeof AddMemoryArgsSchema> | undefined;
        const body: string[] = [];
        if (args) {
            if (args.scope) {
                body.push(cliField(t('tools.memory.scope'), memoryScopeLabel(args.scope), width));
            }
            if (args.title) {
                body.push(cliField(t('tools.memory.title'), args.title, width));
            }
            if (args.content) {
                body.push(cliField(t('tools.memory.content'), truncMemoryText(args.content, 160), width));
            }
        }
        if (toolcall.status === 'success' && toolcall.result) {
            const result = parseToolResult<{ uid?: string }>(toolcall);
            if (result?.uid) {
                body.push(chalk.greenBright(`  ✓ ${t('tools.memory.created')} ${result.uid}`));
            } else {
                body.push(chalk.greenBright(`  ✓ ${t('tools.memory.created')}`));
            }
        }
        appendCliError(body, toolcall, width);

        return renderMemoryCardCli(toolcall, width, {
            icon: '🧠',
            title: t('tools.memory.add.name'),
            body,
            maxLines: 9
        });
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const args = toolcall.args_object as z.output<typeof AddMemoryArgsSchema> | undefined;
        const result = parseToolResult<{ uid?: string }>(toolcall);
        const rows: string[] = [];
        if (args?.scope) {
            rows.push(metaRowHtml(t('tools.memory.scope'), memoryScopeLabel(args.scope)));
        }
        if (result?.uid) {
            rows.push(metaRowHtml(t('tools.memory.uid'), result.uid, { mono: true }));
        }
        if (args?.title) {
            rows.push(metaRowHtml(t('tools.memory.title'), args.title));
        }
        if (args?.content) {
            rows.push(textBlockHtml(args.content));
        }

        return renderMemoryCardHtml(toolcall, {
            iconClass: 'fa-solid fa-plus',
            title: t('tools.memory.add.name'),
            subtitle: args?.title,
            bodyHtml: rows.join('')
        });
    }

    private async handleExecute(args: z.output<typeof AddMemoryArgsSchema>, taskState?: TaskState): Promise<string> {
        const registry = FactorialMemoryStore.getInstance(taskState?.getWorkspace() || undefined);
        const result = await registry.addMemory(
            args.scope,
            args.title || buildDefaultMemoryTitle(args.content),
            args.content
        );
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
            body.push(cliField(t('tools.memory.uid'), args.uid, width));
        }
        if (toolcall.status === 'success' && toolcall.result) {
            const result = parseToolResult<{ removed?: boolean }>(toolcall);
            body.push(
                result?.removed
                    ? chalk.greenBright(`  ✓ ${t('tools.memory.removed')}`)
                    : chalk.yellowBright(`  ${t('tools.memory.notFound')}`)
            );
        }
        appendCliError(body, toolcall, width);

        return renderMemoryCardCli(toolcall, width, {
            icon: '⌫',
            title: t('tools.memory.remove.name'),
            body
        });
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const args = toolcall.args_object as z.output<typeof RemoveMemoryArgsSchema> | undefined;
        const result = parseToolResult<{ removed?: boolean }>(toolcall);
        const rows: string[] = [];
        if (args?.uid) {
            rows.push(metaRowHtml(t('tools.memory.uid'), args.uid, { mono: true }));
        }
        if (toolcall.status === 'success') {
            rows.push(
                metaRowHtml(
                    t('tools.memory.result'),
                    result?.removed ? t('tools.memory.removed') : t('tools.memory.notFound')
                )
            );
        }

        return renderMemoryCardHtml(toolcall, {
            iconClass: 'fa-solid fa-trash-can',
            title: t('tools.memory.remove.name'),
            subtitle: args?.uid,
            bodyHtml: rows.join('')
        });
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
            body.push(cliField(t('tools.memory.keyword'), args.keyword, width));
        }
        if (toolcall.status === 'success' && toolcall.result) {
            const result = parseToolResult<Array<{ uid: string; title: string }>>(toolcall);
            if (Array.isArray(result)) {
                body.push(chalk.dim(`  ${t('tools.memory.searchResultCount', { count: result.length })}`));
                for (const item of result.slice(0, 5)) {
                    body.push(`    ${chalk.cyan(item.uid)} ${truncText(String(item.title), width - 20)}`);
                }
            } else {
                body.push(chalk.dim(`  ✓ ${t('tools.memory.searched')}`));
            }
        }
        appendCliError(body, toolcall, width);

        return renderMemoryCardCli(toolcall, width, {
            icon: '⌕',
            title: t('tools.memory.search.name'),
            body,
            maxLines: 10
        });
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const args = toolcall.args_object as z.output<typeof SearchMemoryArgsSchema> | undefined;
        const result = parseToolResult<Array<{ uid: string; title: string }>>(toolcall);
        const rows: string[] = [];
        if (args?.keyword) {
            rows.push(metaRowHtml(t('tools.memory.keyword'), args.keyword));
        }
        if (Array.isArray(result)) {
            rows.push(
                metaRowHtml(t('tools.memory.result'), t('tools.memory.searchResultCount', { count: result.length }))
            );
            if (result.length > 0) {
                const items = result
                    .slice(0, 20)
                    .map(
                        (item) =>
                            `<li class="flex gap-2 min-w-0">` +
                            `<span class="font-mono text-gray-400 shrink-0">${escapeHtml(item.uid)}</span>` +
                            `<span class="text-gray-600 truncate">${escapeHtml(item.title)}</span>` +
                            `</li>`
                    )
                    .join('');
                rows.push(`<ul class="space-y-1 text-[12px]">${items}</ul>`);
            }
        }

        return renderMemoryCardHtml(toolcall, {
            iconClass: 'fa-solid fa-magnifying-glass',
            title: t('tools.memory.search.name'),
            subtitle: args?.keyword,
            bodyHtml: rows.join('')
        });
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
            body.push(cliField(t('tools.memory.uid'), args.uid, width));
        }
        if (toolcall.status === 'success' && toolcall.result) {
            const result = parseToolResult<{
                found?: boolean;
                title?: string;
                content?: string;
                scope?: string;
                heat?: number;
            }>(toolcall);
            if (result) {
                body.push(
                    result.found
                        ? chalk.greenBright(`  ✓ ${truncText(result.title || '', width - 8)}`)
                        : chalk.yellowBright(`  ${t('tools.memory.notFound')}`)
                );
                if (result.found && result.scope) {
                    body.push(cliField(t('tools.memory.scope'), memoryScopeLabel(result.scope), width));
                }
                if (result.found && typeof result.heat === 'number') {
                    body.push(cliField(t('tools.memory.heat'), String(result.heat), width));
                }
                if (result.found && result.content) {
                    body.push(cliField(t('tools.memory.content'), truncMemoryText(result.content, 220), width));
                }
            } else {
                body.push(chalk.dim(`  ✓ ${t('tools.memory.read')}`));
            }
        }
        appendCliError(body, toolcall, width);

        return renderMemoryCardCli(toolcall, width, {
            icon: '◇',
            title: t('tools.memory.get.name'),
            body,
            maxLines: 10
        });
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const args = toolcall.args_object as z.output<typeof GetMemoryArgsSchema> | undefined;
        const result = parseToolResult<{
            found?: boolean;
            uid?: string;
            scope?: string;
            title?: string;
            content?: string;
            heat?: number;
        }>(toolcall);
        const rows: string[] = [];
        rows.push(metaRowHtml(t('tools.memory.uid'), result?.uid || args?.uid || '', { mono: true }));
        if (result?.found) {
            rows.push(metaRowHtml(t('tools.memory.scope'), memoryScopeLabel(result.scope)));
            rows.push(metaRowHtml(t('tools.memory.title'), result.title || ''));
            if (typeof result.heat === 'number') {
                rows.push(metaRowHtml(t('tools.memory.heat'), String(result.heat)));
            }
            rows.push(textBlockHtml(result.content || '', 4000));
        } else if (toolcall.status === 'success') {
            rows.push(metaRowHtml(t('tools.memory.result'), t('tools.memory.notFound')));
        }

        return renderMemoryCardHtml(toolcall, {
            iconClass: 'fa-solid fa-book-open',
            title: t('tools.memory.get.name'),
            subtitle: result?.title || args?.uid,
            bodyHtml: rows.join('')
        });
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
