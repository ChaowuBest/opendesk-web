import fs from 'fs';
import os from 'os';
import path from 'path';
import { jest } from '@jest/globals';
import { AutoCompactStates, createAutoCompactDecision } from '../../../main/aikernel/compaction/auto-compact';
import { MicrocompactStates } from '../../../main/aikernel/compaction/microcompact-state';
import { FULL_COMPACT_BOUNDARY_STRATEGY } from '../../../main/aikernel/compaction/full-compact';
import { prepareContextForModel } from '../../../main/aikernel/compaction/pipeline';
import { estimateVisibleContextTokens } from '../../../main/aikernel/compaction/token-estimation';
import { ToolResultReplacementStates } from '../../../main/aikernel/compaction/tool-results';
import { OpenAIAdapter } from '../../../main/aikernel/adapters/openai';
import { LLM } from '../../../main/aikernel/llm';
import {
    AssistantMessage,
    ChatContext,
    ToolCall,
    ToolCallMessagePart,
    SystemMessage,
    Usage,
    UserMessage,
    isCompactBoundaryMessage
} from '../../../main/aikernel/messages';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks';
import { setCustomOpendeskDirectory } from '../../../main/utils/setting';

let tempRootDir: string | undefined;

function createTempAppDirectory(): string {
    tempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-compaction-pipeline-'));
    setCustomOpendeskDirectory(tempRootDir);
    return tempRootDir;
}

function cleanupTempAppDirectory(): void {
    if (tempRootDir && fs.existsSync(tempRootDir)) {
        fs.rmSync(tempRootDir, { recursive: true, force: true });
    }
    tempRootDir = undefined;
}

function createChatContext(): ChatContext {
    const chatContext = new ChatContext();
    chatContext.appendMessage(new UserMessage('hello'));
    return chatContext;
}

function createForcedCompactDecision(estimatedContextTokens = 720) {
    return createAutoCompactDecision({
        contextWindow: 1000,
        promptTokens: estimatedContextTokens,
        reservedSummaryOutput: 100,
        buffer: 180
    });
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

function appendAssistantRound(message: AssistantMessage, roundLabel: string): void {
    message.appendReasoningContent(`reasoning ${roundLabel}`);
    message.appendText(`assistant ${roundLabel}`);

    const toolCall = new ToolCall(0, `tool-${roundLabel}`, 'demo_tool', `{"round":"${roundLabel}"}`);
    toolCall.status = 'success';
    toolCall.result = `result ${roundLabel}`;

    const part = new ToolCallMessagePart();
    part.push(toolCall);
    message.appendToolCallPart(part);
}

function createLargeAssistantMessage(): AssistantMessage {
    const message = new AssistantMessage();
    appendAssistantRound(message, 'old-round-1');
    appendAssistantRound(message, 'old-round-2');
    appendAssistantRound(message, 'old-round-3');
    appendAssistantRound(message, 'recent-round-4');
    return message;
}

function createAssistantWithUsageAndLargeToolResult(
    totalTokens: number,
    result: string
): { message: AssistantMessage; toolCall: ToolCall } {
    const message = new AssistantMessage();
    message.appendText('assistant prepared a large tool result');
    message.usage = new Usage(totalTokens, 0, totalTokens);

    const toolCall = new ToolCall(0, 'tool-visible-budget', 'executePowerShell', '{"command":"Get-Content build.log"}');
    toolCall.status = 'success';
    toolCall.result = result;

    const part = new ToolCallMessagePart();
    part.push(toolCall);
    message.appendToolCallPart(part);

    return { message, toolCall };
}

function createAssistantWithCompactableToolResult(
    toolIdSuffix: string,
    result: string,
    toolName: string = 'executePowerShell'
): { message: AssistantMessage; toolCall: ToolCall } {
    const message = new AssistantMessage();
    message.appendText(`assistant ${toolIdSuffix}`);

    const toolCall = new ToolCall(0, `tool-${toolIdSuffix}`, toolName, `{"command":"echo ${toolIdSuffix}"}`);
    toolCall.status = 'success';
    toolCall.result = result;

    const part = new ToolCallMessagePart();
    part.push(toolCall);
    message.appendToolCallPart(part);

    return { message, toolCall };
}

function createMicrocompactableChatContext(): {
    chatContext: ChatContext;
    toolCalls: {
        old1: ToolCall;
        old2: ToolCall;
        recent: ToolCall;
    };
} {
    const chatContext = new ChatContext();
    chatContext.appendMessage(new UserMessage('run several tools'));

    const old1 = createAssistantWithCompactableToolResult('old-1', 'old result 1 '.repeat(80));
    const old2 = createAssistantWithCompactableToolResult('old-2', 'old result 2 '.repeat(80));
    const recent = createAssistantWithCompactableToolResult('recent', 'recent result should stay visible');
    chatContext.appendMessage(old1.message);
    chatContext.appendMessage(old2.message);
    chatContext.appendMessage(recent.message);

    return {
        chatContext,
        toolCalls: {
            old1: old1.toolCall,
            old2: old2.toolCall,
            recent: recent.toolCall
        }
    };
}

function createManyMicrocompactableChatContext(oldResultCount: number): {
    chatContext: ChatContext;
    oldToolCalls: ToolCall[];
    recentToolCall: ToolCall;
} {
    const chatContext = new ChatContext();
    chatContext.appendMessage(new UserMessage('run many tools'));

    const oldToolCalls: ToolCall[] = [];
    for (let index = 1; index <= oldResultCount; index++) {
        const old = createAssistantWithCompactableToolResult(`old-${index}`, `old result ${index} `.repeat(80));
        chatContext.appendMessage(old.message);
        oldToolCalls.push(old.toolCall);
    }

    const recent = createAssistantWithCompactableToolResult('recent', 'recent result should stay visible');
    chatContext.appendMessage(recent.message);

    return {
        chatContext,
        oldToolCalls,
        recentToolCall: recent.toolCall
    };
}

function createStep4AndStep5ChatContext(): {
    chatContext: ChatContext;
    toolCalls: {
        oldBudgeted: ToolCall;
        oldMicrocompactOnly: ToolCall;
        recent: ToolCall;
    };
} {
    const chatContext = new ChatContext();
    chatContext.appendMessage(new UserMessage('run several tools with mixed budgets'));

    const oldBudgeted = createAssistantWithCompactableToolResult('old-budgeted', `HEAD\n${'x'.repeat(12_000)}\nTAIL`);
    const oldMicrocompactOnly = createAssistantWithCompactableToolResult(
        'old-microcompact-only',
        'mid result '.repeat(140)
    );
    const recent = createAssistantWithCompactableToolResult('recent', 'recent result should stay visible');
    chatContext.appendMessage(oldBudgeted.message);
    chatContext.appendMessage(oldMicrocompactOnly.message);
    chatContext.appendMessage(recent.message);

    return {
        chatContext,
        toolCalls: {
            oldBudgeted: oldBudgeted.toolCall,
            oldMicrocompactOnly: oldMicrocompactOnly.toolCall,
            recent: recent.toolCall
        }
    };
}

describe('压缩 pipeline 的自动压缩状态流', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.restoreAllMocks();
        jest.useRealTimers();
        cleanupTempAppDirectory();
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
            autoCompactDecisionOverride: createForcedCompactDecision(),
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
            autoCompactDecisionOverride: createForcedCompactDecision(),
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
                autoCompactDecisionOverride: createForcedCompactDecision(),
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
            autoCompactDecisionOverride: createForcedCompactDecision(),
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
        const requestOptions = {
            extraHeaders: {
                cookie: 'session=demo',
                trace_id: 'trace-demo'
            }
        };

        const result = await prepareContextForModel(chatContext, 'demo-model', {
            autoCompactDecisionOverride: createForcedCompactDecision(),
            autoCompactState,
            beforeCompact,
            requestOptions
        });

        expect(beforeCompact).toHaveBeenCalledTimes(1);
        expect(askSpy).toHaveBeenCalledTimes(1);
        expect(askSpy.mock.calls[0]?.[2]).toMatchObject({
            extraHeaders: requestOptions.extraHeaders
        });
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

    test('step 9 pipeline fallback full compact defaults to assistant round boundary', async () => {
        const now = new Date('2026-04-27T00:00:00.000Z');
        jest.setSystemTime(now);

        const chatContext = new ChatContext();
        const bigAssistant = createLargeAssistantMessage();
        chatContext.appendMessage(new UserMessage('user 0'));
        appendAssistantMessage(chatContext, 'assistant 0');
        chatContext.appendMessage(new UserMessage('user 1'));
        chatContext.appendMessage(bigAssistant);
        chatContext.appendMessage(new UserMessage('user 2'));
        appendAssistantMessage(chatContext, 'assistant 2');
        chatContext.appendMessage(new UserMessage('user 3'));
        appendAssistantMessage(chatContext, 'assistant 3');
        chatContext.appendMessage(new UserMessage('user 4'));
        appendAssistantMessage(chatContext, 'assistant 4');

        const askSpy = jest
            .spyOn(LLM, 'ask')
            .mockResolvedValue('<state_snapshot><overall_goal>step9 pipeline default</overall_goal></state_snapshot>');

        const result = await prepareContextForModel(chatContext, 'demo-model', {
            autoCompactDecisionOverride: createForcedCompactDecision(),
            autoCompactState: AutoCompactStates.create()
        });

        expect(askSpy).toHaveBeenCalledTimes(1);
        expect(result.compacted).toBe(true);
        expect(result.activeContext.leadingPartialAssistant).toMatchObject({
            message: bigAssistant,
            roundRef: {
                assistantMessageId: bigAssistant.message_id,
                roundIndex: 1,
                startPartIndex: 3,
                endPartIndexExclusive: 6
            }
        });
        expect(chatContext.findCompactBoundary()?.message.metadata).toMatchObject({
            strategy: FULL_COMPACT_BOUNDARY_STRATEGY,
            kept_anchor_message_id: bigAssistant.message_id,
            kept_anchor_round_index: 1,
            kept_anchor_start_part_index: 3
        });

        const serialized = JSON.stringify(OpenAIAdapter.buildMessages(chatContext, false));
        expect(serialized).not.toContain('old-round-1');
        expect(serialized).toContain('old-round-2');
        expect(serialized).toContain('old-round-3');
        expect(serialized).toContain('recent-round-4');
    });

    test('step 9 pipeline fallback full compact can roll back to message-granularity with false', async () => {
        const now = new Date('2026-04-27T00:00:00.000Z');
        jest.setSystemTime(now);

        const chatContext = new ChatContext();
        const bigAssistant = createLargeAssistantMessage();
        chatContext.appendMessage(new UserMessage('user 0'));
        appendAssistantMessage(chatContext, 'assistant 0');
        chatContext.appendMessage(new UserMessage('user 1'));
        chatContext.appendMessage(bigAssistant);
        chatContext.appendMessage(new UserMessage('user 2'));
        appendAssistantMessage(chatContext, 'assistant 2');
        chatContext.appendMessage(new UserMessage('user 3'));
        appendAssistantMessage(chatContext, 'assistant 3');
        chatContext.appendMessage(new UserMessage('user 4'));
        appendAssistantMessage(chatContext, 'assistant 4');

        const askSpy = jest
            .spyOn(LLM, 'ask')
            .mockResolvedValue('<state_snapshot><overall_goal>step9 pipeline rollback</overall_goal></state_snapshot>');

        const result = await prepareContextForModel(chatContext, 'demo-model', {
            autoCompactDecisionOverride: createForcedCompactDecision(),
            autoCompactState: AutoCompactStates.create(),
            enableAssistantRoundBoundary: false
        });

        expect(askSpy).toHaveBeenCalledTimes(1);
        expect(result.compacted).toBe(true);
        expect(result.activeContext.leadingPartialAssistant).toBeUndefined();
        expect(chatContext.findCompactBoundary()?.message.metadata.kept_anchor_message_id).toBeUndefined();
        expect(chatContext.findCompactBoundary()?.message.metadata.kept_anchor_round_index).toBeUndefined();
        expect(chatContext.findCompactBoundary()?.message.metadata.kept_anchor_start_part_index).toBeUndefined();

        const serialized = JSON.stringify(OpenAIAdapter.buildMessages(chatContext, false));
        expect(serialized).toContain('old-round-1');
        expect(serialized).toContain('old-round-2');
        expect(serialized).toContain('old-round-3');
        expect(serialized).toContain('recent-round-4');
    });

    test('自动压缩决策会使用 Step 4 预算后的可见工具结果 preview', async () => {
        createTempAppDirectory();
        const chatContext = new ChatContext();
        chatContext.appendMessage(new UserMessage('inspect the latest build output'));
        const largeResult = `HEAD\n${'x'.repeat(80_000)}\nTAIL`;
        const { message } = createAssistantWithUsageAndLargeToolResult(90_000, largeResult);
        chatContext.appendMessage(message);

        const rawEstimate = estimateVisibleContextTokens({
            activeContext: {
                startIndex: 0,
                messages: chatContext.messages
            }
        });

        const result = await prepareContextForModel(chatContext, 'gpt-4o', {
            taskId: 'task-pipeline-visible-budget',
            enableToolResultBudget: true,
            toolResultBudgetChars: 1_000,
            toolResultReplacementState: ToolResultReplacementStates.create()
        });

        expect(rawEstimate.estimatedContextTokens).toBeGreaterThan(result.autoCompactDecision.autoCompactThreshold);
        expect(result.contextTokenEstimate.estimatedContextTokens).toBeLessThan(
            result.autoCompactDecision.autoCompactThreshold
        );
        expect(result.autoCompactDecision.shouldCompact).toBe(false);
        expect(result.shouldCompact).toBe(false);
        expect(result.compacted).toBe(false);
        expect(result.autoCompactDecision.tokenEstimateSource).toBe('usage_plus_tail_estimate');
        expect(result.toolResultOverrides.size).toBe(1);
        expect(result.contextTokenEstimate.assistantInternalTailTokens).toBeLessThan(
            rawEstimate.assistantInternalTailTokens
        );
    });

    test('prepareContextForModel 会把 system_prompt 计入自动压缩预算', async () => {
        const chatContext = new ChatContext();
        chatContext.system_prompt = new SystemMessage('system prompt '.repeat(400));
        chatContext.appendMessage(new UserMessage('inspect the latest build output'));
        const assistant = new AssistantMessage();
        assistant.appendText('plain answer without usage');
        chatContext.appendMessage(assistant);

        const expectedEstimate = estimateVisibleContextTokens({
            activeContext: {
                startIndex: 0,
                messages: chatContext.messages
            },
            systemPrompt: chatContext.system_prompt
        });

        const result = await prepareContextForModel(chatContext, undefined, {
            autoCompactDecisionOverride: createAutoCompactDecision({
                contextWindow: 10_000,
                estimatedContextTokens: 1,
                reservedSummaryOutput: 0,
                buffer: 0
            })
        });

        expect(result.contextTokenEstimate).toMatchObject(expectedEstimate);
        expect(result.shouldCompact).toBe(false);
        expect(result.compacted).toBe(false);
    });

    test('Phase 2: pre_submit_check 和 view_only 只做 microcompact analysis，不产生本地副作用', async () => {
        const { chatContext, toolCalls } = createMicrocompactableChatContext();

        const preSubmit = await prepareContextForModel(chatContext, undefined, {
            taskId: 'task-pre-submit-microcompact',
            enableMicrocompact: true,
            microcompactRequestKind: 'pre_submit_check',
            microcompactTaskRole: 'main',
            microcompactTailAssistantMessages: 1,
            autoCompactDecisionOverride: createForcedCompactDecision(0)
        });

        expect(preSubmit.microcompactAnalysis?.candidates.map((candidate) => candidate.toolCall.id)).toEqual([
            'tool-old-1',
            'tool-old-2'
        ]);
        expect(preSubmit.microcompactDecision).toMatchObject({
            mode: 'noop',
            reason: 'pre_submit_check'
        });
        expect(preSubmit.microcompactApplied).toBe(false);
        expect(preSubmit.microcompactAppliedCandidates).toHaveLength(0);
        expect(toolCalls.old1.microcompact).toBeUndefined();
        expect(toolCalls.old2.microcompact).toBeUndefined();
        expect(toolCalls.old1.result).toContain('old result 1');
        expect(toolCalls.old2.result).toContain('old result 2');

        const viewOnly = await prepareContextForModel(chatContext, undefined, {
            taskId: 'task-view-only-microcompact',
            enableMicrocompact: true,
            microcompactRequestKind: 'view_only',
            microcompactTaskRole: 'main',
            microcompactTailAssistantMessages: 1,
            autoCompactDecisionOverride: createForcedCompactDecision(0)
        });

        expect(viewOnly.microcompactAnalysis?.candidates.map((candidate) => candidate.toolCall.id)).toEqual([
            'tool-old-1',
            'tool-old-2'
        ]);
        expect(viewOnly.microcompactDecision).toMatchObject({
            mode: 'noop',
            reason: 'view_only'
        });
        expect(viewOnly.microcompactApplied).toBe(false);
        expect(viewOnly.microcompactAppliedCandidates).toHaveLength(0);
        expect(toolCalls.recent.result).toBe('recent result should stay visible');
    });

    test('Phase 2: subtask 的 task_turn 默认不执行副作用型 microcompact', async () => {
        const { chatContext, toolCalls } = createMicrocompactableChatContext();

        const result = await prepareContextForModel(chatContext, undefined, {
            taskId: 'task-subtask-microcompact',
            enableMicrocompact: true,
            microcompactRequestKind: 'task_turn',
            microcompactTaskRole: 'subtask',
            microcompactTailAssistantMessages: 1,
            autoCompactDecisionOverride: createForcedCompactDecision(0)
        });

        expect(result.microcompactAnalysis?.candidates.map((candidate) => candidate.toolCall.id)).toEqual([
            'tool-old-1',
            'tool-old-2'
        ]);
        expect(result.microcompactDecision).toMatchObject({
            mode: 'noop',
            reason: 'subtask_skipped'
        });
        expect(result.microcompactApplied).toBe(false);
        expect(result.microcompactAppliedCandidates).toHaveLength(0);
        expect(toolCalls.old1.microcompact).toBeUndefined();
        expect(toolCalls.old2.microcompact).toBeUndefined();
        expect(toolCalls.old1.result).toContain('old result 1');
        expect(toolCalls.old2.result).toContain('old result 2');
    });

    test('Phase 4: main task_turn 在暖路径下默认走 request_override，不改原始结果并记录 microcompact state', async () => {
        const now = new Date('2026-05-05T01:00:00.000Z');
        jest.setSystemTime(now);

        const { chatContext, toolCalls } = createMicrocompactableChatContext();
        const rawEstimate = estimateVisibleContextTokens({
            activeContext: {
                startIndex: 0,
                messages: chatContext.messages
            }
        });

        const result = await prepareContextForModel(chatContext, undefined, {
            taskId: 'task-main-task-turn-microcompact',
            enableMicrocompact: true,
            microcompactRequestKind: 'task_turn',
            microcompactTaskRole: 'main',
            microcompactTailAssistantMessages: 1,
            microcompactState: MicrocompactStates.deserialize({
                version: 1,
                last_assistant_completed_at: '2026-05-05T00:30:00.000Z'
            }),
            autoCompactDecisionOverride: createForcedCompactDecision(0)
        });

        expect(result.microcompactDecision).toMatchObject({
            mode: 'request_override',
            reason: 'warm_path_request_override'
        });
        expect(result.microcompactDecision?.idleGapMinutes).toBe(30);
        expect(result.microcompactDecision?.selectedResultIds).toHaveLength(2);
        expect(result.microcompactApplied).toBe(true);
        expect(result.toolResultOverrides.size).toBe(2);
        expect(result.microcompactAppliedCandidates.map((candidate) => candidate.toolCall.id)).toEqual([
            'tool-old-1',
            'tool-old-2'
        ]);
        expect(result.microcompactStateChanged).toBe(true);
        expect(result.microcompactState).toMatchObject({
            lastDecisionAt: now.toISOString(),
            lastDecisionMode: 'request_override'
        });
        expect(result.microcompactState?.lastLocalClearAt).toBeUndefined();
        expect(result.microcompactState?.lastLocalClearResultIds).toBeUndefined();
        expect(toolCalls.old1.result).toContain('old result 1');
        expect(toolCalls.old2.result).toContain('old result 2');
        expect(toolCalls.old1.microcompact).toBeUndefined();
        expect(toolCalls.old2.microcompact).toBeUndefined();
        expect(toolCalls.old1.result_storage?.replacement_text).toBeUndefined();
        expect(toolCalls.old2.result_storage?.replacement_text).toBeUndefined();
        expect(toolCalls.old1.result_storage?.result_id).toBeDefined();
        expect(toolCalls.old2.result_storage?.result_id).toBeDefined();
        expect(result.contextTokenEstimate.estimatedContextTokens).toBeLessThan(rawEstimate.estimatedContextTokens);

        const messages = OpenAIAdapter.buildMessages(chatContext, false, {
            activeContext: result.activeContext,
            toolResultOverrides: result.toolResultOverrides
        });
        const serialized = JSON.stringify(messages);
        expect(serialized).toContain('[旧工具结果已被 microcompact 清理');
        expect(serialized).not.toContain('old result 1 old result 1 old result 1');
        expect(serialized).not.toContain('old result 2 old result 2 old result 2');
    });

    test('Phase 5: idle gap 达到冷路径阈值后才会 local_clear，且保留最近 5 个结果', async () => {
        const now = new Date('2026-05-05T02:01:00.000Z');
        jest.setSystemTime(now);

        const { chatContext, oldToolCalls, recentToolCall } = createManyMicrocompactableChatContext(7);

        const result = await prepareContextForModel(chatContext, undefined, {
            taskId: 'task-main-task-turn-cold-path',
            enableMicrocompact: true,
            microcompactRequestKind: 'task_turn',
            microcompactTaskRole: 'main',
            microcompactTailAssistantMessages: 1,
            microcompactState: MicrocompactStates.deserialize({
                version: 1,
                last_assistant_completed_at: '2026-05-05T01:00:00.000Z'
            }),
            autoCompactDecisionOverride: createForcedCompactDecision(0)
        });

        expect(result.microcompactDecision).toMatchObject({
            mode: 'local_clear',
            reason: 'cold_path_local_clear',
            idleGapMinutes: 61
        });
        expect(result.microcompactDecision?.selectedResultIds).toHaveLength(2);
        expect(result.microcompactDecision?.keptRecentResultIds).toHaveLength(5);
        expect(result.microcompactApplied).toBe(true);
        expect(result.toolResultOverrides.size).toBe(0);
        expect(result.microcompactAppliedCandidates.map((candidate) => candidate.toolCall.id)).toEqual([
            'tool-old-1',
            'tool-old-2'
        ]);
        expect(result.microcompactState).toMatchObject({
            lastDecisionAt: now.toISOString(),
            lastDecisionMode: 'local_clear',
            lastLocalClearAt: now.toISOString(),
            lastLocalClearResultIds: result.microcompactDecision?.selectedResultIds
        });

        expect(oldToolCalls[0].result).toContain('[旧工具结果已被 microcompact 清理');
        expect(oldToolCalls[1].result).toContain('[旧工具结果已被 microcompact 清理');
        expect(oldToolCalls[0].microcompact?.strategy).toBe('local_clear');
        expect(oldToolCalls[1].microcompact?.strategy).toBe('local_clear');

        for (const toolCall of oldToolCalls.slice(2)) {
            expect(toolCall.result).toContain('old result');
            expect(toolCall.microcompact).toBeUndefined();
        }
        expect(recentToolCall.result).toBe('recent result should stay visible');
        expect(recentToolCall.microcompact).toBeUndefined();
    });

    test('Phase 4: local_clear 仍可通过 mode override 触发', async () => {
        const now = new Date('2026-05-04T04:00:00.000Z');
        jest.setSystemTime(now);

        const { chatContext, toolCalls } = createMicrocompactableChatContext();

        const result = await prepareContextForModel(chatContext, undefined, {
            taskId: 'task-main-task-turn-local-clear',
            enableMicrocompact: true,
            microcompactRequestKind: 'task_turn',
            microcompactTaskRole: 'main',
            microcompactModeOverride: 'local_clear',
            microcompactTailAssistantMessages: 1,
            microcompactState: MicrocompactStates.create(),
            autoCompactDecisionOverride: createForcedCompactDecision(0)
        });

        expect(result.microcompactDecision).toMatchObject({
            mode: 'local_clear',
            reason: 'mode_override'
        });
        expect(result.microcompactAppliedCandidates.map((candidate) => candidate.toolCall.id)).toEqual([
            'tool-old-1',
            'tool-old-2'
        ]);
        expect(result.microcompactState).toMatchObject({
            lastDecisionAt: now.toISOString(),
            lastDecisionMode: 'local_clear',
            lastLocalClearAt: now.toISOString(),
            lastLocalClearResultIds: result.microcompactDecision?.selectedResultIds
        });
        expect(toolCalls.old1.result).toContain('[旧工具结果已被 microcompact 清理');
        expect(toolCalls.old2.result).toContain('[旧工具结果已被 microcompact 清理');
        expect(toolCalls.old1.microcompact?.strategy).toBe('local_clear');
        expect(toolCalls.old2.microcompact?.strategy).toBe('local_clear');
    });

    test('Phase 4: Step 4 与 Step 5 override 会合并，且 Step 5 不污染 replacement state', async () => {
        createTempAppDirectory();
        const { chatContext, toolCalls } = createStep4AndStep5ChatContext();
        const replacementState = ToolResultReplacementStates.create();

        const result = await prepareContextForModel(chatContext, undefined, {
            taskId: 'task-step4-step5-merge',
            enableToolResultBudget: true,
            toolResultBudgetChars: 2_500,
            toolResultReplacementState: replacementState,
            enableMicrocompact: true,
            microcompactRequestKind: 'task_turn',
            microcompactTaskRole: 'main',
            microcompactTailAssistantMessages: 1,
            microcompactState: MicrocompactStates.create(),
            autoCompactDecisionOverride: createForcedCompactDecision(0)
        });

        const oldBudgetedResultId = toolCalls.oldBudgeted.result_storage?.result_id;
        const oldMicrocompactOnlyResultId = toolCalls.oldMicrocompactOnly.result_storage?.result_id;

        expect(result.microcompactDecision).toMatchObject({
            mode: 'request_override',
            reason: 'warm_path_request_override'
        });
        expect(result.microcompactDecision?.selectedResultIds).toHaveLength(2);
        expect(result.microcompactStats).toMatchObject({
            appliedCount: 1,
            skippedByOverrideCount: 1
        });
        expect(result.toolResultOverrides.size).toBe(2);
        expect(oldBudgetedResultId).toBeDefined();
        expect(oldMicrocompactOnlyResultId).toBeDefined();
        expect(result.toolResultOverrides.get(oldBudgetedResultId!)).toBe(
            toolCalls.oldBudgeted.result_storage?.replacement_text
        );
        expect(result.toolResultOverrides.get(oldMicrocompactOnlyResultId!)).toContain(
            '[旧工具结果已被 microcompact 清理'
        );
        expect(result.toolResultReplacementState?.replacements.has(oldBudgetedResultId!)).toBe(true);
        expect(result.toolResultReplacementState?.replacements.has(oldMicrocompactOnlyResultId!)).toBe(false);
        expect(toolCalls.oldBudgeted.result).toContain('HEAD');
        expect(toolCalls.oldMicrocompactOnly.result).toContain('mid result');
        expect(toolCalls.oldMicrocompactOnly.result_storage?.replacement_text).toBeUndefined();
        expect(toolCalls.oldBudgeted.microcompact).toBeUndefined();
        expect(toolCalls.oldMicrocompactOnly.microcompact).toBeUndefined();
        expect(result.microcompactAppliedCandidates.map((candidate) => candidate.toolCall.id)).toEqual([
            'tool-old-microcompact-only'
        ]);
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
            autoCompactDecisionOverride: createForcedCompactDecision(719),
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

    test('TailCard sections stay out of active context and enter only the request projection', async () => {
        const task = new TaskState(new TaskManagerState());
        task.chat_context = createCompactableChatContext();
        task.setFrontendTailCardSection('knowledge-mode', 'opaque request-only prompt');

        const activeResult = await prepareContextForModel(task.chat_context, undefined, {
            autoCompactDecisionOverride: createForcedCompactDecision(0)
        });
        const withoutTail = JSON.stringify(
            OpenAIAdapter.buildMessages(task.chat_context, false, {
                activeContext: activeResult.activeContext
            })
        );
        expect(withoutTail).not.toContain('opaque request-only prompt');

        const requestTailText = await task.hooks.buildTailcards(task, {
            activeContext: activeResult.activeContext,
            chatContext: task.chat_context,
            requestType: 'streamComplete'
        });
        const withTail = JSON.stringify(
            OpenAIAdapter.buildMessages(task.chat_context, false, {
                activeContext: activeResult.activeContext,
                requestTailText
            })
        );
        expect(withTail).toContain('opaque request-only prompt');
        expect(JSON.stringify(task.chat_context.toJSON())).not.toContain('opaque request-only prompt');
    });
});
