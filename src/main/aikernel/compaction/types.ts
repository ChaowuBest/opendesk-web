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

import type {
    AssistantMessage,
    AssistantMessagePart,
    ChatMessage,
    CompactSeparatorMessage,
    UserMessage
} from '../messages.js';
import type {
    MicrocompactAnalysisResult,
    MicrocompactCandidate,
    MicrocompactDecision,
    MicrocompactMode,
    MicrocompactStats
} from './microcompact.js';
import type { AutoCompactDecision, AutoCompactState } from './auto-compact.js';
import type { VisibleContextTokenEstimate } from './token-estimation.js';
import type {
    SessionMemoryCompactOptions,
    SessionMemoryCompactRunResult,
    SessionMemoryState
} from './session-memory-compact.js';
import type { MicrocompactState } from './microcompact-state.js';
import type {
    ToolResultReplacementState,
    ToolResultPreviewOptions,
    ToolResultBudgetProjectionStats
} from './tool-results.js';
import type { LLMRequestOptions } from '../llm.js';

export interface CompactBoundaryRef {
    index: number;
    message: CompactSeparatorMessage;
}

export interface ActiveContextView {
    startIndex: number;
    messages: ChatMessage[];
    boundary?: CompactBoundaryRef;
    leadingPartialAssistant?: ActiveContextLeadingPartialAssistant;
}

export interface ProjectedActiveContextView extends ActiveContextView {
    projectedItems: ProjectedContextItem[];
}

/**
 * 单条 AssistantMessage 内部某个逻辑 round 的稳定引用。
 * 当前粒度只到 message.content 的 part 边界，不进入 part 内部。
 */
export interface AssistantRoundRef {
    assistantMessageId: string;
    roundIndex: number;
    startPartIndex: number;
    endPartIndexExclusive: number;
}

/**
 * assistant 内部 round 的结束方式：
 * - tool_call_batch: 以一个 tool_call part 结束
 * - message_tail: 以消息末尾结束，末尾不包含 tool_call part
 */
export type AssistantRoundKind = 'tool_call_batch' | 'message_tail';

export interface AssistantRound {
    ref: AssistantRoundRef;
    kind: AssistantRoundKind;
    parts: AssistantMessagePart[];
    toolCallCount: number;
}

export interface ActiveContextLeadingPartialAssistant {
    message: AssistantMessage;
    messageIndex: number;
    roundRef: AssistantRoundRef;
}

export interface VisibleAssistantRound {
    message: AssistantMessage;
    assistantMessageIndex: number;
    messageIndex: number;
    round: AssistantRound;
    roundRef: AssistantRoundRef;
}

export interface BaseProjectedContextItem {
    kind: 'compact_boundary' | 'user_message' | 'assistant_round';
    messageIndex: number;
    messageId: string;
}

export interface ProjectedBoundaryContextItem extends BaseProjectedContextItem {
    kind: 'compact_boundary';
    boundary: CompactBoundaryRef;
    message: CompactSeparatorMessage;
}

export interface ProjectedUserContextItem extends BaseProjectedContextItem {
    kind: 'user_message';
    message: UserMessage;
}

export interface ProjectedAssistantRoundItem extends BaseProjectedContextItem {
    kind: 'assistant_round';
    message: AssistantMessage;
    round: AssistantRound;
    roundRef: AssistantRoundRef;
}

export type ProjectedContextItem =
    | ProjectedBoundaryContextItem
    | ProjectedUserContextItem
    | ProjectedAssistantRoundItem;

export type MicrocompactRequestKind = 'task_turn' | 'pre_submit_check' | 'view_only' | 'manual_compact';

export type MicrocompactTaskRole = 'main' | 'subtask';

export interface PrepareContextOptions {
    readonlyOnly?: boolean;
    beforeCompact?: () => void;
    executeCompact?: () => Promise<boolean | void> | boolean | void;
    enableToolResultBudget?: boolean;
    enableMicrocompact?: boolean;
    /** Defaults to true; set false to roll back pipeline compaction to message-granularity boundaries. */
    enableAssistantRoundBoundary?: boolean;
    enableSessionMemoryCompact?: boolean;
    autoCompactState?: AutoCompactState;
    sessionMemoryState?: SessionMemoryState;
    sessionMemoryCompactOptions?: SessionMemoryCompactOptions;
    /** 可选的自动压缩决策注入，主要用于单元测试稳定控制 pipeline 分支。 */
    autoCompactDecisionOverride?: AutoCompactDecision;
    taskId?: string;
    toolResultReplacementState?: ToolResultReplacementState;
    toolResultBudgetChars?: number;
    toolResultBudgetPreviewOptions?: ToolResultPreviewOptions;
    skipToolNames?: Iterable<string>;
    microcompactState?: MicrocompactState;
    microcompactRequestKind?: MicrocompactRequestKind;
    microcompactTaskRole?: MicrocompactTaskRole;
    microcompactModeOverride?: MicrocompactMode;
    microcompactIdleGapMinutes?: number;
    microcompactKeepRecentResults?: number;
    microcompactTailAssistantMessages?: number;
    microcompactSkipToolNames?: Iterable<string>;
    /** Runtime-only model request options, such as server-forwarded headers. */
    requestOptions?: LLMRequestOptions;
}

export interface PreparedContextResult {
    activeContext: ActiveContextView;
    /** Token estimate used to compute the auto-compact decision before any full compact rerun. */
    contextTokenEstimate: VisibleContextTokenEstimate;
    autoCompactDecision: AutoCompactDecision;
    autoCompactState?: AutoCompactState;
    autoCompactStateChanged: boolean;
    shouldCompact: boolean;
    compacted: boolean;
    sessionMemoryCompacted: boolean;
    budgetApplied: boolean;
    microcompactApplied: boolean;
    microcompactMode?: MicrocompactMode;
    microcompactDecision?: MicrocompactDecision;
    toolResultOverrides: Map<string, string>;
    toolResultReplacementState?: ToolResultReplacementState;
    toolResultBudgetStats?: ToolResultBudgetProjectionStats;
    sessionMemoryCompactResult?: SessionMemoryCompactRunResult;
    sessionMemoryState?: SessionMemoryState;
    microcompactState?: MicrocompactState;
    microcompactAnalysis?: MicrocompactAnalysisResult;
    microcompactAppliedCandidates: MicrocompactCandidate[];
    microcompactStats?: MicrocompactStats;
    toolResultStateChanged: boolean;
    microcompactStateChanged: boolean;
    sessionMemoryStateChanged: boolean;
}
