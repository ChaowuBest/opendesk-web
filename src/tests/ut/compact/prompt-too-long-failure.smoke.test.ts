import { jest } from '@jest/globals';

const createMock = jest.fn(async () => {
    throw new Error('context length exceeded: requested tokens exceed model limit');
});

jest.unstable_mockModule('openai', () => ({
    APIError: class APIError extends Error {
        status?: number;
        headers?: Headers;
    },
    RateLimitError: class RateLimitError extends Error {},
    OpenAI: jest.fn().mockImplementation(() => ({
        chat: {
            completions: {
                create: createMock
            }
        }
    }))
}));

describe('compact smoke: prompt-too-long failure path', () => {
    beforeEach(() => {
        createMock.mockClear();
    });

    test('LLM.streamComplete 当前会把超上下文错误转换成 assistant error，而不是自动重试压缩', async () => {
        const { ChatContext, UserMessage } = await import('../../../main/aikernel/messages');
        const { ModelInstance } = await import('../../../main/utils/setting');
        const { LLM } = await import('../../../main/aikernel/llm');
        const chatContext = new ChatContext();
        chatContext.appendMessage(new UserMessage('single huge user prompt '.repeat(200)));
        const chunks = [];

        for await (const chunk of LLM.streamComplete(
            chatContext,
            new ModelInstance('gpt-4o', 'https://mock.local/v1', 'test-key', true)
        )) {
            chunks.push(chunk);
        }

        expect(createMock).toHaveBeenCalledTimes(1);
        expect(chunks).toHaveLength(1);
        expect(chunks[0].finish_reason).toBe('error');
        expect(chunks[0].content.content[0]).toMatchObject({
            type: 'error',
            title: 'Stream Completion Failed'
        });
        expect(chunks[0].content.content[0].message).toContain('context length exceeded');
    });
});
