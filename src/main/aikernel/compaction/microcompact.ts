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

import { ChatContext, ToolCall, ToolCallMessagePart } from '../messages.js';
import { buildVisibleAssistantRounds } from './assistant-rounds.js';
import { isMicrocompactableToolName, matchesToolName } from './compactable-tools.js';
import { renderMicrocompactReplacementText } from './microcompact-render.js';
import { buildActiveContextView } from './context-view.js';
import type { MicrocompactState } from './microcompact-state.js';
import type {
    ActiveContextView,
    AssistantRoundRef,
    MicrocompactRequestKind,
    MicrocompactTaskRole,
    VisibleAssistantRound
} from './types.js';
import {
    countToolResultLines,
    ensureToolResultStorageId,
    getToolResultArtifactRelativePath,
    persistToolResultArtifactForToolCall,
    shouldPersistToolResult
} from './tool-results.js';

export { MICROCOMPACTABLE_TOOL_NAMES, isMicrocompactableToolName, matchesToolName } from './compactable-tools.js';

const DEFAULT_MICROCOMPACT_TAIL_ASSISTANT_MESSAGES = 3;
const DEFAULT_MICROCOMPACT_IDLE_GAP_MINUTES = 60;
const DEFAULT_MICROCOMPACT_KEEP_RECENT_RESULTS = 5;

export type MicrocompactSkipReason =
    | 'missing_result'
    | 'non_string_result'
    | 'empty_result'
    | 'non_compactable_tool'
    | 'level1_compressed'
    | 'already_microcompacted'
    | 'tail_protected';

interface MicrocompactBaseRecord {
    resultId: string;
    toolName: string;
    assistantMessageIndex: number;
    chatContextMessageIndex: number;
    assistantMessageId: string;
    roundIndex: number;
    roundRef: AssistantRoundRef;
    toolCallPartIndex: number;
    toolCallIndex: number;
    hasResultStorage: boolean;
    hasCompressId: boolean;
    isWithinTail: boolean;
    toolCallPart: ToolCallMessagePart;
    toolCall: ToolCall;
}

export interface MicrocompactCandidate extends MicrocompactBaseRecord {
    sizeChars: number;
    sizeLines: number;
}

export interface MicrocompactSkippedCandidate extends MicrocompactBaseRecord {
    reason: MicrocompactSkipReason;
    sizeChars?: number;
    sizeLines?: number;
}

export interface MicrocompactStats {
    assistantMessagesWithToolCalls: number;
    assistantRoundsWithToolCalls: number;
    tailAssistantMessages: number;
    tailAssistantRounds: number;
    tailProtectedCount: number;
    scannedToolCallCount: number;
    candidateCount: number;
    skippedCount: number;
    appliedCount: number;
    skippedByOverrideCount: number;
    unshrinkableCount: number;
    totalCandidateChars: number;
    totalCandidateLines: number;
    totalCharsBefore: number;
    totalCharsAfter: number;
    skippedByReason: Partial<Record<MicrocompactSkipReason, number>>;
}

export interface MicrocompactAnalysisResult {
    activeContext: ActiveContextView;
    candidates: MicrocompactCandidate[];
    skipped: MicrocompactSkippedCandidate[];
    stats: MicrocompactStats;
    tailProtectedAssistantMessageIds: string[];
    tailProtectedAssistantRoundRefs: AssistantRoundRef[];
}

export interface MicrocompactAnalysisOptions {
    /** Legacy option name kept for compatibility; the protected tail is now round-aware. */
    tailAssistantMessages?: number;
    skipToolNames?: Iterable<string>;
}

export type MicrocompactMode = 'noop' | 'request_override' | 'local_clear';

export type MicrocompactDecisionReason =
    | 'disabled'
    | 'no_candidates'
    | 'missing_task_id'
    | 'view_only'
    | 'pre_submit_check'
    | 'manual_compact'
    | 'subtask_skipped'
    | 'warm_path_request_override'
    | 'cold_path_local_clear'
    | 'mode_override';

export interface MicrocompactDecision {
    mode: MicrocompactMode;
    reason: MicrocompactDecisionReason;
    selectedResultIds: string[];
    keptRecentResultIds: string[];
    estimatedCharsBefore: number;
    estimatedCharsAfter: number;
    estimatedCharsSaved: number;
    idleGapMinutes?: number;
}

export interface MicrocompactDecisionOptions {
    enabled?: boolean;
    requestKind?: MicrocompactRequestKind;
    taskRole?: MicrocompactTaskRole;
    taskId?: string;
    modeOverride?: MicrocompactMode;
    state?: MicrocompactState;
    now?: Date;
    idleGapThresholdMinutes?: number;
    keepRecentResults?: number;
}

export interface LocalMicrocompactOptions extends MicrocompactAnalysisOptions {
    analysis?: MicrocompactAnalysisResult;
    skipResultIds?: Iterable<string>;
    selectedResultIds?: Iterable<string>;
}

export interface LocalMicrocompactResult {
    activeContext: ActiveContextView;
    analysis: MicrocompactAnalysisResult;
    appliedCandidates: MicrocompactCandidate[];
    skippedByOverrideCandidates: MicrocompactCandidate[];
    stateChanged: boolean;
    stats: MicrocompactStats;
}

export interface RequestTimeMicrocompactOptions extends MicrocompactAnalysisOptions {
    analysis?: MicrocompactAnalysisResult;
    skipResultIds?: Iterable<string>;
    selectedResultIds?: Iterable<string>;
}

export interface RequestTimeMicrocompactResult {
    analysis: MicrocompactAnalysisResult;
    overrides: Map<string, string>;
    appliedCandidates: MicrocompactCandidate[];
    skippedByOverrideCandidates: MicrocompactCandidate[];
    stateChanged: boolean;
    stats: MicrocompactStats;
}

function buildMicrocompactResultId(
    toolCall: ToolCall,
    assistantMessageId: string,
    toolCallPartIndex: number,
    toolCallIndex: number
): string {
    return (
        toolCall.result_storage?.result_id ??
        `microcompact:unstable:${assistantMessageId}:${toolCallPartIndex}:${toolCallIndex}`
    );
}

function incrementSkipReasonCounter(
    counters: Partial<Record<MicrocompactSkipReason, number>>,
    reason: MicrocompactSkipReason
): void {
    counters[reason] = (counters[reason] ?? 0) + 1;
}

function buildRoundKey(roundRef: AssistantRoundRef): string {
    return `${roundRef.assistantMessageId}:${roundRef.roundIndex}:${roundRef.startPartIndex}:${roundRef.endPartIndexExclusive}`;
}

function collectVisibleAssistantRoundsWithToolCalls(activeContext: ActiveContextView): VisibleAssistantRound[] {
    return buildVisibleAssistantRounds(activeContext).filter((round) => round.round.toolCallCount > 0);
}

function buildNoopMicrocompactDecision(reason: MicrocompactDecisionReason): MicrocompactDecision {
    return {
        mode: 'noop',
        reason,
        selectedResultIds: [],
        keptRecentResultIds: [],
        estimatedCharsBefore: 0,
        estimatedCharsAfter: 0,
        estimatedCharsSaved: 0
    };
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fallback;
    }

    return Math.max(1, Math.floor(value));
}

function normalizeNonNegativeInteger(value: unknown, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fallback;
    }

    return Math.max(0, Math.floor(value));
}

function ensureStableMicrocompactCandidateResultId(candidate: MicrocompactCandidate): boolean {
    if (candidate.hasResultStorage && candidate.toolCall.result_storage?.result_id) {
        candidate.resultId = candidate.toolCall.result_storage.result_id;
        return false;
    }

    candidate.resultId = ensureToolResultStorageId(candidate.toolCall);
    candidate.hasResultStorage = true;
    return true;
}

function estimateMicrocompactReplacementLength(candidate: MicrocompactCandidate, taskId: string): number {
    return buildMicrocompactReplacementText(candidate.toolCall, taskId, {
        persistArtifact: false
    }).length;
}

function selectShrinkableMicrocompactCandidates(
    analysis: MicrocompactAnalysisResult,
    taskId: string
): MicrocompactCandidate[] {
    return analysis.candidates.filter(
        (candidate) => estimateMicrocompactReplacementLength(candidate, taskId) < candidate.sizeChars
    );
}

function computeMicrocompactIdleGapMinutes(state: MicrocompactState | undefined, now: Date): number | undefined {
    const lastAssistantCompletedAt = state?.lastAssistantCompletedAt;
    if (typeof lastAssistantCompletedAt !== 'string' || lastAssistantCompletedAt.length === 0) {
        return undefined;
    }

    const parsed = new Date(lastAssistantCompletedAt);
    if (Number.isNaN(parsed.getTime())) {
        return undefined;
    }

    const gapMs = now.getTime() - parsed.getTime();
    if (!Number.isFinite(gapMs) || gapMs < 0) {
        return 0;
    }

    return gapMs / 60000;
}

export function selectMicrocompactCandidatesByRecentResults(
    candidates: ReadonlyArray<MicrocompactCandidate>,
    keepRecentResults: number
): {
    selected: MicrocompactCandidate[];
    keptRecent: MicrocompactCandidate[];
} {
    const normalizedKeepRecentResults = normalizeNonNegativeInteger(
        keepRecentResults,
        DEFAULT_MICROCOMPACT_KEEP_RECENT_RESULTS
    );

    if (normalizedKeepRecentResults <= 0) {
        return {
            selected: [...candidates],
            keptRecent: []
        };
    }

    if (candidates.length <= normalizedKeepRecentResults) {
        return {
            selected: [],
            keptRecent: [...candidates]
        };
    }

    return {
        selected: candidates.slice(0, candidates.length - normalizedKeepRecentResults),
        keptRecent: candidates.slice(-normalizedKeepRecentResults)
    };
}

export function shouldSkipMicrocompactToolName(toolName: string, skipToolNames?: Iterable<string>): boolean {
    if (!isMicrocompactableToolName(toolName)) {
        return true;
    }

    if (skipToolNames) {
        for (const skippedToolName of skipToolNames) {
            if (matchesToolName(toolName, skippedToolName)) {
                return true;
            }
        }
    }

    return false;
}

export function analyzeMicrocompactCandidates(
    activeContext: ActiveContextView,
    options: MicrocompactAnalysisOptions = {}
): MicrocompactAnalysisResult {
    const tailAssistantRounds = Math.max(
        0,
        Math.trunc(options.tailAssistantMessages ?? DEFAULT_MICROCOMPACT_TAIL_ASSISTANT_MESSAGES)
    );
    const assistantRoundsWithToolCalls = collectVisibleAssistantRoundsWithToolCalls(activeContext);
    const tailProtectedAssistantRounds =
        tailAssistantRounds > 0 ? assistantRoundsWithToolCalls.slice(-tailAssistantRounds) : [];
    const tailProtectedAssistantRoundKeySet = new Set(
        tailProtectedAssistantRounds.map((round) => buildRoundKey(round.roundRef))
    );
    const tailProtectedAssistantMessageIds = Array.from(
        new Set(tailProtectedAssistantRounds.map((round) => round.message.message_id))
    );
    const assistantMessagesWithToolCalls = Array.from(
        new Set(assistantRoundsWithToolCalls.map((round) => round.message.message_id))
    );

    const candidates: MicrocompactCandidate[] = [];
    const skipped: MicrocompactSkippedCandidate[] = [];
    const skippedByReason: Partial<Record<MicrocompactSkipReason, number>> = {};
    let scannedToolCallCount = 0;

    for (const visibleRound of assistantRoundsWithToolCalls) {
        const isWithinTail = tailProtectedAssistantRoundKeySet.has(buildRoundKey(visibleRound.roundRef));

        for (let roundPartIndex = 0; roundPartIndex < visibleRound.round.parts.length; roundPartIndex++) {
            const part = visibleRound.round.parts[roundPartIndex];
            if (part.type !== 'tool_call') {
                continue;
            }

            const toolCallPartIndex = visibleRound.roundRef.startPartIndex + roundPartIndex;
            for (let toolCallIndex = 0; toolCallIndex < part.toolcalls.length; toolCallIndex++) {
                const toolCall = part.toolcalls[toolCallIndex];
                const chatContextMessageIndex = visibleRound.messageIndex;
                const resultId = buildMicrocompactResultId(
                    toolCall,
                    visibleRound.message.message_id,
                    toolCallPartIndex,
                    toolCallIndex
                );
                const hasResultStorage = toolCall.result_storage !== undefined;
                const hasCompressId = toolCall.hasLegacyCompressId();
                const sizeChars = typeof toolCall.result === 'string' ? toolCall.result.length : undefined;
                const sizeLines =
                    typeof toolCall.result === 'string' ? countToolResultLines(toolCall.result) : undefined;

                scannedToolCallCount++;

                const baseRecord = {
                    resultId,
                    toolName: toolCall.tool_name,
                    assistantMessageIndex: visibleRound.assistantMessageIndex,
                    chatContextMessageIndex,
                    assistantMessageId: visibleRound.message.message_id,
                    roundIndex: visibleRound.roundRef.roundIndex,
                    roundRef: visibleRound.roundRef,
                    toolCallPartIndex,
                    toolCallIndex,
                    hasResultStorage,
                    hasCompressId,
                    isWithinTail,
                    toolCallPart: part,
                    toolCall
                };

                const pushSkipped = (reason: MicrocompactSkipReason) => {
                    skipped.push({
                        ...baseRecord,
                        reason,
                        sizeChars,
                        sizeLines
                    });
                    incrementSkipReasonCounter(skippedByReason, reason);
                };

                if (toolCall.result === undefined) {
                    pushSkipped('missing_result');
                    continue;
                }

                if (typeof toolCall.result !== 'string') {
                    pushSkipped('non_string_result');
                    continue;
                }

                if (toolCall.result.length === 0) {
                    pushSkipped('empty_result');
                    continue;
                }

                if (shouldSkipMicrocompactToolName(toolCall.tool_name, options.skipToolNames)) {
                    pushSkipped('non_compactable_tool');
                    continue;
                }

                if (hasCompressId) {
                    pushSkipped('level1_compressed');
                    continue;
                }

                if (toolCall.microcompact) {
                    pushSkipped('already_microcompacted');
                    continue;
                }

                if (isWithinTail) {
                    pushSkipped('tail_protected');
                    continue;
                }

                candidates.push({
                    ...baseRecord,
                    sizeChars: toolCall.result.length,
                    sizeLines: countToolResultLines(toolCall.result)
                });
            }
        }
    }

    return {
        activeContext,
        candidates,
        skipped,
        stats: {
            assistantMessagesWithToolCalls: assistantMessagesWithToolCalls.length,
            assistantRoundsWithToolCalls: assistantRoundsWithToolCalls.length,
            tailAssistantMessages: tailAssistantRounds,
            tailAssistantRounds: tailProtectedAssistantRounds.length,
            tailProtectedCount: skippedByReason.tail_protected ?? 0,
            scannedToolCallCount,
            candidateCount: candidates.length,
            skippedCount: skipped.length,
            appliedCount: 0,
            skippedByOverrideCount: 0,
            unshrinkableCount: 0,
            totalCandidateChars: candidates.reduce((total, candidate) => total + candidate.sizeChars, 0),
            totalCandidateLines: candidates.reduce((total, candidate) => total + candidate.sizeLines, 0),
            totalCharsBefore: candidates.reduce((total, candidate) => total + candidate.sizeChars, 0),
            totalCharsAfter: candidates.reduce((total, candidate) => total + candidate.sizeChars, 0),
            skippedByReason
        },
        tailProtectedAssistantMessageIds,
        tailProtectedAssistantRoundRefs: tailProtectedAssistantRounds.map((round) => round.roundRef)
    };
}

export function analyzeMicrocompactCandidatesForChatContext(
    chatContext: ChatContext,
    options: MicrocompactAnalysisOptions = {}
): MicrocompactAnalysisResult {
    return analyzeMicrocompactCandidates(buildActiveContextView(chatContext), options);
}

export function createMicrocompactDecision(
    analysis: MicrocompactAnalysisResult | undefined,
    options: MicrocompactDecisionOptions = {}
): MicrocompactDecision {
    const now = options.now ?? new Date();
    if (options.enabled === false) {
        return buildNoopMicrocompactDecision('disabled');
    }

    if (!analysis || analysis.candidates.length === 0) {
        return buildNoopMicrocompactDecision('no_candidates');
    }

    if (options.requestKind === 'view_only') {
        return buildNoopMicrocompactDecision('view_only');
    }

    if (options.requestKind === 'pre_submit_check') {
        return buildNoopMicrocompactDecision('pre_submit_check');
    }

    if (options.requestKind === 'manual_compact') {
        return buildNoopMicrocompactDecision('manual_compact');
    }

    if (options.taskRole === 'subtask') {
        return buildNoopMicrocompactDecision('subtask_skipped');
    }

    if (options.modeOverride === 'noop') {
        return buildNoopMicrocompactDecision('mode_override');
    }

    if (!options.taskId) {
        return buildNoopMicrocompactDecision('missing_task_id');
    }

    const shrinkableCandidates = selectShrinkableMicrocompactCandidates(analysis, options.taskId);
    if (shrinkableCandidates.length === 0) {
        return buildNoopMicrocompactDecision('no_candidates');
    }
    for (const candidate of shrinkableCandidates) {
        ensureStableMicrocompactCandidateResultId(candidate);
    }
    const idleGapMinutes = computeMicrocompactIdleGapMinutes(options.state, now);
    const idleGapThresholdMinutes = normalizePositiveInteger(
        options.idleGapThresholdMinutes,
        DEFAULT_MICROCOMPACT_IDLE_GAP_MINUTES
    );
    const selectedMode =
        options.modeOverride ??
        (idleGapMinutes !== undefined && idleGapMinutes >= idleGapThresholdMinutes
            ? 'local_clear'
            : 'request_override');
    const keepRecentResults = normalizeNonNegativeInteger(
        options.keepRecentResults,
        DEFAULT_MICROCOMPACT_KEEP_RECENT_RESULTS
    );
    const selection =
        selectedMode === 'local_clear' && !options.modeOverride
            ? selectMicrocompactCandidatesByRecentResults(shrinkableCandidates, keepRecentResults)
            : {
                  selected: [...shrinkableCandidates],
                  keptRecent: [] as MicrocompactCandidate[]
              };
    const selectedCandidates = selection.selected;
    if (selectedCandidates.length === 0) {
        return buildNoopMicrocompactDecision('no_candidates');
    }

    const estimatedCharsBefore = selectedCandidates.reduce((total, candidate) => total + candidate.sizeChars, 0);
    const estimatedCharsAfter = selectedCandidates.reduce(
        (total, candidate) => total + estimateMicrocompactReplacementLength(candidate, options.taskId!),
        0
    );

    return {
        mode: selectedMode,
        reason: options.modeOverride
            ? 'mode_override'
            : selectedMode === 'request_override'
              ? 'warm_path_request_override'
              : 'cold_path_local_clear',
        selectedResultIds: selectedCandidates.map((candidate) => candidate.resultId),
        keptRecentResultIds: selection.keptRecent.map((candidate) => candidate.resultId),
        estimatedCharsBefore,
        estimatedCharsAfter,
        estimatedCharsSaved: Math.max(estimatedCharsBefore - estimatedCharsAfter, 0),
        idleGapMinutes
    };
}

/**
 * microcompact 的产物引用：直接复用 result_storage.relative_path（与 compact 主流程
 * 同一套结构化字段，不再单独存 artifact_path_hint）。落盘时由
 * persistToolResultArtifactForToolCall 写入 relative_path；投影/估算阶段用
 * getToolResultArtifactRelativePath 计算「预计路径」，只用于渲染文本长度，不落盘。
 */
function getProjectedMicrocompactArtifactPathHint(taskId: string, toolCall: ToolCall): string | undefined {
    const existingPath = toolCall.result_storage?.relative_path;
    if (typeof existingPath === 'string' && existingPath.length > 0) {
        return existingPath;
    }

    if (typeof toolCall.result !== 'string' || !shouldPersistToolResult(toolCall.result)) {
        return undefined;
    }

    const resultId = toolCall.result_storage?.result_id;
    if (!resultId) {
        return undefined;
    }

    return getToolResultArtifactRelativePath(taskId, resultId);
}

function ensureMicrocompactArtifactPathHint(taskId: string, toolCall: ToolCall): string | undefined {
    const existingPath = toolCall.result_storage?.relative_path;
    if (typeof existingPath === 'string' && existingPath.length > 0) {
        return existingPath;
    }

    if (typeof toolCall.result !== 'string' || !shouldPersistToolResult(toolCall.result)) {
        return undefined;
    }

    const persisted = persistToolResultArtifactForToolCall(taskId, toolCall, toolCall.result);
    return persisted.metadata.relative_path;
}

/**
 * 构造 microcompact 替代文本（请求期 override / local_clear 的 result 展示用）。
 * 文本按当前数据根渲染；持久化状态只保存结构化字段（见 renderMicrocompactReplacementText）。
 */
export function buildMicrocompactReplacementText(
    toolCall: ToolCall,
    taskId: string,
    options: { persistArtifact?: boolean } = {}
): string {
    const artifactPathHint =
        options.persistArtifact === false
            ? getProjectedMicrocompactArtifactPathHint(taskId, toolCall)
            : ensureMicrocompactArtifactPathHint(taskId, toolCall);
    return renderMicrocompactReplacementText(toolCall, artifactPathHint);
}

export function buildRequestTimeMicrocompactOverrides(
    taskId: string,
    options: RequestTimeMicrocompactOptions = {}
): RequestTimeMicrocompactResult {
    const analysis = options.analysis;
    if (!analysis) {
        throw new Error('buildRequestTimeMicrocompactOverrides requires a precomputed microcompact analysis');
    }
    const skippedResultIdSet = new Set<string>(options.skipResultIds ?? []);
    const selectedResultIdSet = options.selectedResultIds ? new Set<string>(options.selectedResultIds) : undefined;
    const overrides = new Map<string, string>();
    const appliedCandidates: MicrocompactCandidate[] = [];
    const skippedByOverrideCandidates: MicrocompactCandidate[] = [];
    let stateChanged = false;
    const originalResultIds = new Map<MicrocompactCandidate, string>();

    for (const candidate of analysis.candidates) {
        originalResultIds.set(candidate, candidate.resultId);
        stateChanged = ensureStableMicrocompactCandidateResultId(candidate) || stateChanged;
    }

    const selectedCandidates =
        selectedResultIdSet === undefined
            ? analysis.candidates
            : analysis.candidates.filter(
                  (candidate) =>
                      selectedResultIdSet.has(candidate.resultId) ||
                      selectedResultIdSet.has(originalResultIds.get(candidate) ?? candidate.resultId)
              );
    const totalCharsBefore = selectedCandidates.reduce((total, candidate) => total + candidate.sizeChars, 0);
    let totalCharsAfter = totalCharsBefore;
    let unshrinkableCount = 0;

    for (const candidate of selectedCandidates) {
        if (skippedResultIdSet.has(candidate.resultId)) {
            skippedByOverrideCandidates.push(candidate);
            continue;
        }

        const originalResult = candidate.toolCall.result;
        if (typeof originalResult !== 'string' || originalResult.length === 0) {
            continue;
        }

        const replacementText = buildMicrocompactReplacementText(candidate.toolCall, taskId, {
            persistArtifact: true
        });
        if (replacementText.length >= originalResult.length) {
            unshrinkableCount++;
            continue;
        }

        overrides.set(candidate.resultId, replacementText);
        totalCharsAfter = totalCharsAfter - candidate.sizeChars + replacementText.length;
        appliedCandidates.push(candidate);
    }

    return {
        analysis,
        overrides,
        appliedCandidates,
        skippedByOverrideCandidates,
        stateChanged,
        stats: {
            ...analysis.stats,
            appliedCount: appliedCandidates.length,
            skippedByOverrideCount: skippedByOverrideCandidates.length,
            unshrinkableCount,
            totalCharsBefore,
            totalCharsAfter
        }
    };
}

export function applyLocalMicrocompactToChatContext(
    chatContext: ChatContext,
    taskId: string,
    options: LocalMicrocompactOptions = {}
): LocalMicrocompactResult {
    const analysis = options.analysis ?? analyzeMicrocompactCandidatesForChatContext(chatContext, options);
    const skippedResultIdSet = new Set<string>(options.skipResultIds ?? []);
    const selectedResultIdSet = options.selectedResultIds ? new Set<string>(options.selectedResultIds) : undefined;
    const appliedCandidates: MicrocompactCandidate[] = [];
    const skippedByOverrideCandidates: MicrocompactCandidate[] = [];
    const selectedCandidates =
        selectedResultIdSet === undefined
            ? analysis.candidates
            : analysis.candidates.filter((candidate) => selectedResultIdSet.has(candidate.resultId));
    const totalCharsBefore = selectedCandidates.reduce((total, candidate) => total + candidate.sizeChars, 0);
    let totalCharsAfter = totalCharsBefore;
    let unshrinkableCount = 0;

    for (const candidate of selectedCandidates) {
        if (skippedResultIdSet.has(candidate.resultId)) {
            skippedByOverrideCandidates.push(candidate);
            continue;
        }

        const originalResult = candidate.toolCall.result;
        if (typeof originalResult !== 'string' || originalResult.length === 0) {
            continue;
        }

        const replacementText = buildMicrocompactReplacementText(candidate.toolCall, taskId, {
            persistArtifact: true
        });
        if (replacementText.length >= originalResult.length) {
            unshrinkableCount++;
            continue;
        }

        candidate.toolCall.result = replacementText;
        // 双字段并存是刻意设计：result_storage.replacement_preview 由 compact 主流程 /
        // tool-result budget 写入（含 relative_path）；microcompact 只记录清理统计。
        // 产物路径直接复用 result_storage.relative_path（上面的 buildMicrocompactReplacementText
        // 已确保落盘并写入该字段），不再单独存 artifact_path_hint。
        // 请求构建时 overrides（microcompact 的 request_override）优先级最高；
        // 重载后无 overrides 时模型可见内容回退到 result_storage.preview / 本状态渲染。
        candidate.toolCall.setMicrocompact({
            strategy: 'local_clear',
            cleared_at: new Date().toISOString(),
            original_chars: candidate.sizeChars,
            original_lines: candidate.sizeLines
        });
        candidate.toolCall.rendered = undefined;
        candidate.toolCallPart.rendered = undefined;

        totalCharsAfter = totalCharsAfter - candidate.sizeChars + replacementText.length;
        appliedCandidates.push(candidate);
    }

    return {
        activeContext: buildActiveContextView(chatContext),
        analysis,
        appliedCandidates,
        skippedByOverrideCandidates,
        stateChanged: appliedCandidates.length > 0,
        stats: {
            ...analysis.stats,
            appliedCount: appliedCandidates.length,
            skippedByOverrideCount: skippedByOverrideCandidates.length,
            unshrinkableCount,
            totalCharsBefore,
            totalCharsAfter
        }
    };
}
