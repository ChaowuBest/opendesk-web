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

import type { TaskState } from '../states/tasks.js';
import type { TextMessagePart } from '../messages.js';
import { AssistantMessage, UserMessage, ToolCall, ToolCallMessagePart, ErrorMessagePart } from '../messages.js';
import { HookRegistry } from '../hooks.js';
import { getTaskTodosForDisplay } from '../todos/task-todos.js';
import { checkTermination } from '../termination.js';
import { logger } from '../../utils/logger.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const MAIN_TASK_INCOMPLETE_TODOS_REMINDER = `你的待办列表中还有未完成的事项，请先完成所有待办事项（或将不再需要的待办标记为 completed）。`;

const SUBTASK_ENFORCE_ATTEMPT_COMPLETION_MESSAGE = `
请使用 planning-attemptCompletion 工具来结束当前对话回合。
无论任务成功、失败还是因缺少信息无法继续，都必须调用 planning-attemptCompletion 结束任务。
`.trim();

export const ATTEMPT_COMPLETION_TOOL_NAME = 'planning-attemptCompletion';

// ─── Helper Functions ─────────────────────────────────────────────────────────

/**
 * 从任务的消息历史中提取最后 N 条内容项（文本/工具调用摘要），
 * 用于在子任务被用户手动停止时向父任务提供上下文。
 */
function extractLastMessages(task: TaskState, count: number): string {
    const items: string[] = [];
    const messages = task.chat_context.messages;

    for (const msg of messages) {
        if (msg instanceof UserMessage) {
            for (const part of msg.content) {
                if (part.type === 'text') {
                    const text = (part as TextMessagePart).text;
                    items.push(`[用户] ${text.length > 200 ? text.slice(0, 200) + '...' : text}`);
                }
            }
        } else if (msg instanceof AssistantMessage) {
            for (const part of msg.content) {
                if (part.type === 'text') {
                    const text = (part as TextMessagePart).text;
                    items.push(`[助手] ${text.length > 200 ? text.slice(0, 200) + '...' : text}`);
                } else if (part.type === 'tool_call') {
                    for (const tc of (part as ToolCallMessagePart).toolcalls) {
                        const resultSnippet = tc.result ? `: ${tc.result.substring(0, 100)}` : '';
                        items.push(`[工具] ${tc.tool_name}(${tc.status})${resultSnippet}`);
                    }
                }
            }
        }
    }
    return items.slice(-count).join('\n');
}

/**
 * 为被用户手动停止的子任务追加一条合成的 attemptCompletion 工具调用，
 * 使子任务的结束方式在架构上与正常完成保持一致——始终通过 extractAttemptCompletionResult 提取结果。
 */
export async function appendSubTaskStopCompletion(subTask: TaskState): Promise<void> {
    const lastMessages = extractLastMessages(subTask, 5);
    const errorResult = `子任务被用户手动停止。\n\n子任务最后的消息记录:\n${lastMessages}`;

    let lastMessage = subTask.chat_context.lastMessage();
    if (!(lastMessage instanceof AssistantMessage)) {
        lastMessage = new AssistantMessage();
        subTask.chat_context.appendMessage(lastMessage);
    }

    const toolCall = new ToolCall(
        0,
        `stop_${crypto.randomUUID()}`,
        ATTEMPT_COMPLETION_TOOL_NAME,
        JSON.stringify({ type: 'fail', message: errorResult })
    );
    toolCall.args_object = { type: 'fail', message: errorResult };
    toolCall.status = 'success';
    toolCall.result = JSON.stringify({ accepted: true, type: 'fail' });

    const tool = subTask.chat_context.getTool(ATTEMPT_COMPLETION_TOOL_NAME);
    if (tool) toolCall.setTool(tool);
    await toolCall.freezeRenderResult();

    const toolCallPart = new ToolCallMessagePart();
    toolCallPart.push(toolCall);
    (lastMessage as AssistantMessage).content.push(toolCallPart);

    logger.info(`[subtask] appended synthetic stop attemptCompletion for subtask=${subTask.task_id}`);
}

// ─── Extract attemptCompletion Result ──────────────────────────────────────────

/**
 * 从任务的消息历史中提取 attemptCompletion 的结果（子任务专用）
 * 兼容新格式 (type/message) 和旧格式 (success/result)
 *
 * 注意：不检查 tc.status === 'success'，因为 stop() 在 handleExecute 内部被调用，
 * 会通过 _stopResolvers 立即唤醒父任务的 waitUntilFinished，而此时 processToolCall
 * 尚未将 tool_call.status 从 'running' 更新为 'success'（微任务排队顺序决定）。
 * args_object 在 tool.execute 之前就已被解析设置，因此可以安全使用。
 */
export function extractAttemptCompletionResult(
    task: TaskState
): { success: boolean; result: string; status?: 'success' | 'fail' | 'ask' } | null {
    const messages = task.chat_context.messages;
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (!(message instanceof AssistantMessage)) continue;
        for (const part of message.content) {
            if (part.type !== 'tool_call') continue;
            for (const tc of part.toolcalls) {
                if (tc.tool_name === ATTEMPT_COMPLETION_TOOL_NAME && tc.args_object) {
                    if ('type' in tc.args_object) {
                        return {
                            success: tc.args_object.type === 'success',
                            result: tc.args_object.message || '',
                            status: tc.args_object.type
                        };
                    }
                    return {
                        success: tc.args_object.success === true,
                        result: tc.args_object.result || ''
                    };
                }
            }
        }
    }
    return null;
}

/**
 * 检查任务的所有消息中是否调用过 attemptCompletion
 */
export function hasAttemptCompletion(task: TaskState): boolean {
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

/**
 * 检查任务的待办事项是否都已完成
 * 返回 null 表示没有待办事项或全部完成，否则返回未完成数量
 */
function getIncompleteTodoCount(task: TaskState): number | null {
    const todos = getTaskTodosForDisplay(task.task_id);
    if (todos.length === 0) return null;
    const incomplete = todos.filter((t) => t.status !== 'completed').length;
    return incomplete > 0 ? incomplete : null;
}

// ─── Error Part Detection & Synthetic Completion ──────────────────────────────

/**
 * 检查任务最后一条 AssistantMessage 中是否包含 ErrorMessagePart
 */
function getLastMessageErrorPart(task: TaskState): ErrorMessagePart | null {
    const messages = task.chat_context.messages;
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (!(message instanceof AssistantMessage)) continue;
        for (const part of message.content) {
            if (part.type === 'error') return part as ErrorMessagePart;
        }
        return null;
    }
    return null;
}

/**
 * 当检测到错误 part 时，自动追加一个合成的 fail 类型 attemptCompletion 工具调用，
 * 避免钩子反复要求 LLM 输出 attemptCompletion 导致死循环。
 */
async function appendSyntheticErrorAttemptCompletion(task: TaskState, errorPart: ErrorMessagePart): Promise<void> {
    let lastMessage = task.chat_context.lastMessage();
    if (!(lastMessage instanceof AssistantMessage)) {
        lastMessage = new AssistantMessage();
        task.chat_context.appendMessage(lastMessage);
    }

    const errorMessage = `${errorPart.title}: ${errorPart.message}`;
    const toolCall = new ToolCall(
        0,
        `err_${crypto.randomUUID()}`,
        ATTEMPT_COMPLETION_TOOL_NAME,
        JSON.stringify({ type: 'fail', message: errorMessage })
    );
    toolCall.args_object = { type: 'fail', message: errorMessage };
    toolCall.status = 'success';
    toolCall.result = JSON.stringify({ accepted: true, type: 'fail' });

    const tool = task.chat_context.getTool(ATTEMPT_COMPLETION_TOOL_NAME);
    if (tool) toolCall.setTool(tool);
    await toolCall.freezeRenderResult();

    const toolCallPart = new ToolCallMessagePart();
    toolCallPart.push(toolCall);
    (lastMessage as AssistantMessage).content.push(toolCallPart);

    logger.warn(`task ${task.task_id}: appended synthetic error attemptCompletion for error "${errorPart.title}"`);
}

// ─── Hook Registration ────────────────────────────────────────────────────────

/**
 * 为子任务注册 attemptCompletion 检查钩子（任务级钩子）
 * 在 turn 结束前检查是否已调用 attemptCompletion，如果没有则拒绝结束并提示
 */
export function registerSubTaskAttemptCompletionHook(subTask: TaskState): void {
    subTask.hooks.beforeFinishTurn(async (task) => {
        if (hasAttemptCompletion(task)) {
            return { operation: 'finish' };
        }
        if (task.stop_requested_by_user) {
            return { operation: 'finish' };
        }
        const errorPart = getLastMessageErrorPart(task);
        if (errorPart) {
            await appendSyntheticErrorAttemptCompletion(task, errorPart);
            return { operation: 'finish' };
        }
        return { operation: 'reject', message: SUBTASK_ENFORCE_ATTEMPT_COMPLETION_MESSAGE };
    });

    subTask.hooks.afterFinishTurn(async (task) => {
        if (task.stop_requested_by_user && !hasAttemptCompletion(task)) {
            await appendSubTaskStopCompletion(task);
        }
    });
}

/**
 * 注册主任务的 beforeFinishTurn 全局钩子
 * - 通过 checkTermination 判断对话是否异常中断
 * - 检查待办事项是否都已完成
 */
export function registerMainTaskTerminationHook(): void {
    HookRegistry.beforeFinishTurn(async (task) => {
        // 只处理主任务（没有 parent_id）
        if (task.parent_id !== null) {
            return { operation: 'finish' };
        }
        if (task.stop_requested_by_user) {
            return { operation: 'finish' };
        }

        // 检查最后一条消息是否包含错误 part，如果有则直接结束
        const errorPart = getLastMessageErrorPart(task);
        if (errorPart) {
            return { operation: 'finish' };
        }

        // 检查待办事项是否都已完成
        const incompleteTodos = getIncompleteTodoCount(task);
        if (incompleteTodos !== null) {
            return { operation: 'reject', message: MAIN_TASK_INCOMPLETE_TODOS_REMINDER };
        }

        // 通过 LLM 判断对话终止状态
        try {
            const terminationState = await checkTermination(task);
            if (terminationState === 'interrupted') {
                return { operation: 'reject', message: '请继续' };
            }
        } catch (err) {
            logger.warn(`checkTermination failed: ${err instanceof Error ? err.message : err}`);
        }

        return { operation: 'finish' };
    });
}

// ─── 注册全局钩子 ─────────────────────────────────────────────────────────────

registerMainTaskTerminationHook();
