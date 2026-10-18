import { AnthropicAdapter } from '../../../main/aikernel/adapters/anthropic';
import { ChatContext, SystemMessage, UserMessage } from '../../../main/aikernel/messages';

describe('AnthropicAdapter.parseUsage 缓存用量', () => {
    test('缓存字段单独表达，input_tokens 保持不含缓存的输入', () => {
        const usage = AnthropicAdapter.parseUsage({
            input_tokens: 30,
            output_tokens: 29,
            cache_creation_input_tokens: 10,
            cache_read_input_tokens: 1280
        });

        expect(usage?.input_tokens).toBe(30);
        expect(usage?.cache_read_input_tokens).toBe(1280);
        expect(usage?.cache_creation_input_tokens).toBe(10);
        // 未命中 + 命中 + 写入 = 完整输入
        expect((usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0)).toBe(1310);
    });

    test('网关不返回 cache_creation 字段时该字段为 undefined', () => {
        const usage = AnthropicAdapter.parseUsage({
            input_tokens: 2,
            output_tokens: 13,
            cache_read_input_tokens: 1216
        });

        expect(usage?.input_tokens).toBe(2);
        expect(usage?.cache_read_input_tokens).toBe(1216);
        expect(usage?.cache_creation_input_tokens).toBeUndefined();
    });
});

describe('AnthropicAdapter.buildMessages system prompt 投影', () => {
    test('chat_context.system_prompt 注入的 system prompt 映射到请求 system 字段', () => {
        const chatContext = new ChatContext();
        (chatContext as any).system_prompt = new SystemMessage('You are a helpful assistant.');
        chatContext.appendMessage(new UserMessage('say hi'));

        const anthropicMessages = AnthropicAdapter.buildMessages(chatContext, false);
        expect(anthropicMessages.system).toBe('You are a helpful assistant.');
        expect(anthropicMessages.messages).toHaveLength(1);
    });

    test('appendMessage(SystemMessage) 注入的 system prompt 不被静默丢弃', () => {
        const chatContext = new ChatContext();
        // 技能归因等调用方的既有写法：SystemMessage 不在 appendMessage 的类型联合内，运行时支持
        chatContext.appendMessage(new SystemMessage('Batch attribution system prompt.') as any);
        chatContext.appendMessage(new UserMessage('attribute skills'));

        const anthropicMessages = AnthropicAdapter.buildMessages(chatContext, false);
        expect(anthropicMessages.system).toBe('Batch attribution system prompt.');
        // SystemMessage 只进 system 字段，不再以消息形式重复发送
        expect(anthropicMessages.messages).toHaveLength(1);
    });
});
