import {
    AssistantMessage,
    CompactSeparatorMessage,
    UserMessage,
    isCompactBoundaryMessage,
    type CompactBoundaryTrigger,
    type ChatContext,
    type ChatMessage
} from '../messages.js';
import { LLM } from '../llm.js';
import { buildActiveContextView } from './context-view.js';
import type { CompactBoundaryRef } from './types.js';

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
    /** kept tail 在完整 chatContext.messages 中的起点。 */
    keepStartIndex: number;
    messagesToSummarize: ChatMessage[];
    messagesToKeep: ChatMessage[];
    summarizedStats: FullCompactMessageStats;
    keptStats: FullCompactMessageStats;
    previousBoundary?: CompactBoundaryRef;
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
}

export type FullCompactSummaryGenerator = (request: FullCompactSummaryRequest) => Promise<string>;

export interface GenerateFullCompactSummaryOptions extends FullCompactSummaryTextOptions {
    prompt?: string;
    generateSummary?: FullCompactSummaryGenerator;
}

export interface FullCompactRunOptions
    extends FullCompactPlanOptions, FullCompactSummaryTextOptions, FullCompactBoundaryOptions {
    prompt?: string;
    generateSummary?: FullCompactSummaryGenerator;
}

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
            return `[Image: ${part.image_url.url}]`;
        }
        return '';
    });

    return `[User]: ${parts.filter((part) => part.length > 0).join('\n')}`;
}

function serializeAssistantMessageForSummary(
    message: AssistantMessage,
    options: Required<FullCompactSummaryTextOptions>
): string[] {
    const parts: string[] = [];

    for (const part of message.content) {
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

    const parts: string[] = [
        `[Full Compact Summary Scope]: summarize chat_context.messages[${plan.summarizeStartIndex}:${plan.summarizeEndIndexExclusive}); kept tail starts at ${plan.keepStartIndex} and is intentionally excluded.`
    ];

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

    if (options.generateSummary) {
        return await options.generateSummary({
            plan,
            model,
            prompt,
            summaryText
        });
    }

    const question = new UserMessage();
    question.appendText(`${prompt}\n\n---\n\n以下是需要总结的对话历史：\n\n${summaryText}`);
    return await LLM.ask(question, model);
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
        summarized_messages: plan.messagesToSummarize.length
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
