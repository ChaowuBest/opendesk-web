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
import { Markdown } from '@earendil-works/pi-tui';
import type {
    TaskModelRequestOptions,
    TaskState,
    TaskUpdateAssistantChunk,
    TaskUpdateChunk
} from '../states/tasks.js';
import type { TextMessagePart } from '../messages.js';
import type { SubTaskConfig, SubTaskResult, SubTaskProgressInfo, PendingSubTask } from './common.js';
import { UserMessage, ToolCall, ToolCallMessagePart, marked } from '../messages.js';
import {
    registerSubTaskAttemptCompletionHook,
    appendSubTaskStopCompletion,
    extractAttemptCompletionResult,
    hasAttemptCompletion
} from './harness.js';
import { AgentRegistry } from '../agents/registry.js';
import { HarnessContext } from '../security/harness.js';
import { getTaskArtifactDirectory } from '../../utils/setting.js';
import { logger } from '../../utils/logger.js';
import { escapeHtml } from '../../../common/utils/escape.js';
import { t } from '../../../locale/index.js';
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

const PROGRESS_THROTTLE_MS = 1000;

export function extractSubTaskProgress(chunk: TaskUpdateAssistantChunk, progress: SubTaskProgressInfo): void {
    const part = chunk.last_part;
    // last_part 可能不存在（如流式更新异常），跳过处理
    if (!part) return;
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
    /** 父 turn 的模型请求上下文，仅传给本次子任务请求，不持久化。 */
    modelRequestOptions?: TaskModelRequestOptions;
}

/**
 * 启动一个子任务
 * - 根据子任务绑定的 Agent 从 AgentRegistry 构建 system prompt
 * - 通过 UserMessage 传入任务目标、结果要求等信息
 * - 使用 TaskHooks 自动处理 attemptCompletion 检查
 */
export async function startSubTask(options: StartSubTaskOptions): Promise<SubTaskResult> {
    const { parentTask, config, onProgress, onCreated, modelRequestOptions } = options;

    // 检查父任务状态
    if (parentTask.task_status === 'stopped' || !parentTask.task_manager_state.getTask(parentTask.task_id)) {
        return {
            success: false,
            result: '父任务已停止或已被移除，子任务跳过执行。',
            subtask_id: 'n/a'
        };
    }

    // 创建子任务
    const subTask = parentTask.task_manager_state.createSubTask(parentTask.task_id);
    subTask.model = parentTask.model;
    subTask.task_name = config.title || '未命名子任务';
    subTask.interactionToolset = parentTask.interactionToolset;

    // 如果指定了 agentName，使用对应 Agent 的系统提示词、权限和工具过滤
    const agentDecl = config.agentName ? AgentRegistry.resolveDispatchableAgent(config.agentName) : undefined;
    if (config.agentName && !agentDecl) {
        logger.warn(
            `[subtask] agent "${config.agentName}" is unavailable for dispatch, falling back to default subtask agent`
        );
    }

    if (agentDecl) {
        subTask.agentId = agentDecl.agentId;
        const defaultMode = agentDecl.getDefaultMode();

        // workspace 优先取父任务的当前值（可能已被用户切换）
        const workspace = parentTask.harnessContext.workspace || '';
        if (workspace) {
            // explore 等只读 agent 不设 permissionPrompt，让 ask 自动拒绝
            subTask.harnessContext = await HarnessContext.createForMode(workspace, defaultMode);
            await subTask.harnessContext.grantTaskArtifactAccess(getTaskArtifactDirectory(subTask.task_id, false));
            // custom agent 继承父任务的 permissionPrompt，使 ask 权限能正常交互确认
            if (agentDecl.agentType === 'custom') {
                subTask.harnessContext.permissionPrompt = parentTask.harnessContext.permissionPrompt;
            }
        } else {
            subTask.harnessContext = parentTask.harnessContext;
        }

        // 应用 Mode 级别的工具过滤
        subTask.activeModeId = defaultMode.id;
        if (defaultMode.allowedTools && defaultMode.allowedTools.length > 0) {
            subTask.allowedTools = [...defaultMode.allowedTools];
        }
        if (defaultMode.disabledTools && defaultMode.disabledTools.length > 0) {
            subTask.disabledTools = [...defaultMode.disabledTools];
        }
        await subTask.rebuildSystemPrompt();
    } else {
        // 默认子任务：继承父任务的 harnessContext（复制 workspace、environ、权限引擎）
        subTask.harnessContext.environ = { ...parentTask.harnessContext.environ };
        subTask.harnessContext.permission = parentTask.harnessContext.permission;
        subTask.harnessContext.permissionPrompt = parentTask.harnessContext.permissionPrompt;
        subTask.harnessContext.workspace = parentTask.harnessContext.workspace;
        subTask.activeModeId = parentTask.activeModeId;
        subTask.allowedTools = parentTask.allowedTools;
        subTask.disabledTools = parentTask.disabledTools;

        await subTask.rebuildSystemPrompt();
    }

    // 注册 attemptCompletion 检查钩子
    registerSubTaskAttemptCompletionHook(subTask);

    logger.info(
        `[subtask] created subtask=${subTask.task_id} parent=${parentTask.task_id} title="${config.title}" async=${config.isAsync}`
    );

    parentTask.notifySubTaskCreated(subTask);

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
        await subTask.submitUserMessage(userMessage, { modelRequestOptions });
        await subTask.waitUntilFinished(progressCallback, true, true);

        // 如果子任务仍在运行（因父任务立即发送消息而被"分离"），转为后台异步子任务
        if (subTask.task_status === 'running' || subTask.task_status === 'waiting') {
            const resultPromise = (async (): Promise<SubTaskResult> => {
                try {
                    await waitForTaskWithProgress(subTask, undefined);
                    if (subTask.stop_requested_by_user && !hasAttemptCompletion(subTask)) {
                        await appendSubTaskStopCompletion(subTask);
                    }
                    const completionResult = extractAttemptCompletionResult(subTask);
                    if (completionResult) {
                        return { ...completionResult, subtask_id: subTask.task_id };
                    }
                    return {
                        success: false,
                        result: t('tools.createSubTask.endedWithoutResult'),
                        subtask_id: subTask.task_id
                    };
                } catch (err: any) {
                    const error = err?.message ?? String(err);
                    subTask.stop('system');
                    logger.warn(`[subtask] detached subtask wait failed subtask=${subTask.task_id} error=${error}`);
                    return {
                        success: false,
                        result: t('tools.createSubTask.executionFailed', { error }),
                        subtask_id: subTask.task_id
                    };
                }
            })();

            pendingSubTasks.set(subTask.task_id, {
                promise: resultPromise,
                taskState: subTask
            });
            resultPromise
                .then(() => {
                    pendingSubTasks.delete(subTask.task_id);
                })
                .catch(() => {
                    pendingSubTasks.delete(subTask.task_id);
                });

            logger.info(
                `[subtask] subtask=${subTask.task_id} detached to background (parent interrupted for new message)`
            );

            return {
                subtask_id: subTask.task_id,
                success: true,
                result: t('tools.createSubTask.detached'),
                status: 'success'
            };
        }

        // 正常流程：等待 afterFinishTurn 钩子完成（如果需要追加 synthetic attemptCompletion）
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
            result: t('tools.createSubTask.endedWithoutResult'),
            subtask_id: subTask.task_id
        };
    } catch (err: any) {
        const error = err?.message ?? String(err);
        subTask.stop('system');
        logger.warn(`[subtask] subtask failed subtask=${subTask.task_id} error=${error}`);
        return {
            success: false,
            result: t('tools.createSubTask.executionFailed', { error }),
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
        subTask.recordTaskInteraction();
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
    isAsync: z.boolean().default(false).describe('是否异步执行'),
    agentName: z.string().optional().describe('指定执行子任务的规范 Agent ID，留空则使用默认通用子任务执行器')
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
                        ? 'text-emerald-500'
                        : t.status === 'error'
                          ? 'text-rose-500'
                          : t.status === 'running'
                            ? 'text-blue-500'
                            : 'text-slate-300';
                const icon =
                    t.status === 'success'
                        ? 'fa-check'
                        : t.status === 'error'
                          ? 'fa-xmark'
                          : t.status === 'running'
                            ? 'fa-circle-notch fa-spin'
                            : 'fa-circle';
                const shortName = t.name.includes('-') ? t.name.split('-').slice(1).join('-') : t.name;
                return `<div class="flex items-center gap-1.5">
                <i class="fa-solid ${icon} ${dotColor} text-[9px] w-3 text-center"></i>
                <span class="text-gray-500 font-mono text-[11px]">${escapeHtml(shortName)}</span>
            </div>`;
            })
            .join('');

        const textPreview = progress.lastText
            ? `<div class="flex items-start gap-1.5 text-gray-400 mt-0.5">
                <i class="fa-solid fa-message text-[9px] w-3 text-center mt-0.5"></i>
                <span class="truncate text-[11px]">${escapeHtml(progress.lastText.length > 60 ? progress.lastText.slice(0, 60) + '…' : progress.lastText)}</span>
               </div>`
            : '';

        return `<div class="space-y-0.5 text-xs">
            ${toolItems}${textPreview}
        </div>`;
    }

    private static getProgress(toolcall: ToolCall): SubTaskProgressInfo | undefined {
        return (toolcall.result_object as any)?.subtask_progress as SubTaskProgressInfo | undefined;
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as z.output<typeof CreateSubTaskArgsSchema> | undefined;
        const body: string[] = [];

        // 卡片标题：含 agentName 时 "创建子任务 (agentName: 标题)"，否则 "创建子任务 (标题)"
        const titleSuffix = args?.title || '未命名';
        let cardTitle: string;
        if (args?.agentName) {
            const maxAgent = Math.max(6, Math.floor((width - 24) / 2));
            const agentLabel = truncText(args.agentName, maxAgent);
            const maxTitle = Math.max(12, width - 24 - agentLabel.length);
            cardTitle = `创建子任务 (${agentLabel}: ${truncText(titleSuffix, maxTitle)})`;
        } else {
            cardTitle = `创建子任务 (${truncText(titleSuffix, Math.max(12, width - 24))})`;
        }

        if (args?.objective) {
            body.push(truncText(args.objective, width - 8));
        }

        if (toolcall.status === 'running') {
            body.push(...CreateSubTaskTool.renderProgressCli(CreateSubTaskTool.getProgress(toolcall), width));
        }

        if (toolcall.status === 'success' && toolcall.result) {
            try {
                const parsed = JSON.parse(toolcall.result);
                if (parsed.result) {
                    body.push(chalk.dim('─'.repeat(Math.min(40, Math.max(4, width - 8)))));
                    const resultLines = String(parsed.result).split('\n');
                    const MAX_RESULT_LINES = 10;
                    if (resultLines.length > MAX_RESULT_LINES) {
                        body.push(chalk.dim.italic(`  … 共 ${resultLines.length} 行，显示最后 ${MAX_RESULT_LINES} 行`));
                    }
                    const displayLines = resultLines.slice(-MAX_RESULT_LINES);
                    for (const line of displayLines) {
                        body.push('  ' + chalk.dim(truncText(line, width - 10)));
                    }
                } else if (parsed.subtask_id && !parsed.success) {
                    const idMaxLen = Math.max(8, width - 22);
                    const idDisplay =
                        parsed.subtask_id.length > idMaxLen
                            ? parsed.subtask_id.slice(0, idMaxLen) + '…'
                            : parsed.subtask_id;
                    body.push(chalk.blueBright(`⏳ 异步子任务已创建: ${idDisplay}`));
                }
            } catch {
                /* ignore parse error */
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        }

        return new Card({
            icon: '📋',
            title: cardTitle,
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const args = toolcall.args_object as z.output<typeof CreateSubTaskArgsSchema> | undefined;
        const title = args?.title || '子任务';
        const isAsync = args?.isAsync;
        const isRunning = toolcall.status === 'running';
        const isError = toolcall.status === 'error';

        const borderColor = isError ? 'border-red-200' : 'border-gray-200';
        const iconBg = isError ? 'subtask-icon--error' : isRunning ? 'subtask-icon--info' : 'subtask-icon--success';

        let statusBadge = '';
        if (isRunning) {
            statusBadge = `<span class="subtask-badge--info flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium"><i class="fa-solid fa-circle-notch fa-spin text-[8px]"></i>执行中</span>`;
        } else if (isError) {
            statusBadge = `<span class="subtask-badge--error flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium"><i class="fa-solid fa-circle-xmark text-[8px]"></i>失败</span>`;
        } else if (toolcall.status === 'success' && toolcall.result) {
            try {
                const parsed = JSON.parse(toolcall.result);
                if (parsed.success !== undefined) {
                    if (parsed.success) {
                        statusBadge = `<span class="subtask-badge--success flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium"><i class="fa-solid fa-circle-check text-[8px]"></i>完成</span>`;
                    } else {
                        statusBadge = `<span class="subtask-badge--error flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium"><i class="fa-solid fa-circle-xmark text-[8px]"></i>失败</span>`;
                    }
                } else if (parsed.subtask_id) {
                    statusBadge = `<span class="subtask-badge--warn flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium"><i class="fa-solid fa-clock text-[8px]"></i>异步</span>`;
                }
            } catch {
                statusBadge = `<span class="subtask-badge--success flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium"><i class="fa-solid fa-circle-check text-[8px]"></i>完成</span>`;
            }
        }

        const asyncTag = isAsync
            ? `<span class="subtask-badge--info text-[10px] font-medium px-1.5 py-0.5 rounded">异步</span>`
            : '';

        const toolName = t('tools.createSubTask.name');
        const objective = args?.objective || '';
        const agentTag = args?.agentName
            ? `<span class="subtask-badge--purple text-[10px] font-medium px-1.5 py-0.5 rounded">${escapeHtml(args.agentName)}</span>`
            : '';

        let bodyContent = '';
        if (isRunning) {
            const progress = CreateSubTaskTool.getProgress(toolcall);
            const progressHtml = CreateSubTaskTool.renderProgressHtml(progress);
            if (progressHtml) {
                bodyContent = `<div class="px-3.5 py-2.5">${progressHtml}</div>`;
            } else {
                bodyContent = `<div class="px-3.5 py-2.5 flex items-center gap-2 text-[12px] text-gray-400"><i class="fa-solid fa-circle-notch fa-spin text-blue-400"></i>子任务启动中…</div>`;
            }
        } else if (toolcall.status === 'success' && toolcall.result) {
            try {
                const parsed = JSON.parse(toolcall.result);
                if (parsed.subtask_id && !parsed.success && parsed.async) {
                    const objRendered = objective ? await marked.parse(objective) : '';
                    bodyContent = objRendered
                        ? `<div class="px-3.5 py-2.5 text-xs text-gray-600 leading-relaxed markdown-body max-h-[200px] overflow-y-auto">${objRendered}</div>`
                        : '';
                } else if (parsed.result) {
                    const resultText = String(parsed.result);
                    const color = parsed.success ? 'text-gray-600' : 'text-red-600';
                    const renderedResult = await marked.parse(resultText);
                    bodyContent = `<div class="px-3.5 py-2.5 text-xs ${color} leading-relaxed markdown-body max-h-[200px] overflow-y-auto">${renderedResult}</div>`;
                }
            } catch {
                /* ignore parse errors in render */
            }
        } else if (isError && toolcall.result) {
            bodyContent = `<div class="px-3.5 py-2.5 text-[12px] text-red-600">${escapeHtml(String(toolcall.result).slice(0, 200))}</div>`;
        }

        return `
        <details class="subtask-tool od-card-shadow my-2 rounded-[14px] border ${borderColor} bg-white overflow-hidden w-full" open>
            <summary class="flex items-center gap-2 px-3.5 py-2.5 cursor-pointer select-none hover:bg-gray-50/60 transition-colors duration-150 font-medium">
                <span class="inline-flex items-center justify-center w-5 h-5 rounded ${iconBg}">
                    <i class="fa-solid fa-diagram-project text-[10px]"></i>
                </span>
                <span class="text-[12px] text-gray-500 shrink-0">${escapeHtml(toolName)}</span>
                <span class="text-[12px] text-gray-600 truncate flex-1">${escapeHtml(title)}</span>
                ${agentTag}
                ${asyncTag}
                ${statusBadge}
                <svg class="w-3 h-3 text-gray-400 shrink-0 transition-transform duration-200" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                    <path d="M6 9l6 6 6-6"/>
                </svg>
            </summary>
            ${bodyContent ? `<div class="border-t border-gray-200 bg-gray-50/40"><div class="max-h-[200px] overflow-y-auto">${bodyContent}</div></div>` : ''}
        </details>`;
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
            isAsync: args.isAsync,
            agentName: args.agentName
        };

        if (config.isAsync) {
            // 异步模式：启动子任务并立即返回真实的 task_id
            let asyncSubTaskState: TaskState | undefined;
            const promise = startSubTask({
                parentTask: taskState,
                config,
                modelRequestOptions: taskState.getActiveModelRequestOptions(),
                onCreated: (st) => {
                    asyncSubTaskState = st;
                    toolResult.updateResultObject({ subtask_id: st.task_id });
                }
            });

            // 注册到 pending 列表，使用真实的 task_id 作为 key
            if (asyncSubTaskState) {
                pendingSubTasks.set(asyncSubTaskState.task_id, {
                    promise,
                    taskState: asyncSubTaskState
                });
                promise
                    .then((_result) => {
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
        let childTaskID: string | undefined;
        const result = await startSubTask({
            parentTask: taskState,
            config,
            modelRequestOptions: taskState.getActiveModelRequestOptions(),
            onCreated: (subTask) => {
                childTaskID = subTask.task_id;
                toolResult.updateResultObject({ subtask_id: subTask.task_id });
            },
            onProgress: (progress) => {
                toolResult.updateResultObject({
                    ...(childTaskID ? { subtask_id: childTaskID } : {}),
                    subtask_progress: progress
                });
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
        const body: string[] = [];
        const subTitle = WaitSubTaskTool.getSubTaskTitle(toolcall);
        const cardTitle = `等待子任务 (${truncText(subTitle, Math.max(12, width - 24))})`;

        if (toolcall.status === 'running') {
            body.push(...CreateSubTaskTool.renderProgressCli(WaitSubTaskTool.getProgress(toolcall), width));
        }

        if (toolcall.status === 'success' && toolcall.result) {
            try {
                const parsed = JSON.parse(toolcall.result);
                if (parsed.result) {
                    body.push(chalk.dim('─'.repeat(Math.min(40, Math.max(4, width - 8)))));
                    const resultLines = String(parsed.result).split('\n');
                    const MAX_RESULT_LINES = 10;
                    if (resultLines.length > MAX_RESULT_LINES) {
                        body.push(chalk.dim.italic(`  … 共 ${resultLines.length} 行，显示最后 ${MAX_RESULT_LINES} 行`));
                    }
                    const displayLines = resultLines.slice(-MAX_RESULT_LINES);
                    for (const line of displayLines) {
                        body.push('  ' + chalk.dim(truncText(line, width - 10)));
                    }
                }
            } catch {
                /* ignore parse error */
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        }

        return new Card({
            icon: '⏳',
            title: cardTitle,
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const title = WaitSubTaskTool.getSubTaskTitle(toolcall);
        const isRunning = toolcall.status === 'running';
        const isError = toolcall.status === 'error';

        const borderColor = isError ? 'border-red-200' : 'border-gray-200';
        const iconBg = isError ? 'subtask-icon--error' : isRunning ? 'subtask-icon--warn' : 'subtask-icon--success';

        let statusBadge = '';
        if (isRunning) {
            statusBadge = `<span class="subtask-badge--warn flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium"><i class="fa-solid fa-circle-notch fa-spin text-[8px]"></i>等待中</span>`;
        } else if (isError) {
            statusBadge = `<span class="subtask-badge--error flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium"><i class="fa-solid fa-circle-xmark text-[8px]"></i>失败</span>`;
        } else if (toolcall.status === 'success' && toolcall.result) {
            try {
                const parsed = JSON.parse(toolcall.result);
                if (parsed.success) {
                    statusBadge = `<span class="subtask-badge--success flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium"><i class="fa-solid fa-circle-check text-[8px]"></i>完成</span>`;
                } else {
                    statusBadge = `<span class="subtask-badge--error flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium"><i class="fa-solid fa-circle-xmark text-[8px]"></i>失败</span>`;
                }
            } catch {
                statusBadge = `<span class="subtask-badge--success flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium"><i class="fa-solid fa-circle-check text-[8px]"></i>完成</span>`;
            }
        }

        const toolName = t('tools.waitSubTask.name');

        let bodyContent = '';
        if (isRunning) {
            const progress = WaitSubTaskTool.getProgress(toolcall);
            const progressHtml = CreateSubTaskTool.renderProgressHtml(progress);
            if (progressHtml) {
                bodyContent = `<div class="px-3.5 py-2.5">${progressHtml}</div>`;
            } else {
                bodyContent = `<div class="px-3.5 py-2.5 flex items-center gap-2 text-[12px] text-gray-400"><i class="fa-solid fa-circle-notch fa-spin text-amber-400"></i>正在等待子任务完成…</div>`;
            }
        } else if (toolcall.status === 'success' && toolcall.result) {
            try {
                const parsed = JSON.parse(toolcall.result);
                if (parsed.result) {
                    const resultText = String(parsed.result);
                    const color = parsed.success ? 'text-gray-600' : 'text-red-600';
                    const renderedResult = await marked.parse(resultText);
                    bodyContent = `<div class="px-3.5 py-2.5 text-xs ${color} leading-relaxed markdown-body max-h-[240px] overflow-y-auto">${renderedResult}</div>`;
                }
            } catch {
                /* ignore parse errors in render */
            }
        } else if (isError && toolcall.result) {
            bodyContent = `<div class="px-3.5 py-2.5 text-[12px] text-red-600">${escapeHtml(String(toolcall.result).slice(0, 200))}</div>`;
        }

        return `
        <details class="subtask-tool od-card-shadow my-2 rounded-[14px] border ${borderColor} bg-white overflow-hidden w-full" open>
            <summary class="flex items-center gap-2 px-3.5 py-2.5 cursor-pointer select-none hover:bg-gray-50/60 transition-colors duration-150 font-medium">
                <span class="inline-flex items-center justify-center w-5 h-5 rounded ${iconBg}">
                    <i class="fa-solid fa-hourglass-half text-[10px]"></i>
                </span>
                <span class="text-[12px] text-gray-500 shrink-0">${escapeHtml(toolName)}</span>
                <span class="text-[12px] text-gray-600 truncate flex-1">${escapeHtml(title)}</span>
                ${statusBadge}
                <svg class="w-3 h-3 text-gray-400 shrink-0 transition-transform duration-200" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                    <path d="M6 9l6 6 6-6"/>
                </svg>
            </summary>
            ${bodyContent ? `<div class="border-t border-gray-200 bg-gray-50/40"><div class="max-h-[240px] overflow-y-auto">${bodyContent}</div></div>` : ''}
        </details>`;
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

        const isRunning = toolcall.status === 'running';
        const isError = toolcall.status === 'error';
        const borderColor = isError ? 'border-red-200' : 'border-gray-200';
        const iconBg = isError ? 'subtask-icon--error' : 'subtask-icon--violet';

        const modeTag = args.isAsync
            ? `<span class="subtask-badge--warn text-[10px] font-medium px-1.5 py-0.5 rounded">异步</span>`
            : `<span class="subtask-badge--info text-[10px] font-medium px-1.5 py-0.5 rounded">同步</span>`;

        let statusBadge = '';
        if (isRunning) {
            statusBadge = `<span class="subtask-badge--info flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium"><i class="fa-solid fa-circle-notch fa-spin text-[8px]"></i>执行中</span>`;
        } else if (isError) {
            statusBadge = `<span class="subtask-badge--error flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium"><i class="fa-solid fa-circle-xmark text-[8px]"></i>失败</span>`;
        } else if (toolcall.status === 'success') {
            statusBadge = `<span class="subtask-badge--success flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium"><i class="fa-solid fa-circle-check text-[8px]"></i>已发送</span>`;
        }

        const bodyContent = `
            <div class="px-3.5 py-2.5 space-y-1.5">
                <div class="flex items-center gap-2 text-[11px] min-w-0">
                    <span class="text-gray-400 shrink-0">${escapeHtml(t('tools.createSubTask.name'))}</span>
                    <span class="font-mono text-gray-500 truncate">${escapeHtml(args.subtask_id)}</span>
                </div>
                <div class="text-[12px] text-gray-600 leading-relaxed line-clamp-3">${escapeHtml(args.message)}</div>
            </div>`;

        return `
        <details class="subtask-tool od-card-shadow my-2 rounded-[14px] border ${borderColor} bg-white overflow-hidden w-full" open>
            <summary class="flex items-center gap-2 px-3.5 py-2.5 cursor-pointer select-none hover:bg-gray-50/60 transition-colors duration-150 font-medium">
                <span class="inline-flex items-center justify-center w-5 h-5 rounded ${iconBg}">
                    <i class="fa-solid fa-paper-plane text-[10px]"></i>
                </span>
                <span class="text-[12px] text-gray-500 shrink-0">${escapeHtml(t('tools.attachToSubTask.name'))}</span>
                ${modeTag}
                ${statusBadge}
                <svg class="w-3 h-3 text-gray-400 shrink-0 transition-transform duration-200" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                    <path d="M6 9l6 6 6-6"/>
                </svg>
            </summary>
            <div class="border-t border-gray-200 bg-gray-50/40">
                ${bodyContent}
            </div>
        </details>`;
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

        const taskId = toolcall.id ? toolcall.id.slice(0, 8) : '—';

        if (args.type === 'fail') {
            const messageHtml = args.message ? await marked.parse(args.message) : '';
            return `
            <div class="subtask-tool subtask-result subtask-result--fail my-2 w-full rounded-[14px] border bg-white overflow-hidden od-card-shadow">
                <div class="subtask-result-header flex items-center justify-between px-3.5 py-1.5 border-b">
                    <div class="flex items-center gap-2">
                        <span class="subtask-result-icon inline-flex items-center justify-center w-4 h-4 rounded">
                            <i class="fa-solid fa-xmark text-[9px]"></i>
                        </span>
                        <span class="subtask-result-title text-[11px] font-semibold">子任务报告</span>
                        <span class="subtask-result-taskid text-[10px] font-mono">#${taskId}</span>
                    </div>
                    <div class="subtask-result-badge flex items-center gap-1 px-2 py-0.5 rounded">
                        <i class="fa-solid fa-circle-xmark text-[9px]"></i>
                        <span class="text-[10px] font-medium">失败</span>
                    </div>
                </div>
                ${messageHtml ? `<div class="subtask-result-message px-3.5 py-2.5 text-xs leading-relaxed markdown-body">${messageHtml}</div>` : ''}
            </div>`;
        }

        if (args.type === 'ask') {
            const messageHtml = args.message ? await marked.parse(args.message) : '';
            return `
            <div class="subtask-tool subtask-result subtask-result--ask my-2 w-full rounded-[14px] border bg-white overflow-hidden od-card-shadow">
                <div class="subtask-result-header flex items-center justify-between px-3.5 py-1.5 border-b">
                    <div class="flex items-center gap-2">
                        <span class="subtask-result-icon inline-flex items-center justify-center w-4 h-4 rounded">
                            <i class="fa-solid fa-question text-[9px]"></i>
                        </span>
                        <span class="subtask-result-title text-[11px] font-semibold">子任务报告</span>
                        <span class="subtask-result-taskid text-[10px] font-mono">#${taskId}</span>
                    </div>
                    <div class="subtask-result-badge flex items-center gap-1 px-2 py-0.5 rounded">
                        <i class="fa-solid fa-circle-question text-[9px]"></i>
                        <span class="text-[10px] font-medium">等待补充</span>
                    </div>
                </div>
                ${messageHtml ? `<div class="subtask-result-message px-3.5 py-2.5 text-xs leading-relaxed markdown-body">${messageHtml}</div>` : ''}
            </div>`;
        }

        // success
        const messageHtml = args.message ? await marked.parse(args.message) : '';
        return `
        <div class="subtask-tool subtask-result subtask-result--success my-2 w-full rounded-[14px] border bg-white overflow-hidden od-card-shadow">
            <div class="subtask-result-header flex items-center justify-between px-3.5 py-1.5 border-b">
                <div class="flex items-center gap-2">
                    <span class="subtask-result-icon inline-flex items-center justify-center w-4 h-4 rounded">
                        <i class="fa-solid fa-check text-[9px]"></i>
                    </span>
                    <span class="subtask-result-title text-[11px] font-semibold">子任务报告</span>
                    <span class="subtask-result-taskid text-[10px] font-mono">#${taskId}</span>
                </div>
                <div class="subtask-result-badge flex items-center gap-1 px-2 py-0.5 rounded">
                    <i class="fa-solid fa-circle-check text-[9px]"></i>
                    <span class="text-[10px] font-medium">已完成</span>
                </div>
            </div>${messageHtml ? `<div class="subtask-result-message px-3.5 py-2.5 text-xs leading-relaxed markdown-body">${messageHtml}</div>` : ''}
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
