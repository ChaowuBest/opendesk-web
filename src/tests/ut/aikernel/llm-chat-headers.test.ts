import { jest } from '@jest/globals';
import { OpenAIAdapter } from '../../../main/aikernel/adapters/openai.js';
import { LLM, type LLMRequestOptions } from '../../../main/aikernel/llm.js';
import { ChatContext, UserMessage } from '../../../main/aikernel/messages.js';
import { GlobalHooks } from '../../../main/aikernel/hooks.js';
import { ModelInstance } from '../../../main/utils/setting.js';

describe('LLM chat.headers hook coverage', () => {
    afterEach(() => {
        LLM.clearAdapterCache();
        jest.restoreAllMocks();
    });

    test('LLM.ask resolves chat headers once for each completion request', async () => {
        const chatHeaders = jest.fn(async (_input, headers: Record<string, string> = {}) => ({
            ...headers,
            'x-plugin': 'ask'
        }));
        const dispose = GlobalHooks.registerChatHeaders(async (input, output) => {
            output.headers = await chatHeaders(input, output.headers);
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

            expect(chatHeaders).toHaveBeenCalledTimes(1);
            expect(chatHeaders).toHaveBeenCalledWith({ modelAlias: 'gpt-4o' }, { 'x-caller': 'yes' });
            expect(adapterOptions?.extraHeaders).toEqual({
                'x-caller': 'yes',
                'x-plugin': 'ask'
            });
        } finally {
            dispose();
        }
    });

    test('LLM.complete forwards task plugin context to chat.headers', async () => {
        const chatHeaders = jest.fn(async (_input, headers: Record<string, string> = {}) => ({
            ...headers,
            'x-plugin': 'complete',
            'x-instrumentation': 'plugin'
        }));
        const dispose = GlobalHooks.registerChatHeaders(async (input, output) => {
            output.headers = await chatHeaders(input, output.headers);
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

            await LLM.complete(context, model, {}, {
                hookContext: {
                    taskId: 'task-1',
                    workspace: '/workspace',
                    modelAlias: 'model-alias'
                },
                extraHeaderOverrides: {
                    'x-instrumentation': 'instrumentation'
                }
            } as LLMRequestOptions);

            expect(chatHeaders).toHaveBeenCalledTimes(1);
            expect(chatHeaders).toHaveBeenCalledWith(
                {
                    taskId: 'task-1',
                    workspace: '/workspace',
                    modelAlias: 'model-alias'
                },
                {}
            );
            expect(adapterOptions?.extraHeaders).toEqual({
                'x-plugin': 'complete',
                'x-instrumentation': 'instrumentation'
            });
        } finally {
            dispose();
        }
    });

    test('LLM.streamComplete resolves chat headers once before consuming the stream', async () => {
        const chatHeaders = jest.fn(async (_input, headers: Record<string, string> = {}) => ({
            ...headers,
            'x-plugin': 'stream'
        }));
        const dispose = GlobalHooks.registerChatHeaders(async (input, output) => {
            output.headers = await chatHeaders(input, output.headers);
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

            expect(chatHeaders).toHaveBeenCalledTimes(1);
            expect(observedHeaders).toEqual([{ 'x-plugin': 'stream' }, { 'x-plugin': 'stream' }]);
        } finally {
            dispose();
        }
    });
});
