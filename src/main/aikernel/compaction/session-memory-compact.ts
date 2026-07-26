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
import path from 'path';
import { LLM, type LLMRequestOptions } from '../llm.js';
import {
    AssistantMessage,
    ChatContext,
    CompactSeparatorMessage,
    ToolCall,
    UserMessage,
    isCompactBoundaryMessage,
    type ChatMessage,
    type CompactBoundaryTrigger
} from '../messages.js';
import { buildAssistantRounds } from './assistant-rounds.js';
import { getTaskSessionMemoryPath } from '../../utils/setting.js';
import type { AutoCompactDecision } from './auto-compact.js';
import { buildActiveContextView, buildProjectedActiveContextView } from './context-view.js';
import { countFullCompactMessageStats, type FullCompactMessageStats } from './full-compact.js';
import {
    estimateRoughTokensFromAssistantParts,
    estimateRoughTokensFromChatMessage,
    estimateRoughTokensFromToolCall,
    estimateTextTokens,
    estimateVisibleContextTokens
} from './token-estimation.js';
import type { ActiveContextView, AssistantRoundRef, CompactBoundaryRef, ProjectedContextItem } from './types.js';

export const SESSION_MEMORY_STATE_VERSION = 2;
export const SESSION_MEMORY_DIRECTORY_NAME = 'session-memory';
export const SESSION_MEMORY_FILENAME = 'session-memory.md';

export const DEFAULT_SESSION_MEMORY_TEMPLATE = `# Session Title
_A short and distinctive 5-10 word descriptive title for the session._

# Current State
_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._

# Task Specification
_What did the user ask to build? Any constraints or design decisions?_

# Files and Functions
_Important files, functions, and why they matter._

# Workflow
_Commands usually run and how to interpret them._

# Errors & Corrections
_Errors encountered, corrections, and approaches to avoid._

# Key Results
_Exact results or important outputs._

# Worklog
_Terse chronological worklog._
`;

export const SESSION_MEMORY_REQUIRED_HEADINGS = [
    '# Session Title',
    '# Current State',
    '# Task Specification',
    '# Files and Functions',
    '# Workflow',
    '# Errors & Corrections',
    '# Key Results',
    '# Worklog'
] as const;

export const DEFAULT_SESSION_MEMORY_EXTRACTION_OPTIONS = {
    minimumMessageTokensToInit: 10_000,
    minimumTokensBetweenUpdate: 5_000,
    toolCallsBetweenUpdates: 3,
    messageTextPreviewChars: 3_000,
    toolArgsPreviewChars: 1_000,
    toolResultPreviewChars: 1_200,
    maxTranscriptChars: 40_000
} as const;

export interface SessionMemoryState {
    version: number;
    initialized: boolean;
    relativePath?: string;
    lastExtractedAt?: string;
    lastSummarizedMessageId?: string;
    lastSummarizedRoundIndex?: number;
    lastSummarizedRoundStartPartIndex?: number;
    preferredLanguage?: string;
    tokensAtLastExtraction: number;
    extractionInProgress?: boolean;
    lastError?: string;
}

export interface SerializedSessionMemoryState {
    version: number;
    initialized: boolean;
    relative_path?: string;
    last_extracted_at?: string;
    last_summarized_message_id?: string;
    last_summarized_round_index?: number;
    last_summarized_round_start_part_index?: number;
    preferred_language?: string;
    tokens_at_last_extraction: number;
    extraction_in_progress?: boolean;
    last_error?: string;
}

export interface SessionMemoryExtractionOptions {
    minimumMessageTokensToInit?: number;
    minimumTokensBetweenUpdate?: number;
    toolCallsBetweenUpdates?: number;
    messageTextPreviewChars?: number;
    toolArgsPreviewChars?: number;
    toolResultPreviewChars?: number;
    maxTranscriptChars?: number;
}

export type SessionMemoryExtractionDecisionReason =
    | 'extraction_in_progress'
    | 'below_initialization_threshold'
    | 'initialization_threshold_met'
    | 'below_update_threshold'
    | 'unsafe_last_assistant_tool_call'
    | 'tool_call_threshold_met'
    | 'natural_break'
    | 'waiting_for_tool_call_threshold_or_break';

export interface SessionMemoryExtractionDecision {
    shouldExtract: boolean;
    reason: SessionMemoryExtractionDecisionReason;
    currentTokens: number;
    tokensSinceLastExtraction: number;
    toolCallsSinceLastExtraction: number;
    hasRunningOrPendingToolCallInLastAssistant: boolean;
    lastAssistantHasToolCall: boolean;
    minimumMessageTokensToInit: number;
    minimumTokensBetweenUpdate: number;
    toolCallsBetweenUpdates: number;
}

export interface SessionMemoryFile {
    fullPath: string;
    relativePath: string;
    content: string;
    created: boolean;
}

export interface SessionMemoryValidationResult {
    valid: boolean;
    content: string;
    missingHeadings: string[];
}

export interface SessionMemoryUpdatePromptOptions extends SessionMemoryExtractionOptions {
    includeStateDebugInfo?: boolean;
    preferredLanguage?: string;
}

export interface SessionMemoryUpdateRequest {
    chatContext: ChatContext;
    taskId: string;
    model?: string;
    state: SessionMemoryState;
    activeContext: ActiveContextView;
    currentMemory: string;
    prompt: string;
    preferredLanguage?: string;
    currentTokens: number;
    memoryPath: string;
    relativePath: string;
    requestOptions?: LLMRequestOptions;
}

export type SessionMemoryUpdateGenerator = (request: SessionMemoryUpdateRequest) => Promise<string>;

export interface UpdateSessionMemoryOptions extends SessionMemoryExtractionOptions {
    template?: string;
    now?: Date;
    force?: boolean;
    generateMemory?: SessionMemoryUpdateGenerator;
    requestOptions?: LLMRequestOptions;
}

export interface SessionMemoryUpdateResult {
    updated: boolean;
    skipped: boolean;
    state: SessionMemoryState;
    stateChanged: boolean;
    decision: SessionMemoryExtractionDecision;
    memoryPath?: string;
    relativePath?: string;
    prompt?: string;
    error?: string;
}

interface NormalizedSessionMemoryExtractionOptions {
    minimumMessageTokensToInit: number;
    minimumTokensBetweenUpdate: number;
    toolCallsBetweenUpdates: number;
    messageTextPreviewChars: number;
    toolArgsPreviewChars: number;
    toolResultPreviewChars: number;
    maxTranscriptChars: number;
}

function normalizeNonNegativeInteger(value: unknown, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fallback;
    }
    return Math.max(0, Math.floor(value));
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
    return Math.max(1, normalizeNonNegativeInteger(value, fallback));
}

function normalizeBoolean(value: unknown, fallback = false): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

function normalizeOptionalTimestamp(value: unknown): string | undefined {
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
    }

    if (typeof value !== 'string' || value.trim().length === 0) {
        return undefined;
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        return undefined;
    }
    return parsed.toISOString();
}

function normalizeOptionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeOptionalNonNegativeInteger(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        return undefined;
    }
    return Math.floor(value);
}

function normalizeOptionalLanguage(value: unknown): string | undefined {
    return normalizeOptionalString(value);
}

function detectSessionMemoryLanguageFromText(text: string): string {
    const normalized = text.trim();
    if (normalized.length === 0) {
        return 'en-US';
    }

    const hanCount = (normalized.match(/[\u4E00-\u9FFF]/g) ?? []).length;
    const hiraganaCount = (normalized.match(/[\u3040-\u309F]/g) ?? []).length;
    const katakanaCount = (normalized.match(/[\u30A0-\u30FF]/g) ?? []).length;

    if (hiraganaCount + katakanaCount >= 2) {
        return 'ja-JP';
    }

    if (hanCount >= 2 || hiraganaCount + katakanaCount >= 2) {
        return 'zh-CN';
    }

    return 'en-US';
}

function formatSessionMemoryLanguageInstruction(language?: string): string {
    const normalized = normalizeOptionalLanguage(language);
    if (!normalized) {
        return 'Use the same language as the user task input.';
    }

    const lower = normalized.toLowerCase();
    if (lower.startsWith('zh')) {
        return '请使用中文编写正文内容。';
    }
    if (lower.startsWith('ja')) {
        return '本文は日本語で書いてください。';
    }
    if (lower.startsWith('en')) {
        return 'Write the body content in English.';
    }
    return `Write the body content in ${normalized}.`;
}

function collectTaskLanguageSample(chatContext: ChatContext): string {
    const activeContext = getActiveContextForSessionMemory(chatContext);

    for (const message of activeContext.messages) {
        if (!isUserMessage(message)) {
            continue;
        }

        const parts: string[] = [];
        for (const part of message.content) {
            if (part.type === 'text') {
                parts.push(part.text);
            } else if (part.type === 'file') {
                parts.push(part.path);
            }
        }

        const sample = parts.join('\n').trim();
        if (sample.length > 0) {
            return sample.slice(0, 1_000);
        }
    }

    return '';
}

function inferSessionMemoryPreferredLanguage(chatContext: ChatContext, state: SessionMemoryState): string | undefined {
    const preferredLanguage = normalizeOptionalLanguage(state.preferredLanguage);
    if (preferredLanguage) {
        return preferredLanguage;
    }

    const sample = collectTaskLanguageSample(chatContext);
    if (sample.trim().length > 0) {
        return detectSessionMemoryLanguageFromText(sample);
    }

    return undefined;
}

function normalizeExtractionOptions(
    options: SessionMemoryExtractionOptions = {}
): NormalizedSessionMemoryExtractionOptions {
    return {
        minimumMessageTokensToInit: normalizePositiveInteger(
            options.minimumMessageTokensToInit,
            DEFAULT_SESSION_MEMORY_EXTRACTION_OPTIONS.minimumMessageTokensToInit
        ),
        minimumTokensBetweenUpdate: normalizePositiveInteger(
            options.minimumTokensBetweenUpdate,
            DEFAULT_SESSION_MEMORY_EXTRACTION_OPTIONS.minimumTokensBetweenUpdate
        ),
        toolCallsBetweenUpdates: normalizePositiveInteger(
            options.toolCallsBetweenUpdates,
            DEFAULT_SESSION_MEMORY_EXTRACTION_OPTIONS.toolCallsBetweenUpdates
        ),
        messageTextPreviewChars: normalizePositiveInteger(
            options.messageTextPreviewChars,
            DEFAULT_SESSION_MEMORY_EXTRACTION_OPTIONS.messageTextPreviewChars
        ),
        toolArgsPreviewChars: normalizePositiveInteger(
            options.toolArgsPreviewChars,
            DEFAULT_SESSION_MEMORY_EXTRACTION_OPTIONS.toolArgsPreviewChars
        ),
        toolResultPreviewChars: normalizePositiveInteger(
            options.toolResultPreviewChars,
            DEFAULT_SESSION_MEMORY_EXTRACTION_OPTIONS.toolResultPreviewChars
        ),
        maxTranscriptChars: normalizePositiveInteger(
            options.maxTranscriptChars,
            DEFAULT_SESSION_MEMORY_EXTRACTION_OPTIONS.maxTranscriptChars
        )
    };
}

function createDefaultSessionMemoryState(): SessionMemoryState {
    return {
        version: SESSION_MEMORY_STATE_VERSION,
        initialized: false,
        tokensAtLastExtraction: 0,
        extractionInProgress: false
    };
}

function normalizeSessionMemoryState(raw: unknown): SessionMemoryState {
    const defaults = createDefaultSessionMemoryState();
    if (!raw || typeof raw !== 'object') {
        return { ...defaults };
    }

    const candidate = raw as {
        version?: unknown;
        initialized?: unknown;
        relative_path?: unknown;
        relativePath?: unknown;
        last_extracted_at?: unknown;
        lastExtractedAt?: unknown;
        last_summarized_message_id?: unknown;
        lastSummarizedMessageId?: unknown;
        last_summarized_round_index?: unknown;
        lastSummarizedRoundIndex?: unknown;
        last_summarized_round_start_part_index?: unknown;
        lastSummarizedRoundStartPartIndex?: unknown;
        preferred_language?: unknown;
        preferredLanguage?: unknown;
        tokens_at_last_extraction?: unknown;
        tokensAtLastExtraction?: unknown;
        extraction_in_progress?: unknown;
        extractionInProgress?: unknown;
        last_error?: unknown;
        lastError?: unknown;
    };

    const lastSummarizedMessageId = normalizeOptionalString(
        candidate.last_summarized_message_id ?? candidate.lastSummarizedMessageId
    );
    const lastSummarizedRoundIndex = normalizeOptionalNonNegativeInteger(
        candidate.last_summarized_round_index ?? candidate.lastSummarizedRoundIndex
    );
    const lastSummarizedRoundStartPartIndex = normalizeOptionalNonNegativeInteger(
        candidate.last_summarized_round_start_part_index ?? candidate.lastSummarizedRoundStartPartIndex
    );
    const hasRoundAnchor =
        lastSummarizedMessageId !== undefined &&
        lastSummarizedRoundIndex !== undefined &&
        lastSummarizedRoundStartPartIndex !== undefined;

    return {
        version: SESSION_MEMORY_STATE_VERSION,
        initialized: normalizeBoolean(candidate.initialized, defaults.initialized),
        relativePath: normalizeOptionalString(candidate.relative_path ?? candidate.relativePath),
        lastExtractedAt: normalizeOptionalTimestamp(candidate.last_extracted_at ?? candidate.lastExtractedAt),
        lastSummarizedMessageId,
        lastSummarizedRoundIndex: hasRoundAnchor ? lastSummarizedRoundIndex : undefined,
        lastSummarizedRoundStartPartIndex: hasRoundAnchor ? lastSummarizedRoundStartPartIndex : undefined,
        preferredLanguage: normalizeOptionalLanguage(candidate.preferred_language ?? candidate.preferredLanguage),
        tokensAtLastExtraction: normalizeNonNegativeInteger(
            candidate.tokens_at_last_extraction ?? candidate.tokensAtLastExtraction,
            defaults.tokensAtLastExtraction
        ),
        extractionInProgress: normalizeBoolean(
            candidate.extraction_in_progress ?? candidate.extractionInProgress,
            false
        ),
        lastError: normalizeOptionalString(candidate.last_error ?? candidate.lastError)
    };
}

function errorToMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export class SessionMemoryStates {
    static create(): SessionMemoryState {
        return createDefaultSessionMemoryState();
    }

    static clone(state: SessionMemoryState): SessionMemoryState {
        return normalizeSessionMemoryState(state);
    }

    static deserialize(raw: unknown): SessionMemoryState {
        return normalizeSessionMemoryState(raw);
    }

    static serialize(state: SessionMemoryState): SerializedSessionMemoryState {
        const normalized = normalizeSessionMemoryState(state);
        return {
            version: normalized.version,
            initialized: normalized.initialized,
            relative_path: normalized.relativePath,
            last_extracted_at: normalized.lastExtractedAt,
            last_summarized_message_id: normalized.lastSummarizedMessageId,
            last_summarized_round_index: normalized.lastSummarizedRoundIndex,
            last_summarized_round_start_part_index: normalized.lastSummarizedRoundStartPartIndex,
            preferred_language: normalized.preferredLanguage,
            tokens_at_last_extraction: normalized.tokensAtLastExtraction,
            extraction_in_progress: normalized.extractionInProgress,
            last_error: normalized.lastError
        };
    }

    static recordExtractionStarted(state: SessionMemoryState): SessionMemoryState {
        const normalized = normalizeSessionMemoryState(state);
        return {
            ...normalized,
            extractionInProgress: true,
            lastError: undefined
        };
    }

    static recordExtractionSuccess(
        state: SessionMemoryState,
        args: {
            relativePath: string;
            currentTokens: number;
            lastSummarizedMessageId?: string;
            lastSummarizedRoundIndex?: number;
            lastSummarizedRoundStartPartIndex?: number;
            preferredLanguage?: string;
            at?: Date;
        }
    ): SessionMemoryState {
        const normalized = normalizeSessionMemoryState(state);
        const at = args.at ?? new Date();
        return {
            ...normalized,
            initialized: true,
            relativePath: args.relativePath,
            lastExtractedAt: at.toISOString(),
            lastSummarizedMessageId: args.lastSummarizedMessageId ?? normalized.lastSummarizedMessageId,
            lastSummarizedRoundIndex: normalizeOptionalNonNegativeInteger(args.lastSummarizedRoundIndex),
            lastSummarizedRoundStartPartIndex: normalizeOptionalNonNegativeInteger(
                args.lastSummarizedRoundStartPartIndex
            ),
            preferredLanguage: normalizeOptionalLanguage(args.preferredLanguage) ?? normalized.preferredLanguage,
            tokensAtLastExtraction: normalizeNonNegativeInteger(args.currentTokens, normalized.tokensAtLastExtraction),
            extractionInProgress: false,
            lastError: undefined
        };
    }

    static recordExtractionFailure(state: SessionMemoryState, error: unknown): SessionMemoryState {
        const normalized = normalizeSessionMemoryState(state);
        return {
            ...normalized,
            extractionInProgress: false,
            lastError: errorToMessage(error)
        };
    }
}

export function getTaskSessionMemoryRelativePath(taskId: string): string {
    return path.join('artifacts', taskId, SESSION_MEMORY_DIRECTORY_NAME, SESSION_MEMORY_FILENAME);
}

export async function ensureTaskSessionMemoryFile(
    taskId: string,
    options: { template?: string } = {}
): Promise<SessionMemoryFile> {
    const fullPath = getTaskSessionMemoryPath(taskId, true);
    const relativePath = getTaskSessionMemoryRelativePath(taskId);
    let created = false;

    try {
        await fs.promises.access(fullPath);
    } catch {
        await fs.promises.writeFile(fullPath, options.template ?? DEFAULT_SESSION_MEMORY_TEMPLATE, {
            encoding: 'utf8'
        });
        created = true;
    }

    const content = await fs.promises.readFile(fullPath, 'utf8');
    return { fullPath, relativePath, content, created };
}

export async function readTaskSessionMemory(
    taskId: string,
    options: { ensureExists?: boolean; template?: string } = {}
): Promise<string | undefined> {
    if (options.ensureExists) {
        return (await ensureTaskSessionMemoryFile(taskId, { template: options.template })).content;
    }

    const fullPath = getTaskSessionMemoryPath(taskId, false);
    try {
        return await fs.promises.readFile(fullPath, 'utf8');
    } catch {
        return undefined;
    }
}

export async function writeTaskSessionMemory(
    taskId: string,
    content: string
): Promise<{ fullPath: string; relativePath: string }> {
    const fullPath = getTaskSessionMemoryPath(taskId, true);
    const relativePath = getTaskSessionMemoryRelativePath(taskId);
    const tmpPath = `${fullPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;

    try {
        await fs.promises.writeFile(tmpPath, content, { encoding: 'utf8' });
        try {
            await fs.promises.rename(tmpPath, fullPath);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException | undefined)?.code;
            if (!['ENOENT', 'EPERM', 'EXDEV'].includes(code ?? '')) {
                throw error;
            }

            await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
            await fs.promises.writeFile(fullPath, content, { encoding: 'utf8' });
        }
    } catch (error) {
        try {
            await fs.promises.rm(tmpPath, { force: true });
        } catch {
            /* cleanup best-effort */
        }
        throw error;
    }

    try {
        await fs.promises.rm(tmpPath, { force: true });
    } catch {
        /* cleanup best-effort */
    }

    return { fullPath, relativePath };
}

export function unwrapMarkdownFence(content: string): string {
    const trimmed = content.trim();
    const match = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
    return match ? match[1].trim() : trimmed;
}

export function validateSessionMemoryMarkdown(content: string): SessionMemoryValidationResult {
    const normalizedContent = unwrapMarkdownFence(content);
    const missingHeadings = SESSION_MEMORY_REQUIRED_HEADINGS.filter((heading) => {
        const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return !new RegExp(`^${escaped}\\s*$`, 'm').test(normalizedContent);
    });

    return {
        valid: normalizedContent.trim().length > 0 && missingHeadings.length === 0,
        content: normalizedContent,
        missingHeadings
    };
}

export function isSessionMemoryTemplateOnly(
    content: string,
    template: string = DEFAULT_SESSION_MEMORY_TEMPLATE
): boolean {
    return content.trim() === template.trim();
}

function isUserMessage(message: ChatMessage): message is UserMessage {
    return message instanceof UserMessage || message.role === 'user';
}

function isAssistantMessage(message: ChatMessage): message is AssistantMessage {
    return message instanceof AssistantMessage || message.role === 'assistant';
}

function getActiveContextForSessionMemory(chatContext: ChatContext): ActiveContextView {
    return buildActiveContextView(chatContext);
}

function getMessageId(message: ChatMessage): string | undefined {
    if (isUserMessage(message) || isAssistantMessage(message)) {
        return normalizeOptionalString(message.message_id);
    }
    return undefined;
}

function estimateToolCallTokens(toolCall: ToolCall): number {
    return estimateRoughTokensFromToolCall(toolCall);
}

export function estimateChatMessageTokensForSessionMemory(message: ChatMessage): number {
    return estimateRoughTokensFromChatMessage(message);
}

function getLastAssistantMessageFromMessages(messages: ReadonlyArray<ChatMessage>): AssistantMessage | undefined {
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (isAssistantMessage(message)) {
            return message;
        }
    }
    return undefined;
}

export function estimateChatContextTokensForSessionMemory(chatContext: ChatContext): number {
    return estimateVisibleContextTokens({
        activeContext: getActiveContextForSessionMemory(chatContext),
        systemPrompt: chatContext.system_prompt
    }).estimatedContextTokens;
}

export function countToolCallsSinceMessage(chatContext: ChatContext, messageId?: string): number {
    const activeContext = getActiveContextForSessionMemory(chatContext);
    const floorIndex = activeContext.startIndex;
    let startIndex = floorIndex;

    if (messageId !== undefined) {
        for (let index = floorIndex; index < chatContext.messages.length; index++) {
            if (getMessageId(chatContext.messages[index]) === messageId) {
                startIndex = index + 1;
                break;
            }
        }
    }

    let toolCalls = 0;

    for (let index = startIndex; index < chatContext.messages.length; index++) {
        const message = chatContext.messages[index];
        if (!isAssistantMessage(message)) {
            continue;
        }

        for (const part of message.content) {
            if (part.type === 'tool_call') {
                toolCalls += part.toolcalls.length;
            }
        }
    }

    return toolCalls;
}

export interface SessionMemoryCoverageAnchor {
    kind: 'user_message' | 'assistant_round';
    messageId: string;
    roundIndex?: number;
    roundStartPartIndex?: number;
}

function countToolCallsInAssistantMessageFromPartIndex(message: AssistantMessage, startPartIndex: number): number {
    let toolCalls = 0;

    for (let index = Math.max(0, startPartIndex); index < message.content.length; index++) {
        const part = message.content[index];
        if (part.type !== 'tool_call') {
            continue;
        }
        toolCalls += part.toolcalls.length;
    }

    return toolCalls;
}

export function getLastSafeSessionMemoryCoverageAnchor(
    chatContext: ChatContext
): SessionMemoryCoverageAnchor | undefined {
    const activeContext = getActiveContextForSessionMemory(chatContext);

    for (let index = activeContext.messages.length - 1; index >= 0; index--) {
        const message = activeContext.messages[index];
        if (isAssistantMessage(message)) {
            if (assistantHasRunningOrPendingToolCall(message)) {
                continue;
            }

            const rounds = buildAssistantRounds(message);
            const lastRound = rounds[rounds.length - 1];
            if (lastRound) {
                return {
                    kind: 'assistant_round',
                    messageId: message.message_id,
                    roundIndex: lastRound.ref.roundIndex,
                    roundStartPartIndex: lastRound.ref.startPartIndex
                };
            }
            continue;
        }

        const messageId = getMessageId(message);
        if (messageId) {
            return {
                kind: 'user_message',
                messageId
            };
        }
    }
    return undefined;
}

export function getLastSafeSessionMemoryMessageId(chatContext: ChatContext): string | undefined {
    return getLastSafeSessionMemoryCoverageAnchor(chatContext)?.messageId;
}

function countToolCallsSinceCoverageAnchor(chatContext: ChatContext, state: SessionMemoryState): number {
    const activeContext = getActiveContextForSessionMemory(chatContext);
    const floorIndex = activeContext.startIndex;
    const anchorRoundIndex = state.lastSummarizedRoundIndex;
    const anchorRoundStartPartIndex = state.lastSummarizedRoundStartPartIndex;

    if (state.lastSummarizedMessageId && anchorRoundIndex !== undefined && anchorRoundStartPartIndex !== undefined) {
        for (let index = floorIndex; index < chatContext.messages.length; index++) {
            const message = chatContext.messages[index];
            if (!isAssistantMessage(message) || getMessageId(message) !== state.lastSummarizedMessageId) {
                continue;
            }

            const rounds = buildAssistantRounds(message);
            const round = rounds.find(
                (candidate) =>
                    candidate.ref.roundIndex === anchorRoundIndex &&
                    candidate.ref.startPartIndex === anchorRoundStartPartIndex
            );
            if (round) {
                let toolCalls = countToolCallsInAssistantMessageFromPartIndex(message, round.ref.endPartIndexExclusive);
                for (let laterIndex = index + 1; laterIndex < chatContext.messages.length; laterIndex++) {
                    const laterMessage = chatContext.messages[laterIndex];
                    if (!isAssistantMessage(laterMessage)) {
                        continue;
                    }
                    toolCalls += countToolCallsInAssistantMessageFromPartIndex(laterMessage, 0);
                }
                return toolCalls;
            }
            break;
        }
    }

    return countToolCallsSinceMessage(chatContext, state.lastSummarizedMessageId);
}

function assistantHasToolCall(message: AssistantMessage | undefined): boolean {
    return message?.content.some((part) => part.type === 'tool_call' && part.toolcalls.length > 0) ?? false;
}

function assistantHasRunningOrPendingToolCall(message: AssistantMessage | undefined): boolean {
    return (
        message?.content.some(
            (part) =>
                part.type === 'tool_call' &&
                part.toolcalls.some((toolCall) => toolCall.status === 'pending' || toolCall.status === 'running')
        ) ?? false
    );
}

export function hasRunningOrPendingToolCallInLastAssistant(chatContext: ChatContext): boolean {
    const activeContext = getActiveContextForSessionMemory(chatContext);
    return assistantHasRunningOrPendingToolCall(getLastAssistantMessageFromMessages(activeContext.messages));
}

export function shouldExtractSessionMemory(
    chatContext: ChatContext,
    state: SessionMemoryState,
    options: SessionMemoryExtractionOptions = {}
): SessionMemoryExtractionDecision {
    const normalizedState = normalizeSessionMemoryState(state);
    const normalizedOptions = normalizeExtractionOptions(options);
    const activeContext = getActiveContextForSessionMemory(chatContext);
    const currentTokens = estimateChatContextTokensForSessionMemory(chatContext);
    const tokensSinceLastExtraction = Math.max(currentTokens - normalizedState.tokensAtLastExtraction, 0);
    const toolCallsSinceLastExtraction = countToolCallsSinceCoverageAnchor(chatContext, normalizedState);
    const lastAssistant = getLastAssistantMessageFromMessages(activeContext.messages);
    const lastAssistantHasToolCall = assistantHasToolCall(lastAssistant);
    const hasRunningOrPending = assistantHasRunningOrPendingToolCall(lastAssistant);

    const baseDecision = {
        currentTokens,
        tokensSinceLastExtraction,
        toolCallsSinceLastExtraction,
        hasRunningOrPendingToolCallInLastAssistant: hasRunningOrPending,
        lastAssistantHasToolCall,
        minimumMessageTokensToInit: normalizedOptions.minimumMessageTokensToInit,
        minimumTokensBetweenUpdate: normalizedOptions.minimumTokensBetweenUpdate,
        toolCallsBetweenUpdates: normalizedOptions.toolCallsBetweenUpdates
    };

    if (normalizedState.extractionInProgress) {
        return { ...baseDecision, shouldExtract: false, reason: 'extraction_in_progress' };
    }

    if (!normalizedState.initialized && currentTokens < normalizedOptions.minimumMessageTokensToInit) {
        return { ...baseDecision, shouldExtract: false, reason: 'below_initialization_threshold' };
    }

    if (hasRunningOrPending) {
        return { ...baseDecision, shouldExtract: false, reason: 'unsafe_last_assistant_tool_call' };
    }

    if (!normalizedState.initialized) {
        return { ...baseDecision, shouldExtract: true, reason: 'initialization_threshold_met' };
    }

    if (tokensSinceLastExtraction < normalizedOptions.minimumTokensBetweenUpdate) {
        return { ...baseDecision, shouldExtract: false, reason: 'below_update_threshold' };
    }

    if (toolCallsSinceLastExtraction >= normalizedOptions.toolCallsBetweenUpdates) {
        return { ...baseDecision, shouldExtract: true, reason: 'tool_call_threshold_met' };
    }

    if (!lastAssistantHasToolCall) {
        return { ...baseDecision, shouldExtract: true, reason: 'natural_break' };
    }

    return { ...baseDecision, shouldExtract: false, reason: 'waiting_for_tool_call_threshold_or_break' };
}

function truncateText(text: string | undefined, maxChars: number): string {
    if (!text) {
        return '';
    }
    if (text.length <= maxChars) {
        return text;
    }
    return `${text.slice(0, maxChars)}\n[... truncated ${text.length - maxChars} chars ...]`;
}

function serializeUserMessageForSessionMemory(
    message: UserMessage,
    options: NormalizedSessionMemoryExtractionOptions
): string {
    const parts = message.content
        .map((part) => {
            if (part.type === 'text') {
                return truncateText(part.text, options.messageTextPreviewChars);
            }
            if (part.type === 'file') {
                return `[File: ${part.path}]`;
            }
            if (part.type === 'image_url') {
                return part.file_path ? part.toModelText() : `[Image: ${part.image_url.url}]`;
            }
            return '';
        })
        .filter((part) => part.trim().length > 0);

    return `[User ${message.message_id}]\n${parts.join('\n')}`;
}

function serializeAssistantMessageForSessionMemory(
    message: AssistantMessage,
    options: NormalizedSessionMemoryExtractionOptions
): string {
    const parts: string[] = [];

    for (const part of message.content) {
        if (part.type === 'text') {
            parts.push(`[Assistant Text]\n${truncateText(part.text, options.messageTextPreviewChars)}`);
        } else if (part.type === 'reasoning') {
            parts.push('[Reasoning omitted]');
        } else if (part.type === 'error') {
            parts.push(`[Assistant Error]\n${part.title}: ${part.message}`);
        } else if (part.type === 'tool_call') {
            for (const toolCall of part.toolcalls) {
                parts.push(
                    [
                        `[Tool Call ${toolCall.id}] ${toolCall.tool_name} (${toolCall.status})`,
                        `Args: ${truncateText(toolCall.args_string || '{}', options.toolArgsPreviewChars)}`,
                        `Result: ${truncateText(toolCall.result ?? '', options.toolResultPreviewChars) || '<no result>'}`
                    ].join('\n')
                );
            }
        }
    }

    return `[Assistant ${message.message_id}]\n${parts.join('\n\n')}`;
}

function serializeMessageForSessionMemory(
    message: ChatMessage,
    options: NormalizedSessionMemoryExtractionOptions
): string {
    if (isCompactBoundaryMessage(message)) {
        return `[Compact Boundary]\n${truncateText(message.summary, options.messageTextPreviewChars)}`;
    }

    if (isUserMessage(message)) {
        return serializeUserMessageForSessionMemory(message, options);
    }

    if (isAssistantMessage(message)) {
        return serializeAssistantMessageForSessionMemory(message, options);
    }

    return '';
}

export function serializeActiveContextForSessionMemory(
    activeContext: ActiveContextView,
    options: SessionMemoryExtractionOptions = {}
): string {
    const normalizedOptions = normalizeExtractionOptions(options);
    const parts = activeContext.messages
        .map((message) => serializeMessageForSessionMemory(message, normalizedOptions))
        .filter((part) => part.trim().length > 0);
    const transcript = parts.join('\n\n---\n\n');

    if (transcript.length <= normalizedOptions.maxTranscriptChars) {
        return transcript;
    }

    return (
        `[Older transcript omitted: ${transcript.length - normalizedOptions.maxTranscriptChars} chars]\n\n` +
        transcript.slice(-normalizedOptions.maxTranscriptChars)
    );
}

export function buildSessionMemoryUpdatePrompt(
    currentMemory: string,
    activeContext: ActiveContextView,
    state: SessionMemoryState,
    options: SessionMemoryUpdatePromptOptions = {}
): string {
    const normalizedState = normalizeSessionMemoryState(state);
    const transcript = serializeActiveContextForSessionMemory(activeContext, options);
    const preferredLanguage = normalizeOptionalLanguage(options.preferredLanguage);
    const stateDebugInfo = options.includeStateDebugInfo
        ? `\nState: ${JSON.stringify(SessionMemoryStates.serialize(normalizedState), null, 2)}\n`
        : '';
    const languageInstruction = preferredLanguage
        ? formatSessionMemoryLanguageInstruction(preferredLanguage)
        : "Write the section content in the same language as the user's task input.";

    return `IMPORTANT: This message is not part of the user conversation. Do not mention note-taking, session memory, this prompt, or the update process in the output.

You maintain a task-local markdown memory file for the current OpenDesk task. Update it using the current memory and the active conversation transcript below.

Rules:
- Output the complete markdown file only. Do not wrap it in code fences.
- Preserve exactly these section headings and keep them in this order:
${SESSION_MEMORY_REQUIRED_HEADINGS.map((heading) => `  - ${heading}`).join('\n')}
- Keep each italic section description line from the template.
- Keep the headings in English, but ${languageInstruction}
- Update actual content below the italic descriptions with dense, specific facts.
- Always make "# Current State" reflect the most recent work, pending tasks, and immediate next steps.
- Include concrete file paths, function names, commands, errors, decisions, and exact key results when available.
- Do not include private reasoning or hidden chain-of-thought. If reasoning is shown as omitted, ignore it.
- Do not add long generic prose or filler.
${stateDebugInfo}
Current memory:
<current_memory>
${currentMemory}
</current_memory>

Active conversation transcript:
<active_context>
${transcript}
</active_context>

Return only the complete updated markdown memory file.`;
}

async function defaultSessionMemoryGenerator(request: SessionMemoryUpdateRequest): Promise<string> {
    return await LLM.ask(request.prompt, request.model, request.requestOptions);
}

export async function updateSessionMemoryFromChatContext(
    chatContext: ChatContext,
    taskId: string,
    model: string | undefined,
    state: SessionMemoryState,
    options: UpdateSessionMemoryOptions = {}
): Promise<SessionMemoryUpdateResult> {
    const normalizedState = SessionMemoryStates.clone(state);
    const decision = shouldExtractSessionMemory(chatContext, normalizedState, options);

    if (!options.force && !decision.shouldExtract) {
        return {
            updated: false,
            skipped: true,
            state: normalizedState,
            stateChanged: false,
            decision
        };
    }

    const startedState = SessionMemoryStates.recordExtractionStarted(normalizedState);
    const sessionMemoryFile = await ensureTaskSessionMemoryFile(taskId, { template: options.template });
    const activeContext = buildActiveContextView(chatContext);
    const preferredLanguage = inferSessionMemoryPreferredLanguage(chatContext, startedState);
    const prompt = buildSessionMemoryUpdatePrompt(sessionMemoryFile.content, activeContext, startedState, {
        ...options,
        preferredLanguage
    });
    const generator = options.generateMemory ?? defaultSessionMemoryGenerator;

    try {
        const rawUpdatedMemory = await generator({
            chatContext,
            taskId,
            model,
            state: startedState,
            activeContext,
            currentMemory: sessionMemoryFile.content,
            prompt,
            preferredLanguage,
            currentTokens: decision.currentTokens,
            memoryPath: sessionMemoryFile.fullPath,
            relativePath: sessionMemoryFile.relativePath,
            requestOptions: options.requestOptions
        });

        const validation = validateSessionMemoryMarkdown(rawUpdatedMemory);
        if (!validation.valid) {
            throw new Error(
                `invalid session memory markdown; missing headings: ${validation.missingHeadings.join(', ')}`
            );
        }

        const writeResult = await writeTaskSessionMemory(
            taskId,
            validation.content.endsWith('\n') ? validation.content : `${validation.content}\n`
        );
        const coverageAnchor = getLastSafeSessionMemoryCoverageAnchor(chatContext);
        const successState = SessionMemoryStates.recordExtractionSuccess(startedState, {
            relativePath: writeResult.relativePath,
            currentTokens: decision.currentTokens,
            lastSummarizedMessageId: coverageAnchor?.messageId,
            lastSummarizedRoundIndex: coverageAnchor?.roundIndex,
            lastSummarizedRoundStartPartIndex: coverageAnchor?.roundStartPartIndex,
            preferredLanguage,
            at: options.now
        });

        return {
            updated: true,
            skipped: false,
            state: successState,
            stateChanged: true,
            decision,
            memoryPath: writeResult.fullPath,
            relativePath: writeResult.relativePath,
            prompt
        };
    } catch (error) {
        const failureState = SessionMemoryStates.recordExtractionFailure(startedState, error);
        return {
            updated: false,
            skipped: false,
            state: failureState,
            stateChanged: true,
            decision,
            memoryPath: sessionMemoryFile.fullPath,
            relativePath: sessionMemoryFile.relativePath,
            prompt,
            error: errorToMessage(error)
        };
    }
}

export const SESSION_MEMORY_COMPACT_BOUNDARY_STRATEGY = 'session_memory_compact';
export const DEFAULT_SESSION_MEMORY_COMPACT_MIN_TOKENS = 4_000;
export const DEFAULT_SESSION_MEMORY_COMPACT_MIN_TEXT_MESSAGES = 4;
export const DEFAULT_SESSION_MEMORY_COMPACT_MAX_TOKENS = 24_000;
export const DEFAULT_SESSION_MEMORY_COMPACT_MIN_MEMORY_CHARS = 80;
export const DEFAULT_SESSION_MEMORY_COMPACT_MAX_MEMORY_CHARS = 48_000;

export type SessionMemoryCompactPlanReason = 'normal' | 'resume_without_last_summarized_message';

export type SessionMemoryCompactNoopReason =
    | 'missing_state'
    | 'missing_task_id'
    | 'missing_memory_file'
    | 'empty_memory'
    | 'template_memory'
    | 'memory_too_short'
    | 'plan_unavailable'
    | 'post_compact_threshold_exceeded';

export interface SessionMemoryCompactOptions {
    minTokens?: number;
    minTextMessages?: number;
    maxTokens?: number;
    minMemoryChars?: number;
    maxMemoryChars?: number;
    trigger?: CompactBoundaryTrigger;
    createdAt?: string;
    boundaryId?: string;
    memoryTemplate?: string;
    autoCompactThreshold?: number;
    enableAssistantRoundBoundary?: boolean;
}

export interface SessionMemoryCompactKeepAnchor {
    kind: 'message_start' | 'assistant_round';
    messageIndex: number;
    messageId: string;
    roundRef?: AssistantRoundRef;
    startPartIndex?: number;
}

export interface SessionMemoryCompactLeadingPartialAssistant {
    message: AssistantMessage;
    messageIndex: number;
    roundRef: AssistantRoundRef;
}

export interface SessionMemoryCompactPlan {
    activeContextStartIndex: number;
    physicalKeepStartIndex: number;
    keepStartIndex: number;
    messagesToKeep: ChatMessage[];
    projectedItemsToSummarize?: ProjectedContextItem[];
    projectedItemsToKeep?: ProjectedContextItem[];
    keepAnchor?: SessionMemoryCompactKeepAnchor;
    leadingPartialAssistant?: SessionMemoryCompactLeadingPartialAssistant;
    memoryContent: string;
    reason: SessionMemoryCompactPlanReason;
    previousBoundary?: CompactBoundaryRef;
    lastSummarizedMessageId?: string;
    summarizedStats: FullCompactMessageStats;
    keptStats: FullCompactMessageStats;
    estimatedKeptTokens: number;
}

export interface SessionMemoryCompactResult {
    boundary: CompactSeparatorMessage;
    plan: SessionMemoryCompactPlan;
}

export interface SessionMemoryCompactRunResult {
    compacted: boolean;
    noopReason?: SessionMemoryCompactNoopReason;
    plan?: SessionMemoryCompactPlan;
    result?: SessionMemoryCompactResult;
    boundary?: CompactSeparatorMessage;
    memoryContent?: string;
    postCompactTokens?: number;
    autoCompactThreshold?: number;
}

interface NormalizedSessionMemoryCompactOptions {
    minTokens: number;
    minTextMessages: number;
    maxTokens: number;
    minMemoryChars: number;
    maxMemoryChars: number;
    trigger: CompactBoundaryTrigger;
    createdAt?: string;
    boundaryId?: string;
    memoryTemplate: string;
    autoCompactThreshold?: number;
    enableAssistantRoundBoundary: boolean;
}

function normalizeOptionalPositiveInteger(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return undefined;
    }
    return Math.floor(value);
}

function normalizeCompactOptions(options: SessionMemoryCompactOptions = {}): NormalizedSessionMemoryCompactOptions {
    const minTokens = normalizePositiveInteger(options.minTokens, DEFAULT_SESSION_MEMORY_COMPACT_MIN_TOKENS);
    const maxTokens = Math.max(
        minTokens,
        normalizePositiveInteger(options.maxTokens, DEFAULT_SESSION_MEMORY_COMPACT_MAX_TOKENS)
    );

    return {
        minTokens,
        minTextMessages: normalizePositiveInteger(
            options.minTextMessages,
            DEFAULT_SESSION_MEMORY_COMPACT_MIN_TEXT_MESSAGES
        ),
        maxTokens,
        minMemoryChars: normalizePositiveInteger(
            options.minMemoryChars,
            DEFAULT_SESSION_MEMORY_COMPACT_MIN_MEMORY_CHARS
        ),
        maxMemoryChars: normalizePositiveInteger(
            options.maxMemoryChars,
            DEFAULT_SESSION_MEMORY_COMPACT_MAX_MEMORY_CHARS
        ),
        trigger: options.trigger ?? 'auto',
        createdAt: options.createdAt,
        boundaryId: options.boundaryId,
        memoryTemplate: options.memoryTemplate ?? DEFAULT_SESSION_MEMORY_TEMPLATE,
        autoCompactThreshold: normalizeOptionalPositiveInteger(options.autoCompactThreshold),
        enableAssistantRoundBoundary: options.enableAssistantRoundBoundary === true
    };
}

function hasTextContent(message: ChatMessage): boolean {
    if (isCompactBoundaryMessage(message)) {
        return message.summary.trim().length > 0;
    }

    if (isUserMessage(message)) {
        return message.content.some((part) => {
            if (part.type === 'text') {
                return part.text.trim().length > 0;
            }
            if (part.type === 'file') {
                return part.path.trim().length > 0;
            }
            return false;
        });
    }

    if (isAssistantMessage(message)) {
        return message.content.some((part) => {
            if (part.type === 'text') {
                return part.text.trim().length > 0;
            }
            if (part.type === 'error') {
                return part.title.trim().length > 0 || part.message.trim().length > 0;
            }
            if (part.type === 'tool_call') {
                return part.toolcalls.some(
                    (toolCall) =>
                        toolCall.tool_name.trim().length > 0 ||
                        toolCall.args_string.trim().length > 0 ||
                        (toolCall.result?.trim().length ?? 0) > 0
                );
            }
            return false;
        });
    }

    return false;
}

function estimateMessagesTokens(messages: ChatMessage[]): number {
    return messages.reduce((total, message) => total + estimateChatMessageTokensForSessionMemory(message), 0);
}

function countTextMessages(messages: ChatMessage[]): number {
    return messages.filter((message) => !isCompactBoundaryMessage(message) && hasTextContent(message)).length;
}

function assistantRoundHasTextContent(item: Extract<ProjectedContextItem, { kind: 'assistant_round' }>): boolean {
    return item.round.parts.some((part) => {
        if (part.type === 'text') {
            return part.text.trim().length > 0;
        }
        if (part.type === 'error') {
            return part.title.trim().length > 0 || part.message.trim().length > 0;
        }
        if (part.type === 'tool_call') {
            return part.toolcalls.some(
                (toolCall) =>
                    toolCall.tool_name.trim().length > 0 ||
                    toolCall.args_string.trim().length > 0 ||
                    (toolCall.result?.trim().length ?? 0) > 0
            );
        }
        return false;
    });
}

function estimateAssistantRoundTokens(item: Extract<ProjectedContextItem, { kind: 'assistant_round' }>): number {
    return estimateRoughTokensFromAssistantParts(item.round.parts);
}

function estimateProjectedItemsTokens(projectedItems: ProjectedContextItem[]): number {
    return projectedItems.reduce((total, item) => {
        if (item.kind === 'compact_boundary') {
            return total + estimateTextTokens(item.message.summary);
        }
        if (item.kind === 'user_message') {
            return total + estimateChatMessageTokensForSessionMemory(item.message);
        }
        return total + estimateAssistantRoundTokens(item);
    }, 0);
}

function countTextProjectedItems(projectedItems: ProjectedContextItem[]): number {
    return projectedItems.filter((item) => {
        if (item.kind === 'compact_boundary') {
            return false;
        }
        if (item.kind === 'user_message') {
            return hasTextContent(item.message);
        }
        return assistantRoundHasTextContent(item);
    }).length;
}

function findFirstProjectedItemIndexAtOrAfterMessageIndex(
    projectedItems: ProjectedContextItem[],
    messageIndex: number
): number {
    for (let index = 0; index < projectedItems.length; index++) {
        const item = projectedItems[index];
        if (item.kind !== 'compact_boundary' && item.messageIndex >= messageIndex) {
            return index;
        }
    }
    return projectedItems.length;
}

function findFirstProjectedItemIndexAfterMessageIndex(
    projectedItems: ProjectedContextItem[],
    messageIndex: number
): number {
    for (let index = 0; index < projectedItems.length; index++) {
        const item = projectedItems[index];
        if (item.kind !== 'compact_boundary' && item.messageIndex > messageIndex) {
            return index;
        }
    }
    return projectedItems.length;
}

function expandKeepStartProjectedItemIndex(
    projectedItems: ProjectedContextItem[],
    initialKeepProjectedItemIndex: number,
    floorProjectedItemIndex: number,
    options: NormalizedSessionMemoryCompactOptions
): number {
    let keepProjectedItemIndex = Math.min(
        Math.max(initialKeepProjectedItemIndex, floorProjectedItemIndex),
        projectedItems.length
    );
    let keptProjectedItems = projectedItems
        .slice(keepProjectedItemIndex)
        .filter((item) => item.kind !== 'compact_boundary');
    let keptTokens = estimateProjectedItemsTokens(keptProjectedItems);
    let textMessages = countTextProjectedItems(keptProjectedItems);

    if (keptTokens >= options.maxTokens) {
        return keepProjectedItemIndex;
    }

    if (keptTokens >= options.minTokens && textMessages >= options.minTextMessages) {
        return keepProjectedItemIndex;
    }

    for (let index = keepProjectedItemIndex - 1; index >= floorProjectedItemIndex; index--) {
        const item = projectedItems[index];
        if (item.kind === 'compact_boundary') {
            continue;
        }

        const itemTokens =
            item.kind === 'assistant_round'
                ? estimateAssistantRoundTokens(item)
                : estimateChatMessageTokensForSessionMemory(item.message);
        if (keptProjectedItems.length > 0 && keptTokens + itemTokens > options.maxTokens) {
            break;
        }

        keepProjectedItemIndex = index;
        keptTokens += itemTokens;
        keptProjectedItems = [item, ...keptProjectedItems];
        if (item.kind === 'assistant_round' ? assistantRoundHasTextContent(item) : hasTextContent(item.message)) {
            textMessages++;
        }

        if (keptTokens >= options.minTokens && textMessages >= options.minTextMessages) {
            break;
        }
    }

    return keepProjectedItemIndex;
}

function countProjectedItemStats(projectedItems: ProjectedContextItem[]): FullCompactMessageStats {
    const stats: FullCompactMessageStats = {
        userMessages: 0,
        assistantMessages: 0,
        toolCalls: 0,
        boundaryMessages: 0
    };
    const countedAssistantMessageIds = new Set<string>();

    for (const item of projectedItems) {
        if (item.kind === 'compact_boundary') {
            stats.boundaryMessages++;
            continue;
        }
        if (item.kind === 'user_message') {
            stats.userMessages++;
            continue;
        }

        if (!countedAssistantMessageIds.has(item.messageId)) {
            countedAssistantMessageIds.add(item.messageId);
            stats.assistantMessages++;
        }
        stats.toolCalls += item.round.toolCallCount;
    }

    return stats;
}

function buildSessionMemoryKeepAnchor(
    item: Exclude<ProjectedContextItem, Extract<ProjectedContextItem, { kind: 'compact_boundary' }>>
): SessionMemoryCompactKeepAnchor {
    if (item.kind === 'assistant_round') {
        return {
            kind: 'assistant_round',
            messageIndex: item.messageIndex,
            messageId: item.messageId,
            roundRef: item.roundRef,
            startPartIndex: item.roundRef.startPartIndex
        };
    }

    return {
        kind: 'message_start',
        messageIndex: item.messageIndex,
        messageId: item.messageId
    };
}

interface SessionMemoryRoundAwareKeepSelection {
    physicalKeepStartProjectedItemIndex: number;
    keepAnchorProjectedItemIndex: number;
}

function selectSessionMemoryRoundAwareKeepSelection(
    projectedItems: ProjectedContextItem[],
    keepAnchorProjectedItemIndex: number,
    floorProjectedItemIndex: number
): SessionMemoryRoundAwareKeepSelection | undefined {
    const keepAnchorItem = projectedItems[keepAnchorProjectedItemIndex];
    if (keepAnchorItem === undefined || keepAnchorItem.kind === 'compact_boundary') {
        return undefined;
    }

    let physicalKeepStartProjectedItemIndex = keepAnchorProjectedItemIndex;
    if (keepAnchorItem.kind === 'assistant_round') {
        let assistantProjectedStartIndex = keepAnchorProjectedItemIndex;
        while (assistantProjectedStartIndex > floorProjectedItemIndex) {
            const previousItem = projectedItems[assistantProjectedStartIndex - 1];
            if (
                previousItem?.kind !== 'assistant_round' ||
                previousItem.messageId !== keepAnchorItem.messageId ||
                previousItem.messageIndex !== keepAnchorItem.messageIndex
            ) {
                break;
            }
            assistantProjectedStartIndex--;
        }

        for (let index = assistantProjectedStartIndex - 1; index >= floorProjectedItemIndex; index--) {
            const item = projectedItems[index];
            if (item.kind === 'compact_boundary') {
                continue;
            }
            if (item.kind !== 'user_message') {
                break;
            }
            physicalKeepStartProjectedItemIndex = index;
        }
    }

    return {
        physicalKeepStartProjectedItemIndex,
        keepAnchorProjectedItemIndex
    };
}

function buildSessionMemoryProjectedItemsToKeep(
    projectedItems: ProjectedContextItem[],
    selection: SessionMemoryRoundAwareKeepSelection
): ProjectedContextItem[] {
    const keepIndices = new Set<number>();

    for (
        let index = selection.physicalKeepStartProjectedItemIndex;
        index < selection.keepAnchorProjectedItemIndex;
        index++
    ) {
        if (projectedItems[index]?.kind === 'user_message') {
            keepIndices.add(index);
        }
    }

    for (let index = selection.keepAnchorProjectedItemIndex; index < projectedItems.length; index++) {
        if (projectedItems[index]?.kind !== 'compact_boundary') {
            keepIndices.add(index);
        }
    }

    return projectedItems.filter((_, index) => keepIndices.has(index));
}

function buildSessionMemoryProjectedItemsToSummarize(
    projectedItems: ProjectedContextItem[],
    selection: SessionMemoryRoundAwareKeepSelection
): ProjectedContextItem[] {
    const projectedItemsToKeep = buildSessionMemoryProjectedItemsToKeep(projectedItems, selection);
    const keptItems = new Set(projectedItemsToKeep);

    return projectedItems.filter(
        (item, index) => index < selection.keepAnchorProjectedItemIndex && !keptItems.has(item)
    );
}

function normalizeMemoryContent(memoryContent: string, maxChars: number): string {
    const trimmed = memoryContent.trim();
    if (trimmed.length <= maxChars) {
        return trimmed;
    }
    return `${trimmed.slice(0, maxChars)}\n\n[... session memory truncated for compact boundary ...]`;
}

function findMessageIndexById(messages: ChatMessage[], floorIndex: number, messageId?: string): number {
    if (!messageId) {
        return -1;
    }

    for (let index = Math.max(0, floorIndex); index < messages.length; index++) {
        if (getMessageId(messages[index]) === messageId) {
            return index;
        }
    }

    return -1;
}

function expandKeepStartIndex(
    messages: ChatMessage[],
    initialKeepStartIndex: number,
    floorIndex: number,
    options: NormalizedSessionMemoryCompactOptions
): number {
    let keepStartIndex = Math.min(Math.max(initialKeepStartIndex, floorIndex), messages.length);
    let keptMessages = messages.slice(keepStartIndex).filter((message) => !isCompactBoundaryMessage(message));
    let keptTokens = estimateMessagesTokens(keptMessages);
    let textMessages = countTextMessages(keptMessages);

    if (keptTokens >= options.maxTokens) {
        return keepStartIndex;
    }

    if (keptTokens >= options.minTokens && textMessages >= options.minTextMessages) {
        return keepStartIndex;
    }

    for (let index = keepStartIndex - 1; index >= floorIndex; index--) {
        const message = messages[index];
        if (isCompactBoundaryMessage(message)) {
            continue;
        }

        const messageTokens = estimateChatMessageTokensForSessionMemory(message);
        if (keptMessages.length > 0 && keptTokens + messageTokens > options.maxTokens) {
            break;
        }

        keepStartIndex = index;
        keptTokens += messageTokens;
        keptMessages = [message, ...keptMessages];
        if (hasTextContent(message)) {
            textMessages++;
        }

        if (keptTokens >= options.minTokens && textMessages >= options.minTextMessages) {
            break;
        }
    }

    return keepStartIndex;
}

export function buildSessionMemoryCompactPlan(
    chatContext: ChatContext,
    state: SessionMemoryState,
    memoryContent: string,
    options: SessionMemoryCompactOptions = {}
): SessionMemoryCompactPlan | undefined {
    const normalizedOptions = normalizeCompactOptions(options);
    const normalizedMemory = normalizeMemoryContent(memoryContent, normalizedOptions.maxMemoryChars);
    if (normalizedMemory.length < normalizedOptions.minMemoryChars) {
        return undefined;
    }
    if (isSessionMemoryTemplateOnly(normalizedMemory, normalizedOptions.memoryTemplate)) {
        return undefined;
    }

    if (normalizedOptions.enableAssistantRoundBoundary) {
        const projectedActiveContext = buildProjectedActiveContextView(chatContext);
        const previousBoundary = projectedActiveContext.boundary;
        const floorIndex = previousBoundary ? previousBoundary.index + 1 : projectedActiveContext.startIndex;
        const floorProjectedItemIndex = findFirstProjectedItemIndexAtOrAfterMessageIndex(
            projectedActiveContext.projectedItems,
            floorIndex
        );
        const lastSummarizedIndex = findMessageIndexById(
            chatContext.messages,
            floorIndex,
            state.lastSummarizedMessageId
        );
        const hasSummarizedAnchor = lastSummarizedIndex >= floorIndex;
        const reason: SessionMemoryCompactPlanReason = hasSummarizedAnchor
            ? 'normal'
            : 'resume_without_last_summarized_message';

        const initialKeepProjectedItemIndex = hasSummarizedAnchor
            ? findFirstProjectedItemIndexAfterMessageIndex(projectedActiveContext.projectedItems, lastSummarizedIndex)
            : projectedActiveContext.projectedItems.length;
        const keepProjectedItemIndex = expandKeepStartProjectedItemIndex(
            projectedActiveContext.projectedItems,
            initialKeepProjectedItemIndex,
            floorProjectedItemIndex,
            normalizedOptions
        );
        const keepSelection = selectSessionMemoryRoundAwareKeepSelection(
            projectedActiveContext.projectedItems,
            keepProjectedItemIndex,
            floorProjectedItemIndex
        );
        if (keepSelection === undefined) {
            return undefined;
        }
        const keepProjectedItem = projectedActiveContext.projectedItems[keepSelection.keepAnchorProjectedItemIndex];
        const physicalKeepStartProjectedItem =
            projectedActiveContext.projectedItems[keepSelection.physicalKeepStartProjectedItemIndex];
        if (
            keepProjectedItem === undefined ||
            keepProjectedItem.kind === 'compact_boundary' ||
            physicalKeepStartProjectedItem === undefined ||
            physicalKeepStartProjectedItem.kind === 'compact_boundary'
        ) {
            return undefined;
        }

        const projectedItemsToKeep = buildSessionMemoryProjectedItemsToKeep(
            projectedActiveContext.projectedItems,
            keepSelection
        );
        const projectedItemsToSummarize = buildSessionMemoryProjectedItemsToSummarize(
            projectedActiveContext.projectedItems,
            keepSelection
        );

        const hasProjectedItemsToSummarize = projectedItemsToSummarize.some((item) => item.kind !== 'compact_boundary');
        if (!previousBoundary && !hasProjectedItemsToSummarize) {
            return undefined;
        }

        const physicalKeepStartIndex = physicalKeepStartProjectedItem.messageIndex;
        const keepStartLocalIndex = physicalKeepStartIndex - projectedActiveContext.startIndex;
        const messagesToKeep = projectedActiveContext.messages
            .slice(keepStartLocalIndex)
            .filter((message) => !isCompactBoundaryMessage(message));
        if (messagesToKeep.length === 0) {
            return undefined;
        }

        return {
            activeContextStartIndex: projectedActiveContext.startIndex,
            physicalKeepStartIndex,
            keepStartIndex: physicalKeepStartIndex,
            messagesToKeep,
            projectedItemsToSummarize,
            projectedItemsToKeep,
            keepAnchor: buildSessionMemoryKeepAnchor(keepProjectedItem),
            leadingPartialAssistant:
                keepProjectedItem.kind === 'assistant_round' && keepProjectedItem.roundRef.startPartIndex > 0
                    ? {
                          message: keepProjectedItem.message,
                          messageIndex: keepProjectedItem.messageIndex,
                          roundRef: keepProjectedItem.roundRef
                      }
                    : undefined,
            memoryContent: normalizedMemory,
            reason,
            previousBoundary,
            lastSummarizedMessageId: state.lastSummarizedMessageId,
            summarizedStats: countProjectedItemStats(projectedItemsToSummarize),
            keptStats: countProjectedItemStats(projectedItemsToKeep),
            estimatedKeptTokens: estimateProjectedItemsTokens(projectedItemsToKeep)
        };
    }

    const activeContext = buildActiveContextView(chatContext);
    const previousBoundary = activeContext.boundary;
    const floorIndex = previousBoundary ? previousBoundary.index + 1 : activeContext.startIndex;
    const lastSummarizedIndex = findMessageIndexById(chatContext.messages, floorIndex, state.lastSummarizedMessageId);
    const hasSummarizedAnchor = lastSummarizedIndex >= floorIndex;
    const reason: SessionMemoryCompactPlanReason = hasSummarizedAnchor
        ? 'normal'
        : 'resume_without_last_summarized_message';

    const initialKeepStartIndex = hasSummarizedAnchor ? lastSummarizedIndex + 1 : chatContext.messages.length;
    const keepStartIndex = expandKeepStartIndex(
        chatContext.messages,
        initialKeepStartIndex,
        floorIndex,
        normalizedOptions
    );
    if (!previousBoundary && keepStartIndex <= floorIndex) {
        return undefined;
    }

    const messagesToKeep = chatContext.messages
        .slice(keepStartIndex)
        .filter((message) => !isCompactBoundaryMessage(message));
    if (messagesToKeep.length === 0) {
        return undefined;
    }

    const summarizedMessages = chatContext.messages.slice(activeContext.startIndex, keepStartIndex);
    return {
        activeContextStartIndex: activeContext.startIndex,
        physicalKeepStartIndex: keepStartIndex,
        keepStartIndex,
        messagesToKeep,
        memoryContent: normalizedMemory,
        reason,
        previousBoundary,
        lastSummarizedMessageId: state.lastSummarizedMessageId,
        summarizedStats: countFullCompactMessageStats(summarizedMessages),
        keptStats: countFullCompactMessageStats(messagesToKeep),
        estimatedKeptTokens: estimateMessagesTokens(messagesToKeep)
    };
}

export function buildSessionMemoryCompactBoundary(
    plan: SessionMemoryCompactPlan,
    options: SessionMemoryCompactOptions = {}
): CompactSeparatorMessage {
    const normalizedOptions = normalizeCompactOptions(options);
    const summary = [
        '以下是本任务的 session memory 工作笔记，用于替代已经稳定的旧上下文。',
        '',
        '<session_memory>',
        plan.memoryContent,
        '</session_memory>'
    ].join('\n');

    return new CompactSeparatorMessage(summary, {
        boundary_id: normalizedOptions.boundaryId,
        created_at: normalizedOptions.createdAt,
        summarized_range: {
            start_index: plan.activeContextStartIndex,
            end_index_exclusive: plan.keepStartIndex,
            message_count: Math.max(plan.keepStartIndex - plan.activeContextStartIndex, 0),
            user_messages: plan.summarizedStats.userMessages,
            assistant_messages: plan.summarizedStats.assistantMessages,
            tool_calls: plan.summarizedStats.toolCalls
        },
        previous_boundary_id: plan.previousBoundary?.message.metadata.boundary_id,
        trigger: normalizedOptions.trigger,
        strategy: SESSION_MEMORY_COMPACT_BOUNDARY_STRATEGY,
        kept_range: {
            start_index: plan.keepStartIndex,
            end_index_exclusive: plan.keepStartIndex + plan.messagesToKeep.length,
            message_count: plan.messagesToKeep.length,
            user_messages: plan.keptStats.userMessages,
            assistant_messages: plan.keptStats.assistantMessages,
            tool_calls: plan.keptStats.toolCalls
        },
        kept_messages: plan.messagesToKeep.length,
        summarized_messages: Math.max(plan.keepStartIndex - plan.activeContextStartIndex, 0),
        kept_anchor_message_id: plan.keepAnchor?.messageId,
        kept_anchor_message_index: plan.keepAnchor?.messageIndex,
        kept_anchor_round_index: plan.keepAnchor?.roundRef?.roundIndex,
        kept_anchor_start_part_index: plan.keepAnchor?.startPartIndex
    });
}

export function buildSessionMemoryCompactResult(
    plan: SessionMemoryCompactPlan,
    options: SessionMemoryCompactOptions = {}
): SessionMemoryCompactResult {
    return {
        boundary: buildSessionMemoryCompactBoundary(plan, options),
        plan
    };
}

export function estimateSessionMemoryCompactPostTokens(result: SessionMemoryCompactResult): number {
    return estimateChatMessageTokensForSessionMemory(result.boundary) + result.plan.estimatedKeptTokens;
}

export function applySessionMemoryCompactResult(chatContext: ChatContext, result: SessionMemoryCompactResult): void {
    const keepStartMessage = result.plan.messagesToKeep[0];
    if (keepStartMessage === undefined) {
        throw new Error('cannot apply session memory compact result without kept messages');
    }

    chatContext.clearCompactBoundaries();

    for (const message of result.plan.messagesToKeep) {
        if (!chatContext.messages.includes(message)) {
            throw new Error(
                'cannot apply session memory compact result because a kept message is missing from chat context'
            );
        }
    }

    const insertIndex = chatContext.messages.indexOf(keepStartMessage);
    if (insertIndex < 0) {
        throw new Error('cannot apply session memory compact result because kept tail start is missing');
    }

    chatContext.messages.splice(insertIndex, 0, result.boundary);
}

export async function trySessionMemoryCompaction(
    chatContext: ChatContext,
    taskId: string | undefined,
    state: SessionMemoryState | undefined,
    autoCompactDecision?: AutoCompactDecision,
    options: SessionMemoryCompactOptions = {}
): Promise<SessionMemoryCompactRunResult> {
    if (!taskId) {
        return { compacted: false, noopReason: 'missing_task_id' };
    }
    if (!state) {
        return { compacted: false, noopReason: 'missing_state' };
    }

    const normalizedOptions = normalizeCompactOptions({
        ...options,
        autoCompactThreshold: options.autoCompactThreshold ?? autoCompactDecision?.autoCompactThreshold
    });
    const memoryContent = await readTaskSessionMemory(taskId);
    if (memoryContent === undefined) {
        return { compacted: false, noopReason: 'missing_memory_file' };
    }

    const trimmedMemory = memoryContent.trim();
    if (trimmedMemory.length === 0) {
        return { compacted: false, noopReason: 'empty_memory', memoryContent };
    }
    if (isSessionMemoryTemplateOnly(trimmedMemory, normalizedOptions.memoryTemplate)) {
        return { compacted: false, noopReason: 'template_memory', memoryContent };
    }
    if (trimmedMemory.length < normalizedOptions.minMemoryChars) {
        return { compacted: false, noopReason: 'memory_too_short', memoryContent };
    }

    const plan = buildSessionMemoryCompactPlan(chatContext, state, trimmedMemory, normalizedOptions);
    if (!plan) {
        return { compacted: false, noopReason: 'plan_unavailable', memoryContent };
    }

    const result = buildSessionMemoryCompactResult(plan, normalizedOptions);
    const postCompactTokens = estimateSessionMemoryCompactPostTokens(result);
    const autoCompactThreshold = normalizedOptions.autoCompactThreshold;
    if (autoCompactThreshold !== undefined && postCompactTokens >= autoCompactThreshold) {
        return {
            compacted: false,
            noopReason: 'post_compact_threshold_exceeded',
            plan,
            result,
            boundary: result.boundary,
            memoryContent,
            postCompactTokens,
            autoCompactThreshold
        };
    }

    applySessionMemoryCompactResult(chatContext, result);

    return {
        compacted: true,
        plan,
        result,
        boundary: result.boundary,
        memoryContent,
        postCompactTokens,
        autoCompactThreshold
    };
}
