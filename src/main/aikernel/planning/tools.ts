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
import type { TaskState } from '../../states/tasks.js';
import type { ToolCall } from '../messages.js';
import {
    executeSubTask,
    pendingSubTasks,
    extractSubTaskProgress,
    AttemptCompletionTool,
    type SubTaskConfig,
    type SubTaskResult,
    type SubTaskProgressInfo,
    type PendingSubTask,
} from './subtask.js';

// ─── CreateSubTaskTool ───────────────────────────────────────────────────────

const CreateSubTaskArgsSchema = z.object({
    title: z.string().describe('子任务标题，一句话解释任务目标。'),
    requirements: z.string().describe('完整的任务要求，尽可能详细地描述任务目标。这是唯一会带入子任务的上下文信息。'),
    outputRequirements: z.string().describe('子任务的输出结果要求，描述期望的返回内容格式和内容。'),
    isAsync: z.boolean().default(false).describe('是否异步执行。true=立即返回子任务ID，false=等待完成后返回结果。'),
    keepContext: z.boolean().default(false).describe('是否保留当前任务的系统提示作为子任务的上下文。'),
});

export class CreateSubTaskTool extends BaseTool<typeof CreateSubTaskArgsSchema> {

    constructor() {
        super(
            'createSubTask',
            '创建并执行一个隔离的子任务。子任务拥有独立的工具集，通过 attemptCompletion 返回结果。' +
            '同步模式下，工具会等待子任务完成并返回结果，异步模式下立即返回子任务ID，并通过 waitSubTask 工具等待子任务完成并获取结果。',
            CreateSubTaskArgsSchema
        );
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
            requirements: args.requirements,
            outputRequirements: args.outputRequirements,
            isAsync: args.isAsync,
            keepContext: args.keepContext,
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

// ─── WaitSubTaskTool ─────────────────────────────────────────────────────────

const WaitSubTaskArgsSchema = z.object({
    subtask_id: z.string().describe('要等待的异步子任务的ID。'),
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
                subTask.waitUntilFinished((chunk) => {
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

// ─── Toolset factories ───────────────────────────────────────────────────────

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
