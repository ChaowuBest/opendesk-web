import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { AnthropicAdapter } from '../../../main/aikernel/adapters/anthropic.js';
import { OpenAIAdapter } from '../../../main/aikernel/adapters/openai.js';
import { ChatContext, UserMessage } from '../../../main/aikernel/messages.js';
import { estimateRequestPayloadTokens } from '../../../main/aikernel/compaction/request-budget.js';
import { ModelInstance } from '../../../main/utils/setting.js';

afterEach(() => jest.restoreAllMocks());

describe.each(['openai', 'anthropic'] as const)('%s final output budget', (provider) => {
    function createRequest(inputEstimate: number, outputLimit?: number, tailText?: string) {
        const model = new ModelInstance('budget-test-model', 'https://example.com', 'test-key', true);
        model.max_output_tokens = 384000;
        const context = new ChatContext();
        context.appendMessage(new UserMessage('hello'));
        const adapter = provider === 'openai' ? new OpenAIAdapter(model) : new AnthropicAdapter(model);
        const send = jest.fn(async function* (_body: object) {});
        if (adapter instanceof OpenAIAdapter) {
            (adapter as any).client = { chat: { completions: { create: send } } };
        } else {
            jest.spyOn(adapter as any, 'streamMessages').mockImplementation(send);
        }
        const options = { requestTailText: tailText };
        const payload =
            provider === 'openai'
                ? {
                      messages: OpenAIAdapter.buildMessages(context, false, options),
                      ...OpenAIAdapter.buildToolOptions(context)
                  }
                : {
                      ...AnthropicAdapter.buildMessages(context, false, options),
                      ...AnthropicAdapter.buildToolOptions(context)
                  };
        const stream = adapter.streamComplete(context, false, options, {
            ...(outputLimit === undefined ? {} : { maxCompletionTokens: outputLimit }),
            contextBudget: { window: 512000, inputEstimate }
        });
        return { stream, send, payload };
    }

    test.each([undefined, 384000])('fits a large output limit %s to the remaining window', async (outputLimit) => {
        const { stream, send } = createRequest(300000, outputLimit);
        for await (const _chunk of stream) {
            // The mocked transport produces no response chunks.
        }
        expect(send).toHaveBeenCalledTimes(1);
        expect(send.mock.calls[0][0]).toMatchObject(
            provider === 'openai' ? { max_completion_tokens: 202000 } : { max_tokens: 202000 }
        );
    });

    test.each([undefined, 4096])('preserves an output limit %s that already fits', async (outputLimit) => {
        const { stream, send } = createRequest(20000, outputLimit);
        for await (const _chunk of stream) {
            // The mocked transport produces no response chunks.
        }
        expect(send).toHaveBeenCalledTimes(1);
        const output = outputLimit ?? 384000;
        expect(send.mock.calls[0][0]).toMatchObject(
            provider === 'openai' ? { max_completion_tokens: output } : { max_tokens: output }
        );
    });

    test('uses the final payload when tail text exceeds the earlier input estimate', async () => {
        const { stream, send, payload } = createRequest(300000, 384000, 'x'.repeat(1400000));
        const finalInput = estimateRequestPayloadTokens(payload);
        expect(finalInput).toBeGreaterThan(300000);
        for await (const _chunk of stream) {
            // The mocked transport produces no response chunks.
        }
        expect(send).toHaveBeenCalledTimes(1);
        const body = send.mock.calls[0][0] as Record<string, number>;
        const output = provider === 'openai' ? body.max_completion_tokens : body.max_tokens;
        expect(finalInput + output + 10000).toBe(512000);
    });

    test('rejects an input that leaves no room for even one output token', async () => {
        const { stream, send } = createRequest(502000);
        await expect(stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'context_limit' });
        expect(send).not.toHaveBeenCalled();
    });
});
