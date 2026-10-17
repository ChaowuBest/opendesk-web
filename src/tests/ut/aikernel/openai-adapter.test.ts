import { jest } from '@jest/globals';
import { OpenAIAdapter } from '../../../main/aikernel/adapters/openai';
import { ChatContext, UserMessage } from '../../../main/aikernel/messages';
import { ModelInstance } from '../../../main/utils/setting';

function createChatContext(): ChatContext {
    const chatContext = new ChatContext();
    chatContext.appendMessage(new UserMessage('hello'));
    return chatContext;
}

function createAdapterWithCompletionResponse(response: unknown): OpenAIAdapter {
    const adapter = new OpenAIAdapter(new ModelInstance('demo-model', 'http://127.0.0.1/v1', 'test-key', true));
    (adapter as any).client = {
        chat: {
            completions: {
                create: jest.fn(async () => response)
            }
        }
    };
    return adapter;
}

function createAdapterWithModelInstance(response: unknown, modelInstance: ModelInstance): OpenAIAdapter {
    const adapter = new OpenAIAdapter(modelInstance);
    (adapter as any).client = {
        chat: {
            completions: {
                create: jest.fn(async () => response)
            }
        }
    };
    return adapter;
}

const plainCompletionResponse = {
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }]
};

describe('OpenAIAdapter.completeText', () => {
    test('兼容非流式请求返回 SSE data 帧的网关响应', async () => {
        const adapter = createAdapterWithCompletionResponse(
            'data:{"choices":[{"index":0,"delta":{"content":""},"finish_reason":null}]}\n\n' +
                'data:{"choices":[{"index":0,"message":{"role":"assistant","content":"问候任务"},"finish_reason":"stop"}]}\n\n' +
                'data:[DONE]\n\n'
        );

        await expect(adapter.completeText(createChatContext(), false)).resolves.toBe('问候任务');
    });

    test('透出 SSE data 帧中的网关业务错误', async () => {
        const adapter = createAdapterWithCompletionResponse(
            'data:{"answer":"trace_id|span_id|model_code入参异常","status":"ERROR_PARAMETER"}\n\n'
        );

        await expect(adapter.completeText(createChatContext(), false)).rejects.toThrow(
            'ERROR_PARAMETER: trace_id|span_id|model_code入参异常'
        );
    });
});

describe('OpenAIAdapter max_completion_tokens 优先级', () => {
    test('未传 maxCompletionTokens 时使用 ModelInstance.max_output_tokens', async () => {
        const modelInstance = new ModelInstance('demo-model', 'http://127.0.0.1/v1', 'test-key', true);
        modelInstance.max_output_tokens = 65536;
        const adapter = createAdapterWithModelInstance(plainCompletionResponse, modelInstance);

        await adapter.completeText(createChatContext(), false);

        const createFn = (adapter as any).client.chat.completions.create;
        expect(createFn).toHaveBeenCalledTimes(1);
        expect(createFn.mock.calls[0][0].max_completion_tokens).toBe(65536);
    });

    test('显式传入 maxCompletionTokens 时覆盖 ModelInstance.max_output_tokens', async () => {
        const modelInstance = new ModelInstance('demo-model', 'http://127.0.0.1/v1', 'test-key', true);
        modelInstance.max_output_tokens = 65536;
        const adapter = createAdapterWithModelInstance(plainCompletionResponse, modelInstance);

        await adapter.completeText(createChatContext(), false, {}, { maxCompletionTokens: 8192 });

        const createFn = (adapter as any).client.chat.completions.create;
        expect(createFn).toHaveBeenCalledTimes(1);
        expect(createFn.mock.calls[0][0].max_completion_tokens).toBe(8192);
    });

    test('未配置 max_output_tokens 且未传 maxCompletionTokens 时回退到默认值 16384', async () => {
        const adapter = createAdapterWithCompletionResponse(plainCompletionResponse);

        await adapter.completeText(createChatContext(), false);

        const createFn = (adapter as any).client.chat.completions.create;
        expect(createFn).toHaveBeenCalledTimes(1);
        expect(createFn.mock.calls[0][0].max_completion_tokens).toBe(16384);
    });
});

describe('summary metadata and final context budget', () => {
    test('empty choices does not trigger an implicit streaming fallback', async () => {
        const adapter = createAdapterWithCompletionResponse({
            choices: [],
            usage: { prompt_tokens: 10, completion_tokens: 0 }
        });
        const result = await adapter.completeTextWithMetadata(
            createChatContext(),
            false,
            {},
            {
                reasoningEffort: 'none',
                maxCompletionTokens: 10500,
                contextBudget: { window: 70000 }
            }
        );
        expect(result.choicesCount).toBe(0);
        const create = (adapter as any).client.chat.completions.create;
        expect(create).toHaveBeenCalledTimes(1);
        expect(create.mock.calls[0][0]).toMatchObject({ max_completion_tokens: 10500, thinking: { type: 'disabled' } });
        expect(create.mock.calls[0][1]).toMatchObject({ maxRetries: 0 });
    });

    test('keeps reasoning length, termination and usage without treating reasoning as text', async () => {
        const adapter = createAdapterWithCompletionResponse({
            choices: [{ message: { content: null, reasoning_content: 'thinking' }, finish_reason: 'length' }],
            usage: { prompt_tokens: 30, completion_tokens: 10 }
        });
        const result = await adapter.completeTextWithMetadata(createChatContext(), false);
        expect(result).toMatchObject({ text: '', reasoningLength: 8, finishReason: 'length' });
        expect(result.usage?.completion_tokens).toBe(10);
    });

    test('incomplete SSE cannot masquerade as a successful summary', async () => {
        const adapter = createAdapterWithCompletionResponse('data: {"choices":[{"delta":{"content":"partial"}}]}\n');
        expect((await adapter.completeTextWithMetadata(createChatContext(), false)).protocolError).toBe(
            'incomplete_stream'
        );
    });

    test('final tail text exceeding the budget prevents the HTTP request', async () => {
        const adapter = createAdapterWithCompletionResponse({ choices: [] });
        const stream = adapter.streamComplete(
            createChatContext(),
            false,
            { requestTailText: 'large tail '.repeat(1000) },
            {
                maxCompletionTokens: 100,
                contextBudget: { window: 1000 }
            }
        );
        await expect(stream[Symbol.asyncIterator]().next()).rejects.toThrow('context_limit');
        expect((adapter as any).client.chat.completions.create).not.toHaveBeenCalled();
    });
});

describe('OpenAIAdapter extraHeaders 透传', () => {
    test('extraHeaders 透传到请求选项', async () => {
        const adapter = createAdapterWithCompletionResponse(plainCompletionResponse);
        const createFn = (adapter as any).client.chat.completions.create;

        await adapter.completeText(createChatContext(), false, {}, { extraHeaders: { 'x-session': 'ses_abc' } });

        expect(createFn).toHaveBeenCalledTimes(1);
        const options = createFn.mock.calls[0][1];
        expect(options.headers['x-session']).toBe('ses_abc');
    });
});

describe('OpenAIAdapter.parseUsage 缓存用量', () => {
    test('解析 OpenAI 风格 prompt_tokens_details.cached_tokens', () => {
        const usage = OpenAIAdapter.parseUsage({
            prompt_tokens: 1000,
            completion_tokens: 20,
            total_tokens: 1020,
            prompt_tokens_details: { cached_tokens: 768 }
        });

        expect(usage?.prompt_tokens).toBe(1000);
        expect(usage?.cache_read_input_tokens).toBe(768);
        expect(usage?.input_tokens).toBe(232);
    });

    test('解析 DeepSeek 风格 prompt_cache_hit_tokens', () => {
        const usage = OpenAIAdapter.parseUsage({
            prompt_tokens: 1000,
            completion_tokens: 20,
            total_tokens: 1020,
            prompt_cache_hit_tokens: 512,
            prompt_cache_miss_tokens: 488
        });

        expect(usage?.cache_read_input_tokens).toBe(512);
        expect(usage?.input_tokens).toBe(488);
    });

    test('无缓存字段时保持输入为完整 prompt tokens', () => {
        const usage = OpenAIAdapter.parseUsage({
            prompt_tokens: 300,
            completion_tokens: 10,
            total_tokens: 310
        });

        expect(usage?.cache_read_input_tokens).toBe(0);
        expect(usage?.input_tokens).toBe(300);
    });

    test('显式提供 input_tokens 时不重复扣除缓存', () => {
        const usage = OpenAIAdapter.parseUsage({
            prompt_tokens: 1000,
            completion_tokens: 20,
            total_tokens: 1020,
            input_tokens: 200,
            prompt_tokens_details: { cached_tokens: 768 }
        });

        expect(usage?.cache_read_input_tokens).toBe(768);
        expect(usage?.input_tokens).toBe(200);
    });
});
