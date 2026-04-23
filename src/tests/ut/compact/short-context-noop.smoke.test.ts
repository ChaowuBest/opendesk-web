import { jest } from '@jest/globals';
import { buildFullCompactPlan, compactFullContext } from '../../../main/aikernel/compaction/full-compact';
import { AssistantMessage, ChatContext, UserMessage } from '../../../main/aikernel/messages';

function appendAssistantText(chatContext: ChatContext, text: string): void {
    const assistant = new AssistantMessage();
    assistant.appendText(text);
    chatContext.appendMessage(assistant);
}

describe('compact smoke: short context no-op', () => {
    test('单条用户消息不会误生成 full compact boundary', async () => {
        const chatContext = new ChatContext();
        chatContext.appendMessage(new UserMessage('only one very large user message'));
        const generateSummary = jest.fn(async () => 'should not be called');

        expect(buildFullCompactPlan(chatContext)).toBeUndefined();

        const result = await compactFullContext(chatContext, undefined, { generateSummary });

        expect(result.compacted).toBe(false);
        expect(generateSummary).not.toHaveBeenCalled();
        expect(chatContext.findCompactBoundary()).toBeUndefined();
        expect(chatContext.messages).toHaveLength(1);
    });

    test('一轮短对话不会误显示 compact 成功', async () => {
        const chatContext = new ChatContext();
        chatContext.appendMessage(new UserMessage('first user turn'));
        appendAssistantText(chatContext, 'first assistant turn');
        const generateSummary = jest.fn(async () => 'should not be called');

        const result = await compactFullContext(chatContext, undefined, { generateSummary });

        expect(result.compacted).toBe(false);
        expect(generateSummary).not.toHaveBeenCalled();
        expect(chatContext.findCompactBoundary()).toBeUndefined();
        expect(chatContext.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    });
});
