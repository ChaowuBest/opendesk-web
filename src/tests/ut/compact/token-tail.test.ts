import { describe, expect, test } from '@jest/globals';
import {
    AssistantMessage,
    ChatContext,
    ToolCall,
    ToolCallMessagePart,
    Usage,
    UserMessage
} from '../../../main/aikernel/messages.js';
import {
    buildTokenBudgetCompactPlan,
    buildUsageAnchoredCompactPlans
} from '../../../main/aikernel/compaction/full-compact.js';
import { calculateCompactionBudget } from '../../../main/aikernel/compaction/request-budget.js';

function contextFor(sizes: number[]) {
    const context = new ChatContext();
    context.appendMessage(new UserMessage('old history '.repeat(10000)));
    for (const size of [...sizes].reverse()) {
        const assistant = new AssistantMessage();
        const part = new ToolCallMessagePart();
        const call = new ToolCall(0, `call-${context.messages.length}`, '', '');
        call.status = 'success';
        call.result = 'x'.repeat((size - 1) * 4);
        call.result_object = {};
        part.push(call);
        assistant.appendToolCallPart(part);
        context.appendMessage(assistant);
    }
    return context;
}

describe('token-budget tail protection', () => {
    test.each([
        [[1400, 500], 2],
        [[300, 500, 1700], 2],
        [[1600, 200], 1],
        [[1500, 100], 1],
        [[1400, 600], 2],
        [[2500, 100], 1]
    ])('keeps complete rounds for newest-first sizes %j', (sizes, count) => {
        const plan = buildTokenBudgetCompactPlan(contextFor(sizes as number[]), 10000);
        expect(plan?.messagesToKeep).toHaveLength(count as number);
        expect(plan?.projectedItemsToSummarize?.length).toBeGreaterThan(0);
    });

    test('latest tool call remains protected with all following user/text content', () => {
        const context = contextFor([2500, 500]);
        context.appendMessage(new UserMessage('follow-up '.repeat(100)));
        const assistant = new AssistantMessage();
        assistant.appendText('response');
        context.appendMessage(assistant);
        expect(buildTokenBudgetCompactPlan(context, 10000)?.messagesToKeep).toHaveLength(3);
    });

    test('images contribute 1500 tokens to tail selection', () => {
        const context = contextFor([10, 200]);
        const assistant = context.lastMessage() as AssistantMessage;
        const part = assistant.content[0] as ToolCallMessagePart;
        part.toolcalls[0].result_object = { type: 'image', images: [{ image_url: 'data:image/png;base64,AAAA' }] };
        expect(buildTokenBudgetCompactPlan(context, 10000)?.messagesToKeep).toHaveLength(1);
    });

    test('never splits tool batches belonging to the same successful completion', () => {
        const context = contextFor([1400, 1600]);
        const earlier = context.messages[1] as AssistantMessage;
        const latest = context.messages[2] as AssistantMessage;
        earlier.content.push(...latest.content);
        earlier.usageCheckpoints = [{ startPartIndex: 0, endPartIndex: 2, usage: new Usage(1000, 10, 1010) }];
        context.messages.pop();
        const plan = buildTokenBudgetCompactPlan(context, 10000);
        expect(plan?.projectedItemsToKeep).toHaveLength(2);
        expect(plan?.keptStats.toolCalls).toBe(2);
    });

    test('short contexts remain intact; an invalid window does not select a boundary', () => {
        const context = new ChatContext();
        context.appendMessage(new UserMessage('short'));
        expect(buildTokenBudgetCompactPlan(context, 10000)).toBeUndefined();
        expect(buildTokenBudgetCompactPlan(context, 0)).toBeUndefined();
    });

    test('usage recovery starts before the desired tail, then permits earlier boundaries beyond 20 percent', () => {
        const context = contextFor([1400, 500, 1700]);
        for (const message of context.messages) {
            if (message instanceof AssistantMessage) message.usage = new Usage(6000, 10, 6010);
        }
        const plans = buildUsageAnchoredCompactPlans(context, calculateCompactionBudget(10000));
        expect(plans[0].messagesToKeep).toHaveLength(2);
        expect(plans[1].messagesToKeep).toHaveLength(3);
        const secondNewest = context.messages[2] as AssistantMessage;
        secondNewest.usage = new Usage(9500, 10, 9510);
        expect(
            buildUsageAnchoredCompactPlans(context, calculateCompactionBudget(10000))[0].messagesToKeep
        ).toHaveLength(3);
    });
});
