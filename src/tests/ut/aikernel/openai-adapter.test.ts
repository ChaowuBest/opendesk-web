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
