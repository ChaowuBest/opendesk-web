import { AssistantMessage, ChatContext, ToolCall, ToolCallMessagePart } from '../messages.js';
import { buildActiveContextView } from './context-view.js';
import type { ActiveContextView } from './types.js';
import { countToolResultLines, getToolResultArtifactPath } from './tool-results.js';

export const MICROCOMPACTABLE_TOOL_NAMES = new Set<string>([
    'executePowerShell',
    'executeBash',
    'executeZsh',
    'writeFile',
    'editFile',
    'searchReplace',
    'applyPatch',
    'globFiles',
    'grepFiles',
    'webFetch',
    'ExaSearch'
]);

const DEFAULT_MICROCOMPACT_TAIL_ASSISTANT_MESSAGES = 3;

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
    tailAssistantMessages: number;
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
}

export interface MicrocompactAnalysisOptions {
    tailAssistantMessages?: number;
    skipToolNames?: Iterable<string>;
}

export interface LocalMicrocompactOptions extends MicrocompactAnalysisOptions {
    analysis?: MicrocompactAnalysisResult;
    skipResultIds?: Iterable<string>;
}

export interface LocalMicrocompactResult {
    activeContext: ActiveContextView;
    analysis: MicrocompactAnalysisResult;
    appliedCandidates: MicrocompactCandidate[];
    skippedByOverrideCandidates: MicrocompactCandidate[];
    stateChanged: boolean;
    stats: MicrocompactStats;
}

function matchesToolName(toolName: string, candidate: string): boolean {
    return toolName === candidate || toolName.endsWith(`-${candidate}`);
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

function collectAssistantMessagesWithToolCalls(activeContext: ActiveContextView): AssistantMessage[] {
    const assistantMessages: AssistantMessage[] = [];

    for (const message of activeContext.messages) {
        if (!(message instanceof AssistantMessage)) {
            continue;
        }

        const hasToolCalls = message.content.some((part) => part.type === 'tool_call' && part.toolcalls.length > 0);
        if (hasToolCalls) {
            assistantMessages.push(message);
        }
    }

    return assistantMessages;
}

export function isMicrocompactableToolName(toolName: string): boolean {
    if (toolName.endsWith('Search')) {
        return true;
    }

    for (const candidate of MICROCOMPACTABLE_TOOL_NAMES) {
        if (matchesToolName(toolName, candidate)) {
            return true;
        }
    }
    return false;
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
    const tailAssistantMessages = Math.max(
        0,
        Math.trunc(options.tailAssistantMessages ?? DEFAULT_MICROCOMPACT_TAIL_ASSISTANT_MESSAGES)
    );
    const assistantMessagesWithToolCalls = collectAssistantMessagesWithToolCalls(activeContext);
    const tailProtectedAssistantMessageIds =
        tailAssistantMessages > 0
            ? assistantMessagesWithToolCalls.slice(-tailAssistantMessages).map((message) => message.message_id)
            : [];
    const tailProtectedAssistantMessageIdSet = new Set(tailProtectedAssistantMessageIds);

    const candidates: MicrocompactCandidate[] = [];
    const skipped: MicrocompactSkippedCandidate[] = [];
    const skippedByReason: Partial<Record<MicrocompactSkipReason, number>> = {};
    let scannedToolCallCount = 0;

    for (
        let assistantMessageIndex = 0;
        assistantMessageIndex < activeContext.messages.length;
        assistantMessageIndex++
    ) {
        const message = activeContext.messages[assistantMessageIndex];
        if (!(message instanceof AssistantMessage)) {
            continue;
        }

        const isWithinTail = tailProtectedAssistantMessageIdSet.has(message.message_id);

        for (let toolCallPartIndex = 0; toolCallPartIndex < message.content.length; toolCallPartIndex++) {
            const part = message.content[toolCallPartIndex];
            if (part.type !== 'tool_call') {
                continue;
            }

            for (let toolCallIndex = 0; toolCallIndex < part.toolcalls.length; toolCallIndex++) {
                const toolCall = part.toolcalls[toolCallIndex];
                const chatContextMessageIndex = activeContext.startIndex + assistantMessageIndex;
                const resultId = buildMicrocompactResultId(
                    toolCall,
                    message.message_id,
                    toolCallPartIndex,
                    toolCallIndex
                );
                const hasResultStorage = toolCall.result_storage !== undefined;
                const hasCompressId = typeof toolCall.compress_id === 'string' && toolCall.compress_id.length > 0;
                const sizeChars = typeof toolCall.result === 'string' ? toolCall.result.length : undefined;
                const sizeLines =
                    typeof toolCall.result === 'string' ? countToolResultLines(toolCall.result) : undefined;

                scannedToolCallCount++;

                const baseRecord = {
                    resultId,
                    toolName: toolCall.tool_name,
                    assistantMessageIndex,
                    chatContextMessageIndex,
                    assistantMessageId: message.message_id,
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
            tailAssistantMessages: tailAssistantMessages,
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
        tailProtectedAssistantMessageIds
    };
}

export function analyzeMicrocompactCandidatesForChatContext(
    chatContext: ChatContext,
    options: MicrocompactAnalysisOptions = {}
): MicrocompactAnalysisResult {
    return analyzeMicrocompactCandidates(buildActiveContextView(chatContext), options);
}

function buildMicrocompactArtifactPathHint(taskId: string, toolCall: ToolCall): string | undefined {
    const resultId = toolCall.result_storage?.result_id;
    if (!resultId || !toolCall.result_storage?.relative_path) {
        return undefined;
    }

    return getToolResultArtifactPath(taskId, resultId, false);
}

export function buildMicrocompactReplacementText(toolCall: ToolCall, taskId: string): string {
    const lines = ['[旧工具结果已被 microcompact 清理，以减少上下文体积。]', `工具: ${toolCall.tool_name}`];
    const artifactPathHint = buildMicrocompactArtifactPathHint(taskId, toolCall);

    if (artifactPathHint) {
        lines.push(`完整输出可查看: ${artifactPathHint}`);
        lines.push('如需完整内容，请读取该文件或重新执行该工具。');
    } else {
        lines.push('如需完整内容，请重新执行该工具，或重新读取相关文件/网页。');
    }

    return lines.join('\n');
}

export function applyLocalMicrocompactToChatContext(
    chatContext: ChatContext,
    taskId: string,
    options: LocalMicrocompactOptions = {}
): LocalMicrocompactResult {
    const analysis = options.analysis ?? analyzeMicrocompactCandidatesForChatContext(chatContext, options);
    const skippedResultIdSet = new Set<string>(options.skipResultIds ?? []);
    const appliedCandidates: MicrocompactCandidate[] = [];
    const skippedByOverrideCandidates: MicrocompactCandidate[] = [];
    let totalCharsAfter = analysis.stats.totalCandidateChars;
    let unshrinkableCount = 0;

    for (const candidate of analysis.candidates) {
        if (skippedResultIdSet.has(candidate.resultId)) {
            skippedByOverrideCandidates.push(candidate);
            continue;
        }

        const originalResult = candidate.toolCall.result;
        if (typeof originalResult !== 'string' || originalResult.length === 0) {
            continue;
        }

        const replacementText = buildMicrocompactReplacementText(candidate.toolCall, taskId);
        if (replacementText.length >= originalResult.length) {
            unshrinkableCount++;
            continue;
        }

        const artifactPathHint = buildMicrocompactArtifactPathHint(taskId, candidate.toolCall);
        candidate.toolCall.result = replacementText;
        candidate.toolCall.setMicrocompact({
            strategy: 'local_clear',
            cleared_at: new Date().toISOString(),
            original_chars: candidate.sizeChars,
            original_lines: candidate.sizeLines,
            replacement_text: replacementText,
            artifact_path_hint: artifactPathHint
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
            totalCharsBefore: analysis.stats.totalCandidateChars,
            totalCharsAfter
        }
    };
}
