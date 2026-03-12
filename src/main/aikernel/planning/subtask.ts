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
import { SystemMessage, ToolCallMessagePart, TextMessagePart } from '../messages.js';
import { logger } from '../../utils/logger.js';
import type { TaskState, TaskUpdateChunk } from '../../states/tasks.js';
import type { ToolCall } from '../messages.js';


// ─── Types ───────────────────────────────────────────────────────────────────

export interface SubTaskConfig {
    title: string;
    requirements: string;
    outputRequirements: string;
    isAsync: boolean;
    keepContext: boolean;
}

export interface SubTaskResult {
    success: boolean;
    result: string;
    subtask_id: string;
}

export interface SubTaskProgressInfo {
    tools: Array<{ name: string; status: string }>;
    lastText: string | null;
}

// ─── Pending async subtask tracking ──────────────────────────────────────────

export interface PendingSubTask {
    promise: Promise<SubTaskResult>;
    taskState?: TaskState;
}

export const pendingSubTasks = new Map<string, PendingSubTask>();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function safeSlice(input: string, maxLen: number): string {
    return input.length <= maxLen ? input : `${input.slice(0, maxLen)}...`;
}

function toShortTitle(input: string, maxChars = 10): string {
    const normalized = input
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
        .replace(/[\r\n]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!normalized) return '';
    const chars = Array.from(normalized);
    return chars.length > maxChars ? chars.slice(0, maxChars).join('') : normalized;
}

// ─── AttemptCompletionTool ───────────────────────────────────────────────────

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
        config.requirements,
        '',
        `## 输出要求`,
        config.outputRequirements,
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
    if (config.keepContext) {
        const inheritedPrompt = parentTask.chat_context.system_prompt?.content?.trim();
        const merged = inheritedPrompt
            ? [inheritedPrompt, '<subtask_contract>', subTaskPrompt, '</subtask_contract>'].join('\n\n')
            : subTaskPrompt;
        subTask.chat_context.system_prompt = new SystemMessage(merged);
    } else {
        subTask.chat_context.system_prompt = new SystemMessage(subTaskPrompt);
    }

    const parentToolNames = Array.from(parentTask.chat_context.getTools().keys());
    const allowlist = parentToolNames
        .filter(name => name !== 'planning-createSubTask' && name !== 'planning-waitSubTask');

    logger.info(
        `[subtask] created subtask=${subTask.task_id} parent=${parentTask.task_id} ` +
        `title="${config.title}" async=${config.isAsync} keepContext=${config.keepContext}`
    );

    onCreated?.(subTask);

    const progress: SubTaskProgressInfo = { tools: [], lastText: null };
    let lastProgressTime = 0;
    const progressCallback = (chunk: TaskUpdateChunk) => {
        extractSubTaskProgress(chunk, progress);
        const now = Date.now();
        if (onProgress && (now - lastProgressTime >= PROGRESS_THROTTLE_MS)) {
            lastProgressTime = now;
            onProgress({ tools: [...progress.tools], lastText: progress.lastText });
        }
    };

    try {
        await subTask.submitUserMessage(config.requirements);
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

// ─── Shared prompt for agents ────────────────────────────────────────────────

export const SUBTASK_MANAGEMENT_PROMPT = `
<task_management>
## 待办事项管理

当任务较为复杂，需要多个步骤组合完成，或者用户指定了多个任务的情况下，你应该使用 TodoWrite 工具先做好规划，再按步骤执行。

TodoWrite 工具使用说明：
- 该工具用于管理当前任务内的待办列表（会话级，不跨会话保存）
- 每次调用该工具时，必须传入完整的待办列表（这将替换当前所有待办）
- 状态：pending（待处理）、in_progress（进行中）、completed（已完成）
- 当你完成一个待办后，应该立即更新待办列表，将该待办标记为 completed
- 简单的单目标任务应当直接执行，不需要使用 TodoWrite
- 待办项应当以结果为导向，不要创建细碎的操作步骤
- 初始待办列表控制在 2-5 项，最多不超过 6 项，在执行过程中可以进行细化；

## 子任务管理

你可以使用 createSubTask 工具将待办事项委派给隔离的子任务执行器。

**核心原则**

1. 当待办列表中存在多个相互独立（无依赖关系）的任务时，你应当将它们作为异步子任务并行执行；
2. 当一个待办事项将会使用到大量中间步骤且对于最终结果没有贡献的时候（比如，通过创建大量外部脚本，然后执行脚本的方式来完成任务），
   你应当将它作为子任务执行；
3. 子任务的输入和输出都应当清晰明确，不依赖彼此结果；

适用场景举例：
- 多个独立的调研/信息收集任务（如"分别调研A、B、C三个方案"）
- 多个独立的文件操作或代码修改

子任务模式：
- 同步（isAsync=false）：createSubTask 等待子任务完成后直接返回结果，适合单个子任务
- 异步（isAsync=true）：createSubTask 立即返回子任务ID，稍后通过 waitSubTask 获取结果，适合并行

**并行执行模式（有多个独立任务时，你应当使用此模式）：**

1. 用 TodoWrite 创建待办列表
2. 识别其中可以并行执行的独立任务，为这些独立任务调用 createSubTask(isAsync=true)，启动异步子任务;
3. 识别其中有依赖，但是比较适合拆分独立执行的任务，为这些任务调用 createSubTask(isAsync=false)，串行执行;
4. 对于所有已经通过子任务来执行的待办事项，你应当把他们标记为执行中;
4. 调用 waitSubTask 逐一等待各子任务完成并收集结果;
5. 更新待办列表，基于子任务结果继续处理后续依赖项;

子任务约束：
- requirements 参数是子任务**唯一**能获取到的上下文，务必写得完整、具体
- 子任务通过 attemptCompletion 工具返回结果字符串
- 子任务不能嵌套创建子任务
</task_management>
`.trim();
