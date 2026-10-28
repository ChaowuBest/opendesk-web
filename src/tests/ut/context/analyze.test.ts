import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { createAutoCompactDecision } from '../../../main/aikernel/compaction/auto-compact';
import { buildProjectedActiveContextView } from '../../../main/aikernel/compaction/context-view';
import { buildAssistantRounds } from '../../../main/aikernel/compaction/assistant-rounds';
import { ToolResultReplacementStates } from '../../../main/aikernel/compaction/tool-results';
import { estimateSystemPromptTokens } from '../../../main/aikernel/compaction/token-estimation';
import { estimateTextTokens } from '../../../utils/token-estimation';
import { analyzeContextDiagnostics } from '../../../main/aikernel/context/analyze';
import { inspectContextForDiagnostics } from '../../../main/aikernel/context/inspect';
import {
    AssistantMessage,
    ChatContext,
    CompactSeparatorMessage,
    SystemMessage,
    ToolCall,
    ToolCallMessagePart,
    UserMessage
} from '../../../main/aikernel/messages';
import { BaseTool, BaseToolset } from '../../../main/aikernel/tool';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks';
import { OpenAIAdapter } from '../../../main/aikernel/adapters/openai.js';

const fixturePath = fileURLToPath(new URL('./fixtures/task-sample.json', import.meta.url));

function loadFixtureSystemPrompt(): SystemMessage {
    return TaskState.load(fixturePath, new TaskManagerState()).chat_context.system_prompt!;
}

function createAnalysisChatContext(): {
    chatContext: ChatContext;
    toolCall: ToolCall;
    toolResultText: string;
} {
    const chatContext = new ChatContext();
    chatContext.system_prompt = loadFixtureSystemPrompt();

    const toolset = new BaseToolset('demo');
    toolset.addTool(new BaseTool('search', 'search files in the workspace', z.object({ query: z.string() })));
    chatContext.attachToolsets(toolset);

    chatContext.appendMessage(new UserMessage('hello world'));

    const assistant = new AssistantMessage();
    assistant.appendReasoningContent('thinking');
    assistant.appendText('answer');

    const part = new ToolCallMessagePart();
    const toolCall = new ToolCall(0, 'tool-call-1', 'search', '{"query":"context"}');
    toolCall.status = 'success';
    toolCall.result = 'tool result body';
    toolCall.ensureResultStorage({ result_id: 'result-1' });
    part.push(toolCall);
    assistant.appendToolCallPart(part);
    assistant.appendText('tail');
    assistant.usage = {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120
    } as any;

    chatContext.appendMessage(assistant);

    return {
        chatContext,
        toolCall,
        toolResultText: 'tool result body'
    };
}

function createMultiToolsetChatContext(): ChatContext {
    const chatContext = new ChatContext();
    chatContext.system_prompt = loadFixtureSystemPrompt();

    const alpha = new BaseToolset('alpha');
    alpha.addTool(new BaseTool('fetch', 'fetch data', z.object({ path: z.string() })));
    const beta = new BaseToolset('beta');
    beta.addTool(new BaseTool('summarize', 'summarize data', z.object({ text: z.string() })));
    chatContext.attachToolsets(alpha, beta);

    const assistant = new AssistantMessage();
    assistant.appendText('first');

    const part1 = new ToolCallMessagePart();
    const call1 = new ToolCall(0, 'tool-call-1', 'fetch', '{"path":"a"}');
    call1.status = 'success';
    call1.result = 'alpha-result';
    call1.ensureResultStorage({ result_id: 'alpha-result-id' });
    part1.push(call1);
    assistant.appendToolCallPart(part1);
    assistant.appendReasoningContent('after alpha');

    const part2 = new ToolCallMessagePart();
    const call2 = new ToolCall(1, 'tool-call-2', 'summarize', '{"text":"b"}');
    call2.status = 'success';
    call2.result = 'beta-result';
    call2.ensureResultStorage({ result_id: 'beta-result-id' });
    part2.push(call2);
    assistant.appendToolCallPart(part2);
    assistant.appendText('tail');
    assistant.usage = {
        prompt_tokens: 200,
        completion_tokens: 50,
        total_tokens: 250
    } as any;

    chatContext.appendMessage(new UserMessage('before assistant'));
    chatContext.appendMessage(assistant);
    return chatContext;
}

function createBoundaryChatContext(): ChatContext {
    const chatContext = new ChatContext();
    chatContext.system_prompt = loadFixtureSystemPrompt();
    chatContext.appendMessage(new UserMessage('before boundary'));
    chatContext.appendMessage(
        new CompactSeparatorMessage('compact summary for diagnostics', {
            boundary_id: 'boundary-diagnostics',
            created_at: '2026-05-08T00:00:00.000Z'
        })
    );
    chatContext.appendMessage(new UserMessage('after boundary'));
    return chatContext;
}

function createBudgetChatContext(): { chatContext: ChatContext; resultId: string; rawResult: string } {
    const chatContext = new ChatContext();
    chatContext.system_prompt = loadFixtureSystemPrompt();
    chatContext.appendMessage(new UserMessage('budget check'));

    const assistant = new AssistantMessage();
    assistant.appendText('prepare large tool result');

    const part = new ToolCallMessagePart();
    const rawResult = 'x'.repeat(8_000);
    const toolCall = new ToolCall(0, 'tool-call-budget', 'search', '{"query":"large result"}');
    toolCall.status = 'success';
    toolCall.result = rawResult;
    toolCall.ensureResultStorage({ result_id: 'result-budget' });
    part.push(toolCall);
    assistant.appendToolCallPart(part);
    chatContext.appendMessage(assistant);

    return { chatContext, resultId: 'result-budget', rawResult };
}

describe('context diagnostics analysis', () => {
    test('builds a structured report with system prompt, tools, messages, and projected rounds', async () => {
        const { chatContext } = createAnalysisChatContext();
        const inspection = await inspectContextForDiagnostics(chatContext, 'demo-model', {
            taskId: 'task-analyze-basic',
            autoCompactDecisionOverride: createAutoCompactDecision({
                contextWindow: 10_000,
                estimatedContextTokens: 1_000,
                reservedSummaryOutput: 100,
                buffer: 0
            })
        });

        const report = analyzeContextDiagnostics({
            chatContext,
            inspection,
            modelName: 'demo-model'
        });

        expect(report.modelName).toBe('demo-model');
        expect(report.contextWindow).toBe(10_000);
        expect(report.totalEstimatedTokens).toBe(inspection.contextTokenEstimate.estimatedContextTokens);
        expect(report.categories.map((category) => category.name)).toEqual([
            'System prompt',
            'Tools',
            'Messages',
            'Free space'
        ]);
        expect(report.categories[0].tokens).toBe(estimateSystemPromptTokens(chatContext.system_prompt));
        expect(report.categories[1].tokens).toBeGreaterThan(0);
        expect(report.toolsetCategories.map((category) => category.name)).toEqual(['demo']);
        expect(report.toolsetCategories[0].toolCount).toBe(1);
        expect(report.categories[2].tokens).toBe(
            report.messageBreakdown.userTextTokens +
                report.messageBreakdown.userFileTokens +
                report.messageBreakdown.userImageTokens +
                report.messageBreakdown.assistantTextTokens +
                report.messageBreakdown.assistantReasoningTokens +
                report.messageBreakdown.assistantToolCallTokens +
                report.messageBreakdown.assistantToolResultTokens +
                report.messageBreakdown.compactBoundaryTokens
        );
        expect(report.categories[3].tokens).toBe(Math.max(report.contextWindow - report.totalEstimatedTokens, 0));
        expect(report.messageBreakdown.userTextTokens).toBe(estimateTextTokens('hello world'));
        expect(report.messageBreakdown.assistantReasoningTokens).toBe(estimateTextTokens('thinking'));
        expect(report.messageBreakdown.assistantTextTokens).toBe(
            estimateTextTokens('answer') + estimateTextTokens('tail')
        );
        expect(report.messageBreakdown.assistantToolResultTokens).toBe(estimateTextTokens('tool result body'));
        expect(report.messageBreakdown.assistantToolCallTokens).toBeGreaterThan(0);
        expect(report.activeContext).toEqual({
            startIndex: 0,
            hasCompactBoundary: false,
            leadingPartialAssistant: false,
            projectedItemCount: buildProjectedActiveContextView(chatContext).projectedItems.length
        });
        expect(report.assistantRounds).toHaveLength(2);
        expect(report.assistantRounds[0]).toMatchObject({
            messageIndex: 1,
            roundIndex: 0,
            kind: 'tool_call_batch',
            startPartIndex: 0,
            endPartIndexExclusive: 3,
            toolCallCount: 1
        });
        expect(report.assistantRounds[1]).toMatchObject({
            messageIndex: 1,
            roundIndex: 1,
            kind: 'message_tail',
            startPartIndex: 3,
            endPartIndexExclusive: 4,
            toolCallCount: 0
        });
        expect(report.contextTokenEstimate).toMatchObject({
            estimatedContextTokens: inspection.contextTokenEstimate.estimatedContextTokens,
            baseUsageTokens: 120,
            tailEstimatedTokens: inspection.contextTokenEstimate.tailEstimatedTokens,
            assistantInternalTailTokens: inspection.contextTokenEstimate.assistantInternalTailTokens,
            source: inspection.contextTokenEstimate.source
        });
        expect(report.compaction.autoCompactDecision.shouldCompact).toBe(false);
    });

    test('exposes toolset categories and assistant round details', async () => {
        const chatContext = createMultiToolsetChatContext();
        const inspection = await inspectContextForDiagnostics(chatContext, 'demo-model', {
            taskId: 'task-analyze-multitoolset',
            autoCompactDecisionOverride: createAutoCompactDecision({
                contextWindow: 10_000,
                estimatedContextTokens: 2_000,
                reservedSummaryOutput: 100,
                buffer: 0
            })
        });

        const report = analyzeContextDiagnostics({
            chatContext,
            inspection,
            modelName: 'demo-model'
        });

        expect(report.toolsetCategories.map((category) => category.name)).toEqual(['alpha', 'beta']);
        expect(report.toolsetCategories.map((category) => category.toolCount)).toEqual([1, 1]);
        expect(report.toolsetCategories.every((category) => category.tokens > 0)).toBe(true);
        expect(report.assistantRounds.length).toBe(
            buildAssistantRounds(chatContext.messages[1] as AssistantMessage).length
        );
        expect(report.assistantRounds[0]).toMatchObject({
            messageIndex: 1,
            roundIndex: 0,
            kind: 'tool_call_batch',
            startPartIndex: 0,
            endPartIndexExclusive: 2,
            toolCallCount: 1
        });
        expect(report.assistantRounds[1]).toMatchObject({
            messageIndex: 1,
            roundIndex: 1,
            kind: 'tool_call_batch',
            startPartIndex: 2,
            endPartIndexExclusive: 4,
            toolCallCount: 1
        });
        expect(report.assistantRounds[2]).toMatchObject({
            messageIndex: 1,
            roundIndex: 2,
            kind: 'message_tail',
            startPartIndex: 4,
            endPartIndexExclusive: 5,
            toolCallCount: 0
        });
        expect(report.contextTokenEstimate).toMatchObject({
            estimatedContextTokens: inspection.contextTokenEstimate.estimatedContextTokens,
            baseUsageTokens: inspection.contextTokenEstimate.baseUsageTokens,
            tailEstimatedTokens: inspection.contextTokenEstimate.tailEstimatedTokens,
            assistantInternalTailTokens: inspection.contextTokenEstimate.assistantInternalTailTokens,
            source: inspection.contextTokenEstimate.source
        });
    });

    test('counts compact boundaries and projected visible items', async () => {
        const chatContext = createBoundaryChatContext();
        const inspection = await inspectContextForDiagnostics(chatContext, undefined, {
            taskId: 'task-analyze-boundary',
            autoCompactDecisionOverride: createAutoCompactDecision({
                contextWindow: 5_000,
                estimatedContextTokens: 500,
                reservedSummaryOutput: 100,
                buffer: 0
            })
        });

        const report = analyzeContextDiagnostics({
            chatContext,
            inspection
        });

        expect(report.activeContext.hasCompactBoundary).toBe(true);
        expect(report.activeContext.startIndex).toBe(1);
        expect(report.messageBreakdown.compactBoundaryTokens).toBe(
            estimateTextTokens('compact summary for diagnostics')
        );
        expect(report.messageBreakdown.userTextTokens).toBe(estimateTextTokens('after boundary'));
        expect(report.activeContext.projectedItemCount).toBe(
            buildProjectedActiveContextView(chatContext).projectedItems.length
        );
    });

    test('uses tool result overrides from inspection when a large result is budgeted', async () => {
        const { chatContext, resultId, rawResult } = createBudgetChatContext();
        const replacementState = ToolResultReplacementStates.create();

        const inspection = await inspectContextForDiagnostics(chatContext, undefined, {
            taskId: 'task-analyze-budget',
            autoCompactDecisionOverride: createAutoCompactDecision({
                contextWindow: 10_000,
                estimatedContextTokens: 1_000,
                reservedSummaryOutput: 100,
                buffer: 0
            }),
            enableToolResultBudget: true,
            toolResultBudgetChars: 100,
            toolResultReplacementState: replacementState
        });

        const overrideText = inspection.toolResultOverrides.get(resultId);
        expect(overrideText).toBeDefined();

        const report = analyzeContextDiagnostics({
            chatContext,
            inspection
        });

        expect(report.compaction.toolResultBudgetStats).toBeDefined();
        expect(report.messageBreakdown.assistantToolResultTokens).toBe(estimateTextTokens(overrideText));
        expect(report.messageBreakdown.assistantToolResultTokens).toBeLessThan(estimateTextTokens(rawResult));
        expect(report.totalEstimatedTokens).toBe(inspection.contextTokenEstimate.estimatedContextTokens);
    });

    test.each(['success', 'error'] as const)(
        'restored %s results use persisted replacements without request overrides',
        async (status) => {
            const { chatContext, toolCall } = createAnalysisChatContext();
            const replacementText = 'Persisted replacement preview for restored tasks';
            toolCall.status = status;
            toolCall.result = 'RAW_RESTORED_RESULT '.repeat(1_000);
            toolCall.ensureResultStorage({
                relative_path: 'artifacts/restored/tool-results/result-1.txt',
                replacement_text: replacementText
            });
            const restored = ChatContext.assign(JSON.parse(JSON.stringify(chatContext.toJSON())));
            const before = JSON.stringify(restored);
            const inspection = await inspectContextForDiagnostics(restored, undefined, {
                enableToolResultBudget: false
            });
            expect(inspection.toolResultOverrides.size).toBe(0);

            const report = analyzeContextDiagnostics({ chatContext: restored, inspection });
            const payload = OpenAIAdapter.buildMessages(restored) as Array<{ role: string; content: string }>;
            expect(payload.find((message) => message.role === 'tool')?.content).toBe(replacementText);
            expect(report.messageBreakdown.assistantToolResultTokens).toBe(estimateTextTokens(replacementText));
            expect(JSON.stringify(restored)).toBe(before);
        }
    );

    test.each(['', 'request-local replacement'])(
        'resolves override %j before persisted replacements',
        async (override) => {
            const { chatContext, toolCall } = createAnalysisChatContext();
            const persistedText = 'Persisted preview '.repeat(50);
            toolCall.ensureResultStorage({ replacement_text: persistedText });
            const inspection = await inspectContextForDiagnostics(chatContext, undefined, {
                enableToolResultBudget: false
            });
            inspection.toolResultOverrides.set(toolCall.result_storage!.result_id, override);
            const expected = override || persistedText;

            const report = analyzeContextDiagnostics({ chatContext, inspection });
            const payload = OpenAIAdapter.buildMessages(chatContext, true, {
                toolResultOverrides: inspection.toolResultOverrides
            }) as Array<{ role: string; content: string }>;
            expect(payload.find((message) => message.role === 'tool')?.content).toBe(expected);
            expect(report.messageBreakdown.assistantToolResultTokens).toBe(estimateTextTokens(expected));
        }
    );

    test('legacy compression takes precedence over both runtime and persisted replacements', async () => {
        const { chatContext, toolCall } = createAnalysisChatContext();
        toolCall.compress_id = 'legacy-diagnostic-result';
        toolCall.ensureResultStorage({ replacement_text: 'Persisted preview '.repeat(50) });
        const inspection = await inspectContextForDiagnostics(chatContext, undefined, {
            enableToolResultBudget: false
        });
        inspection.toolResultOverrides.set(toolCall.result_storage!.result_id, 'Runtime preview '.repeat(200));

        const report = analyzeContextDiagnostics({ chatContext, inspection });
        const payload = OpenAIAdapter.buildMessages(chatContext, true, {
            toolResultOverrides: inspection.toolResultOverrides
        }) as Array<{ role: string; content: string }>;
        const expected = toolCall.getLegacyCompressedResultText();
        expect(payload.find((message) => message.role === 'tool')?.content).toBe(expected);
        expect(report.messageBreakdown.assistantToolResultTokens).toBe(estimateTextTokens(expected));
    });

    test('keeps model estimate details for threshold reporting', async () => {
        const { chatContext } = createAnalysisChatContext();
        const inspection = await inspectContextForDiagnostics(chatContext, 'demo-model', {
            taskId: 'task-analyze-estimate-details',
            autoCompactDecisionOverride: createAutoCompactDecision({
                contextWindow: 10_000,
                estimatedContextTokens: 8_500,
                reservedSummaryOutput: 100,
                buffer: 250
            })
        });

        const report = analyzeContextDiagnostics({
            chatContext,
            inspection,
            modelName: 'demo-model'
        });

        expect(report.contextTokenEstimate.usageAnchorMessageId).toBeDefined();
        expect(report.contextTokenEstimate.baseUsageTokens).toBeGreaterThan(0);
        expect(report.compaction.autoCompactDecision.reservedSummaryOutput).toBe(100);
        expect(report.compaction.autoCompactDecision.buffer).toBe(250);
        expect(report.compaction.autoCompactDecision.autoCompactThreshold).toBe(8_000);
        expect(report.compaction.autoCompactDecision.effectiveWindow).toBe(9_900);
        expect(report.compaction.autoCompactDecision.windowUsageRatio).toBeDefined();
    });
});
