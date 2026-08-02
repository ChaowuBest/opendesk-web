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
    AssistantMessage,
    TextMessagePart,
    FileMessagePart,
    ImageMessagePart,
    SystemMessage,
    Usage,
    ToolCall,
    ToolCallMessagePart,
    ReasoningMessagePart,
    CompactSeparatorMessage,
    extractImagePaths,
    imageToDataUri,
    type RuntimeMetadata
} from '../messages.js';
import { prepareContextForModel } from '../compaction/pipeline.js';
import { logCompactInfo } from '../compaction/compact-trace.js';
import type { ActiveContextView, MicrocompactTaskRole } from '../compaction/types.js';
import { compactContext } from '../compact.js';
import { BaseTool, BaseToolset } from '../tool.js';
import { LLM } from '../llm.js';
import {
    buildEvidenceCardRuntimeTail,
    createEvidenceCardState,
    getEvidenceCardSettings,
    recordEvidenceCardToolCall,
    syncEvidenceCardTaskState,
    type EvidenceCardState
} from '../../utils/evidencecard.js';
import { Setting, getTaskArtifactDirectory, getTaskDirectory, type ReasoningEffort } from '../../utils/setting.js';
import { logger } from '../../utils/logger.js';
import { jsonrepair } from 'jsonrepair';
import path from 'path';
import fs from 'fs';
import { SkillRegistry } from '../skill.js';
import { FileReadStateCache } from './read-state.js';
import { TaskHooks } from '../hooks.js';
import type { Participant } from '../../plugins/types.js';
import { HarnessContext, type ExecutionHost } from '../security/harness.js';
import { escapeGlobLiteralPath } from '../security/permission.js';
import { TaskProfiler } from '../profiler.js';
import { BenchmarkUsageLedger } from '../evaluation/index.js';
import {
    addUsageToTaskSummary,
    recordTaskUsage,
    type TaskUsageSummary,
    type UsageRequestType
} from '../../telemetry/local-telemetry.js';
import { AgentExecutionInstrumentationRegistry, normalizeTurnContext } from '../../telemetry/agent-execution.js';
import { TelemetryOperation, TelemetryOperationRegistry } from '../../telemetry/operation.js';
import { getPlatform } from '../../../platforms/base.js';
import { type AgentDecl, type ModeDecl, type TaskSkillExposure } from '../agents/common.js';
import { AgentRegistry } from '../agents/registry.js';
import { assertAttachmentFilePathsSupported } from '../attachment-support.js';
import { TaskExtensionManager } from '../task-extension.js';
import type { TaskManagerState } from '../task/manager.js';
import {
    serializeTask,
    serializeTaskSimplified,
    serializeTaskForIndex,
    normalizeTaskIndexEntry,
    serializeTaskForRender,
    deserializeTask,
    loadFullTaskData,
    forkTask
} from '../task/serializer.js';
import { getTaskChangesFromTask } from '../task/changes.js';
import {
    buildToolsetsForTask,
    ensureToolsResolvedForTask,
    resolveAllToolCallsForTask,
    resolveToolForCallForTask
} from '../task/tool-resolver.js';
import { handleToolPermissionsForTask } from '../task/permission.js';
import {
    processTaskCompletion,
    isLLMRetryDelayPendingForTask,
    skipRetryDelayForTask,
    sendRetryFeedbackForTask
} from '../task/completion.js';
export type {
    DiffLine,
    DiffHunk,
    FileChangeEntry,
    FileChanges,
    TaskChangesResult,
    FileChangeOperation,
    FileChangeGroup
} from '../task/changes.js';

export type {
    TaskStatus,
    TaskCompletionStatus,
    TaskRuntimeInterrupt,
    TaskModelRequestOptions,
    SubmitUserMessageOptions,
    ProcessTaskTurnOptions,
    TaskAwareTool,
    StartInternalTurnOptions,
    InterruptRunningTurnOptions,
    TaskUpdateUserChunk,
    TaskUpdateAssistantChunk,
    TaskUpdateAssistantReplaceChunk,
    TaskUpdateUserReplaceChunk,
    TaskUpdateRetryChunk,
    TaskUpdateGoalEvalChunk,
    TaskUpdateChunk
} from '../task/types.js';
import {
    ATTEMPT_COMPLETION_TOOL_NAME,
    getLLMRetryDelayMs,
    errorToMessage,
    TaskModelRequestOptions
} from '../task/types.js';
export { ATTEMPT_COMPLETION_TOOL_NAME, getLLMRetryDelayMs };

export interface TaskCompactOptions {
    /** 仅用于本次压缩，不修改任务后续对话所使用的模型。 */
    model?: string;
    modelRequestOptions?: TaskModelRequestOptions;
}

export interface TaskCompactResult {
    compacted: boolean;
    boundary?: CompactSeparatorMessage;
    summary?: string;
}

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

export class TaskState {
    task_id: string = generateShortTaskId();
    parent_id: string | null = null;
    task_name: string | null = null;
    task_status: TaskStatus = 'waiting';
    /** Internal tasks are hidden from normal GUI task lists unless developer mode is enabled. */
    internal?: boolean;
    /** 内存标志：任务刚创建、名称待生成时为 true，submitUserMessage 后置 false。不持久化到磁盘。 */
    name_pending: boolean = false;
    private _chat_context: ChatContext = new ChatContext();
    private _unbindChatContextMessageAppend?: () => void;
    tool_result_replacement_state: ToolResultReplacementState = ToolResultReplacementStates.create();
    /** 自动压缩失败熔断状态，随 task JSON 持久化。 */
    auto_compact_state: AutoCompactState = AutoCompactStates.create();
    /** task-local microcompact 状态，供后续 Phase 3/5 策略与冷启动路径使用。 */
    microcompact_state: MicrocompactState = MicrocompactStates.create();
    /** task-local session memory 状态，文件位于 artifacts/<taskId>/session-memory/。 */
    session_memory_state: SessionMemoryState = SessionMemoryStates.create();
    runtimeInterrupt?: TaskRuntimeInterrupt;
    private file_read_state = new FileReadStateCache();
    benchmark_usage?: BenchmarkUsageLedger;
    enableEvidenceCard: boolean = false;
    evidencecard_state: EvidenceCardState = createEvidenceCardState(false);

    /**
     * 脏标记：标识本任务在当前进程中是否被修改过。
     * 仅被标记为脏的任务在 save 时才会写入磁盘，
     * 防止多进程同时运行时互相用过时的内存数据覆盖对方的任务文件。
     * 新创建的任务默认为 true（需要写入）；从磁盘加载的任务默认为 false。
     */
    _dirty: boolean = true;

    /**
     * 懒加载状态：当任务从 task_list.json 索引创建时，仅加载元数据字段，
     * chat_context 等重字段延迟到 ensureLoaded() 时才从磁盘读取。
     * _fullyLoaded = false 时，toSimplifiedJSON() 返回 _lazySimplifiedJSON 缓存，
     * 避免访问空 chat_context 导致数据不一致。
     */
    _fullyLoaded: boolean = true;
    _lazyFilePath?: string;
    _lazySimplifiedJSON?: object;
    /** 防止 ensureLoaded() 递归：applyTaskJson 中会访问 chat_context，此时 _fullyLoaded 尚为 false */
    private _loading: boolean = false;
    /** 任务数据文件已损坏（缺失或无法解析）。ensureLoaded() 降级时标记为 true。 */
    _corrupted: boolean = false;

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

    private _agentId: string | undefined = AgentRegistry.getMainAgent().agentId;

    /**
     * 由当前 AgentDecl 和 Mode 生成的 prompt。运行时派生，不单独触发持久化。
     */
    agent_system_prompt?: string;

    /**
     * 调用 setSystemPrompt() 设置的附加 prompt。它是任务数据的一部分，需要持久化。
     */
    custom_system_prompt?: string;

    /**
     * 当前任务对应的 Agent ID，用于筛选 agent 专属工具。
     * 修改此字段会触发任务持久化；system prompt 等派生状态不会。
     */
    get agentId(): string | undefined {
        return this._agentId;
    }

    set agentId(agentId: string | undefined) {
        if (this._agentId === agentId) return;
        this._agentId = agentId;
        this.agent_system_prompt = undefined;
        this.updateEffectiveSystemPrompt();
        if (this.task_manager_state.tasks.includes(this)) {
            this.persistLater();
        } else {
            this._dirty = true;
        }
    }

    /** 获取当前任务绑定的 Agent，并将失效的绑定修复为 main。 */
    getAgent(): AgentDecl {
        if (!this.agentId) {
            return AgentRegistry.getMainAgent();
        }
        const agent = AgentRegistry.resolveAgentReference(this.agentId);
        if (agent) {
            return agent;
        }

        const mainAgent = AgentRegistry.getMainAgent();
        if (!AgentRegistry.areApplicationAgentsReady()) {
            return mainAgent;
        }
        if (this.agentId !== mainAgent.agentId) {
            logger.warn(
                `TaskState: agent "${this.agentId}" not found for task ${this.task_id}, ` +
                    `falling back to ${mainAgent.agentId}`
            );
        }
        this.agentId = mainAgent.agentId;
        return mainAgent;
    }

    /**
     * 获取当前任务绑定 Agent 下与 activeModeId 对应的模式。
     */
    getAgentMode(): ModeDecl {
        const agent = this.getAgent();
        const modes = agent.supportedModes();
        return modes.find((candidate) => candidate.id === this.activeModeId) ?? agent.getDefaultMode();
    }

    /**
     * 由当前任务绑定的 Agent 和运行模式重建 system prompt。
     */
    async buildSystemPrompt(): Promise<string> {
        const agentSystemPrompt = this.agentId
            ? await this.getAgent().createSystemPrompt(this.getAgentMode(), this)
            : undefined;
        return this.composeSystemPrompt(agentSystemPrompt);
    }

    /**
     * 重建并安装当前任务的 system prompt。
     */
    async rebuildSystemPrompt(): Promise<void> {
        const systemPrompt = await this.buildSystemPrompt();
        this.installBuiltSystemPrompt(systemPrompt);
    }

    /**
     * 安装由 buildSystemPrompt() 生成的完整 prompt，不改变 custom_system_prompt，也不触发 dirty。
     */
    installBuiltSystemPrompt(systemPrompt: string): void {
        this.agent_system_prompt = this.extractAgentSystemPrompt(systemPrompt);
        this.chat_context.system_prompt = new SystemMessage(systemPrompt);
    }

    /**
     * 从落盘数据恢复 prompt 分层状态，同时保留 chat_context 中用于兼容和调试的完整 prompt。
     */
    restoreSystemPromptState(customSystemPrompt: unknown): void {
        this.custom_system_prompt = typeof customSystemPrompt === 'string' ? customSystemPrompt : undefined;
        const effectiveSystemPrompt = this.chat_context.system_prompt?.content;
        this.agent_system_prompt =
            typeof effectiveSystemPrompt === 'string'
                ? this.extractAgentSystemPrompt(effectiveSystemPrompt)
                : undefined;
    }

    private composeSystemPrompt(agentSystemPrompt = this.agent_system_prompt): string {
        if (agentSystemPrompt && this.custom_system_prompt) {
            return `${agentSystemPrompt}\n\n${this.custom_system_prompt}`;
        }
        return agentSystemPrompt ?? this.custom_system_prompt ?? '';
    }

    private extractAgentSystemPrompt(effectiveSystemPrompt: string): string | undefined {
        const customSystemPrompt = this.custom_system_prompt;
        if (customSystemPrompt === undefined) {
            return this.agentId ? effectiveSystemPrompt : undefined;
        }
        if (effectiveSystemPrompt === customSystemPrompt) {
            return undefined;
        }
        const suffix = `\n\n${customSystemPrompt}`;
        return effectiveSystemPrompt.endsWith(suffix) ? effectiveSystemPrompt.slice(0, -suffix.length) : undefined;
    }

    private updateEffectiveSystemPrompt(): void {
        const effectiveSystemPrompt = this.composeSystemPrompt();
        this.chat_context.system_prompt =
            effectiveSystemPrompt.length > 0 ? new SystemMessage(effectiveSystemPrompt) : undefined;
    }

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
    /**
     * 最近一次 beforeFinishTurn 计算出的终止状态（finished/interrupted/question）。
     * 运行时状态，不持久化——会话重启后之前的终止状态无意义。
     * 用于 afterFinishTurn 回调判断会话是否真正结束（而非 turn 暂停等待用户）。
     */
    lastTerminationState: 'finished' | 'interrupted' | 'question' | null = null;
    created_at: Date = new Date();
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
    /** 累计 task 级 LLM token 消耗，随 task JSON 持久化。 */
    usage_summary?: TaskUsageSummary;

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
    /** 与任务执行生命周期集成的可选领域功能。 */
    private _extensions: TaskExtensionManager;

    get extensions(): TaskExtensionManager {
        // 与 chat_context getter 同：懒加载任务不应在 ensureLoaded() 之前通过
        // extensions 访问内部状态。此处作为防御性检查，防止绕过保护的代码路径。
        // _loading 标志防止 ensureLoaded() → applyTaskJson() 内部的 extensions 访问触发递归。
        if (!this._fullyLoaded && !this._loading) {
            logger.warn(
                `extensions accessed on not-fully-loaded task ${this.task_id} — ` +
                    `this indicates a code path that bypasses ensureLoaded(). Forcing load.`
            );
            this.ensureLoaded();
        }
        return this._extensions;
    }
    /** stop() 被调用时直接 resolve 所有 waitUntilFinished 的等待者 */
    private _stopResolvers: (() => void)[] = [];
    /** 父任务被新消息中断时，仅唤醒允许转为后台执行的等待者 */
    private _parentInterruptResolvers: (() => void)[] = [];
    /** 用户在 GUI 点击"立即重试"时 resolve，跳过 waitForLLMRetryDelay 的剩余等待 */
    _retryNowResolver: (() => void) | null = null;
    /** LLM 重试等待窗口是否已经对前端可见 */
    _retryDelayPending: boolean = false;
    /** 标记 processTaskTurn 是否正在运行，stop() 据此决定是否立即发送 feedback */
    private _turnRunning: boolean = false;
    /** Turn 代数计数器，用于防止旧 turn 的清理代码干扰 submitUserMessage 发起的新 turn。 */
    private _turnGeneration: number = 0;
    private _activeTurnMetadata?: RuntimeMetadata;
    /** Step 8F: task-local session memory 后台更新锁，避免同一 task 并发抽取。 */
    private _sessionMemoryUpdatePromise?: Promise<SessionMemoryUpdateResult>;
    private _taskReviewTimer?: ReturnType<typeof setTimeout>;
    private _taskReviewGeneration: number = 0;
    private _taskReviewMessageCount: number = 0;
    private _taskReviewStartMessageIndex: number = 0;
    private _taskReviewActive: boolean = false;
    static TASK_REVIEW_IDLE_MS = 10 * 60 * 1000;

    get chat_context(): ChatContext {
        // 懒加载任务在 ensureLoaded() 之前不应访问 chat_context。
        // 所有修改路径（stop、interruptRunningTurn 等）在入口处已调用 ensureLoaded()，
        // 此处作为防御性检查，帮助在开发阶段尽早发现绕过保护的代码路径。
        // _loading 标志防止 ensureLoaded() → applyTaskJson() 内部的 chat_context 访问触发递归。
        if (!this._fullyLoaded && !this._loading) {
            logger.warn(
                `chat_context accessed on not-fully-loaded task ${this.task_id} — ` +
                    `this indicates a code path that bypasses ensureLoaded(). Forcing load.`
            );
            this.ensureLoaded();
        }
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

    ensureBenchmarkUsageLedger(): BenchmarkUsageLedger {
        if (!this.benchmark_usage) {
            this.benchmark_usage = new BenchmarkUsageLedger(this.task_id);
        }
        return this.benchmark_usage;
    }

    resolveBenchmarkUsageModelInfo(): { model?: string; provider?: string } {
        try {
            if (this.model) {
                const modelInstance = Setting.getInstance().getModelInstance(this.model, 'chat');
                if (modelInstance) {
                    return {
                        model: modelInstance.model_name,
                        provider: modelInstance.getProviderName()
                    };
                }
                return { model: this.model };
            }

            const defaultModel = Setting.getInstance().getDefaultModelInstance();
            return {
                model: defaultModel.model_name,
                provider: defaultModel.getProviderName()
            };
        } catch {
            return this.model ? { model: this.model } : {};
        }
    }

    private withUsageTelemetry(modelRequestOptions?: TaskModelRequestOptions): TaskModelRequestOptions {
        const previousOnUsage = modelRequestOptions?.onUsage;
        return {
            ...modelRequestOptions,
            onUsage: async (usage, context) => {
                if (previousOnUsage) {
                    try {
                        await previousOnUsage(usage, context);
                    } catch (error) {
                        logger.warn(`task ${this.task_id}: upstream usage callback failed: ${errorToMessage(error)}`);
                    }
                }
                await this.recordUsageTelemetry(usage, context);
            }
        };
    }

    createUsageTelemetryRequestOptions(modelRequestOptions?: TaskModelRequestOptions): TaskModelRequestOptions {
        return this.withUsageTelemetry(modelRequestOptions);
    }

    private async recordUsageTelemetry(
        usage: Usage,
        context?: { requestType: UsageRequestType; model?: string; provider?: string }
    ): Promise<void> {
        const recordedAt = new Date();
        const nextSummary = addUsageToTaskSummary(this.usage_summary, usage, recordedAt);
        if (nextSummary) {
            this.usage_summary = nextSummary;
            this.persistLater();
        }

        const modelInfo = this.resolveBenchmarkUsageModelInfo();
        await recordTaskUsage({
            taskId: this.task_id,
            taskName: this.task_name,
            parentId: this.parent_id,
            taskCreatedAt: this.created_at,
            model: context?.model ?? modelInfo.model,
            provider: context?.provider ?? modelInfo.provider,
            requestType: context?.requestType,
            turn: this._currentTurn,
            usage,
            timestamp: recordedAt
        });
    }

    constructor(task_manager_state: TaskManagerState, parent_id: string | null = null) {
        this.task_manager_state = task_manager_state;
        this.parent_id = parent_id;
        this._extensions = new TaskExtensionManager(this);
        syncEvidenceCardTaskState(this);
        this.bindChatContextMessageAppend();
    }

    getTurnGeneration(): number {
        return this._turnGeneration;
    }

    async materializeExtensionPromptTurn(prompt: string, metadata: RuntimeMetadata, rawText?: string): Promise<void> {
        const effectiveMetadata =
            this.withTurnGenerationMetadata(metadata, metadata.execution?.generation ?? this._turnGeneration) ??
            metadata;
        await this.appendInternalUserMessage(prompt, effectiveMetadata, rawText);
        const assistantMessage = new AssistantMessage();
        assistantMessage.metadata = effectiveMetadata;
        this.chat_context.appendMessage(assistantMessage);
        this._activeTurnMetadata = effectiveMetadata;
    }

    private bindChatContextMessageAppend(): void {
        this._unbindChatContextMessageAppend = this._chat_context.onMessageAppend(() => {
            this.recordTaskMessageActivityForReview();
        });
    }

    /** 记录一次用户交互，使任务进入 onTaskReview 的空闲观察窗口。 */
    recordTaskInteraction(): void {
        if (this.parent_id !== null) {
            return;
        }
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

    retainAvailableTaskUpdateSubscribers(context: string): void {
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

    publishTaskUpdate(chunkUpdate: TaskUpdateChunk, context: string): void {
        this.publishChunkUpdate(chunkUpdate, context);
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
        return deserializeTask(task_json_path, task_manager_state);
    }

    /**
     * 懒加载：如果任务仅从索引加载了元数据，此时从磁盘读取完整 JSON 文件，
     * 填充 chat_context 等重字段。多次调用安全（已加载时为 no-op）。
     */
    ensureLoaded(): void {
        if (this._fullyLoaded) return;
        if (!this._lazyFilePath) return;
        this._loading = true;
        try {
            loadFullTaskData(this, this._lazyFilePath);
        } catch (err) {
            logger.warn(
                `failed to load full task data for ${this.task_id} from ${this._lazyFilePath}: ` +
                    `${(err as Error)?.message || String(err)}. Degrading to empty task state.`
            );
            this._corrupted = true;
            // 显式重置为干净的 ChatContext，确保后续访问不会拿到半初始化的脏数据。
            // （虽然 _chat_context 在字段声明处有 new ChatContext() 默认值，
            // 但此处显式重置可防止未来有人修改默认值后引入空指针崩溃。）
            this._chat_context = new ChatContext();
        } finally {
            this._loading = false;
        }
        this._fullyLoaded = true;
        this._lazySimplifiedJSON = undefined;
        this._lazyFilePath = undefined;
    }

    toSimplifiedJSON() {
        if (!this._fullyLoaded && this._lazySimplifiedJSON) {
            return this._lazySimplifiedJSON;
        }
        return serializeTaskSimplified(this);
    }

    toIndexJSON() {
        if (!this._fullyLoaded && this._lazySimplifiedJSON) {
            return normalizeTaskIndexEntry(this._lazySimplifiedJSON as Record<string, unknown>);
        }
        return serializeTaskForIndex(this);
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

    /**
     * 从 chat_context 实时反推本会话已加载的 skill 列表（供安全网关拦截归因）。
     *
     * 取代原先持久化的 loadedSkills 字段。每条 LoadSkill 工具调用（含 LLM 主动调用
     * 与 /skillname 预加载两条路径，二者在 chat_context 中均记为 tool_name
     * 'skill-manager-LoadSkill'，见 skill.ts:369/977、tasks.ts:1703）都会在
     * chat_context 留下一条 ToolCall，其 args_object 携带 {bundleName, skillName}；
     * turn 取自所在 AssistantMessage 的 execution.generation。
     *
     * 相对旧字段的两点改进：
     * 1. /skillname 预加载路径不再漏记（旧 loadedSkills 从不 push 该路径）；
     * 2. 回退（rewindToUserMessage/rewindMessages 只 splice chat_context）后自动同步——
     *    旧字段会残留已被回退掉的幽灵 skill，此处随 chat_context 自然变短。
     *
     * @returns 按 chat_context 出现顺序、去重后的已加载 skill（含加载 turn）
     */
    getLoadedSkillsFromContext(): Array<{ bundleName: string; skillName: string; turn: number }> {
        const result: Array<{ bundleName: string; skillName: string; turn: number }> = [];
        const seen = new Set<string>();
        for (const message of this.chat_context.messages) {
            if (!(message instanceof AssistantMessage)) continue;
            const turn = message.metadata?.execution?.generation ?? 0;
            const content = Array.isArray(message.content) ? message.content : [];
            for (const part of content) {
                if (!part || part.type !== 'tool_call') continue;
                const toolcalls = Array.isArray(part.toolcalls) ? part.toolcalls : [];
                for (const tc of toolcalls) {
                    if (!tc) continue;
                    // tool_name 两条路径均写 'skill-manager-LoadSkill'；兼容个别 provider
                    // 可能返回裸名 'LoadSkill'（参考 hook.ts:511 的 endsWith 范式）。
                    if (tc.tool_name !== 'LoadSkill' && !tc.tool_name.endsWith('-LoadSkill')) continue;
                    let args: any = tc.args_object;
                    if (!args && tc.args_string) {
                        try {
                            args = JSON.parse(jsonrepair(tc.args_string));
                        } catch {
                            continue;
                        }
                    }
                    const bundleName = args?.bundleName;
                    const skillName = args?.skillName;
                    if (typeof bundleName !== 'string' || typeof skillName !== 'string') continue;
                    const key = `${bundleName}/${skillName}`;
                    if (seen.has(key)) continue; // 去重，对应 skill.ts:453 旧逻辑
                    seen.add(key);
                    result.push({ bundleName, skillName, turn });
                }
            }
        }
        return result;
    }

    toJSON() {
        return serializeTask(this);
    }

    /** 仅包含前端渲染所需的字段（不含 args_string / result 等大字段） */
    toRenderJSON() {
        return serializeTaskForRender(this);
    }

    getTaskChanges(): TaskChangesResult {
        return getTaskChangesFromTask(this);
    }

    setSystemPrompt(prompt: string) {
        if (this.custom_system_prompt === prompt) {
            this.updateEffectiveSystemPrompt();
            return;
        }
        this.custom_system_prompt = prompt;
        this.updateEffectiveSystemPrompt();
        if (this.task_manager_state.tasks.includes(this)) {
            this.persistLater();
        } else {
            this._dirty = true;
        }
    }

    refreshEvidenceCardFeatureState(): boolean {
        return syncEvidenceCardTaskState(this);
    }

    resetEvidenceCardState(): void {
        const enabled = this.refreshEvidenceCardFeatureState();
        this.evidencecard_state = createEvidenceCardState(enabled, getEvidenceCardSettings(enabled).globalBudgetTokens);
    }

    buildEvidenceCardRequestTail(activeContext?: Pick<ActiveContextView, 'messages'>): string | undefined {
        if (!this.refreshEvidenceCardFeatureState()) {
            return undefined;
        }
        const requestTail = buildEvidenceCardRuntimeTail(activeContext ?? this.chat_context, this.evidencecard_state);
        return requestTail.trim().length > 0 ? requestTail : undefined;
    }

    /**
     * 向 chat_context 追加一条内部用户消息（用户不可见），并通知前端。
     */
    async appendInternalUserMessage(content: string, metadata?: RuntimeMetadata, rawText?: string): Promise<void> {
        const user_message = new UserMessage(content);
        user_message.internal = true;
        user_message.rawText = rawText;
        user_message.metadata = metadata;
        this.chat_context.appendMessage(user_message);
        await this.sendSubscriptionFeedback();
    }

    getNextTurnGeneration(): number {
        return this._turnGeneration + 1;
    }

    private getTurnId(generation: number): string {
        return `${this.task_id}:${generation}`;
    }

    private withTurnGenerationMetadata(
        metadata: RuntimeMetadata | undefined,
        generation: number
    ): RuntimeMetadata | undefined {
        if (!metadata) return undefined;
        return {
            ...metadata,
            execution: {
                ...metadata.execution,
                turnId: metadata.execution?.turnId ?? this.getTurnId(generation),
                generation
            }
        };
    }

    applyRuntimeMetadataToAssistant(assistantMessage: AssistantMessage, metadata?: RuntimeMetadata): void {
        const effective = metadata ?? assistantMessage.metadata ?? this._activeTurnMetadata;
        if (!effective) return;
        assistantMessage.metadata = effective;
        for (const part of assistantMessage.content) {
            if (part.type !== 'tool_call') continue;
            for (const toolCall of part.toolcalls) {
                toolCall.metadata = {
                    ...effective,
                    origin: toolCall.metadata?.origin ?? effective.origin,
                    execution: {
                        ...effective.execution,
                        ...toolCall.metadata?.execution
                    }
                };
            }
        }
    }

    async startInternalTurn(options: StartInternalTurnOptions): Promise<void> {
        await this.task_manager_state.refreshLazyTaskSystemPrompt(this);
        const generation = ++this._turnGeneration;
        const metadata = this.withTurnGenerationMetadata(options.metadata, generation);
        this._activeTurnMetadata = metadata;
        this.task_status = 'running';
        this.started_at = new Date();
        this.updated_at = new Date();
        this.stop_requested_by_user = false;
        this.finished_at = undefined;
        this.clearRuntimeInterruptForNewTurn();
        this.task_manager_state.moveTaskToEnd(this);
        this.persistLater();
        this.task_manager_state.publishTaskListUpdate();

        const userMessage = new UserMessage(options.prompt);
        userMessage.internal = true;
        userMessage.rawText = options.rawText;
        userMessage.metadata = metadata;
        this.chat_context.appendMessage(userMessage);
        for (let i = 0; i < userMessage.content.length; i++) {
            await this.sendSubscriptionFeedback(i);
        }

        const assistantMessage = new AssistantMessage();
        assistantMessage.metadata = metadata;
        this.chat_context.appendMessage(assistantMessage);

        const allToolsets = await this.buildToolsets();
        this.chat_context.attachToolsets(...allToolsets);

        logger.info(`internal turn started for task ${this.task_id} (${options.source})`);
        this.processTaskTurn({
            generation,
            modelRequestOptions: this.withUsageTelemetry()
        });
    }

    rewindMessages(
        count: number,
        source: string = 'system'
    ): Array<UserMessage | AssistantMessage | CompactSeparatorMessage> {
        const actualCount = Math.min(Math.max(0, count), this.chat_context.messages.length);
        if (actualCount === 0) {
            return [];
        }
        const removed = this.chat_context.messages.splice(this.chat_context.messages.length - actualCount, actualCount);
        this.extensions.onHistoryMutation(source);
        this.resetEvidenceCardState();
        this.persistLater();
        return removed;
    }

    redoMessages(
        messages: Array<UserMessage | AssistantMessage | CompactSeparatorMessage>,
        source: string = 'system'
    ): void {
        if (messages.length === 0) {
            return;
        }
        this.chat_context.messages.push(...messages);
        this.extensions.onHistoryMutation(source);
        this.resetEvidenceCardState();
        this.persistLater();
    }

    async rewindToUserMessage(
        messageId: string,
        options: { resubmit?: boolean; source?: string } = {}
    ): Promise<{ removedCount: number; resubmitted: boolean; userMessageText: string }> {
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
        if (removedCount > 0) {
            this.chat_context.messages.splice(idx);
            this.extensions.onHistoryMutation(options.source ?? 'system');
        }
        this.resetEvidenceCardState();
        this.task_status = 'stopped';
        this.stop_requested_by_user = false;
        this.finished_at = new Date();
        this.persistLater();
        this.task_manager_state.publishTaskListUpdate();

        // 触发 onTaskRevert 钩子
        await this.hooks.noticeTaskRevert(this);

        if (options.resubmit) {
            if (attachedFilePaths.length > 0) {
                await this.attachFiles(attachedFilePaths);
            }
            await this.submitUserMessage(messageText, { imageDataUris });
        }

        return { removedCount, resubmitted: options.resubmit === true, userMessageText: messageText };
    }

    getSynchronizedToolResultReplacementState(): ToolResultReplacementState {
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
            user_message.content.push(new FileMessagePart(filePath, size, modifiedTime));
        }

        // 自动授权拖入的文件为可读，使 Agent 工具能直接读取这些文件
        if (this.harnessContext.permission) {
            for (const filePath of filePaths) {
                await this.harnessContext.permission.addRule({
                    resourceType: 'file',
                    action: 'read',
                    pathPattern: escapeGlobLiteralPath(filePath),
                    effect: 'allow'
                });
            }
        }

        this.chat_context.appendMessage(user_message);
    }

    /** 当 TUI 层已经执行过压缩时置 true，防止 submitUserMessage 重复压缩 */
    private _compactedBeforeSubmit = false;
    private _compactPromise?: Promise<TaskCompactResult>;

    /** 标记外部已经完成一次压缩，submitUserMessage 应跳过自动压缩 */
    markCompacted() {
        this._compactedBeforeSubmit = true;
    }

    getMicrocompactTaskRole(): MicrocompactTaskRole {
        return this.parent_id === null ? 'main' : 'subtask';
    }

    async compactTaskContext(options: TaskCompactOptions = {}): Promise<TaskCompactResult> {
        if (this._compactPromise) {
            return this._compactPromise;
        }

        const compactPromise = (async (): Promise<TaskCompactResult> => {
            const model = options.model ?? this.ensureValidModelOrFallback();
            const compacted = await compactContext(this.chat_context, model, {
                taskId: this.task_id,
                requestOptions: this.withUsageTelemetry(options.modelRequestOptions)
            });
            if (!compacted) {
                return { compacted: false };
            }

            const boundary = this.chat_context.findCompactBoundary()?.message;
            this.clearFileReadStateAfterContextCompaction('manual_full_compact');
            this.markCompacted();
            this.persistLater();
            return {
                compacted: true,
                boundary,
                summary: boundary?.summary
            };
        })();

        this._compactPromise = compactPromise;
        try {
            return await compactPromise;
        } finally {
            if (this._compactPromise === compactPromise) {
                this._compactPromise = undefined;
            }
        }
    }

    async manualCompact(): Promise<boolean> {
        return (await this.compactTaskContext()).compacted;
    }

    clearFileReadStateAfterContextCompaction(reason: string): void {
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
     * 将粘贴/拖入的图片 data URI 保存为文件到任务 artifacts 目录。
     * 保存后返回文件绝对路径，供模型通过 readImage / askImage 工具按需读取。
     */
    private savePastedImageToArtifacts(dataUri: string): string {
        const match = dataUri.match(/^data:([^;]+);base64,(.+)$/);
        if (!match) {
            throw new Error('invalid data URI format');
        }
        const mimeType = match[1];
        const base64Data = match[2];
        const ext = mimeType.split('/')[1]?.replace('svg+xml', 'svg') || 'png';
        const fileName = `pasted-image-${Date.now()}-${crypto.randomUUID()}.${ext}`;
        const taskArtifactDir = getTaskArtifactDirectory(this.task_id);
        const filePath = path.join(taskArtifactDir, fileName);
        fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
        return filePath;
    }

    /**
     * Submit a message to the task
     */
    async submitUserMessage(
        message: string,
        options: SubmitUserMessageOptions = {}
    ): Promise<
        | { status: 'ok'; supplementId?: string }
        | { status: 'error'; messageKey: string; messageArgs?: Record<string, unknown> }
    > {
        const instrumentationContext = normalizeTurnContext(options.instrumentationContext);
        const pendingCompact = this._compactPromise;
        if (pendingCompact) {
            try {
                await pendingCompact;
            } catch {
                // 压缩请求会向其调用方报告错误；新 turn 等待其结束后仍可继续。
            }
        }

        await this.task_manager_state.refreshLazyTaskSystemPrompt(this);
        const extensionInputResult = await this.extensions.handleUserMessage(message, options.imageDataUris);
        if (extensionInputResult) return extensionInputResult;
        const model = this.ensureValidModelOrFallback();
        const telemetryRequestOptions = this.withUsageTelemetry(options.modelRequestOptions);
        this.task_status = 'running';
        // 立即递增 _turnGeneration，让旧的 processTaskTurn 在下一个 await 点检测到
        // generation 变化后立即退出，避免旧 turn 与新 turn 并发运行造成竞态。
        const generation = ++this._turnGeneration;
        this.clearRuntimeInterruptForNewTurn();
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
        // 标记本条用户消息所属的运行代次，与 startInternalTurn 路径一致（tasks.ts:781-782）。
        // generation 已在上方 1223 行递增，此处将其写入消息元数据，使下游
        // （安全网关 skill 归因等）能从 message 反查到 turn 归属。
        user_message.metadata = {
            ...(user_message.metadata ?? {}),
            execution: {
                ...(user_message.metadata?.execution ?? {}),
                turnId: user_message.metadata?.execution?.turnId ?? this.getTurnId(generation),
                generation
            }
        };

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

        if (options.imageDataUris && options.imageDataUris.length > 0) {
            for (const dataUri of options.imageDataUris) {
                try {
                    const filePath = this.savePastedImageToArtifacts(dataUri);
                    user_message.content.push(new ImageMessagePart(dataUri, filePath));
                    logger.info(
                        `saved pasted image to artifacts: ${filePath} (${Math.round(dataUri.length / 1024)}KB)`
                    );
                } catch (err) {
                    user_message.content.push(new ImageMessagePart(dataUri));
                    logger.warn(`failed to save pasted image to artifacts, sending data URI directly: ${err}`);
                }
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
                    requestOptions: telemetryRequestOptions
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

        const autoParseThinkTags =
            Setting.getInstance().getModelInstance(
                this.model || Setting.getInstance().getData().default_model || '',
                'chat'
            )?.auto_parse_think_tags ?? false;
        logger.info(
            `task ${this.task_id}: creating AssistantMessage ` +
                `model=${this.model}, ` +
                `autoParseThinkTags=${autoParseThinkTags}`
        );
        const assistant_message = new AssistantMessage([], { allowThinkTagParsing: autoParseThinkTags });
        assistant_message.metadata = this.extensions.getAssistantMetadata(user_message.metadata);
        // 与 user_message 对称：保证 assistant 消息携带本 turn 的 generation，
        // 同时使 _activeTurnMetadata 非空，applyRuntimeMetadataToAssistant 不再 early-return（tasks.ts:763）。
        assistant_message.metadata = {
            ...(assistant_message.metadata ?? {}),
            execution: {
                ...(assistant_message.metadata?.execution ?? {}),
                turnId:
                    assistant_message.metadata?.execution?.turnId ??
                    user_message.metadata?.execution?.turnId ??
                    this.getTurnId(generation),
                generation
            }
        };
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
            const taskConfig = Setting.getInstance().getData().task_config;
            this.name_pending = false;
            if (taskConfig?.generate_taskname !== false) {
                this.task_name = '未命名任务';
                this.generateTaskName(message, telemetryRequestOptions).then(() => {
                    this.persistLater();
                    this.task_manager_state.publishTaskListUpdate();
                });
            } else {
                // 关闭自动生成时，使用用户 prompt 作为任务名（截断到 30 字符）
                this.task_name = message.length > 30 ? message.substring(0, 30) + '...' : message;
                this.persistLater();
                this.task_manager_state.publishTaskListUpdate();
            }
        }
        this._activeTurnMetadata = assistant_message.metadata;
        this.processTaskTurn({
            generation,
            modelRequestOptions: telemetryRequestOptions,
            instrumentationContext
        });
        return { status: 'ok' };
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
        // 确保任务已完全加载，否则 markInterruptedToolCalls 会访问空的 chat_context。
        // stop() 可能从 clearAllTasks() 直接遍历 this.tasks 调用（绕过 getTask()），
        // 此时任务可能处于懒加载状态。
        this.ensureLoaded();
        const alreadyStopped = this.task_status === 'stopped';

        if (!alreadyStopped) {
            this.task_status = 'stopped';
            this.stop_requested_by_user = reason === 'user';
            this.finished_at = new Date();
            logger.info(`task ${this.task_id} stopped (reason=${reason})`);
            this.harnessContext.permissionPrompt?.cancelTaskPrompts?.([this.task_id]);
            this.markInterruptedToolCalls('任务已停止');
            // 清除 LLM 重试等待状态，防止 tick 在 task_status 被 submitUserMessage
            // 改回 'running' 后继续发送 scheduled 状态
            this._retryDelayPending = false;
        }

        // 级联停止子任务：即使父任务已经 stopped，也要确保子任务被停止
        for (const task of this.task_manager_state.tasks) {
            if (task.parent_id === this.task_id && task.task_status !== 'stopped') {
                task.stop(reason);
            }
        }

        if (alreadyStopped) {
            return;
        }

        const stopResolvers = this._stopResolvers;
        const parentInterruptResolvers = this._parentInterruptResolvers;
        this._stopResolvers = [];
        this._parentInterruptResolvers = [];
        for (const resolver of [...stopResolvers, ...parentInterruptResolvers]) {
            resolver();
        }

        if (!this._turnRunning) {
            this.sendSubscriptionFeedback();
        }
        this.persistLater();
        this.task_manager_state.publishTaskListUpdate();
    }

    /**
     * 唤醒允许因父任务中断而返回的等待者，但不停止任务。
     * 用于立即发送场景下让 startSubTask 返回而子任务继续在后台运行。
     */
    resolveParentInterruptWaiters() {
        const resolvers = this._parentInterruptResolvers;
        this._parentInterruptResolvers = [];
        for (const resolver of resolvers) {
            resolver();
        }
    }

    /**
     * 中断当前任务以提交新消息（立即发送场景），但不停止正在运行的子任务。
     * 子任务会被"分离"到后台继续执行，可通过 waitSubTask 获取结果。
     * 与 stop() 的区别：不级联停止子任务，而是唤醒子任务的等待者让 startSubTask 返回。
     */
    interruptForNewMessage() {
        this.ensureLoaded();
        const alreadyStopped = this.task_status === 'stopped';

        if (!alreadyStopped) {
            this.task_status = 'stopped';
            this.stop_requested_by_user = true;
            this.finished_at = new Date();
            logger.info(`task ${this.task_id} interrupted for new message`);
            this.harnessContext.permissionPrompt?.cancelTaskPrompts?.([this.task_id]);
            this.markInterruptedToolCalls('任务已停止');
            this._retryDelayPending = false;
        }

        // 不级联停止子任务，只唤醒允许因父任务中断而返回的 startSubTask 等待者
        // 子任务继续在后台运行，通过 pendingSubTasks 注册后可用 waitSubTask 获取结果
        for (const task of this.task_manager_state.tasks) {
            if (task.parent_id === this.task_id && task.task_status !== 'stopped') {
                task.resolveParentInterruptWaiters();
            }
        }

        if (alreadyStopped) {
            return;
        }

        const stopResolvers = this._stopResolvers;
        const parentInterruptResolvers = this._parentInterruptResolvers;
        this._stopResolvers = [];
        this._parentInterruptResolvers = [];
        for (const resolver of [...stopResolvers, ...parentInterruptResolvers]) {
            resolver();
        }

        if (!this._turnRunning) {
            this.sendSubscriptionFeedback();
        }
        this.persistLater();
        this.task_manager_state.publishTaskListUpdate();
    }

    async interruptRunningTurn(options: InterruptRunningTurnOptions): Promise<void> {
        // 与 stop() 同理：确保任务已完全加载，防止访问空的 chat_context
        this.ensureLoaded();
        const requestedAt = new Date().toISOString();
        this.runtimeInterrupt = {
            requested: true,
            reason: options.reason,
            requestedAt,
            turnGeneration: this._turnGeneration,
            skipFinishHooks: options.skipFinishHooks
        };
        if (options.cancelPermissionPrompts) {
            this.harnessContext.permissionPrompt?.cancelTaskPrompts?.([this.task_id]);
        }
        if (options.stopRunningTools) {
            const stops: Promise<void>[] = [];
            for (const message of this.chat_context.messages) {
                if (!(message instanceof AssistantMessage)) continue;
                for (const part of message.content) {
                    if (part.type !== 'tool_call') continue;
                    for (const toolCall of part.toolcalls) {
                        if (
                            toolCall.tool &&
                            toolCall.status === 'running' &&
                            typeof toolCall.tool.stop === 'function'
                        ) {
                            stops.push(
                                Promise.resolve()
                                    .then(() => toolCall.tool?.stop())
                                    .catch((error) => {
                                        logger.warn(`Failed to stop tool ${toolCall.tool_name}: ${error}`);
                                    })
                            );
                        }
                    }
                }
            }
            await Promise.allSettled(stops);
        }
        if (this.task_status !== 'stopped') {
            this.task_status = 'stopped';
            this.stop_requested_by_user = options.userInitiated === true;
            this.finished_at = new Date();
            this.markInterruptedToolCalls(options.reason, options.reason);
        }

        // runtime interruption 用于暂停目标、清除目标或执行超时，必须同时终止
        // 仍在执行的子任务。只有 interruptForNewMessage 会保留子任务并将其转到后台。
        for (const task of this.task_manager_state.tasks) {
            if (task.parent_id === this.task_id && task.task_status !== 'stopped') {
                task.stop(options.userInitiated === true ? 'user' : 'system');
            }
        }

        const stopResolvers = this._stopResolvers;
        const parentInterruptResolvers = this._parentInterruptResolvers;
        this._stopResolvers = [];
        this._parentInterruptResolvers = [];
        for (const resolver of [...stopResolvers, ...parentInterruptResolvers]) {
            resolver();
        }
        if (!this._turnRunning) {
            this.runtimeInterrupt.handledAt = new Date().toISOString();
            await this.sendSubscriptionFeedback();
        }
        this.persistLater();
        this.task_manager_state.publishTaskListUpdate();
    }

    settleRuntimeInterruptIfTaskStopped(): boolean {
        if (
            this.runtimeInterrupt?.requested !== true ||
            this.runtimeInterrupt.handledAt ||
            this.task_status === 'running'
        ) {
            return false;
        }
        this.runtimeInterrupt.handledAt = new Date().toISOString();
        this.runtimeInterrupt = undefined;
        this.persistLater();
        return true;
    }

    private clearRuntimeInterruptForNewTurn(): void {
        if (this.runtimeInterrupt?.requested === true && !this.runtimeInterrupt.handledAt) {
            this.runtimeInterrupt.handledAt = new Date().toISOString();
        }
        this.runtimeInterrupt = undefined;
    }

    private finishRuntimeInterruptIfCurrentTurn(generation: number): boolean {
        if (
            this.runtimeInterrupt?.requested === true &&
            !this.runtimeInterrupt.handledAt &&
            (this.runtimeInterrupt.turnGeneration === undefined || this.runtimeInterrupt.turnGeneration === generation)
        ) {
            this.runtimeInterrupt.handledAt = new Date().toISOString();
            const shouldSkipHooks = this.runtimeInterrupt.skipFinishHooks === true;
            this.runtimeInterrupt = undefined;
            return shouldSkipHooks;
        }
        return false;
    }

    markInterruptedToolCalls(result: string, reasonCode: string = 'task_stopped'): number {
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
                    toolCall.result_object = { interrupted: true, reason: reasonCode };
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
        return isLLMRetryDelayPendingForTask(this);
    }

    /**
     * 跳过 LLM 重试的等待时间，立即发起下一次重试。
     * 从 GUI "立即重试" 按钮或 TUI /retry 命令触发。
     */
    skipRetryDelay(): boolean {
        return skipRetryDelayForTask(this);
    }

    /**
     * Wait until task_status is no longer 'running' or 'waiting'.
     *
     * @param callback  每次收到更新 chunk 时的回调
     * @param resolveOnStop  如果为 true，当 stop() 被调用时立即 resolve（用于父任务等待子任务完成的场景）；
     *                       默认 false，则等待 processTaskTurn 正常结束后通过 sendSubscriptionFeedback 触发 resolve。
     * @param resolveOnParentInterrupt 如果为 true，父任务因新消息中断时也立即 resolve，
     *                                 仅供 startSubTask 将同步子任务转为后台执行。
     */
    async waitUntilFinished(
        callback?: (updateChunk: TaskUpdateChunk) => void | Promise<void>,
        resolveOnStop: boolean = false,
        resolveOnParentInterrupt: boolean = false
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
                this._stopResolvers = this._stopResolvers.filter((resolver) => resolver !== settle);
                this._parentInterruptResolvers = this._parentInterruptResolvers.filter(
                    (resolver) => resolver !== settle
                );
                this.removeSubscriber(subscriber.subscription_id);
                resolve();
            };

            if (resolveOnStop) {
                this._stopResolvers.push(settle);
            }
            if (resolveOnParentInterrupt) {
                this._parentInterruptResolvers.push(settle);
            }

            const subscriber = new CallbackTaskUpdateSubscriber((chunkUpdate: TaskUpdateChunk) => {
                try {
                    return callback?.(chunkUpdate);
                } finally {
                    if (chunkUpdate.task_status === 'stopped') {
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
        const allSkills = await registry.getAllSkillsFlat(this.agentId);

        let updatedMessage = message;
        for (const name of matchedNames) {
            const entry = allSkills.find((e) => e.skill.frontmatter.name === name && e.skill.isUserInvocable);
            if (!entry) continue;

            try {
                const loadedSkill = await registry.getSkillForAgent(entry.bundleName, name, this.agentId);
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
        const allSkills = await registry.getAllSkillsFlat(this.agentId);

        for (const name of matchedNames) {
            // 查找 user-invocable 的 skill
            const entry = allSkills.find((e) => e.skill.frontmatter.name === name && e.skill.isUserInvocable);
            if (!entry) continue;

            const { bundleName } = entry;
            try {
                const loadedSkill = await registry.getSkillForAgent(bundleName, name, this.agentId);
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
                this.applyRuntimeMetadataToAssistant(assistantMessage);

                await AgentExecutionInstrumentationRegistry.recordToolCall({
                    taskId: this.task_id,
                    toolCall
                });
                logger.info(`preloaded skill via /skillname: ${bundleName}/${name}`);
            } catch (err) {
                logger.warn(`failed to preload skill ${name}: ${err}`);
            }
        }
    }

    async generateTaskName(user_message: string, modelRequestOptions?: TaskModelRequestOptions) {
        const operation = new TelemetryOperation('task.generate_name', {
            'task.id': this.task_id
        });
        await TelemetryOperationRegistry.aroundOperation(operation, async () => {
            const model = this.ensureValidModelOrFallback();
            const prompt = `你是一个任务管理助手，请根据以下用户消息生成一个任务名称: ${user_message}
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
                    operation.setAttribute('task.name', this.task_name);
                }
            }
        });
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
        return forkTask(this);
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
                    metadata: last_message.metadata,
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
                    provisional: last_message.isImplicitThinkCandidatePart(updated_part_index)
                        ? 'implicit_think_close_candidate'
                        : undefined,
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

            this.publishTaskUpdate(chunkUpdate, 'subscription feedback');
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
                metadata: userMessage.metadata,
                internal: userMessage.internal,
                timestamp: userMessage.timestamp
            };
            this.publishTaskUpdate(chunkUpdate, 'user message replace');
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
            this.publishTaskUpdate(chunkUpdate, 'assistant message replace');
        } catch (err) {
            logger.error(`error sending assistant message replace for task ${this.task_id}: ${errorToMessage(err)}`);
        }
    }

    async sendRetryFeedback(update: Omit<TaskUpdateRetryChunk, 'type' | 'task_id' | 'task_status'>) {
        return sendRetryFeedbackForTask(this, update);
    }

    async buildToolsets(): Promise<BaseToolset[]> {
        return buildToolsetsForTask(this);
    }

    async ensureToolsResolved() {
        return ensureToolsResolvedForTask(this);
    }

    resolveAllToolCalls() {
        return resolveAllToolCallsForTask(this);
    }

    resolveToolForCall(tool_call: ToolCall): BaseTool<any> | undefined {
        return resolveToolForCallForTask(this, tool_call);
    }

    async handleToolPermissions(
        tool: BaseTool<any>,
        args: Record<string, unknown>,
        tool_call: ToolCall
    ): Promise<boolean> {
        return handleToolPermissionsForTask(this, tool, args, tool_call);
    }

    /**
     * @returns true 表示流被 tool call 解析/创建钩子主动中断
     */
    async processCompletion(modelRequestOptions?: TaskModelRequestOptions): Promise<boolean> {
        return processTaskCompletion(this, modelRequestOptions);
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

        if (this.extensions.beforeToolCall(tool_call)) {
            return;
        }

        const profilerToken = this.profiler?.beginTool(tool_call.tool_name, this._currentTurn);

        tool_call.setTool(tool);
        try {
            let args: Record<string, unknown> = {};
            if (tool_call.args_string) {
                const repaired = jsonrepair(tool_call.args_string);
                args = JSON.parse(repaired);
                // 同步更新为修复后的合法 JSON，避免下游 sanitizeOutboundMessage
                // 因 JSON.parse 失败而清空参数
                tool_call.args_string = repaired;
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
                const permissionDenied = await handleToolPermissionsForTask(this, tool, args, tool_call);
                if (permissionDenied) {
                    return;
                }
            }

            const hookFeedback = await TelemetryOperationRegistry.aroundOperation(
                new TelemetryOperation('hook.before_tool_call', {
                    'tool.name': tool_call.tool_name
                }),
                () => this.hooks.checkBeforeToolCall(this, tool_call)
            );

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

            const toolOperation = new TelemetryOperation('tool.execute', {
                'tool.name': tool_call.tool_name
            });
            const result = await TelemetryOperationRegistry.aroundOperation(toolOperation, async () => {
                const r = await tool.execute(
                    args,
                    async (result) => {
                        tool_call.result = result.result;
                        tool_call.result_object = result.result_object;
                        await this.sendSubscriptionFeedback();
                    },
                    this
                );
                toolOperation.setAttribute('tool.status', r.status);
                return r;
            });
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
            await TelemetryOperationRegistry.aroundOperation(
                new TelemetryOperation('hook.after_tool_call', {
                    'tool.name': tool_call.tool_name,
                    'tool.status': tool_call.status
                }),
                () => this.hooks.noticeAfterToolCall(this, tool_call)
            );
            try {
                await AgentExecutionInstrumentationRegistry.recordToolCall({
                    taskId: this.task_id,
                    toolCall: tool_call
                });
            } catch (instrumentationError) {
                logger.error('TaskState.processToolCall: instrumentation error', instrumentationError);
            }
            await tool_call.freezeRenderResult();
            recordEvidenceCardToolCall(this, tool_call);
        }
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
        for (const { tool_call, partIndex } of pendingCalls) {
            if (this.extensions.beforeToolCall(tool_call)) {
                permissionResults.set(tool_call, true);
                await tool_call.render();
                await this.sendSubscriptionFeedback(partIndex);
                continue;
            }
            const tool = resolveToolForCallForTask(this, tool_call);
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
                const denied = await handleToolPermissionsForTask(this, tool, args, tool_call);
                permissionResults.set(tool_call, denied);
            }
        }

        // 阶段 2：执行所有通过权限检查的工具（已拒绝的跳过执行阶段）
        // 标记了 serialExecution 的工具（如文件写入类）按顺序串行执行，避免并发写入同一文件导致竞态条件
        // 其余工具并行执行；两组之间互相并发
        const executeOne = async ({ tool_call, partIndex }: { tool_call: ToolCall; partIndex: number }) => {
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
        };

        const serialCalls: { tool_call: ToolCall; partIndex: number }[] = [];
        const parallelCalls: { tool_call: ToolCall; partIndex: number }[] = [];
        for (const item of pendingCalls) {
            const tool = resolveToolForCallForTask(this, item.tool_call);
            if (tool?.serialExecution) {
                serialCalls.push(item);
            } else {
                parallelCalls.push(item);
            }
        }

        await Promise.all([
            // 串行执行文件写入类工具
            (async () => {
                for (const item of serialCalls) {
                    await executeOne(item);
                }
            })(),
            // 并行执行其余工具
            Promise.all(parallelCalls.map(executeOne))
        ]);

        return true;
    }

    /**
     * 执行任务的一个轮次
     *
     * 从收到消息，到反复执行工具获取结果，直到没有新的工具要执行为止，这样的过程我们
     * 称为一个轮次 (turn)。processTaskTurn 负责这个执行过程以及相关的钩子判断。
     */
    /** 当前 turn 索引，供 profiler 记录 */
    _currentTurn: number = 0;

    async processTaskTurn(options: ProcessTaskTurnOptions = {}) {
        const myGeneration = options.generation ?? ++this._turnGeneration;
        const modelRequestOptions = options.modelRequestOptions;
        this._turnRunning = true;
        const modelInfo = this.resolveBenchmarkUsageModelInfo();
        const instrumentationContext = options.instrumentationContext;
        let turnFailure: unknown;
        let userPrompt: string | undefined;
        for (let i = this.chat_context.messages.length - 1; i >= 0; i--) {
            const message = this.chat_context.messages[i];
            if (message instanceof UserMessage) {
                userPrompt = message.getPlainText().substring(0, 200);
                break;
            }
        }

        await AgentExecutionInstrumentationRegistry.aroundTaskTurn(
            {
                taskId: this.task_id,
                turnId: this._activeTurnMetadata?.execution?.turnId ?? this.getTurnId(myGeneration),
                taskName: this.task_name,
                parentTaskId: this.parent_id,
                userPrompt,
                workspace: this.getWorkspace(),
                chatContext: this.chat_context,
                externalContext: instrumentationContext,
                model: modelInfo.model,
                recordGenerations: modelInfo.provider !== 'myagent',
                metadata: {
                    taskName: this.task_name,
                    parentTaskId: this.parent_id,
                    provider: modelInfo.provider,
                    providerID: modelInfo.provider,
                    modelID: modelInfo.model,
                    ...instrumentationContext?.metadata
                },
                getOutcome: () => ({
                    taskID: this.task_id,
                    sessionID: instrumentationContext?.output?.sessionID,
                    workspace: this.getWorkspace(),
                    providerID: modelInfo.provider,
                    modelID: modelInfo.model,
                    mode: instrumentationContext?.output?.mode ?? this.activeModeId,
                    agent: instrumentationContext?.output?.agent ?? this.agentId,
                    cost: instrumentationContext?.output?.cost,
                    completedAt: this.finished_at?.getTime(),
                    failure: turnFailure,
                    metadata: {
                        providerID: modelInfo.provider,
                        modelID: modelInfo.model
                    }
                })
            },
            async () => {
                let hookRejectCount = 0;
                this._currentTurn = 0;
                await TelemetryOperationRegistry.aroundOperation(new TelemetryOperation('hook.before_turn_start'), () =>
                    this.hooks.noticeBeforeTurnStart(this)
                );
                let shouldScheduleSessionMemoryUpdate = false;

                try {
                    while (this.task_status !== 'stopped') {
                        // 在每次异步操作后检查是否被新的 turn 取代
                        if (this._turnGeneration !== myGeneration) return;

                        try {
                            const abortedByToolcallHook = await this.processCompletion(modelRequestOptions);
                            if (this._turnGeneration !== myGeneration) return;
                            // @ts-expect-error 这里的task_status可能通过前端的请求被随时中止
                            if (this.task_status === 'stopped') {
                                break;
                            }

                            // 钩子：通知 afterProcessCompletion
                            {
                                const lastMsg = this.chat_context.lastMessage();
                                if (lastMsg instanceof AssistantMessage) {
                                    this.applyRuntimeMetadataToAssistant(lastMsg);
                                    await TelemetryOperationRegistry.aroundOperation(
                                        new TelemetryOperation('hook.after_completion'),
                                        () => this.hooks.noticeAfterProcessCompletion(this, lastMsg)
                                    );
                                }
                            }

                            const materializedExtensionEvents = await this.extensions.checkpoint('after_completion', {
                                includeSupplements: false
                            });
                            if (this._turnGeneration !== myGeneration) return;
                            // @ts-expect-error 这里的task_status可能通过前端的请求被随时中止
                            if (this.task_status === 'stopped') {
                                break;
                            }
                            if (materializedExtensionEvents) {
                                hookRejectCount = 0;
                                this._currentTurn++;
                                continue;
                            }

                            const hasToolCalls = await this.processToolCalls();
                            if (this._turnGeneration !== myGeneration) return;
                            if (hasToolCalls) {
                                const materializedExtensionEventsAfterTools = await this.extensions.checkpoint(
                                    'after_tools',
                                    {
                                        includeSupplements: false
                                    }
                                );
                                if (this._turnGeneration !== myGeneration) return;
                                // @ts-expect-error 这里的task_status可能通过前端的请求被随时中止
                                if (this.task_status === 'stopped') {
                                    break;
                                }
                                if (materializedExtensionEventsAfterTools) {
                                    hookRejectCount = 0;
                                    this._currentTurn++;
                                    continue;
                                }
                                hookRejectCount = 0;
                                this._currentTurn++;
                                await this.extensions.checkpoint('after_tool_turn');
                                if (this._turnGeneration !== myGeneration) return;
                                // @ts-expect-error 这里的task_status可能通过前端的请求被随时中止
                                if (this.task_status === 'stopped') {
                                    break;
                                }

                                continue;
                            }

                            const materializedExtensionEventsBeforeFinish =
                                await this.extensions.checkpoint('before_finish');
                            if (this._turnGeneration !== myGeneration) return;
                            // @ts-expect-error 这里的task_status可能通过前端的请求被随时中止
                            if (this.task_status === 'stopped') {
                                break;
                            }
                            if (materializedExtensionEventsBeforeFinish) {
                                hookRejectCount = 0;
                                this._currentTurn++;
                                continue;
                            }

                            // 检查是否需要拒绝当前 turn
                            let turnRejected: boolean;
                            let turnRejectedReason: string = '';

                            if (abortedByToolcallHook) {
                                turnRejected = true;
                                turnRejectedReason = '';
                            } else {
                                const checkHooks = await TelemetryOperationRegistry.aroundOperation(
                                    new TelemetryOperation('hook.before_finish_turn'),
                                    () => this.hooks.checkBeforeFinishTurn(this, modelRequestOptions)
                                );
                                if (this._turnGeneration !== myGeneration) return;
                                const materializedExtensionEventsAfterHooks =
                                    await this.extensions.checkpoint('after_finish_hooks');
                                if (this._turnGeneration !== myGeneration) return;
                                // @ts-expect-error 这里的task_status可能通过前端的请求被随时中止
                                if (this.task_status === 'stopped') {
                                    break;
                                }
                                if (materializedExtensionEventsAfterHooks) {
                                    hookRejectCount = 0;
                                    this._currentTurn++;
                                    continue;
                                }
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
                                    this.extensions.onTurnIterationFailed('hook_reject_safety_cap', false);
                                    shouldScheduleSessionMemoryUpdate = true;
                                    break;
                                }
                                const backoffMs = 5_000;
                                logger.info(
                                    `task ${this.task_id}: hook rejected (attempt ${hookRejectCount}), backing off ${backoffMs}ms before retry`
                                );
                                await new Promise((resolve) => setTimeout(resolve, backoffMs));
                                if (this._turnGeneration !== myGeneration) return;
                                const materializedExtensionEventsAfterBackoff =
                                    await this.extensions.checkpoint('after_hook_backoff');
                                if (this._turnGeneration !== myGeneration) return;
                                // @ts-expect-error 这里的task_status可能通过前端的请求被随时中止
                                if (this.task_status === 'stopped') {
                                    break;
                                }
                                if (materializedExtensionEventsAfterBackoff) {
                                    hookRejectCount = 0;
                                    this._currentTurn++;
                                    continue;
                                }
                                await this.appendInternalUserMessage(turnRejectedReason);
                                const autoParseThinkTags = this.model
                                    ? (Setting.getInstance().getModelInstance(this.model, 'chat')
                                          ?.auto_parse_think_tags ?? false)
                                    : false;
                                const assistant_message = new AssistantMessage([], {
                                    allowThinkTagParsing: autoParseThinkTags
                                });
                                this.chat_context.appendMessage(assistant_message);
                                continue;
                            }
                        } catch (iterationErr) {
                            turnFailure = iterationErr;
                            logger.error(
                                `task ${this.task_id}: turn iteration crashed: ${(iterationErr as Error)?.message || String(iterationErr)}`
                            );
                            // 异常后任务标记为 stopped，安全退出
                            this.task_status = 'stopped';
                            this.finished_at = new Date();
                            this.extensions.onTurnIterationFailed('turn_iteration_failed');
                            break;
                        }
                    }

                    // 即使被新 turn 取代，也先完成当前 turn 的 runtime interrupt 清理
                    const skipInterruptedTurnHooks = this.finishRuntimeInterruptIfCurrentTurn(myGeneration);

                    // 清理代码：仅在未被新 turn 取代时执行
                    if (this._turnGeneration !== myGeneration) return;

                    if (this.task_status !== 'stopped') {
                        this.task_status = 'stopped';
                    }
                    if (!skipInterruptedTurnHooks) {
                        await this.hooks.noticeAfterFinishTurn(this);
                    } else {
                        shouldScheduleSessionMemoryUpdate = false;
                    }
                    if (this._turnGeneration !== myGeneration) return;
                    const completedAt = new Date();
                    this.finished_at = completedAt;
                    if (shouldScheduleSessionMemoryUpdate) {
                        this.recordMicrocompactAssistantCompleted(completedAt);
                    }
                    this.extensions.onTurnSettled();
                    this.persistLater();
                    this.sendSubscriptionFeedback();
                    this.task_manager_state.publishTaskListUpdate();
                    this.extensions.afterTurnFinished();
                    if (shouldScheduleSessionMemoryUpdate) {
                        this.scheduleSessionMemoryUpdateAfterCompletion(modelRequestOptions);
                    }
                } finally {
                    if (this._turnGeneration === myGeneration) {
                        this._turnRunning = false;
                        this._activeTurnMetadata = undefined;
                    }
                }
            }
        );
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

export function isTaskVisibleForDeveloperMode(
    task: Pick<TaskState, 'internal'> | null | undefined,
    developerMode: boolean
): boolean {
    return developerMode || task?.internal !== true;
}

export { TaskManagerState, BaseTaskManagerUpdateSubscriber } from '../task/manager.js';
