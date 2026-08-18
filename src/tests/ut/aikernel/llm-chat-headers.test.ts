import { jest } from '@jest/globals';
import { OpenAIAdapter } from '../../../main/aikernel/adapters/openai.js';
import { LLM, type LLMRequestOptions } from '../../../main/aikernel/llm.js';
import { ChatContext, UserMessage } from '../../../main/aikernel/messages.js';
import { GlobalHooks } from '../../../main/aikernel/hooks.js';
import { ModelInstance } from '../../../main/utils/setting.js';

describe('LLM beforeChatModelRequest hook coverage', () => {
    afterEach(() => {
        LLM.clearAdapterCache();
        jest.restoreAllMocks();
    });

    test('LLM.ask applies hook-modified options once for each completion request', async () => {
        const onRequest = jest.fn(async (options: LLMRequestOptions) => {
            options.extraHeaders = { ...options.extraHeaders, 'x-plugin': 'ask' };
        });
        const dispose = GlobalHooks.beforeChatModelRequest(async (ctx) => {
            await onRequest(ctx.options);
        });
        try {
            let adapterOptions: LLMRequestOptions | undefined;
            jest.spyOn(OpenAIAdapter.prototype, 'completeText').mockImplementation(
                async (_context, _vision, _options, requestOptions) => {
                    adapterOptions = requestOptions;
                    return 'answer';
                }
            );
            const model = new ModelInstance('gpt-4o', 'https://example.test/v1', 'key', true);

            await LLM.ask('hello', model, {
                extraHeaders: { 'x-caller': 'yes' }
            });

            expect(onRequest).toHaveBeenCalledTimes(1);
            expect(onRequest).toHaveBeenCalledWith(
                expect.objectContaining({ extraHeaders: { 'x-caller': 'yes', 'x-plugin': 'ask' } })
            );
            expect(adapterOptions?.extraHeaders).toEqual({
                'x-caller': 'yes',
                'x-plugin': 'ask'
            });
        } finally {
            dispose();
        }
    });

    test('LLM.complete forwards task and model to beforeChatModelRequest', async () => {
        const received: Array<{ task?: unknown; modelName: string }> = [];
        const task = { task_id: 'task-1' } as never;
        const dispose = GlobalHooks.beforeChatModelRequest(async (ctx) => {
            received.push({ task: ctx.task, modelName: ctx.model.model_name });
            ctx.options.extraHeaders = { ...ctx.options.extraHeaders, 'x-plugin': 'complete' };
            ctx.options.maxCompletionTokens = 123;
        });
        try {
            let adapterOptions: LLMRequestOptions | undefined;
            jest.spyOn(OpenAIAdapter.prototype, 'complete').mockImplementation(
                async (_context, _vision, _options, requestOptions) => {
                    adapterOptions = requestOptions;
                    return { content: [] } as never;
                }
            );
            const context = new ChatContext();
            context.appendMessage(new UserMessage('hello'));
            const model = new ModelInstance('gpt-4o', 'https://example.test/v1', 'key', true);

            await LLM.complete(context, model, {}, { task } as LLMRequestOptions);

            expect(received).toEqual([{ task, modelName: 'gpt-4o' }]);
            expect(adapterOptions?.extraHeaders).toEqual({ 'x-plugin': 'complete' });
            expect(adapterOptions?.maxCompletionTokens).toBe(123);
        } finally {
            dispose();
        }
    });

    test('LLM.streamComplete applies hook once before consuming the stream', async () => {
        const dispose = GlobalHooks.beforeChatModelRequest(async (ctx) => {
            ctx.options.extraHeaders = { 'x-plugin': 'stream' };
        });
        try {
            const observedHeaders: Array<Record<string, string> | undefined> = [];
            jest.spyOn(OpenAIAdapter.prototype, 'streamComplete').mockImplementation(
                async function* (_context, _vision, _options, requestOptions) {
                    observedHeaders.push(requestOptions?.extraHeaders);
                    observedHeaders.push(requestOptions?.extraHeaders);
                    yield { content: [] } as never;
                }
            );
            const context = new ChatContext();
            context.appendMessage(new UserMessage('hello'));
            const model = new ModelInstance('gpt-4o', 'https://example.test/v1', 'key', true);

            for await (const _response of LLM.streamComplete(context, model)) {
                // Drain the mocked stream.
            }

            expect(observedHeaders).toEqual([{ 'x-plugin': 'stream' }, { 'x-plugin': 'stream' }]);
        } finally {
            dispose();
        }
    });
});
