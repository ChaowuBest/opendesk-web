import {
    analyzeMicrocompactCandidatesForChatContext,
    applyLocalMicrocompactToChatContext
} from '../../../main/aikernel/compaction/microcompact';
import {
    AssistantMessage,
    ChatContext,
    ToolCall,
    ToolCallMessagePart,
    UserMessage
} from '../../../main/aikernel/messages';

function createToolAssistant(name: string, result: string): { message: AssistantMessage; toolCall: ToolCall } {
    const message = new AssistantMessage();
    message.appendText(`assistant ${name}`);

    const toolCall = new ToolCall(0, `tool-${name}`, 'executePowerShell', `{"command":"echo ${name}"}`);
    toolCall.status = 'success';
    toolCall.result = result;

    const part = new ToolCallMessagePart();
    part.push(toolCall);
    message.appendToolCallPart(part);

    return { message, toolCall };
}

describe('compact smoke: microcompact', () => {
    test('会清理旧工具结果，并保护最近的工具调用 tail', () => {
        const chatContext = new ChatContext();
        chatContext.appendMessage(new UserMessage('run several tools'));

        const old1 = createToolAssistant('old-1', 'old result 1 '.repeat(80));
        const old2 = createToolAssistant('old-2', 'old result 2 '.repeat(80));
        const recent = createToolAssistant('recent', 'recent result should stay visible');
        chatContext.appendMessage(old1.message);
        chatContext.appendMessage(old2.message);
        chatContext.appendMessage(recent.message);

        const analysis = analyzeMicrocompactCandidatesForChatContext(chatContext, {
            tailAssistantMessages: 1
        });
        expect(analysis.candidates.map((candidate) => candidate.toolCall.id)).toEqual(['tool-old-1', 'tool-old-2']);
        expect(analysis.stats.tailProtectedCount).toBe(1);

        const result = applyLocalMicrocompactToChatContext(chatContext, 'task-microcompact-smoke', {
            analysis
        });

        expect(result.appliedCandidates).toHaveLength(2);
        expect(old1.toolCall.result).toContain('[旧工具结果已被 microcompact 清理');
        expect(old2.toolCall.result).toContain('[旧工具结果已被 microcompact 清理');
        expect(old1.toolCall.microcompact?.strategy).toBe('local_clear');
        expect(old2.toolCall.microcompact?.strategy).toBe('local_clear');
        expect(recent.toolCall.result).toBe('recent result should stay visible');
        expect(recent.toolCall.microcompact).toBeUndefined();
        expect(result.activeContext.messages).toHaveLength(4);
    });
});
