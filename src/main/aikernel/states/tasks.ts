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

import { ToolResultReplacementStates, type ToolResultReplacementState } from '../compaction/tool-results.js';
import { AutoCompactStates, type AutoCompactState } from '../compaction/auto-compact.js';
import { MicrocompactStates, type MicrocompactState } from '../compaction/microcompact-state.js';
import {
    SessionMemoryStates,
    shouldExtractSessionMemory,
    updateSessionMemoryFromChatContext,
    type SessionMemoryExtractionDecision,
    type SessionMemoryState,
    type SessionMemoryUpdateResult,
    type UpdateSessionMemoryOptions
} from '../compaction/session-memory-compact.js';
import {
    ChatContext,
    UserMessage,
    UserMessagePart,
    AssistantMessage,
    AssistantMessagePart,
    TextMessagePart,
    FileMessagePart,
    ImageMessagePart,
    SystemMessage,
    Usage,
    AssistantResponse,
    ToolCall,
    ToolCallMessagePart,
    ReasoningMessagePart,
    CompactSeparatorMessage,
    extractImagePaths,
    imageToDataUri,
    tryExtractFirstJson
} from '../messages.js';
import { prepareContextForModel } from '../compaction/pipeline.js';
import {
    describeActiveContextVariant,
    describeCompactPlanVariant,
    logCompactInfo
} from '../compaction/compact-trace.js';
import type { ActiveContextView, MicrocompactTaskRole } from '../compaction/types.js';
import { compactContext } from '../compact.js';
import { BaseTool, BaseToolset } from '../tool.js';
import { LLM, type LLMRequestOptions } from '../llm.js';
import { Setting, getTaskArtifactDirectory, getTaskDirectory, type ReasoningEffort } from '../../utils/setting.js';
import { lookupKnownContextSize, fetchContextSizeFromAPI } from '../../utils/model-context.js';
import { logger } from '../../utils/logger.js';
import { type ToolsetProvider, EmptyToolsetProvider } from '../tool.js';
import { jsonrepair } from 'jsonrepair';
import path from 'path';
import fs from 'fs';
import { SkillRegistry } from '../skill.js';
import { createMemoryToolset } from '../memory/tools.js';
import { createMainPlanningToolset, createSubTaskPlanningToolset } from '../planning/tools.js';
import { createTaskInfoToolset } from './tools.js';
import { FileReadStateCache } from './read-state.js';
import { TaskHooks } from '../hooks.js';
import type { Participant } from '../../plugins/types.js';
import { HarnessContext, type ExecutionHost } from '../security/harness.js';
import type {
    PermissionEnforcer,
    PermissionRequest,
    PermissionCheckResult,
    PermissionPromptProvider,
    PermissionPromptContext,
    PermissionRule,
    PermissionUserResponse
} from '../security/permission.js';
import { createResourcePath } from '../security/permission.js';
import { TaskProfiler } from '../profiler.js';
import { BenchmarkUsageLedger } from '../evaluation/index.js';
import { getPlatform } from '../../../platforms/base.js';
import type { AgentDecl, ModeDecl, TaskSkillExposure } from '../agents/common.js';
import { MainAgentDecl } from '../agents/main/agent.js';
import { AgentRegistry } from '../agents/registry.js';
import * as diff from 'diff';
import { assertAttachmentFilePathsSupported } from '../attachment-support.js';
import { parseAttachmentFile } from '../attachment-parser.js';

type TaskStatus = 'waiting' | 'running' | 'stopped';
type TaskCompletionStatus = 'success' | 'fail' | 'ask';
const ATTEMPT_COMPLETION_TOOL_NAME = 'planning-attemptCompletion';
type TaskModelRequestOptions = Pick<LLMRequestOptions, 'extraHeaders'>;

type TaskAwareTool = BaseTool<any> & {
    isAvailable?: (taskState?: TaskState) => boolean;
};

// ==================== Task Changes (for 变更 panel) ====================

export interface DiffLine {
    type: 'context' | 'added' | 'removed';
    oldNum?: number;
    newNum?: number;
    content: string;
}

export interface DiffHunk {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: DiffLine[];
}

export interface FileChangeEntry {
    toolName: string;
    hunks: DiffHunk[];
    addedLines: number;
    removedLines: number;
}

export interface FileChanges {
    filePath: string;
    totalAdded: number;
    totalRemoved: number;
    changes: FileChangeEntry[];
}

export interface TaskChangesResult {
    files: FileChanges[];
    totalFiles: number;
    totalAdded: number;
    totalRemoved: number;
}

interface FileChangeOperation {
    toolName: string;
    args: Record<string, unknown>;
    fallbackEntry: FileChangeEntry;
}

interface FileChangeGroup {
    displayPath: string;
    absolutePath: string;
    operations: FileChangeOperation[];
}

export interface TaskUpdateUserChunk {
    type: 'user';
    task_id: string;
    task_status: TaskStatus;
    message_id: string;
    last_part_index: number;
    last_part: UserMessagePart;
    /** 是否为该用户消息的最后一个 part */
    isLastPart?: boolean;
    rawText?: string;
    usage?: Usage;
    internal?: boolean;
    timestamp?: number;
}

export interface TaskUpdateAssistantChunk {
    type: 'assistant';
    task_id: string;
    task_status: TaskStatus;
    message_id: string;
    last_part_index: number;
    last_part: AssistantMessagePart;
    usage?: Usage;
}

export interface TaskUpdateAssistantReplaceChunk {
    type: 'assistant_replace';
    task_id: string;
    task_status: TaskStatus;
    message_id: string;
    parts: AssistantMessagePart[];
    usage?: Usage;
}

export interface TaskUpdateUserReplaceChunk {
    type: 'user_replace';
    task_id: string;
    task_status: TaskStatus;
    message_id: string;
    parts: UserMessagePart[];
    rawText?: string;
    internal?: boolean;
    timestamp?: number;
}

export interface TaskUpdateRetryChunk {
    type: 'retry';
    task_id: string;
    task_status: TaskStatus;
    attempt: number;
    delay_ms: number;
    next_retry_at: number;
    error_message: string;
    status: 'scheduled' | 'retrying' | 'cleared';
}

export type TaskUpdateChunk =
    | TaskUpdateUserChunk
    | TaskUpdateAssistantChunk
    | TaskUpdateUserReplaceChunk
    | TaskUpdateAssistantReplaceChunk
    | TaskUpdateRetryChunk;

export class BaseTaskUpdateSubscriber {
    subscription_id: string = crypto.randomUUID();

    /**
     * Whether this subscriber needs HTML-rendered content in update chunks.
     * ElectronTaskUpdateSubscriber sets this to true because the renderer
     * displays HTML. CallbackTaskUpdateSubscriber (used by waitUntilFinished)
     * leaves it false, avoiding unnecessary marked.parse() calls.
     */
    wantsHtmlRender: boolean = false;

    isAvailable() {
        return true;
    }

    send(_chunkUpdate: TaskUpdateChunk) {
        throw new Error('send not implemented');
    }
}

class CallbackTaskUpdateSubscriber extends BaseTaskUpdateSubscriber {
    callback: (chunkUpdate: TaskUpdateChunk) => void | Promise<void>;

    constructor(callback: (chunkUpdate: TaskUpdateChunk) => void | Promise<void>) {
        super();
        this.callback = callback;
    }

    send(chunkUpdate: TaskUpdateChunk) {
        try {
            const result = this.callback(chunkUpdate);
            if (result && typeof result.catch === 'function') {
                void result.catch((err) => {
                    logger.error(`task update subscriber callback failed: ${errorToMessage(err)}`);
                });
            }
        } catch (err) {
            logger.error(`task update subscriber callback failed: ${errorToMessage(err)}`);
        }
    }
}

/**
 * 生成短任务ID
 * 格式: task_时间戳8位_随机4字符
 * 示例: task_a1b2c3d4_x7yz
 *
 * 碰撞概率分析：
 * - 时间戳部分（8位36进制）：可覆盖约282年，不同毫秒必不同
 * - 随机部分（4位36进制）：约168万种可能
 * - 同一毫秒内创建任务的碰撞概率约1/168万
 */
function generateShortTaskId(): string {
    const timestamp = Date.now().toString(36).slice(-8);
    const random = Math.random().toString(36).slice(2, 6);
    return `task_${timestamp}_${random}`;
}

function errorToMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

const LLM_RETRY_MIN_DELAY_MS = 10_000;
const LLM_RETRY_MAX_DELAY_MS = 10 * 60 * 1000;

function getLLMRetryDelayMs(attempt: number): number {
    const exponent = Math.max(0, attempt - 1);
    return Math.min(LLM_RETRY_MIN_DELAY_MS * Math.pow(2, exponent), LLM_RETRY_MAX_DELAY_MS);
}

function getAssistantResponseError(response: AssistantResponse): Error | undefined {
    if (response.finish_reason !== 'error') {
        return undefined;
    }

    const errorPart = response.content.content.find((part) => part.type === 'error');
    if (errorPart?.type === 'error') {
        return new Error(errorPart.message || errorPart.title || 'LLM request failed');
    }
    return new Error('LLM request failed');
}

/**
 * 原子写入文件：先写入临时文件，再 rename 覆盖目标文件。
 * 防止进程崩溃时产生残缺/损坏的 JSON 文件。
 */
async function _atomicWriteFile(filePath: string, content: string): Promise<void> {
    const tmpPath = filePath + '.tmp';
    await fs.promises.writeFile(tmpPath, content, 'utf8');
    await fs.promises.rename(tmpPath, filePath);
}

function _atomicWriteFileSync(filePath: string, content: string): void {
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, content, { encoding: 'utf8' });
    fs.renameSync(tmpPath, filePath);
}

export class TaskState {
    task_id: string = generateShortTaskId();
    parent_id: string | null = null;
    task_name: string | null = null;
    task_status: TaskStatus = 'waiting';
    /** Internal tasks are hidden from normal GUI task lists unless developer mode is enabled. */
    internal?: boolean;
    private _chat_context: ChatContext = new ChatContext();
    private _unbindChatContextMessageAppend?: () => void;
    tool_result_replacement_state: ToolResultReplacementState = ToolResultReplacementStates.create();
    /** 自动压缩失败熔断状态，随 task JSON 持久化。 */
    auto_compact_state: AutoCompactState = AutoCompactStates.create();
    /** task-local microcompact 状态，供后续 Phase 3/5 策略与冷启动路径使用。 */
    microcompact_state: MicrocompactState = MicrocompactStates.create();
    /** task-local session memory 状态，文件位于 artifacts/<taskId>/session-memory/。 */
    session_memory_state: SessionMemoryState = SessionMemoryStates.create();
    private file_read_state = new FileReadStateCache();
    benchmark_usage?: BenchmarkUsageLedger;

    /**
     * 脏标记：标识本任务在当前进程中是否被修改过。
     * 仅被标记为脏的任务在 save 时才会写入磁盘，
     * 防止多进程同时运行时互相用过时的内存数据覆盖对方的任务文件。
     * 新创建的任务默认为 true（需要写入）；从磁盘加载的任务默认为 false。
     */
    _dirty: boolean = true;

    model?: string;
    reasoningEffort?: ReasoningEffort;
    message_queue: string[] = [];

    /**
     * 工程框架上下文：包含环境变量、权限等非聊天信息的外部约束。
     * 不参与序列化/持久化——其中的 environ 等字段可能包含敏感数据。
     */
    harnessContext: HarnessContext = HarnessContext.createEmpty();

    /**
     * 当前任务使用的运行模式 ID (如 'standard', 'plan', 'solo')。
     * 不参与序列化——Mode 在每次会话时由 TUI/GUI 设定。
     */
    activeModeId?: string;

    /**
     * 当前模式需要排除的工具名列表。
     * 不参与序列化——Mode 在每次会话时由 TUI/GUI 设定。
     */
    disabledTools?: string[];

    /**
     * 限定 system prompt 中向模型暴露的 Skill frontmatter。
     * 不参与序列化——仅用于批处理/分析类任务的临时上下文瘦身。
     */
    skillExposure?: TaskSkillExposure;

    /**
     * Mode 级别的工具白名单。非空时仅白名单内的工具可用。
     * 不参与序列化——由子任务 Agent 的 Mode 派发时设置。
     */
    allowedTools?: string[];

    stop_requested_by_user: boolean = false;
    started_at?: Date;
    finished_at?: Date;
    /** 最后更新时间：每次提交新消息时更新，用于任务列表按活跃度排序 */
    updated_at?: Date;
    total_elapsed_ms: number = 0;
    bookmark_path?: string;
    /** Task origin - set for channel-initiated tasks to identify the source channel */
    origin?: Participant;
    /** Server/API session workspace. Persisted because harnessContext is runtime-only. */
    workspace?: string;
    /** OpenCode experimental workspace id when a compatible TUI attaches one. */
    workspaceID?: string;
    /** Selected execution node for node-aware tools. Empty means local execution. */
    executionNodeId?: string;
    executionNodeLabel?: string;

    /** 性能分析器，当 CLI --profile 启用时创建 */
    profiler: TaskProfiler | null = null;

    /**
     * 可选的 interaction 工具集（仅主任务使用）。
     * 由 TUI/Electron 层在任务创建后注入，包含 askUser 等需要用户交互的工具。
     * buildToolsets() 会自动将其包含在工具列表中。
     */
    interactionToolset: BaseToolset | null = null;

    /** 任务钩子，用于在一系列任务控制点中执行回调函数 */
    hooks: TaskHooks = new TaskHooks();
    /** 订阅者，主要用于在 TUI/GUI 中获取任务状态更新等 */
    subscribers: BaseTaskUpdateSubscriber[] = [];
    /** 文本片段完成回调，用于 channel 增量发送 - 当一个文本片段生成结束时调用（下一个片段创建时） */
    onTextPartComplete?: (text: string) => void;
    /** 全局任务管理器的状态 */
    task_manager_state: TaskManagerState;
    /** stop() 被调用时直接 resolve 所有 waitUntilFinished 的等待者 */
    private _stopResolvers: (() => void)[] = [];
    /** 用户在 GUI 点击"立即重试"时 resolve，跳过 waitForLLMRetryDelay 的剩余等待 */
    private _retryNowResolver: (() => void) | null = null;
    /** LLM 重试等待窗口是否已经对前端可见 */
    private _retryDelayPending: boolean = false;
    /** 标记 processTaskTurn 是否正在运行，stop() 据此决定是否立即发送 feedback */
    private _turnRunning: boolean = false;
    /** Turn 代数计数器，用于防止旧 turn 的清理代码干扰 submitUserMessage 发起的新 turn。 */
    private _turnGeneration: number = 0;
    /** Step 8F: task-local session memory 后台更新锁，避免同一 task 并发抽取。 */
    private _sessionMemoryUpdatePromise?: Promise<SessionMemoryUpdateResult>;
    private _taskReviewTimer?: ReturnType<typeof setTimeout>;
    private _taskReviewGeneration: number = 0;
    private _taskReviewMessageCount: number = 0;
    private _taskReviewStartMessageIndex: number = 0;
    private _taskReviewActive: boolean = false;
    static TASK_REVIEW_IDLE_MS = 10 * 60 * 1000;

    get chat_context(): ChatContext {
        return this._chat_context;
    }

    set chat_context(chatContext: ChatContext) {
        if (this._chat_context === chatContext) {
            return;
        }
        this._unbindChatContextMessageAppend?.();
        this._chat_context = chatContext;
        this.bindChatContextMessageAppend();
        if (this._taskReviewActive) {
            this.recordTaskMessageActivityForReview();
        }
    }

    private ensureBenchmarkUsageLedger(): BenchmarkUsageLedger {
        if (!this.benchmark_usage) {
            this.benchmark_usage = new BenchmarkUsageLedger(this.task_id);
        }
        return this.benchmark_usage;
    }

    private resolveBenchmarkUsageModelInfo(): { model?: string; provider?: string } {
        try {
            if (this.model) {
                const modelInstance = Setting.getInstance().getModelInstance(this.model, 'chat');
                if (modelInstance) {
                    return {
                        model: modelInstance.model_name,
                        provider: modelInstance.provider_name
                    };
                }
                return { model: this.model };
            }

            const defaultModel = Setting.getInstance().getDefaultModelInstance();
            return {
                model: defaultModel.model_name,
                provider: defaultModel.provider_name
            };
        } catch {
            return this.model ? { model: this.model } : {};
        }
    }

    constructor(task_manager_state: TaskManagerState, parent_id: string | null = null) {
        this.task_manager_state = task_manager_state;
        this.parent_id = parent_id;
        this.bindChatContextMessageAppend();
    }

    private bindChatContextMessageAppend(): void {
        this._unbindChatContextMessageAppend = this._chat_context.onMessageAppend(() => {
            this.recordTaskMessageActivityForReview();
        });
    }

    /** 记录一次用户交互，使任务进入 onTaskReview 的空闲观察窗口。 */
    recordTaskInteraction(): void {
        this._taskReviewStartMessageIndex = this.chat_context.messages.length;
        this._taskReviewActive = true;
        this.recordTaskMessageActivityForReview();
    }

    private recordTaskMessageActivityForReview(): void {
        if (!this._taskReviewActive) {
            return;
        }
        this._taskReviewMessageCount = this.chat_context.messages.length;
        this.scheduleTaskReview();
    }

    private retainAvailableTaskUpdateSubscribers(context: string): void {
        this.subscribers = this.subscribers.filter((subscriber) => {
            try {
                return subscriber.isAvailable();
            } catch (err) {
                logger.error(
                    `task update subscriber availability check failed for ${context} (${subscriber.subscription_id}): ${errorToMessage(err)}`
                );
                return false;
            }
        });
    }

    private publishChunkUpdate(chunkUpdate: TaskUpdateChunk, context: string): void {
        for (const subscriber of this.subscribers) {
            try {
                subscriber.send(chunkUpdate);
            } catch (err) {
                logger.error(
                    `failed to publish ${context} to subscriber ${subscriber.subscription_id}: ${errorToMessage(err)}`
                );
            }
        }
    }

    private scheduleTaskReview(): void {
        this._taskReviewGeneration++;
        const generation = this._taskReviewGeneration;
        if (this._taskReviewTimer) {
            clearTimeout(this._taskReviewTimer);
        }
        this._taskReviewTimer = setTimeout(() => {
            this._taskReviewTimer = undefined;
            void this.fireTaskReviewIfIdle(generation).catch((err) => {
                logger.error(`task ${this.task_id}: onTaskReview hook failed: ${err}`);
            });
        }, TaskState.TASK_REVIEW_IDLE_MS);
        (this._taskReviewTimer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
    }

    private async fireTaskReviewIfIdle(generation: number): Promise<void> {
        if (!this._taskReviewActive || generation !== this._taskReviewGeneration) {
            return;
        }

        if (this.chat_context.messages.length !== this._taskReviewMessageCount) {
            this.recordTaskMessageActivityForReview();
            return;
        }

        this._taskReviewActive = false;
        this._taskReviewGeneration++;
        await this.hooks.noticeTaskReview(this, this._taskReviewStartMessageIndex);
    }

    cancelPendingTaskReview(): void {
        this._taskReviewActive = false;
        this._taskReviewGeneration++;
        if (this._taskReviewTimer) {
            clearTimeout(this._taskReviewTimer);
            this._taskReviewTimer = undefined;
        }
    }

    /**
     * 获取当前任务的工作空间路径。
     */
    getWorkspace(): string {
        return this.harnessContext?.workspace || this.workspace || '';
    }

    getExecutionHost(): ExecutionHost {
        return this.harnessContext?.executionHost ?? { type: 'local' };
    }

    /**
     * Task-local model aliases can outlive their config entry. In that case,
     * clear the override so subsequent LLM calls use the current global default.
     */
    ensureValidModelOrFallback(): string | undefined {
        if (!this.model) {
            return undefined;
        }

        const setting = Setting.getInstance();
        const data = setting.getData();
        if ((data.models ?? []).length === 0) {
            return this.model;
        }
        if (setting.getModelInstance(this.model, 'chat')) {
            return this.model;
        }

        const invalidModel = this.model;
        const defaultModel = data.default_model || '';
        const defaultAvailable = !!defaultModel && !!setting.getModelInstance(defaultModel, 'chat');
        this.model = undefined;
        if (this.task_manager_state.tasks.includes(this)) {
            this.persistLater();
        } else {
            this._dirty = true;
        }
        logger.warn(
            defaultAvailable
                ? `task ${this.task_id} model "${invalidModel}" not found, falling back to default model "${defaultModel}"`
                : `task ${this.task_id} model "${invalidModel}" not found, clearing task model override`
        );
        return undefined;
    }

    /**
     * 标记当前任务为脏并触发异步落盘。
     * TaskState 内部所有修改了持久化字段的路径都应调用此方法，而非直接 task_manager_state.save()。
     */
    persistLater(): void {
        this._dirty = true;
        this.task_manager_state.save();
    }

    static load(task_json_path: string, task_manager_state: TaskManagerState): TaskState {
        const task_json = JSON.parse(fs.readFileSync(task_json_path, 'utf8'));
        const task = new TaskState(task_manager_state, task_json.parent_id || null);
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
        task.auto_compact_state = AutoCompactStates.deserialize(
            task_json.auto_compact_state ?? task_json.autoCompactState
        );
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
        return task;
    }

    toSimplifiedJSON() {
        return {
            task_id: this.task_id,
            parent_id: this.parent_id,
            task_name: this.task_name,
            task_status: this.task_status,
            completion_status: this.getTaskCompletionStatus(),
            ...(this.internal === true ? { internal: true } : {}),
            started_at: this.started_at?.toISOString(),
            finished_at: this.finished_at?.toISOString(),
            updated_at: this.updated_at?.toISOString(),
            total_elapsed_ms: this.total_elapsed_ms,
            bookmark_path: this.bookmark_path,
            origin: this.origin,
            workspace: this.workspace,
            workspaceID: this.workspaceID,
            executionNodeId: this.executionNodeId,
            executionNodeLabel: this.executionNodeLabel,
            stop_requested_by_user: this.stop_requested_by_user
        };
    }

    getTaskCompletionStatus(): TaskCompletionStatus | null {
        const messages = this.chat_context.messages;
        for (let i = messages.length - 1; i >= 0; i--) {
            const message = messages[i];
            if (!(message instanceof AssistantMessage)) continue;
            const content = Array.isArray(message.content) ? message.content : [];
            for (let j = content.length - 1; j >= 0; j--) {
                const part = content[j];
                if (!part || part.type !== 'tool_call') continue;
                const toolcalls = Array.isArray(part.toolcalls) ? part.toolcalls : [];
                for (let k = toolcalls.length - 1; k >= 0; k--) {
                    const toolcall = toolcalls[k];
                    if (!toolcall) continue;
                    if (toolcall.tool_name !== ATTEMPT_COMPLETION_TOOL_NAME || !toolcall.args_object) continue;
                    const args = toolcall.args_object;
                    if (args.type === 'success' || args.type === 'fail' || args.type === 'ask') {
                        return args.type;
                    }
                    if ('success' in args) {
                        return args.success === true ? 'success' : 'fail';
                    }
                }
            }
        }
        return null;
    }

    toJSON() {
        const toolResultReplacementState = this.getSynchronizedToolResultReplacementState();
        const benchmarkUsageLedger = this.benchmark_usage;
        const benchmarkTaskSummary =
            benchmarkUsageLedger && this.started_at && this.finished_at
                ? benchmarkUsageLedger.getTaskSummary({
                      taskStatus: this.task_status,
                      stopRequestedByUser: this.stop_requested_by_user,
                      startedAt: this.started_at,
                      finishedAt: this.finished_at,
                      totalElapsedMs: this.total_elapsed_ms
                  })
                : undefined;
        return {
            task_id: this.task_id,
            parent_id: this.parent_id,
            task_name: this.task_name,
            task_status: this.task_status,
            ...(this.internal === true ? { internal: true } : {}),
            model: this.model,
            reasoningEffort: this.reasoningEffort,
            chat_context: this.chat_context.toJSON(),
            tool_result_replacement_state: ToolResultReplacementStates.serialize(toolResultReplacementState),
            auto_compact_state: AutoCompactStates.serialize(this.auto_compact_state),
            microcompact_state: MicrocompactStates.serialize(this.microcompact_state),
            session_memory_state: SessionMemoryStates.serialize(this.session_memory_state),
            benchmark_usage: benchmarkUsageLedger?.toStorageJSON(benchmarkTaskSummary),
            started_at: this.started_at?.toISOString(),
            finished_at: this.finished_at?.toISOString(),
            updated_at: this.updated_at?.toISOString(),
            total_elapsed_ms: this.total_elapsed_ms,
            bookmark_path: this.bookmark_path,
            origin: this.origin,
            workspace: this.workspace,
            workspaceID: this.workspaceID,
            executionNodeId: this.executionNodeId,
            executionNodeLabel: this.executionNodeLabel,
            stop_requested_by_user: this.stop_requested_by_user
        };
    }

    /** 仅包含前端渲染所需的字段（不含 args_string / result 等大字段） */
    toRenderJSON() {
        return {
            task_id: this.task_id,
            task_name: this.task_name,
            task_status: this.task_status,
            ...(this.internal === true ? { internal: true } : {}),
            model: this.model,
            reasoningEffort: this.reasoningEffort,
            activeModeId: this.activeModeId,
            executionNodeId: this.executionNodeId,
            executionNodeLabel: this.executionNodeLabel,
            chat_context: this.chat_context.toRenderJSON()
        };
    }

    getTaskChanges(): TaskChangesResult {
        // 文件修改工具名（短名称，不含 toolset 前缀）
        const FILE_MODIFY_TOOLS = new Set(['writeFile', 'editFile', 'searchReplace']);
        const fileMap = new Map<string, FileChangeGroup>();

        for (const message of this.chat_context.messages) {
            if (message.role !== 'assistant') continue;
            const assistantMsg = message as AssistantMessage;
            const content = Array.isArray(assistantMsg.content) ? assistantMsg.content : [];
            for (const part of content) {
                if (!part || part.type !== 'tool_call') continue;
                const tcPart = part as ToolCallMessagePart;
                const toolcalls = Array.isArray(tcPart.toolcalls) ? tcPart.toolcalls : [];
                for (const tc of toolcalls) {
                    if (!tc || typeof tc.tool_name !== 'string') continue;
                    // tc.tool_name 可能是完整限定名（如 "filemgr-writeFile"）或短名（"writeFile"）
                    const shortName = tc.tool_name.includes('-')
                        ? tc.tool_name.slice(tc.tool_name.lastIndexOf('-') + 1)
                        : tc.tool_name;
                    if (!FILE_MODIFY_TOOLS.has(shortName)) continue;
                    if (tc.status !== 'success') continue;

                    // 解析 args：优先使用 args_object，回退到解析 args_string
                    const args = this._resolveToolCallArgs(tc);
                    if (!args) continue;

                    const entry = this._computeFileChangeEntry(shortName, args);
                    if (!entry) continue;

                    // Determine file path from args
                    const filePath = (args as any).path || (args as any).filePath || '';
                    if (!filePath) continue;

                    const normalizedPath = this._normalizeChangeFilePath(String(filePath));
                    if (!fileMap.has(normalizedPath.absolutePath)) {
                        fileMap.set(normalizedPath.absolutePath, {
                            displayPath: normalizedPath.displayPath,
                            absolutePath: normalizedPath.absolutePath,
                            operations: []
                        });
                    }
                    fileMap.get(normalizedPath.absolutePath)!.operations.push({
                        toolName: shortName,
                        args,
                        fallbackEntry: entry
                    });
                }
            }
        }

        const files: FileChanges[] = [];
        let totalAdded = 0;
        let totalRemoved = 0;

        for (const group of fileMap.values()) {
            if (group.operations.length === 0) continue;

            const cumulative = this._computeCumulativeFileChange(group);
            if (cumulative === null) {
                continue;
            }

            const changes =
                cumulative !== undefined ? [cumulative] : [this._mergeFallbackEntriesAsCumulative(group.operations)];
            if (changes.length === 0) continue;

            let fileAdded = 0;
            let fileRemoved = 0;
            for (const change of changes) {
                fileAdded += change.addedLines;
                fileRemoved += change.removedLines;
            }
            files.push({
                filePath: group.displayPath,
                totalAdded: fileAdded,
                totalRemoved: fileRemoved,
                changes
            });
            totalAdded += fileAdded;
            totalRemoved += fileRemoved;
        }

        // Sort files by path for stable output
        files.sort((a, b) => a.filePath.localeCompare(b.filePath));

        return {
            files,
            totalFiles: files.length,
            totalAdded,
            totalRemoved
        };
    }

    /**
     * 解析工具调用参数：优先使用 args_object（内存中已解析），
     * 回退到解析 args_string（从磁盘加载的原始 JSON）。
     * 对压缩过的任务同样适用——compact 不会清除 args_string。
     */
    private _resolveToolCallArgs(tc: ToolCall): Record<string, unknown> | undefined {
        // 优先使用已解析的 args_object
        if (
            tc.args_object &&
            typeof tc.args_object === 'object' &&
            !Array.isArray(tc.args_object) &&
            Object.keys(tc.args_object).length > 0
        ) {
            return tc.args_object as Record<string, unknown>;
        }

        // 回退：从 args_string 解析
        if (typeof tc.args_string === 'string' && tc.args_string.trim().length > 0) {
            try {
                const parsed = JSON.parse(tc.args_string);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    return parsed as Record<string, unknown>;
                }
            } catch {
                // JSON 解析失败，可能是不完整的流式输出残留
            }
        }

        return undefined;
    }

    private _normalizeChangeFilePath(filePath: string): { displayPath: string; absolutePath: string } {
        const displayPath = filePath.replace(/\\/g, '/');
        const workspace = this.getWorkspace() || Setting.getInstance().getEffectiveWorkspace();
        const isAbsolute = path.isAbsolute(filePath) || path.win32.isAbsolute(filePath);
        const absolutePath = (isAbsolute ? filePath : path.resolve(workspace || process.cwd(), filePath)).replace(
            /\\/g,
            '/'
        );
        return { displayPath, absolutePath };
    }

    private _computeCumulativeFileChange(group: FileChangeGroup): FileChangeEntry | null | undefined {
        const finalContent = this._readChangeFileContent(group.absolutePath) ?? this._replayOperationsForward(group);
        if (finalContent === undefined) {
            return undefined;
        }

        let originalContent = finalContent;
        for (let i = group.operations.length - 1; i >= 0; i--) {
            const previousContent = this._reverseFileChangeOperation(originalContent, group.operations[i]);
            if (previousContent === undefined) {
                return undefined;
            }
            originalContent = previousContent;
        }

        if (originalContent === finalContent) {
            return null;
        }

        return this._buildDiffEntry('cumulative', originalContent, finalContent);
    }

    private _readChangeFileContent(filePath: string): string | undefined {
        try {
            if (!fs.existsSync(filePath)) {
                return undefined;
            }
            return fs.readFileSync(filePath, 'utf8');
        } catch {
            return undefined;
        }
    }

    private _replayOperationsForward(group: FileChangeGroup): string | undefined {
        let content: string | undefined;
        for (const operation of group.operations) {
            if (operation.toolName === 'writeFile') {
                const next = (operation.args as any).content;
                if (typeof next !== 'string') {
                    return undefined;
                }
                const mode = (operation.args as any).mode || 'overwrite';
                content = mode === 'append' ? (content ?? '') + next : next;
                continue;
            }

            const oldString = (operation.args as any).oldString;
            const newString = (operation.args as any).newString;
            if (typeof oldString !== 'string' || typeof newString !== 'string') {
                return undefined;
            }
            if (oldString === '') {
                content = newString;
                continue;
            }
            if (content === undefined) {
                return undefined;
            }
            const count = this._getReplacementLimit(operation);
            const replaced = this._replaceOccurrences(content, oldString, newString, count);
            if (replaced.count === 0) {
                return undefined;
            }
            content = replaced.content;
        }
        return content;
    }

    private _reverseFileChangeOperation(content: string, operation: FileChangeOperation): string | undefined {
        if (operation.toolName === 'writeFile') {
            const writtenContent = (operation.args as any).content;
            if (typeof writtenContent !== 'string') {
                return undefined;
            }
            const mode = (operation.args as any).mode || 'overwrite';
            if (mode === 'append') {
                if (content.endsWith(writtenContent)) {
                    return content.slice(0, content.length - writtenContent.length);
                }
                const idx = content.lastIndexOf(writtenContent);
                if (idx >= 0) {
                    return content.slice(0, idx) + content.slice(idx + writtenContent.length);
                }
                return undefined;
            }
            return '';
        }

        const oldString = (operation.args as any).oldString;
        const newString = (operation.args as any).newString;
        if (typeof oldString !== 'string' || typeof newString !== 'string') {
            return undefined;
        }
        if (oldString === '') {
            if (content === newString) {
                return '';
            }
            const replaced = this._replaceOccurrences(content, newString, '', 1);
            return replaced.count > 0 ? replaced.content : undefined;
        }
        if (newString === '') {
            return undefined;
        }

        const count = this._getReplacementLimit(operation);
        const replaced = this._replaceOccurrences(content, newString, oldString, count);
        if (replaced.count === 0) {
            return undefined;
        }
        return replaced.content;
    }

    private _getReplacementLimit(operation: FileChangeOperation): number {
        const raw = (operation.args as any).expectedReplacements;
        if (operation.toolName === 'editFile' && typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
            return Math.floor(raw);
        }
        return 1;
    }

    private _replaceOccurrences(
        input: string,
        search: string,
        replacement: string,
        limit: number
    ): { content: string; count: number } {
        if (search === '' || limit <= 0) {
            return { content: input, count: 0 };
        }

        let count = 0;
        let cursor = 0;
        let result = '';
        while (count < limit) {
            const idx = input.indexOf(search, cursor);
            if (idx === -1) {
                break;
            }
            result += input.slice(cursor, idx) + replacement;
            cursor = idx + search.length;
            count++;
        }
        if (count === 0) {
            return { content: input, count: 0 };
        }
        result += input.slice(cursor);
        return { content: result, count };
    }

    private _buildDiffEntry(toolName: string, oldContent: string, newContent: string): FileChangeEntry {
        const patch = diff.structuredPatch('', '', oldContent, newContent, '', '', {
            context: 3
        });
        const hunks: DiffHunk[] = [];
        let addedCount = 0;
        let removedCount = 0;

        for (const hunk of patch.hunks) {
            let oldNum = hunk.oldStart;
            let newNum = hunk.newStart;
            const lines: DiffLine[] = [];
            for (const rawLine of hunk.lines) {
                if (rawLine.startsWith('\\')) {
                    continue;
                }
                const op = rawLine[0];
                const content = rawLine.slice(1);
                if (op === '+') {
                    lines.push({ type: 'added', newNum, content });
                    newNum++;
                    addedCount++;
                } else if (op === '-') {
                    lines.push({ type: 'removed', oldNum, content });
                    oldNum++;
                    removedCount++;
                } else {
                    lines.push({ type: 'context', oldNum, newNum, content });
                    oldNum++;
                    newNum++;
                }
            }

            hunks.push({
                oldStart: hunk.oldStart,
                oldLines: hunk.oldLines,
                newStart: hunk.newStart,
                newLines: hunk.newLines,
                lines
            });
        }

        return {
            toolName,
            hunks,
            addedLines: addedCount,
            removedLines: removedCount
        };
    }

    private _mergeFallbackEntriesAsCumulative(operations: FileChangeOperation[]): FileChangeEntry {
        return {
            toolName: 'cumulative',
            hunks: operations.flatMap((operation) => operation.fallbackEntry.hunks),
            addedLines: operations.reduce((sum, operation) => sum + operation.fallbackEntry.addedLines, 0),
            removedLines: operations.reduce((sum, operation) => sum + operation.fallbackEntry.removedLines, 0)
        };
    }

    private _computeFileChangeEntry(toolName: string, args: Record<string, unknown>): FileChangeEntry | null {
        try {
            if (toolName === 'writeFile') {
                const content = (args as any).content;
                const mode = (args as any).mode || 'overwrite';
                if (typeof content !== 'string' || content.length === 0) return null;
                const lines = content.split('\n');
                const hunks: DiffHunk[] = [
                    {
                        oldStart: 0,
                        oldLines: 0,
                        newStart: 1,
                        newLines: lines.length,
                        lines: lines.map((line: string, i: number) => ({
                            type: 'added' as const,
                            newNum: i + 1,
                            content: line
                        }))
                    }
                ];
                return {
                    toolName: mode === 'append' ? 'writeFile (追加)' : 'writeFile (写入)',
                    hunks,
                    addedLines: lines.length,
                    removedLines: 0
                };
            }

            if (toolName === 'editFile' || toolName === 'searchReplace') {
                const oldString = (args as any).oldString;
                const newString = (args as any).newString;
                if (typeof oldString !== 'string' || typeof newString !== 'string') return null;
                if (oldString === '' && newString === '') return null;

                // For new file creation (oldString is empty), treat as writeFile
                if (oldString === '') {
                    const lines = newString.split('\n');
                    const hunks: DiffHunk[] = [
                        {
                            oldStart: 0,
                            oldLines: 0,
                            newStart: 1,
                            newLines: lines.length,
                            lines: lines.map((line: string, i: number) => ({
                                type: 'added' as const,
                                newNum: i + 1,
                                content: line
                            }))
                        }
                    ];
                    return {
                        toolName: toolName === 'editFile' ? 'editFile (新建)' : 'searchReplace (新建)',
                        hunks,
                        addedLines: lines.length,
                        removedLines: 0
                    };
                }

                // Compute diff between oldString and newString
                return this._buildDiffEntry(toolName, oldString, newString);
            }

            return null;
        } catch {
            return null;
        }
    }

    setSystemPrompt(prompt: string) {
        // logger.info(`setting system prompt ${prompt} to task ${this.task_id}`);
        this.chat_context.system_prompt = new SystemMessage(prompt);
    }

    /**
     * 向 chat_context 追加一条内部用户消息（用户不可见），并通知前端。
     */
    async appendInternalUserMessage(content: string): Promise<void> {
        const user_message = new UserMessage(content);
        user_message.internal = true;
        this.chat_context.appendMessage(user_message);
        await this.sendSubscriptionFeedback();
    }

    async rewindToUserMessage(
        messageId: string,
        options: { resubmit?: boolean } = {}
    ): Promise<{ removedCount: number; resubmitted: boolean }> {
        const idx = this.chat_context.messages.findIndex(
            (message) => message.role === 'user' && message.message_id === messageId
        );
        if (idx === -1) {
            throw new Error(`user message ${messageId} not found`);
        }

        const userMessage = this.chat_context.messages[idx] as UserMessage;
        const messageText = userMessage.rawText || userMessage.getPlainText();
        const imageDataUris = userMessage.content
            .filter((part): part is ImageMessagePart => part.type === 'image_url')
            .map((part) => part.image_url.url);
        const attachedFilePaths = userMessage.content
            .filter((part): part is FileMessagePart => part.type === 'file')
            .map((part) => part.path);

        if (this.task_status !== 'stopped') {
            this.stop('user');
        }

        const removedCount = this.chat_context.messages.length - idx;
        this.chat_context.messages.splice(idx);
        this.task_status = 'stopped';
        this.stop_requested_by_user = false;
        this.finished_at = new Date();
        this.persistLater();
        this.task_manager_state.publishTaskListUpdate();

        if (options.resubmit) {
            if (attachedFilePaths.length > 0) {
                await this.attachFiles(attachedFilePaths);
            }
            await this.submitUserMessage(messageText, imageDataUris);
        }

        return { removedCount, resubmitted: options.resubmit === true };
    }

    private getSynchronizedToolResultReplacementState(): ToolResultReplacementState {
        this.tool_result_replacement_state = ToolResultReplacementStates.synchronize(
            this.tool_result_replacement_state,
            this.chat_context
        );
        return this.tool_result_replacement_state;
    }

    getAutoCompactState(): AutoCompactState {
        return AutoCompactStates.clone(this.auto_compact_state);
    }

    setAutoCompactState(state: AutoCompactState) {
        this.auto_compact_state = AutoCompactStates.clone(state);
    }

    recordAutoCompactAttempt(at: Date = new Date()) {
        this.auto_compact_state = AutoCompactStates.recordAttempt(this.auto_compact_state, at);
        return this.auto_compact_state;
    }

    recordAutoCompactFailure(reason?: string, at: Date = new Date()) {
        this.auto_compact_state = AutoCompactStates.recordFailure(this.auto_compact_state, at, reason);
        return this.auto_compact_state;
    }

    recordAutoCompactSuccess(at: Date = new Date()) {
        this.auto_compact_state = AutoCompactStates.recordSuccess(this.auto_compact_state, at);
        return this.auto_compact_state;
    }

    resetAutoCompactState() {
        this.auto_compact_state = AutoCompactStates.create();
        return this.auto_compact_state;
    }

    getMicrocompactState(): MicrocompactState {
        return MicrocompactStates.clone(this.microcompact_state);
    }

    setMicrocompactState(state: MicrocompactState) {
        this.microcompact_state = MicrocompactStates.clone(state);
    }

    resetMicrocompactState() {
        this.microcompact_state = MicrocompactStates.create();
        return this.microcompact_state;
    }

    recordMicrocompactAssistantCompleted(at: Date = new Date()) {
        this.microcompact_state = MicrocompactStates.recordAssistantCompleted(this.microcompact_state, at);
        return this.microcompact_state;
    }

    getSessionMemoryState(): SessionMemoryState {
        return SessionMemoryStates.clone(this.session_memory_state);
    }

    setSessionMemoryState(state: SessionMemoryState) {
        this.session_memory_state = SessionMemoryStates.clone(state);
    }

    resetSessionMemoryState() {
        this.session_memory_state = SessionMemoryStates.create();
        return this.session_memory_state;
    }

    getFileReadState(): FileReadStateCache {
        return this.file_read_state;
    }

    resetFileReadState(): void {
        this.file_read_state = new FileReadStateCache();
    }

    private buildSkippedSessionMemoryUpdateResult(
        decision: SessionMemoryExtractionDecision
    ): SessionMemoryUpdateResult {
        return {
            updated: false,
            skipped: true,
            state: SessionMemoryStates.clone(this.session_memory_state),
            stateChanged: false,
            decision
        };
    }

    private saveSessionMemoryStateSafely() {
        try {
            this.persistLater();
        } catch (error) {
            logger.warn(
                `[Compact Step8F] failed to persist session memory state for task ${this.task_id}: ` +
                    errorToMessage(error)
            );
        }
    }

    private async runSessionMemoryUpdateAfterCompletion(
        options: UpdateSessionMemoryOptions,
        initialDecision: SessionMemoryExtractionDecision
    ): Promise<SessionMemoryUpdateResult> {
        try {
            const model = this.ensureValidModelOrFallback();
            logCompactInfo(this.task_id, {
                source: 'tasks',
                event: 'session_memory_update_starting',
                message:
                    `[Compact Step8F] session memory update starting for task ${this.task_id}: ` +
                    `reason=${initialDecision.reason}, tokens=${initialDecision.currentTokens}, ` +
                    `delta=${initialDecision.tokensSinceLastExtraction}, ` +
                    `toolCalls=${initialDecision.toolCallsSinceLastExtraction}`,
                data: {
                    reason: initialDecision.reason,
                    currentTokens: initialDecision.currentTokens,
                    tokensSinceLastExtraction: initialDecision.tokensSinceLastExtraction,
                    toolCallsSinceLastExtraction: initialDecision.toolCallsSinceLastExtraction
                }
            });

            const result = await updateSessionMemoryFromChatContext(
                this.chat_context,
                this.task_id,
                model,
                this.session_memory_state,
                options
            );

            this.setSessionMemoryState(result.state);
            if (result.stateChanged) {
                this.saveSessionMemoryStateSafely();
            }

            logCompactInfo(this.task_id, {
                source: 'tasks',
                event: 'session_memory_update_completed',
                message:
                    `[Compact Step8F] session memory update completed for task ${this.task_id}: ` +
                    `updated=${result.updated}, skipped=${result.skipped}, ` +
                    `reason=${result.decision.reason}, error=${result.error ?? 'none'}`,
                data: {
                    updated: result.updated,
                    skipped: result.skipped,
                    reason: result.decision.reason,
                    error: result.error ?? 'none'
                }
            });

            return result;
        } catch (error) {
            const failureState = SessionMemoryStates.recordExtractionFailure(this.session_memory_state, error);
            this.setSessionMemoryState(failureState);
            this.saveSessionMemoryStateSafely();

            const message = errorToMessage(error);
            logger.warn(`[Compact Step8F] session memory update failed for task ${this.task_id}: ${message}`);

            return {
                updated: false,
                skipped: false,
                state: failureState,
                stateChanged: true,
                decision: initialDecision,
                error: message
            };
        }
    }

    maybeUpdateSessionMemoryAfterCompletion(
        options: UpdateSessionMemoryOptions = {}
    ): Promise<SessionMemoryUpdateResult> {
        if (this._sessionMemoryUpdatePromise) {
            logCompactInfo(this.task_id, {
                source: 'tasks',
                event: 'session_memory_update_already_running',
                message: `[Compact Step8F] session memory update already running for task ${this.task_id}`
            });
            return this._sessionMemoryUpdatePromise;
        }

        const decision = shouldExtractSessionMemory(this.chat_context, this.session_memory_state, options);
        if (!options.force && !decision.shouldExtract) {
            logCompactInfo(this.task_id, {
                source: 'tasks',
                event: 'session_memory_update_skipped',
                message:
                    `[Compact Step8F] session memory update skipped for task ${this.task_id}: ` +
                    `reason=${decision.reason}, tokens=${decision.currentTokens}, ` +
                    `delta=${decision.tokensSinceLastExtraction}, ` +
                    `toolCalls=${decision.toolCallsSinceLastExtraction}`,
                data: {
                    reason: decision.reason,
                    currentTokens: decision.currentTokens,
                    tokensSinceLastExtraction: decision.tokensSinceLastExtraction,
                    toolCallsSinceLastExtraction: decision.toolCallsSinceLastExtraction
                }
            });
            return Promise.resolve(this.buildSkippedSessionMemoryUpdateResult(decision));
        }

        const updatePromise = this.runSessionMemoryUpdateAfterCompletion(options, decision);
        this._sessionMemoryUpdatePromise = updatePromise;
        void updatePromise.finally(() => {
            if (this._sessionMemoryUpdatePromise === updatePromise) {
                this._sessionMemoryUpdatePromise = undefined;
            }
        });

        return updatePromise;
    }

    private scheduleSessionMemoryUpdateAfterCompletion(modelRequestOptions?: TaskModelRequestOptions) {
        void this.maybeUpdateSessionMemoryAfterCompletion({ requestOptions: modelRequestOptions }).catch((error) => {
            logger.warn(
                `[Compact Step8F] unexpected session memory scheduler failure for task ${this.task_id}: ` +
                    errorToMessage(error)
            );
        });
    }

    isAutoCompactCoolingDown(at: Date = new Date()) {
        return AutoCompactStates.isCoolingDown(this.auto_compact_state, at);
    }

    getAutoCompactCooldownRemainingMs(at: Date = new Date()) {
        return AutoCompactStates.getCooldownRemainingMs(this.auto_compact_state, at);
    }

    hasAutoCompactReachedFailureThreshold() {
        return AutoCompactStates.hasReachedFailureThreshold(this.auto_compact_state);
    }

    async attachToolset(toolset: BaseToolset) {
        logger.info(`attaching toolset ${toolset.name} to task ${this.task_id}`);
        this.chat_context.toolsets.set(toolset.name, toolset);
    }

    async setExecutionHost(host: ExecutionHost): Promise<void> {
        this.harnessContext.executionHost = host;
        if (host.type === 'node') {
            this.executionNodeId = host.nodeId;
            this.executionNodeLabel = host.nodeLabel;
        } else {
            this.executionNodeId = undefined;
            this.executionNodeLabel = undefined;
        }
        this.persistLater();
        await this.refreshBaseToolsets();
    }

    private async refreshBaseToolsets(): Promise<void> {
        const allToolsets = await this.buildToolsets();
        for (const toolset of allToolsets) {
            this.chat_context.toolsets.set(toolset.name, toolset);
        }
        this.resolveAllToolCalls();
    }

    async attachFiles(filePaths: string[]) {
        if (filePaths.length === 0) {
            return;
        }
        assertAttachmentFilePathsSupported(filePaths);

        const user_message = new UserMessage();
        for (const filePath of filePaths) {
            const extname = path.extname(filePath);
            const content = await parseAttachmentFile(filePath);
            logger.info(`attach file ${filePath} to task ${this.task_id} with extension ${extname}`);
            // 获取文件大小和修改时间用于卡片展示
            let size: number | undefined;
            let modifiedTime: number | undefined;
            try {
                const stat = fs.statSync(filePath);
                size = stat.size;
                modifiedTime = stat.mtimeMs;
            } catch {
                // 如果无法获取 stat 信息，忽略
            }
            user_message.content.push(new FileMessagePart(filePath, content, size, modifiedTime));
        }

        this.chat_context.appendMessage(user_message);
    }

    /** 当 TUI 层已经执行过压缩时置 true，防止 submitUserMessage 重复压缩 */
    private _compactedBeforeSubmit = false;

    /** 标记外部已经完成一次压缩，submitUserMessage 应跳过自动压缩 */
    markCompacted() {
        this._compactedBeforeSubmit = true;
    }

    private getMicrocompactTaskRole(): MicrocompactTaskRole {
        return this.parent_id === null ? 'main' : 'subtask';
    }

    async manualCompact(): Promise<boolean> {
        const model = this.ensureValidModelOrFallback();
        const compacted = await compactContext(this.chat_context, model, {
            taskId: this.task_id
        });
        if (compacted) {
            this.clearFileReadStateAfterContextCompaction('manual_full_compact');
        }
        return compacted;
    }

    private clearFileReadStateAfterContextCompaction(reason: string): void {
        if (this.file_read_state.size === 0) {
            return;
        }

        const previousEntries = this.file_read_state.size;
        this.resetFileReadState();
        logCompactInfo(this.task_id, {
            source: 'tasks',
            event: 'file_read_state_cleared_after_compact',
            message: `[Compact] cleared file read state after ${reason}, entries=${previousEntries}`,
            data: {
                reason,
                previousEntries
            }
        });
    }

    /**
     * Submit a message to the task
     */
    async submitUserMessage(message: string, imageDataUris?: string[], modelRequestOptions?: TaskModelRequestOptions) {
        const model = this.ensureValidModelOrFallback();
        this.task_status = 'running';
        this.recordTaskInteraction();
        this.started_at = new Date();
        this.updated_at = new Date();
        this.stop_requested_by_user = false;
        this.finished_at = undefined;
        this.task_manager_state.moveTaskToEnd(this);
        this.persistLater();
        this.task_manager_state.publishTaskListUpdate();

        // 先构建用户消息并立即推送到前端，避免后续的 prepareContextForModel / replaceSlashSkills
        // 等耗时异步操作阻塞用户消息的显示
        const user_message = new UserMessage(message);

        const imagePaths = extractImagePaths(message);
        for (const imgPath of imagePaths) {
            try {
                const dataUri = imageToDataUri(imgPath);
                user_message.content.push(new ImageMessagePart(dataUri));
                logger.info(`attached image from message text: ${imgPath}`);
            } catch (err) {
                logger.warn(`failed to read image ${imgPath}: ${err}`);
            }
        }

        if (imageDataUris && imageDataUris.length > 0) {
            for (const dataUri of imageDataUris) {
                user_message.content.push(new ImageMessagePart(dataUri));
                logger.info(`attached pasted image (data URI, ${Math.round(dataUri.length / 1024)}KB)`);
            }
        }

        this.chat_context.appendMessage(user_message);
        for (let i = 0; i < user_message.content.length; i++) {
            await this.sendSubscriptionFeedback(i);
        }

        // 在追加新消息后检查是否需要自动压缩上下文（TUI 层可能已经做过，此处为 GUI 等场景的兜底）
        if (this._compactedBeforeSubmit) {
            this._compactedBeforeSubmit = false;
        } else {
            try {
                const preparation = await prepareContextForModel(this.chat_context, model, {
                    beforeCompact: () => {
                        logCompactInfo(this.task_id, {
                            source: 'tasks',
                            event: 'auto_compacting_context',
                            message: `Auto-compacting context for task ${this.task_id}`
                        });
                    },
                    enableSessionMemoryCompact: true,
                    autoCompactState: this.auto_compact_state,
                    microcompactState: this.microcompact_state,
                    microcompactRequestKind: 'pre_submit_check',
                    microcompactTaskRole: this.getMicrocompactTaskRole(),
                    sessionMemoryState: this.session_memory_state,
                    taskId: this.task_id,
                    requestOptions: modelRequestOptions
                });
                if (preparation.autoCompactState) {
                    this.setAutoCompactState(preparation.autoCompactState);
                }
                if (preparation.microcompactState) {
                    this.setMicrocompactState(preparation.microcompactState);
                }
                if (preparation.sessionMemoryState) {
                    this.setSessionMemoryState(preparation.sessionMemoryState);
                }
                if (preparation.compacted) {
                    this.clearFileReadStateAfterContextCompaction(
                        preparation.sessionMemoryCompacted ? 'session_memory_compact' : 'full_compact'
                    );
                }
            } catch (err: unknown) {
                logger.warn(`Auto-compact check failed: ${err instanceof Error ? err.message : err}`);
            }
        }

        // 检测用户消息中的 /skillname，替换文本（用户消息已经显示，如果有替换则更新显示）
        const displayMessage = await this.replaceSlashSkillsInText(message);

        // 如果文本被替换了，保留原始输入并更新显示文本，重新推送到前端
        if (displayMessage !== message) {
            user_message.rawText = message;
            const textPart = user_message.content.find((p) => p.type === 'text') as TextMessagePart | undefined;
            if (textPart) {
                textPart.text = displayMessage;
                textPart.invalidateRender();
            }
            // 文本被 slash skill 替换后需要重新推送用户消息到前端以更新显示
            await this.sendUserMessageReplace(user_message);
        }

        const assistant_message = new AssistantMessage();
        this.chat_context.appendMessage(assistant_message);

        const allToolsets = await this.buildToolsets();
        this.chat_context.attachToolsets(...allToolsets);

        // 检测用户消息中的 /skillname 引用并预加载到 assistant message
        await this.preloadSlashSkills(message, assistant_message);

        // 预加载产生的 parts 需要立即推送到前端，否则后续流式更新的 part_index 与 DOM 不同步
        for (let i = 0; i < assistant_message.content.length; i++) {
            await this.sendSubscriptionFeedback(i);
        }

        logger.info(`messsage submitted to task ${this.task_id}`);

        if (this.task_name === null) {
            this.task_name = '未命名任务';
            this.generateTaskName(message, modelRequestOptions).then(() => {
                this.persistLater();
                this.task_manager_state.publishTaskListUpdate();
            });
        }

        this.processTaskTurn(++this._turnGeneration, modelRequestOptions);
    }

    /**
     * Clean up the task resources (delete JSON file and artifacts)
     * Imported from tasks.js
     * [修改: 增加 cleanup 方法，支持清理物理文件和 Artifacts 记录]
     */
    cleanup() {
        this.cancelPendingTaskReview();
        const taskDirectory = getTaskDirectory();
        const taskArtifactDirectory = getTaskArtifactDirectory(this.task_id, false);

        // 1. Delete task JSON configuration
        const taskJsonPath = path.join(taskDirectory, `${this.task_id}.json`);
        if (fs.existsSync(taskJsonPath)) {
            try {
                fs.unlinkSync(taskJsonPath);
            } catch (err) {
                logger.error(`Failed to delete task file ${taskJsonPath}: ${(err as Error).message}`);
            }
        }

        // 2. Delete task-scoped artifacts under artifacts/<taskId>/
        if (fs.existsSync(taskArtifactDirectory)) {
            try {
                fs.rmSync(taskArtifactDirectory, { recursive: true, force: true });
            } catch (err) {
                logger.error(
                    `Failed to cleanup task artifact directory ${taskArtifactDirectory}: ${(err as Error).message}`
                );
            }
        }

        // 3. Compatibility cleanup for older task-scoped artifacts under tasks/artifacts/
        const legacyArtifactsDir = path.join(taskDirectory, 'artifacts');
        if (fs.existsSync(legacyArtifactsDir)) {
            try {
                const entries = fs.readdirSync(legacyArtifactsDir);
                for (const entry of entries) {
                    if (!entry.startsWith(`${this.task_id}_`)) {
                        continue;
                    }
                    fs.rmSync(path.join(legacyArtifactsDir, entry), { recursive: true, force: true });
                }
            } catch (err) {
                logger.error(`Failed to cleanup legacy artifacts for task ${this.task_id}: ${(err as Error).message}`);
            }
        }
    }
    /**
     * Stop the task execution
     */
    stop(reason: 'user' | 'system' = 'user') {
        if (this.task_status === 'stopped') {
            return;
        }
        this.task_status = 'stopped';
        this.stop_requested_by_user = reason === 'user';
        this.finished_at = new Date();
        logger.info(`task ${this.task_id} stopped (reason=${reason})`);
        this.harnessContext.permissionPrompt?.cancelTaskPrompts?.([this.task_id]);
        this.markInterruptedToolCalls('任务已停止');
        // 清除 LLM 重试等待状态，防止 tick 在 task_status 被 submitUserMessage
        // 改回 'running' 后继续发送 scheduled 状态
        this._retryDelayPending = false;

        for (const task of this.task_manager_state.tasks) {
            if (task.parent_id === this.task_id && task.task_status !== 'stopped') {
                task.stop(reason);
            }
        }

        for (const resolver of this._stopResolvers) {
            resolver();
        }
        this._stopResolvers = [];

        if (!this._turnRunning) {
            this.sendSubscriptionFeedback();
        }
        this.persistLater();
        this.task_manager_state.publishTaskListUpdate();
    }

    private markInterruptedToolCalls(result: string): number {
        let changed = 0;
        for (const message of this.chat_context.messages) {
            if (!(message instanceof AssistantMessage)) {
                continue;
            }
            const content = Array.isArray(message.content) ? message.content : [];
            for (const part of content) {
                if (!(part instanceof ToolCallMessagePart)) {
                    continue;
                }
                let partChanged = false;
                const toolcalls = Array.isArray(part.toolcalls) ? part.toolcalls : [];
                for (const toolCall of toolcalls) {
                    if (!toolCall) continue;
                    if (toolCall.status !== 'pending' && toolCall.status !== 'running') {
                        continue;
                    }
                    toolCall.status = 'error';
                    toolCall.result = result;
                    toolCall.result_object = { interrupted: true, reason: 'task_stopped' };
                    toolCall.rendered = undefined;
                    partChanged = true;
                    changed++;
                }
                if (partChanged) {
                    part.rendered = undefined;
                }
            }
        }
        return changed;
    }

    /**
     * 当前任务是否正处在 LLM 自动重试的等待窗口内。
     */
    isLLMRetryDelayPending(): boolean {
        return this._retryDelayPending && this.task_status === 'running';
    }

    /**
     * 跳过 LLM 重试的等待时间，立即发起下一次重试。
     * 从 GUI "立即重试" 按钮或 TUI /retry 命令触发。
     */
    skipRetryDelay(): boolean {
        if (this._retryNowResolver) {
            logger.info(`task ${this.task_id}: user requested immediate retry`);
            this._retryNowResolver();
            this._retryNowResolver = null;
            return true;
        }
        return false;
    }

    /**
     * Wait until task_status is no longer 'running' or 'waiting'.
     *
     * @param callback  每次收到更新 chunk 时的回调
     * @param resolveOnStop  如果为 true，当 stop() 被调用时立即 resolve（用于父任务等待子任务完成的场景）；
     *                       默认 false，则等待 processTaskTurn 正常结束后通过 sendSubscriptionFeedback 触发 resolve。
     */
    async waitUntilFinished(
        callback?: (updateChunk: TaskUpdateChunk) => void | Promise<void>,
        resolveOnStop: boolean = false
    ): Promise<void> {
        const activeStatuses: TaskStatus[] = ['running', 'waiting'];
        if (!activeStatuses.includes(this.task_status)) {
            return;
        }
        return new Promise<void>((resolve) => {
            let settled = false;
            const settle = () => {
                if (settled) return;
                settled = true;
                this.removeSubscriber(subscriber.subscription_id);
                resolve();
            };

            if (resolveOnStop) {
                this._stopResolvers.push(settle);
            }

            const subscriber = new CallbackTaskUpdateSubscriber((chunkUpdate: TaskUpdateChunk) => {
                try {
                    return callback?.(chunkUpdate);
                } finally {
                    if (!activeStatuses.includes(chunkUpdate.task_status)) {
                        settle();
                    }
                }
            });
            this.addSubscriber(subscriber);
        });
    }

    /**
     * 从用户消息中提取 /skillname 引用，逐一查找并预加载到 assistant message 中。
     * 未找到的 skill name 静默忽略（不报错）。
     */
    /**
     * 将用户消息中匹配到的 /skillName 替换为 [技能: skillName](directory) 标签。
     * 在消息 append 到 chat_context 之前调用，确保渲染时已经是替换后的文本。
     */
    private async replaceSlashSkillsInText(message: string): Promise<string> {
        const skillNamePattern = /(?:^|\s)\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?=\s|$)/g;
        const matchedNames = new Set<string>();
        let match: RegExpExecArray | null;
        while ((match = skillNamePattern.exec(message)) !== null) {
            matchedNames.add(match[1]);
        }
        if (matchedNames.size === 0) return message;

        const registry = SkillRegistry.getInstance();
        const allSkills = await registry.getAllSkillsFlat();

        let updatedMessage = message;
        for (const name of matchedNames) {
            const entry = allSkills.find((e) => e.skill.frontmatter.name === name && e.skill.isUserInvocable);
            if (!entry) continue;

            try {
                const loadedSkill = await registry.getSkill(entry.bundleName, name);
                if (!loadedSkill) continue;

                const directory = loadedSkill.directory || entry.bundleName;
                const slashPattern = new RegExp(`(^|\\s)\\/${name.replace(/-/g, '\\-')}(?=\\s|$)`, 'g');
                updatedMessage = updatedMessage.replace(slashPattern, `$1[技能: ${name}](${directory})`);
            } catch {
                // skill 加载失败时不替换
            }
        }
        return updatedMessage;
    }

    private async preloadSlashSkills(message: string, assistantMessage: AssistantMessage) {
        // 提取消息中所有 /skillname 模式（skill name 规则: 小写字母、数字、连字符）
        const skillNamePattern = /(?:^|\s)\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?=\s|$)/g;
        const matchedNames = new Set<string>();
        let match: RegExpExecArray | null;
        while ((match = skillNamePattern.exec(message)) !== null) {
            matchedNames.add(match[1]);
        }
        if (matchedNames.size === 0) return;

        const registry = SkillRegistry.getInstance();
        const allSkills = await registry.getAllSkillsFlat();

        for (const name of matchedNames) {
            // 查找 user-invocable 的 skill
            const entry = allSkills.find((e) => e.skill.frontmatter.name === name && e.skill.isUserInvocable);
            if (!entry) continue;

            const { bundleName } = entry;
            try {
                const loadedSkill = await registry.getSkill(bundleName, name);
                if (!loadedSkill) continue;

                // 将 skill 的 .env 环境变量合并到当前 task 的 harnessContext.environ
                if (loadedSkill.env && Object.keys(loadedSkill.env).length > 0) {
                    Object.assign(this.harnessContext.environ, loadedSkill.env);
                    logger.info(
                        `preloaded skill ${name} env merged to task harnessContext.environ: ${Object.keys(loadedSkill.env).join(', ')}`
                    );
                }

                const fullContent = loadedSkill.getFullContent();

                const qualifiedToolName = 'skill-manager-LoadSkill';
                const toolCall = new ToolCall(
                    0,
                    `preload_${crypto.randomUUID()}`,
                    qualifiedToolName,
                    JSON.stringify({ bundleName, skillName: name })
                );
                toolCall.args_object = { bundleName, skillName: name };
                toolCall.status = 'success';
                toolCall.result = fullContent;

                const loadSkillTool = this.chat_context.getTool(qualifiedToolName);
                if (loadSkillTool) toolCall.setTool(loadSkillTool);

                const toolCallPart = new ToolCallMessagePart();
                toolCallPart.push(toolCall);
                assistantMessage.content.push(
                    new ReasoningMessagePart(`User requested skill "${name}", loading it now.`, 'reasoning_content')
                );
                assistantMessage.content.push(toolCallPart);

                logger.info(`preloaded skill via /skillname: ${bundleName}/${name}`);
            } catch (err) {
                logger.warn(`failed to preload skill ${name}: ${err}`);
            }
        }
    }

    async generateTaskName(user_message: string, modelRequestOptions?: TaskModelRequestOptions) {
        const model = this.ensureValidModelOrFallback();
        const prompt = `
        你是一个任务管理助手，请根据以下用户消息生成一个任务名称: ${user_message}
        请输出一个简洁明了的任务名称，不要超过10个字符。不要包含任何其他内容。
        `;

        const output = await LLM.ask(prompt.trim(), model, {
            reasoningEffort: 'none',
            ...modelRequestOptions
        }).catch((err) => {
            logger.error(err);
            return null;
        });

        if (output) {
            const lines = output.trim().split('\n');
            if (lines.length > 0) {
                this.task_name = lines[lines.length - 1].trim();
            }
        }
    }

    /**
     * Rename the task
     * @param name the new name for the task
     */
    rename(name: string) {
        this.task_name = name;
        this.persistLater();
        this.task_manager_state.publishTaskListUpdate();
        logger.info(`task ${this.task_id} renamed to "${name}"`);
    }

    markAsInternal(): void {
        if (this.internal !== true) {
            this.internal = true;
            this.persistLater();
        }
        this.task_manager_state.publishTaskListUpdate();
    }

    /**
     * Fork the current task to create a copy with a new task_id
     * The forked task's name will have "-fork" suffix
     * @returns the forked task
     */
    fork(): TaskState {
        const forkedTask = new TaskState(this.task_manager_state, null);
        const toolResultReplacementState = this.getSynchronizedToolResultReplacementState();

        // Copy chat context via serialization
        forkedTask.chat_context = ChatContext.assign(this.chat_context.toJSON());
        forkedTask.tool_result_replacement_state = ToolResultReplacementStates.clone(toolResultReplacementState);
        forkedTask.auto_compact_state = AutoCompactStates.clone(this.auto_compact_state);
        forkedTask.microcompact_state = MicrocompactStates.create();
        // Step 8A 第一版不复制 session-memory.md，避免 fork 后指向父任务 artifact。
        forkedTask.session_memory_state = SessionMemoryStates.create();
        forkedTask.benchmark_usage = undefined;

        // Copy model and reasoning effort
        forkedTask.model = this.model;
        forkedTask.reasoningEffort = this.reasoningEffort;

        // Set forked name with "-fork" suffix
        forkedTask.task_name = this.task_name ? `${this.task_name}-fork` : null;

        // Copy task status (forked task should have the same status as the original)
        forkedTask.task_status = this.task_status;
        forkedTask.internal = this.internal;

        forkedTask.started_at = this.started_at;
        forkedTask.finished_at = this.finished_at;
        forkedTask.total_elapsed_ms = this.total_elapsed_ms;

        // harnessContext 不落盘但 fork 时复制环境变量和权限引擎（便于工具继续使用）
        forkedTask.harnessContext.environ = { ...this.harnessContext.environ };
        forkedTask.harnessContext.permission = this.harnessContext.permission;
        forkedTask.harnessContext.permissionPrompt = this.harnessContext.permissionPrompt;
        forkedTask.harnessContext.workspace = this.harnessContext.workspace;
        forkedTask.harnessContext.executionHost = this.harnessContext.executionHost;
        forkedTask.workspace = this.workspace;
        forkedTask.workspaceID = this.workspaceID;
        forkedTask.executionNodeId = this.executionNodeId;
        forkedTask.executionNodeLabel = this.executionNodeLabel;
        forkedTask.activeModeId = this.activeModeId;
        forkedTask.disabledTools = this.disabledTools;

        // Add to task manager — forkedTask._dirty 默认 true，save 时会写入
        this.task_manager_state.tasks.push(forkedTask);
        this.task_manager_state.save();
        this.task_manager_state.publishTaskListUpdate();

        logger.info(`task ${this.task_id} forked to ${forkedTask.task_id}`);

        return forkedTask;
    }

    /**
     * Set bookmark path for the task
     * @param path the bookmark path, "/" for root, or unix-style path like "/folder/subfolder"
     */
    setBookmark(path: string) {
        this.bookmark_path = path;
        this.persistLater();
        this.task_manager_state.publishTaskListUpdate();
        logger.info(`task ${this.task_id} bookmark set to "${path}"`);
    }

    /**
     * Remove bookmark from the task
     */
    removeBookmark() {
        this.bookmark_path = undefined;
        this.persistLater();
        this.task_manager_state.publishTaskListUpdate();
        logger.info(`task ${this.task_id} bookmark removed`);
    }

    /**
     * 向前端的订阅者发布任务状态更新，如果指定了part_index，则只更新该part
     * 否则更新最后一个 part。根据最后一条消息类型发送 UserChunk 或 AssistantChunk。
     */
    async sendSubscriptionFeedback(part_index: number | undefined = undefined) {
        const last_message = this.chat_context.lastMessage();
        if (last_message === undefined) {
            return;
        }

        this.retainAvailableTaskUpdateSubscribers('subscription feedback');
        if (this.subscribers.length === 0) return;

        const needsHtmlRender =
            getPlatform().getName() === 'electron' && this.subscribers.some((s) => s.wantsHtmlRender);

        try {
            let chunkUpdate: TaskUpdateChunk;
            if (last_message instanceof UserMessage) {
                const content = Array.isArray(last_message.content) ? last_message.content : [];
                if (content.length === 0) return;
                const updated_part_index = part_index !== undefined ? part_index : content.length - 1;
                const last_part = content[updated_part_index];
                if (last_part === undefined) {
                    logger.warn(
                        `sendSubscriptionFeedback: user part_index ${updated_part_index} out of bounds for last_message.content.length ${content.length}`
                    );
                    return;
                }
                if (needsHtmlRender) {
                    await last_message.render();
                }
                chunkUpdate = {
                    type: 'user',
                    task_id: this.task_id,
                    task_status: this.task_status,
                    message_id: last_message.message_id,
                    last_part_index: updated_part_index,
                    last_part: last_part,
                    isLastPart: updated_part_index === content.length - 1,
                    rawText: last_message.rawText,
                    internal: last_message.internal,
                    timestamp: last_message.timestamp
                };
            } else if (last_message instanceof AssistantMessage) {
                const content = Array.isArray(last_message.content) ? last_message.content : [];
                if (content.length === 0) return;
                const updated_part_index = part_index !== undefined ? part_index : content.length - 1;
                const last_part = content[updated_part_index];
                if (last_part === undefined) {
                    logger.warn(
                        `sendSubscriptionFeedback: part_index ${updated_part_index} out of bounds for last_message.content.length ${content.length}`
                    );
                    return;
                }
                if (needsHtmlRender) {
                    await last_part.render();
                }
                chunkUpdate = {
                    type: 'assistant',
                    task_id: this.task_id,
                    task_status: this.task_status,
                    message_id: last_message.message_id,
                    last_part_index: updated_part_index,
                    last_part: last_part,
                    usage: last_message.usage
                };
            } else if (last_message instanceof CompactSeparatorMessage) {
                return;
            } else {
                logger.warn(
                    `unexpected last message type in sendSubscriptionFeedback: ${(last_message as { role?: string }).role}`
                );
                return;
            }

            this.publishChunkUpdate(chunkUpdate, 'subscription feedback');
        } catch (err) {
            logger.error(`error sending subscription feedback for task ${this.task_id}: ${errorToMessage(err)}`);
        }
    }

    /**
     * 向前端推送用户消息的完整替换更新（用于 slash skill 替换文本后重新渲染整条消息）
     */
    async sendUserMessageReplace(userMessage: UserMessage) {
        this.retainAvailableTaskUpdateSubscribers('user message replace');
        if (this.subscribers.length === 0) return;

        const needsHtmlRender =
            getPlatform().getName() === 'electron' && this.subscribers.some((s) => s.wantsHtmlRender);
        try {
            if (needsHtmlRender) {
                await userMessage.render();
            }
            const chunkUpdate: TaskUpdateUserReplaceChunk = {
                type: 'user_replace',
                task_id: this.task_id,
                task_status: this.task_status,
                message_id: userMessage.message_id,
                parts: Array.isArray(userMessage.content) ? [...userMessage.content] : [],
                rawText: userMessage.rawText,
                internal: userMessage.internal,
                timestamp: userMessage.timestamp
            };
            this.publishChunkUpdate(chunkUpdate, 'user message replace');
        } catch (err) {
            logger.error(`error sending user message replace for task ${this.task_id}: ${errorToMessage(err)}`);
        }
    }

    async sendAssistantMessageReplace(assistantMessage: AssistantMessage) {
        this.retainAvailableTaskUpdateSubscribers('assistant message replace');
        if (this.subscribers.length === 0) return;

        const needsHtmlRender =
            getPlatform().getName() === 'electron' && this.subscribers.some((s) => s.wantsHtmlRender);
        try {
            if (needsHtmlRender) {
                await assistantMessage.render();
            }
            const chunkUpdate: TaskUpdateAssistantReplaceChunk = {
                type: 'assistant_replace',
                task_id: this.task_id,
                task_status: this.task_status,
                message_id: assistantMessage.message_id,
                parts: Array.isArray(assistantMessage.content) ? [...assistantMessage.content] : [],
                usage: assistantMessage.usage
            };
            this.publishChunkUpdate(chunkUpdate, 'assistant message replace');
        } catch (err) {
            logger.error(`error sending assistant message replace for task ${this.task_id}: ${errorToMessage(err)}`);
        }
    }

    async sendRetryFeedback(update: Omit<TaskUpdateRetryChunk, 'type' | 'task_id' | 'task_status'>) {
        this.retainAvailableTaskUpdateSubscribers('retry feedback');
        if (this.subscribers.length === 0) return;

        const chunkUpdate: TaskUpdateRetryChunk = {
            type: 'retry',
            task_id: this.task_id,
            task_status: this.task_status,
            ...update
        };

        this.publishChunkUpdate(chunkUpdate, 'retry feedback');
    }

    private async waitForLLMRetryDelay(attempt: number, delayMs: number, error: unknown): Promise<boolean> {
        const nextRetryAt = Date.now() + delayMs;
        const errorMessage = errorToMessage(error);
        this._retryDelayPending = true;
        const emitScheduled = () =>
            this.sendRetryFeedback({
                attempt,
                delay_ms: delayMs,
                next_retry_at: nextRetryAt,
                error_message: errorMessage,
                status: 'scheduled'
            });

        await emitScheduled();

        return await new Promise<boolean>((resolve) => {
            let settled = false;
            let interval: ReturnType<typeof setInterval>;
            let timeout: ReturnType<typeof setTimeout>;
            const cleanup = () => {
                clearInterval(interval);
                clearTimeout(timeout);
                this._retryDelayPending = false;
                this._retryNowResolver = null;
            };
            const settle = (value: boolean) => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(value);
            };
            this._retryNowResolver = () => settle(true);
            const tick = () => {
                if (this.task_status === 'stopped' || !this._retryDelayPending) {
                    void this.clearLLMRetryFeedback(attempt, delayMs, nextRetryAt, errorMessage).finally(() =>
                        settle(false)
                    );
                    return;
                }
                void emitScheduled();
            };
            interval = setInterval(tick, 1000);
            timeout = setTimeout(() => settle(this.task_status !== 'stopped'), delayMs);
        });
    }

    private async clearLLMRetryFeedback(
        attempt: number,
        delayMs: number,
        nextRetryAt: number,
        errorMessage: string
    ): Promise<void> {
        await this.sendRetryFeedback({
            attempt,
            delay_ms: delayMs,
            next_retry_at: nextRetryAt,
            error_message: errorMessage,
            status: 'cleared'
        });
    }

    /**
     * @returns true 表示流被 afterParseToolcall 钩子中断（abortedByParseHook）
     */
    async processCompletion(modelRequestOptions?: TaskModelRequestOptions): Promise<boolean> {
        const assistant_message = this.chat_context.lastMessage();
        if (assistant_message === undefined || !(assistant_message instanceof AssistantMessage)) {
            return false;
        }

        const model = this.ensureValidModelOrFallback();
        let streamOptions:
            | {
                  toolResultOverrides?: Map<string, string>;
                  activeContext?: ActiveContextView;
              }
            | undefined = undefined;
        let dynamicMaxCompletionTokens: number | undefined = undefined;
        try {
            const preparation = await prepareContextForModel(this.chat_context, model, {
                beforeCompact: () => {
                    logCompactInfo(this.task_id, {
                        source: 'tasks',
                        event: 'auto_compacting_context',
                        message: `Auto-compacting context for task ${this.task_id}`
                    });
                },
                enableToolResultBudget: true,
                enableMicrocompact: false,
                enableSessionMemoryCompact: true,
                taskId: this.task_id,
                toolResultReplacementState: this.tool_result_replacement_state,
                autoCompactState: this.auto_compact_state,
                microcompactState: this.microcompact_state,
                microcompactRequestKind: 'task_turn',
                microcompactTaskRole: this.getMicrocompactTaskRole(),
                sessionMemoryState: this.session_memory_state,
                requestOptions: modelRequestOptions
            });

            if (preparation.toolResultReplacementState) {
                this.tool_result_replacement_state = preparation.toolResultReplacementState;
            }

            if (preparation.autoCompactState) {
                this.setAutoCompactState(preparation.autoCompactState);
            }

            if (preparation.microcompactState) {
                this.setMicrocompactState(preparation.microcompactState);
            }

            if (preparation.sessionMemoryState) {
                this.setSessionMemoryState(preparation.sessionMemoryState);
            }

            if (preparation.compacted) {
                this.clearFileReadStateAfterContextCompaction(
                    preparation.sessionMemoryCompacted ? 'session_memory_compact' : 'full_compact'
                );
            }

            if (preparation.sessionMemoryCompactResult) {
                const compactVariant = preparation.sessionMemoryCompactResult.plan
                    ? describeCompactPlanVariant(preparation.sessionMemoryCompactResult.plan)
                    : undefined;
                logCompactInfo(this.task_id, {
                    source: 'tasks',
                    event: 'session_memory_compact_result',
                    message:
                        `[Compact Step9] session memory compact result: compacted=${preparation.sessionMemoryCompacted}, ` +
                        (compactVariant ? `variant=${compactVariant.compactVariant}, ` : '') +
                        `reason=${preparation.sessionMemoryCompactResult.noopReason ?? 'applied'}, ` +
                        `postTokens=${preparation.sessionMemoryCompactResult.postCompactTokens ?? 'unknown'}`,
                    data: {
                        compacted: preparation.sessionMemoryCompacted,
                        reason: preparation.sessionMemoryCompactResult.noopReason ?? 'applied',
                        postTokens: preparation.sessionMemoryCompactResult.postCompactTokens ?? 'unknown',
                        ...(compactVariant ?? {})
                    }
                });
            }

            const activeContextVariant = describeActiveContextVariant(preparation.activeContext);
            logCompactInfo(this.task_id, {
                source: 'tasks',
                event: 'active_context_compact_variant',
                message:
                    `[Compact Step9] active context compact variant=${activeContextVariant.compactVariant}, ` +
                    `recentUserPreserved=${activeContextVariant.recentUserPreserved}, ` +
                    `startsInsideAssistant=${activeContextVariant.startsInsideAssistant}` +
                    (activeContextVariant.startsInsideAssistant
                        ? `, messageId=${activeContextVariant.keepAnchorMessageId}, ` +
                          `roundIndex=${activeContextVariant.kept_anchor_round_index}, ` +
                          `startPartIndex=${activeContextVariant.kept_anchor_start_part_index}`
                        : ''),
                data: {
                    ...activeContextVariant
                }
            });

            if (preparation.budgetApplied && preparation.toolResultBudgetStats) {
                const stats = preparation.toolResultBudgetStats;
                logCompactInfo(this.task_id, {
                    source: 'tasks',
                    event: 'tool_result_budget',
                    message:
                        `[Compact Step4] query-time tool result budget: groups=${stats.groupCount}, ` +
                        `overrides=${stats.overrideCount}, reapplied=${stats.reappliedCount}, ` +
                        `newlySelected=${stats.newlySelectedCount}, newlySeen=${stats.newlySeenCount}, ` +
                        `overBudgetGroups=${stats.overBudgetGroupCount}`,
                    data: {
                        groupCount: stats.groupCount,
                        overrideCount: stats.overrideCount,
                        reappliedCount: stats.reappliedCount,
                        newlySelectedCount: stats.newlySelectedCount,
                        newlySeenCount: stats.newlySeenCount,
                        overBudgetGroupCount: stats.overBudgetGroupCount
                    }
                });
            }

            if (preparation.microcompactStats) {
                const stats = preparation.microcompactStats;
                const skippedSummary = Object.entries(stats.skippedByReason)
                    .sort(([leftReason], [rightReason]) => leftReason.localeCompare(rightReason))
                    .map(([reason, count]) => `${reason}=${count}`)
                    .join(', ');
                logCompactInfo(this.task_id, {
                    source: 'tasks',
                    event: 'microcompact_analysis_detail',
                    message:
                        `[Compact Step5A] microcompact analysis: scanned=${stats.scannedToolCallCount}, ` +
                        `candidates=${stats.candidateCount}, skipped=${stats.skippedCount}, ` +
                        `tailProtected=${stats.tailProtectedCount}, totalCandidateChars=${stats.totalCandidateChars}, ` +
                        `tailAssistantMessages=${stats.tailAssistantMessages}` +
                        (skippedSummary.length > 0 ? `, skippedByReason={${skippedSummary}}` : ''),
                    data: {
                        scannedToolCallCount: stats.scannedToolCallCount,
                        candidateCount: stats.candidateCount,
                        skippedCount: stats.skippedCount,
                        tailProtectedCount: stats.tailProtectedCount,
                        totalCandidateChars: stats.totalCandidateChars,
                        tailAssistantMessages: stats.tailAssistantMessages,
                        skippedByReason: stats.skippedByReason
                    }
                });

                const topCandidates = [...(preparation.microcompactAnalysis?.candidates ?? [])]
                    .sort((left, right) => right.sizeChars - left.sizeChars)
                    .slice(0, 3);
                for (const candidate of topCandidates) {
                    logCompactInfo(this.task_id, {
                        source: 'tasks',
                        event: 'microcompact_candidate_detail',
                        message:
                            `[Compact Step5A] candidate tool=${candidate.toolName}, chars=${candidate.sizeChars}, ` +
                            `lines=${candidate.sizeLines}, chatIndex=${candidate.chatContextMessageIndex}, ` +
                            `part=${candidate.toolCallPartIndex}, call=${candidate.toolCallIndex}, ` +
                            `resultId=${candidate.resultId}, hasStorage=${candidate.hasResultStorage}`,
                        data: {
                            toolName: candidate.toolName,
                            sizeChars: candidate.sizeChars,
                            sizeLines: candidate.sizeLines,
                            chatContextMessageIndex: candidate.chatContextMessageIndex,
                            toolCallPartIndex: candidate.toolCallPartIndex,
                            toolCallIndex: candidate.toolCallIndex,
                            resultId: candidate.resultId,
                            hasResultStorage: candidate.hasResultStorage
                        }
                    });
                }
                if (preparation.microcompactDecision) {
                    const decision = preparation.microcompactDecision;
                    logCompactInfo(this.task_id, {
                        source: 'tasks',
                        event: 'microcompact_decision_detail',
                        message:
                            `[Compact Step5B] microcompact decision: mode=${decision.mode}, ` +
                            `reason=${decision.reason}, selected=${decision.selectedResultIds.length}, ` +
                            `keptRecent=${decision.keptRecentResultIds.length}, ` +
                            `idleGapMinutes=${decision.idleGapMinutes ?? 'n/a'}, ` +
                            `estimatedCharsBefore=${decision.estimatedCharsBefore}, ` +
                            `estimatedCharsAfter=${decision.estimatedCharsAfter}, ` +
                            `estimatedCharsSaved=${decision.estimatedCharsSaved}`,
                        data: {
                            mode: decision.mode,
                            reason: decision.reason,
                            selectedCount: decision.selectedResultIds.length,
                            selectedResultIds: decision.selectedResultIds,
                            keptRecentCount: decision.keptRecentResultIds.length,
                            keptRecentResultIds: decision.keptRecentResultIds,
                            idleGapMinutes: decision.idleGapMinutes,
                            estimatedCharsBefore: decision.estimatedCharsBefore,
                            estimatedCharsAfter: decision.estimatedCharsAfter,
                            estimatedCharsSaved: decision.estimatedCharsSaved
                        }
                    });
                }
                logCompactInfo(this.task_id, {
                    source: 'tasks',
                    event: 'microcompact_execution_detail',
                    message:
                        `[Compact Step5C] microcompact execution: mode=${preparation.microcompactDecision?.mode ?? 'noop'}, ` +
                        `applied=${stats.appliedCount}, ` +
                        `skippedByOverride=${stats.skippedByOverrideCount}, ` +
                        `unshrinkable=${stats.unshrinkableCount}, ` +
                        `charsBefore=${stats.totalCharsBefore}, charsAfter=${stats.totalCharsAfter}`,
                    data: {
                        mode: preparation.microcompactDecision?.mode ?? 'noop',
                        appliedCount: stats.appliedCount,
                        skippedByOverrideCount: stats.skippedByOverrideCount,
                        unshrinkableCount: stats.unshrinkableCount,
                        totalCharsBefore: stats.totalCharsBefore,
                        totalCharsAfter: stats.totalCharsAfter
                    }
                });

                for (const candidate of preparation.microcompactAppliedCandidates.slice(0, 3)) {
                    logCompactInfo(this.task_id, {
                        source: 'tasks',
                        event: 'microcompact_applied_candidate_detail',
                        message:
                            `[Compact Step5C] applied tool=${candidate.toolName}, chars=${candidate.sizeChars}, ` +
                            `lines=${candidate.sizeLines}, chatIndex=${candidate.chatContextMessageIndex}, ` +
                            `part=${candidate.toolCallPartIndex}, call=${candidate.toolCallIndex}, ` +
                            `resultId=${candidate.resultId}`,
                        data: {
                            toolName: candidate.toolName,
                            sizeChars: candidate.sizeChars,
                            sizeLines: candidate.sizeLines,
                            chatContextMessageIndex: candidate.chatContextMessageIndex,
                            toolCallPartIndex: candidate.toolCallPartIndex,
                            toolCallIndex: candidate.toolCallIndex,
                            resultId: candidate.resultId
                        }
                    });
                }
            }

            if (
                preparation.compacted ||
                preparation.toolResultStateChanged ||
                preparation.microcompactStateChanged ||
                preparation.autoCompactStateChanged ||
                preparation.sessionMemoryStateChanged
            ) {
                this.persistLater();
            }

            streamOptions = {
                activeContext: preparation.activeContext,
                toolResultOverrides: preparation.toolResultOverrides
            };

            const estimatedContextTokens = preparation.contextTokenEstimate?.estimatedContextTokens ?? 0;
            if (estimatedContextTokens > 0) {
                try {
                    let contextWindow = 0;
                    const modelInstance = model
                        ? Setting.getInstance().getModelInstance(model, 'chat')
                        : Setting.getInstance().getDefaultModelInstance();
                    if (modelInstance?.context_length && modelInstance.context_length > 0) {
                        contextWindow = modelInstance.context_length;
                    } else {
                        const modelName = modelInstance?.model_name ?? model ?? '';
                        contextWindow = lookupKnownContextSize(modelName);
                        if (contextWindow <= 0 && modelInstance) {
                            contextWindow = await fetchContextSizeFromAPI(modelInstance);
                        }
                    }
                    if (contextWindow > 0) {
                        const remaining = contextWindow - estimatedContextTokens;
                        if (remaining > 0) {
                            dynamicMaxCompletionTokens = Math.min(remaining, 16384);
                        }
                    }
                } catch {
                    // 解析失败时保持默认值
                }
            }
        } catch (err: unknown) {
            logger.warn(`Prepare context before completion failed: ${err instanceof Error ? err.message : err}`);
        }

        this.profiler?.beginLLM(this._currentTurn);
        const benchmarkRequest = this.ensureBenchmarkUsageLedger().beginRequest({
            turn: this._currentTurn,
            requestType: 'streamComplete',
            ...this.resolveBenchmarkUsageModelInfo()
        });

        // Track the last sent text part index to avoid duplicate sends
        let lastSentTextPartIndex = -1;
        // 追踪上一次 merge 后的工具调用数量，用于检测新工具调用到达
        let prevMergedToolCallCount = 0;
        let abortedByParseHook = false;
        const requestOptions: LLMRequestOptions = {
            reasoningEffort: this.reasoningEffort,
            maxCompletionTokens: dynamicMaxCompletionTokens,
            ...modelRequestOptions,
            onRetry: (_attempt: number, _delayMs: number, err: unknown) => {
                this.ensureBenchmarkUsageLedger().recordRetry(benchmarkRequest, err);
            },
            disableInternalRetry: true
        };
        let retryAttempt = 0;
        let lastRetryState:
            | {
                  attempt: number;
                  delayMs: number;
                  nextRetryAt: number;
                  errorMessage: string;
              }
            | undefined;

        try {
            while (this.task_status !== 'stopped') {
                try {
                    const requestModel = this.ensureValidModelOrFallback();
                    for await (const chunk_resp of LLM.streamComplete(
                        this.chat_context,
                        requestModel,
                        streamOptions,
                        requestOptions
                    )) {
                        const responseError = getAssistantResponseError(chunk_resp);
                        if (responseError) {
                            throw responseError;
                        }

                        // 检查是否已停止
                        if (this.task_status === 'stopped') {
                            logger.info(`task ${this.task_id} completion interrupted by stop request`);
                            break;
                        }

                        // 在 merge 之前，检查本 chunk 是否带来了新的工具调用 ID。
                        // 如果是，说明前一个工具调用的 args_string 已完整，通过 afterParseToolcall 钩子校验。
                        const chunkHasNewToolCall = TaskState.chunkIntroducesNewToolCall(
                            chunk_resp.content,
                            assistant_message
                        );
                        if (chunkHasNewToolCall && prevMergedToolCallCount > 0) {
                            const existingCalls = TaskState.collectToolCalls(assistant_message);
                            const lastExisting = existingCalls[existingCalls.length - 1];
                            if (lastExisting) {
                                TaskState.finalizeToolCallArgs(lastExisting);
                                const feedback = await this.hooks.checkAfterParseToolcall(this, lastExisting);
                                if (feedback.operation === 'reject') {
                                    TaskState.removeToolCallsFrom(assistant_message, existingCalls.length - 1);
                                    if (chunk_resp.usage) {
                                        assistant_message.usage = chunk_resp.usage;
                                    }
                                    logger.warn(
                                        `task ${this.task_id}: afterParseToolcall rejected ` +
                                            `"${lastExisting.tool_name}" (id=${lastExisting.id}): ${feedback.message}`
                                    );
                                    await this.sendSubscriptionFeedback();
                                    break;
                                }
                            }
                        }

                        const prevPartCount = assistant_message.content.length;
                        assistant_message.mergeChunk(chunk_resp.content);
                        assistant_message.usage = chunk_resp.usage;

                        this.resolveStreamingToolCalls(assistant_message);

                        prevMergedToolCallCount = TaskState.collectToolCalls(assistant_message).length;

                        // When content length increases, a new part was created - the previous part is now complete
                        if (assistant_message.content.length > prevPartCount) {
                            const prevPartIndex = prevPartCount - 1;
                            const prevPart = assistant_message.content[prevPartIndex];

                            // Check if the previous part is a text part that hasn't been sent yet
                            if (prevPart?.type === 'text' && lastSentTextPartIndex < prevPartIndex) {
                                this.onTextPartComplete?.(prevPart.text);
                                lastSentTextPartIndex = prevPartIndex;
                            }
                        }

                        if (this.subscribers.length == 0) {
                            // no subscribers, skip
                            continue;
                        }

                        if (assistant_message.content.length > prevPartCount) {
                            // content 数组增长了（如 <think> 标签拆分产生新 part），
                            // 需要同时更新被修改的旧 part 和新增的 part
                            for (let i = Math.max(0, prevPartCount - 1); i < assistant_message.content.length; i++) {
                                await this.sendSubscriptionFeedback(i);
                            }
                        } else {
                            await this.sendSubscriptionFeedback();
                        }
                    }

                    if (lastRetryState) {
                        await this.clearLLMRetryFeedback(
                            lastRetryState.attempt,
                            lastRetryState.delayMs,
                            lastRetryState.nextRetryAt,
                            lastRetryState.errorMessage
                        );
                    }
                    break;
                } catch (err: unknown) {
                    if (this.task_status === 'stopped') {
                        break;
                    }

                    const autoRetry = Setting.getInstance().getData().task_config?.auto_retry !== false;
                    if (!autoRetry) {
                        if (lastRetryState) {
                            await this.clearLLMRetryFeedback(
                                lastRetryState.attempt,
                                lastRetryState.delayMs,
                                lastRetryState.nextRetryAt,
                                lastRetryState.errorMessage
                            );
                        }
                        assistant_message.appendError('Stream Completion Failed', errorToMessage(err));
                        await this.sendSubscriptionFeedback();
                        break;
                    }

                    retryAttempt++;
                    const delayMs = getLLMRetryDelayMs(retryAttempt);
                    const nextRetryAt = Date.now() + delayMs;
                    const errorMessage = errorToMessage(err);
                    lastRetryState = {
                        attempt: retryAttempt,
                        delayMs,
                        nextRetryAt,
                        errorMessage
                    };

                    this.ensureBenchmarkUsageLedger().recordRetry(benchmarkRequest, err);

                    if (assistant_message.content.length > 0) {
                        // 仅回退最后一个未完成的 part，保留已完成的 parts
                        assistant_message.rollbackLastPart();
                        // 重新计算 lastSentTextPartIndex：找到最后一个 text part 的索引
                        lastSentTextPartIndex = -1;
                        for (let i = assistant_message.content.length - 1; i >= 0; i--) {
                            if (assistant_message.content[i].type === 'text') {
                                lastSentTextPartIndex = i;
                                break;
                            }
                        }
                        prevMergedToolCallCount = TaskState.collectToolCalls(assistant_message).length;
                        await this.sendAssistantMessageReplace(assistant_message);
                    }

                    logger.warn(
                        `LLM request failed for task ${this.task_id}; retry ${retryAttempt} in ${delayMs / 1000}s: ` +
                            errorMessage
                    );

                    const shouldRetry = await this.waitForLLMRetryDelay(retryAttempt, delayMs, err);
                    if (!shouldRetry) {
                        break;
                    }

                    await this.sendRetryFeedback({
                        attempt: retryAttempt,
                        delay_ms: delayMs,
                        next_retry_at: Date.now(),
                        error_message: errorMessage,
                        status: 'retrying'
                    });
                }
            }

            // 流结束后，如果之前没有被 afterParseToolcall 钩子拒绝过，则再校验最后一个工具调用
            if (!abortedByParseHook) {
                const finalToolCalls = TaskState.collectToolCalls(assistant_message);
                if (finalToolCalls.length > 0) {
                    const lastTc = finalToolCalls[finalToolCalls.length - 1];
                    TaskState.finalizeToolCallArgs(lastTc);
                    const feedback = await this.hooks.checkAfterParseToolcall(this, lastTc);
                    if (feedback.operation === 'reject') {
                        TaskState.removeToolCallsFrom(assistant_message, finalToolCalls.length - 1);
                        logger.warn(
                            `task ${this.task_id}: afterParseToolcall rejected last tool call ` +
                                `"${lastTc.tool_name}" (id=${lastTc.id}) after stream: ${feedback.message}`
                        );
                        abortedByParseHook = true;
                        await this.sendSubscriptionFeedback();
                    }
                }
            }

            // After streaming ends, send any remaining text part if it hasn't been sent
            const lastPart = assistant_message.content[assistant_message.content.length - 1];
            if (lastPart?.type === 'text' && lastSentTextPartIndex < assistant_message.content.length - 1) {
                this.onTextPartComplete?.(lastPart.text);
            }
        } catch (err) {
            logger.error(`task ${this.task_id}: processTaskTurn crashed: ${(err as Error)?.message || String(err)}`);
            // 确保任务状态被标记为已停止
            if (this.task_status !== 'stopped') {
                this.task_status = 'stopped';
                this.finished_at = new Date();
            }
        } finally {
            this.ensureBenchmarkUsageLedger().finishRequest(benchmarkRequest, {
                usage: assistant_message.usage
            });
            this.profiler?.endLLM({
                prompt_tokens: assistant_message.usage?.prompt_tokens,
                completion_tokens: assistant_message.usage?.completion_tokens,
                total_tokens: assistant_message.usage?.total_tokens,
                input_tokens: assistant_message.usage?.input_tokens,
                output_tokens: assistant_message.usage?.output_tokens,
                cache_creation_input_tokens: assistant_message.usage?.cache_creation_input_tokens,
                cache_read_input_tokens: assistant_message.usage?.cache_read_input_tokens
            });
        }

        this.persistLater();
        return abortedByParseHook;
    }

    /**
     * 构建当前任务所需的全部 toolsets。
     * 主任务和子任务共享应用工具集与 skill 工具集，
     * 但 planning 工具集和 task-info 工具集仅主任务拥有。
     */
    async buildToolsets(): Promise<BaseToolset[]> {
        const appToolsets = await this.task_manager_state.toolsetProvider.listAvailableToolsets();
        const skillToolset = SkillRegistry.getInstance().getToolset();
        const memoryToolset = createMemoryToolset();
        const planningToolset = this.parent_id ? createSubTaskPlanningToolset() : createMainPlanningToolset();

        const all = [...appToolsets, skillToolset, memoryToolset, planningToolset];
        if (this.parent_id === null) {
            all.push(createTaskInfoToolset(this.task_manager_state));
            if (this.interactionToolset) {
                all.push(this.interactionToolset);
            }
        }

        this.applyToolAvailabilityFilters(all);

        // Apply allowedTools whitelist filter (Agent level) — if set, only these tools are kept
        if (this.allowedTools && this.allowedTools.length > 0) {
            const allowed = new Set(this.allowedTools);
            for (const toolset of all) {
                for (const [name] of toolset.tools.entries()) {
                    if (!allowed.has(name)) {
                        toolset.tools.delete(name);
                    }
                }
            }
        }

        // Apply disabledTools blacklist filter (Mode + Agent level)
        if (this.disabledTools && this.disabledTools.length > 0) {
            const disabled = new Set(this.disabledTools);
            for (const toolset of all) {
                for (const [name] of toolset.tools.entries()) {
                    if (disabled.has(name)) {
                        toolset.tools.delete(name);
                    }
                }
            }
        }

        return all;
    }

    private applyToolAvailabilityFilters(toolsets: BaseToolset[]): void {
        for (let i = toolsets.length - 1; i >= 0; i--) {
            const toolset = toolsets[i];
            for (const [name, tool] of [...toolset.tools.entries()]) {
                const isAvailable = (tool as TaskAwareTool).isAvailable;
                if (typeof isAvailable === 'function' && !isAvailable.call(tool, this)) {
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
    async ensureToolsResolved() {
        if (this.chat_context.toolsets.size === 0) {
            const allToolsets = await this.buildToolsets();
            this.chat_context.attachToolsets(...allToolsets);
        }
        this.resolveAllToolCalls();
    }

    /**
     * 为历史消息中所有未绑定 tool 的 ToolCall 解析 tool 引用并解析 args_object。
     * 用于从硬盘加载任务后、在 toolsets 已挂载的前提下重新绑定工具，
     * 使 CLI 自定义渲染器能正常工作。
     */
    resolveAllToolCalls() {
        for (const message of this.chat_context.messages) {
            if (!(message instanceof AssistantMessage)) continue;
            const content = Array.isArray(message.content) ? message.content : [];
            for (const part of content) {
                if (!part || part.type !== 'tool_call') continue;
                const toolcalls = Array.isArray(part.toolcalls) ? part.toolcalls : [];
                for (const tc of toolcalls) {
                    if (!tc) continue;
                    if (!tc.tool && tc.tool_name) {
                        const tool = this.chat_context.getTool(tc.tool_name);
                        if (tool) tc.setTool(tool);
                    }
                    if (tc.args_string && !tc.args_object) {
                        try {
                            tc.args_object = JSON.parse(jsonrepair(tc.args_string));
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
    private resolveStreamingToolCalls(message: AssistantMessage) {
        const content = Array.isArray(message.content) ? message.content : [];
        for (const part of content) {
            if (!part || part.type !== 'tool_call') continue;
            const toolcalls = Array.isArray(part.toolcalls) ? part.toolcalls : [];
            for (const tc of toolcalls) {
                if (!tc) continue;
                if (!tc.tool && tc.tool_name) {
                    const tool = this.chat_context.getTool(tc.tool_name);
                    if (tool) tc.setTool(tool);
                }
                if (tc.args_string) {
                    try {
                        tc.args_object = JSON.parse(jsonrepair(tc.args_string));
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
    private static chunkIntroducesNewToolCall(chunk: AssistantMessage, existingMessage?: AssistantMessage): boolean {
        const existingCalls = existingMessage ? TaskState.collectToolCalls(existingMessage) : [];
        const content = Array.isArray(chunk.content) ? chunk.content : [];
        for (const part of content) {
            if (!part || part.type !== 'tool_call') continue;
            const toolcalls = Array.isArray(part.toolcalls) ? part.toolcalls : [];
            for (const tc of toolcalls) {
                if (!tc) continue;
                if (typeof tc.id === 'string' && tc.id.trim().length > 0) {
                    const hasValidIndex = typeof tc.index === 'number' && Number.isInteger(tc.index);
                    if (
                        existingCalls.some((existing) => {
                            if (existing.id === tc.id) {
                                return true;
                            }
                            return (
                                hasValidIndex &&
                                !existing.id &&
                                typeof existing.index === 'number' &&
                                Number.isInteger(existing.index) &&
                                existing.index === tc.index
                            );
                        })
                    ) {
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
    private static collectToolCalls(message: AssistantMessage): ToolCall[] {
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
    private static finalizeToolCallArgs(tc: ToolCall): boolean {
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
                tc.args_object = JSON.parse(jsonrepair(raw));
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
    private static removeToolCallsFrom(message: AssistantMessage, flatIndex: number): ToolCall[] {
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
    private resolveToolForCall(tool_call: ToolCall): BaseTool<any> | undefined {
        if (!tool_call.tool_name) {
            return undefined;
        }
        return this.chat_context.getTool(tool_call.tool_name);
    }

    /**
     * 完成一个工具调用的实际执行过程, 并将结果直接写入 tool_call 中
     * @param tool_call 要被执行的工具调用
     * @param skipPermission 是否跳过权限检查（已在 processToolCalls 预检阶段完成时为 true）
     */
    async processToolCall(tool_call: ToolCall, skipPermission = false): Promise<void> {
        if (!tool_call.tool_name) {
            logger.error('tool_call has no tool_name');
            tool_call.status = 'error';
            tool_call.result = 'tool_call has no tool_name';
            return;
        }

        const tool = this.chat_context.getTool(tool_call.tool_name);
        if (tool === undefined) {
            logger.error(`tool ${tool_call.tool_name} not found`);
            tool_call.status = 'error';
            tool_call.result = `tool ${tool_call.tool_name} not found`;
            return;
        }

        const profilerToken = this.profiler?.beginTool(tool_call.tool_name, this._currentTurn);

        tool_call.setTool(tool);
        try {
            let args: Record<string, unknown> = {};
            if (tool_call.args_string) {
                const repaired = jsonrepair(tool_call.args_string);
                args = JSON.parse(repaired);
            }
            const validation = tool.validateArgs(args);
            if (!validation.success) {
                logger.error(`tool ${tool_call.tool_name} validation failed: ${validation.error}`);
                tool_call.args_object = args;
                tool_call.status = 'error';
                tool_call.result = validation.error;
                return;
            }

            args = validation.data as Record<string, unknown>;
            tool_call.args_object = args;
            tool_call.status = 'running';

            await this.sendSubscriptionFeedback();

            /* 在执行工具前检查是否任务已经被用户手动中止 */
            if (this.task_status === 'stopped') {
                logger.info(`tool ${tool_call.tool_name} skipped: task stopped`);
                tool_call.status = 'error';
                tool_call.result = '任务已停止';
                return;
            }

            if (!skipPermission) {
                /* 权限检查：工具声明所需权限 → 引擎判定 → allow/deny/ask */
                const permissionDenied = await this.handleToolPermissions(tool, args, tool_call);
                if (permissionDenied) {
                    return;
                }
            }

            const hookFeedback = await this.hooks.checkBeforeToolCall(this, tool_call);

            // 检查 beforeToolCall hook 是否已阻止执行（如 AgentGate 安全拦截）
            if (hookFeedback.operation === 'deny') {
                logger.error(`tool ${tool_call.tool_name} denied by hook: ${hookFeedback.message}`);
                tool_call.status = 'error';
                tool_call.result = hookFeedback.message;
                if (hookFeedback.extra) {
                    tool_call.result_object = hookFeedback.extra;
                }
                return;
            }

            const result = await tool.execute(
                args,
                async (result) => {
                    tool_call.result = result.result;
                    tool_call.result_object = result.result_object;
                    await this.sendSubscriptionFeedback();
                },
                this
            );
            tool_call.status = result.status;
            tool_call.result = result.result;
            tool_call.result_object = result.result_object;
        } catch (err) {
            logger.error(err);
            tool_call.status = 'error';
            tool_call.result = `工具运行错误: ${err}`;
        } finally {
            if (profilerToken !== undefined) {
                this.profiler?.endTool(profilerToken, { status: tool_call.status });
            }
            await this.hooks.noticeAfterToolCall(this, tool_call);
            await tool_call.freezeRenderResult();
        }
    }

    /**
     * 处理工具的全部权限请求。
     *
     * 1. 收集所有声明的权限并逐条检查
     * 2. 如有 deny → 直接拒绝
     * 3. 将所有 ask 按 (resourceType, action) 分组合并
     * 4. 逐组提示用户
     *
     * @returns true 表示工具被拒绝执行，false 表示可以继续
     */
    private async handleToolPermissions(
        tool: BaseTool<any>,
        args: Record<string, unknown>,
        tool_call: ToolCall
    ): Promise<boolean> {
        const enforcer = this.harnessContext.permission;
        if (!enforcer) {
            return false;
        }

        const declaredPermissions = tool.getDeclaredPermissions(args, this);
        if (!declaredPermissions || declaredPermissions.length === 0) {
            return false;
        }

        const allResults = await enforcer.checkAllDetailed(declaredPermissions);
        if (allResults.length === 0) {
            return false;
        }

        // deny 优先：只要有一个 deny 就拒绝整个工具调用
        const denied = allResults.find((r) => r.effect === 'deny');
        if (denied) {
            tool_call.status = 'error';
            tool_call.result = `权限被拒绝: ${denied.reason || denied.request.action + ' ' + denied.request.resourcePath}`;
            tool_call.result_object = { permission_denied: true };
            return true;
        }

        // 剩下全是 ask，按 (resourceType, action) 分组合并
        const askResults = allResults.filter((r) => r.effect === 'ask');
        if (askResults.length === 0) {
            return false;
        }

        const groups = new Map<string, PermissionCheckResult[]>();
        for (const result of askResults) {
            const key = `${result.request.resourceType}:${result.request.action}`;
            if (!groups.has(key)) {
                groups.set(key, []);
            }
            groups.get(key)!.push(result);
        }

        // 逐组提示用户
        for (const [, groupResults] of groups) {
            const requests = groupResults.map((r) => r.request);

            // 计算所有请求路径的共同前缀选项
            const prefixOptions = this.computePrefixOptions(requests);

            const response = await this.promptPermissionBatch(requests, tool.name, prefixOptions, tool_call);

            if (response.decision === 'deny') {
                const paths = requests.map((r) => r.resourcePath).join(', ');
                const reasonLabel =
                    response.denyReason === 'timeout'
                        ? '权限请求超时自动拒绝'
                        : response.denyReason === 'no_prompt_provider'
                          ? '无权限确认界面，已自动拒绝'
                          : response.denyReason === 'task_stopped'
                            ? '任务已停止，权限请求已取消'
                            : '用户拒绝了权限请求';
                tool_call.status = 'error';
                tool_call.result = `${reasonLabel}: ${requests[0].action} ${paths}`;
                tool_call.result_object = {
                    permission_denied: true,
                    deny_reason: response.denyReason || 'user_denied'
                };
                return true;
            }

            // 根据用户选择写回规则
            if (
                response.rememberScope === 'prefix' &&
                response.selectedPrefixPattern &&
                this.harnessContext.permission
            ) {
                await this.applyPersistentPermissionAllow({
                    resourceType: requests[0].resourceType,
                    action: requests[0].action,
                    pathPattern: response.selectedPrefixPattern,
                    effect: 'allow'
                });
            } else if (response.rememberScope === 'type' && this.harnessContext.permission) {
                await this.applyPersistentPermissionAllow({
                    resourceType: requests[0].resourceType,
                    action: requests[0].action,
                    pathPattern: '**',
                    effect: 'allow'
                });
            }
        }

        return false;
    }

    private async applyPersistentPermissionAllow(rule: PermissionRule): Promise<void> {
        const relatedTasks = [this];
        if (this.parent_id) {
            const parentTask = this.task_manager_state.getTask(this.parent_id);
            if (parentTask) {
                relatedTasks.push(parentTask);
            }
        }

        const enforcers: PermissionEnforcer[] = [];
        for (const task of relatedTasks) {
            const enforcer = task.harnessContext.permission;
            if (enforcer && !enforcers.includes(enforcer)) {
                enforcers.push(enforcer);
            }
        }

        for (const enforcer of enforcers) {
            await enforcer.addRule(rule);
        }

        const authoritativeEnforcer = [...relatedTasks].reverse().find((task) => task.harnessContext.permission)
            ?.harnessContext.permission;
        if (!authoritativeEnforcer) {
            return;
        }

        const providers: PermissionPromptProvider[] = [];
        for (const task of relatedTasks) {
            const provider = task.harnessContext.permissionPrompt;
            if (provider?.notifyPermissionRulesChanged && !providers.includes(provider)) {
                providers.push(provider);
            }
        }

        for (const provider of providers) {
            await provider.notifyPermissionRulesChanged?.(authoritativeEnforcer);
        }
    }

    /**
     * 计算一组同类请求的共同前缀选项，用于让用户选择授权范围。
     * 对所有请求的 ResourcePath.getPrefixes() 取交集（保留所有请求都共享的前缀）。
     * 如果请求只有一个，直接返回其前缀。
     * 如果前缀无法取交集，返回各自的精确路径前缀。
     */
    private computePrefixOptions(requests: PermissionRequest[]): { label: string; pattern: string }[] {
        if (requests.length === 0) return [];

        const allPrefixLists = requests.map((req) =>
            createResourcePath(req.resourceType, req.resourcePath).getPrefixes()
        );

        if (allPrefixLists.length === 1) {
            return allPrefixLists[0];
        }

        // 取交集：只保留所有请求都有的 pattern
        const first = allPrefixLists[0];
        const commonPrefixes = first.filter((prefix) =>
            allPrefixLists.every((list) => list.some((p) => p.pattern === prefix.pattern))
        );

        if (commonPrefixes.length > 0) {
            return commonPrefixes;
        }

        // 没有共同前缀时，返回每个请求的精确路径
        return requests.map((req) => ({ label: req.resourcePath, pattern: req.resourcePath }));
    }

    /**
     * 通过 harnessContext 的 permissionPrompt 向用户请求权限确认（合并后的批量请求）
     */
    private async promptPermissionBatch(
        requests: PermissionRequest[],
        toolName: string,
        prefixOptions: { label: string; pattern: string }[],
        toolCall?: ToolCall
    ): Promise<PermissionUserResponse> {
        const promptProvider = this.harnessContext.permissionPrompt;
        if (!promptProvider) {
            logger.warn(`permission ask required but no prompt provider configured, defaulting to deny`);
            return { decision: 'deny', rememberScope: 'none', denyReason: 'no_prompt_provider' };
        }

        const parentTask = this.parent_id ? this.task_manager_state.getTask(this.parent_id) : undefined;
        const taskInfo = {
            taskId: parentTask?.task_id ?? this.task_id,
            taskName: parentTask?.task_name ?? this.task_name,
            workspace: parentTask?.getWorkspace() ?? this.getWorkspace(),
            sourceTaskId: this.task_id,
            sourceTaskName: this.task_name,
            parentTaskId: parentTask?.task_id ?? null
        };
        const promptContext: PermissionPromptContext | undefined = toolCall
            ? {
                  toolCallId: toolCall.id,
                  messageId: this.findMessageIdForToolCall(toolCall),
                  input: toolCall.args_object
              }
            : undefined;

        try {
            return await promptProvider.prompt(requests, toolName, prefixOptions, taskInfo, promptContext);
        } catch (err) {
            logger.error(`permission prompt failed: ${err}`);
            return { decision: 'deny', rememberScope: 'none' };
        }
    }

    private findMessageIdForToolCall(toolCall: ToolCall): string | undefined {
        for (const message of this.chat_context.messages) {
            if (!(message instanceof AssistantMessage)) continue;
            const content = Array.isArray(message.content) ? message.content : [];
            for (const part of content) {
                if (!part || part.type !== 'tool_call') continue;
                const toolcalls = Array.isArray(part.toolcalls) ? part.toolcalls : [];
                if (toolcalls.includes(toolCall)) {
                    return message.message_id;
                }
            }
        }
        return undefined;
    }

    /**
     * Process the tool calls in the last message
     * @returns true if there are tool calls to process, false otherwise
     */
    async processToolCalls(): Promise<boolean> {
        const lastMessage = this.chat_context.lastMessage();
        if (!(lastMessage instanceof AssistantMessage)) {
            return false;
        }

        const pendingCalls: { tool_call: ToolCall; partIndex: number }[] = [];

        for (const message of this.chat_context.messages) {
            if (message instanceof AssistantMessage) {
                const content = Array.isArray(message.content) ? message.content : [];
                for (let index = 0; index < content.length; index++) {
                    const part = content[index];
                    if (!part || part.type !== 'tool_call') {
                        continue;
                    }
                    const toolcalls = Array.isArray(part.toolcalls) ? part.toolcalls : [];
                    for (const tool_call of toolcalls) {
                        if (!tool_call) continue;
                        if (tool_call.status !== 'pending') {
                            continue;
                        }
                        pendingCalls.push({ tool_call, partIndex: index });
                    }
                }
            }
        }

        if (pendingCalls.length === 0) {
            return false;
        }

        // 阶段 1：串行完成所有权限检查（避免多个权限提示同时弹出）
        const permissionResults = new Map<ToolCall, boolean>();
        for (const { tool_call } of pendingCalls) {
            const tool = this.resolveToolForCall(tool_call);
            if (tool) {
                let args: Record<string, unknown> = {};
                try {
                    if (tool_call.args_string) {
                        const repaired = jsonrepair(tool_call.args_string);
                        args = JSON.parse(repaired);
                    }
                } catch {
                    // parse 失败时不做预检，让 processToolCall 里处理
                }
                const denied = await this.handleToolPermissions(tool, args, tool_call);
                permissionResults.set(tool_call, denied);
            }
        }

        // 阶段 2：并行执行所有通过权限检查的工具（已拒绝的跳过执行阶段）
        // 每个工具调用独立 try-catch，防止单个工具异常导致整个 turn 崩溃
        await Promise.all(
            pendingCalls.map(async ({ tool_call, partIndex }) => {
                try {
                    const alreadyDenied = permissionResults.get(tool_call);
                    if (alreadyDenied) {
                        await tool_call.render();
                        await this.sendSubscriptionFeedback(partIndex);
                        return;
                    }
                    await this.processToolCall(tool_call, true);
                    await tool_call.render();
                    await this.sendSubscriptionFeedback(partIndex);
                } catch (err) {
                    logger.error(
                        `task ${this.task_id}: tool call execution crashed: ${(err as Error)?.message || String(err)}`
                    );
                    tool_call.status = 'error';
                    tool_call.result = `工具执行异常: ${(err as Error)?.message || String(err)}`;
                    try {
                        await tool_call.render();
                        await this.sendSubscriptionFeedback(partIndex);
                    } catch (renderErr) {
                        logger.error(
                            `task ${this.task_id}: failed to render tool call error state: ${(renderErr as Error)?.message || String(renderErr)}`
                        );
                    }
                }
            })
        );

        return true;
    }

    /**
     * 执行任务的一个轮次
     *
     * 从收到消息，到反复执行工具获取结果，直到没有新的工具要执行为止，这样的过程我们
     * 称为一个轮次 (turn)。processTaskTurn 负责这个执行过程以及相关的钩子判断。
     */
    /** 当前 turn 索引，供 profiler 记录 */
    private _currentTurn: number = 0;

    async processTaskTurn(generation?: number, modelRequestOptions?: TaskModelRequestOptions) {
        const myGeneration = generation ?? ++this._turnGeneration;
        this._turnRunning = true;
        let hookRejectCount = 0;
        this._currentTurn = 0;
        await this.hooks.noticeBeforeTurnStart(this);
        let shouldScheduleSessionMemoryUpdate = false;

        try {
            let parseHookAbortCount = 0;
            while (this.task_status !== 'stopped') {
                // 在每次异步操作后检查是否被新的 turn 取代
                if (this._turnGeneration !== myGeneration) return;

                try {
                    const abortedByParseHook = await this.processCompletion(modelRequestOptions);
                    if (this._turnGeneration !== myGeneration) return;
                    // @ts-expect-error 这里的task_status可能通过前端的请求被随时中止
                    if (this.task_status === 'stopped') {
                        break;
                    }

                    // 钩子：通知 afterProcessCompletion
                    {
                        const lastMsg = this.chat_context.lastMessage();
                        if (lastMsg instanceof AssistantMessage) {
                            await this.hooks.noticeAfterProcessCompletion(this, lastMsg);
                        }
                    }

                    const hasToolCalls = await this.processToolCalls();
                    if (this._turnGeneration !== myGeneration) return;
                    if (hasToolCalls) {
                        hookRejectCount = 0;
                        parseHookAbortCount = 0;
                        this._currentTurn++;
                        continue;
                    }

                    // 检查是否需要拒绝当前 turn
                    let turnRejected: boolean;
                    let turnRejectedReason: string = '';

                    if (abortedByParseHook) {
                        turnRejected = true;
                        turnRejectedReason = '';
                    } else {
                        const checkHooks = await this.hooks.checkBeforeFinishTurn(this);
                        if (this._turnGeneration !== myGeneration) return;
                        if (checkHooks.operation === 'finish') {
                            turnRejected = false;
                        } else {
                            turnRejected = true;
                            turnRejectedReason = checkHooks.message;
                        }
                    }

                    if (turnRejected === false) {
                        shouldScheduleSessionMemoryUpdate = true;
                        break;
                    } else {
                        hookRejectCount++;
                        if (hookRejectCount >= 10) {
                            logger.warn(
                                `task ${this.task_id}: beforeFinishTurn hook rejected ${hookRejectCount} times consecutively, force-ending turn`
                            );
                            shouldScheduleSessionMemoryUpdate = true;
                            break;
                        }
                        const backoffMs = 5_000;
                        logger.info(
                            `task ${this.task_id}: hook rejected (attempt ${hookRejectCount}), backing off ${backoffMs}ms before retry`
                        );
                        await new Promise((resolve) => setTimeout(resolve, backoffMs));
                        if (this._turnGeneration !== myGeneration) return;
                        await this.appendInternalUserMessage(turnRejectedReason);
                        const assistant_message = new AssistantMessage();
                        this.chat_context.appendMessage(assistant_message);
                        continue;
                    }
                } catch (iterationErr) {
                    logger.error(
                        `task ${this.task_id}: turn iteration crashed: ${(iterationErr as Error)?.message || String(iterationErr)}`
                    );
                    // 异常后任务标记为 stopped，安全退出
                    this.task_status = 'stopped';
                    this.finished_at = new Date();
                    break;
                }
            }

            // 清理代码：仅在未被新 turn 取代时执行
            if (this._turnGeneration !== myGeneration) return;

            if (this.task_status !== 'stopped') {
                this.task_status = 'stopped';
            }
            await this.hooks.noticeAfterFinishTurn(this);
            if (this._turnGeneration !== myGeneration) return;
            const completedAt = new Date();
            this.finished_at = completedAt;
            if (shouldScheduleSessionMemoryUpdate) {
                this.recordMicrocompactAssistantCompleted(completedAt);
            }
            this.persistLater();
            this.sendSubscriptionFeedback();
            this.task_manager_state.publishTaskListUpdate();
            if (shouldScheduleSessionMemoryUpdate) {
                this.scheduleSessionMemoryUpdateAfterCompletion(modelRequestOptions);
            }
        } finally {
            if (this._turnGeneration === myGeneration) {
                this._turnRunning = false;
            }
        }
    }

    async render() {
        for (const message of this.chat_context.messages) {
            await message.render();
        }
    }

    addSubscriber(subscriber: BaseTaskUpdateSubscriber) {
        this.subscribers.push(subscriber);
        return subscriber.subscription_id;
    }

    /**
     * Remove a subscriber for task update
     * @param subscription_id the subscription id
     * @returns true if the subscriber was removed, false otherwise
     */
    removeSubscriber(subscription_id: string) {
        const subscriber = this.subscribers.find((s) => s.subscription_id === subscription_id);
        if (subscriber === undefined) {
            logger.error('subscriber not found for task', this.task_id);
            return false;
        }

        this.subscribers = this.subscribers.filter((s) => s.subscription_id !== subscription_id);
        logger.info('task update subscriber removed for task', this.task_id);
        return true;
    }
}

export class BaseTaskManagerUpdateSubscriber {
    subscription_id: string = crypto.randomUUID();

    isAvailable() {
        return true;
    }

    send(_taskList: object[]): void {
        throw new Error('send not implemented');
    }
}

export class TaskManagerState {
    tasks: TaskState[] = [];
    subscribers: BaseTaskManagerUpdateSubscriber[] = [];
    toolsetProvider: ToolsetProvider = new EmptyToolsetProvider();
    private _deletedTaskIds: Set<string> = new Set();

    /**
     * Load the task manager state from the file system
     * @returns the task manager state, or null if the files does not exist
     */
    static load(): TaskManagerState | null {
        const taskDirectory = getTaskDirectory();
        const taskListFile = path.join(taskDirectory, 'task_list.json');
        if (!fs.existsSync(taskListFile)) {
            logger.info('task_list.json not found, attempting to rebuild from task files...');
            return TaskManagerState.rebuildTaskListFromDirectory();
        }

        const taskManagerState = new TaskManagerState();
        let taskList: { task_id: string }[];
        try {
            taskList = JSON.parse(fs.readFileSync(taskListFile, 'utf8'));
        } catch (err) {
            logger.error(`failed to parse task_list.json: ${err}, falling back to directory scan...`);
            return TaskManagerState.rebuildTaskListFromDirectory();
        }
        for (const task of taskList) {
            try {
                taskManagerState.tasks.push(
                    TaskState.load(path.join(taskDirectory, `${task.task_id}.json`), taskManagerState)
                );
            } catch (err) {
                logger.warn(`error loading task ${task.task_id}: ${err}`);
                continue;
            }
        }
        if (taskManagerState.tasks.length > 0) {
            return taskManagerState;
        }
        // task_list.json 有条目但所有任务文件都加载失败，尝试从目录恢复
        logger.warn('all tasks in task_list.json failed to load, falling back to directory scan...');
        return TaskManagerState.rebuildTaskListFromDirectory();
    }

    /**
     * 从任务目录中扫描所有任务 JSON 文件，重建 task_list.json。
     * 用于 task_list.json 丢失后的自动恢复以及 /recover tasks 命令。
     * @returns 重建后的 TaskManagerState，若无有效任务文件则返回 null
     */
    static rebuildTaskListFromDirectory(): TaskManagerState | null {
        const taskDirectory = getTaskDirectory();
        let files: string[];
        try {
            files = fs.readdirSync(taskDirectory);
        } catch {
            return null;
        }

        const taskManagerState = new TaskManagerState();

        for (const file of files) {
            if (!file.endsWith('.json') || file === 'task_list.json' || file.endsWith('.tmp')) {
                continue;
            }

            const filePath = path.join(taskDirectory, file);
            try {
                const task = TaskState.load(filePath, taskManagerState);
                taskManagerState.tasks.push(task);
                logger.info(`recovered task: ${task.task_id} (${task.task_name ?? 'unnamed'})`);
            } catch (err) {
                logger.warn(`skipping unrecoverable task file ${file}: ${err}`);
                continue;
            }
        }

        if (taskManagerState.tasks.length === 0) {
            return null;
        }

        taskManagerState.tasks.sort((a, b) => {
            const aTime = (a.updated_at ?? a.started_at)?.getTime() ?? 0;
            const bTime = (b.updated_at ?? b.started_at)?.getTime() ?? 0;
            return aTime - bTime;
        });

        taskManagerState.saveSync();
        logger.info(`task list rebuilt: ${taskManagerState.tasks.length} task(s) recovered`);
        return taskManagerState;
    }

    private _saveTimer?: ReturnType<typeof setTimeout>;
    private _lastWritePromise: Promise<void> = Promise.resolve();
    private _savePendingAfterTimer: boolean = false;
    private static SAVE_THROTTLE_MS = 2000;

    /**
     * Schedule an async throttled write of all tasks to disk.
     * Multiple calls within the throttle window are coalesced into a single write
     * of the latest state snapshot, keeping the event loop free for UI rendering.
     *
     * 如果在 timer 等待期间再次调用 save()，会标记 _savePendingAfterTimer，
     * 确保 timer 触发写入后再安排一次写入以捕获最新状态。
     */
    save(): void {
        if (this._saveTimer) {
            this._savePendingAfterTimer = true;
            return;
        }
        this._saveTimer = setTimeout(() => {
            this._saveTimer = undefined;
            const hadPending = this._savePendingAfterTimer;
            this._savePendingAfterTimer = false;
            this._lastWritePromise = this._writeAll()
                .catch((err) => {
                    logger.error(`async save failed: ${err}`);
                })
                .finally(() => {
                    if (hadPending || this._savePendingAfterTimer) {
                        this._savePendingAfterTimer = false;
                        this.save();
                    }
                });
        }, TaskManagerState.SAVE_THROTTLE_MS);
    }

    private async _writeAll(): Promise<void> {
        const taskDirectory = getTaskDirectory();
        const taskListFile = path.join(taskDirectory, 'task_list.json');

        // 只写入在本进程中被修改过的任务文件，防止多进程互相覆盖。
        // 先快照脏任务并立即清除 _dirty 标记：如果在异步写入期间 persistLater()
        // 被调用，_dirty 会被重新设为 true，不会被本方法的后续逻辑意外覆盖。
        const dirtyTasks = this.tasks.filter((t) => t._dirty);
        for (const task of dirtyTasks) {
            task._dirty = false;
        }

        const results = await Promise.allSettled(
            dirtyTasks.map((task) => {
                const taskFile = path.join(taskDirectory, `${task.task_id}.json`);
                return _atomicWriteFile(taskFile, JSON.stringify(task.toJSON(), null, 4));
            })
        );
        for (let i = 0; i < results.length; i++) {
            if (results[i].status === 'rejected') {
                // 写入失败：恢复 _dirty 以便下次重试，并记录错误原因
                dirtyTasks[i]._dirty = true;
                logger.error(`failed to persist task ${dirtyTasks[i].task_id}: ${results[i].reason}`);
            }
            // 写入成功：_dirty 保持 false。如果写入期间 persistLater() 被调用过，
            // _dirty 已经是 true，不会被本方法覆盖，数据会在下次写入中落盘。
        }

        // 构建合并后的 task_list.json：保留其他进程写入的任务条目
        const mergedList = this._buildMergedTaskList(taskDirectory, taskListFile);
        await _atomicWriteFile(taskListFile, JSON.stringify(mergedList, null, 4));
    }

    /**
     * 构建合并后的任务列表：以内存任务为主，同时保留磁盘上由其他进程创建的任务条目。
     * 防止 CLI 和 GUI 同时运行时互相覆盖彼此的任务。
     */
    private _buildMergedTaskList(taskDirectory: string, taskListFile: string): object[] {
        const inMemoryIds = new Set(this.tasks.map((t) => t.task_id));
        const mergedList: object[] = this.tasks.map((t) => t.toSimplifiedJSON());

        try {
            if (!fs.existsSync(taskListFile)) return mergedList;
            const diskEntries: { task_id: string }[] = JSON.parse(fs.readFileSync(taskListFile, 'utf8'));
            for (const entry of diskEntries) {
                if (inMemoryIds.has(entry.task_id) || this._deletedTaskIds.has(entry.task_id)) {
                    continue;
                }
                const taskFile = path.join(taskDirectory, `${entry.task_id}.json`);
                if (fs.existsSync(taskFile)) {
                    mergedList.push(entry);
                }
            }
        } catch {
            // 读取/解析失败时仅使用内存中的任务列表
        }

        return mergedList;
    }

    /**
     * Synchronous write for operations that require immediate persistence
     * (e.g. rebuild, clear, remove — user may exit right after).
     */
    saveSync(): void {
        const taskDirectory = getTaskDirectory();
        const taskListFile = path.join(taskDirectory, 'task_list.json');

        // 只写入在本进程中被修改过的任务文件
        const dirtyTasks = this.tasks.filter((t) => t._dirty);
        for (const task of dirtyTasks) {
            const taskFile = path.join(taskDirectory, `${task.task_id}.json`);
            try {
                _atomicWriteFileSync(taskFile, JSON.stringify(task.toJSON(), null, 4));
                task._dirty = false;
            } catch (err) {
                // 写入失败保持 _dirty = true 以便后续重试
                logger.error(`failed to persist task ${task.task_id} synchronously: ${err}`);
            }
        }

        // 构建合并后的 task_list.json
        const mergedList = this._buildMergedTaskList(taskDirectory, taskListFile);
        _atomicWriteFileSync(taskListFile, JSON.stringify(mergedList, null, 4));
    }

    /**
     * Cancel any pending throttled write and perform a final synchronous write.
     * Call before process exit to ensure no data is lost.
     *
     * 循环写入直到没有脏任务为止：如果在 _writeAll() 异步写入期间有新的
     * persistLater() 调用将 _dirty 重新设为 true，循环会捕获并再次写入。
     */
    async flushAllPendingSaves(): Promise<void> {
        // 取消当前节流定时器
        if (this._saveTimer) {
            clearTimeout(this._saveTimer);
            this._saveTimer = undefined;
        }
        this._savePendingAfterTimer = false;

        // 等待正在进行的写入完成
        await this._lastWritePromise;

        // 循环写入，直到没有脏任务或达到最大重试次数。
        // 防止在写入期间新产生的脏数据被遗漏。
        const MAX_FLUSH_RETRIES = 5;
        for (let attempt = 0; attempt < MAX_FLUSH_RETRIES; attempt++) {
            // 取消可能在等待期间被 save() 启动的新定时器
            if (this._saveTimer) {
                clearTimeout(this._saveTimer);
                this._saveTimer = undefined;
            }
            this._savePendingAfterTimer = false;

            const dirtyBefore = this.tasks.some((t) => t._dirty);
            if (!dirtyBefore) {
                break;
            }
            await this._writeAll();
        }
    }

    /**
     * Clean up task files that are no longer in the current tasks list
     */
    private cleanupOldTaskFiles(): void {
        const taskDirectory = getTaskDirectory();
        const existingTaskIds = new Set(this.tasks.map((task) => task.task_id));

        fs.readdirSync(taskDirectory).forEach((file) => {
            if (file.endsWith('.json') && file !== 'task_list.json') {
                const taskIdFromFile = path.basename(file, '.json');
                if (!existingTaskIds.has(taskIdFromFile)) {
                    fs.unlinkSync(path.join(taskDirectory, file));
                }
            }
        });
    }

    /**
     * Get a simplified list of tasks. The renderer uses child task entries to
     * build nested sidebar groups, so this intentionally returns all tasks.
     * @returns {object[]} the list of tasks
     */
    getTaskList() {
        return this.tasks.map((task) => task.toSimplifiedJSON());
    }

    /**
     * 将任务移动到数组末尾，使其在列表中显示为最新（sidebar 以 reverse 顺序渲染）。
     */
    moveTaskToEnd(task: TaskState): void {
        const idx = this.tasks.indexOf(task);
        if (idx >= 0 && idx < this.tasks.length - 1) {
            this.tasks.splice(idx, 1);
            this.tasks.push(task);
        }
    }

    /**
     * Create a task from user request
     * @returns the created task
     */
    createTask(model?: string, options: { internal?: boolean; taskName?: string } = {}): TaskState {
        const task = new TaskState(this);
        if (model) {
            if (Setting.getInstance().getModelInstance(model, 'chat')) {
                task.model = model;
            } else {
                logger.warn(`task ${task.task_id} requested model "${model}" not found, using global default model`);
            }
        }
        if (options.taskName !== undefined) {
            task.task_name = options.taskName;
        }
        if (options.internal) {
            task.internal = true;
        }
        logger.info('task created', task.task_id);
        this.tasks.push(task);
        this.save();
        this.publishTaskListUpdate();
        return task;
    }

    /**
     * 为任务初始化 HarnessContext：根据 mode 创建权限引擎，设置 mode 相关属性，
     * 并调用 Platform.initPlatformHarness 注入平台特定提供者。
     */
    async initHarness(task: TaskState, workspace: string, mode: ModeDecl): Promise<void> {
        const previousExecutionHost = task.harnessContext.executionHost;
        try {
            task.harnessContext = await HarnessContext.createForMode(workspace, mode);
            task.harnessContext.executionHost = previousExecutionHost;
            task.workspace = workspace;
            task.activeModeId = mode.id;
            task.allowedTools = mode.allowedTools;
            task.disabledTools = mode.disabledTools;
            await task.harnessContext.grantTaskArtifactAccess(getTaskArtifactDirectory(task.task_id, false));
            await getPlatform().initPlatformHarness(task);
        } catch (err) {
            logger.warn(`Failed to init task harness, using empty context: ${err}`);
            task.harnessContext = HarnessContext.createEmpty();
            task.harnessContext.workspace = workspace;
            task.harnessContext.executionHost = previousExecutionHost;
            task.workspace = workspace;
        }
    }

    /**
     * 将 prompt 分发给指定 Agent 执行：创建任务、初始化 harness、提交消息。
     * @param agentName Agent 名称（'main' 或 AgentRegistry 中注册的名称）
     * @param modeName 使用的 Mode 名称，undefined 则使用 Agent 的默认 Mode
     * @param prompt 要提交的用户消息
     * @returns 创建好的 TaskState（已提交消息，任务开始执行）
     */
    async dispatchPromptToAgent(
        agentName: string,
        modeName: string | undefined,
        prompt: string,
        options?: { workspace?: string; origin?: Participant }
    ): Promise<TaskState> {
        // 解析 Agent
        let agentDecl: AgentDecl;
        if (agentName === 'main') {
            agentDecl = new MainAgentDecl();
        } else {
            const registered = AgentRegistry.getAgent(agentName);
            if (!registered) {
                throw new Error(`Agent "${agentName}" not found in AgentRegistry`);
            }
            agentDecl = registered;
        }

        // 解析 Mode
        const modes = agentDecl.supportedModes();
        const targetModeId = modeName || agentDecl.defaultModeId();
        const activeMode = modes.find((m) => m.id === targetModeId) ?? modes[0];

        // 获取 workspace
        const workspace = options?.workspace || getPlatform().getEffectiveWorkspace();

        // 创建任务
        const task = this.createTask();

        // 设置 origin（需在 submitUserMessage 之前，以便 buildToolsets 中 isAvailable 能读取）
        if (options?.origin) {
            task.origin = options.origin;
        }

        // 先初始化 harness（设置 workspace、权限引擎等），
        // 这样 createSystemPrompt 中的 taskCtx.getWorkspace() 才能返回正确值
        await this.initHarness(task, workspace, activeMode);

        // 构建 system prompt 并设置
        const systemPrompt = await agentDecl.createSystemPrompt(activeMode, task);
        task.setSystemPrompt(systemPrompt);

        // 触发 beforeTaskStart 钩子（在 system prompt 已设置但用户消息尚未提交时）
        await task.hooks.noticeBeforeTaskStart(task);

        // 提交用户消息
        await task.submitUserMessage(prompt);

        return task;
    }
    /**
     * Create a sub-task for tool isolation (新增方法)
     * @param {string} parentId
     * @returns {TaskState}
     */
    createSubTask(parentId: string) {
        const subTask = new TaskState(this, parentId);
        this.tasks.push(subTask);
        this.save();
        return subTask;
    }
    /**
     * Remove a task by its id (Recursive deletion)
     * @param {string} taskId
     */
    removeTask(taskId: string) {
        const taskToRemove = this.getTask(taskId);
        if (!taskToRemove) {
            logger.warn(`Task ${taskId} not found for deletion.`);
            return;
        }

        const removedIds = new Set<string>();
        this._removeTaskRecursive(taskId, removedIds);

        if (removedIds.size > 0) {
            this.tasks = this.tasks.filter((t) => !removedIds.has(t.task_id));
            this.publishTaskListUpdate();
            this.saveSync();
        }
    }

    private _removeTaskRecursive(taskId: string, removedIds: Set<string>) {
        const task = this.getTask(taskId);
        if (!task || removedIds.has(taskId)) return;

        task.stop('system');

        const children = this.tasks.filter((t) => t.parent_id === taskId);
        for (const child of children) {
            this._removeTaskRecursive(child.task_id, removedIds);
        }

        task.cleanup();
        removedIds.add(taskId);
        this._deletedTaskIds.add(taskId);
    }

    /**
     * Remove all tasks from the task manager
     */
    clearAllTasks(): void {
        for (const task of this.tasks) {
            this._deletedTaskIds.add(task.task_id);
            task.stop('system');
            task.cleanup();
        }
        this.tasks = [];
        this.publishTaskListUpdate();
        this.cleanupOldTaskFiles();
        this.saveSync();
    }

    /**
     * Find a task by its id
     * @returns the task, or undefined if the task is not found
     */
    getTask(taskId: string): TaskState | undefined {
        return this.tasks.find((task) => task.task_id === taskId);
    }

    publishTaskListUpdate() {
        const isSubscriberAvailable = (subscriber: BaseTaskManagerUpdateSubscriber) =>
            typeof subscriber.isAvailable !== 'function' || subscriber.isAvailable();

        this.removeSubscriberByFilter(isSubscriberAvailable);
        if (this.subscribers.length === 0) return;

        const taskList = this.getTaskList();
        const failedSubscriptionIds = new Set<string>();
        for (const subscriber of this.subscribers) {
            try {
                subscriber.send(taskList);
            } catch (err) {
                failedSubscriptionIds.add(subscriber.subscription_id);
                logger.warn(
                    `failed to publish task list update to subscriber ${subscriber.subscription_id}: ${(err as Error)?.message || String(err)}`
                );
            }
        }

        if (failedSubscriptionIds.size > 0) {
            this.removeSubscriberByFilter(
                (subscriber) =>
                    isSubscriberAvailable(subscriber) && !failedSubscriptionIds.has(subscriber.subscription_id)
            );
        }
    }

    /**
     * Add a subscriber for task list update
     * @param subscriber the subscriber to add
     */
    addSubscriber(subscriber: BaseTaskManagerUpdateSubscriber) {
        this.subscribers.push(subscriber);
        return subscriber.subscription_id;
    }

    /**
     * Remove a subscriber for task list update
     * @param {Electron.WebContents} webContents
     */
    removeSubscriber(subscription_id: string) {
        const subscriber = this.subscribers.find((s) => s.subscription_id === subscription_id);
        if (subscriber === undefined) {
            logger.warn('subscriber not found for task list update');
            return false;
        }
        this.subscribers = this.subscribers.filter((s) => s.subscription_id !== subscription_id);
        return true;
    }

    removeSubscriberByFilter(filter: (subscriber: BaseTaskManagerUpdateSubscriber) => boolean) {
        this.subscribers = this.subscribers.filter(filter);
    }
}
