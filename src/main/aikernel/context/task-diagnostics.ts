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

import type { ChatContext } from '../messages.js';
import type { AutoCompactState } from '../compaction/auto-compact.js';
import type { MicrocompactState } from '../compaction/microcompact-state.js';
import type { ToolResultReplacementState } from '../compaction/tool-results.js';
import { inspectContextForDiagnostics } from './inspect.js';
import { analyzeContextDiagnostics } from './analyze.js';
import { generateContextSuggestions, type ContextSuggestion } from './suggestions.js';
import type { ContextDiagnosticsReport, ContextInspectOptions } from './types.js';

/**
 * 诊断所需的任务字段（结构化子集，TaskState 可直接赋值）。
 * 与 TUI /context 命令保持一致：GUI IPC handler 无需关心完整任务对象。
 */
export interface TaskContextDiagnosticsTask {
    readonly task_id: string;
    readonly parent_id: string | null;
    readonly chat_context: ChatContext;
    readonly auto_compact_state?: AutoCompactState;
    readonly tool_result_replacement_state?: ToolResultReplacementState;
    readonly microcompact_state?: MicrocompactState;
    ensureValidModelOrFallback(): string | undefined;
}

export interface TaskContextDiagnosticsResult {
    report: ContextDiagnosticsReport;
    suggestions: ContextSuggestion[];
}

/**
 * 复用 TUI /context 命令同款诊断管线，为 GUI 开发者模式生成上下文占比数据。
 * 只读：inspect 内部会克隆 ChatContext，不会写回任务状态。
 * inspectOptions 仅作为测试/高级调用方的覆盖入口，固定字段以本函数为准。
 */
export async function buildTaskContextDiagnostics(
    task: TaskContextDiagnosticsTask,
    fallbackModel?: string,
    inspectOptions?: ContextInspectOptions
): Promise<TaskContextDiagnosticsResult> {
    const model = task.ensureValidModelOrFallback() ?? fallbackModel;
    const inspection = await inspectContextForDiagnostics(task.chat_context, model, {
        ...inspectOptions,
        taskId: task.task_id,
        autoCompactState: task.auto_compact_state,
        toolResultReplacementState: task.tool_result_replacement_state,
        readonlyOnly: true,
        enableMicrocompact: false,
        enableSessionMemoryCompact: false,
        enableToolResultBudget: true,
        microcompactState: task.microcompact_state,
        microcompactRequestKind: 'view_only',
        microcompactTaskRole: task.parent_id === null ? 'main' : 'subtask'
    });

    const report = analyzeContextDiagnostics({
        chatContext: task.chat_context,
        inspection,
        modelName: model
    });
    const suggestions = generateContextSuggestions(report);
    return { report, suggestions };
}
