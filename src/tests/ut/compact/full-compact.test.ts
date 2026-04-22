import { jest } from '@jest/globals';
import {
    FULL_COMPACT_BOUNDARY_STRATEGY,
    applyFullCompactResult,
    buildFullCompactResult,
    buildFullCompactPlan,
    buildFullCompactSummaryText,
    compactFullContext,
    countFullCompactMessageStats
} from '../../../main/aikernel/compaction/full-compact';
import { buildActiveContextView } from '../../../main/aikernel/compaction/context-view';
import { compactContext } from '../../../main/aikernel/compact';
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
                summarized_messages: 7
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
});
