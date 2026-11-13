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

import type { UserMessagePart, AssistantMessagePart, Usage, RuntimeMetadata } from '../messages.js';
import type { LLMRequestOptions } from '../llm.js';
import type { InteractiveToolset } from '../tool.js';
import type { PermissionPromptProvider } from '../security/permission.js';
import type { TaskTurnInstrumentationExternalContext } from '../../telemetry/agent-execution.js';
import type { TaskUsageSummary } from '../../telemetry/local-telemetry.js';

/**
 * 任务状态。
 * 'failed' 有两种产生路径：运行期 turn 以不可恢复的模型错误自然终止（见
 * TaskState 的 turn 收尾逻辑）；以及应用退出/崩溃时落盘的 running 任务，
 * 下次启动加载时被改写为 failed（见 serializer.applyTaskJson）。
 */
export type TaskStatus = 'waiting' | 'running' | 'stopped' | 'failed';
export type TaskCompletionStatus = 'success' | 'fail' | 'ask';

/**
 * 任务当前「在途/最后一条 assistant 消息」的实时 token 用量。
 * 与主界面（taskview）的消息级展示同源（last_message.usage），随流式逐 chunk 更新；
 * 而 usage_summary 仅在请求完成时叠加。
 */
export interface TaskLiveUsageSnapshot {
    message_id: string;
    /** 消息 turn 的开始时间（毫秒时间戳，来自 execution.startAt），用于判断该消息的请求是否已提交进 usage_summary。 */
    message_timestamp?: number;
    usage: Usage;
}

/** 任务 token 用量快照：累计（usage_summary）+ 在途消息实时用量。 */
export interface TaskUsageSnapshot {
    /** 任务级累计 token 用量（随请求完成更新，与个人中心任务统计同源）。 */
    usage_summary?: TaskUsageSummary;
    /** 当前在途/最后一条 assistant 消息的实时用量。 */
    live?: TaskLiveUsageSnapshot;
}

export interface TailCardSectionEntry {
    id: string;
    content: string;
}

export interface TaskRuntimeInterrupt {
    requested: boolean;
    reason: string;
    requestedAt: string;
    turnGeneration?: number;
    handledAt?: string;
    skipFinishHooks?: boolean;
}

export type TaskModelRequestOptions = LLMRequestOptions;

export interface SubmitUserMessageOptions {
    imageDataUris?: string[];
    modelRequestOptions?: TaskModelRequestOptions;
    instrumentationContext?: TaskTurnInstrumentationExternalContext;
    /**
     * 本次 turn 是否由用户交互发起，决定是否挂载交互工具集（askUser / exitPlanMode）。
     * 内部/自动化流程（子任务、agentoffice、headless、channel 等）应保持默认 false。
     */
    interactive?: boolean;
}

export interface ProcessTaskTurnOptions {
    generation?: number;
    modelRequestOptions?: TaskModelRequestOptions;
    instrumentationContext?: TaskTurnInstrumentationExternalContext;
}

/**
 * 单个 turn 的交互归属绑定（运行时状态，不持久化）。
 *
 * 每个 turn 起点由发起入口现场声明：渠道入站消息发起的一轮，权限审批与 askUser
 * 发给渠道用户；桌面 / TUI / ACP 等入口发起的一轮沿用任务默认 provider。
 * 字段为 undefined 表示沿用任务默认（harnessContext.permissionPrompt / TaskState.interactionToolset）。
 */
export interface TurnInteractionBinding {
    /** 本 turn 是否由用户交互发起，决定是否挂载交互工具集（askUser / exitPlanMode）。 */
    interactive: boolean;
    /** 本 turn 的权限审批 provider；省略沿用任务默认，null 表示本轮直接拒绝（无确认界面）。 */
    permissionPrompt?: PermissionPromptProvider | null;
    /**
     * 本 turn 的交互工具集；省略沿用任务默认。null 表示本轮没有入口侧工具集
     * （interactive 为 true 时仍会按需从 platform 补建，为 false 时一律不挂载）。
     */
    interactionToolset?: InteractiveToolset | null;
}

export interface StartInternalTurnOptions {
    prompt: string;
    /** Optional user-facing command text used by renderers while keeping prompt internal. */
    rawText?: string;
    source: string;
    metadata: RuntimeMetadata;
}

export interface InterruptRunningTurnOptions {
    reason: TaskRuntimeInterrupt['reason'];
    stopRunningTools?: boolean;
    cancelPermissionPrompts?: boolean;
    userInitiated?: boolean;
    skipFinishHooks?: boolean;
}

export interface TaskUpdateUserChunk {
    type: 'user';
    task_id: string;
    task_status: TaskStatus;
    message_id: string;
    last_part_index: number;
    last_part: UserMessagePart;
    isLastPart?: boolean;
    rawText?: string;
    metadata?: RuntimeMetadata;
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
    /** Marks an active text/reasoning part so the GUI can use its streaming layout. */
    streaming?: boolean;
    provisional?: 'implicit_think_close_candidate';
    usage?: Usage;
}

export interface TaskUpdateAssistantReplaceChunk {
    type: 'assistant_replace';
    task_id: string;
    task_status: TaskStatus;
    message_id: string;
    parts: AssistantMessagePart[];
    /**
     * 增量 replace：parts 仅携带消息尾部 N 个 part，之前的 parts 自上一次发给
     * 该订阅方的 replace 后未变化，由消费方用本地缓存回填。省略时为全量快照
     * （旧语义）。仅发给声明 supportsReplaceDelta 的订阅方。
     */
    unmodifiedTail?: number;
    /**
     * 消息级定型标记：本条消息内容已定稿（最终渲染已完成），前端据此停止
     * 流式展示。与 task_status 语义无关——定型快照发出时任务可能仍在
     * running（如 hook 拒绝后的续跑等待期），task_status 必须携带真实值。
     */
    finalized?: boolean;
    usage?: Usage;
    metadata?: RuntimeMetadata;
}

export interface TaskUpdateUserReplaceChunk {
    type: 'user_replace';
    task_id: string;
    task_status: TaskStatus;
    message_id: string;
    parts: UserMessagePart[];
    rawText?: string;
    metadata?: RuntimeMetadata;
    internal?: boolean;
    timestamp?: number;
}

export interface TaskUpdateCompactChunk {
    type: 'compact';
    task_id: string;
    task_status: TaskStatus;
    phase: 'start' | 'end';
    trigger: 'auto' | 'manual';
    compacted?: boolean;
    boundary?: {
        role: 'compact_separator';
        message_id: string;
        trigger?: string;
        kept_anchor_message_id?: string;
        kept_anchor_start_part_index?: number;
    };
    before_message_id?: string;
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

export interface TaskUpdateGoalEvalChunk {
    type: 'goal_eval';
    task_id: string;
    task_status: TaskStatus;
    goalId?: string;
    goalRevision?: number;
    evaluationId?: string;
    anchorMessageId?: string;
    anchorMessageIndex?: number;
    phase: 'start' | 'end';
    status?: 'met' | 'not_met' | 'blocked' | 'error' | 'superseded' | 'cancelled';
    message?: string;
    evidence?: string[];
    startedAt?: string;
    evaluatedAt?: string;
    updatedAt?: string;
}

export type TaskUpdateChunk =
    | TaskUpdateUserChunk
    | TaskUpdateAssistantChunk
    | TaskUpdateUserReplaceChunk
    | TaskUpdateAssistantReplaceChunk
    | TaskUpdateRetryChunk
    | TaskUpdateCompactChunk
    | TaskUpdateGoalEvalChunk;

export const ATTEMPT_COMPLETION_TOOL_NAME = 'planning-attemptCompletion';

export const LLM_RETRY_MIN_DELAY_MS = 10_000;
export const LLM_RETRY_MAX_DELAY_MS = 10 * 60 * 1000;

export function getLLMRetryDelayMs(attempt: number): number {
    const exponent = Math.max(0, attempt - 1);
    return Math.min(LLM_RETRY_MIN_DELAY_MS * Math.pow(2, exponent), LLM_RETRY_MAX_DELAY_MS);
}

export function errorToMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
