import { jest } from '@jest/globals';
import {
    FULL_COMPACT_BOUNDARY_STRATEGY,
    applyFullCompactResult,
    buildFullCompactResult,
    buildFullCompactPlan,
    buildFullCompactSummaryText,
    compactFullContext,
    countFullCompactMessageStats,
    generateFullCompactSummary
} from '../../../main/aikernel/compaction/full-compact';
import {
    buildActiveContextView,
    buildProjectedActiveContextView
} from '../../../main/aikernel/compaction/context-view';
import { compactContext } from '../../../main/aikernel/compact';
import { LLM } from '../../../main/aikernel/llm';
import {
    AssistantMessage,
    ChatContext,
    CompactSeparatorMessage,
    ToolCall,
    ToolCallMessagePart,
    UserMessage,
    isCompactBoundaryMessage,
    type ChatMessage
} from '../../../main/aikernel/messages';

afterEach(() => {
    jest.restoreAllMocks();
});

function createMessageFactory() {
    const labels = new Map<ChatMessage, string>();

    const label = <T extends ChatMessage>(message: T, name: string): T => {
        labels.set(message, name);
        return message;
    };

    return {
        user(name: string): UserMessage {
            return label(new UserMessage(`user ${name}`), name);
        },

        assistant(name: string, text = `assistant ${name}`): AssistantMessage {
            const message = new AssistantMessage();
            message.appendText(text);
            return label(message, name);
        },

        toolAssistant(
            name: string,
            status: 'success' | 'error' = 'success',
            result = `${status} result for ${name}`,
            argsString = '{"query":"demo"}'
        ): AssistantMessage {
            const message = new AssistantMessage();
            message.appendText(`assistant ${name}`);

            const toolCall = new ToolCall(0, `tool-call-${name}`, 'demo_tool', argsString);
            toolCall.status = status;
            toolCall.result = result;

            const part = new ToolCallMessagePart();
            part.push(toolCall);
            message.appendToolCallPart(part);

            return label(message, name);
        },

        reasoningAssistant(name: string): AssistantMessage {
            const message = new AssistantMessage();
            message.appendReasoningContent(`private reasoning ${name}`);
            message.appendText(`assistant visible ${name}`);
            return label(message, name);
        },

        errorAssistant(name: string): AssistantMessage {
            const message = new AssistantMessage();
            message.appendError('Error', `failed in ${name}`);
            return label(message, name);
        },

        boundary(name: string, boundaryId = name): CompactSeparatorMessage {
            return label(
                new CompactSeparatorMessage(`summary for ${name}`, {
                    boundary_id: boundaryId,
                    created_at: '2026-04-20T00:00:00.000Z'
                }),
                name
            );
        },

        labelsOf(messages: ChatMessage[]): string[] {
            return messages.map((message) => labels.get(message) ?? '<unlabelled>');
        }
    };
}

function appendMessages(chatContext: ChatContext, messages: ChatMessage[]): void {
    for (const message of messages) {
        chatContext.appendMessage(message);
    }
}

function appendAssistantRound(
    message: AssistantMessage,
    assistantName: string,
    roundLabel: string,
    toolCallCount = 1
): void {
    message.appendReasoningContent(`reasoning ${assistantName} ${roundLabel}`);
    message.appendText(`assistant ${assistantName} ${roundLabel}`);

    const part = new ToolCallMessagePart();
    for (let index = 0; index < toolCallCount; index++) {
        const toolCall = new ToolCall(
            index,
            `tool-call-${assistantName}-${roundLabel}-${index}`,
            'demo_tool',
            `{"assistant":"${assistantName}","round":"${roundLabel}","toolCallIndex":${index}}`
        );
        toolCall.status = 'success';
        toolCall.result = `result ${assistantName} ${roundLabel} ${index}`;
        part.push(toolCall);
    }
    message.appendToolCallPart(part);
}

function createMultiRoundAssistant(name: string, roundLabels: string[]): AssistantMessage {
    const message = new AssistantMessage();
    for (const roundLabel of roundLabels) {
        appendAssistantRound(message, name, roundLabel);
    }
    return message;
}

function appendAssistantRoundSequence(
    message: AssistantMessage,
    assistantName: string,
    startNumber: number,
    count: number
): string[] {
    const labels: string[] = [];
    for (let offset = 0; offset < count; offset++) {
        const roundNumber = startNumber + offset;
        const roundLabel = `round-${String(roundNumber).padStart(2, '0')}`;
        appendAssistantRound(message, assistantName, roundLabel);
        labels.push(roundLabel);
    }
    return labels;
}

function formatRoundLabel(roundNumber: number): string {
    return `round-${String(roundNumber).padStart(2, '0')}`;
}

function getVisibleAssistantRoundIndices(chatContext: ChatContext, message: AssistantMessage): number[] {
    return buildProjectedActiveContextView(chatContext)
        .projectedItems.filter((item) => item.kind === 'assistant_round' && item.message === message)
        .map((item) => item.roundRef.roundIndex);
}

describe('full compact planning', () => {
    test('首次 compact 会总结 active context 前缀并保留默认最近 8 条非 boundary 消息', () => {
        const factory = createMessageFactory();
        const chatContext = new ChatContext();

        appendMessages(chatContext, [
            factory.user('u1'),
            factory.assistant('a1'),
            factory.user('u2'),
            factory.assistant('a2'),
            factory.user('u3'),
            factory.assistant('a3'),
            factory.user('u4'),
            factory.assistant('a4'),
            factory.user('u5'),
            factory.assistant('a5'),
            factory.user('u6'),
            factory.assistant('a6')
        ]);

        const plan = buildFullCompactPlan(chatContext);

        expect(plan).toBeDefined();
        expect(plan!.activeContextStartIndex).toBe(0);
        expect(plan!.summarizeStartIndex).toBe(0);
        expect(plan!.summarizeEndIndexExclusive).toBe(4);
        expect(plan!.keepStartIndex).toBe(4);
        expect(factory.labelsOf(plan!.messagesToSummarize)).toEqual(['u1', 'a1', 'u2', 'a2']);
        expect(factory.labelsOf(plan!.messagesToKeep)).toEqual(['u3', 'a3', 'u4', 'a4', 'u5', 'a5', 'u6', 'a6']);
        expect(plan!.summarizedStats).toEqual({
            userMessages: 2,
            assistantMessages: 2,
            toolCalls: 0,
            boundaryMessages: 0
        });
        expect(plan!.keptStats).toEqual({
            userMessages: 4,
            assistantMessages: 4,
            toolCalls: 0,
            boundaryMessages: 0
        });
    });

    test('已有 boundary 时只规划 active context，不重新总结 boundary 之前的原始历史', () => {
        const factory = createMessageFactory();
        const chatContext = new ChatContext();
        const previousBoundary = factory.boundary('previous-boundary', 'boundary-old');

        appendMessages(chatContext, [
            factory.user('hidden-u'),
            factory.assistant('hidden-a'),
            previousBoundary,
            factory.user('u1'),
            factory.assistant('a1'),
            factory.user('u2'),
            factory.assistant('a2'),
            factory.user('u3'),
            factory.assistant('a3'),
            factory.user('u4'),
            factory.assistant('a4'),
            factory.user('u5'),
            factory.assistant('a5'),
            factory.user('u6'),
            factory.assistant('a6')
        ]);

        const plan = buildFullCompactPlan(chatContext);

        expect(plan).toBeDefined();
        expect(plan!.activeContextStartIndex).toBe(2);
        expect(plan!.summarizeStartIndex).toBe(2);
        expect(plan!.summarizeEndIndexExclusive).toBe(7);
        expect(plan!.keepStartIndex).toBe(7);
        expect(plan!.previousBoundary?.index).toBe(2);
        expect(plan!.previousBoundary?.message.metadata.boundary_id).toBe('boundary-old');
        expect(factory.labelsOf(plan!.messagesToSummarize)).toEqual(['previous-boundary', 'u1', 'a1', 'u2', 'a2']);
        expect(factory.labelsOf(plan!.messagesToKeep)).toEqual(['u3', 'a3', 'u4', 'a4', 'u5', 'a5', 'u6', 'a6']);
        expect(factory.labelsOf(plan!.messagesToSummarize)).not.toContain('hidden-u');
        expect(factory.labelsOf(plan!.messagesToSummarize)).not.toContain('hidden-a');
    });

    test('tail 保护会向前扩展到最近 3 条包含工具调用的 assistant 消息', () => {
        const factory = createMessageFactory();
        const chatContext = new ChatContext();

        appendMessages(chatContext, [
            factory.user('u1'),
            factory.assistant('a1'),
            factory.toolAssistant('tool-1'),
            factory.user('u2'),
            factory.assistant('a2'),
            factory.toolAssistant('tool-2'),
            factory.user('u3'),
            factory.assistant('a3'),
            factory.toolAssistant('tool-3'),
            factory.user('u4'),
            factory.assistant('a4'),
            factory.user('u5'),
            factory.assistant('a5'),
            factory.user('u6'),
            factory.assistant('a6'),
            factory.user('u7'),
            factory.assistant('a7')
        ]);

        const plan = buildFullCompactPlan(chatContext);

        expect(plan).toBeDefined();
        expect(plan!.keepStartIndex).toBe(2);
        expect(factory.labelsOf(plan!.messagesToSummarize)).toEqual(['u1', 'a1']);
        expect(factory.labelsOf(plan!.messagesToKeep)).toEqual([
            'tool-1',
            'u2',
            'a2',
            'tool-2',
            'u3',
            'a3',
            'tool-3',
            'u4',
            'a4',
            'u5',
            'a5',
            'u6',
            'a6',
            'u7',
            'a7'
        ]);
        expect(plan!.keptStats.toolCalls).toBe(3);
    });

    test('tail 保护会包含最近用户、错误 assistant 和计划相关 assistant 文本', () => {
        const factory = createMessageFactory();
        const chatContext = new ChatContext();

        appendMessages(chatContext, [
            factory.user('u1'),
            factory.assistant('a1'),
            factory.assistant('plan', '当前计划: 继续保留这个阶段的执行计划'),
            factory.assistant('a2'),
            factory.errorAssistant('error'),
            factory.assistant('a3'),
            factory.user('recent-user'),
            factory.assistant('a4'),
            factory.assistant('a5'),
            factory.assistant('a6')
        ]);

        const plan = buildFullCompactPlan(chatContext, {
            tailMessageCount: 2,
            tailAssistantToolMessageCount: 0,
            tailAssistantErrorMessageCount: 1,
            tailPlanMessageCount: 1
        });

        expect(plan).toBeDefined();
        expect(plan!.keepStartIndex).toBe(2);
        expect(factory.labelsOf(plan!.messagesToSummarize)).toEqual(['u1', 'a1']);
        expect(factory.labelsOf(plan!.messagesToKeep)).toEqual([
            'plan',
            'a2',
            'error',
            'a3',
            'recent-user',
            'a4',
            'a5',
            'a6'
        ]);
    });

    test('消息过少或没有可总结前缀时返回 undefined，不产生 compact plan', () => {
        const factory = createMessageFactory();
        const chatContext = new ChatContext();

        appendMessages(chatContext, [factory.user('u1'), factory.assistant('a1'), factory.user('u2')]);

        expect(buildFullCompactPlan(chatContext)).toBeUndefined();
    });

    test('会去重旧 boundary，且 kept tail 不包含 compact boundary', () => {
        const factory = createMessageFactory();
        const chatContext = new ChatContext();
        const obsoleteBoundary = factory.boundary('obsolete-boundary', 'boundary-obsolete');
        const latestBoundary = factory.boundary('latest-boundary', 'boundary-latest');

        appendMessages(chatContext, [
            factory.user('hidden-before-obsolete'),
            obsoleteBoundary,
            factory.user('hidden-before-latest'),
            latestBoundary,
            factory.user('u1'),
            factory.assistant('a1'),
            factory.user('u2'),
            factory.assistant('a2'),
            factory.user('u3'),
            factory.assistant('a3'),
            factory.user('u4'),
            factory.assistant('a4'),
            factory.user('u5'),
            factory.assistant('a5'),
            factory.user('u6'),
            factory.assistant('a6')
        ]);

        const plan = buildFullCompactPlan(chatContext);

        expect(plan).toBeDefined();
        expect(chatContext.messages).not.toContain(obsoleteBoundary);
        expect(plan!.activeContextStartIndex).toBe(2);
        expect(plan!.previousBoundary?.message).toBe(latestBoundary);
        expect(factory.labelsOf(plan!.messagesToSummarize)).toEqual(['latest-boundary', 'u1', 'a1', 'u2', 'a2']);
        expect(plan!.messagesToKeep.some(isCompactBoundaryMessage)).toBe(false);
        expect(countFullCompactMessageStats(plan!.messagesToKeep).boundaryMessages).toBe(0);
    });

    test('summary 输入只序列化 messagesToSummarize，并排除 reasoning 与 kept tail', () => {
        const factory = createMessageFactory();
        const chatContext = new ChatContext();
        const previousBoundary = factory.boundary('previous-boundary', 'boundary-old');

        appendMessages(chatContext, [
            factory.user('hidden-u'),
            previousBoundary,
            factory.user('folded-user'),
            factory.reasoningAssistant('folded-assistant'),
            factory.toolAssistant(
                'folded-tool',
                'success',
                'tool result abcdefghijklmnopqrstuvwxyz',
                '{"long":"abcdefghijklmnopqrstuvwxyz"}'
            ),
            factory.user('kept-user'),
            factory.assistant('kept-assistant', 'assistant kept tail text')
        ]);

        const plan = buildFullCompactPlan(chatContext, {
            tailMessageCount: 2,
            tailAssistantToolMessageCount: 0,
            tailAssistantErrorMessageCount: 0,
            tailPlanMessageCount: 0
        });

        expect(plan).toBeDefined();

        const summaryText = buildFullCompactSummaryText(plan!, {
            toolArgsPreviewChars: 12,
            toolResultPreviewChars: 14
        });

        expect(summaryText).toContain('[Previous Compact Summary]');
        expect(summaryText).toContain('summary for previous-boundary');
        expect(summaryText).toContain('[User]: user folded-user');
        expect(summaryText).toContain('[Assistant]: assistant visible folded-assistant');
        expect(summaryText).toContain('[Tool Call: demo_tool]');
        expect(summaryText).toContain('Args: {"long":"abc...');
        expect(summaryText).toContain('Result(success): tool result ab...');
        expect(summaryText).not.toContain('private reasoning folded-assistant');
        expect(summaryText).not.toContain('user kept-user');
        expect(summaryText).not.toContain('assistant kept tail text');
        expect(summaryText).not.toContain('hidden-u');
    });

    test('generateFullCompactSummary 默认把 reserved summary output 传给 LLM.ask 的 maxCompletionTokens', async () => {
        const factory = createMessageFactory();
        const chatContext = new ChatContext();

        appendMessages(chatContext, [
            factory.user('u1'),
            factory.assistant('a1'),
            factory.user('u2'),
            factory.assistant('a2'),
            factory.user('u3'),
            factory.assistant('a3')
        ]);

        const plan = buildFullCompactPlan(chatContext, {
            tailMessageCount: 2,
            tailAssistantToolMessageCount: 0,
            tailAssistantErrorMessageCount: 0,
            tailPlanMessageCount: 0
        });
        expect(plan).toBeDefined();

        const askSpy = jest
            .spyOn(LLM, 'ask')
            .mockResolvedValue('<state_snapshot><overall_goal>demo</overall_goal></state_snapshot>');

        await expect(generateFullCompactSummary(plan!, 'anthropic/claude-4-sonnet')).resolves.toContain(
            '<state_snapshot>'
        );
        expect(askSpy).toHaveBeenCalledTimes(1);
        expect(askSpy.mock.calls[0]?.[1]).toBe('anthropic/claude-4-sonnet');
        expect(askSpy.mock.calls[0]?.[2]).toMatchObject({
            maxCompletionTokens: 20000
        });
    });

    test('enableAssistantRoundBoundary 打开后，planner 可以在单条 assistant 内部计算 keep anchor', () => {
        const factory = createMessageFactory();
        const chatContext = new ChatContext();
        const bigAssistant = createMultiRoundAssistant('big', ['old-round-1', 'old-round-2', 'recent-round-3']);

        const u1 = factory.user('u1');
        const a1 = factory.assistant('a1');
        const u2 = factory.user('u2');
        const a2 = factory.assistant('a2');
        const u3 = factory.user('u3');
        const a3 = factory.assistant('a3');

        appendMessages(chatContext, [u1, a1, bigAssistant, u2, a2, u3, a3]);

        const legacyPlan = buildFullCompactPlan(chatContext, {
            tailMessageCount: 5,
            tailAssistantToolMessageCount: 0,
            tailAssistantErrorMessageCount: 0,
            tailPlanMessageCount: 0
        });
        const roundAwarePlan = buildFullCompactPlan(chatContext, {
            tailMessageCount: 5,
            tailAssistantToolMessageCount: 0,
            tailAssistantErrorMessageCount: 0,
            tailPlanMessageCount: 0,
            enableAssistantRoundBoundary: true
        });

        expect(legacyPlan).toBeDefined();
        expect(roundAwarePlan).toBeDefined();
        expect(legacyPlan!.keepStartIndex).toBe(2);
        expect(legacyPlan!.messagesToKeep).toEqual([bigAssistant, u2, a2, u3, a3]);

        expect(roundAwarePlan!.keepStartIndex).toBe(2);
        expect(roundAwarePlan!.keepAnchor).toMatchObject({
            kind: 'assistant_round',
            messageIndex: 2,
            messageId: bigAssistant.message_id,
            startPartIndex: 6,
            roundRef: {
                assistantMessageId: bigAssistant.message_id,
                roundIndex: 2,
                startPartIndex: 6,
                endPartIndexExclusive: 9
            }
        });
        expect(roundAwarePlan!.leadingPartialAssistant).toMatchObject({
            message: bigAssistant,
            messageIndex: 2,
            roundRef: {
                assistantMessageId: bigAssistant.message_id,
                roundIndex: 2,
                startPartIndex: 6,
                endPartIndexExclusive: 9
            }
        });
        expect(factory.labelsOf(roundAwarePlan!.messagesToSummarize)).toEqual(['u1', 'a1']);
        expect(roundAwarePlan!.messagesToKeep).toEqual([bigAssistant, u2, a2, u3, a3]);
        expect(roundAwarePlan!.projectedItemsToSummarize?.map((item) => item.kind)).toEqual([
            'user_message',
            'assistant_round',
            'assistant_round',
            'assistant_round'
        ]);
        expect(
            roundAwarePlan!.projectedItemsToSummarize
                ?.filter((item) => item.kind === 'assistant_round')
                .map((item) => item.roundRef.roundIndex)
        ).toEqual([0, 0, 1]);
        expect(roundAwarePlan!.projectedItemsToKeep?.[0]).toMatchObject({
            kind: 'assistant_round',
            messageIndex: 2,
            messageId: bigAssistant.message_id,
            roundRef: {
                roundIndex: 2,
                startPartIndex: 6
            }
        });
    });

    test('round-aware summary text 只总结 keep anchor 之前的 assistant rounds', () => {
        const factory = createMessageFactory();
        const chatContext = new ChatContext();
        const bigAssistant = createMultiRoundAssistant('big', ['old-round-1', 'old-round-2', 'recent-round-3']);

        appendMessages(chatContext, [
            factory.user('u1'),
            factory.assistant('a1'),
            bigAssistant,
            factory.user('u2'),
            factory.assistant('a2'),
            factory.user('u3'),
            factory.assistant('a3')
        ]);

        const plan = buildFullCompactPlan(chatContext, {
            tailMessageCount: 5,
            tailAssistantToolMessageCount: 0,
            tailAssistantErrorMessageCount: 0,
            tailPlanMessageCount: 0,
            enableAssistantRoundBoundary: true
        });

        expect(plan).toBeDefined();

        const summaryText = buildFullCompactSummaryText(plan!, {
            toolArgsPreviewChars: 80,
            toolResultPreviewChars: 80
        });

        expect(summaryText).toContain('assistant big old-round-1');
        expect(summaryText).toContain('assistant big old-round-2');
        expect(summaryText).toContain('result big old-round-1 0');
        expect(summaryText).toContain('result big old-round-2 0');
        expect(summaryText).not.toContain('assistant big recent-round-3');
        expect(summaryText).not.toContain('result big recent-round-3 0');
        expect(summaryText).toContain('assistant message 2 round 2 (part 6)');
    });

    test('普通对话在 round-aware planner 下仍与旧 planner 保持一致', () => {
        const factory = createMessageFactory();
        const chatContext = new ChatContext();

        appendMessages(chatContext, [
            factory.user('u1'),
            factory.assistant('a1'),
            factory.user('u2'),
            factory.assistant('a2'),
            factory.user('u3'),
            factory.assistant('a3'),
            factory.user('u4'),
            factory.assistant('a4'),
            factory.user('u5'),
            factory.assistant('a5'),
            factory.user('u6'),
            factory.assistant('a6')
        ]);

        const legacyPlan = buildFullCompactPlan(chatContext, {
            tailAssistantToolMessageCount: 0,
            tailAssistantErrorMessageCount: 0,
            tailPlanMessageCount: 0
        });
        const roundAwarePlan = buildFullCompactPlan(chatContext, {
            tailAssistantToolMessageCount: 0,
            tailAssistantErrorMessageCount: 0,
            tailPlanMessageCount: 0,
            enableAssistantRoundBoundary: true
        });

        expect(legacyPlan).toBeDefined();
        expect(roundAwarePlan).toBeDefined();
        expect(roundAwarePlan!.keepStartIndex).toBe(legacyPlan!.keepStartIndex);
        expect(roundAwarePlan!.summarizeEndIndexExclusive).toBe(legacyPlan!.summarizeEndIndexExclusive);
        expect(factory.labelsOf(roundAwarePlan!.messagesToSummarize)).toEqual(
            factory.labelsOf(legacyPlan!.messagesToSummarize)
        );
        expect(factory.labelsOf(roundAwarePlan!.messagesToKeep)).toEqual(factory.labelsOf(legacyPlan!.messagesToKeep));
        expect(roundAwarePlan!.leadingPartialAssistant).toBeUndefined();
    });

    test('buildFullCompactResult 会创建带 tail-preserving metadata 的新 boundary', () => {
        const factory = createMessageFactory();
        const chatContext = new ChatContext();
        const previousBoundary = factory.boundary('previous-boundary', 'boundary-old');

        appendMessages(chatContext, [
            factory.user('hidden-u'),
            previousBoundary,
            factory.user('u1'),
            factory.assistant('a1'),
            factory.user('u2'),
            factory.assistant('a2'),
            factory.user('u3'),
            factory.assistant('a3'),
            factory.user('kept-u'),
            factory.assistant('kept-a')
        ]);

        const plan = buildFullCompactPlan(chatContext, {
            tailMessageCount: 2,
            tailAssistantToolMessageCount: 0,
            tailAssistantErrorMessageCount: 0,
            tailPlanMessageCount: 0
        });

        expect(plan).toBeDefined();

        const result = buildFullCompactResult(plan!, 'new structured summary', {
            boundaryId: 'boundary-new',
            createdAt: '2026-04-20T08:00:00.000Z',
            trigger: 'manual'
        });

        expect(result.summary).toBe('new structured summary');
        expect(result.boundary.summary).toBe('new structured summary');
        expect(result.boundary.metadata).toMatchObject({
            boundary_id: 'boundary-new',
            created_at: '2026-04-20T08:00:00.000Z',
            previous_boundary_id: 'boundary-old',
            trigger: 'manual',
            strategy: FULL_COMPACT_BOUNDARY_STRATEGY,
            kept_messages: 2,
            summarized_messages: 7,
            summarized_range: {
                start_index: 1,
                end_index_exclusive: 8,
                message_count: 7,
                user_messages: 3,
                assistant_messages: 3,
                tool_calls: 0
            },
            kept_range: {
                start_index: 8,
                end_index_exclusive: 10,
                message_count: 2,
                user_messages: 1,
                assistant_messages: 1,
                tool_calls: 0
            }
        });
    });

    test('applyFullCompactResult 会清理旧 boundary，并让 active context 变成新 boundary + kept tail', () => {
        const factory = createMessageFactory();
        const chatContext = new ChatContext();
        const previousBoundary = factory.boundary('previous-boundary', 'boundary-old');

        const hidden = factory.user('hidden-u');
        const foldedU1 = factory.user('u1');
        const foldedA1 = factory.assistant('a1');
        const foldedU2 = factory.user('u2');
        const foldedA2 = factory.assistant('a2');
        const foldedU3 = factory.user('u3');
        const foldedA3 = factory.assistant('a3');
        const keptUser = factory.user('kept-u');
        const keptAssistant = factory.assistant('kept-a');

        appendMessages(chatContext, [
            hidden,
            previousBoundary,
            foldedU1,
            foldedA1,
            foldedU2,
            foldedA2,
            foldedU3,
            foldedA3,
            keptUser,
            keptAssistant
        ]);

        const plan = buildFullCompactPlan(chatContext, {
            tailMessageCount: 2,
            tailAssistantToolMessageCount: 0,
            tailAssistantErrorMessageCount: 0,
            tailPlanMessageCount: 0
        });
        const result = buildFullCompactResult(plan!, 'new structured summary', {
            boundaryId: 'boundary-new',
            createdAt: '2026-04-20T08:00:00.000Z',
            trigger: 'auto'
        });

        applyFullCompactResult(chatContext, result);

        const boundaries = chatContext.messages.filter(isCompactBoundaryMessage);
        expect(boundaries).toEqual([result.boundary]);
        expect(chatContext.messages).not.toContain(previousBoundary);
        expect(chatContext.messages).toEqual([
            hidden,
            foldedU1,
            foldedA1,
            foldedU2,
            foldedA2,
            foldedU3,
            foldedA3,
            result.boundary,
            keptUser,
            keptAssistant
        ]);

        const activeContext = buildActiveContextView(chatContext);
        expect(activeContext.messages).toEqual([result.boundary, keptUser, keptAssistant]);
        expect(activeContext.boundary?.message).toBe(result.boundary);
    });

    test('CompactSeparatorMessage.assign 会保留 tail-preserving boundary metadata', () => {
        const restored = CompactSeparatorMessage.assign({
            role: 'compact_separator',
            summary: 'saved summary',
            metadata: {
                boundary_id: 'boundary-saved',
                summary_version: 1,
                created_at: '2026-04-20T08:00:00.000Z',
                previous_boundary_id: 'boundary-old',
                trigger: 'auto',
                strategy: FULL_COMPACT_BOUNDARY_STRATEGY,
                summarized_range: {
                    start_index: 1,
                    end_index_exclusive: 8,
                    message_count: 7,
                    user_messages: 3,
                    assistant_messages: 3,
                    tool_calls: 1
                },
                kept_range: {
                    start_index: 8,
                    end_index_exclusive: 10,
                    message_count: 2,
                    user_messages: 1,
                    assistant_messages: 1,
                    tool_calls: 0
                },
                kept_messages: 2,
                summarized_messages: 7,
                kept_anchor_message_id: 'assistant-anchor-message',
                kept_anchor_message_index: 8,
                kept_anchor_round_index: 2,
                kept_anchor_start_part_index: 5
            }
        });

        expect(restored.summary).toBe('saved summary');
        expect(restored.metadata).toMatchObject({
            boundary_id: 'boundary-saved',
            previous_boundary_id: 'boundary-old',
            trigger: 'auto',
            strategy: FULL_COMPACT_BOUNDARY_STRATEGY,
            kept_messages: 2,
            summarized_messages: 7,
            kept_anchor_message_id: 'assistant-anchor-message',
            kept_anchor_message_index: 8,
            kept_anchor_round_index: 2,
            kept_anchor_start_part_index: 5,
            summarized_range: {
                start_index: 1,
                end_index_exclusive: 8,
                message_count: 7,
                user_messages: 3,
                assistant_messages: 3,
                tool_calls: 1
            },
            kept_range: {
                start_index: 8,
                end_index_exclusive: 10,
                message_count: 2,
                user_messages: 1,
                assistant_messages: 1,
                tool_calls: 0
            }
        });
    });

    test('CompactSeparatorMessage.assign 兼容扁平化的 assistant internal anchor metadata', () => {
        const restored = CompactSeparatorMessage.assign({
            role: 'compact_separator',
            summary: 'saved summary',
            boundary_id: 'boundary-flat',
            summary_version: 1,
            created_at: '2026-04-20T09:00:00.000Z',
            strategy: FULL_COMPACT_BOUNDARY_STRATEGY,
            kept_anchor_message_id: 'assistant-anchor-flat',
            kept_anchor_message_index: 12,
            kept_anchor_round_index: 3,
            kept_anchor_start_part_index: 7
        });

        expect(restored.metadata).toMatchObject({
            boundary_id: 'boundary-flat',
            strategy: FULL_COMPACT_BOUNDARY_STRATEGY,
            kept_anchor_message_id: 'assistant-anchor-flat',
            kept_anchor_message_index: 12,
            kept_anchor_round_index: 3,
            kept_anchor_start_part_index: 7
        });
    });

    test('compactFullContext 会通过注入 summary 生成器完成 summary + apply', async () => {
        const factory = createMessageFactory();
        const chatContext = new ChatContext();
        const previousBoundary = factory.boundary('previous-boundary', 'boundary-old');
        const summaryRequests: Array<{ summaryText: string; model?: string }> = [];

        const keptUser = factory.user('kept-u');
        const keptAssistant = factory.assistant('kept-a');

        appendMessages(chatContext, [
            factory.user('hidden-u'),
            previousBoundary,
            factory.user('u1'),
            factory.assistant('a1'),
            factory.user('u2'),
            factory.assistant('a2'),
            factory.user('u3'),
            factory.assistant('a3'),
            keptUser,
            keptAssistant
        ]);

        const runResult = await compactFullContext(chatContext, 'demo-model', {
            tailMessageCount: 2,
            tailAssistantToolMessageCount: 0,
            tailAssistantErrorMessageCount: 0,
            tailPlanMessageCount: 0,
            boundaryId: 'boundary-new',
            createdAt: '2026-04-20T08:00:00.000Z',
            trigger: 'auto',
            generateSummary: async ({ summaryText, model }) => {
                summaryRequests.push({ summaryText, model });
                return '<state_snapshot><overall_goal>demo</overall_goal></state_snapshot>';
            }
        });

        expect(runResult.compacted).toBe(true);
        expect(runResult.summary).toBe('<state_snapshot><overall_goal>demo</overall_goal></state_snapshot>');
        expect(summaryRequests).toHaveLength(1);
        expect(summaryRequests[0].model).toBe('demo-model');
        expect(summaryRequests[0].summaryText).toContain('summary for previous-boundary');
        expect(summaryRequests[0].summaryText).toContain('[User]: user u1');
        expect(summaryRequests[0].summaryText).not.toContain('hidden-u');
        expect(summaryRequests[0].summaryText).not.toContain('user kept-u');

        const activeContext = buildActiveContextView(chatContext);
        expect(activeContext.messages).toEqual([runResult.boundary, keptUser, keptAssistant]);
        expect(runResult.boundary?.metadata).toMatchObject({
            boundary_id: 'boundary-new',
            previous_boundary_id: 'boundary-old',
            trigger: 'auto',
            strategy: FULL_COMPACT_BOUNDARY_STRATEGY
        });
    });

    test('compactFullContext 在消息太少时返回 no-op，且不会调用 summary 生成器', async () => {
        const factory = createMessageFactory();
        const chatContext = new ChatContext();
        const generateSummary = jest.fn(async () => 'should not be used');

        appendMessages(chatContext, [factory.user('u1'), factory.assistant('a1'), factory.user('u2')]);

        const runResult = await compactFullContext(chatContext, undefined, { generateSummary });

        expect(runResult.compacted).toBe(false);
        expect(runResult.plan).toBeUndefined();
        expect(generateSummary).not.toHaveBeenCalled();
        expect(chatContext.messages).toHaveLength(3);
        expect(chatContext.findCompactBoundary()).toBeUndefined();
    });

    test('compactContext 会传播 summary 失败，供 pipeline 记录失败状态', async () => {
        const factory = createMessageFactory();
        const chatContext = new ChatContext();

        appendMessages(chatContext, [
            factory.user('u1'),
            factory.assistant('a1'),
            factory.user('u2'),
            factory.assistant('a2'),
            factory.user('u3'),
            factory.assistant('a3'),
            factory.user('u4'),
            factory.assistant('a4'),
            factory.user('u5'),
            factory.assistant('a5')
        ]);

        await expect(
            compactContext(chatContext, undefined, {
                tailMessageCount: 2,
                tailAssistantToolMessageCount: 0,
                tailAssistantErrorMessageCount: 0,
                tailPlanMessageCount: 0,
                generateSummary: async () => {
                    throw new Error('summary failed');
                }
            })
        ).rejects.toThrow('summary failed');

        expect(chatContext.findCompactBoundary()).toBeUndefined();
    });

    test('连续 compact 会把旧 boundary summary 纳入新 summary 输入，并继续保护最新 kept tail', async () => {
        const factory = createMessageFactory();
        const chatContext = new ChatContext();
        const summaryRequests: string[] = [];

        const firstKeptUser = factory.user('first-kept-u');
        const firstKeptAssistant = factory.assistant('first-kept-a');

        appendMessages(chatContext, [
            factory.user('u1'),
            factory.assistant('a1'),
            factory.user('u2'),
            factory.assistant('a2'),
            factory.user('u3'),
            factory.assistant('a3'),
            firstKeptUser,
            firstKeptAssistant
        ]);

        const firstRun = await compactFullContext(chatContext, undefined, {
            tailMessageCount: 2,
            tailAssistantToolMessageCount: 0,
            tailAssistantErrorMessageCount: 0,
            tailPlanMessageCount: 0,
            boundaryId: 'boundary-first',
            createdAt: '2026-04-20T08:00:00.000Z',
            trigger: 'manual',
            generateSummary: async ({ summaryText }) => {
                summaryRequests.push(summaryText);
                return 'first compact summary';
            }
        });

        expect(firstRun.compacted).toBe(true);
        expect(buildActiveContextView(chatContext).messages).toEqual([
            firstRun.boundary,
            firstKeptUser,
            firstKeptAssistant
        ]);

        const secondKeptUser = factory.user('second-kept-u');
        const secondKeptAssistant = factory.assistant('second-kept-a');
        appendMessages(chatContext, [
            factory.user('new-u1'),
            factory.assistant('new-a1'),
            factory.user('new-u2'),
            factory.assistant('new-a2'),
            secondKeptUser,
            secondKeptAssistant
        ]);

        const secondRun = await compactFullContext(chatContext, undefined, {
            tailMessageCount: 2,
            tailAssistantToolMessageCount: 0,
            tailAssistantErrorMessageCount: 0,
            tailPlanMessageCount: 0,
            boundaryId: 'boundary-second',
            createdAt: '2026-04-20T08:10:00.000Z',
            trigger: 'manual',
            generateSummary: async ({ summaryText }) => {
                summaryRequests.push(summaryText);
                return 'second compact summary';
            }
        });

        expect(secondRun.compacted).toBe(true);
        expect(summaryRequests).toHaveLength(2);
        expect(summaryRequests[1]).toContain('[Previous Compact Summary]');
        expect(summaryRequests[1]).toContain('first compact summary');
        expect(summaryRequests[1]).toContain('user first-kept-u');
        expect(summaryRequests[1]).toContain('assistant first-kept-a');
        expect(summaryRequests[1]).toContain('user new-u1');
        expect(summaryRequests[1]).not.toContain('user second-kept-u');
        expect(summaryRequests[1]).not.toContain('assistant second-kept-a');
        expect(chatContext.messages.filter(isCompactBoundaryMessage)).toEqual([secondRun.boundary]);
        expect(secondRun.boundary?.metadata.previous_boundary_id).toBe('boundary-first');
        expect(buildActiveContextView(chatContext).messages).toEqual([
            secondRun.boundary,
            secondKeptUser,
            secondKeptAssistant
        ]);
    });

    test('step 6 round-aware apply keeps assistant partial visibility', async () => {
        const factory = createMessageFactory();
        const chatContext = new ChatContext();
        const bigAssistant = createMultiRoundAssistant('big', ['old-round-1', 'old-round-2', 'recent-round-3']);
        const u1 = factory.user('u1');
        const a1 = factory.assistant('a1');
        const u2 = factory.user('u2');
        const a2 = factory.assistant('a2');
        const u3 = factory.user('u3');
        const a3 = factory.assistant('a3');

        appendMessages(chatContext, [u1, a1, bigAssistant, u2, a2, u3, a3]);

        const runResult = await compactFullContext(chatContext, undefined, {
            tailMessageCount: 5,
            tailAssistantToolMessageCount: 0,
            tailAssistantErrorMessageCount: 0,
            tailPlanMessageCount: 0,
            enableAssistantRoundBoundary: true,
            boundaryId: 'boundary-round-aware-step6',
            createdAt: '2026-04-27T00:00:00.000Z',
            trigger: 'manual',
            generateSummary: async () => '<state_snapshot><overall_goal>step6</overall_goal></state_snapshot>'
        });

        expect(runResult.compacted).toBe(true);
        expect(chatContext.messages).toEqual([u1, a1, runResult.boundary, bigAssistant, u2, a2, u3, a3]);
        expect(runResult.boundary?.metadata).toMatchObject({
            boundary_id: 'boundary-round-aware-step6',
            kept_anchor_message_id: bigAssistant.message_id,
            kept_anchor_message_index: 2,
            kept_anchor_round_index: 2,
            kept_anchor_start_part_index: 6
        });

        const activeContext = buildActiveContextView(chatContext);
        expect(activeContext.messages).toEqual([runResult.boundary, bigAssistant, u2, a2, u3, a3]);
        expect(activeContext.leadingPartialAssistant).toMatchObject({
            message: bigAssistant,
            messageIndex: 3,
            roundRef: {
                assistantMessageId: bigAssistant.message_id,
                roundIndex: 2,
                startPartIndex: 6,
                endPartIndexExclusive: 9
            }
        });

        const projectedView = buildProjectedActiveContextView(chatContext);
        const bigAssistantRoundItems = projectedView.projectedItems.filter(
            (item) => item.kind === 'assistant_round' && item.message === bigAssistant
        );
        expect(bigAssistantRoundItems).toHaveLength(1);
        expect(bigAssistantRoundItems[0].roundRef).toEqual({
            assistantMessageId: bigAssistant.message_id,
            roundIndex: 2,
            startPartIndex: 6,
            endPartIndexExclusive: 9
        });
    });

    test('step 0 legacy message-granularity full compact path still cannot advance an existing boundary through a pure single-assistant active context', async () => {
        const factory = createMessageFactory();
        const chatContext = new ChatContext();
        const previousBoundary = factory.boundary('previous-boundary', 'boundary-old');
        const bigAssistant = new AssistantMessage();
        appendAssistantRoundSequence(bigAssistant, 'builder', 1, 20);

        appendMessages(chatContext, [factory.user('hidden-u'), previousBoundary, bigAssistant]);

        const legacyPlan = buildFullCompactPlan(chatContext, {
            enableAssistantRoundBoundary: false
        });
        expect(legacyPlan).toBeUndefined();

        await expect(
            compactContext(chatContext, undefined, {
                enableAssistantRoundBoundary: false,
                boundaryId: 'boundary-single-assistant-legacy-step0',
                createdAt: '2026-04-27T00:00:00.000Z',
                trigger: 'auto',
                generateSummary: async () => '<state_snapshot><overall_goal>step0</overall_goal></state_snapshot>'
            })
        ).resolves.toBe(false);

        expect(chatContext.findCompactBoundary()?.message).toBe(previousBoundary);
        expect(buildActiveContextView(chatContext).leadingPartialAssistant).toBeUndefined();
    });

    test('step 1 projected summarize eligibility uses projected visible units instead of physical assistant message count', () => {
        const factory = createMessageFactory();
        const chatContext = new ChatContext();
        const previousBoundary = factory.boundary('previous-boundary', 'boundary-old');
        const bigAssistant = new AssistantMessage();
        appendAssistantRoundSequence(bigAssistant, 'builder', 1, 20);

        appendMessages(chatContext, [factory.user('hidden-u'), previousBoundary, bigAssistant]);

        const roundAwarePlan = buildFullCompactPlan(chatContext, {
            enableAssistantRoundBoundary: true,
            minMessagesToSummarize: 12
        });
        const overThresholdPlan = buildFullCompactPlan(chatContext, {
            enableAssistantRoundBoundary: true,
            minMessagesToSummarize: 13
        });

        expect(roundAwarePlan).toBeDefined();
        expect(roundAwarePlan!.summarizedStats.assistantMessages).toBe(1);
        expect(roundAwarePlan!.projectedItemsToSummarize?.[0]?.kind).toBe('compact_boundary');
        expect(
            roundAwarePlan!.projectedItemsToSummarize?.filter((item) => item.kind === 'assistant_round')
        ).toHaveLength(12);
        expect(roundAwarePlan!.keepAnchor).toMatchObject({
            kind: 'assistant_round',
            messageId: bigAssistant.message_id,
            messageIndex: 2
        });
        expect(overThresholdPlan).toBeUndefined();
    });

    test('step 1 projected summarize eligibility lets full compact advance an existing boundary through a pure single-assistant active context', async () => {
        const factory = createMessageFactory();
        const chatContext = new ChatContext();
        const hiddenUser = factory.user('hidden-u');
        const previousBoundary = factory.boundary('previous-boundary', 'boundary-old');
        const bigAssistant = new AssistantMessage();
        appendAssistantRoundSequence(bigAssistant, 'builder', 1, 20);

        appendMessages(chatContext, [hiddenUser, previousBoundary, bigAssistant]);

        const projectedViewBeforeCompact = buildProjectedActiveContextView(chatContext);
        const visibleAssistantRoundsBeforeCompact = projectedViewBeforeCompact.projectedItems.filter(
            (item) => item.kind === 'assistant_round' && item.message === bigAssistant
        );
        expect(visibleAssistantRoundsBeforeCompact).toHaveLength(20);

        const roundAwarePlan = buildFullCompactPlan(chatContext, {
            enableAssistantRoundBoundary: true
        });
        expect(roundAwarePlan).toBeDefined();
        expect(roundAwarePlan!.keepAnchor).toMatchObject({
            kind: 'assistant_round',
            messageId: bigAssistant.message_id,
            messageIndex: 2
        });
        expect(roundAwarePlan!.leadingPartialAssistant?.message).toBe(bigAssistant);
        expect(roundAwarePlan!.leadingPartialAssistant?.roundRef.startPartIndex).toBeGreaterThan(0);

        await expect(
            compactContext(chatContext, undefined, {
                enableAssistantRoundBoundary: true,
                boundaryId: 'boundary-single-assistant-step1',
                createdAt: '2026-04-27T00:00:00.000Z',
                trigger: 'auto',
                generateSummary: async () => '<state_snapshot><overall_goal>step1</overall_goal></state_snapshot>'
            })
        ).resolves.toBe(true);

        const newBoundary = chatContext.findCompactBoundary()?.message;
        expect(newBoundary).toBeDefined();
        expect(newBoundary).not.toBe(previousBoundary);
        expect(newBoundary?.metadata).toMatchObject({
            boundary_id: 'boundary-single-assistant-step1',
            previous_boundary_id: 'boundary-old',
            kept_anchor_message_id: bigAssistant.message_id,
            kept_anchor_message_index: 2
        });
        expect(chatContext.messages).toEqual([hiddenUser, newBoundary, bigAssistant]);

        const activeContext = buildActiveContextView(chatContext);
        expect(activeContext.messages).toEqual([newBoundary, bigAssistant]);
        expect(activeContext.leadingPartialAssistant?.message).toBe(bigAssistant);
        expect(activeContext.leadingPartialAssistant?.roundRef.startPartIndex).toBeGreaterThan(0);

        const projectedViewAfterCompact = buildProjectedActiveContextView(chatContext);
        const visibleAssistantRoundsAfterCompact = projectedViewAfterCompact.projectedItems.filter(
            (item) => item.kind === 'assistant_round' && item.message === bigAssistant
        );
        expect(visibleAssistantRoundsAfterCompact.length).toBeLessThan(visibleAssistantRoundsBeforeCompact.length);
        expect(visibleAssistantRoundsAfterCompact[0]?.roundRef.roundIndex).toBeGreaterThan(0);
    });

    test('step 2 active context can restore boundary + recent user + partial assistant visibility from boundary metadata', () => {
        const factory = createMessageFactory();
        const chatContext = new ChatContext();
        const hiddenUser = factory.user('hidden-u');
        const hiddenAssistant = factory.assistant('hidden-a');
        const recentUser = factory.user('recent-user');
        const bigAssistant = createMultiRoundAssistant('big', ['old-round-1', 'old-round-2', 'recent-round-3']);
        const boundary = new CompactSeparatorMessage('summary for hidden history', {
            boundary_id: 'boundary-step2-replay',
            created_at: '2026-04-27T00:00:00.000Z',
            strategy: FULL_COMPACT_BOUNDARY_STRATEGY,
            kept_anchor_message_id: bigAssistant.message_id,
            kept_anchor_message_index: 4,
            kept_anchor_round_index: 2,
            kept_anchor_start_part_index: 6
        });

        appendMessages(chatContext, [hiddenUser, hiddenAssistant, boundary, recentUser, bigAssistant]);

        const activeContext = buildActiveContextView(chatContext);
        expect(activeContext.messages).toEqual([boundary, recentUser, bigAssistant]);
        expect(activeContext.leadingPartialAssistant).toMatchObject({
            message: bigAssistant,
            messageIndex: 4,
            roundRef: {
                assistantMessageId: bigAssistant.message_id,
                roundIndex: 2,
                startPartIndex: 6,
                endPartIndexExclusive: 9
            }
        });

        const projectedView = buildProjectedActiveContextView(chatContext);
        expect(projectedView.projectedItems.map((item) => item.kind)).toEqual([
            'compact_boundary',
            'user_message',
            'assistant_round'
        ]);
        expect(projectedView.projectedItems[1]).toMatchObject({
            kind: 'user_message',
            messageIndex: 3,
            messageId: recentUser.message_id,
            message: recentUser
        });
        expect(projectedView.projectedItems[2]).toMatchObject({
            kind: 'assistant_round',
            messageIndex: 4,
            messageId: bigAssistant.message_id,
            roundRef: {
                assistantMessageId: bigAssistant.message_id,
                roundIndex: 2,
                startPartIndex: 6,
                endPartIndexExclusive: 9
            }
        });
    });

    test('step 3 round-aware planner can separate physical keep start from assistant round keep anchor for recent user + huge assistant', () => {
        const chatContext = new ChatContext();
        const recentUser = new UserMessage('keep watching the build output');
        const bigAssistant = new AssistantMessage();
        appendAssistantRoundSequence(bigAssistant, 'builder', 1, 20);

        appendMessages(chatContext, [recentUser, bigAssistant]);

        const projectedView = buildProjectedActiveContextView(chatContext);
        expect(projectedView.projectedItems.filter((item) => item.kind === 'assistant_round')).toHaveLength(20);
        expect(projectedView.projectedItems[0]?.kind).toBe('user_message');

        const roundAwarePlan = buildFullCompactPlan(chatContext, {
            enableAssistantRoundBoundary: true
        });

        expect(roundAwarePlan).toBeDefined();
        expect(roundAwarePlan!.physicalKeepStartIndex).toBe(0);
        expect(roundAwarePlan!.keepStartIndex).toBe(0);
        expect(roundAwarePlan!.messagesToKeep).toEqual([recentUser, bigAssistant]);
        expect(roundAwarePlan!.messagesToSummarize).toEqual([]);
        expect(roundAwarePlan!.keepAnchor).toMatchObject({
            kind: 'assistant_round',
            messageIndex: 1,
            messageId: bigAssistant.message_id,
            roundRef: {
                assistantMessageId: bigAssistant.message_id,
                roundIndex: 12,
                startPartIndex: 36,
                endPartIndexExclusive: 39
            }
        });
        expect(roundAwarePlan!.leadingPartialAssistant).toMatchObject({
            message: bigAssistant,
            messageIndex: 1,
            roundRef: {
                assistantMessageId: bigAssistant.message_id,
                roundIndex: 12,
                startPartIndex: 36,
                endPartIndexExclusive: 39
            }
        });
        expect(roundAwarePlan!.projectedItemsToSummarize?.some((item) => item.kind === 'user_message')).toBe(false);
        expect(roundAwarePlan!.projectedItemsToKeep?.[0]).toMatchObject({
            kind: 'user_message',
            messageIndex: 0,
            messageId: recentUser.message_id,
            message: recentUser
        });
        expect(roundAwarePlan!.projectedItemsToKeep?.slice(1).every((item) => item.kind === 'assistant_round')).toBe(
            true
        );
        expect(
            roundAwarePlan!.projectedItemsToKeep
                ?.slice(1)
                .map((item) => (item.kind === 'assistant_round' ? item.roundRef.roundIndex : -1))
        ).toEqual([12, 13, 14, 15, 16, 17, 18, 19]);
        expect(roundAwarePlan!.projectedItemsToSummarize).toHaveLength(12);
    });

    test('step 5 full compact apply supports boundary + recent user + partial assistant', async () => {
        const chatContext = new ChatContext();
        const recentUser = new UserMessage('keep watching the build output');
        const bigAssistant = new AssistantMessage();
        appendAssistantRoundSequence(bigAssistant, 'builder', 1, 20);

        appendMessages(chatContext, [recentUser, bigAssistant]);

        const roundAwarePlan = buildFullCompactPlan(chatContext, {
            enableAssistantRoundBoundary: true
        });
        expect(roundAwarePlan).toBeDefined();

        const runResult = await compactFullContext(chatContext, undefined, {
            enableAssistantRoundBoundary: true,
            boundaryId: 'boundary-step5-recent-user-partial-assistant',
            createdAt: '2026-04-27T00:00:00.000Z',
            trigger: 'auto',
            generateSummary: async () => '<state_snapshot><overall_goal>step5</overall_goal></state_snapshot>'
        });

        expect(runResult.compacted).toBe(true);
        expect(runResult.plan?.physicalKeepStartIndex).toBe(0);
        expect(chatContext.findCompactBoundary()?.message).toBe(runResult.boundary);
        expect(runResult.boundary?.metadata).toMatchObject({
            boundary_id: 'boundary-step5-recent-user-partial-assistant',
            trigger: 'auto',
            strategy: FULL_COMPACT_BOUNDARY_STRATEGY,
            kept_anchor_message_id: bigAssistant.message_id,
            kept_anchor_round_index: 12,
            kept_anchor_start_part_index: 36
        });
        expect(chatContext.messages).toEqual([runResult.boundary, recentUser, bigAssistant]);

        const activeContext = buildActiveContextView(chatContext);
        expect(activeContext.messages).toEqual([runResult.boundary, recentUser, bigAssistant]);
        expect(activeContext.leadingPartialAssistant).toMatchObject({
            message: bigAssistant,
            messageIndex: 2,
            roundRef: {
                assistantMessageId: bigAssistant.message_id,
                roundIndex: 12,
                startPartIndex: 36,
                endPartIndexExclusive: 39
            }
        });

        const projectedView = buildProjectedActiveContextView(chatContext);
        expect(projectedView.projectedItems[0]?.kind).toBe('compact_boundary');
        expect(projectedView.projectedItems[1]).toMatchObject({
            kind: 'user_message',
            messageIndex: 1,
            messageId: recentUser.message_id,
            message: recentUser
        });
        expect(projectedView.projectedItems.filter((item) => item.kind === 'assistant_round')).toHaveLength(8);
    });

    test('step 4 round-aware summary text for recent user + huge assistant excludes the recent user and visible assistant tail', () => {
        const chatContext = new ChatContext();
        const recentUser = new UserMessage('keep watching the build output');
        const bigAssistant = new AssistantMessage();
        appendAssistantRoundSequence(bigAssistant, 'builder', 1, 20);

        appendMessages(chatContext, [recentUser, bigAssistant]);

        const plan = buildFullCompactPlan(chatContext, {
            enableAssistantRoundBoundary: true
        });
        expect(plan).toBeDefined();
        expect(plan!.physicalKeepStartIndex).toBe(0);
        expect(plan!.keepAnchor).toMatchObject({
            kind: 'assistant_round',
            messageIndex: 1,
            roundRef: {
                roundIndex: 12,
                startPartIndex: 36,
                endPartIndexExclusive: 39
            }
        });

        const summaryText = buildFullCompactSummaryText(plan!, {
            toolArgsPreviewChars: 80,
            toolResultPreviewChars: 80
        });

        expect(summaryText).toContain(
            'summarize projected items before assistant message 1 round 12 (part 36); physical kept tail starts at chat_context.messages[0]'
        );
        expect(summaryText).toContain(
            'preserved raw-visible messages before the assistant anchor are intentionally excluded'
        );
        expect(summaryText).toContain('assistant builder round-01');
        expect(summaryText).toContain('assistant builder round-12');
        expect(summaryText).toContain('result builder round-01 0');
        expect(summaryText).toContain('result builder round-12 0');
        expect(summaryText).not.toContain('keep watching the build output');
        expect(summaryText).not.toContain('assistant builder round-13');
        expect(summaryText).not.toContain('assistant builder round-20');
        expect(summaryText).not.toContain('result builder round-13 0');
        expect(summaryText).not.toContain('result builder round-20 0');
    });

    test('step 6 boundary + huge assistant keeps moving the assistant round anchor forward across repeated full compactions', async () => {
        const factory = createMessageFactory();
        const chatContext = new ChatContext();
        const hiddenUser = factory.user('hidden-u');
        const initialBoundary = factory.boundary('previous-boundary', 'boundary-step6-single-assistant-initial');
        const bigAssistant = new AssistantMessage();
        appendAssistantRoundSequence(bigAssistant, 'builder', 1, 20);

        appendMessages(chatContext, [hiddenUser, initialBoundary, bigAssistant]);

        const anchorHistory: number[] = [];
        const visibleWindowStarts: number[] = [];
        let previousBoundaryId = 'boundary-step6-single-assistant-initial';

        for (let iteration = 0; iteration < 3; iteration++) {
            const boundaryId = `boundary-step6-single-assistant-${iteration + 1}`;
            const runResult = await compactFullContext(chatContext, undefined, {
                tailMessageCount: 8,
                tailAssistantToolMessageCount: 0,
                tailAssistantErrorMessageCount: 0,
                tailPlanMessageCount: 0,
                enableAssistantRoundBoundary: true,
                boundaryId,
                createdAt: '2026-04-27T00:00:00.000Z',
                trigger: 'manual',
                generateSummary: async () =>
                    `<state_snapshot><overall_goal>${boundaryId}</overall_goal></state_snapshot>`
            });

            expect(runResult.compacted).toBe(true);
            expect(runResult.boundary?.metadata.previous_boundary_id).toBe(previousBoundaryId);
            expect(chatContext.messages).toEqual([hiddenUser, runResult.boundary, bigAssistant]);

            const anchorRoundIndex = runResult.boundary?.metadata.kept_anchor_round_index;
            expect(typeof anchorRoundIndex).toBe('number');
            anchorHistory.push(anchorRoundIndex!);

            const activeContext = buildActiveContextView(chatContext);
            expect(activeContext.messages).toEqual([runResult.boundary, bigAssistant]);
            expect(activeContext.leadingPartialAssistant).toMatchObject({
                message: bigAssistant,
                roundRef: {
                    roundIndex: anchorRoundIndex
                }
            });

            const visibleRoundIndices = getVisibleAssistantRoundIndices(chatContext, bigAssistant);
            visibleWindowStarts.push(visibleRoundIndices[0] ?? -1);
            expect(visibleRoundIndices).toHaveLength(8);
            expect(visibleRoundIndices[0]).toBe(anchorRoundIndex);
            expect(visibleRoundIndices).toEqual(Array.from({ length: 8 }, (_, index) => anchorRoundIndex! + index));

            const serialized = JSON.stringify(LLM.buildMessages(chatContext, false));
            const firstVisibleRoundNumber = anchorRoundIndex! + 1;
            const lastVisibleRoundNumber = anchorRoundIndex! + 8;
            expect(serialized).not.toContain(formatRoundLabel(anchorRoundIndex!));
            expect(serialized).toContain(formatRoundLabel(firstVisibleRoundNumber));
            expect(serialized).toContain(formatRoundLabel(lastVisibleRoundNumber));

            previousBoundaryId = boundaryId;
            if (iteration < 2) {
                appendAssistantRoundSequence(bigAssistant, 'builder', lastVisibleRoundNumber + 1, 8);
            }
        }

        expect(anchorHistory).toEqual([12, 20, 28]);
        expect(visibleWindowStarts).toEqual(anchorHistory);
        expect(anchorHistory[1]).toBeGreaterThan(anchorHistory[0]);
        expect(anchorHistory[2]).toBeGreaterThan(anchorHistory[1]);
    });

    test('step 6 recent user + huge assistant keeps the user visible while the assistant round anchor advances monotonically', async () => {
        const chatContext = new ChatContext();
        const recentUser = new UserMessage('keep watching the build output');
        const bigAssistant = new AssistantMessage();
        appendAssistantRoundSequence(bigAssistant, 'builder', 1, 20);

        appendMessages(chatContext, [recentUser, bigAssistant]);

        const anchorHistory: number[] = [];
        const visibleWindowStarts: number[] = [];
        let previousBoundaryId: string | undefined = undefined;

        for (let iteration = 0; iteration < 3; iteration++) {
            const boundaryId = `boundary-step6-recent-user-${iteration + 1}`;
            const runResult = await compactFullContext(chatContext, undefined, {
                tailMessageCount: 8,
                tailAssistantToolMessageCount: 0,
                tailAssistantErrorMessageCount: 0,
                tailPlanMessageCount: 0,
                enableAssistantRoundBoundary: true,
                boundaryId,
                createdAt: '2026-04-27T00:00:00.000Z',
                trigger: 'manual',
                generateSummary: async () =>
                    `<state_snapshot><overall_goal>${boundaryId}</overall_goal></state_snapshot>`
            });

            expect(runResult.compacted).toBe(true);
            expect(runResult.boundary?.metadata.previous_boundary_id).toBe(previousBoundaryId);
            expect(chatContext.messages).toEqual([runResult.boundary, recentUser, bigAssistant]);

            const anchorRoundIndex = runResult.boundary?.metadata.kept_anchor_round_index;
            expect(typeof anchorRoundIndex).toBe('number');
            anchorHistory.push(anchorRoundIndex!);

            const activeContext = buildActiveContextView(chatContext);
            expect(activeContext.messages).toEqual([runResult.boundary, recentUser, bigAssistant]);
            expect(activeContext.leadingPartialAssistant).toMatchObject({
                message: bigAssistant,
                roundRef: {
                    roundIndex: anchorRoundIndex
                }
            });

            const visibleRoundIndices = getVisibleAssistantRoundIndices(chatContext, bigAssistant);
            visibleWindowStarts.push(visibleRoundIndices[0] ?? -1);
            expect(visibleRoundIndices).toHaveLength(8);
            expect(visibleRoundIndices[0]).toBe(anchorRoundIndex);
            expect(visibleRoundIndices).toEqual(Array.from({ length: 8 }, (_, index) => anchorRoundIndex! + index));

            const serialized = JSON.stringify(LLM.buildMessages(chatContext, false));
            const firstVisibleRoundNumber = anchorRoundIndex! + 1;
            const lastVisibleRoundNumber = anchorRoundIndex! + 8;
            expect(serialized).toContain('keep watching the build output');
            expect(serialized).not.toContain(formatRoundLabel(anchorRoundIndex!));
            expect(serialized).toContain(formatRoundLabel(firstVisibleRoundNumber));
            expect(serialized).toContain(formatRoundLabel(lastVisibleRoundNumber));

            previousBoundaryId = boundaryId;
            if (iteration < 2) {
                appendAssistantRoundSequence(bigAssistant, 'builder', lastVisibleRoundNumber + 1, 8);
            }
        }

        expect(anchorHistory).toEqual([12, 20, 28]);
        expect(visibleWindowStarts).toEqual(anchorHistory);
        expect(anchorHistory[1]).toBeGreaterThan(anchorHistory[0]);
        expect(anchorHistory[2]).toBeGreaterThan(anchorHistory[1]);
    });
});
