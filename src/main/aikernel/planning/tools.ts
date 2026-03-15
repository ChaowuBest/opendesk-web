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
import { BaseTool, BaseToolset, ToolResult } from '../tool.js';
import { Card } from '../../tui/components/card.js';
import { statusDisplay, truncText } from '../../tui/components/toolcall.js';
import { Markdown, truncateToWidth } from '@mariozechner/pi-tui';
import type { TaskState, TaskUpdateChunk } from '../states/tasks.js';
import type { ToolCall, ToolCallMessagePart, TextMessagePart } from '../messages.js';
import type { SubTaskConfig, SubTaskResult, SubTaskProgressInfo, PendingSubTask } from './common.js';
import { AssistantMessage, marked } from '../messages.js';
import { SUBTASK_SYSTEM_PROMPT } from './prompt.js';
import { logger } from '../../utils/logger.js';
import { defaultMarkdownTheme } from '../../tui/theme.js';
import chalk from 'chalk';
import format from 'string-template';


const SUBTASK_USER_MESSAGE_TEMPLATE = `
请按照下面的要求执行任务，完成后通过 attemptCompletion 工具提交结果。你的所有待提交的结果都要通过
attemptCompletion 工具的参数传递，避免通过写文件的形式传递任务结果交付件。

## 任务标题
{title}

## 任务目标
{objective}

## 输出结果要求
{criteria}
`.trim();

const ATTEMPT_COMPLETION_REMINDER = `你还没有调用 attemptCompletion 工具来返回结果。
请立即调用 planning-attemptCompletion 工具提交你的任务结果。`;

// ─── Pending SubTasks Registry ─────────────────────────────────────────────────

const pendingSubTasks = new Map<string, PendingSubTask>();

// ─── Progress Extraction ───────────────────────────────────────────────────────

const PROGRESS_THROTTLE_MS = 300;

export function extractSubTaskProgress(
    chunk: TaskUpdateChunk,
    progress: SubTaskProgressInfo
): void {
    const part = chunk.last_part;
    if (part.type === 'tool_call') {
        for (const tc of (part as ToolCallMessagePart).toolcalls) {
            const existing = progress.tools.find(t => t.name === tc.tool_name);
            if (existing) {
                existing.status = tc.status;
            } else {
                progress.tools.push({ name: tc.tool_name, status: tc.status });
            }
        }
        if (progress.tools.length > 4) {
            progress.tools = progress.tools.slice(-4);
        }
    } else if (part.type === 'text') {
        const text = (part as TextMessagePart).text;
        progress.lastText = text.length > 80 ? '…' + text.slice(-77) : text;
    }
}

// ─── Extract attemptCompletion Result ──────────────────────────────────────────

const ATTEMPT_COMPLETION_TOOL_NAME = 'planning-attemptCompletion';

/**
 * 从任务的消息历史中提取 attemptCompletion 的结果
 */
function extractAttemptCompletionResult(task: TaskState): { success: boolean; result: string } | null {
    for (const message of task.chat_context.messages) {
        if (!(message instanceof AssistantMessage)) continue;
        for (const part of message.content) {
            if (part.type !== 'tool_call') continue;
            for (const tc of part.toolcalls) {
                if (tc.tool_name === ATTEMPT_COMPLETION_TOOL_NAME && tc.status === 'success' && tc.args_object) {
                    return {
                        success: tc.args_object.success === true,
                        result: tc.args_object.result || '',
                    };
                }
            }
        }
    }
    return null;
}

/**
 * 检查任务是否已调用 attemptCompletion
 */
function hasAttemptCompletion(task: TaskState): boolean {
    for (const message of task.chat_context.messages) {
        if (!(message instanceof AssistantMessage)) continue;
        for (const part of message.content) {
            if (part.type !== 'tool_call') continue;
            for (const tc of part.toolcalls) {
                if (tc.tool_name === ATTEMPT_COMPLETION_TOOL_NAME) {
                    return true;
                }
            }
        }
    }
    return false;
}

// ─── SubTask Hooks ─────────────────────────────────────────────────────────────

/**
 * 为子任务注册 attemptCompletion 检查钩子
 * 在 turn 结束前检查是否已调用 attemptCompletion，如果没有则拒绝结束并提示
 */
function registerAttemptCompletionHook(subTask: TaskState): void {
    subTask.hooks.beforeFinishTurn(async (task) => {
        // 如果已经调用了 attemptCompletion，允许结束
        if (hasAttemptCompletion(task)) {
            return { operation: 'finish' };
        }
        // 如果用户手动停止，允许结束
        if (task.stop_requested_by_user) {
            return { operation: 'finish' };
        }
        // 否则拒绝结束，要求调用 attemptCompletion
        return {
            operation: 'reject',
            message: ATTEMPT_COMPLETION_REMINDER
        };
    });
}

// ─── startSubTask: 核心子任务启动函数 ───────────────────────────────────────────

export interface StartSubTaskOptions {
    /** 父任务 */
    parentTask: TaskState;
    /** 子任务配置 */
    config: SubTaskConfig;
    /** 进度回调 */
    onProgress?: (progress: SubTaskProgressInfo) => void;
    /** 子任务创建后的回调 */
    onCreated?: (subTask: TaskState) => void;
}

/**
 * 启动一个子任务
 * - 使用 SUBTASK_SYSTEM_PROMPT 作为系统提示词
 * - 通过 UserMessage 传入任务目标、结果要求等信息
 * - 使用 TaskHooks 自动处理 attemptCompletion 检查
 */
export async function startSubTask(options: StartSubTaskOptions): Promise<SubTaskResult> {
    const { parentTask, config, onProgress, onCreated } = options;

    // 检查父任务状态
    if (parentTask.task_status === 'stopped' || !parentTask.task_manager_state.getTask(parentTask.task_id)) {
        return {
            success: false,
            result: '父任务已停止或已被移除，子任务跳过执行。',
            subtask_id: 'n/a',
        };
    }

    // 创建子任务
    const subTask = parentTask.task_manager_state.createSubTask(parentTask.task_id);
    subTask.model = parentTask.model;
    subTask.task_name = config.title || '未命名子任务';

    // 设置系统提示词
    subTask.setSystemPrompt(SUBTASK_SYSTEM_PROMPT);

    // 注册 attemptCompletion 检查钩子
    registerAttemptCompletionHook(subTask);

    logger.info(`[subtask] created subtask=${subTask.task_id} parent=${parentTask.task_id} title="${config.title}" async=${config.isAsync}`);

    // 通知子任务已创建
    onCreated?.(subTask);

    // 进度跟踪
    const progress: SubTaskProgressInfo = { tools: [], lastText: null };
    let lastProgressTime = 0;
    const progressCallback = (chunk: TaskUpdateChunk) => {
        if (chunk.type !== 'assistant') return;
        extractSubTaskProgress(chunk, progress);
        const now = Date.now();
        if (onProgress && (now - lastProgressTime >= PROGRESS_THROTTLE_MS)) {
            lastProgressTime = now;
            onProgress({ tools: [...progress.tools], lastText: progress.lastText });
        }
    };

    try {
        // 通过 UserMessage 传入任务目标
        const userMessage = format(SUBTASK_USER_MESSAGE_TEMPLATE, {
            title: config.title,
            objective: config.objective,
            criteria: config.criteria
        });
        await subTask.submitUserMessage(userMessage);
        await subTask.waitUntilFinished(progressCallback);

        // 处理结果
        if (subTask.stop_requested_by_user) {
            return {
                success: false,
                result: '子任务被用户手动停止。',
                subtask_id: subTask.task_id
            };
        }

        // 从消息历史中提取 attemptCompletion 结果
        const completionResult = extractAttemptCompletionResult(subTask);
        if (completionResult) {
            return {
                ...completionResult,
                subtask_id: subTask.task_id
            };
        }

        // 理论上不应该到达这里，因为 hooks 会强制要求 attemptCompletion
        return {
            success: false,
            result: '子任务已结束但未返回结果。',
            subtask_id: subTask.task_id
        };
    } catch (err: any) {
        subTask.stop('system');
        logger.warn(`[subtask] subtask failed subtask=${subTask.task_id} error=${err?.message ?? String(err)}`);
        return {
            success: false,
            result: `子任务执行失败: ${err?.message ?? String(err)}`,
            subtask_id: subTask.task_id
        };
    }
}

// ─── waitSubTaskResult: 等待子任务结果 ─────────────────────────────────────────

export interface WaitSubTaskOptions {
    /** 子任务ID */
    subtaskId: string;
    /** 父任务（用于查找子任务） */
    parentTask: TaskState;
    /** 进度回调 */
    onProgress?: (progress: SubTaskProgressInfo) => void;
}

/**
 * 等待子任务完成并返回结果
 * 复用于 createSubTask 异步模式和 waitSubTask 工具
 */
export async function waitSubTaskResult(options: WaitSubTaskOptions): Promise<SubTaskResult> {
    const { subtaskId, parentTask, onProgress } = options;

    // 先检查 pending 列表
    const pending = pendingSubTasks.get(subtaskId);
    if (pending) {
        const subTask = pending.taskState;

        // 如果子任务还在运行，等待并报告进度
        if (subTask && (subTask.task_status === 'running' || subTask.task_status === 'waiting')) {
            await waitForTaskWithProgress(subTask, onProgress);
        }

        const result = await pending.promise;
        pendingSubTasks.delete(subtaskId);
        return result;
    }

    // 从任务管理器中查找
    const subTask = parentTask.task_manager_state.getTask(subtaskId);
    if (!subTask) {
        return {
            success: false,
            result: `未找到子任务: ${subtaskId}`,
            subtask_id: subtaskId,
        };
    }

    // 如果已经有结果，直接返回
    const existingResult = extractAttemptCompletionResult(subTask);
    if (existingResult) {
        return {
            ...existingResult,
            subtask_id: subtaskId
        };
    }

    // 等待子任务完成
    await waitForTaskWithProgress(subTask, onProgress);

    const completionResult = extractAttemptCompletionResult(subTask);
    if (completionResult) {
        return {
            ...completionResult,
            subtask_id: subtaskId
        };
    }

    return {
        success: false,
        result: '子任务已结束但未调用 attemptCompletion 返回结果。',
        subtask_id: subtaskId
    };
}

/**
 * 等待任务完成并报告进度（内部复用函数）
 */
async function waitForTaskWithProgress(
    task: TaskState,
    onProgress?: (progress: SubTaskProgressInfo) => void
): Promise<void> {
    if (!onProgress) {
        await task.waitUntilFinished();
        return;
    }

    const progress: SubTaskProgressInfo = { tools: [], lastText: null };
    let lastProgressTime = 0;

    await task.waitUntilFinished((chunk) => {
        extractSubTaskProgress(chunk, progress);
        const now = Date.now();
        if (now - lastProgressTime >= PROGRESS_THROTTLE_MS) {
            lastProgressTime = now;
            onProgress({ tools: [...progress.tools], lastText: progress.lastText });
        }
    });
}

// ─── Tool Classes ──────────────────────────────────────────────────────────────

const CreateSubTaskArgsSchema = z.object({
    title: z.string().describe('子任务标题，一句话解释任务目标'),
    objective: z.string().describe('完整的任务目标，尽可能详细地描述任务细节。这是唯一会带入子任务的上下文信息'),
    criteria: z.string().describe('子任务的输出结果要求，描述期望输出的内容，格式等要求'),
    isAsync: z.boolean().default(false).describe('是否异步执行')
});

export class CreateSubTaskTool extends BaseTool<typeof CreateSubTaskArgsSchema> {

    constructor() {
        super('createSubTask', '创建并执行一个上下文隔离的子任务', CreateSubTaskArgsSchema);
        this.setUniversalExecutor(this.handleExecute.bind(this));
    }

    static renderProgressCli(progress: SubTaskProgressInfo | undefined, width: number): string[] {
        const lines: string[] = [];
        if (!progress || (progress.tools.length === 0 && !progress.lastText)) return lines;

        lines.push(chalk.dim('─'.repeat(Math.min(width - 8, 30))));
        for (const t of progress.tools) {
            const icon = t.status === 'success' ? chalk.greenBright('✔') :
                t.status === 'error' ? chalk.redBright('✘') :
                    t.status === 'running' ? chalk.blueBright('●') :
                        chalk.dim('○');
            const shortName = t.name.includes('-') ? t.name.split('-').slice(1).join('-') : t.name;
            lines.push(`  ${icon} ${chalk.dim(shortName)}`);
        }
        if (progress.lastText) {
            lines.push(`  ${chalk.dim('💬')} ${chalk.dim(truncText(progress.lastText, width - 16))}`);
        }
        return lines;
    }

    static renderProgressHtml(progress: SubTaskProgressInfo | undefined): string {
        if (!progress || (progress.tools.length === 0 && !progress.lastText)) return '';

        const toolItems = progress.tools.map(t => {
            const dotColor = t.status === 'success' ? 'bg-emerald-500' :
                t.status === 'error' ? 'bg-rose-500' :
                    t.status === 'running' ? 'bg-blue-500 animate-pulse' :
                        'bg-slate-300';
            const shortName = t.name.includes('-') ? t.name.split('-').slice(1).join('-') : t.name;
            return `<div class="flex items-center space-x-2">
                <div class="h-1.5 w-1.5 rounded-full ${dotColor}"></div>
                <span class="text-slate-500 font-mono text-[11px]">${shortName}</span>
            </div>`;
        }).join('');

        const textPreview = progress.lastText
            ? `<div class="flex items-start space-x-2 text-slate-400 mt-0.5">
                <span class="shrink-0 text-[10px]">💬</span>
                <span class="truncate text-[11px]">${progress.lastText.length > 60 ? progress.lastText.slice(0, 60) + '…' : progress.lastText}</span>
               </div>`
            : '';

        return `<div class="mt-2 ml-7 space-y-1 text-xs border-l-2 border-blue-100 pl-3">
            ${toolItems}${textPreview}
        </div>`;
    }

    private static getProgress(toolcall: ToolCall): SubTaskProgressInfo | undefined {
        return (toolcall.result_object as any)?.subtask_progress as SubTaskProgressInfo | undefined;
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as z.output<typeof CreateSubTaskArgsSchema> | undefined;
        const body: string[] = [];

        if (args?.title) {
            body.push(chalk.dim('标题: ') + truncText(args.title, width - 12));
        }
        if (args?.objective) {
            body.push(chalk.dim('目标: ') + truncText(args.objective, width - 12));
        }
        if (args?.isAsync) {
            body.push(chalk.dim('模式: ') + chalk.cyan('异步'));
        }

        if (toolcall.status === 'running') {
            body.push(...CreateSubTaskTool.renderProgressCli(CreateSubTaskTool.getProgress(toolcall), width));
        }

        if (toolcall.status === 'success' && toolcall.result) {
            try {
                const parsed = JSON.parse(toolcall.result);
                if (parsed.success !== undefined) {
                    const icon = parsed.success ? chalk.greenBright('✔') : chalk.redBright('✘');
                    body.push(`${icon} ${parsed.success ? '成功' : '失败'}`);
                    if (parsed.result) {
                        body.push(chalk.dim('  结果: ') + truncText(parsed.result, width - 14));
                    }
                } else if (parsed.subtask_id) {
                    body.push(chalk.blueBright(`⏳ 异步子任务已创建: ${parsed.subtask_id.slice(0, 8)}...`));
                }
            } catch {
                body.push(chalk.greenBright('  ✔ 子任务已完成'));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        }

        return new Card({
            icon: '📋',
            title: '创建子任务',
            status: statusDisplay(toolcall.status),
            body,
        }).render(width);
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const args = toolcall.args_object as z.output<typeof CreateSubTaskArgsSchema> | undefined;
        const title = args?.title || '子任务';
        const objective = args?.objective || '';
        const asyncTag = args?.isAsync ? ' <span class="text-blue-500 text-xs">[异步]</span>' : '';

        if (toolcall.status === 'running') {
            const activitiesHtml = CreateSubTaskTool.renderProgressHtml(CreateSubTaskTool.getProgress(toolcall));
            return `
            <div class="flex flex-col mt-3 mb-3 text-sm bg-white/80 backdrop-blur-md border border-slate-200 py-3 px-4 rounded-2xl shadow-sm w-fit min-w-[280px] max-w-md">
                <div class="flex items-center space-x-3">
                    <span class="text-base">📋</span>
                    <span class="font-semibold text-slate-600">子任务${asyncTag}</span>
                    <div class="h-2 w-2 rounded-full bg-blue-500 animate-pulse ring-4 ring-blue-100/50"></div>
                    <span class="text-slate-500 truncate max-w-xs">${title}</span>
                </div>
                ${objective ? `<div class="mt-1 text-xs text-slate-400 truncate max-w-full">目标: ${objective.length > 60 ? objective.slice(0, 60) + '…' : objective}</div>` : ''}
                ${activitiesHtml}
            </div>`;
        }

        let statusHtml = '';
        if (toolcall.status === 'success' && toolcall.result) {
            try {
                const parsed = JSON.parse(toolcall.result);
                if (parsed.success !== undefined) {
                    const icon = parsed.success ? '✅' : '❌';
                    statusHtml = `<span>${icon}</span><span class="text-slate-500 truncate max-w-xs">${parsed.result ? parsed.result.slice(0, 80) : ''}</span>`;
                } else if (parsed.subtask_id) {
                    statusHtml = `<span>⏳</span><span class="text-blue-500">异步执行中</span>`;
                }
            } catch {
                statusHtml = '<span class="text-emerald-500">✅</span>';
            }
        } else if (toolcall.status === 'error') {
            statusHtml = `<span class="text-rose-500">❌ 失败</span>`;
        }

        return `
        <div class="flex flex-col mt-3 mb-3 text-sm bg-white/80 backdrop-blur-md border border-slate-200 py-2 px-4 rounded-full shadow-sm w-fit">
            <div class="flex items-center space-x-4">
                <span class="text-base">📋</span>
                <span class="font-semibold text-slate-600">子任务${asyncTag}</span>
                <span class="text-slate-500 truncate max-w-xs">${title}</span>
                ${statusHtml}
            </div>
            ${objective ? `<div class="text-xs text-slate-400 truncate max-w-full ml-6">目标: ${objective.length > 50 ? objective.slice(0, 50) + '…' : objective}</div>` : ''}
        </div>`;
    }

    private async handleExecute(args: z.output<typeof CreateSubTaskArgsSchema>, toolResult: ToolResult, taskState?: TaskState): Promise<void> {
        if (!taskState) {
            throw new Error('createSubTask requires task state');
        }

        const config: SubTaskConfig = {
            title: args.title,
            objective: args.objective,
            criteria: args.criteria,
            isAsync: args.isAsync,
        };

        if (config.isAsync) {
            // 异步模式：启动子任务并立即返回 ID
            let asyncSubTaskState: TaskState | undefined;
            const promise = startSubTask({
                parentTask: taskState,
                config,
                onCreated: (st) => { asyncSubTaskState = st; }
            });

            const tempId = crypto.randomUUID();
            pendingSubTasks.set(tempId, { promise, taskState: asyncSubTaskState });

            promise.then(result => {
                pendingSubTasks.delete(tempId);
                pendingSubTasks.set(result.subtask_id, { promise: Promise.resolve(result) });
            }).catch(() => {
                pendingSubTasks.delete(tempId);
            });

            // 等待一小段时间，看任务是否能快速完成
            const earlyResult = await new Promise<SubTaskResult | string>((resolve) => {
                const timeout = setTimeout(() => resolve(tempId), 200);
                promise.then(result => {
                    clearTimeout(timeout);
                    resolve(result);
                }).catch(() => {
                    clearTimeout(timeout);
                    resolve(tempId);
                });
            });

            if (typeof earlyResult === 'string') {
                toolResult.result = JSON.stringify({ subtask_id: earlyResult, async: true });
            } else {
                toolResult.result = JSON.stringify(earlyResult);
            }
            return;
        }

        // 同步模式：等待子任务完成
        const result = await startSubTask({
            parentTask: taskState,
            config,
            onProgress: (progress) => {
                toolResult.updateResultObject({ subtask_progress: progress });
            }
        });

        toolResult.result = JSON.stringify(result);
    }
}

const WaitSubTaskArgsSchema = z.object({
    subtask_id: z.string().describe('要等待的异步子任务的ID'),
});

export class WaitSubTaskTool extends BaseTool<typeof WaitSubTaskArgsSchema> {
    constructor() {
        super(
            'waitSubTask',
            '等待一个异步子任务完成并返回其结果。输入是 createSubTask 异步模式返回的 subtask_id。',
            WaitSubTaskArgsSchema
        );
        this.setUniversalExecutor(this.handleExecute.bind(this));
    }

    private static getProgress(toolcall: ToolCall): SubTaskProgressInfo | undefined {
        return (toolcall.result_object as any)?.subtask_progress as SubTaskProgressInfo | undefined;
    }

    private static getSubTaskTitle(toolcall: ToolCall): string {
        // 从 pendingSubTasks 中查找子任务标题
        const subtaskId = (toolcall.args_object as any)?.subtask_id as string | undefined;
        if (subtaskId) {
            const pending = pendingSubTasks.get(subtaskId);
            if (pending?.taskState) {
                return pending.taskState.task_name || '子任务';
            }
        }
        return '子任务';
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as z.output<typeof WaitSubTaskArgsSchema> | undefined;
        const body: string[] = [];
        const title = WaitSubTaskTool.getSubTaskTitle(toolcall);

        body.push(chalk.dim('标题: ') + chalk.cyan(truncText(title, width - 12)));

        if (toolcall.status === 'running') {
            body.push(...CreateSubTaskTool.renderProgressCli(
                WaitSubTaskTool.getProgress(toolcall), width
            ));
        }

        if (toolcall.status === 'success' && toolcall.result) {
            try {
                const parsed = JSON.parse(toolcall.result);
                const icon = parsed.success ? chalk.greenBright('✔') : chalk.redBright('✘');
                body.push(`${icon} ${parsed.success ? '成功' : '失败'}`);
                if (parsed.result) {
                    body.push(chalk.dim('  结果: ') + truncText(parsed.result, width - 14));
                }
            } catch {
                body.push(chalk.greenBright('  ✔ 子任务已完成'));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        }

        return new Card({
            icon: '⏳',
            title: '等待子任务',
            status: statusDisplay(toolcall.status),
            body,
        }).render(width);
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const title = WaitSubTaskTool.getSubTaskTitle(toolcall);

        if (toolcall.status === 'running') {
            const activitiesHtml = CreateSubTaskTool.renderProgressHtml(
                WaitSubTaskTool.getProgress(toolcall)
            );
            return `
            <div class="flex flex-col mt-3 mb-3 text-sm bg-white/80 backdrop-blur-md border border-slate-200 py-3 px-4 rounded-2xl shadow-sm w-fit min-w-[280px] max-w-md">
                <div class="flex items-center space-x-3">
                    <span class="text-base">⏳</span>
                    <span class="font-semibold text-slate-600">等待子任务</span>
                    <div class="h-2 w-2 rounded-full bg-blue-500 animate-pulse ring-4 ring-blue-100/50"></div>
                    <span class="text-slate-500 truncate max-w-xs">${title}</span>
                </div>
                ${activitiesHtml}
            </div>`;
        }

        let statusHtml = '';
        if (toolcall.status === 'success' && toolcall.result) {
            try {
                const parsed = JSON.parse(toolcall.result);
                const icon = parsed.success ? '✅' : '❌';
                statusHtml = `<span>${icon}</span><span class="text-slate-500 truncate max-w-xs">${parsed.result ? parsed.result.slice(0, 80) : ''}</span>`;
            } catch {
                statusHtml = '<span class="text-emerald-500">✅</span>';
            }
        } else if (toolcall.status === 'error') {
            statusHtml = `<span class="text-rose-500">❌ 失败</span>`;
        }

        return `
        <div class="flex mt-3 mb-3 text-sm items-center space-x-4 bg-white/80 backdrop-blur-md border border-slate-200 py-2 px-4 rounded-full shadow-sm w-fit">
            <span class="text-base">⏳</span>
            <span class="font-semibold text-slate-600">等待子任务</span>
            <span class="text-slate-500 truncate max-w-xs">${title}</span>
            ${statusHtml}
        </div>`;
    }

    private async handleExecute(args: z.output<typeof WaitSubTaskArgsSchema>, toolResult: ToolResult, taskState?: TaskState): Promise<void> {
        if (!taskState) {
            throw new Error('waitSubTask requires task state');
        }

        const result = await waitSubTaskResult({
            subtaskId: args.subtask_id,
            parentTask: taskState,
            onProgress: (progress) => {
                toolResult.updateResultObject({ subtask_progress: progress });
            }
        });

        toolResult.result = JSON.stringify(result);
    }
}

const AttemptCompletionArgsSchema = z.object({
    success: z.boolean().describe('子任务是否成功完成'),
    result: z.string().describe('如果成功完成则该参数为任务的返回结果，若为成功完成则为失败原因'),
});

export class AttemptCompletionTool extends BaseTool<typeof AttemptCompletionArgsSchema> {
    constructor() {
        super('attemptCompletion', '完成子任务并返回结果', AttemptCompletionArgsSchema);
        this.setUniversalExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as z.output<typeof AttemptCompletionArgsSchema> | undefined;
        const body: string[] = [];

        if (args) {
            const icon = args.success ? chalk.greenBright('✔') : chalk.redBright('✘');
            body.push(`${icon} ${args.success ? '成功' : '失败'}`);
            if (args.result) {
                const markdown = new Markdown(args.result, 0, 0, defaultMarkdownTheme);
                body.push(...markdown.render(width - 10));
            }
        }

        return new Card({
            icon: '🏁',
            title: '提交子任务结果',
            status: statusDisplay(toolcall.status),
            body,
        }).render(width);
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const args = toolcall.args_object as z.output<typeof AttemptCompletionArgsSchema> | undefined;
        const successIcon = args?.success ? '✅' : '❌';
        const statusText = args?.success ? '成功' : '失败';
        const resultHtml = args?.result ? await marked.parse(args.result) : '';

        return `
        <div class="flex flex-col mt-3 mb-3 text-sm bg-white/80 backdrop-blur-md border border-slate-200 py-3 px-4 rounded-2xl shadow-sm w-fit max-w-2xl">
            <div class="flex items-center space-x-3 mb-2">
                <span class="text-base">${successIcon}</span>
                <span class="font-semibold text-slate-600">子任务${statusText}</span>
            </div>
            ${resultHtml ? `<div class="prose prose-slate prose-sm max-w-none">${resultHtml}</div>` : ''}
        </div>
        `;
    }

    private async handleExecute(args: z.output<typeof AttemptCompletionArgsSchema>, toolResult: ToolResult, taskState?: TaskState): Promise<void> {
        // 停止子任务，结果已经通过 tool call args 记录在消息历史中
        taskState?.stop('system');
        toolResult.attachResult(JSON.stringify({ accepted: true }));
    }
}

// ─── Toolset Factory Functions ────────────────────────────────────────────────

export function createMainPlanningToolset(): BaseToolset {
    const toolset = new BaseToolset('planning');
    toolset.addTool(new CreateSubTaskTool());
    toolset.addTool(new WaitSubTaskTool());
    return toolset;
}

export function createSubTaskPlanningToolset(): BaseToolset {
    const toolset = new BaseToolset('planning');
    toolset.addTool(new AttemptCompletionTool());
    return toolset;
}
