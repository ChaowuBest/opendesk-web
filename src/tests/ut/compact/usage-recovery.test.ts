import { afterEach, describe, expect, jest, test } from '@jest/globals';
import {
    AssistantMessage,
    ChatContext,
    CompactSeparatorMessage,
    ToolCall,
    ToolCallMessagePart,
    Usage,
    UserMessage
} from '../../../main/aikernel/messages.js';
import { buildUsageAnchoredCompactPlans, compactFullContext } from '../../../main/aikernel/compaction/full-compact.js';
import {
    calculateCompactionBudget,
    estimateRequestPayloadTokens
} from '../../../main/aikernel/compaction/request-budget.js';
import {
    estimateAssistantPostUsageVisibleTokens,
    estimateRoughTokensFromChatMessage,
    estimateTextTokens,
    estimateVisibleContextTokens
} from '../../../main/aikernel/compaction/token-estimation.js';
import { buildActiveContextView } from '../../../main/aikernel/compaction/context-view.js';

afterEach(() => jest.restoreAllMocks());

function history() {
    const context = new ChatContext();
    context.appendMessage(new UserMessage('Keep the original goal'));
    const assistant = new AssistantMessage();
    context.appendMessage(assistant);
    for (const [index, tokens] of [1000, 2000, 3000, 6000, 9000].entries()) {
        assistant.beginCompletionRound(false);
        assistant.appendText(`round ${index}` + 'x'.repeat(4000));
        const part = new ToolCallMessagePart();
        const call = new ToolCall(index, `call-${index}`, 'readImage', '{}');
        part.push(call);
        assistant.appendToolCallPart(part);
        assistant.usage = new Usage(tokens - 10, 10, tokens);
        assistant.recordCompletionUsage('model');
        call.status = 'success';
        call.result = `result ${index}`;
    }
    return { context, assistant };
}

describe('usage anchored compaction recovery', () => {
    test.each(['execution metadata', 'migrated legacy timestamp'])(
        'legacy usage without checkpoints uses %s to reject usage before the compact boundary',
        (source) => {
            const context = new ChatContext();
            const boundaryTime = Date.parse('2026-10-10T00:00:00.000Z');
            const boundary = new CompactSeparatorMessage('previous summary', {
                created_at: new Date(boundaryTime).toISOString()
            });
            context.appendMessage(boundary);
            const assistants: AssistantMessage[] = [];
            for (let index = 0; index < 4; index++) {
                const finishedAt = boundaryTime + (index - 1) * 1000;
                const raw = {
                    role: 'assistant',
                    message_id: `legacy-${index}`,
                    content: [{ type: 'text', text: 'history '.repeat(500) }],
                    usage: { prompt_tokens: 2000 + index, completion_tokens: 10, total_tokens: 2010 + index },
                    ...(source === 'execution metadata'
                        ? { metadata: { execution: { startAt: boundaryTime - 1000, finishAt: finishedAt } } }
                        : { timestamp: finishedAt })
                };
                const message = AssistantMessage.assign(raw);
                context.appendMessage(message);
                assistants.push(message);
            }
            const plans = buildUsageAnchoredCompactPlans(context, calculateCompactionBudget(10000), 'model');
            expect(plans.map((plan) => plan.keepAnchor?.messageId)).toEqual(['legacy-2']);
            const estimate = estimateVisibleContextTokens({ activeContext: buildActiveContextView(context) });
            expect(estimate.source).toBe('usage_plus_tail_estimate');
            expect(estimate.baseUsageTokens).toBe(2013);
            context.messages.splice(context.messages.indexOf(assistants[2]));
            expect(buildUsageAnchoredCompactPlans(context, calculateCompactionBudget(10000), 'model')).toHaveLength(0);
            expect(estimateVisibleContextTokens({ activeContext: buildActiveContextView(context) }).source).toBe(
                'rough_estimate_only'
            );
        }
    );
    test('every image costs 1500 tokens regardless of size, model, encoding or detail', () => {
        const payload = (size: number) => [
            { type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(size)}` } }
        ];
        const placeholderTokens = estimateRequestPayloadTokens([{ type: 'image' }]);
        expect(estimateRequestPayloadTokens(payload(100000)) - placeholderTokens).toBe(1500);
        expect(estimateRequestPayloadTokens(payload(10)) - placeholderTokens).toBe(1500);
        const user = new UserMessage();
        user.appendImageURL('https://example.com/image');
        expect(estimateRoughTokensFromChatMessage(user)).toBe(1500);
        user.appendImageURL('data:image/png;base64,AAAA');
        expect(estimateRoughTokensFromChatMessage(user)).toBe(3000);
        expect(
            estimateRequestPayloadTokens([
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
            ]) - placeholderTokens
        ).toBe(1500);
        for (const model of ['gpt-4o', 'gpt-4o-mini', 'claude-sonnet-4', 'unknown']) {
            for (const size of [256, 4096]) {
                const request = {
                    model,
                    content: [
                        {
                            type: 'image_url',
                            image_url: { url: 'https://example.com/image', detail: 'low' },
                            width: size,
                            height: size
                        }
                    ]
                };
                const withoutImage = { model, content: [{ type: 'image' }] };
                expect(estimateRequestPayloadTokens(request) - estimateRequestPayloadTokens(withoutImage)).toBe(1500);
            }
        }
    });
    test('chooses latest eligible real usage and keeps all subsequent tool calls/results', () => {
        const { context } = history();
        const plans = buildUsageAnchoredCompactPlans(context, calculateCompactionBudget(10000), 'model');
        expect(plans[0].keepAnchor?.startPartIndex).toBe(6);
        expect(plans.map((plan) => plan.keepAnchor?.startPartIndex)).toEqual([6, 4, 2, 0]);
        expect(
            plans[0].projectedItemsToKeep
                ?.flatMap((item) => (item.kind === 'assistant_round' ? item.round.parts : []))
                .filter((part) => part.type === 'tool_call')
                .flatMap((part) => part.toolcalls.map((call) => call.result))
        ).toEqual(['result 3', 'result 4']);
    });

    test('budget equality is accepted and checkpoints from another model or compact boundary are excluded', () => {
        const { context, assistant } = history();
        const budget = { ...calculateCompactionBudget(10000), summaryOutputTokens: 500, bufferTokens: 500 };
        expect(buildUsageAnchoredCompactPlans(context, budget, 'model')[0].keepAnchor?.startPartIndex).toBe(8);
        expect(buildUsageAnchoredCompactPlans(context, budget, 'other-model')).toHaveLength(0);
        assistant.usageCheckpoints!.forEach((checkpoint) => {
            checkpoint.boundaryId = 'obsolete';
        });
        expect(buildUsageAnchoredCompactPlans(context, budget, 'model')).toHaveLength(0);
    });

    test('plain text completion checkpoints remain valid boundaries', () => {
        const context = new ChatContext();
        context.appendMessage(new UserMessage('goal'));
        const assistant = new AssistantMessage();
        context.appendMessage(assistant);
        for (let index = 0; index < 3; index++) {
            assistant.beginCompletionRound(false);
            assistant.appendText(`answer ${index}` + 'x'.repeat(6400));
            assistant.usage = new Usage(1000 + index, 10, 1010 + index);
            assistant.recordCompletionUsage('model');
        }
        expect(
            buildUsageAnchoredCompactPlans(context, calculateCompactionBudget(10000), 'model').map(
                (plan) => plan.keepAnchor?.startPartIndex
            )
        ).toEqual([2, 1, 0]);
    });

    test('no eligible real usage falls back to estimated summary input', async () => {
        const { context, assistant } = history();
        assistant.usageCheckpoints!.forEach((checkpoint) => {
            checkpoint.boundaryId = 'obsolete';
        });
        const lastPart = assistant.content.at(-1)!;
        if (lastPart.type !== 'tool_call') throw new Error('missing tool result');
        lastPart.toolcalls[0].result_object = {
            type: 'image',
            images: [{ image_url: 'data:image/png;base64,AAAA' }]
        };
        const generateSummary = jest.fn(async () => 'saved history');
        const result = await compactFullContext(context, 'model', {
            budget: calculateCompactionBudget(10000),
            usageRecovery: { attempts: 0 },
            generateSummary
        });
        expect(result.compacted).toBe(true);
        expect(generateSummary).toHaveBeenCalledTimes(1);
        const estimate = estimateVisibleContextTokens({ activeContext: buildActiveContextView(context) });
        expect(estimate.source).toBe('rough_estimate_only');
        expect(estimate.estimatedContextTokens).toBeGreaterThan(0);
        expect(estimate.estimatedContextTokens).toBeLessThan(9000);
        expect(lastPart.toolcalls[0].getResultImages()).toHaveLength(1);
        lastPart.toolcalls[0].result_object = undefined;
        const withoutImage = estimateVisibleContextTokens({ activeContext: buildActiveContextView(context) });
        expect(estimate.estimatedContextTokens - withoutImage.estimatedContextTokens).toBeGreaterThanOrEqual(1500);
    });

    test('estimated fallback also shrinks on overflow and stops after three attempts', async () => {
        const { context, assistant } = history();
        assistant.usageCheckpoints = [];
        assistant.usage = undefined;
        const inputs: string[] = [];
        await expect(
            compactFullContext(context, 'model', {
                budget: calculateCompactionBudget(10000),
                generateSummary: async ({ summaryText }) => {
                    inputs.push(summaryText);
                    throw new Error('context_length_exceeded');
                }
            })
        ).rejects.toThrow();
        expect(inputs).toHaveLength(3);
        expect(inputs[1].length).toBeLessThan(inputs[0].length);
        expect(inputs[2].length).toBeLessThan(inputs[1].length);
        expect(context.findCompactBoundary()).toBeUndefined();
    });

    test('estimated fallback includes the summary prompt and output reserves in its budget', async () => {
        const { context, assistant } = history();
        assistant.usageCheckpoints = [];
        assistant.usage = undefined;
        const generateSummary = jest.fn(async () => 'unused');
        await expect(
            compactFullContext(context, 'model', {
                budget: calculateCompactionBudget(10000),
                prompt: 'x'.repeat(50000),
                generateSummary
            })
        ).rejects.toMatchObject({ code: 'no_safe_usage_boundary' });
        expect(generateSummary).not.toHaveBeenCalled();
    });

    test('cancellation never retries a summary or replaces the existing context', async () => {
        const { context } = history();
        let current = true;
        const generateSummary = jest.fn(async () => {
            current = false;
            throw new Error('maximum context length exceeded');
        });
        await expect(
            compactFullContext(context, 'model', {
                budget: calculateCompactionBudget(10000),
                usageRecovery: { attempts: 0 },
                isCurrent: () => current,
                generateSummary
            })
        ).rejects.toMatchObject({ code: 'cancelled' });
        expect(generateSummary).toHaveBeenCalledTimes(1);
        expect(context.findCompactBoundary()).toBeUndefined();
    });

    test('images already included in a newer usage are not charged as new increments', () => {
        const { assistant } = history();
        const oldPart = assistant.content[1];
        if (oldPart.type !== 'tool_call') throw new Error('missing call');
        const before = estimateAssistantPostUsageVisibleTokens(assistant);
        oldPart.toolcalls[0].result_object = { type: 'image', images: [{ image_url: 'data:image/png;base64,AAAA' }] };
        expect(estimateAssistantPostUsageVisibleTokens(assistant)).toBe(before);
    });

    test('context limit retries use strictly smaller summary input, at most three attempts', async () => {
        const { context } = history();
        const inputs: string[] = [];
        const generateSummary = jest.fn(async ({ summaryText }: { summaryText: string }) => {
            inputs.push(summaryText);
            throw new Error('maximum context length exceeded');
        });
        await expect(
            compactFullContext(context, 'model', {
                budget: calculateCompactionBudget(10000),
                usageRecovery: { attempts: 0 },
                generateSummary
            })
        ).rejects.toThrow();
        expect(inputs).toHaveLength(3);
        expect(inputs[1].length).toBeLessThan(inputs[0].length);
        expect(inputs[2].length).toBeLessThan(inputs[1].length);
        expect(context.findCompactBoundary()).toBeUndefined();
    });

    test('a normal summary that overflows switches to an earlier usage boundary', async () => {
        const context = new ChatContext();
        for (let index = 0; index < 5; index++) {
            context.appendMessage(new UserMessage(`goal ${index}`));
            const assistant = new AssistantMessage();
            assistant.appendText(`history ${index} ` + 'detail '.repeat(1000));
            assistant.usage = new Usage(1000 * (index + 1), 10, 1000 * (index + 1) + 10);
            context.appendMessage(assistant);
        }
        const inputs: string[] = [];
        const result = await compactFullContext(context, 'model', {
            budget: calculateCompactionBudget(10000),
            generateSummary: async ({ summaryText }) => {
                inputs.push(summaryText);
                if (inputs.length === 1) throw new Error('maximum context length exceeded');
                return 'summary';
            }
        });
        expect(result.compacted).toBe(true);
        expect(inputs).toHaveLength(2);
        expect(inputs[1].length).toBeLessThan(inputs[0].length);
    });

    test('successful retry preserves image results and serializable usage checkpoints', async () => {
        const { context, assistant } = history();
        const last = assistant.content.at(-1)!;
        if (last.type !== 'tool_call') throw new Error('missing call');
        last.toolcalls[0].result_object = { type: 'image', images: [{ image_url: 'data:image/png;base64,AAAA' }] };
        let calls = 0;
        const result = await compactFullContext(context, 'model', {
            budget: calculateCompactionBudget(10000),
            usageRecovery: { attempts: 0 },
            generateSummary: async () => {
                if (++calls === 1) throw new Error('context_length_exceeded');
                return 'Goal and completed work';
            }
        });
        expect(result.compacted).toBe(true);
        expect(buildActiveContextView(context).messages).toContain(assistant);
        expect(last.toolcalls[0].getResultImages()).toHaveLength(1);
        expect(AssistantMessage.assign(JSON.parse(JSON.stringify(assistant))).usageCheckpoints).toHaveLength(5);
    });

    test('image increment after usage is counted even when text is replaced', () => {
        const { assistant } = history();
        const part = assistant.content.at(-1)!;
        if (part.type !== 'tool_call') throw new Error('missing call');
        const call = part.toolcalls[0];
        call.ensureResultStorage({ result_id: 'image-result' });
        const overrides = new Map([['image-result', 'preview']]);
        const before = estimateAssistantPostUsageVisibleTokens(assistant, overrides);
        call.result_object = { type: 'image', images: [1, 2].map(() => ({ image_url: 'data:image/png;base64,AAAA' })) };
        const imageIncrement = 3000 + estimateTextTokens(JSON.stringify([{}, {}]));
        expect(estimateAssistantPostUsageVisibleTokens(assistant, overrides) - before).toBe(imageIncrement);
        expect(
            estimateVisibleContextTokens({ messages: [assistant], toolResultOverrides: overrides })
                .estimatedContextTokens
        ).toBe(9000 + before + imageIncrement);
    });
});
