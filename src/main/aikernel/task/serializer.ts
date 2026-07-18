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

import fs from 'fs';
import { ChatContext, UserMessage, AssistantMessage } from '../messages.js';
import { ToolResultReplacementStates, type ToolResultReplacementState } from '../compaction/tool-results.js';
import { AutoCompactStates } from '../compaction/auto-compact.js';
import { MicrocompactStates } from '../compaction/microcompact-state.js';
import { SessionMemoryStates } from '../compaction/session-memory-compact.js';
import { BenchmarkUsageLedger } from '../evaluation/index.js';
import { normalizeTaskUsageSummary } from '../telemetry/usage.js';
import type { ReasoningEffort } from '../../utils/setting.js';
import { TaskState } from '../states/tasks.js';
import type { TaskManagerState } from './manager.js';
import { logger } from '../../utils/logger.js';

// ═══════════════════ Helpers ═══════════════════

function coerceDate(value: unknown): Date | undefined {
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? undefined : value;
    }
    if (typeof value === 'string' || typeof value === 'number') {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? undefined : date;
    }
    return undefined;
}

function inferCreatedAt(taskJson: any, chatContext: ChatContext): Date {
    let earliestUserMessageDate: Date | undefined;
    for (const message of chatContext.messages) {
        if (!(message instanceof UserMessage)) {
            continue;
        }
        const timestamp = coerceDate(message.timestamp);
        if (!timestamp) {
            continue;
        }
        if (!earliestUserMessageDate || timestamp.getTime() < earliestUserMessageDate.getTime()) {
            earliestUserMessageDate = timestamp;
        }
    }
    return (
        earliestUserMessageDate ??
        coerceDate(taskJson.started_at) ??
        coerceDate(taskJson.updated_at) ??
        coerceDate(taskJson.finished_at) ??
        new Date()
    );
}

// ═══════════════════ Serialization ═══════════════════

/**
 * 序列化 TaskState 为完整 JSON 对象（用于持久化到磁盘）。
 * 之前是 TaskState.toJSON()，现在由 serializer 统一管理。
 */
export function serializeTask(task: TaskState): object {
    const toolResultReplacementState = task.getSynchronizedToolResultReplacementState();
    const benchmarkUsageLedger = task.benchmark_usage;
    const benchmarkTaskSummary =
        benchmarkUsageLedger && task.started_at && task.finished_at
            ? benchmarkUsageLedger.getTaskSummary({
                  taskStatus: task.task_status,
                  stopRequestedByUser: task.stop_requested_by_user,
                  startedAt: task.started_at,
                  finishedAt: task.finished_at,
                  totalElapsedMs: task.total_elapsed_ms
              })
            : undefined;
    return {
        ...task.extensions.serialize(),
        task_id: task.task_id,
        parent_id: task.parent_id,
        task_name: task.task_name,
        task_status: task.task_status,
        ...(task.internal === true ? { internal: true } : {}),
        model: task.model,
        reasoningEffort: task.reasoningEffort,
        chat_context: task.chat_context.toJSON(),
        tool_result_replacement_state: ToolResultReplacementStates.serialize(toolResultReplacementState),
        auto_compact_state: AutoCompactStates.serialize(task.auto_compact_state),
        microcompact_state: MicrocompactStates.serialize(task.microcompact_state),
        session_memory_state: SessionMemoryStates.serialize(task.session_memory_state),
        benchmark_usage: benchmarkUsageLedger?.toStorageJSON(benchmarkTaskSummary),
        usage_summary: task.usage_summary,
        created_at: task.created_at.toISOString(),
        started_at: task.started_at?.toISOString(),
        finished_at: task.finished_at?.toISOString(),
        updated_at: task.updated_at?.toISOString(),
        total_elapsed_ms: task.total_elapsed_ms,
        bookmark_path: task.bookmark_path,
        origin: task.origin,
        workspace: task.workspace,
        workspaceID: task.workspaceID,
        executionNodeId: task.executionNodeId,
        executionNodeLabel: task.executionNodeLabel,
        stop_requested_by_user: task.stop_requested_by_user
    };
}

/**
 * 序列化 TaskState 为简化 JSON 对象（用于任务列表显示）。
 * 之前是 TaskState.toSimplifiedJSON()。
 */
export function serializeTaskSimplified(task: TaskState): object {
    return {
        task_id: task.task_id,
        parent_id: task.parent_id,
        task_name: task.task_name,
        task_status: task.task_status,
        completion_status: task.getTaskCompletionStatus(),
        ...(task.internal === true ? { internal: true } : {}),
        created_at: task.created_at.toISOString(),
        started_at: task.started_at?.toISOString(),
        finished_at: task.finished_at?.toISOString(),
        updated_at: task.updated_at?.toISOString(),
        total_elapsed_ms: task.total_elapsed_ms,
        bookmark_path: task.bookmark_path,
        origin: task.origin,
        workspace: task.workspace,
        workspaceID: task.workspaceID,
        executionNodeId: task.executionNodeId,
        executionNodeLabel: task.executionNodeLabel,
        usage_summary: task.usage_summary,
        stop_requested_by_user: task.stop_requested_by_user,
        ...task.extensions.toSimplifiedJSON()
    };
}

/**
 * 序列化 TaskState 为渲染用 JSON 对象（仅前端渲染所需字段，不含大字段）。
 * 之前是 TaskState.toRenderJSON()。
 */
export function serializeTaskForRender(task: TaskState): object {
    return {
        task_id: task.task_id,
        task_name: task.task_name,
        task_status: task.task_status,
        ...(task.internal === true ? { internal: true } : {}),
        model: task.model,
        reasoningEffort: task.reasoningEffort,
        activeModeId: task.activeModeId,
        executionNodeId: task.executionNodeId,
        executionNodeLabel: task.executionNodeLabel,
        usage_summary: task.usage_summary,
        created_at: task.created_at.toISOString(),
        chat_context: task.chat_context.toRenderJSON(),
        workspace: task.getWorkspace() || '',
        workspaceID: task.workspaceID || '',
        ...task.extensions.toRenderJSON()
    };
}

// ═══════════════════ Deserialization ═══════════════════

/**
 * 从 JSON 文件反序列化为 TaskState 实例。
 * 之前是 TaskState.load() 静态方法。
 */
export function deserializeTask(taskJsonPath: string, taskManagerState: TaskManagerState): TaskState {
    const task_json = JSON.parse(fs.readFileSync(taskJsonPath, 'utf8'));
    const task = new TaskState(taskManagerState, task_json.parent_id || null);
    task.task_id = task_json.task_id;
    task.task_name = task_json.task_name;
    const wasRunningAtShutdown = task_json.task_status === 'running';
    task.task_status = task_json.task_status === 'running' ? 'failed' : task_json.task_status;
    if (typeof task_json.internal === 'boolean') {
        task.internal = task_json.internal;
    }
    if (typeof task_json.model === 'string') {
        task.model = task_json.model;
    }
    if (typeof task_json.reasoningEffort === 'string') {
        task.reasoningEffort = task_json.reasoningEffort as ReasoningEffort;
    }
    task.chat_context = ChatContext.assign(task_json.chat_context);
    if (wasRunningAtShutdown || task.task_status === 'stopped') {
        task.markInterruptedToolCalls('任务已停止');
    }
    task.tool_result_replacement_state = ToolResultReplacementStates.deserialize(
        task_json.tool_result_replacement_state,
        task.chat_context
    );
    task.auto_compact_state = AutoCompactStates.deserialize(task_json.auto_compact_state ?? task_json.autoCompactState);
    task.microcompact_state = MicrocompactStates.deserialize(
        task_json.microcompact_state ?? task_json.microcompactState
    );
    task.session_memory_state = SessionMemoryStates.deserialize(
        task_json.session_memory_state ?? task_json.sessionMemoryState
    );
    task.benchmark_usage = BenchmarkUsageLedger.deserialize(
        task_json.benchmark_usage ?? task_json.benchmarkUsage,
        task.task_id
    );
    task.usage_summary = normalizeTaskUsageSummary(task_json.usage_summary ?? task_json.usageSummary);
    task.created_at = coerceDate(task_json.created_at) ?? inferCreatedAt(task_json, task.chat_context);
    if (task_json.started_at) {
        task.started_at = new Date(task_json.started_at);
    }
    if (task_json.finished_at) {
        task.finished_at = new Date(task_json.finished_at);
    }
    if (task_json.updated_at) {
        task.updated_at = new Date(task_json.updated_at);
    }
    if (typeof task_json.total_elapsed_ms === 'number') {
        task.total_elapsed_ms = task_json.total_elapsed_ms;
    }
    if (task_json.bookmark_path) {
        task.bookmark_path = task_json.bookmark_path;
    }
    if (typeof task_json.stop_requested_by_user === 'boolean') {
        task.stop_requested_by_user = task_json.stop_requested_by_user;
    }
    if (task_json.origin) {
        task.origin = task_json.origin;
    }
    if (typeof task_json.workspace === 'string') {
        task.workspace = task_json.workspace;
    }
    if (typeof task_json.workspaceID === 'string') {
        task.workspaceID = task_json.workspaceID;
    }
    if (typeof task_json.executionNodeId === 'string') {
        task.executionNodeId = task_json.executionNodeId;
    }
    if (typeof task_json.executionNodeLabel === 'string') {
        task.executionNodeLabel = task_json.executionNodeLabel;
    }
    task._dirty = false;
    task.extensions.restore(task_json, wasRunningAtShutdown);
    return task;
}

// ═══════════════════ Fork ═══════════════════

export function forkTask(task: TaskState): TaskState {
    const forkedTask = new TaskState(task.task_manager_state, null);
    const toolResultReplacementState = task.getSynchronizedToolResultReplacementState();

    // Copy chat context via serialization
    forkedTask.chat_context = ChatContext.assign(task.chat_context.toJSON());
    forkedTask.tool_result_replacement_state = ToolResultReplacementStates.clone(toolResultReplacementState);
    forkedTask.auto_compact_state = AutoCompactStates.clone(task.auto_compact_state);
    forkedTask.microcompact_state = MicrocompactStates.create();
    // Step 8A 第一版不复制 session-memory.md，避免 fork 后指向父任务 artifact。
    forkedTask.session_memory_state = SessionMemoryStates.create();
    forkedTask.benchmark_usage = undefined;

    // Copy model and reasoning effort
    forkedTask.model = task.model;
    forkedTask.reasoningEffort = task.reasoningEffort;

    // Set forked name with "-fork" suffix
    forkedTask.task_name = task.task_name ? `${task.task_name}-fork` : null;

    // Copy task status (forked task should have the same status as the original)
    forkedTask.task_status = task.task_status;
    forkedTask.internal = task.internal;

    forkedTask.started_at = task.started_at;
    forkedTask.finished_at = task.finished_at;
    forkedTask.total_elapsed_ms = task.total_elapsed_ms;

    // harnessContext 不落盘但 fork 时复制环境变量和权限引擎（便于工具继续使用）
    forkedTask.harnessContext.environ = { ...task.harnessContext.environ };
    forkedTask.harnessContext.permission = task.harnessContext.permission;
    forkedTask.harnessContext.permissionPrompt = task.harnessContext.permissionPrompt;
    forkedTask.harnessContext.workspace = task.harnessContext.workspace;
    forkedTask.harnessContext.executionHost = task.harnessContext.executionHost;
    forkedTask.workspace = task.workspace;
    forkedTask.workspaceID = task.workspaceID;
    forkedTask.executionNodeId = task.executionNodeId;
    forkedTask.executionNodeLabel = task.executionNodeLabel;
    forkedTask.activeModeId = task.activeModeId;
    forkedTask.disabledTools = task.disabledTools;
    task.extensions.prepareFork(forkedTask);

    // Add to task manager — forkedTask._dirty 默认 true，save 时会写入
    task.task_manager_state.tasks.push(forkedTask);
    task.task_manager_state.save();
    task.task_manager_state.publishTaskListUpdate();

    logger.info(`task ${task.task_id} forked to ${forkedTask.task_id}`);

    return forkedTask;
}
