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
