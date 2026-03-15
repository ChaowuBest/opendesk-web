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
import { BaseTool, BaseToolset, ToolResult } from '../tool.js';
import { Card } from '../../tui/components/card.js';
import { statusDisplay, truncText } from '../../tui/components/toolcall.js';
import type { TaskState, TaskUpdateChunk } from '../../states/tasks.js';
import { SystemMessage, type ToolCall } from '../messages.js';
import type { SubTaskConfig, SubTaskResult, SubTaskProgressInfo } from './common.js';
import { logger } from '../../utils/logger.js';


function safeSlice(input: string, maxLen: number): string {
    return input.length <= maxLen ? input : `${input.slice(0, maxLen)}...`;
}

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
        <div class="flex mt-3 mb-3 text-sm items-center space-x-4 bg-white/80 backdrop-blur-md border border-slate-200 py-2 px-4 rounded-full shadow-sm w-fit">
            <span class="text-base">📋</span>
            <span class="font-semibold text-slate-600">子任务${asyncTag}</span>
            <span class="text-slate-500 truncate max-w-xs">${title}</span>
            ${statusHtml}
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
            let asyncSubTaskState: TaskState | undefined;
            const promise = executeSubTask(taskState, config, undefined, (st) => {
                asyncSubTaskState = st;
            });
            const tempId = crypto.randomUUID();
            pendingSubTasks.set(tempId, { promise, taskState: asyncSubTaskState });

            promise.then(result => {
                pendingSubTasks.delete(tempId);
                pendingSubTasks.set(result.subtask_id, { promise: Promise.resolve(result) });
            }).catch(() => {
                pendingSubTasks.delete(tempId);
            });

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

        const result = await executeSubTask(taskState, config, (progress) => {
            toolResult.updateResultObject({ subtask_progress: progress });
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

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as z.output<typeof WaitSubTaskArgsSchema> | undefined;
        const body: string[] = [];

        if (args?.subtask_id) {
            body.push(chalk.dim('子任务ID: ') + chalk.cyan(truncText(args.subtask_id, width - 18)));
        }

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
        const args = toolcall.args_object as z.output<typeof WaitSubTaskArgsSchema> | undefined;
        const idPreview = args?.subtask_id ? args.subtask_id.slice(0, 8) + '...' : '?';

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
                    <span class="text-slate-500">${idPreview}</span>
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
            <span class="text-slate-500">${idPreview}</span>
            ${statusHtml}
        </div>`;
    }

    private async handleExecute(args: z.output<typeof WaitSubTaskArgsSchema>, toolResult: ToolResult, taskState?: TaskState): Promise<void> {
        if (!taskState) {
            throw new Error('waitSubTask requires task state');
        }

        const subtaskId = args.subtask_id;

        const pending = pendingSubTasks.get(subtaskId);
        if (pending) {
            const subTask = pending.taskState;

            if (subTask && (subTask.task_status === 'running' || subTask.task_status === 'waiting')) {
                const progress: SubTaskProgressInfo = { tools: [], lastText: null };
                let lastProgressTime = 0;
                await subTask.waitUntilFinished((chunk) => {
                    extractSubTaskProgress(chunk, progress);
                    const now = Date.now();
                    if (now - lastProgressTime >= 300) {
                        lastProgressTime = now;
                        toolResult.updateResultObject({
                            subtask_progress: { tools: [...progress.tools], lastText: progress.lastText }
                        });
                    }
                });
            }

            const result = await pending.promise;
            pendingSubTasks.delete(subtaskId);
            toolResult.result = JSON.stringify(result);
            return;
        }

        const subTask = taskState.task_manager_state.getTask(subtaskId);
        if (!subTask) {
            toolResult.result = JSON.stringify({
                success: false,
                result: `未找到子任务: ${subtaskId}`,
                subtask_id: subtaskId,
            } satisfies SubTaskResult);
            return;
        }

        if (subTask.completion_result) {
            toolResult.result = JSON.stringify({
                ...subTask.completion_result,
                subtask_id: subtaskId,
            } satisfies SubTaskResult);
            return;
        }

        const progress: SubTaskProgressInfo = { tools: [], lastText: null };
        let lastProgressTime = 0;

        await subTask.waitUntilFinished((chunk) => {
            extractSubTaskProgress(chunk, progress);
            const now = Date.now();
            if (now - lastProgressTime >= 300) {
                lastProgressTime = now;
                toolResult.updateResultObject({
                    subtask_progress: { tools: [...progress.tools], lastText: progress.lastText }
                });
            }
        });

        const cr = subTask.completion_result as { success: boolean; result: string } | undefined;
        if (cr) {
            toolResult.result = JSON.stringify({
                success: cr.success,
                result: cr.result,
                subtask_id: subtaskId,
            } satisfies SubTaskResult);
            return;
        }

        toolResult.result = JSON.stringify({
            success: false,
            result: '子任务已结束但未调用 attemptCompletion 返回结果。',
            subtask_id: subtaskId,
        } satisfies SubTaskResult);
    }
}

const AttemptCompletionArgsSchema = z.object({
    success: z.boolean().describe('Whether the subtask completed successfully.'),
    result: z.string().describe('If success=true, the task result. If success=false, the failure reason.'),
});

export class AttemptCompletionTool extends BaseTool<typeof AttemptCompletionArgsSchema> {
    private subTaskState: TaskState;

    constructor(subTaskState: TaskState) {
        super(
            'attemptCompletion',
            '完成子任务并返回结果。子任务必须通过此工具提交最终结果，success=true 时 result 为任务结果，success=false 时 result 为失败原因。',
            AttemptCompletionArgsSchema
        );
        this.subTaskState = subTaskState;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as z.output<typeof AttemptCompletionArgsSchema> | undefined;
        const body: string[] = [];

        if (args) {
            const icon = args.success ? chalk.greenBright('✔') : chalk.redBright('✘');
            body.push(`${icon} ${args.success ? '成功' : '失败'}`);
            if (args.result) {
                body.push(chalk.dim('结果: ') + truncText(args.result, width - 12));
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
        const resultPreview = args?.result ? safeSlice(args.result, 120) : '';

        return `
        <div class="flex mt-3 mb-3 text-sm items-center space-x-4 bg-white/80 backdrop-blur-md border border-slate-200 py-2 px-4 rounded-full shadow-sm w-fit">
            <span class="text-base">${successIcon}</span>
            <span class="font-semibold text-slate-600">子任务${statusText}</span>
            ${resultPreview ? `<span class="text-slate-500 truncate max-w-xs">${resultPreview}</span>` : ''}
        </div>
        `;
    }

    private async handleExecute(args: z.output<typeof AttemptCompletionArgsSchema>): Promise<string> {
        this.subTaskState.completion_result = {
            success: args.success,
            result: args.result,
        };
        this.subTaskState.stop('system');
        return JSON.stringify({ accepted: true });
    }
}

// ─── Subtask system prompt builder ───────────────────────────────────────────

export function buildSubTaskSystemPrompt(config: SubTaskConfig): string {
    return [
        '你是一个子任务执行器。请专注于完成分配给你的任务。',
        '',
        `## 任务标题`,
        config.title,
        '',
        `## 任务要求`,
        config.objective,
        '',
        `## 输出要求`,
        config.criteria,
        '',
        '## 完成规则',
        '完成任务后，你**必须**调用 attemptCompletion 工具来返回结果：',
        '- 如果任务成功完成，调用 attemptCompletion(success=true, result="你的结果")',
        '- 如果任务无法完成，调用 attemptCompletion(success=false, result="失败原因")',
        '- 你**不能**在没有调用 attemptCompletion 的情况下结束任务',
        '- result 参数的内容应当严格按照上面的输出要求来组织',
        '- 对于简单的任务，你应当将任务结果直接放在 attemptCompletion 工具中，对于复杂的任务，你可以将任务结果写入文件然后在结果中将文件路径告知主任务'
    ].join('\n');
}

// ─── Subtask progress extraction ─────────────────────────────────────────────

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

// ─── Subtask executor ────────────────────────────────────────────────────────

const MAX_COMPLETION_RETRIES = 3;
const PROGRESS_THROTTLE_MS = 300;

export async function executeSubTask(
    parentTask: TaskState,
    config: SubTaskConfig,
    onProgress?: (progress: SubTaskProgressInfo) => void,
    onCreated?: (subTask: TaskState) => void
): Promise<SubTaskResult> {
    if (parentTask.task_status === 'stopped' || !parentTask.task_manager_state.getTask(parentTask.task_id)) {
        return {
            success: false,
            result: '父任务已停止或已被移除，子任务跳过执行。',
            subtask_id: 'n/a',
        };
    }

    const subTask = parentTask.task_manager_state.createSubTask(parentTask.task_id);
    subTask.model = parentTask.model;
    subTask.task_name = toShortTitle(config.title) || '子任务';

    const subTaskPrompt = buildSubTaskSystemPrompt(config);
    subTask.chat_context.system_prompt = new SystemMessage(subTaskPrompt);

    logger.info(`[subtask] created subtask=${subTask.task_id} parent=${parentTask.task_id} title="${config.title}" async=${config.isAsync}`);

    onCreated?.(subTask);

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
        await subTask.submitUserMessage(config.objective);
        await subTask.waitUntilFinished(progressCallback);

        let retries = 0;
        while (!subTask.completion_result && !subTask.stop_requested_by_user && retries < MAX_COMPLETION_RETRIES) {
            retries++;
            logger.info(`[subtask] retry attemptCompletion subtask=${subTask.task_id} attempt=${retries}`);
            await subTask.submitUserMessage(
                '你还没有调用 attemptCompletion 工具来返回结果。请立即调用 planning-attemptCompletion 工具提交你的任务结果。'
            );
            await subTask.waitUntilFinished(progressCallback);
        }

        if (subTask.stop_requested_by_user) {
            return {
                success: false,
                result: '子任务被用户手动停止。',
                subtask_id: subTask.task_id,
            };
        }

        if (subTask.completion_result) {
            return {
                ...subTask.completion_result,
                subtask_id: subTask.task_id,
            };
        }

        return {
            success: false,
            result: `子任务在 ${MAX_COMPLETION_RETRIES} 次重试后仍未调用 attemptCompletion。`,
            subtask_id: subTask.task_id,
        };
    } catch (err: any) {
        subTask.stop('system');
        logger.warn(`[subtask] subtask failed subtask=${subTask.task_id} error=${err?.message ?? String(err)}`);
        return {
            success: false,
            result: `子任务执行失败: ${err?.message ?? String(err)}`,
            subtask_id: subTask.task_id,
        };
    }
}

export function createMainPlanningToolset(): BaseToolset {
    const toolset = new BaseToolset('planning');
    toolset.addTool(new CreateSubTaskTool());
    toolset.addTool(new WaitSubTaskTool());
    return toolset;
}

export function createSubTaskPlanningToolset(subTask: TaskState): BaseToolset {
    const toolset = new BaseToolset('planning');
    toolset.addTool(new AttemptCompletionTool(subTask));
    return toolset;
}
