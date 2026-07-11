import { HookRegistry } from '../../hooks.js';
import type { AssistantMessage, ToolCall } from '../../messages.js';
import { logger } from '../../../utils/logger.js';

/** 单次 LLM 请求中允许的最大工具调用数量 */
const MAX_TOOLCALLS_PER_REQUEST = 10;

let registered = false;

export function registerDeadloopHarness(): void {
    if (registered) return;
    registered = true;

    HookRegistry.beforeToolcallCreated(async (task, assistantMessage, chunkHasNewToolCall) => {
        const toolcalls = collectToolCalls(assistantMessage);

        // 1. 工具调用数量限制：当前已有 >= MAX 个，且即将追加新工具调用时拒绝
        if (chunkHasNewToolCall && toolcalls.length >= MAX_TOOLCALLS_PER_REQUEST) {
            logger.warn(
                `task ${task.task_id}: tool call limit (${MAX_TOOLCALLS_PER_REQUEST}) reached, ` +
                    `rejecting new tool call from this request`
            );
            return {
                operation: 'reject',
                message: `tool call limit (${MAX_TOOLCALLS_PER_REQUEST}) reached`
            };
        }

        // 2. 重复工具调用检测：已解析的工具调用中是否存在 tool_name + args_string 完全相同的
        if (toolcalls.length >= 2) {
            const dupIndex = findDuplicateToolCallIndex(toolcalls);
            if (dupIndex >= 0) {
                const dup = toolcalls[dupIndex];
                logger.warn(
                    `task ${task.task_id}: duplicate tool call detected ` +
                        `(tool="${dup.tool_name}", index=${dupIndex})`
                );
                return {
                    operation: 'reject',
                    message: `duplicate tool call detected (tool="${dup.tool_name}")`
                };
            }
        }

        return { operation: 'accept' };
    });
}

function collectToolCalls(message: AssistantMessage): ToolCall[] {
    const result: ToolCall[] = [];
    const content = Array.isArray(message.content) ? message.content : [];
    for (const part of content) {
        if (part?.type === 'tool_call') {
            result.push(...(Array.isArray(part.toolcalls) ? part.toolcalls : []));
        }
    }
    return result;
}

function findDuplicateToolCallIndex(calls: ToolCall[]): number {
    for (let i = 1; i < calls.length; i++) {
        const current = calls[i];
        if (!current.tool_name) continue;
        const currentArgs = current.args_string ?? '';
        for (let j = 0; j < i; j++) {
            if (calls[j].tool_name === current.tool_name && (calls[j].args_string ?? '') === currentArgs) {
                return i;
            }
        }
    }
    return -1;
}
