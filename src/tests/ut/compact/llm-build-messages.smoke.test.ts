import { LLM } from '../../../main/aikernel/llm';
import { AssistantMessage, ChatContext, CompactSeparatorMessage, UserMessage } from '../../../main/aikernel/messages';

function assistant(text: string): AssistantMessage {
    const message = new AssistantMessage();
    message.appendText(text);
    return message;
}

describe('compact smoke: LLM.buildMessages active context projection', () => {
    test('最终发给模型的 messages 只包含最新 boundary 和 kept tail', () => {
        const chatContext = new ChatContext();
        chatContext.appendMessage(new UserMessage('hidden user before compact'));
        chatContext.appendMessage(assistant('hidden assistant before compact'));
        chatContext.appendMessage(
            new CompactSeparatorMessage('structured compact summary for hidden history', {
                boundary_id: 'boundary-build-messages-smoke',
                created_at: '2026-04-20T00:00:00.000Z'
            })
        );
        chatContext.appendMessage(new UserMessage('kept user after compact'));
        chatContext.appendMessage(assistant('kept assistant after compact'));

        const messages = LLM.buildMessages(chatContext, false);
        const serialized = JSON.stringify(messages);

        expect(messages).toHaveLength(3);
        expect(serialized).toContain('structured compact summary for hidden history');
        expect(serialized).toContain('kept user after compact');
        expect(serialized).toContain('kept assistant after compact');
        expect(serialized).not.toContain('hidden user before compact');
        expect(serialized).not.toContain('hidden assistant before compact');
    });
});
