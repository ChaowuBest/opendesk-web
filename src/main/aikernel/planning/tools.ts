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
import { Card } from '../../tui/components/card.js';
import { statusDisplay, truncText } from '../../tui/components/toolcall.js';
import type { TaskState } from '../../states/tasks.js';
import type { ToolCall } from '../messages.js';
import {
    executeSubTask,
    pendingSubTasks,
    AttemptCompletionTool,
    type SubTaskConfig,
    type SubTaskResult,
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
            '创建并执行一个隔离的子任务。子任务拥有独立的工具集，通过 attemptCompletion 返回结果。同步模式等待完成，异步模式立即返回子任务ID。',
            CreateSubTaskArgsSchema
        );
        this.setExecutor(this.handleExecute.bind(this));
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
            return `
            <div class="flex mt-3 mb-3 text-sm items-center space-x-4 bg-white/80 backdrop-blur-md border border-slate-200 py-2 px-4 rounded-full shadow-sm w-fit">
                <span class="text-base">📋</span>
                <span class="font-semibold text-slate-600">子任务${asyncTag}</span>
                <div class="h-2 w-2 rounded-full bg-blue-500 animate-pulse ring-4 ring-blue-100/50"></div>
                <span class="text-slate-500 truncate max-w-xs">${title}</span>
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

    private async handleExecute(args: z.output<typeof CreateSubTaskArgsSchema>, taskState?: TaskState): Promise<string> {
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
            const promise = executeSubTask(taskState, config);
            const tempId = crypto.randomUUID();
            pendingSubTasks.set(tempId, promise);

            promise.then(result => {
                pendingSubTasks.delete(tempId);
                pendingSubTasks.set(result.subtask_id, Promise.resolve(result));
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
                return JSON.stringify({ subtask_id: earlyResult, async: true });
            }
            return JSON.stringify(earlyResult);
        }

        const result = await executeSubTask(taskState, config);
        return JSON.stringify(result);
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
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as z.output<typeof WaitSubTaskArgsSchema> | undefined;
        const body: string[] = [];

        if (args?.subtask_id) {
            body.push(chalk.dim('子任务ID: ') + chalk.cyan(truncText(args.subtask_id, width - 18)));
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
            return `
            <div class="flex mt-3 mb-3 text-sm items-center space-x-4 bg-white/80 backdrop-blur-md border border-slate-200 py-2 px-4 rounded-full shadow-sm w-fit">
                <span class="text-base">⏳</span>
                <span class="font-semibold text-slate-600">等待子任务</span>
                <div class="h-2 w-2 rounded-full bg-blue-500 animate-pulse ring-4 ring-blue-100/50"></div>
                <span class="text-slate-500">${idPreview}</span>
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

    private async handleExecute(args: z.output<typeof WaitSubTaskArgsSchema>, taskState?: TaskState): Promise<string> {
        if (!taskState) {
            throw new Error('waitSubTask requires task state');
        }

        const subtaskId = args.subtask_id;

        const pending = pendingSubTasks.get(subtaskId);
        if (pending) {
            const result = await pending;
            pendingSubTasks.delete(subtaskId);
            return JSON.stringify(result);
        }

        const subTask = taskState.task_manager_state.getTask(subtaskId);
        if (!subTask) {
            return JSON.stringify({
                success: false,
                result: `未找到子任务: ${subtaskId}`,
                subtask_id: subtaskId,
            } satisfies SubTaskResult);
        }

        if (subTask.completion_result) {
            return JSON.stringify({
                ...subTask.completion_result,
                subtask_id: subtaskId,
            } satisfies SubTaskResult);
        }

        await subTask.waitUntilFinished();

        if (subTask.completion_result) {
            return JSON.stringify({
                ...subTask.completion_result,
                subtask_id: subtaskId,
            } satisfies SubTaskResult);
        }

        return JSON.stringify({
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
