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
import { normalizeTaskUsageSummary } from '../../telemetry/local-telemetry.js';
import type { ReasoningEffort } from '../../utils/setting.js';
import { AgentRegistry } from '../agents/registry.js';
import { TaskState } from '../states/tasks.js';
import type { TaskManagerState } from './manager.js';
import { logger } from '../../utils/logger.js';
import { normalizeEvidenceCardState } from '../evidencecard/evidencecard.js';

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
        agentId: task.agentId ?? null,
        custom_system_prompt: task.custom_system_prompt ?? null,
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
        ...(task.name_pending ? { name_pending: true } : {}),
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
 * 将实时任务列表条目收缩为磁盘索引条目。
 * Renderer 需要完整 goal 摘要来实时刷新详情面板；冷启动索引只需要 status
 * 来渲染任务列表中的终态标签，避免把 objective、criteria、evaluation 等重复写入 task_list.json。
 */
export function normalizeTaskIndexEntry(entry: Record<string, unknown>): object {
    const { goal, ...metadata } = entry;
    if (goal === null || typeof goal !== 'object' || Array.isArray(goal)) {
        return metadata;
    }

    const status = (goal as Record<string, unknown>).status;
    return typeof status === 'string' ? { ...metadata, goal: { status } } : metadata;
}

/**
 * 序列化 TaskState 为 task_list.json 使用的轻量索引对象。
 */
export function serializeTaskForIndex(task: TaskState): object {
    return normalizeTaskIndexEntry(serializeTaskSimplified(task) as Record<string, unknown>);
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
 * 将 JSON 数据填充到已有的 TaskState 实例上（所有字段）。
 * 供 deserializeTask()（新建任务）和 loadFullTaskData()（懒加载补全）复用。
 */
function applyTaskJson(task: TaskState, task_json: any): void {
    task.task_id = task_json.task_id;
    task.parent_id = typeof task_json.parent_id === 'string' ? task_json.parent_id : null;
    task.task_name = typeof task_json.task_name === 'string' ? task_json.task_name : null;
    const wasRunningAtShutdown = task_json.task_status === 'running';
    task.task_status = task_json.task_status === 'running' ? 'failed' : task_json.task_status;
    task.internal = task_json.internal === true ? true : undefined;
    task.model = typeof task_json.model === 'string' ? task_json.model : undefined;
    task.reasoningEffort =
        typeof task_json.reasoningEffort === 'string' ? (task_json.reasoningEffort as ReasoningEffort) : undefined;
    task.agentId =
        typeof task_json.agentId === 'string'
            ? task_json.agentId
            : task_json.agentId === null
              ? undefined
              : AgentRegistry.getMainAgent().agentId;
    task.chat_context = ChatContext.assign(task_json.chat_context);
    task.restoreSystemPromptState(task_json.custom_system_prompt);
    // ⚠️ 顺序依赖：chat_context 赋值必须在 extensions.restore() 之前。
    // ensureLoaded() → loadFullTaskData() → applyTaskJson() 中 _loading=true，
    // chat_context getter 此时会跳过 ensureLoaded() 直接返回 _chat_context。
    // extensions.restore() 内部可能访问 chat_context，因此依赖 _chat_context 已就绪。
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
    task.started_at = coerceDate(task_json.started_at);
    task.finished_at = coerceDate(task_json.finished_at);
    task.updated_at = coerceDate(task_json.updated_at);
    task.total_elapsed_ms = typeof task_json.total_elapsed_ms === 'number' ? task_json.total_elapsed_ms : 0;
    task.bookmark_path = typeof task_json.bookmark_path === 'string' ? task_json.bookmark_path : undefined;
    task.stop_requested_by_user =
        typeof task_json.stop_requested_by_user === 'boolean' ? task_json.stop_requested_by_user : false;
    task.origin = task_json.origin ?? undefined;
    task.workspace = typeof task_json.workspace === 'string' ? task_json.workspace : undefined;
    task.workspaceID = typeof task_json.workspaceID === 'string' ? task_json.workspaceID : undefined;
    task.executionNodeId = typeof task_json.executionNodeId === 'string' ? task_json.executionNodeId : undefined;
    task.executionNodeLabel =
        typeof task_json.executionNodeLabel === 'string' ? task_json.executionNodeLabel : undefined;
    task._dirty = false;
    task.extensions.restore(task_json, wasRunningAtShutdown);
}

/**
 * 从 JSON 文件反序列化为 TaskState 实例（全量加载）。
 * 之前是 TaskState.load() 静态方法。
 */
export function deserializeTask(taskJsonPath: string, taskManagerState: TaskManagerState): TaskState {
    const task_json = JSON.parse(fs.readFileSync(taskJsonPath, 'utf8'));
    const task = new TaskState(taskManagerState, task_json.parent_id || null);
    applyTaskJson(task, task_json);
    return task;
}

/**
 * 在已有的 TaskState 上加载完整数据（用于懒加载补全）。
 * 读取完整任务 JSON 文件，填充 chat_context 等重字段。
 */
export function loadFullTaskData(task: TaskState, taskJsonPath: string): void {
    const task_json = JSON.parse(fs.readFileSync(taskJsonPath, 'utf8'));
    if (task_json.task_id !== task.task_id) {
        throw new Error(
            `task ID mismatch while loading ${taskJsonPath}: expected ${task.task_id}, got ${String(task_json.task_id)}`
        );
    }
    applyTaskJson(task, task_json);
}

/**
 * 从 task_list.json 索引条目创建轻量 TaskState（不含 chat_context 等重字段）。
 * 仅填充列表展示和启动恢复所需的元数据字段，完整数据延迟到 ensureLoaded() 时加载。
 *
 * @param indexEntry task_list.json 中的条目（serializeTaskSimplified 的输出）
 * @param taskFilePath 完整任务 JSON 文件路径（供后续 ensureLoaded 使用）
 * @param taskManagerState 所属 TaskManagerState
 */
export function deserializeTaskFromIndex(
    indexEntry: Record<string, unknown>,
    taskFilePath: string,
    taskManagerState: TaskManagerState
): TaskState {
    // ⚠️ 仅恢复列表展示所需的元数据字段（与 serializeTaskSimplified 输出对应）。
    // 以下字段在此处不恢复，延迟到 ensureLoaded() → loadFullTaskData() → applyTaskJson() 补全：
    //   chat_context, model, reasoningEffort, tool_result_replacement_state,
    //   auto_compact_state, microcompact_state, session_memory_state,
    //   benchmark_usage, extensions.restore()
    // 因此在 ensureLoaded() 之前通过 extensions getter 访问扩展状态会触发防御性加载。
    const task = new TaskState(taskManagerState, (indexEntry.parent_id as string) || null);
    task.task_id = indexEntry.task_id as string;
    task.task_name = (indexEntry.task_name as string) ?? null;
    // 与 deserializeTask 一致：running -> failed
    const rawStatus = indexEntry.task_status as string;
    task.task_status = (rawStatus === 'running' ? 'failed' : rawStatus) as TaskState['task_status'];
    if (indexEntry.internal === true) {
        task.internal = true;
    }
    task.created_at = indexEntry.created_at ? new Date(indexEntry.created_at as string) : new Date();
    if (indexEntry.started_at) {
        task.started_at = new Date(indexEntry.started_at as string);
    }
    if (indexEntry.finished_at) {
        task.finished_at = new Date(indexEntry.finished_at as string);
    }
    if (indexEntry.updated_at) {
        task.updated_at = new Date(indexEntry.updated_at as string);
    }
    if (typeof indexEntry.total_elapsed_ms === 'number') {
        task.total_elapsed_ms = indexEntry.total_elapsed_ms;
    }
    if (indexEntry.bookmark_path) {
        task.bookmark_path = indexEntry.bookmark_path as string;
    }
    if (typeof indexEntry.stop_requested_by_user === 'boolean') {
        task.stop_requested_by_user = indexEntry.stop_requested_by_user;
    }
    if (indexEntry.origin) {
        task.origin = indexEntry.origin as TaskState['origin'];
    }
    if (typeof indexEntry.workspace === 'string') {
        task.workspace = indexEntry.workspace;
    }
    if (typeof indexEntry.workspaceID === 'string') {
        task.workspaceID = indexEntry.workspaceID;
    }
    if (typeof indexEntry.executionNodeId === 'string') {
        task.executionNodeId = indexEntry.executionNodeId;
    }
    if (typeof indexEntry.executionNodeLabel === 'string') {
        task.executionNodeLabel = indexEntry.executionNodeLabel;
    }
    if (indexEntry.usage_summary) {
        task.usage_summary = indexEntry.usage_summary as TaskState['usage_summary'];
    }
    // 标记为懒加载：缓存简化 JSON 供 toSimplifiedJSON 直接返回，避免访问空 chat_context。
    // 缓存的 completion_status 等动态字段可能因 task_status 变化（running→failed）而不再准确，
    // 但侧边栏仅用 task_status 判断运行中/已停止，无需 completion_status；
    // 任务详情面板打开时走 getTask()→ensureLoaded()，toSimplifiedJSON 会动态重新计算所有字段。
    task._lazyFilePath = taskFilePath;
    task._lazySimplifiedJSON = { ...indexEntry, task_status: task.task_status };
    task._fullyLoaded = false;
    task._dirty = false;
    return task;
}

/**
 * 判断索引条目是否包含足够的元数据用于懒加载。
 * 旧格式（仅有 task_id）返回 false，需回退到全量加载。
 */
export function indexEntryHasMetadata(entry: Record<string, unknown>): boolean {
    return entry.task_status !== undefined && entry.created_at !== undefined;
}

// ═══════════════════ Fork ═══════════════════

export function forkTask(task: TaskState, upToMessageId?: string): TaskState {
    task.refreshEvidenceCardFeatureState();
    const forkedTask = new TaskState(task.task_manager_state, null);
    forkedTask.agentId = task.agentId;
    const toolResultReplacementState = task.getSynchronizedToolResultReplacementState();

    // Copy chat context via serialization
    forkedTask.chat_context = ChatContext.assign(task.chat_context.toJSON());

    // Truncate messages if upToMessageId is specified (fork from a specific point)
    if (upToMessageId) {
        const messages = forkedTask.chat_context.messages;
        const idx = messages.findIndex((m) => m.message_id === upToMessageId);
        if (idx >= 0) {
            messages.splice(idx + 1);
        }
    }
    forkedTask.tool_result_replacement_state = ToolResultReplacementStates.clone(toolResultReplacementState);
    forkedTask.auto_compact_state = AutoCompactStates.clone(task.auto_compact_state);
    forkedTask.microcompact_state = MicrocompactStates.create();
    // Step 8A 第一版不复制 session-memory.md，避免 fork 后指向父任务 artifact。
    forkedTask.session_memory_state = SessionMemoryStates.create();
    forkedTask.benchmark_usage = undefined;
    forkedTask.enableEvidenceCard = task.enableEvidenceCard;
    forkedTask.evidencecard_state = normalizeEvidenceCardState(task.evidencecard_state, task.enableEvidenceCard);

    // Copy model and reasoning effort
    forkedTask.model = task.model;
    forkedTask.reasoningEffort = task.reasoningEffort;

    // Set forked name with "-fork" suffix
    forkedTask.task_name = task.task_name ? `${task.task_name}-fork` : null;

    // Partial fork (from a specific message) creates a clean snapshot: stopped status, fresh timestamps
    if (upToMessageId) {
        forkedTask.task_status = 'stopped';
        forkedTask.started_at = undefined;
        forkedTask.finished_at = new Date();
        forkedTask.total_elapsed_ms = 0;
    } else {
        forkedTask.task_status = task.task_status;
        forkedTask.started_at = task.started_at;
        forkedTask.finished_at = task.finished_at;
        forkedTask.total_elapsed_ms = task.total_elapsed_ms;
    }
    forkedTask.internal = task.internal;

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
    forkedTask.restoreSystemPromptState(task.custom_system_prompt);
    forkedTask.disabledTools = task.disabledTools;
    task.extensions.prepareFork(forkedTask);

    // Add to task manager — forkedTask._dirty 默认 true，save 时会写入
    task.task_manager_state.tasks.push(forkedTask);
    task.task_manager_state.save();
    task.task_manager_state.publishTaskListUpdate();

    logger.info(`task ${task.task_id} forked to ${forkedTask.task_id}`);

    return forkedTask;
}
