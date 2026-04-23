import { jest } from '@jest/globals';
import { AutoCompactStates, createAutoCompactDecision } from '../../../main/aikernel/compaction/auto-compact';
import { FULL_COMPACT_BOUNDARY_STRATEGY } from '../../../main/aikernel/compaction/full-compact';
import { prepareContextForModel } from '../../../main/aikernel/compaction/pipeline';
import { LLM } from '../../../main/aikernel/llm';
import { AssistantMessage, ChatContext, UserMessage, isCompactBoundaryMessage } from '../../../main/aikernel/messages';

function createChatContext(): ChatContext {
    const chatContext = new ChatContext();
    chatContext.appendMessage(new UserMessage('hello'));
    return chatContext;
}

function appendAssistantMessage(chatContext: ChatContext, text: string): void {
    const message = new AssistantMessage();
    message.appendText(text);
    chatContext.appendMessage(message);
}

function createCompactableChatContext(): ChatContext {
    const chatContext = new ChatContext();
    for (let index = 1; index <= 5; index++) {
        chatContext.appendMessage(new UserMessage(`user ${index}`));
        appendAssistantMessage(chatContext, `assistant ${index}`);
    }
    return chatContext;
}

describe('压缩 pipeline 的自动压缩状态流', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.restoreAllMocks();
        jest.useRealTimers();
    });

    test('达到阈值时会执行自动 compact，并在成功后清空失败状态', async () => {
        const now = new Date('2026-04-17T02:00:00.000Z');
        jest.setSystemTime(now);

        const chatContext = createChatContext();
        const autoCompactState = AutoCompactStates.deserialize({
            consecutive_failures: 2,
            last_failure_at: '2026-04-17T01:55:00.000Z',
            failure_threshold: 3,
            cooldown_ms: 60000,
            last_failure_reason: 'previous failure'
        });
        const beforeCompact = jest.fn();
        const executeCompact = jest.fn(() => {
            chatContext.appendMessage(new UserMessage('after compact'));
        });

        const result = await prepareContextForModel(chatContext, undefined, {
            autoCompactDecisionOverride: createAutoCompactDecision({
                contextWindow: 1000,
                promptTokens: 720,
                reservedSummaryOutput: 100
            }),
            autoCompactState,
            beforeCompact,
            executeCompact
        });

        expect(beforeCompact).toHaveBeenCalledTimes(1);
        expect(executeCompact).toHaveBeenCalledTimes(1);
        expect(result.shouldCompact).toBe(true);
        expect(result.compacted).toBe(true);
        expect(result.autoCompactDecision.reason).toBe('at_or_above_threshold');
        expect(result.autoCompactStateChanged).toBe(true);
        expect(result.autoCompactState).toBe(autoCompactState);
        expect(autoCompactState.consecutiveFailures).toBe(0);
        expect(autoCompactState.lastAttemptAt).toBe(now.toISOString());
        expect(autoCompactState.lastSuccessAt).toBe(now.toISOString());
        expect(autoCompactState.cooldownUntil).toBeUndefined();
        expect(autoCompactState.lastFailureReason).toBeUndefined();
        expect(result.activeContext.messages).toHaveLength(2);
        expect((result.activeContext.messages[1] as UserMessage).getPlainText()).toBe('after compact');
    });

    test('处于 cooldown 时即使策略判定应 compact，也不会执行自动 compact', async () => {
        const now = new Date('2026-04-17T02:00:00.000Z');
        jest.setSystemTime(now);

        const chatContext = createChatContext();
        const autoCompactState = AutoCompactStates.deserialize({
            consecutive_failures: 3,
            last_attempt_at: '2026-04-17T01:59:00.000Z',
            cooldown_until: '2026-04-17T02:05:00.000Z',
            failure_threshold: 3,
            cooldown_ms: 600000,
            last_failure_reason: 'compact failed'
        });
        const beforeCompact = jest.fn();
        const executeCompact = jest.fn();

        const result = await prepareContextForModel(chatContext, undefined, {
            autoCompactDecisionOverride: createAutoCompactDecision({
                contextWindow: 1000,
                promptTokens: 720,
                reservedSummaryOutput: 100
            }),
            autoCompactState,
            beforeCompact,
            executeCompact
        });

        expect(beforeCompact).not.toHaveBeenCalled();
        expect(executeCompact).not.toHaveBeenCalled();
        expect(result.autoCompactDecision.shouldCompact).toBe(true);
        expect(result.shouldCompact).toBe(false);
        expect(result.compacted).toBe(false);
        expect(result.autoCompactStateChanged).toBe(false);
        expect(result.autoCompactState).toBe(autoCompactState);
        expect(autoCompactState.consecutiveFailures).toBe(3);
        expect(autoCompactState.cooldownUntil).toBe('2026-04-17T02:05:00.000Z');
        expect(autoCompactState.lastFailureReason).toBe('compact failed');
        expect(result.activeContext.messages).toHaveLength(1);
    });

    test('自动 compact 失败时会记录失败次数、失败原因并重新抛错', async () => {
        const now = new Date('2026-04-17T02:00:00.000Z');
        jest.setSystemTime(now);

        const chatContext = createChatContext();
        const autoCompactState = AutoCompactStates.deserialize({
            consecutive_failures: 1,
            failure_threshold: 2,
            cooldown_ms: 60000
        });
        const beforeCompact = jest.fn();
        const executeCompact = jest.fn(() => {
            throw new Error('compact failed');
        });

        await expect(
            prepareContextForModel(chatContext, undefined, {
                autoCompactDecisionOverride: createAutoCompactDecision({
                    contextWindow: 1000,
                    promptTokens: 720,
                    reservedSummaryOutput: 100
                }),
                autoCompactState,
                beforeCompact,
                executeCompact
            })
        ).rejects.toThrow('compact failed');

        expect(beforeCompact).toHaveBeenCalledTimes(1);
        expect(executeCompact).toHaveBeenCalledTimes(1);
        expect(autoCompactState.consecutiveFailures).toBe(2);
        expect(autoCompactState.lastAttemptAt).toBe(now.toISOString());
        expect(autoCompactState.lastFailureAt).toBe(now.toISOString());
        expect(autoCompactState.lastFailureReason).toBe('compact failed');
        expect(autoCompactState.cooldownUntil).toBe('2026-04-17T02:01:00.000Z');
        expect(AutoCompactStates.isCoolingDown(autoCompactState, now)).toBe(true);
    });

    test('自动 compact 返回 no-op 时不会记录为成功 compact', async () => {
        const now = new Date('2026-04-17T02:00:00.000Z');
        jest.setSystemTime(now);

        const chatContext = createChatContext();
        const autoCompactState = AutoCompactStates.deserialize({
            consecutive_failures: 1,
            failure_threshold: 3,
            cooldown_ms: 60000
        });
        const beforeCompact = jest.fn();
        const executeCompact = jest.fn(() => false);

        const result = await prepareContextForModel(chatContext, undefined, {
            autoCompactDecisionOverride: createAutoCompactDecision({
                contextWindow: 1000,
                promptTokens: 720,
                reservedSummaryOutput: 100
            }),
            autoCompactState,
            beforeCompact,
            executeCompact
        });

        expect(beforeCompact).toHaveBeenCalledTimes(1);
        expect(executeCompact).toHaveBeenCalledTimes(1);
        expect(result.shouldCompact).toBe(true);
        expect(result.compacted).toBe(false);
        expect(result.autoCompactStateChanged).toBe(true);
        expect(result.autoCompactState).toBe(autoCompactState);
        expect(autoCompactState.consecutiveFailures).toBe(1);
        expect(autoCompactState.lastAttemptAt).toBe(now.toISOString());
        expect(autoCompactState.lastSuccessAt).toBeUndefined();
        expect(autoCompactState.lastFailureAt).toBeUndefined();
        expect(autoCompactState.lastFailureReason).toBeUndefined();
        expect(autoCompactState.cooldownUntil).toBeUndefined();
        expect(result.activeContext.messages).toHaveLength(1);
    });

    test('自动 compact 默认路径会走 tail-preserving compactContext 并重建 active context', async () => {
        const now = new Date('2026-04-17T02:00:00.000Z');
        jest.setSystemTime(now);

        const chatContext = createCompactableChatContext();
        const autoCompactState = AutoCompactStates.deserialize({
            consecutive_failures: 1,
            failure_threshold: 3,
            cooldown_ms: 60000
        });
        const beforeCompact = jest.fn();
        const askSpy = jest
            .spyOn(LLM, 'ask')
            .mockResolvedValue('<state_snapshot><overall_goal>pipeline compact</overall_goal></state_snapshot>');

        const result = await prepareContextForModel(chatContext, 'demo-model', {
            autoCompactDecisionOverride: createAutoCompactDecision({
                contextWindow: 1000,
                promptTokens: 720,
                reservedSummaryOutput: 100
            }),
            autoCompactState,
            beforeCompact
        });

        expect(beforeCompact).toHaveBeenCalledTimes(1);
        expect(askSpy).toHaveBeenCalledTimes(1);
        expect(result.shouldCompact).toBe(true);
        expect(result.compacted).toBe(true);
        expect(autoCompactState.consecutiveFailures).toBe(0);
        expect(autoCompactState.lastSuccessAt).toBe(now.toISOString());

        const boundary = chatContext.findCompactBoundary();
        expect(boundary).toBeDefined();
        expect(boundary!.message.summary).toContain('pipeline compact');
        expect(boundary!.message.metadata).toMatchObject({
            trigger: 'auto',
            strategy: FULL_COMPACT_BOUNDARY_STRATEGY,
            summarized_messages: 2,
            kept_messages: 8
        });
        expect(result.activeContext.messages[0]).toBe(boundary!.message);
        expect(result.activeContext.messages).toHaveLength(9);
        const tailContainsBoundary = result.activeContext.messages.some(
            (message, index) => index > 0 && isCompactBoundaryMessage(message)
        );
        expect(tailContainsBoundary).toBe(false);
    });

    test('未达到阈值时不会触发自动 compact，也不会改动自动压缩状态', async () => {
        const now = new Date('2026-04-17T02:00:00.000Z');
        jest.setSystemTime(now);

        const chatContext = createChatContext();
        const autoCompactState = AutoCompactStates.deserialize({
            consecutive_failures: 1,
            failure_threshold: 3,
            cooldown_ms: 60000
        });
        const beforeCompact = jest.fn();
        const executeCompact = jest.fn();

        const result = await prepareContextForModel(chatContext, undefined, {
            autoCompactDecisionOverride: createAutoCompactDecision({
                contextWindow: 1000,
                promptTokens: 719,
                reservedSummaryOutput: 100
            }),
            autoCompactState,
            beforeCompact,
            executeCompact
        });

        expect(beforeCompact).not.toHaveBeenCalled();
        expect(executeCompact).not.toHaveBeenCalled();
        expect(result.autoCompactDecision.reason).toBe('below_threshold');
        expect(result.shouldCompact).toBe(false);
        expect(result.compacted).toBe(false);
        expect(result.autoCompactStateChanged).toBe(false);
        expect(autoCompactState.consecutiveFailures).toBe(1);
        expect(autoCompactState.lastAttemptAt).toBeUndefined();
        expect(autoCompactState.lastSuccessAt).toBeUndefined();
        expect(autoCompactState.cooldownUntil).toBeUndefined();
    });
});
