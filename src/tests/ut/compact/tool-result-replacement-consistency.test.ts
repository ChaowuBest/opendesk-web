import { describe, expect, test } from '@jest/globals';
import { OpenAIAdapter } from '../../../main/aikernel/adapters/openai.js';
import { AnthropicAdapter } from '../../../main/aikernel/adapters/anthropic.js';
import { buildRequestChatContext } from '../../../main/aikernel/adapters/context.js';
import {
    AssistantMessage,
    ChatContext,
    ToolCall,
    ToolCallMessagePart,
    UserMessage
} from '../../../main/aikernel/messages.js';
import {
    buildFullCompactPlan,
    buildFullCompactSummaryText,
    compactFullContext
} from '../../../main/aikernel/compaction/full-compact.js';
import { estimateRoughTokensFromToolCall } from '../../../main/aikernel/compaction/token-estimation.js';
import { calculateCompactionBudget } from '../../../main/aikernel/compaction/request-budget.js';
import { prepareContextForModel } from '../../../main/aikernel/compaction/pipeline.js';
import { serializeActiveContextForSessionMemory } from '../../../main/aikernel/compaction/session-memory-compact.js';
import { buildActiveContextView } from '../../../main/aikernel/compaction/context-view.js';

const artifactPath = 'C:/test/artifacts/tool-results/web-result.txt';
const replacement = `网页摘要 ${'preview '.repeat(240)}\n完整输出已保存至: ${artifactPath}\n若需完整内容请通过读文件方式获取。`;

function history(persistReplacement = true) {
    const context = new ChatContext();
    context.appendMessage(new UserMessage('original goal ' + 'history '.repeat(1200)));
    const calls: ToolCall[] = [];
    for (let index = 0; index < 4; index++) {
        const assistant = new AssistantMessage();
        const call = new ToolCall(index, `call-${index}`, 'web_search', '{}');
        call.status = 'success';
        call.result = `RAW_WEB_RESULT_${index} ` + '原文'.repeat(50000);
        call.setResultStorage({
            result_id: `result-${index}`,
            relative_path: `tool-results/web-${index}.txt`,
            ...(persistReplacement ? { replacement_text: replacement } : {})
        });
        const part = new ToolCallMessagePart();
        part.push(call);
        assistant.appendToolCallPart(part);
        context.appendMessage(assistant);
        calls.push(call);
    }
    const overrides = new Map(calls.map((call) => [call.result_storage!.result_id, replacement]));
    return { context, calls, overrides };
}

describe('consistent model-visible tool results', () => {
    test.each(['persisted', 'runtime override'] as const)(
        '%s is used by both adapters and request snapshots',
        (source) => {
            const { context, calls, overrides } = history();
            const text = source === 'persisted' ? replacement : replacement + '\nruntime replacement';
            if (source === 'runtime override') {
                for (const id of overrides.keys()) overrides.set(id, text);
            }
            const options = source === 'persisted' ? {} : { toolResultOverrides: overrides };
            // Persisted metadata must survive JSON restoration, without reading artifacts back into history.
            const restored = ChatContext.assign(JSON.parse(JSON.stringify(context)));
            for (const request of [
                OpenAIAdapter.buildMessages(restored, true, options),
                AnthropicAdapter.buildMessages(restored, true, options),
                OpenAIAdapter.buildMessages(buildRequestChatContext(restored, options))
            ]) {
                const serialized = JSON.stringify(request);
                expect(serialized.includes(source === 'persisted' ? '网页摘要' : 'runtime replacement')).toBe(true);
                expect(serialized.includes(artifactPath)).toBe(true);
                expect(serialized.includes('RAW_WEB_RESULT')).toBe(false);
            }
            expect(calls[0].result).toContain('RAW_WEB_RESULT');
            expect(restored.messages).toHaveLength(context.messages.length);
        }
    );

    test('rough estimates use persisted previews and runtime replacements with the same priority as adapters', () => {
        const { calls, overrides } = history();
        const call = calls[0];
        const persistedTokens = estimateRoughTokensFromToolCall(call);
        expect(persistedTokens).toBe(estimateRoughTokensFromToolCall(call, { toolResultOverrides: overrides }));
        overrides.set(call.result_storage!.result_id, 'short');
        expect(estimateRoughTokensFromToolCall(call, { toolResultOverrides: overrides })).toBeLessThan(persistedTokens);
    });

    test('tail planning makes the same choice with persisted and request-local replacements', () => {
        const persisted = history();
        const runtime = history(false);
        const storedPlan = buildFullCompactPlan(persisted.context, { contextWindow: 10000 });
        const runtimePlan = buildFullCompactPlan(runtime.context, {
            contextWindow: 10000,
            toolResultOverrides: runtime.overrides
        });
        expect(storedPlan).toBeDefined();
        expect(runtimePlan?.keepStartIndex).toBe(storedPlan?.keepStartIndex);
        expect(runtimePlan?.keptStats.toolCalls).toBe(storedPlan?.keptStats.toolCalls);
    });

    test('legacy compressed results keep their precedence, and ordinary results remain visible', () => {
        const { context, calls, overrides } = history();
        for (const call of calls) call.compress_id = 'legacy-result';
        const options = { toolResultOverrides: overrides };
        const legacyText = calls[0].getLegacyCompressedResultText();
        for (const payload of [
            OpenAIAdapter.buildMessages(context, true, options),
            AnthropicAdapter.buildMessages(context, true, options)
        ]) {
            const serialized = JSON.stringify(payload);
            expect(serialized.includes(legacyText)).toBe(true);
            expect(serialized.includes('网页摘要')).toBe(false);
        }
        const call = calls[0];
        call.compress_id = undefined;
        call.clearResultStorage();
        call.result = 'ordinary result';
        expect(JSON.stringify(OpenAIAdapter.buildMessages(context)).includes('ordinary result')).toBe(true);
    });

    test.each([true, false])('summary uses short results and keeps artifact references (persisted=%s)', (persisted) => {
        const { context, overrides } = history(persisted);
        const options = persisted ? {} : { toolResultOverrides: overrides };
        const plan = buildFullCompactPlan(context, { contextWindow: 10000, ...options })!;
        const summary = buildFullCompactSummaryText(plan, options);
        expect(summary).toContain('网页摘要');
        expect(summary).toContain(artifactPath);
        expect(summary).not.toContain('RAW_WEB_RESULT');
    });

    test.each([true, false])(
        'candidate budget checks use replacements without mutating originals (persisted=%s)',
        async (persisted) => {
            const { context, calls, overrides } = history(persisted);
            const originals = calls.map((call) => call.result);
            const result = await compactFullContext(context, undefined, {
                budget: calculateCompactionBudget(10000),
                toolResultOverrides: overrides,
                generateSummary: async () => 'saved history'
            });
            expect(result.compacted).toBe(true);
            expect(calls.map((call) => call.result)).toEqual(originals);
        }
    );

    test.each([true, false])(
        'session memory input also keeps replacements and artifact paths (persisted=%s)',
        (persisted) => {
            const { context, overrides } = history(persisted);
            const transcript = serializeActiveContextForSessionMemory(buildActiveContextView(context), {
                ...(persisted ? {} : { toolResultOverrides: overrides }),
                toolResultPreviewChars: 30
            });
            expect(transcript.includes('网页摘要')).toBe(true);
            expect(transcript.includes(artifactPath)).toBe(true);
            expect(transcript.includes('RAW_WEB_RESULT')).toBe(false);
        }
    );

    test('automatic compaction receives the prepared replacements', async () => {
        const { context, overrides } = history(false);
        const replacements = new Map(
            Array.from(overrides, ([result_id, replacement_text]) => [result_id, { result_id, replacement_text }])
        );
        let received: Map<string, string> | undefined;
        await prepareContextForModel(context, undefined, {
            forceCompact: true,
            taskId: 'test-replacement-consistency',
            enableToolResultBudget: true,
            toolResultReplacementState: { seenIds: new Set(overrides.keys()), replacements },
            executeCompact: (toolResultOverrides) => {
                received = toolResultOverrides;
                return false;
            }
        });
        expect(received).toEqual(overrides);
    });
});
