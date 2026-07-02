import fs from 'fs';
import path from 'path';
import { getTaskToolResultDirectory } from '../../utils/setting.js';
import { AssistantMessage, ChatContext, ToolCall, type ToolResultStorageMetadata } from '../messages.js';
import { TOOL_RESULT_BUDGET_EXCLUDED_TOOL_NAMES, isToolResultBudgetExcludedToolName } from './compactable-tools.js';
import { buildActiveContextView } from './context-view.js';
import type { ActiveContextView } from './types.js';

export const TOOL_RESULT_STORAGE_DIRECTORY_NAME = 'tool-results';
export const TOOL_RESULT_STORAGE_EXTENSION = '.txt';

const LARGE_TOOL_RESULT_LINES = 2000;
const LARGE_TOOL_RESULT_CHARS = 100_000; // 100KB
const ARTIFACT_HEAD_LINES = 100;
const ARTIFACT_TAIL_LINES = 200;
const ARTIFACT_HEAD_CHARS = 4_000;
const ARTIFACT_TAIL_CHARS = 8_000;
export const TOOL_RESULT_COMPRESSION_EXCLUDED_TOOL_NAMES = TOOL_RESULT_BUDGET_EXCLUDED_TOOL_NAMES;

export interface ToolResultPreview {
    mode: 'chars' | 'lines';
    previewText: string;
    omittedChars?: number;
    omittedLines?: number;
}

export interface ToolResultCharPreviewOptions {
    thresholdChars?: number;
    headChars?: number;
    tailChars?: number;
}

export interface ToolResultLinePreviewOptions {
    thresholdLines?: number;
    headLines?: number;
    tailLines?: number;
}

export interface ToolResultPreviewOptions extends ToolResultCharPreviewOptions, ToolResultLinePreviewOptions {
    prefer?: 'chars' | 'lines';
    force?: boolean;
}

export interface PersistedToolResultArtifact {
    fullPath: string;
    relativePath: string;
    originalChars: number;
    originalLines: number;
}

export interface PersistedToolResultForCall {
    metadata: ToolResultStorageMetadata;
    fullPath: string;
}

export interface ToolResultReplacementRecord {
    result_id: string;
    replacement_text: string;
    relative_path?: string;
}

export interface SerializedToolResultReplacementState {
    seen_ids: string[];
    replacements: ToolResultReplacementRecord[];
}

export interface ToolResultReplacementState {
    seenIds: Set<string>;
    replacements: Map<string, ToolResultReplacementRecord>;
}

function sanitizeToolResultId(resultId: string): string {
    return resultId.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_');
}

export function countToolResultLines(result: string): number {
    if (result.length === 0) {
        return 0;
    }
    return result.split('\n').length;
}

export function ensureToolResultStorageId(toolCall: ToolCall): string {
    return toolCall.ensureResultStorage().result_id;
}

export function isToolResultCompressionExcluded(toolName: string, extraExcludedToolNames?: Iterable<string>): boolean {
    return isToolResultBudgetExcludedToolName(toolName, extraExcludedToolNames);
}

export function buildToolResultLinePreview(
    result: string,
    options: ToolResultLinePreviewOptions = {}
): ToolResultPreview | undefined {
    const lines = result.split('\n');
    const thresholdLines = options.thresholdLines ?? LARGE_TOOL_RESULT_LINES;
    const headLines = options.headLines ?? ARTIFACT_HEAD_LINES;
    const tailLines = options.tailLines ?? ARTIFACT_TAIL_LINES;
    const omittedLines = Math.max(lines.length - headLines - tailLines, 0);
    const force = (options as ToolResultPreviewOptions).force === true;

    if (lines.length <= thresholdLines && !force) {
        return undefined;
    }

    if (omittedLines <= 0) {
        return undefined;
    }

    const head = lines.slice(0, headLines).join('\n');
    const tail = lines.slice(-tailLines).join('\n');

    return {
        mode: 'lines',
        previewText: `${head}\n\n... [中间省略 ${omittedLines} 行] ...\n\n${tail}`,
        omittedLines
    };
}

export function buildToolResultCharPreview(
    result: string,
    options: ToolResultCharPreviewOptions = {}
): ToolResultPreview | undefined {
    const thresholdChars = options.thresholdChars ?? LARGE_TOOL_RESULT_CHARS;
    const headChars = options.headChars ?? ARTIFACT_HEAD_CHARS;
    const tailChars = options.tailChars ?? ARTIFACT_TAIL_CHARS;
    const omittedChars = Math.max(result.length - headChars - tailChars, 0);
    const force = (options as ToolResultPreviewOptions).force === true;

    if (result.length <= thresholdChars && !force) {
        return undefined;
    }

    if (omittedChars <= 0) {
        return undefined;
    }

    const head = result.slice(0, headChars);
    const tail = result.slice(-tailChars);
    const omittedKB = (omittedChars / 1024).toFixed(1);

    return {
        mode: 'chars',
        previewText: `${head}\n\n... [中间省略约 ${omittedKB} KB] ...\n\n${tail}`,
        omittedChars
    };
}

export function truncateToolResultForPreview(
    result: string,
    options: ToolResultPreviewOptions = {}
): ToolResultPreview | undefined {
    const prefer = options.prefer ?? 'chars';
    if (prefer === 'lines') {
        return buildToolResultLinePreview(result, options) ?? buildToolResultCharPreview(result, options);
    }
    return buildToolResultCharPreview(result, options) ?? buildToolResultLinePreview(result, options);
}

export function shouldPersistToolResult(result: string): boolean {
    return truncateToolResultForPreview(result) !== undefined;
}

export function getToolResultFilename(resultId: string): string {
    return `${sanitizeToolResultId(resultId)}${TOOL_RESULT_STORAGE_EXTENSION}`;
}

export function getToolResultArtifactRelativePath(taskId: string, resultId: string): string {
    return path.join('artifacts', taskId, TOOL_RESULT_STORAGE_DIRECTORY_NAME, getToolResultFilename(resultId));
}

export function getToolResultArtifactPath(taskId: string, resultId: string, ensureExists: boolean = true): string {
    return path.join(getTaskToolResultDirectory(taskId, ensureExists), getToolResultFilename(resultId));
}

export function persistToolResultArtifact(
    taskId: string,
    resultId: string,
    result: string
): PersistedToolResultArtifact {
    const fullPath = getToolResultArtifactPath(taskId, resultId, true);
    try {
        if (!fs.existsSync(fullPath)) {
            fs.writeFileSync(fullPath, result, 'utf8');
        }
    } catch {
        /* best-effort artifact persistence */
    }

    return {
        fullPath,
        relativePath: getToolResultArtifactRelativePath(taskId, resultId),
        originalChars: result.length,
        originalLines: countToolResultLines(result)
    };
}

export function buildToolResultReplacementText(previewText: string, fullPath: string): string {
    return `${previewText}\n\n完整输出已保存至: ${fullPath}\n若需完整内容请通过读文件方式获取。`;
}

export function buildToolResultStorageMetadata(
    toolCall: ToolCall,
    artifact: PersistedToolResultArtifact,
    replacementText: string,
    persistedAt: string = new Date().toISOString()
): ToolResultStorageMetadata {
    return toolCall.ensureResultStorage({
        relative_path: artifact.relativePath,
        original_chars: artifact.originalChars,
        original_lines: artifact.originalLines,
        persisted_at: persistedAt,
        replacement_text: replacementText
    });
}

export function persistToolResultForToolCall(
    taskId: string,
    toolCall: ToolCall,
    result: string,
    replacementText: string,
    persistedAt: string = new Date().toISOString()
): PersistedToolResultForCall {
    const resultId = ensureToolResultStorageId(toolCall);
    const artifact = persistToolResultArtifact(taskId, resultId, result);
    const metadata = buildToolResultStorageMetadata(toolCall, artifact, replacementText, persistedAt);

    return {
        metadata,
        fullPath: artifact.fullPath
    };
}

export function persistToolResultArtifactForToolCall(
    taskId: string,
    toolCall: ToolCall,
    result: string,
    persistedAt: string = new Date().toISOString()
): PersistedToolResultForCall {
    const resultId = ensureToolResultStorageId(toolCall);
    const artifact = persistToolResultArtifact(taskId, resultId, result);
    const metadata = toolCall.ensureResultStorage({
        relative_path: artifact.relativePath,
        original_chars: artifact.originalChars,
        original_lines: artifact.originalLines,
        persisted_at: persistedAt
    });

    return {
        metadata,
        fullPath: artifact.fullPath
    };
}

function normalizeReplacementRecord(record: unknown): ToolResultReplacementRecord | undefined {
    if (record === undefined || record === null || typeof record !== 'object') {
        return undefined;
    }

    const candidate = record as {
        result_id?: unknown;
        replacement_text?: unknown;
        relative_path?: unknown;
    };

    if (typeof candidate.result_id !== 'string' || candidate.result_id.trim().length === 0) {
        return undefined;
    }

    if (typeof candidate.replacement_text !== 'string' || candidate.replacement_text.length === 0) {
        return undefined;
    }

    const normalized: ToolResultReplacementRecord = {
        result_id: candidate.result_id,
        replacement_text: candidate.replacement_text
    };

    if (typeof candidate.relative_path === 'string' && candidate.relative_path.trim().length > 0) {
        normalized.relative_path = candidate.relative_path;
    }

    return normalized;
}

function createEmptyState(): ToolResultReplacementState {
    return {
        seenIds: new Set<string>(),
        replacements: new Map<string, ToolResultReplacementRecord>()
    };
}

function applyReplacementRecord(state: ToolResultReplacementState, record: ToolResultReplacementRecord): void {
    state.seenIds.add(record.result_id);
    state.replacements.set(record.result_id, record);
}

function applyChatContextMetadata(state: ToolResultReplacementState, chatContext: ChatContext): void {
    for (const message of chatContext.messages) {
        if (!(message instanceof AssistantMessage)) {
            continue;
        }

        for (const part of message.content) {
            if (part.type !== 'tool_call') {
                continue;
            }

            for (const toolCall of part.toolcalls) {
                const metadata = toolCall.result_storage;
                if (!metadata?.result_id) {
                    continue;
                }

                // Step 3 的稳定 result_id 只用于结果落盘与重放定位，
                // 不能自动推导为 Step 4 的 "seen" 状态；否则 fresh 候选会被提前冻结。
                if (typeof metadata.replacement_text === 'string' && metadata.replacement_text.length > 0) {
                    applyReplacementRecord(state, {
                        result_id: metadata.result_id,
                        replacement_text: metadata.replacement_text,
                        relative_path: metadata.relative_path
                    });
                }
            }
        }
    }
}

function collectChatContextStoredResultIds(chatContext: ChatContext): Set<string> {
    const resultIds = new Set<string>();

    for (const message of chatContext.messages) {
        if (!(message instanceof AssistantMessage)) {
            continue;
        }

        for (const part of message.content) {
            if (part.type !== 'tool_call') {
                continue;
            }

            for (const toolCall of part.toolcalls) {
                const resultId = toolCall.result_storage?.result_id;
                if (typeof resultId === 'string' && resultId.length > 0) {
                    resultIds.add(resultId);
                }
            }
        }
    }

    return resultIds;
}

export class ToolResultReplacementStates {
    static create(): ToolResultReplacementState {
        return createEmptyState();
    }

    static clone(source: ToolResultReplacementState): ToolResultReplacementState {
        return {
            seenIds: new Set(source.seenIds),
            replacements: new Map(
                Array.from(source.replacements.entries()).map(([resultId, record]) => [resultId, { ...record }])
            )
        };
    }

    static synchronize(state: ToolResultReplacementState, chatContext: ChatContext): ToolResultReplacementState {
        const synchronized = ToolResultReplacementStates.clone(state);
        applyChatContextMetadata(synchronized, chatContext);
        return synchronized;
    }

    static deserialize(raw: unknown, chatContext?: ChatContext): ToolResultReplacementState {
        const state = createEmptyState();

        if (raw && typeof raw === 'object') {
            const candidate = raw as {
                seen_ids?: unknown;
                replacements?: unknown;
            };

            if (Array.isArray(candidate.seen_ids)) {
                for (const seenId of candidate.seen_ids) {
                    if (typeof seenId === 'string' && seenId.trim().length > 0) {
                        state.seenIds.add(seenId);
                    }
                }
            }

            if (Array.isArray(candidate.replacements)) {
                for (const replacement of candidate.replacements) {
                    const normalized = normalizeReplacementRecord(replacement);
                    if (normalized) {
                        applyReplacementRecord(state, normalized);
                    }
                }
            }
        }

        if (chatContext) {
            const storedResultIds = collectChatContextStoredResultIds(chatContext);
            const shouldDropLegacySeenIds =
                state.replacements.size === 0 &&
                state.seenIds.size > 0 &&
                Array.from(state.seenIds).every((resultId) => storedResultIds.has(resultId));

            // 兼容旧版 Step 4 bug：
            // 之前会把所有已有 stable result_id 自动同步进 seenIds，
            // 导致 fresh 候选在首次 budget 前就被冻结。这里在无 replacement 的情况下清理这批旧数据。
            if (shouldDropLegacySeenIds) {
                state.seenIds.clear();
            }

            applyChatContextMetadata(state, chatContext);
        }

        return state;
    }

    static serialize(
        state: ToolResultReplacementState,
        chatContext?: ChatContext
    ): SerializedToolResultReplacementState {
        const synchronized = chatContext
            ? ToolResultReplacementStates.synchronize(state, chatContext)
            : ToolResultReplacementStates.clone(state);

        return {
            seen_ids: Array.from(synchronized.seenIds).sort(),
            replacements: Array.from(synchronized.replacements.values()).sort((a, b) =>
                a.result_id.localeCompare(b.result_id)
            )
        };
    }
}

type ToolResultBudgetCandidateState = 'fresh' | 'frozen' | 'must_reapply';

type ToolResultBudgetSkipReason = 'missing_result' | 'non_string_result' | 'excluded_tool' | 'level1_compressed';

export interface ToolResultBudgetOptions {
    skipToolNames?: Iterable<string>;
}

export interface ToolResultBudgetProjectionOptions extends ToolResultBudgetOptions {
    groupBudgetChars?: number;
    previewOptions?: ToolResultPreviewOptions;
    persistArtifacts?: boolean;
}

interface ToolResultBudgetCandidate {
    resultId: string;
    hasStableResultId: boolean;
    state: ToolResultBudgetCandidateState;
    toolName: string;
    sizeChars: number;
    projectedSizeChars: number;
    replacementText?: string;
    assistantMessageIndex: number;
    chatContextMessageIndex: number;
    assistantMessageId: string;
    toolCallPartIndex: number;
    toolCallIndex: number;
    toolCall: ToolCall;
}

interface ToolResultBudgetSkippedCandidate {
    reason: ToolResultBudgetSkipReason;
    toolName: string;
    assistantMessageIndex: number;
    chatContextMessageIndex: number;
    assistantMessageId: string;
    toolCallPartIndex: number;
    toolCallIndex: number;
    toolCall: ToolCall;
}

interface ToolResultBudgetGroup {
    key: string;
    assistantMessageIndex: number;
    chatContextMessageIndex: number;
    assistantMessageId: string;
    toolCallPartIndex: number;
    candidates: ToolResultBudgetCandidate[];
    totalSizeChars: number;
    totalProjectedChars: number;
    freshSizeChars: number;
    frozenSizeChars: number;
    mustReapplyProjectedChars: number;
}

interface ToolResultBudgetStats {
    groupCount: number;
    candidateCount: number;
    skippedCount: number;
    freshCount: number;
    frozenCount: number;
    mustReapplyCount: number;
    unstableResultIdCount: number;
    totalSizeChars: number;
    totalProjectedChars: number;
    skippedByReason: Partial<Record<ToolResultBudgetSkipReason, number>>;
}

interface ToolResultBudgetAnalysisResult {
    activeContext: ActiveContextView;
    candidates: ToolResultBudgetCandidate[];
    groups: ToolResultBudgetGroup[];
    skipped: ToolResultBudgetSkippedCandidate[];
    stats: ToolResultBudgetStats;
}

export interface ToolResultBudgetOverrideRecord {
    resultId: string;
    replacementText: string;
    relativePath?: string;
    source: 'must_reapply' | 'fresh_selected';
    assistantMessageIndex: number;
    chatContextMessageIndex: number;
    assistantMessageId: string;
    toolCallPartIndex: number;
    toolCallIndex: number;
    toolName: string;
}

interface ToolResultBudgetProjectionGroupResult extends ToolResultBudgetGroup {
    budgetChars: number;
    projectedCharsAfterSelection: number;
    selectedFreshResultIds: string[];
    reappliedResultIds: string[];
    overBudget: boolean;
}

export interface ToolResultBudgetProjectionStats extends ToolResultBudgetStats {
    overrideCount: number;
    reappliedCount: number;
    newlySelectedCount: number;
    newlySeenCount: number;
    stableIdsCreatedCount: number;
    persistedCount: number;
    overBudgetGroupCount: number;
    unshrinkableFreshCount: number;
    totalProjectedCharsAfterSelection: number;
}

export interface ToolResultBudgetProjectionResult {
    activeContext: ActiveContextView;
    overrides: Map<string, string>;
    overrideRecords: ToolResultBudgetOverrideRecord[];
    replacementState: ToolResultReplacementState;
    stats: ToolResultBudgetProjectionStats;
}

const DEFAULT_TOOL_RESULT_BUDGET_PREVIEW_OPTIONS: ToolResultPreviewOptions = {
    prefer: 'chars',
    force: true,
    thresholdChars: 0,
    thresholdLines: 0,
    headChars: 1_200,
    tailChars: 1_800,
    headLines: 20,
    tailLines: 30
};

function buildTransientResultId(assistantMessageId: string, toolCallPartIndex: number, toolCallIndex: number): string {
    return `unstable:${assistantMessageId}:${toolCallPartIndex}:${toolCallIndex}`;
}

function incrementBudgetSkipReasonCounter(
    counters: Partial<Record<ToolResultBudgetSkipReason, number>>,
    reason: ToolResultBudgetSkipReason
): void {
    counters[reason] = (counters[reason] ?? 0) + 1;
}

function createBudgetSkippedCandidate(
    reason: ToolResultBudgetSkipReason,
    assistantMessageIndex: number,
    chatContextMessageIndex: number,
    assistantMessageId: string,
    toolCallPartIndex: number,
    toolCallIndex: number,
    toolCall: ToolCall
): ToolResultBudgetSkippedCandidate {
    return {
        reason,
        toolName: toolCall.tool_name,
        assistantMessageIndex,
        chatContextMessageIndex,
        assistantMessageId,
        toolCallPartIndex,
        toolCallIndex,
        toolCall
    };
}

function ensureStableBudgetResultStorageIds(candidates: ToolResultBudgetCandidate[]): number {
    let createdCount = 0;
    for (const candidate of candidates) {
        if (candidate.hasStableResultId) {
            continue;
        }
        candidate.toolCall.ensureResultStorage();
        createdCount++;
    }
    return createdCount;
}

function buildMergedBudgetPreviewOptions(options?: ToolResultPreviewOptions): ToolResultPreviewOptions {
    return {
        ...DEFAULT_TOOL_RESULT_BUDGET_PREVIEW_OPTIONS,
        ...options,
        force: options?.force ?? true
    };
}

function classifyBudgetCandidate(
    toolCall: ToolCall,
    replacementState: ToolResultReplacementState,
    assistantMessageId: string,
    toolCallPartIndex: number,
    toolCallIndex: number
): Pick<
    ToolResultBudgetCandidate,
    'resultId' | 'hasStableResultId' | 'state' | 'replacementText' | 'projectedSizeChars'
> {
    const stableResultId = toolCall.result_storage?.result_id;
    const replacementText =
        (stableResultId ? replacementState.replacements.get(stableResultId)?.replacement_text : undefined) ??
        toolCall.result_storage?.replacement_text;
    const state: ToolResultBudgetCandidateState =
        typeof replacementText === 'string' && replacementText.length > 0
            ? 'must_reapply'
            : stableResultId && replacementState.seenIds.has(stableResultId)
              ? 'frozen'
              : 'fresh';
    const resultId = stableResultId ?? buildTransientResultId(assistantMessageId, toolCallPartIndex, toolCallIndex);
    const sourceSizeChars = typeof toolCall.result === 'string' ? toolCall.result.length : 0;

    return {
        resultId,
        hasStableResultId: stableResultId !== undefined,
        state,
        replacementText,
        projectedSizeChars:
            state === 'must_reapply' && typeof replacementText === 'string' ? replacementText.length : sourceSizeChars
    };
}

function sortFreshBudgetCandidatesBySize(candidates: ToolResultBudgetCandidate[]): ToolResultBudgetCandidate[] {
    return [...candidates].sort((a, b) => {
        if (b.sizeChars !== a.sizeChars) {
            return b.sizeChars - a.sizeChars;
        }
        if (a.chatContextMessageIndex !== b.chatContextMessageIndex) {
            return a.chatContextMessageIndex - b.chatContextMessageIndex;
        }
        if (a.toolCallPartIndex !== b.toolCallPartIndex) {
            return a.toolCallPartIndex - b.toolCallPartIndex;
        }
        return a.toolCallIndex - b.toolCallIndex;
    });
}

function createBudgetOverrideRecord(
    candidate: ToolResultBudgetCandidate,
    replacementText: string,
    source: 'must_reapply' | 'fresh_selected'
): ToolResultBudgetOverrideRecord {
    return {
        resultId: candidate.resultId,
        replacementText,
        relativePath: candidate.toolCall.result_storage?.relative_path,
        source,
        assistantMessageIndex: candidate.assistantMessageIndex,
        chatContextMessageIndex: candidate.chatContextMessageIndex,
        assistantMessageId: candidate.assistantMessageId,
        toolCallPartIndex: candidate.toolCallPartIndex,
        toolCallIndex: candidate.toolCallIndex,
        toolName: candidate.toolName
    };
}

function persistFreshBudgetReplacementForCandidate(
    taskId: string,
    candidate: ToolResultBudgetCandidate,
    previewOptions?: ToolResultPreviewOptions,
    persistArtifacts: boolean = true
): ToolResultBudgetOverrideRecord | undefined {
    const result = candidate.toolCall.result;
    if (typeof result !== 'string' || result.length === 0) {
        return undefined;
    }

    const preview = truncateToolResultForPreview(result, buildMergedBudgetPreviewOptions(previewOptions));
    if (!preview) {
        return undefined;
    }

    const resultId = candidate.toolCall.ensureResultStorage().result_id;
    const fullPath = getToolResultArtifactPath(taskId, resultId, persistArtifacts);
    const replacementText = buildToolResultReplacementText(preview.previewText, fullPath);
    if (replacementText.length >= result.length) {
        return undefined;
    }

    if (persistArtifacts) {
        persistToolResultForToolCall(taskId, candidate.toolCall, result, replacementText);
    }
    return createBudgetOverrideRecord(candidate, replacementText, 'fresh_selected');
}

function collectToolResultBudgetCandidates(
    activeContext: ActiveContextView,
    replacementState: ToolResultReplacementState,
    options: ToolResultBudgetOptions = {}
): { candidates: ToolResultBudgetCandidate[]; skipped: ToolResultBudgetSkippedCandidate[] } {
    const candidates: ToolResultBudgetCandidate[] = [];
    const skipped: ToolResultBudgetSkippedCandidate[] = [];

    for (let messageIndex = 0; messageIndex < activeContext.messages.length; messageIndex++) {
        const message = activeContext.messages[messageIndex];
        if (!(message instanceof AssistantMessage)) {
            continue;
        }

        for (let partIndex = 0; partIndex < message.content.length; partIndex++) {
            const part = message.content[partIndex];
            if (part.type !== 'tool_call') {
                continue;
            }

            for (let toolCallIndex = 0; toolCallIndex < part.toolcalls.length; toolCallIndex++) {
                const toolCall = part.toolcalls[toolCallIndex];
                const chatContextMessageIndex = activeContext.startIndex + messageIndex;

                if (toolCall.result === undefined) {
                    skipped.push(
                        createBudgetSkippedCandidate(
                            'missing_result',
                            messageIndex,
                            chatContextMessageIndex,
                            message.message_id,
                            partIndex,
                            toolCallIndex,
                            toolCall
                        )
                    );
                    continue;
                }

                if (typeof toolCall.result !== 'string') {
                    skipped.push(
                        createBudgetSkippedCandidate(
                            'non_string_result',
                            messageIndex,
                            chatContextMessageIndex,
                            message.message_id,
                            partIndex,
                            toolCallIndex,
                            toolCall
                        )
                    );
                    continue;
                }

                if (isToolResultCompressionExcluded(toolCall.tool_name, options.skipToolNames)) {
                    skipped.push(
                        createBudgetSkippedCandidate(
                            'excluded_tool',
                            messageIndex,
                            chatContextMessageIndex,
                            message.message_id,
                            partIndex,
                            toolCallIndex,
                            toolCall
                        )
                    );
                    continue;
                }

                if (toolCall.hasLegacyCompressId()) {
                    skipped.push(
                        createBudgetSkippedCandidate(
                            'level1_compressed',
                            messageIndex,
                            chatContextMessageIndex,
                            message.message_id,
                            partIndex,
                            toolCallIndex,
                            toolCall
                        )
                    );
                    continue;
                }

                const classification = classifyBudgetCandidate(
                    toolCall,
                    replacementState,
                    message.message_id,
                    partIndex,
                    toolCallIndex
                );

                candidates.push({
                    ...classification,
                    toolName: toolCall.tool_name,
                    sizeChars: toolCall.result.length,
                    assistantMessageIndex: messageIndex,
                    chatContextMessageIndex,
                    assistantMessageId: message.message_id,
                    toolCallPartIndex: partIndex,
                    toolCallIndex,
                    toolCall
                });
            }
        }
    }

    return { candidates, skipped };
}

function groupToolResultBudgetCandidates(candidates: ToolResultBudgetCandidate[]): ToolResultBudgetGroup[] {
    const groups = new Map<string, ToolResultBudgetGroup>();

    for (const candidate of candidates) {
        const key = `${candidate.assistantMessageId}:${candidate.toolCallPartIndex}`;
        const existing = groups.get(key);
        if (existing) {
            existing.candidates.push(candidate);
            existing.totalSizeChars += candidate.sizeChars;
            existing.totalProjectedChars += candidate.projectedSizeChars;
            if (candidate.state === 'fresh') {
                existing.freshSizeChars += candidate.sizeChars;
            } else if (candidate.state === 'frozen') {
                existing.frozenSizeChars += candidate.sizeChars;
            } else {
                existing.mustReapplyProjectedChars += candidate.projectedSizeChars;
            }
            continue;
        }

        groups.set(key, {
            key,
            assistantMessageIndex: candidate.assistantMessageIndex,
            chatContextMessageIndex: candidate.chatContextMessageIndex,
            assistantMessageId: candidate.assistantMessageId,
            toolCallPartIndex: candidate.toolCallPartIndex,
            candidates: [candidate],
            totalSizeChars: candidate.sizeChars,
            totalProjectedChars: candidate.projectedSizeChars,
            freshSizeChars: candidate.state === 'fresh' ? candidate.sizeChars : 0,
            frozenSizeChars: candidate.state === 'frozen' ? candidate.sizeChars : 0,
            mustReapplyProjectedChars: candidate.state === 'must_reapply' ? candidate.projectedSizeChars : 0
        });
    }

    return Array.from(groups.values()).sort((a, b) => {
        if (a.chatContextMessageIndex !== b.chatContextMessageIndex) {
            return a.chatContextMessageIndex - b.chatContextMessageIndex;
        }
        return a.toolCallPartIndex - b.toolCallPartIndex;
    });
}

function analyzeToolResultBudget(
    activeContext: ActiveContextView,
    replacementState: ToolResultReplacementState,
    options: ToolResultBudgetOptions = {}
): ToolResultBudgetAnalysisResult {
    const { candidates, skipped } = collectToolResultBudgetCandidates(activeContext, replacementState, options);
    const groups = groupToolResultBudgetCandidates(candidates);
    const skippedByReason: Partial<Record<ToolResultBudgetSkipReason, number>> = {};

    for (const skippedCandidate of skipped) {
        incrementBudgetSkipReasonCounter(skippedByReason, skippedCandidate.reason);
    }

    return {
        activeContext,
        candidates,
        groups,
        skipped,
        stats: {
            groupCount: groups.length,
            candidateCount: candidates.length,
            skippedCount: skipped.length,
            freshCount: candidates.filter((candidate) => candidate.state === 'fresh').length,
            frozenCount: candidates.filter((candidate) => candidate.state === 'frozen').length,
            mustReapplyCount: candidates.filter((candidate) => candidate.state === 'must_reapply').length,
            unstableResultIdCount: candidates.filter((candidate) => !candidate.hasStableResultId).length,
            totalSizeChars: candidates.reduce((total, candidate) => total + candidate.sizeChars, 0),
            totalProjectedChars: candidates.reduce((total, candidate) => total + candidate.projectedSizeChars, 0),
            skippedByReason
        }
    };
}

export function buildToolResultBudgetProjectionForChatContext(
    chatContext: ChatContext,
    taskId: string,
    replacementState: ToolResultReplacementState = ToolResultReplacementStates.create(),
    options: ToolResultBudgetProjectionOptions = {}
): ToolResultBudgetProjectionResult {
    const budgetChars = options.groupBudgetChars ?? LARGE_TOOL_RESULT_CHARS;
    const persistArtifacts = options.persistArtifacts !== false;
    const activeContext = buildActiveContextView(chatContext);
    const synchronizedState = ToolResultReplacementStates.synchronize(replacementState, chatContext);
    const initialAnalysis = analyzeToolResultBudget(activeContext, synchronizedState, options);
    const stableIdsCreatedCount = ensureStableBudgetResultStorageIds(initialAnalysis.candidates);
    const workingState = ToolResultReplacementStates.synchronize(
        ToolResultReplacementStates.clone(synchronizedState),
        chatContext
    );
    const analysis = analyzeToolResultBudget(activeContext, workingState, options);
    const overrides = new Map<string, string>();
    const overrideRecords: ToolResultBudgetOverrideRecord[] = [];
    let newlySeenCount = 0;
    let reappliedCount = 0;
    let newlySelectedCount = 0;
    let persistedCount = 0;
    let unshrinkableFreshCount = 0;

    for (const candidate of analysis.candidates) {
        if (!workingState.seenIds.has(candidate.resultId)) {
            workingState.seenIds.add(candidate.resultId);
            newlySeenCount++;
        }
    }

    const groups: ToolResultBudgetProjectionGroupResult[] = analysis.groups.map((group) => {
        const selectedFreshResultIds: string[] = [];
        const reappliedResultIds: string[] = [];
        let projectedCharsAfterSelection = group.totalProjectedChars;

        for (const candidate of group.candidates) {
            if (candidate.state !== 'must_reapply' || typeof candidate.replacementText !== 'string') {
                continue;
            }
            overrides.set(candidate.resultId, candidate.replacementText);
            overrideRecords.push(createBudgetOverrideRecord(candidate, candidate.replacementText, 'must_reapply'));
            reappliedResultIds.push(candidate.resultId);
            reappliedCount++;
        }

        if (projectedCharsAfterSelection > budgetChars) {
            const freshCandidates = sortFreshBudgetCandidatesBySize(
                group.candidates.filter((candidate) => candidate.state === 'fresh')
            );
            for (const candidate of freshCandidates) {
                if (projectedCharsAfterSelection <= budgetChars) {
                    break;
                }

                const overrideRecord = persistFreshBudgetReplacementForCandidate(
                    taskId,
                    candidate,
                    options.previewOptions,
                    persistArtifacts
                );
                if (!overrideRecord) {
                    unshrinkableFreshCount++;
                    continue;
                }

                overrides.set(overrideRecord.resultId, overrideRecord.replacementText);
                overrideRecords.push(overrideRecord);
                selectedFreshResultIds.push(overrideRecord.resultId);
                projectedCharsAfterSelection =
                    projectedCharsAfterSelection - candidate.sizeChars + overrideRecord.replacementText.length;
                workingState.replacements.set(overrideRecord.resultId, {
                    result_id: overrideRecord.resultId,
                    replacement_text: overrideRecord.replacementText,
                    relative_path: overrideRecord.relativePath
                });
                newlySelectedCount++;
                persistedCount++;
            }
        }

        return {
            ...group,
            budgetChars,
            projectedCharsAfterSelection,
            selectedFreshResultIds,
            reappliedResultIds,
            overBudget: projectedCharsAfterSelection > budgetChars
        };
    });

    return {
        activeContext: analysis.activeContext,
        overrides,
        overrideRecords,
        replacementState: workingState,
        stats: {
            ...analysis.stats,
            overrideCount: overrideRecords.length,
            reappliedCount,
            newlySelectedCount,
            newlySeenCount,
            stableIdsCreatedCount,
            persistedCount,
            overBudgetGroupCount: groups.filter((group) => group.overBudget).length,
            unshrinkableFreshCount,
            totalProjectedCharsAfterSelection: groups.reduce(
                (total, group) => total + group.projectedCharsAfterSelection,
                0
            )
        }
    };
}
