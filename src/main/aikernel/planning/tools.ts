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
import { Markdown, Text, truncateToWidth } from '@mariozechner/pi-tui';
import type { TaskState, TaskUpdateChunk } from '../states/tasks.js';
import type { TextMessagePart } from '../messages.js';
import type { SubTaskConfig, SubTaskResult, SubTaskProgressInfo, PendingSubTask } from './common.js';
import { AssistantMessage, UserMessage, ToolCall, ToolCallMessagePart, ErrorMessagePart, marked } from '../messages.js';
import { SUBTASK_SYSTEM_PROMPT } from './prompt.js';
import {
    registerSubTaskAttemptCompletionHook,
    appendSubTaskStopCompletion,
    extractAttemptCompletionResult,
    hasAttemptCompletion
} from './harness.js';
import { SkillRegistry } from '../skill.js';
import { getSkillsSection } from '../agents/shellagent.js';
import { logger } from '../../utils/logger.js';
import { defaultMarkdownTheme } from '../../tui/theme.js';
import chalk from 'chalk';
import format from 'string-template';

const SUBTASK_USER_MESSAGE_TEMPLATE = `
请按照下面的要求执行任务，完成后通过 planning-attemptCompletion 工具提交结果。你的所有待提交的结果都要通过
planning-attemptCompletion 工具的参数传递，避免通过写文件的形式传递任务结果交付件。
无论任务成功、失败还是因缺少信息无法继续，都必须调用 planning-attemptCompletion 结束任务。

## 任务标题
{title}

## 任务目标
{objective}

## 输出结果要求
{criteria}
`.trim();

// ─── Pending SubTasks Registry ─────────────────────────────────────────────────

const pendingSubTasks = new Map<string, PendingSubTask>();

// ─── Progress Extraction ───────────────────────────────────────────────────────

const PROGRESS_THROTTLE_MS = 300;

export function extractSubTaskProgress(chunk: TaskUpdateChunk, progress: SubTaskProgressInfo): void {
    const part = chunk.last_part;
    if (part.type === 'tool_call') {
        for (const tc of (part as ToolCallMessagePart).toolcalls) {
            const existing = progress.tools.find((t) => t.name === tc.tool_name);
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
 * - 使用 SUBTASK_SYSTEM_PROMPT，并拼接与主任务一致的技能列表（SkillRegistry frontmatter XML）
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
            subtask_id: 'n/a'
        };
    }

    // 创建子任务，继承父任务的 harnessContext（共享权限引擎和环境变量）
    const subTask = parentTask.task_manager_state.createSubTask(parentTask.task_id);
    subTask.model = parentTask.model;
    subTask.harnessContext = parentTask.harnessContext;
    subTask.task_name = config.title || '未命名子任务';

    const skillFrontmatters = await SkillRegistry.getInstance().getSkillFrontmatterXml();
    const subtaskSystemPrompt = [SUBTASK_SYSTEM_PROMPT.trim(), getSkillsSection(skillFrontmatters)].join('\n\n');
    subTask.setSystemPrompt(subtaskSystemPrompt);

    // 注册 attemptCompletion 检查钩子
    registerSubTaskAttemptCompletionHook(subTask);

    logger.info(
        `[subtask] created subtask=${subTask.task_id} parent=${parentTask.task_id} title="${config.title}" async=${config.isAsync}`
    );

    // 通知子任务已创建
    onCreated?.(subTask);

    // 进度跟踪
    const progress: SubTaskProgressInfo = { tools: [], lastText: null };
    let lastProgressTime = 0;
    const progressCallback = (chunk: TaskUpdateChunk) => {
        if (chunk.type !== 'assistant') return;
        extractSubTaskProgress(chunk, progress);
        const now = Date.now();
        if (onProgress && now - lastProgressTime >= PROGRESS_THROTTLE_MS) {
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
        await subTask.waitUntilFinished(progressCallback, true);

        // 等待一小段时间，让 afterFinishTurn 钩子完成（如果需要追加 synthetic attemptCompletion）
        await new Promise((resolve) => setTimeout(resolve, 100));

        // 兜底：afterFinishTurn 钩子通常已追加，此处防御钩子未触发的极端情况
        if (subTask.stop_requested_by_user && !hasAttemptCompletion(subTask)) {
            await appendSubTaskStopCompletion(subTask);
        }

        // 统一通过 extractAttemptCompletionResult 提取结果
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
            subtask_id: subtaskId
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

    if (subTask.stop_requested_by_user && !hasAttemptCompletion(subTask)) {
        await appendSubTaskStopCompletion(subTask);
    }

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
        await task.waitUntilFinished(undefined, true);
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
    }, true);
}

// ─── attachToSubTask: 向已存在的子任务追加消息 ──────────────────────────────────

export interface AttachToSubTaskOptions {
    /** 子任务ID */
    subtaskId: string;
    /** 要追加的消息内容 */
    message: string;
    /** 父任务（用于查找子任务） */
    parentTask: TaskState;
    /** 是否异步模式，异步模式下立即返回 */
    isAsync?: boolean;
    /** 进度回调 */
    onProgress?: (progress: SubTaskProgressInfo) => void;
}

/**
 * 向已存在的子任务追加新消息
 * 支持同步和异步两种模式
 * 当子任务已完成时，会重新启动它继续执行
 */
export async function attachToSubTask(options: AttachToSubTaskOptions): Promise<SubTaskResult> {
    const { subtaskId, message, parentTask, isAsync = false, onProgress } = options;

    const subTask = parentTask.task_manager_state.getTask(subtaskId);
    if (!subTask) {
        return {
            success: false,
            result: `未找到子任务: ${subtaskId}`,
            subtask_id: subtaskId
        };
    }

    // 检查子任务是否已完成，如果已完成则重新启动
    const wasFinished = subTask.task_status === 'stopped';

    // 如果子任务已完成，需要重新启动它
    if (wasFinished) {
        // submitUserMessage 会重置任务状态并重新启动任务
        await subTask.submitUserMessage(message);
    } else {
        // 子任务还在运行中，直接追加消息
        const userMessage = new UserMessage(message);
        subTask.chat_context.appendMessage(userMessage);
    }

    if (isAsync) {
        // 异步模式：立即返回，子任务在后台继续执行
        // 创建一个 Promise，在子任务完成时 resolve
        const resultPromise = new Promise<SubTaskResult>((resolve) => {
            const checkCompletion = async () => {
                await waitForTaskWithProgress(subTask, onProgress);
                const completionResult = extractAttemptCompletionResult(subTask);
                if (completionResult) {
                    resolve({
                        ...completionResult,
                        subtask_id: subtaskId
                    });
                } else {
                    resolve({
                        success: false,
                        result: '子任务已完成但未返回有效结果',
                        subtask_id: subtaskId
                    });
                }
            };
            checkCompletion();
        });

        // 注册到 pending 列表
        pendingSubTasks.set(subtaskId, {
            promise: resultPromise,
            taskState: subTask
        });

        return {
            success: true,
            result: `消息已追加到子任务 ${subtaskId}，子任务正在后台执行`,
            subtask_id: subtaskId
        };
    }

    // 同步模式：等待子任务完成
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
        result: '子任务已完成但未返回有效结果',
        subtask_id: subtaskId
    };
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
            const icon =
                t.status === 'success'
                    ? chalk.greenBright('✔')
                    : t.status === 'error'
                      ? chalk.redBright('✘')
                      : t.status === 'running'
                        ? chalk.blueBright('●')
                        : chalk.dim('○');
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

        const toolItems = progress.tools
            .map((t) => {
                const dotColor =
                    t.status === 'success'
                        ? 'bg-emerald-500'
                        : t.status === 'error'
                          ? 'bg-rose-500'
                          : t.status === 'running'
                            ? 'bg-blue-500 animate-pulse'
                            : 'bg-slate-300';
                const shortName = t.name.includes('-') ? t.name.split('-').slice(1).join('-') : t.name;
                return `<div class="flex items-center space-x-2">
                <div class="h-1.5 w-1.5 rounded-full ${dotColor}"></div>
                <span class="text-slate-500 font-mono text-[11px]">${shortName}</span>
            </div>`;
            })
            .join('');

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
                    const icon = parsed.success
                        ? chalk.greenBright('✔')
                        : parsed.status === 'ask'
                          ? chalk.yellowBright('❓')
                          : chalk.redBright('✘');
                    const label = parsed.success ? '成功' : parsed.status === 'ask' ? '询问' : '失败';
                    body.push(`${icon} ${label}`);
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
            body
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

    private async handleExecute(
        args: z.output<typeof CreateSubTaskArgsSchema>,
        toolResult: ToolResult,
        taskState?: TaskState
    ): Promise<void> {
        if (!taskState) {
            throw new Error('createSubTask requires task state');
        }

        const config: SubTaskConfig = {
            title: args.title,
            objective: args.objective,
            criteria: args.criteria,
            isAsync: args.isAsync
        };

        if (config.isAsync) {
            // 异步模式：启动子任务并立即返回真实的 task_id
            let asyncSubTaskState: TaskState | undefined;
            const promise = startSubTask({
                parentTask: taskState,
                config,
                onCreated: (st) => {
                    asyncSubTaskState = st;
                }
            });

            // 注册到 pending 列表，使用真实的 task_id 作为 key
            if (asyncSubTaskState) {
                pendingSubTasks.set(asyncSubTaskState.task_id, {
                    promise,
                    taskState: asyncSubTaskState
                });
                promise
                    .then((result) => {
                        pendingSubTasks.delete(asyncSubTaskState!.task_id);
                    })
                    .catch(() => {
                        pendingSubTasks.delete(asyncSubTaskState!.task_id);
                    });
            }

            // 等待一小段时间，看任务是否能快速完成
            const earlyResult = await new Promise<SubTaskResult | string>((resolve) => {
                const timeout = setTimeout(() => {
                    // 200ms 内没完成，返回真实的 task_id（如果有的话）
                    if (asyncSubTaskState) {
                        resolve(asyncSubTaskState.task_id);
                    } else {
                        resolve('pending');
                    }
                }, 200);
                promise
                    .then((result) => {
                        clearTimeout(timeout);
                        resolve(result);
                    })
                    .catch(() => {
                        clearTimeout(timeout);
                        if (asyncSubTaskState) {
                            resolve(asyncSubTaskState.task_id);
                        } else {
                            resolve('pending');
                        }
                    });
            });

            if (typeof earlyResult === 'string') {
                // 返回真实的 task_id 给 AI，而不是无意义的 tempId
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
    subtask_id: z.string().describe('要等待的异步子任务的ID')
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
            body.push(...CreateSubTaskTool.renderProgressCli(WaitSubTaskTool.getProgress(toolcall), width));
        }

        if (toolcall.status === 'success' && toolcall.result) {
            try {
                const parsed = JSON.parse(toolcall.result);
                const icon = parsed.success
                    ? chalk.greenBright('✔')
                    : parsed.status === 'ask'
                      ? chalk.yellowBright('❓')
                      : chalk.redBright('✘');
                const label = parsed.success ? '成功' : parsed.status === 'ask' ? '询问' : '失败';
                body.push(`${icon} ${label}`);
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
            body
        }).render(width);
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const title = WaitSubTaskTool.getSubTaskTitle(toolcall);

        if (toolcall.status === 'running') {
            const activitiesHtml = CreateSubTaskTool.renderProgressHtml(WaitSubTaskTool.getProgress(toolcall));
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

    private async handleExecute(
        args: z.output<typeof WaitSubTaskArgsSchema>,
        toolResult: ToolResult,
        taskState?: TaskState
    ): Promise<void> {
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

// ─── AttachToSubTask Tool ──────────────────────────────────────────────────────

const AttachToSubTaskArgsSchema = z.object({
    subtask_id: z.string().describe('要追加消息的子任务ID'),
    message: z.string().describe('要追加到子任务的消息内容'),
    isAsync: z.boolean().default(false).describe('是否异步执行，异步模式下立即返回')
});

export class AttachToSubTaskTool extends BaseTool<typeof AttachToSubTaskArgsSchema> {
    constructor() {
        super(
            'attachToSubTask',
            '向已存在的子任务追加新消息，用于在子任务需要补充信息时向其追加内容',
            AttachToSubTaskArgsSchema
        );
        this.setUniversalExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as z.output<typeof AttachToSubTaskArgsSchema> | undefined;
        const body: string[] = [];

        if (args) {
            body.push(chalk.dim('子任务ID: ') + chalk.cyan(truncText(args.subtask_id, width - 20)));
            body.push(chalk.dim('消息: ') + chalk.white(truncText(args.message, width - 12)));
            body.push(chalk.dim('模式: ') + (args.isAsync ? chalk.yellow('异步') : chalk.blue('同步')));
        }

        return new Card({
            icon: '➕',
            title: '追加消息到子任务',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const args = toolcall.args_object as z.output<typeof AttachToSubTaskArgsSchema> | undefined;

        if (!args) return undefined;

        const modeText = args.isAsync ? '异步' : '同步';
        const modeClass = args.isAsync ? 'text-amber-600' : 'text-blue-600';

        return `
        <div class="flex flex-col mt-3 mb-3 text-sm bg-white/80 backdrop-blur-md border border-slate-200 py-3 px-4 rounded-2xl shadow-sm w-fit min-w-[280px] max-w-md">
            <div class="flex items-center space-x-3">
                <span class="text-base">➕</span>
                <span class="font-semibold text-slate-600">追加消息到子任务</span>
            </div>
            <div class="mt-2 space-y-1 text-xs text-slate-500">
                <div><span class="text-slate-400">子任务ID:</span> <span class="font-mono">${args.subtask_id.slice(0, 16)}...</span></div>
                <div><span class="text-slate-400">消息:</span> ${truncText(args.message, 50)}</div>
                <div><span class="text-slate-400">模式:</span> <span class="${modeClass}">${modeText}</span></div>
            </div>
        </div>`;
    }

    private async handleExecute(
        args: z.output<typeof AttachToSubTaskArgsSchema>,
        toolResult: ToolResult,
        taskState?: TaskState
    ): Promise<void> {
        if (!taskState) {
            throw new Error('attachToSubTask requires task state');
        }

        const result = await attachToSubTask({
            subtaskId: args.subtask_id,
            message: args.message,
            parentTask: taskState,
            isAsync: args.isAsync,
            onProgress: (progress) => {
                toolResult.updateResultObject({ subtask_progress: progress });
            }
        });

        toolResult.result = JSON.stringify(result);
    }
}

// ─── AttemptCompletion for SubTask ─────────────────────────────────────────────

const AttemptCompletionSubTaskArgsSchema = z.object({
    type: z
        .enum(['success', 'fail', 'ask'])
        .describe('任务完成类型: success 表示任务成功完成, fail 表示任务无法完成, ask 表示需要补充信息'),
    message: z.string().describe('success 时为任务结果的详细描述, fail 时为失败原因, ask 时为需要补充的信息描述')
});

export class AttemptCompletionSubTaskTool extends BaseTool<typeof AttemptCompletionSubTaskArgsSchema> {
    constructor() {
        super('attemptCompletion', '完成子任务并返回结果', AttemptCompletionSubTaskArgsSchema);
        this.setUniversalExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as z.output<typeof AttemptCompletionSubTaskArgsSchema> | undefined;
        if (!args) return undefined;

        if (args.type === 'fail') {
            const body: string[] = [];
            body.push(chalk.redBright('子任务未能完成：'));
            if (args.message) {
                const markdown = new Markdown(args.message, 0, 0, defaultMarkdownTheme);
                body.push(...markdown.render(width - 4));
            }
            return new Card({
                icon: '❌',
                title: '子任务失败',
                status: statusDisplay(toolcall.status),
                body
            }).render(width);
        }

        if (args.type === 'ask') {
            const body: string[] = [];
            if (args.message) {
                const markdown = new Markdown(args.message, 0, 0, defaultMarkdownTheme);
                body.push(...markdown.render(width - 4));
            }
            return new Card({
                icon: '❓',
                title: '子任务需要补充信息',
                status: { icon: chalk.yellowBright('❙'), text: chalk.yellowBright('等待输入') },
                body
            }).render(width);
        }

        // success
        const body: string[] = [];
        if (args.message) {
            const markdown = new Markdown(args.message, 0, 0, defaultMarkdownTheme);
            body.push(...markdown.render(width - 4));
        }
        return new Card({
            icon: '🏁',
            title: '子任务完成',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const args = toolcall.args_object as z.output<typeof AttemptCompletionSubTaskArgsSchema> | undefined;
        if (!args) return undefined;

        if (args.type === 'fail') {
            const messageHtml = args.message ? await marked.parse(args.message) : '';
            return `
            <div class="flex flex-col mt-1 mb-1 text-xs bg-rose-50/80 backdrop-blur-md border border-rose-200 py-2 px-3 rounded-xl shadow-sm w-fit max-w-2xl">
                <div class="flex items-center space-x-2 mb-1">
                    <span class="text-sm">❌</span>
                    <span class="font-medium text-rose-600">子任务未能完成</span>
                </div>
                ${messageHtml ? `<div class="prose prose-slate prose-xs max-w-none">${messageHtml}</div>` : ''}
            </div>`;
        }

        if (args.type === 'ask') {
            const messageHtml = args.message ? await marked.parse(args.message) : '';
            return `
            <div class="flex flex-col mt-1 mb-1 text-xs bg-amber-50/80 backdrop-blur-md border border-amber-200 py-2 px-3 rounded-xl shadow-sm w-fit max-w-2xl">
                <div class="flex items-center space-x-2 mb-1">
                    <span class="text-sm">❓</span>
                    <span class="font-medium text-amber-600">子任务需要补充信息</span>
                </div>
                ${messageHtml ? `<div class="prose prose-slate prose-xs max-w-none">${messageHtml}</div>` : ''}
            </div>`;
        }

        // success
        const messageHtml = args.message ? await marked.parse(args.message) : '';
        return `
        <div class="flex flex-col mt-1 mb-1 text-xs bg-emerald-50/80 backdrop-blur-md border border-emerald-200 py-2 px-3 rounded-xl shadow-sm w-fit max-w-2xl">
            <div class="flex items-center space-x-2 mb-1">
                <span class="text-sm">✅</span>
                <span class="font-medium text-emerald-600">子任务完成</span>
            </div>
            ${messageHtml ? `<div class="prose prose-slate prose-xs max-w-none">${messageHtml}</div>` : ''}
        </div>`;
    }

    private async handleExecute(
        args: z.output<typeof AttemptCompletionSubTaskArgsSchema>,
        toolResult: ToolResult,
        taskState?: TaskState
    ): Promise<void> {
        taskState?.stop('system');
        toolResult.attachResult(JSON.stringify({ accepted: true, type: args.type }));
    }
}

// ─── Toolset Factory Functions ────────────────────────────────────────────────

export function createMainPlanningToolset(): BaseToolset {
    const toolset = new BaseToolset('planning');
    toolset.addTool(new CreateSubTaskTool());
    toolset.addTool(new WaitSubTaskTool());
    toolset.addTool(new AttachToSubTaskTool());
    return toolset;
}

export function createSubTaskPlanningToolset(): BaseToolset {
    const toolset = new BaseToolset('planning');
    toolset.addTool(new AttemptCompletionSubTaskTool());
    return toolset;
}

// ─── 注册全局钩子 ─────────────────────────────────────────────────────────────
// harness.ts 在模块加载时自动注册全局钩子，此处通过 import 确保副作用执行
import './harness.js';
