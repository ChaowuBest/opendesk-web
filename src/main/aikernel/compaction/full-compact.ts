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

import {
    AssistantMessage,
    CompactSeparatorMessage,
    UserMessage,
    isCompactBoundaryMessage,
    type CompactBoundaryTrigger,
    type ChatContext,
    type ChatMessage
} from '../messages.js';
import { LLM, type LLMRequestOptions } from '../llm.js';
import { resolveReservedSummaryOutput } from './auto-compact.js';
import { buildActiveContextView, buildProjectedActiveContextView } from './context-view.js';
import type { AssistantRoundRef, CompactBoundaryRef, ProjectedContextItem } from './types.js';

export const DEFAULT_FULL_COMPACT_TAIL_MESSAGE_COUNT = 8;
export const DEFAULT_FULL_COMPACT_TAIL_ASSISTANT_TOOL_MESSAGE_COUNT = 3;
export const DEFAULT_FULL_COMPACT_TAIL_ASSISTANT_ERROR_MESSAGE_COUNT = 1;
export const DEFAULT_FULL_COMPACT_TAIL_PLAN_MESSAGE_COUNT = 1;
export const DEFAULT_FULL_COMPACT_MIN_MESSAGES_TO_SUMMARIZE = 2;
export const DEFAULT_FULL_COMPACT_SUMMARY_TOOL_PREVIEW_CHARS = 300;
export const FULL_COMPACT_BOUNDARY_STRATEGY = 'tail_preserving_full_compact';

const ASSISTANT_ERROR_SIGNAL_PATTERN = /(?:错误|失败|报错|异常|\berror\b|\bfailed\b|\bfailure\b)/i;
const ASSISTANT_PLAN_SIGNAL_PATTERN =
    /(?:当前计划|后续计划|下一步|待完成|进行中|计划|\btodo\b|\bnext steps?\b|\bcurrent plan\b|\bplan\b)/i;

export interface FullCompactPlanOptions {
    /** 最近要保留的非 boundary 消息数量。 */
    tailMessageCount?: number;
    /** 额外保护最近多少条包含工具调用的 assistant 消息。 */
    tailAssistantToolMessageCount?: number;
    /** 额外保护最近多少条包含错误信号的 assistant 消息。 */
    tailAssistantErrorMessageCount?: number;
    /** 额外保护最近多少条计划相关 assistant 文本。 */
    tailPlanMessageCount?: number;
    /** 至少需要总结多少条非 boundary 消息，否则认为本次 compact 没有效果。 */
    minMessagesToSummarize?: number;
    /** 开启 assistant 内部 round-aware planner，仅影响 plan 计算，不改变默认 apply 语义。 */
    enableAssistantRoundBoundary?: boolean;
}

export interface FullCompactMessageStats {
    userMessages: number;
    assistantMessages: number;
    toolCalls: number;
    boundaryMessages: number;
}

export interface FullCompactPlan {
    /** active context 在完整 chatContext.messages 中的起点。 */
    activeContextStartIndex: number;
    /** 本次 summary 输入在完整 chatContext.messages 中的起点。 */
    summarizeStartIndex: number;
    /** 本次 summary 输入在完整 chatContext.messages 中的结束位置，左闭右开。 */
    summarizeEndIndexExclusive: number;
    /** kept tail 在完整 chatContext.messages 中的物理起点。 */
    physicalKeepStartIndex: number;
    /** kept tail 在完整 chatContext.messages 中的起点。兼容旧字段，当前等于 physicalKeepStartIndex。 */
    keepStartIndex: number;
    messagesToSummarize: ChatMessage[];
    messagesToKeep: ChatMessage[];
    projectedItemsToSummarize?: ProjectedContextItem[];
    projectedItemsToKeep?: ProjectedContextItem[];
    keepAnchor?: FullCompactKeepAnchor;
    leadingPartialAssistant?: FullCompactLeadingPartialAssistant;
    summarizedStats: FullCompactMessageStats;
    keptStats: FullCompactMessageStats;
    previousBoundary?: CompactBoundaryRef;
}

export interface FullCompactKeepAnchor {
    kind: 'message_start' | 'assistant_round';
    messageIndex: number;
    messageId: string;
    roundRef?: AssistantRoundRef;
    startPartIndex?: number;
}

export interface FullCompactLeadingPartialAssistant {
    message: AssistantMessage;
    messageIndex: number;
    roundRef: AssistantRoundRef;
}

export interface FullCompactSummaryTextOptions {
    toolArgsPreviewChars?: number;
    toolResultPreviewChars?: number;
}

export interface FullCompactBoundaryOptions {
    trigger?: CompactBoundaryTrigger;
    createdAt?: string;
    boundaryId?: string;
}

export interface FullCompactResult {
    boundary: CompactSeparatorMessage;
    plan: FullCompactPlan;
    summary: string;
}

export interface FullCompactSummaryRequest {
    plan: FullCompactPlan;
    model?: string;
    prompt: string;
    summaryText: string;
    maxCompletionTokens: number;
    requestOptions?: LLMRequestOptions;
}

export type FullCompactSummaryGenerator = (request: FullCompactSummaryRequest) => Promise<string>;

export interface GenerateFullCompactSummaryOptions extends FullCompactSummaryTextOptions {
    prompt?: string;
    generateSummary?: FullCompactSummaryGenerator;
    maxCompletionTokens?: number;
    requestOptions?: LLMRequestOptions;
}

export interface FullCompactRunOptions
    extends FullCompactPlanOptions, GenerateFullCompactSummaryOptions, FullCompactBoundaryOptions {}

export interface FullCompactRunResult {
    compacted: boolean;
    plan?: FullCompactPlan;
    result?: FullCompactResult;
    boundary?: CompactSeparatorMessage;
    summary?: string;
}

interface NormalizedFullCompactPlanOptions {
    tailMessageCount: number;
    tailAssistantToolMessageCount: number;
    tailAssistantErrorMessageCount: number;
    tailPlanMessageCount: number;
    minMessagesToSummarize: number;
}

function normalizeCount(value: number | undefined, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fallback;
    }
    return Math.max(0, Math.floor(value));
}

function normalizePositiveCount(value: number | undefined, fallback: number): number {
    return Math.max(1, normalizeCount(value, fallback));
}

function normalizeOptions(options: FullCompactPlanOptions): NormalizedFullCompactPlanOptions {
    return {
        tailMessageCount: normalizeCount(options.tailMessageCount, DEFAULT_FULL_COMPACT_TAIL_MESSAGE_COUNT),
        tailAssistantToolMessageCount: normalizeCount(
            options.tailAssistantToolMessageCount,
            DEFAULT_FULL_COMPACT_TAIL_ASSISTANT_TOOL_MESSAGE_COUNT
        ),
        tailAssistantErrorMessageCount: normalizeCount(
            options.tailAssistantErrorMessageCount,
            DEFAULT_FULL_COMPACT_TAIL_ASSISTANT_ERROR_MESSAGE_COUNT
        ),
        tailPlanMessageCount: normalizeCount(
            options.tailPlanMessageCount,
            DEFAULT_FULL_COMPACT_TAIL_PLAN_MESSAGE_COUNT
        ),
        minMessagesToSummarize: normalizePositiveCount(
            options.minMessagesToSummarize,
            DEFAULT_FULL_COMPACT_MIN_MESSAGES_TO_SUMMARIZE
        )
    };
}

function isUserMessage(message: ChatMessage): message is UserMessage {
    return message instanceof UserMessage || message.role === 'user';
}

function isAssistantMessage(message: ChatMessage): message is AssistantMessage {
    return message instanceof AssistantMessage || message.role === 'assistant';
}

function getAssistantToolCallCount(message: AssistantMessage): number {
    let toolCalls = 0;
    for (const part of message.content) {
        if (part.type === 'tool_call') {
            toolCalls += part.toolcalls.length;
        }
    }
    return toolCalls;
}

function assistantHasToolCall(message: AssistantMessage): boolean {
    return getAssistantToolCallCount(message) > 0;
}

function assistantHasErrorSignal(message: AssistantMessage): boolean {
    for (const part of message.content) {
        if (part.type === 'error') {
            return true;
        }
        if (part.type === 'tool_call' && part.toolcalls.some((toolCall) => toolCall.status === 'error')) {
            return true;
        }
        if (part.type === 'text' && ASSISTANT_ERROR_SIGNAL_PATTERN.test(part.text)) {
            return true;
        }
    }
    return false;
}

function assistantHasPlanSignal(message: AssistantMessage): boolean {
    for (const part of message.content) {
        if (part.type === 'text' && ASSISTANT_PLAN_SIGNAL_PATTERN.test(part.text)) {
            return true;
        }
    }
    return false;
}

function truncateForSummaryText(text: string | undefined, maxChars: number): string {
    if (text === undefined || text.length === 0) {
        return '';
    }

    if (maxChars <= 0) {
        return '';
    }

    return text.length > maxChars ? `${text.substring(0, maxChars)}...` : text;
}

function normalizeSummaryPreviewChars(value: number | undefined): number {
    return normalizePositiveCount(value, DEFAULT_FULL_COMPACT_SUMMARY_TOOL_PREVIEW_CHARS);
}

function serializeUserMessageForSummary(message: UserMessage): string {
    const parts = message.content.map((part) => {
        if (part.type === 'text') {
            return part.text;
        }
        if (part.type === 'file') {
            return `[File: ${part.path}]`;
        }
        if (part.type === 'image_url') {
            return part.file_path ? part.toModelText() : `[Image: ${part.image_url.url}]`;
        }
        return '';
    });

    return `[User]: ${parts.filter((part) => part.length > 0).join('\n')}`;
}

function serializeAssistantMessageForSummary(
    message: AssistantMessage,
    options: Required<FullCompactSummaryTextOptions>
): string[] {
    return serializeAssistantPartsForSummary(message.content, options);
}

function serializeAssistantPartsForSummary(
    partsToSerialize: ReadonlyArray<AssistantMessage['content'][number]>,
    options: Required<FullCompactSummaryTextOptions>
): string[] {
    const parts: string[] = [];

    for (const part of partsToSerialize) {
        if (part.type === 'text') {
            parts.push(`[Assistant]: ${part.text}`);
        } else if (part.type === 'reasoning') {
            /* reasoning 内容不进入 full compact summary 输入。 */
        } else if (part.type === 'error') {
            parts.push(`[Assistant Error]: ${part.title}: ${part.message}`);
        } else if (part.type === 'tool_call') {
            for (const toolCall of part.toolcalls) {
                const argsSnippet =
                    truncateForSummaryText(toolCall.args_string, options.toolArgsPreviewChars) || 'none';
                const resultSnippet =
                    truncateForSummaryText(toolCall.result, options.toolResultPreviewChars) || 'no result';
                parts.push(
                    `[Tool Call: ${toolCall.tool_name}] Args: ${argsSnippet} -> ` +
                        `Result(${toolCall.status}): ${resultSnippet}`
                );
            }
        }
    }

    return parts;
}

function serializeMessageForSummary(message: ChatMessage, options: Required<FullCompactSummaryTextOptions>): string[] {
    if (isCompactBoundaryMessage(message)) {
        return [`[Previous Compact Summary]:\n${message.summary}`];
    }

    if (isUserMessage(message)) {
        return [serializeUserMessageForSummary(message)];
    }

    if (isAssistantMessage(message)) {
        return serializeAssistantMessageForSummary(message, options);
    }

    return [];
}

function serializeProjectedItemForSummary(
    item: ProjectedContextItem,
    options: Required<FullCompactSummaryTextOptions>
): string[] {
    if (item.kind === 'compact_boundary') {
        return [`[Previous Compact Summary]:\n${item.message.summary}`];
    }

    if (item.kind === 'user_message') {
        return [serializeUserMessageForSummary(item.message)];
    }

    return serializeAssistantPartsForSummary(item.round.parts, options);
}

export function getFullCompactCompressionPrompt(): string {
    return `你是对话历史压缩器，负责将完整的对话记录提炼为结构化状态快照。

【重要性】此快照将成为智能体对被折叠历史的唯一记忆。智能体将依据此快照，加上随后保留的最近消息继续工作，因此必须保留被折叠历史中的关键信息：用户指令、决策依据、遇到的错误、已完成和待完成的工作。

【范围说明】
- 你只需要总结下方“需要总结的对话历史”。
- 最近的 kept tail 会原样保留在 summary 之后，不要复述 kept tail 中的细节。
- 如果输入中包含 [Previous Compact Summary]，请把它当作此前历史的唯一摘要，并将其和本次被折叠的新历史融合成一个新的状态快照。
- reasoning / 思考过程不会提供给你，也不应出现在输出中。

【输出要求】
- 信息密度最大化：只保留有价值的事实，删除寒暄、重复和无关内容。
- 使用要点/列表形式，避免冗长叙述。
- 直接输出 <state_snapshot> XML，不要添加任何前导或后缀文字。

请严格按以下结构输出：

<state_snapshot>
    <overall_goal>
        <!-- 用一句话概括用户的核心目标 -->
    </overall_goal>

    <key_knowledge>
        <!-- 智能体必须记住的关键事实、约定和约束，使用列表 -->
        <!-- 包括：技术栈、命名规范、用户偏好、重要限制条件等 -->
    </key_knowledge>

    <file_system_state>
        <!-- 列出被创建、读取、修改或删除的文件 -->
        <!-- 标注每个文件的当前状态和关键发现 -->
    </file_system_state>

    <recent_actions>
        <!-- 最近若干次重要操作及其结果，只记录事实 -->
        <!-- 特别关注：失败的操作及原因、需要重试的内容 -->
    </recent_actions>

    <current_plan>
        <!-- 当前的分步计划，标记每步的状态 -->
    </current_plan>
</state_snapshot>`;
}

function getNonBoundaryLocalIndices(messages: ChatMessage[]): number[] {
    const indices: number[] = [];
    for (let index = 0; index < messages.length; index++) {
        if (!isCompactBoundaryMessage(messages[index])) {
            indices.push(index);
        }
    }
    return indices;
}

function protectRecentAssistantMessages(
    messages: ChatMessage[],
    count: number,
    predicate: (message: AssistantMessage) => boolean,
    protectedIndices: Set<number>
): void {
    if (count <= 0) {
        return;
    }

    let matched = 0;
    for (let index = messages.length - 1; index >= 0 && matched < count; index--) {
        const message = messages[index];
        if (isAssistantMessage(message) && predicate(message)) {
            protectedIndices.add(index);
            matched++;
        }
    }
}

function protectMostRecentUserMessage(messages: ChatMessage[], protectedIndices: Set<number>): void {
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (isUserMessage(message)) {
            protectedIndices.add(index);
            return;
        }
    }
}

function selectKeepStartLocalIndex(
    activeMessages: ChatMessage[],
    options: NormalizedFullCompactPlanOptions
): number | undefined {
    const nonBoundaryIndices = getNonBoundaryLocalIndices(activeMessages);
    if (nonBoundaryIndices.length === 0) {
        return undefined;
    }

    const protectedIndices = new Set<number>();
    for (const index of nonBoundaryIndices.slice(-options.tailMessageCount)) {
        protectedIndices.add(index);
    }

    protectRecentAssistantMessages(
        activeMessages,
        options.tailAssistantToolMessageCount,
        assistantHasToolCall,
        protectedIndices
    );
    protectRecentAssistantMessages(
        activeMessages,
        options.tailAssistantErrorMessageCount,
        assistantHasErrorSignal,
        protectedIndices
    );
    protectRecentAssistantMessages(
        activeMessages,
        options.tailPlanMessageCount,
        assistantHasPlanSignal,
        protectedIndices
    );
    protectMostRecentUserMessage(activeMessages, protectedIndices);

    if (protectedIndices.size === 0) {
        return undefined;
    }

    let keepStartIndex = Math.min(...protectedIndices);
    while (keepStartIndex < activeMessages.length && isCompactBoundaryMessage(activeMessages[keepStartIndex])) {
        keepStartIndex++;
    }

    return keepStartIndex < activeMessages.length ? keepStartIndex : undefined;
}

function assistantRoundHasErrorSignal(item: Extract<ProjectedContextItem, { kind: 'assistant_round' }>): boolean {
    for (const part of item.round.parts) {
        if (part.type === 'error') {
            return true;
        }
        if (part.type === 'tool_call' && part.toolcalls.some((toolCall) => toolCall.status === 'error')) {
            return true;
        }
        if (part.type === 'text' && ASSISTANT_ERROR_SIGNAL_PATTERN.test(part.text)) {
            return true;
        }
    }
    return false;
}

function assistantRoundHasPlanSignal(item: Extract<ProjectedContextItem, { kind: 'assistant_round' }>): boolean {
    return item.round.parts.some((part) => part.type === 'text' && ASSISTANT_PLAN_SIGNAL_PATTERN.test(part.text));
}

function getNonBoundaryProjectedItemIndices(projectedItems: ProjectedContextItem[]): number[] {
    const indices: number[] = [];
    for (let index = 0; index < projectedItems.length; index++) {
        if (projectedItems[index].kind !== 'compact_boundary') {
            indices.push(index);
        }
    }
    return indices;
}

function protectRecentAssistantRounds(
    projectedItems: ProjectedContextItem[],
    count: number,
    predicate: (item: Extract<ProjectedContextItem, { kind: 'assistant_round' }>) => boolean,
    protectedIndices: Set<number>
): void {
    if (count <= 0) {
        return;
    }

    let matched = 0;
    for (let index = projectedItems.length - 1; index >= 0 && matched < count; index--) {
        const item = projectedItems[index];
        if (item.kind === 'assistant_round' && predicate(item)) {
            protectedIndices.add(index);
            matched++;
        }
    }
}

function protectMostRecentProjectedUserMessage(
    projectedItems: ProjectedContextItem[],
    protectedIndices: Set<number>
): void {
    for (let index = projectedItems.length - 1; index >= 0; index--) {
        if (projectedItems[index].kind === 'user_message') {
            protectedIndices.add(index);
            return;
        }
    }
}

function collectProtectedProjectedItemIndices(
    projectedItems: ProjectedContextItem[],
    options: NormalizedFullCompactPlanOptions
): number[] {
    const nonBoundaryIndices = getNonBoundaryProjectedItemIndices(projectedItems);
    if (nonBoundaryIndices.length === 0) {
        return [];
    }

    const protectedIndices = new Set<number>();
    if (options.tailMessageCount > 0) {
        for (const index of nonBoundaryIndices.slice(-options.tailMessageCount)) {
            protectedIndices.add(index);
        }
    }

    protectRecentAssistantRounds(
        projectedItems,
        options.tailAssistantToolMessageCount,
        (item) => item.round.toolCallCount > 0,
        protectedIndices
    );
    protectRecentAssistantRounds(
        projectedItems,
        options.tailAssistantErrorMessageCount,
        assistantRoundHasErrorSignal,
        protectedIndices
    );
    protectRecentAssistantRounds(
        projectedItems,
        options.tailPlanMessageCount,
        assistantRoundHasPlanSignal,
        protectedIndices
    );
    protectMostRecentProjectedUserMessage(projectedItems, protectedIndices);

    if (protectedIndices.size === 0) {
        return [];
    }

    return Array.from(protectedIndices).sort((left, right) => left - right);
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

function countProjectedSummarizeUnits(projectedItems: ProjectedContextItem[]): number {
    let units = 0;

    for (const item of projectedItems) {
        if (item.kind === 'user_message' || item.kind === 'assistant_round') {
            units++;
        }
    }

    return units;
}

function buildRoundAwareKeepAnchor(
    item: Exclude<ProjectedContextItem, Extract<ProjectedContextItem, { kind: 'compact_boundary' }>>
): FullCompactKeepAnchor {
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

interface RoundAwareKeepSelection {
    physicalKeepStartProjectedItemIndex: number;
    keepAnchorProjectedItemIndex: number;
}

function selectRoundAwareKeepSelection(
    projectedItems: ProjectedContextItem[],
    options: NormalizedFullCompactPlanOptions
): RoundAwareKeepSelection | undefined {
    const protectedIndices = collectProtectedProjectedItemIndices(projectedItems, options);
    if (protectedIndices.length === 0) {
        return undefined;
    }

    let physicalKeepStartProjectedItemIndex = protectedIndices[0];
    while (
        physicalKeepStartProjectedItemIndex < projectedItems.length &&
        projectedItems[physicalKeepStartProjectedItemIndex].kind === 'compact_boundary'
    ) {
        physicalKeepStartProjectedItemIndex++;
    }
    if (physicalKeepStartProjectedItemIndex >= projectedItems.length) {
        return undefined;
    }

    let keepAnchorProjectedItemIndex = physicalKeepStartProjectedItemIndex;
    const physicalKeepStartItem = projectedItems[physicalKeepStartProjectedItemIndex];
    if (physicalKeepStartItem.kind === 'user_message') {
        const firstProtectedNonUserItemIndex = protectedIndices.find((index) => {
            if (index <= physicalKeepStartProjectedItemIndex) {
                return false;
            }
            const item = projectedItems[index];
            return item?.kind !== 'user_message';
        });
        if (firstProtectedNonUserItemIndex !== undefined) {
            const firstProtectedNonUserItem = projectedItems[firstProtectedNonUserItemIndex];
            if (
                firstProtectedNonUserItem?.kind === 'assistant_round' &&
                firstProtectedNonUserItem.roundRef.startPartIndex > 0
            ) {
                keepAnchorProjectedItemIndex = firstProtectedNonUserItemIndex;
            }
        }
    }

    const keepAnchorItem = projectedItems[keepAnchorProjectedItemIndex];
    if (keepAnchorItem === undefined || keepAnchorItem.kind === 'compact_boundary') {
        return undefined;
    }

    return {
        physicalKeepStartProjectedItemIndex,
        keepAnchorProjectedItemIndex
    };
}

function buildRoundAwareProjectedItemsToKeep(
    projectedItems: ProjectedContextItem[],
    selection: RoundAwareKeepSelection
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

function buildRoundAwareProjectedItemsToSummarize(
    projectedItems: ProjectedContextItem[],
    selection: RoundAwareKeepSelection
): ProjectedContextItem[] {
    const projectedItemsToKeep = buildRoundAwareProjectedItemsToKeep(projectedItems, selection);
    const keptItems = new Set(projectedItemsToKeep);

    return projectedItems.filter(
        (item, index) => index < selection.keepAnchorProjectedItemIndex && !keptItems.has(item)
    );
}

function buildFullCompactSummaryScopeLine(plan: FullCompactPlan): string {
    if (plan.projectedItemsToSummarize && plan.keepAnchor?.kind === 'assistant_round') {
        if (plan.keepAnchor.messageIndex > plan.physicalKeepStartIndex) {
            return (
                `[Full Compact Summary Scope]: summarize projected items before assistant message ` +
                `${plan.keepAnchor.messageIndex} round ${plan.keepAnchor.roundRef?.roundIndex} ` +
                `(part ${plan.keepAnchor.startPartIndex}); physical kept tail starts at ` +
                `chat_context.messages[${plan.physicalKeepStartIndex}] and preserved raw-visible messages ` +
                `before the assistant anchor are intentionally excluded.`
            );
        }

        return (
            `[Full Compact Summary Scope]: summarize projected items before assistant message ` +
            `${plan.keepAnchor.messageIndex} round ${plan.keepAnchor.roundRef?.roundIndex} ` +
            `(part ${plan.keepAnchor.startPartIndex}); physical kept tail starts at ` +
            `chat_context.messages[${plan.physicalKeepStartIndex}] and is intentionally excluded.`
        );
    }

    return `[Full Compact Summary Scope]: summarize chat_context.messages[${plan.summarizeStartIndex}:${plan.summarizeEndIndexExclusive}); kept tail starts at ${plan.keepStartIndex} and is intentionally excluded.`;
}

export function countFullCompactMessageStats(messages: ChatMessage[]): FullCompactMessageStats {
    const stats: FullCompactMessageStats = {
        userMessages: 0,
        assistantMessages: 0,
        toolCalls: 0,
        boundaryMessages: 0
    };

    for (const message of messages) {
        if (isCompactBoundaryMessage(message)) {
            stats.boundaryMessages++;
        } else if (isUserMessage(message)) {
            stats.userMessages++;
        } else if (isAssistantMessage(message)) {
            stats.assistantMessages++;
            stats.toolCalls += getAssistantToolCallCount(message);
        }
    }

    return stats;
}

export function buildFullCompactPlan(
    chatContext: ChatContext,
    options: FullCompactPlanOptions = {}
): FullCompactPlan | undefined {
    const normalizedOptions = normalizeOptions(options);
    if (options.enableAssistantRoundBoundary) {
        const projectedActiveContext = buildProjectedActiveContextView(chatContext);
        const keepSelection = selectRoundAwareKeepSelection(projectedActiveContext.projectedItems, normalizedOptions);
        if (keepSelection === undefined) {
            return undefined;
        }

        const physicalKeepStartProjectedItem =
            projectedActiveContext.projectedItems[keepSelection.physicalKeepStartProjectedItemIndex];
        const keepProjectedItem = projectedActiveContext.projectedItems[keepSelection.keepAnchorProjectedItemIndex];
        if (
            physicalKeepStartProjectedItem === undefined ||
            physicalKeepStartProjectedItem.kind === 'compact_boundary'
        ) {
            return undefined;
        }
        if (keepProjectedItem.kind === 'compact_boundary') {
            return undefined;
        }

        const physicalKeepStartIndex = physicalKeepStartProjectedItem.messageIndex;
        const physicalKeepStartLocalIndex = physicalKeepStartIndex - projectedActiveContext.startIndex;
        const messagesToSummarize = projectedActiveContext.messages.slice(0, physicalKeepStartLocalIndex);
        const messagesToKeep = projectedActiveContext.messages
            .slice(physicalKeepStartLocalIndex)
            .filter((message) => !isCompactBoundaryMessage(message));
        const projectedItemsToKeep = buildRoundAwareProjectedItemsToKeep(
            projectedActiveContext.projectedItems,
            keepSelection
        );
        const projectedItemsToSummarize = buildRoundAwareProjectedItemsToSummarize(
            projectedActiveContext.projectedItems,
            keepSelection
        );

        if (messagesToKeep.length === 0) {
            return undefined;
        }

        const summarizedStats = countProjectedItemStats(projectedItemsToSummarize);
        const summarizedProjectedUnits = countProjectedSummarizeUnits(projectedItemsToSummarize);
        if (summarizedProjectedUnits < normalizedOptions.minMessagesToSummarize) {
            return undefined;
        }

        return {
            activeContextStartIndex: projectedActiveContext.startIndex,
            summarizeStartIndex: projectedActiveContext.startIndex,
            summarizeEndIndexExclusive: keepProjectedItem.messageIndex,
            physicalKeepStartIndex,
            keepStartIndex: physicalKeepStartIndex,
            messagesToSummarize,
            messagesToKeep,
            projectedItemsToSummarize,
            projectedItemsToKeep,
            keepAnchor: buildRoundAwareKeepAnchor(keepProjectedItem),
            leadingPartialAssistant:
                keepProjectedItem.kind === 'assistant_round' && keepProjectedItem.roundRef.startPartIndex > 0
                    ? {
                          message: keepProjectedItem.message,
                          messageIndex: keepProjectedItem.messageIndex,
                          roundRef: keepProjectedItem.roundRef
                      }
                    : undefined,
            summarizedStats,
            keptStats: countProjectedItemStats(projectedItemsToKeep),
            previousBoundary: projectedActiveContext.boundary
        };
    }

    const activeContext = buildActiveContextView(chatContext);
    const keepStartLocalIndex = selectKeepStartLocalIndex(activeContext.messages, normalizedOptions);
    if (keepStartLocalIndex === undefined || keepStartLocalIndex <= 0) {
        return undefined;
    }

    const messagesToSummarize = activeContext.messages.slice(0, keepStartLocalIndex);
    const messagesToKeep = activeContext.messages
        .slice(keepStartLocalIndex)
        .filter((message) => !isCompactBoundaryMessage(message));

    if (messagesToKeep.length === 0) {
        return undefined;
    }

    const summarizedStats = countFullCompactMessageStats(messagesToSummarize);
    const summarizedNonBoundaryMessages = summarizedStats.userMessages + summarizedStats.assistantMessages;
    if (summarizedNonBoundaryMessages < normalizedOptions.minMessagesToSummarize) {
        return undefined;
    }

    return {
        activeContextStartIndex: activeContext.startIndex,
        summarizeStartIndex: activeContext.startIndex,
        summarizeEndIndexExclusive: activeContext.startIndex + keepStartLocalIndex,
        physicalKeepStartIndex: activeContext.startIndex + keepStartLocalIndex,
        keepStartIndex: activeContext.startIndex + keepStartLocalIndex,
        messagesToSummarize,
        messagesToKeep,
        summarizedStats,
        keptStats: countFullCompactMessageStats(messagesToKeep),
        previousBoundary: activeContext.boundary
    };
}

export function buildFullCompactSummaryText(
    plan: FullCompactPlan,
    options: FullCompactSummaryTextOptions = {}
): string {
    const normalizedOptions: Required<FullCompactSummaryTextOptions> = {
        toolArgsPreviewChars: normalizeSummaryPreviewChars(options.toolArgsPreviewChars),
        toolResultPreviewChars: normalizeSummaryPreviewChars(options.toolResultPreviewChars)
    };

    const scopeLine = buildFullCompactSummaryScopeLine(plan);
    const parts: string[] = [scopeLine];

    if (plan.projectedItemsToSummarize) {
        for (const item of plan.projectedItemsToSummarize) {
            parts.push(...serializeProjectedItemForSummary(item, normalizedOptions));
        }
        return parts.filter((part) => part.trim().length > 0).join('\n\n');
    }

    for (const message of plan.messagesToSummarize) {
        parts.push(...serializeMessageForSummary(message, normalizedOptions));
    }

    return parts.filter((part) => part.trim().length > 0).join('\n\n');
}

export async function generateFullCompactSummary(
    plan: FullCompactPlan,
    model?: string,
    options: GenerateFullCompactSummaryOptions = {}
): Promise<string> {
    const prompt = options.prompt ?? getFullCompactCompressionPrompt();
    const summaryText = buildFullCompactSummaryText(plan, options);
    const maxCompletionTokens = options.maxCompletionTokens ?? (await resolveReservedSummaryOutput(model));

    if (options.generateSummary) {
        return await options.generateSummary({
            plan,
            model,
            prompt,
            summaryText,
            maxCompletionTokens,
            requestOptions: options.requestOptions
        });
    }

    const question = new UserMessage();
    question.appendText(`${prompt}\n\n---\n\n以下是需要总结的对话历史：\n\n${summaryText}`);
    return await LLM.ask(question, model, {
        ...options.requestOptions,
        maxCompletionTokens
    });
}

export function buildFullCompactBoundary(
    plan: FullCompactPlan,
    summary: string,
    options: FullCompactBoundaryOptions = {}
): CompactSeparatorMessage {
    return new CompactSeparatorMessage(summary, {
        boundary_id: options.boundaryId,
        created_at: options.createdAt,
        summarized_range: {
            start_index: plan.summarizeStartIndex,
            end_index_exclusive: plan.summarizeEndIndexExclusive,
            message_count: plan.messagesToSummarize.length,
            user_messages: plan.summarizedStats.userMessages,
            assistant_messages: plan.summarizedStats.assistantMessages,
            tool_calls: plan.summarizedStats.toolCalls
        },
        previous_boundary_id: plan.previousBoundary?.message.metadata.boundary_id,
        trigger: options.trigger,
        strategy: FULL_COMPACT_BOUNDARY_STRATEGY,
        kept_range: {
            start_index: plan.keepStartIndex,
            end_index_exclusive: plan.keepStartIndex + plan.messagesToKeep.length,
            message_count: plan.messagesToKeep.length,
            user_messages: plan.keptStats.userMessages,
            assistant_messages: plan.keptStats.assistantMessages,
            tool_calls: plan.keptStats.toolCalls
        },
        kept_messages: plan.messagesToKeep.length,
        summarized_messages: plan.messagesToSummarize.length,
        kept_anchor_message_id: plan.keepAnchor?.messageId,
        kept_anchor_message_index: plan.keepAnchor?.messageIndex,
        kept_anchor_round_index: plan.keepAnchor?.roundRef?.roundIndex,
        kept_anchor_start_part_index: plan.keepAnchor?.startPartIndex
    });
}

export function buildFullCompactResult(
    plan: FullCompactPlan,
    summary: string,
    options: FullCompactBoundaryOptions = {}
): FullCompactResult {
    return {
        boundary: buildFullCompactBoundary(plan, summary, options),
        plan,
        summary
    };
}

export function applyFullCompactResult(chatContext: ChatContext, result: FullCompactResult): void {
    const keepStartMessage = result.plan.messagesToKeep[0];
    if (keepStartMessage === undefined) {
        throw new Error('cannot apply full compact result without kept messages');
    }

    chatContext.clearCompactBoundaries();

    for (const message of result.plan.messagesToKeep) {
        if (!chatContext.messages.includes(message)) {
            throw new Error('cannot apply full compact result because a kept message is missing from chat context');
        }
    }

    const insertIndex = chatContext.messages.indexOf(keepStartMessage);
    if (insertIndex < 0) {
        throw new Error('cannot apply full compact result because kept tail start is missing from chat context');
    }

    chatContext.messages.splice(insertIndex, 0, result.boundary);
}

export async function compactFullContext(
    chatContext: ChatContext,
    model?: string,
    options: FullCompactRunOptions = {}
): Promise<FullCompactRunResult> {
    chatContext.deduplicateCompactBoundaries();

    const plan = buildFullCompactPlan(chatContext, options);
    if (plan === undefined) {
        return { compacted: false };
    }

    const summary = await generateFullCompactSummary(plan, model, options);
    if (summary.trim().length === 0) {
        throw new Error('full compact summary is empty');
    }

    const result = buildFullCompactResult(plan, summary, options);
    applyFullCompactResult(chatContext, result);

    return {
        compacted: true,
        plan,
        result,
        boundary: result.boundary,
        summary
    };
}
