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
import { BaseTool, BaseToolset } from '../tool.js';
import { UserMessage, AssistantMessage, ToolCall, marked } from '../messages.js';
import { LLM } from '../llm.js';
import { logger } from '../../utils/logger.js';
import { Card } from '../../tui/components/card.js';
import { statusDisplay, truncText } from '../../tui/components/toolcall.js';
import { escapeHtml } from '../../../common/utils/escape.js';
import { t } from '../../../locale/index.js';
import type { TaskManagerState } from './manager.js';
import type { TaskState } from '../states/tasks.js';

// ═══════════════════ Helpers ═══════════════════

/** 当工具参数中这些字段的值过大时，将其替换为占位符以避免信息过载 */
const LARGE_CONTENT_FIELDS = ['content', 'file_content', 'new_content', 'new_string', 'contents'];
const CONTENT_TRUNCATE_THRESHOLD = 200;

function sanitizeToolArgs(args: any): any {
    if (!args || typeof args !== 'object') return args;
    const sanitized = { ...args };
    for (const field of LARGE_CONTENT_FIELDS) {
        if (
            field in sanitized &&
            typeof sanitized[field] === 'string' &&
            sanitized[field].length > CONTENT_TRUNCATE_THRESHOLD
        ) {
            sanitized[field] = `[内容已省略，共 ${sanitized[field].length} 字符]`;
        }
    }
    return sanitized;
}

function formatToolCallBrief(toolName: string, argsObj: any): string {
    const args = sanitizeToolArgs(argsObj ?? {});
    return `[工具调用] ${toolName}(${JSON.stringify(args)})`;
}

function formatMessageBrief(message: UserMessage | AssistantMessage): string {
    if (message instanceof UserMessage) {
        const textParts = message.content.filter((p) => p.type === 'text');
        const text = textParts.map((p) => (p as { text: string }).text).join(' ');
        const truncated = text.slice(0, 200);
        return `> **用户**: ${truncated}${text.length > 200 ? '...' : ''}`;
    } else {
        let result = '> **助手**: ';
        for (const part of message.content) {
            if (part.type === 'text') {
                const truncated = part.text.slice(0, 200);
                result += truncated + (part.text.length > 200 ? '...' : '');
            } else if (part.type === 'tool_call') {
                for (const tc of part.toolcalls) {
                    result += '\n>   ' + formatToolCallBrief(tc.tool_name, tc.args_object);
                }
            }
        }
        return result;
    }
}

// ═══════════════════ listRecentTasks ═══════════════════

const ListRecentTasksSchema = z.object({
    startDate: z.string().describe('起始日期，格式为 YYYY-MM-DD'),
    endDate: z.string().describe('结束日期，格式为 YYYY-MM-DD')
});

class ListRecentTasksTool extends BaseTool<typeof ListRecentTasksSchema> {
    private taskManagerState: TaskManagerState;

    constructor(taskManagerState: TaskManagerState) {
        super(
            'listRecentTasks',
            '按照指定的起止日期列出日期范围内所有任务的信息摘要，包含任务ID、名称、时间和消息摘要',
            ListRecentTasksSchema,
            undefined,
            { 'zh-CN': '列出任务', 'en-US': 'List Tasks' }
        );
        this.taskManagerState = taskManagerState;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as z.output<typeof ListRecentTasksSchema> | undefined;
        const body: string[] = [];

        if (args?.startDate && args?.endDate) {
            body.push(chalk.dim('日期范围: ') + `${args.startDate} ~ ${args.endDate}`);
        }

        if (toolcall.status === 'success' && toolcall.result) {
            const taskCount = (toolcall.result.match(/^## /gm) ?? []).length;
            body.push(chalk.greenBright(`  ✓ 找到 ${taskCount} 个任务`));
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        }

        return new Card({
            icon: '📋',
            title: '列出任务',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const args = toolcall.args_object as z.output<typeof ListRecentTasksSchema> | undefined;
        const dateRange = args?.startDate && args?.endDate ? `${args.startDate} ~ ${args.endDate}` : '';

        const statusIcon =
            toolcall.status === 'running'
                ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"></span>'
                : toolcall.status === 'error'
                  ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-rose-500"></span>'
                  : '';

        let detail = escapeHtml(dateRange);
        if (toolcall.status === 'success' && toolcall.result) {
            const taskCount = (toolcall.result.match(/^## /gm) ?? []).length;
            detail += `，共 ${taskCount} 个任务`;
        }

        return `<div class="od-inline-toolcall-container">
            <div class="flex items-center gap-1.5 min-w-0">
                <i class="fas fa-list-ul shrink-0 text-slate-400 text-xs"></i>
                <span class="shrink-0 text-slate-500 text-xs">${escapeHtml(t('tools.listRecentTasks.name'))}</span>
                ${statusIcon}
                <span class="truncate text-xs text-slate-600">${detail}</span>
            </div>
        </div>`;
    }

    private async handleExecute(args: z.output<typeof ListRecentTasksSchema>): Promise<string> {
        const start = new Date(args.startDate);
        const end = new Date(args.endDate);
        end.setHours(23, 59, 59, 999);

        if (isNaN(start.getTime()) || isNaN(end.getTime())) {
            throw new Error('日期格式无效，请使用 YYYY-MM-DD 格式');
        }

        const filteredTasks = this.taskManagerState.tasks.filter((task) => {
            if (task.parent_id !== null) return false;
            if (!task.started_at) return false;
            return task.started_at >= start && task.started_at <= end;
        });

        if (filteredTasks.length === 0) {
            return `在 ${args.startDate} 至 ${args.endDate} 期间没有找到任何任务。`;
        }

        let md = `# 任务列表 (${args.startDate} ~ ${args.endDate})\n\n`;
        md += `共 ${filteredTasks.length} 个任务\n\n`;

        for (const task of filteredTasks) {
            md += this.formatTaskEntry(task);
            md += '\n---\n\n';
        }

        return md;
    }

    private formatTaskEntry(task: TaskState): string {
        const messages = task.chat_context.messages;
        const contentMessages = messages.filter(
            (m): m is UserMessage | AssistantMessage => m instanceof UserMessage || m instanceof AssistantMessage
        );

        const firstMsgTime = task.started_at?.toISOString() ?? '未知';
        const lastMsgTime = task.finished_at?.toISOString() ?? task.started_at?.toISOString() ?? '未知';

        let md = `## ${task.task_name ?? '未命名任务'}\n\n`;
        md += `- **任务ID**: \`${task.task_id}\`\n`;
        md += `- **状态**: ${task.task_status}\n`;
        md += `- **首条消息时间**: ${firstMsgTime}\n`;
        md += `- **末条消息时间**: ${lastMsgTime}\n`;
        md += `- **消息总数**: ${contentMessages.length}\n\n`;

        if (contentMessages.length === 0) return md;

        md += `### 摘要\n\n`;

        if (contentMessages.length <= 10) {
            for (const msg of contentMessages) {
                md += formatMessageBrief(msg) + '\n';
            }
        } else {
            const first5 = contentMessages.slice(0, 5);
            const last5 = contentMessages.slice(-5);

            for (const msg of first5) {
                md += formatMessageBrief(msg) + '\n';
            }
            md += `\n*... 省略 ${contentMessages.length - 10} 条消息 ...*\n\n`;
            for (const msg of last5) {
                md += formatMessageBrief(msg) + '\n';
            }
        }

        return md;
    }
}

// ═══════════════════ askFromTask ═══════════════════

const AskFromTaskSchema = z.object({
    taskId: z.string().describe('要查询的任务ID'),
    question: z.string().describe('要对该任务内容提出的问题')
});

class AskFromTaskTool extends BaseTool<typeof AskFromTaskSchema> {
    private taskManagerState: TaskManagerState;

    constructor(taskManagerState: TaskManagerState) {
        super(
            'askFromTask',
            '给定任务ID和一个问题，由大模型根据该任务的完整对话记录回答问题',
            AskFromTaskSchema,
            undefined,
            { 'zh-CN': '任务追问', 'en-US': 'Ask Task' }
        );
        this.taskManagerState = taskManagerState;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as z.output<typeof AskFromTaskSchema> | undefined;
        const body: string[] = [];

        if (args?.taskId) {
            body.push(chalk.dim('任务ID: ') + truncText(args.taskId, width - 16));
        }
        if (args?.question) {
            body.push(chalk.dim('问题: ') + truncText(args.question, width - 12));
        }

        if (toolcall.status === 'success' && toolcall.result) {
            body.push(chalk.greenBright('  ✓ ') + truncText(toolcall.result, width - 10));
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        }

        return new Card({
            icon: '💬',
            title: '询问任务',
            status: statusDisplay(toolcall.status),
            body,
            maxLines: 8,
            truncateStrategy: 'tail'
        }).render(width);
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const args = toolcall.args_object as z.output<typeof AskFromTaskSchema> | undefined;
        const question = args?.question ?? '';
        const isRunning = toolcall.status === 'running';
        const isError = toolcall.status === 'error';

        const borderColor = isError ? 'border-red-200' : 'border-gray-200';
        const iconBg = isError ? 'bg-red-50 text-red-400' : 'bg-blue-50 text-blue-400';

        const toolName = t('tools.askFromTask.name');
        const questionText = escapeHtml(question.length > 80 ? question.slice(0, 77) + '…' : question);

        let bodyContent = '';
        if (isRunning) {
            bodyContent = `
                <div class="px-4 py-3 flex items-center gap-2 text-blue-400 text-[12px]">
                    <i class="fa-solid fa-circle-notch fa-spin"></i>
                    <span class="text-gray-400">正在分析任务对话记录…</span>
                </div>`;
        } else if (toolcall.status === 'success' && toolcall.result) {
            const rendered = await marked.parse(toolcall.result);
            bodyContent = `
                <div class="px-4 py-2.5 text-xs text-gray-700 leading-relaxed markdown-body max-h-[240px] overflow-y-auto">${rendered}</div>`;
        } else if (isError) {
            bodyContent = `
                <div class="px-4 py-2.5 text-xs text-red-600">${escapeHtml(String(toolcall.result ?? '查询失败'))}</div>`;
        }

        return `
        <details class="od-card-shadow my-2 rounded-[14px] border ${borderColor} bg-white overflow-hidden w-full" open>
            <summary class="flex items-center gap-2 px-3.5 py-2.5 cursor-pointer select-none hover:bg-gray-50/60 transition-colors duration-150 font-medium">
                <span class="inline-flex items-center justify-center w-5 h-5 rounded ${iconBg}">
                    <i class="fa-solid fa-comment-dots text-[10px]"></i>
                </span>
                <span class="text-[12px] text-gray-500 shrink-0">${escapeHtml(toolName)}</span>
                <span class="text-[12px] text-gray-600 truncate flex-1">${questionText}</span>
                <svg class="w-3 h-3 text-gray-400 shrink-0 transition-transform duration-200" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                    <path d="M6 9l6 6 6-6"/>
                </svg>
            </summary>
            <div class="border-t border-gray-200 bg-gray-50/40">
                ${bodyContent}
            </div>
        </details>`;
    }

    private async handleExecute(args: z.output<typeof AskFromTaskSchema>): Promise<string> {
        const task = this.taskManagerState.getTask(args.taskId);
        if (!task) {
            throw new Error(`未找到ID为 "${args.taskId}" 的任务`);
        }

        let conversationRecord = '';
        for (const msg of task.chat_context.messages) {
            if (msg instanceof UserMessage) {
                const textParts = msg.content.filter((p) => p.type === 'text');
                const text = textParts.map((p) => (p as { text: string }).text).join('\n');
                if (text.trim()) {
                    const truncated = text.length > 2000 ? text.slice(0, 2000) + '...[截断]' : text;
                    conversationRecord += `用户: ${truncated}\n\n`;
                }
            } else if (msg instanceof AssistantMessage) {
                const textParts = msg.content.filter((p) => p.type === 'text');
                const text = textParts.map((p) => (p as { text: string }).text).join('\n');
                if (text.trim()) {
                    const truncated = text.length > 2000 ? text.slice(0, 2000) + '...[截断]' : text;
                    conversationRecord += `助手: ${truncated}\n\n`;
                }
            }
        }

        if (!conversationRecord.trim()) {
            return '该任务没有可供分析的对话记录。';
        }

        const prompt =
            `以下是一段任务对话记录，请根据对话内容回答问题。\n\n` +
            `<conversation>\n${conversationRecord}</conversation>\n\n` +
            `问题: ${args.question}\n\n` +
            `请根据上述对话内容给出准确、简洁的回答。`;

        try {
            return await LLM.ask(new UserMessage(prompt));
        } catch (err) {
            logger.error(`askFromTask LLM call failed: ${err}`);
            throw new Error(`大模型调用失败: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}

// ═══════════════════ getTaskHistory ═══════════════════

const GetTaskHistorySchema = z.object({
    taskId: z.string().describe('要查询的任务ID'),
    limit: z.number().default(10).describe('获取的消息条数限制，默认为10'),
    includeFullToolContent: z
        .boolean()
        .default(false)
        .describe('是否包含完整的工具调用内容（参数和返回值），默认为false')
});

class GetTaskHistoryTool extends BaseTool<typeof GetTaskHistorySchema> {
    private taskManagerState: TaskManagerState;

    constructor(taskManagerState: TaskManagerState) {
        super(
            'getTaskHistory',
            '获取指定任务的最近N条消息历史，可选择是否包含完整的工具调用细节',
            GetTaskHistorySchema,
            undefined,
            { 'zh-CN': '获取历史', 'en-US': 'Task History' }
        );
        this.taskManagerState = taskManagerState;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as z.output<typeof GetTaskHistorySchema> | undefined;
        const body: string[] = [];

        if (args?.taskId) {
            body.push(chalk.dim('任务ID: ') + truncText(args.taskId, width - 16));
            body.push(chalk.dim('条数: ') + String(args.limit ?? 10));
            if (args.includeFullToolContent) {
                body.push(chalk.dim('完整工具内容: ') + chalk.cyan('是'));
            }
        }

        if (toolcall.status === 'success' && toolcall.result) {
            const msgCount = (toolcall.result.match(/^### /gm) ?? []).length;
            body.push(chalk.greenBright(`  ✓ 返回 ${msgCount} 条消息`));
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        }

        return new Card({
            icon: '📜',
            title: '获取历史',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const args = toolcall.args_object as z.output<typeof GetTaskHistorySchema> | undefined;
        const taskIdShort = args?.taskId ? args.taskId.slice(0, 8) + '…' : '';
        const limit = args?.limit ?? 10;

        const statusIcon =
            toolcall.status === 'running'
                ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"></span>'
                : toolcall.status === 'error'
                  ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-rose-500"></span>'
                  : '';

        let detail = `${escapeHtml(taskIdShort)} · 最近 ${limit} 条`;
        if (toolcall.status === 'success' && toolcall.result) {
            const msgCount = (toolcall.result.match(/^### /gm) ?? []).length;
            detail += ` · 返回 ${msgCount} 条`;
        }

        return `<div class="od-inline-toolcall-container">
            <div class="flex items-center gap-1.5 min-w-0">
                <i class="fas fa-clock-rotate-left shrink-0 text-slate-400 text-xs"></i>
                <span class="shrink-0 text-slate-500 text-xs">${escapeHtml(t('tools.getTaskHistory.name'))}</span>
                ${statusIcon}
                <span class="truncate text-xs text-slate-600">${detail}</span>
            </div>
        </div>`;
    }

    private async handleExecute(args: z.output<typeof GetTaskHistorySchema>): Promise<string> {
        const task = this.taskManagerState.getTask(args.taskId);
        if (!task) {
            throw new Error(`未找到ID为 "${args.taskId}" 的任务`);
        }

        const messages = task.chat_context.messages;
        const contentMessages = messages.filter(
            (m): m is UserMessage | AssistantMessage => m instanceof UserMessage || m instanceof AssistantMessage
        );

        const lastN = contentMessages.slice(-args.limit);

        if (lastN.length === 0) {
            return '该任务没有消息历史。';
        }

        let result = `# 任务 "${task.task_name ?? '未命名'}" 的最近 ${lastN.length} 条消息\n\n`;

        for (const msg of lastN) {
            result += this.formatMessage(msg, args.includeFullToolContent);
            result += '\n---\n\n';
        }

        return result;
    }

    private formatMessage(message: UserMessage | AssistantMessage, includeFullToolContent: boolean): string {
        if (message instanceof UserMessage) {
            let result = '### 👤 用户\n\n';
            for (const part of message.content) {
                if (part.type === 'text') {
                    result += (part as { text: string }).text + '\n';
                } else if (part.type === 'file') {
                    result += `[文件附件: ${(part as { path: string }).path}]\n`;
                }
            }
            return result;
        } else {
            let result = '### 🤖 助手\n\n';
            for (const part of message.content) {
                if (part.type === 'text') {
                    result += part.text + '\n';
                } else if (part.type === 'tool_call') {
                    for (const tc of part.toolcalls) {
                        if (includeFullToolContent) {
                            result += `**工具调用**: ${tc.tool_name}\n`;
                            result += `- 参数:\n\`\`\`json\n${tc.args_string ?? '{}'}\n\`\`\`\n`;
                            result += `- 状态: ${tc.status}\n`;
                            if (tc.result) {
                                result += `- 结果:\n\`\`\`\n${tc.result}\n\`\`\`\n`;
                            }
                            result += '\n';
                        } else {
                            result += formatToolCallBrief(tc.tool_name, tc.args_object) + '\n';
                        }
                    }
                }
                // reasoning 部分不输出
            }
            return result;
        }
    }
}

// ═══════════════════ deleteTasks ═══════════════════

const DeleteTasksSchema = z.object({
    taskIds: z.array(z.string()).min(1).describe('要删除的一个或多个任务ID列表')
});

class DeleteTasksTool extends BaseTool<typeof DeleteTasksSchema> {
    private taskManagerState: TaskManagerState;

    constructor(taskManagerState: TaskManagerState) {
        super(
            'deleteTasks',
            '删除指定的一个或多个任务（含子任务）。删除后自动通知前端刷新任务列表',
            DeleteTasksSchema,
            undefined,
            { 'zh-CN': '删除任务', 'en-US': 'Delete Tasks' }
        );
        this.taskManagerState = taskManagerState;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as z.output<typeof DeleteTasksSchema> | undefined;
        const body: string[] = [];

        if (args?.taskIds && args.taskIds.length > 0) {
            body.push(chalk.dim('任务数: ') + String(args.taskIds.length));
            const preview = args.taskIds.map((id) => truncText(id, 20)).join(', ');
            body.push(chalk.dim('IDs: ') + truncText(preview, width - 14));
        }

        if (toolcall.status === 'success' && toolcall.result) {
            body.push(chalk.greenBright('  ✓ ') + truncText(toolcall.result, width - 10));
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        }

        return new Card({
            icon: '🗑️',
            title: '删除任务',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const args = toolcall.args_object as z.output<typeof DeleteTasksSchema> | undefined;
        const count = args?.taskIds?.length ?? 0;

        const statusIcon =
            toolcall.status === 'running'
                ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"></span>'
                : toolcall.status === 'error'
                  ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-rose-500"></span>'
                  : '';

        let detail = `共 ${count} 个任务`;
        if (toolcall.status === 'success' && toolcall.result) {
            detail += ` · ${escapeHtml(toolcall.result)}`;
        }

        return `<div class="od-inline-toolcall-container">
            <div class="flex items-center gap-1.5 min-w-0">
                <i class="fas fa-trash-can shrink-0 text-slate-400 text-xs"></i>
                <span class="shrink-0 text-slate-500 text-xs">${escapeHtml(t('tools.deleteTasks.name'))}</span>
                ${statusIcon}
                <span class="truncate text-xs text-slate-600">${detail}</span>
            </div>
        </div>`;
    }

    private async handleExecute(args: z.output<typeof DeleteTasksSchema>): Promise<string> {
        const results: string[] = [];
        const notFound: string[] = [];

        for (const taskId of args.taskIds) {
            const removedTaskIds = this.taskManagerState.removeTask(taskId);
            if (removedTaskIds.length === 0) {
                notFound.push(taskId);
                continue;
            }
            results.push(taskId);
        }

        const parts: string[] = [];
        if (results.length > 0) {
            parts.push(`已删除 ${results.length} 个任务`);
        }
        if (notFound.length > 0) {
            parts.push(`未找到 ${notFound.length} 个任务: ${notFound.map((id) => `\`${id}\``).join(', ')}`);
        }

        return parts.join('；');
    }
}

// ═══════════════════ Toolset Factory ═══════════════════

export function createTaskInfoToolset(taskManagerState: TaskManagerState): BaseToolset {
    const toolset = new BaseToolset('task-info');
    toolset.addTools(
        new ListRecentTasksTool(taskManagerState),
        new AskFromTaskTool(taskManagerState),
        new GetTaskHistoryTool(taskManagerState),
        new DeleteTasksTool(taskManagerState)
    );
    return toolset;
}
