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

import { parseJsonWithRepair, repairJsonString } from '../../../utils/json.js';
import { logger } from '../../utils/logger.js';
import { BaseTool, BaseToolset } from '../tool.js';
import { AssistantMessage, ToolCall, tryExtractFirstJson } from '../messages.js';
import { SkillRegistry } from '../skill.js';
import { createMemoryToolset } from '../memory/tools.js';
import { createMainPlanningToolset, createSubTaskPlanningToolset } from '../planning/tools.js';
import { createTaskInfoToolset } from '../task/tools.js';
import type { TaskState } from '../states/tasks.js';

/**
 * 克隆工具集（浅拷贝：新 Map，复用同一批 tool 实例）。
 * 过滤逻辑会就地删除 tools 中的条目，为避免污染共享的单例工具集
 * （如 task.interactionToolset / entryToolset / skill 工具集），
 * 过滤前统一克隆，使被过滤掉的工具在后续 build 中仍能重新出现。
 */
function cloneToolset(toolset: BaseToolset): BaseToolset {
    const clone = new BaseToolset(toolset.name);
    for (const tool of toolset.tools.values()) {
        clone.addTool(tool);
    }
    return clone;
}

/**
 * 构建当前任务所需的全部 toolsets。
 * 主任务和子任务共享应用工具集与 skill 工具集，
 * 但 planning 工具集和 task-info 工具集仅主任务拥有。
 */
export async function buildToolsetsForTask(
    task: TaskState,
    interactionToolset?: BaseToolset | null
): Promise<BaseToolset[]> {
    const appToolsets = await task.task_manager_state.toolsetProvider.listAvailableToolsets(task);
    const skillToolset = SkillRegistry.getInstance().getToolset();
    const memoryToolset = createMemoryToolset();
    const planningToolset = task.parent_id ? createSubTaskPlanningToolset() : createMainPlanningToolset();

    const base = [...appToolsets, skillToolset, memoryToolset, planningToolset];
    if (task.parent_id === null) {
        base.push(createTaskInfoToolset(task.task_manager_state));
    }
    // 入口注入的额外工具集（workflow 完成协议、opencode/ACP 交互工具）始终挂载。
    if (task.entryToolset) {
        base.push(task.entryToolset);
    }
    // 交互工具集（askUser/exitPlanMode）仅在当前 turn 由用户交互发起时挂载。
    if (interactionToolset) {
        base.push(interactionToolset);
    }

    // 过滤会就地修改工具集，这里统一克隆，避免污染共享单例。
    const all = base.map(cloneToolset);

    await applyToolAvailabilityFilters(task, all);
    applyAgentToolExposureFilter(task, all);

    // Apply allowedTools whitelist filter (Agent level) — if set, only these tools are kept
    if (task.allowedTools && task.allowedTools.length > 0) {
        const allowed = new Set(task.allowedTools);
        for (const toolset of all) {
            for (const [name] of toolset.tools.entries()) {
                if (!allowed.has(name)) {
                    toolset.tools.delete(name);
                }
            }
        }
    }

    // Apply disabledTools blacklist filter (Mode + Agent level)
    if (task.disabledTools && task.disabledTools.length > 0) {
        const disabled = new Set(task.disabledTools);
        for (const toolset of all) {
            for (const [name] of toolset.tools.entries()) {
                if (disabled.has(name)) {
                    toolset.tools.delete(name);
                }
            }
        }
    }

    await task.hooks.applyAfterToolsetBuild({ toolsets: all, chat: task.chat_context, task });

    return all;
}

function applyAgentToolExposureFilter(task: TaskState, toolsets: BaseToolset[]): void {
    for (let i = toolsets.length - 1; i >= 0; i--) {
        const toolset = toolsets[i];
        for (const [name, tool] of [...toolset.tools.entries()]) {
            if (tool.agentIds !== undefined && (!task.agentId || !tool.agentIds.includes(task.agentId))) {
                toolset.tools.delete(name);
            }
        }
        if (toolset.tools.size === 0) {
            toolsets.splice(i, 1);
        }
    }
}

async function applyToolAvailabilityFilters(task: TaskState, toolsets: BaseToolset[]): Promise<void> {
    for (let i = toolsets.length - 1; i >= 0; i--) {
        const toolset = toolsets[i];
        for (const [name, tool] of [...toolset.tools.entries()]) {
            const available = await Promise.resolve(tool.isAvailable(task));
            if (!available) {
                toolset.tools.delete(name);
            }
        }
        if (toolset.tools.size === 0) {
            toolsets.splice(i, 1);
        }
    }
}

/**
 * 确保 chat_context 已挂载 toolsets，并为所有历史 ToolCall 解析 tool 引用。
 * 从硬盘加载任务后 toolsets 为空、ToolCall.tool 为 undefined，
 * 调用此方法后 CLI 自定义渲染器即可正常工作。
 */
export async function ensureToolsResolvedForTask(task: TaskState) {
    if (task.chat_context.toolsets.size === 0) {
        const allToolsets = await buildToolsetsForTask(task);
        task.chat_context.attachToolsets(...allToolsets);
    }
    resolveAllToolCallsForTask(task);
}

/**
 * 为历史消息中所有未绑定 tool 的 ToolCall 解析 tool 引用并解析 args_object。
 * 用于从硬盘加载任务后、在 toolsets 已挂载的前提下重新绑定工具，
 * 使 CLI 自定义渲染器能正常工作。
 */
export function resolveAllToolCallsForTask(task: TaskState) {
    for (const message of task.chat_context.messages) {
        if (!(message instanceof AssistantMessage)) continue;
        const content = Array.isArray(message.content) ? message.content : [];
        for (const part of content) {
            if (!part || part.type !== 'tool_call') continue;
            const toolcalls = Array.isArray(part.toolcalls) ? part.toolcalls : [];
            for (const tc of toolcalls) {
                if (!tc) continue;
                if (!tc.tool && tc.tool_name) {
                    const tool = task.chat_context.getTool(tc.tool_name);
                    if (tool) tc.setTool(tool);
                }
                if (tc.args_string && !tc.args_object) {
                    try {
                        tc.args_object = parseJsonWithRepair(tc.args_string);
                    } catch {
                        /* 解析失败不影响后续逻辑 */
                    }
                }
            }
        }
    }
}

/**
 * 在流式输出阶段提前解析 ToolCall 的 tool 引用和 args_object，
 * 使 CLI 自定义卡片能在参数生成过程中实时渲染。
 *
 * 注意：此方法在每个 chunk 到达时都会被调用，args_string 尚未完整，
 * 因此只做 best-effort 解析（jsonrepair），不做 partial object 检测——
 * partial object 检测由 finalizeToolCallArgs 在 args 确认完整后执行。
 */
export function resolveStreamingToolCallsForTask(task: TaskState, message: AssistantMessage) {
    const content = Array.isArray(message.content) ? message.content : [];
    for (const part of content) {
        if (!part || part.type !== 'tool_call') continue;
        const toolcalls = Array.isArray(part.toolcalls) ? part.toolcalls : [];
        for (const tc of toolcalls) {
            if (!tc) continue;
            // 已执行完成的工具调用不再重新解析 args_object，
            // 避免 sanitizeOutboundMessage 等后续修改 args_string 后覆盖正确的 args_object
            if (tc.status !== 'pending') continue;
            if (!tc.tool && tc.tool_name) {
                const tool = task.chat_context.getTool(tc.tool_name);
                if (tool) tc.setTool(tool);
            }
            if (tc.args_string) {
                try {
                    tc.args_object = parseJsonWithRepair(tc.args_string);
                } catch {
                    /* streaming 阶段 JSON 不完整属正常现象 */
                }
            }
        }
    }
}

/**
 * 检查一个 chunk（流式 delta）中是否包含带有新 id 的工具调用，
 * 即标志着一个全新工具调用开始（而非对已有调用的 args_string 续传）。
 */
export function chunkIntroducesNewToolCall(chunk: AssistantMessage, existingMessage?: AssistantMessage): boolean {
    const existingCalls = existingMessage ? collectToolCalls(existingMessage) : [];
    const content = Array.isArray(chunk.content) ? chunk.content : [];
    for (const part of content) {
        if (!part || part.type !== 'tool_call') continue;
        const toolcalls = Array.isArray(part.toolcalls) ? part.toolcalls : [];
        for (const tc of toolcalls) {
            if (!tc) continue;
            if (typeof tc.id === 'string' && tc.id.trim().length > 0) {
                if (existingCalls.some((existing) => existing.id === tc.id)) {
                    continue;
                }
                return true;
            }
        }
    }
    return false;
}

/**
 * 收集 assistant message 中所有 tool_call part 内的 ToolCall 引用（保持顺序）。
 */
export function collectToolCalls(message: AssistantMessage): ToolCall[] {
    const result: ToolCall[] = [];
    const content = Array.isArray(message.content) ? message.content : [];
    for (const part of content) {
        if (part?.type === 'tool_call') {
            result.push(...(Array.isArray(part.toolcalls) ? part.toolcalls : []));
        }
    }
    return result;
}

/**
 * 对已完成（args 不再增长）的 ToolCall 做最终的 args 解析。
 *
 * 解析策略：
 * 1. 先尝试原始 JSON.parse；
 * 2. 失败时检查 partial object（前半部分是完整 JSON，后半部分损坏），
 *    检测到则截取有效前缀并更新 args_string / args_object；
 * 3. 最后 fallback 到 jsonrepair。
 *
 * 成功时设置 args_object 并返回 true；失败时将 args_object 置为 undefined 并返回 false。
 */
export function finalizeToolCallArgs(tc: ToolCall): boolean {
    const raw = tc.args_string || '';
    if (raw.trim().length === 0) {
        return true;
    }
    try {
        tc.args_object = JSON.parse(raw);
        return true;
    } catch {
        // 检查 partial object：前半部分是完整 JSON，后半部分损坏
        const extracted = tryExtractFirstJson(raw);
        if (extracted) {
            logger.warn(
                `finalizeToolCallArgs: partial object detected for ` +
                    `"${tc.tool_name}" (id=${tc.id}), extracting valid JSON prefix`
            );
            tc.args_string = extracted;
            tc.args_object = JSON.parse(extracted);
            return true;
        }
        // fallback: jsonrepair
        try {
            const repaired = repairJsonString(raw);
            tc.args_object = JSON.parse(repaired);
            // 同步更新为修复后的合法 JSON，与 processToolCall 保持一致
            tc.args_string = repaired;
            return true;
        } catch {
            tc.args_object = undefined;
            return false;
        }
    }
}

/**
 * 从 assistant message 中移除从指定位置（flatIndex）开始的所有 toolcall。
 * flatIndex 为跨所有 tool_call part 的扁平索引。
 * 移除后如果某个 tool_call part 变空则也一并移除。
 */
export function removeToolCallsFrom(message: AssistantMessage, flatIndex: number): ToolCall[] {
    const removed: ToolCall[] = [];
    let idx = 0;
    const content = Array.isArray(message.content) ? message.content : [];
    for (let pi = 0; pi < content.length; pi++) {
        const part = content[pi];
        if (!part || part.type !== 'tool_call') continue;
        const startIdx = idx;
        const toolcalls = Array.isArray(part.toolcalls) ? part.toolcalls : [];
        idx += toolcalls.length;
        if (idx <= flatIndex) continue;
        // 此 part 有需要移除的 toolcall
        const removeFrom = Math.max(0, flatIndex - startIdx);
        removed.push(...toolcalls.splice(removeFrom));
        if (toolcalls.length === 0) {
            message.content.splice(pi, 1);
            content.splice(pi, 1);
            pi--;
        }
    }
    for (const tc of removed) {
        logger.info(`Removed malformed/trailing tool call "${tc.tool_name}" (id=${tc.id}) from stream output`);
    }
    return removed;
}

/**
 * 根据 tool_call 查找对应的 BaseTool 实例（不设置 tool_call 状态）
 */
export function resolveToolForCallForTask(task: TaskState, tool_call: ToolCall): BaseTool<any> | undefined {
    if (!tool_call.tool_name) {
        return undefined;
    }
    return task.chat_context.getTool(tool_call.tool_name);
}
