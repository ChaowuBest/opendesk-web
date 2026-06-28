import { buildAssistantRounds } from '../../../main/aikernel/compaction/assistant-rounds';
import { OpenAIAdapter } from '../../../main/aikernel/adapters/openai';
import {
    AssistantMessage,
    ChatContext,
    ToolCall,
    ToolCallMessagePart,
    UserMessage
} from '../../../main/aikernel/messages';

function appendToolRound(
    message: AssistantMessage,
    roundLabel: string,
    options: { resultId?: string; includeVisibleText?: boolean } = {}
): ToolCall {
    message.appendReasoningContent(`reasoning ${roundLabel}`);
    if (options.includeVisibleText !== false) {
        message.appendText(`visible ${roundLabel}`);
    }

    const toolCall = new ToolCall(0, `tool-call-${roundLabel}`, 'demo_tool', `{"round":"${roundLabel}"}`);
    toolCall.status = 'success';
    toolCall.result = `result ${roundLabel}`;
    if (options.resultId) {
        toolCall.setResultStorage({
            result_id: options.resultId,
            storage_version: 1
        });
    }

    const part = new ToolCallMessagePart();
    part.push(toolCall);
    message.appendToolCallPart(part);
    return toolCall;
}

function createReplayAssistant(): { message: AssistantMessage; round2ToolCall: ToolCall } {
    const message = new AssistantMessage();
    appendToolRound(message, 'round-1');
    const round2ToolCall = appendToolRound(message, 'round-2', { resultId: 'result-round-2' });
    message.appendReasoningContent('reasoning round-3');
    message.appendText('visible round-3');
    return { message, round2ToolCall };
}

describe('assistant partial replay', () => {
    test('OpenAI assistant messages use Chat Completions compatible content shapes', () => {
        const textMessage = new AssistantMessage();
        textMessage.appendText('plain assistant text');

        const textOpenAIMessages = textMessage.toOpenAIMessages();
        expect(textOpenAIMessages).toEqual([
            {
                role: 'assistant',
                content: 'plain assistant text'
            }
        ]);

        const toolOnlyMessage = new AssistantMessage();
        const toolCall = new ToolCall(0, 'tool-call-only', 'demo_tool', '{"query":"value"}');
        toolCall.status = 'success';
        toolCall.result = 'tool result text';
        const part = new ToolCallMessagePart();
        part.push(toolCall);
        toolOnlyMessage.appendToolCallPart(part);

        const toolOpenAIMessages = toolOnlyMessage.toOpenAIMessages();
        expect(toolOpenAIMessages).toEqual([
            {
                role: 'assistant',
                content: null,
                tool_calls: [
                    {
                        id: 'tool-call-only',
                        type: 'function',
                        function: {
                            name: 'demo_tool',
                            arguments: '{"query":"value"}'
                        }
                    }
                ]
            },
            {
                role: 'tool',
                tool_call_id: 'tool-call-only',
                content: 'tool result text'
            }
        ]);
    });

    test('toOpenAIMessagesFromRound 只回放指定 round 及之后的内容，并保持 tool call/tool result 成对输出', () => {
        const { message } = createReplayAssistant();
        const rounds = buildAssistantRounds(message);

        const replayedMessages = message.toOpenAIMessagesFromRound(rounds[1].ref);
        const serialized = JSON.stringify(replayedMessages);

        expect(replayedMessages).toHaveLength(3);
        expect(serialized).not.toContain('round-1');
        expect(serialized).toContain('reasoning round-2');
        expect(serialized).toContain('visible round-2');
        expect(serialized).toContain('result round-2');
        expect(serialized).toContain('reasoning round-3');
        expect(serialized).toContain('visible round-3');
        expect((replayedMessages[0] as { role: string; tool_calls: object[] }).role).toBe('assistant');
        expect((replayedMessages[0] as { tool_calls?: object[] }).tool_calls).toHaveLength(1);
        expect((replayedMessages[1] as { role: string; tool_call_id: string }).role).toBe('tool');
        expect((replayedMessages[2] as { role: string }).role).toBe('assistant');
    });

    test('toOpenAIMessagesFromPartIndex 仍然支持 tool result override', () => {
        const { message, round2ToolCall } = createReplayAssistant();
        const rounds = buildAssistantRounds(message);
        const replayedMessages = message.toOpenAIMessagesFromPartIndex(
            rounds[1].ref.startPartIndex,
            new Map([['result-round-2', 'override result round-2']])
        );

        const toolMessage = replayedMessages.find(
            (candidate) =>
                typeof candidate === 'object' &&
                candidate !== null &&
                (candidate as { role?: string }).role === 'tool' &&
                (candidate as { tool_call_id?: string }).tool_call_id === round2ToolCall.id
        ) as { content: string } | undefined;

        expect(toolMessage?.content).toBe('override result round-2');
        expect(JSON.stringify(replayedMessages)).not.toContain('result round-1');
    });

    test('OpenAIAdapter.buildMessages 在显式提供 replay 指令时可只回放 assistant 后半段', () => {
        const chatContext = new ChatContext();
        const user = new UserMessage('continue task');
        const { message } = createReplayAssistant();
        const rounds = buildAssistantRounds(message);

        chatContext.appendMessage(user);
        chatContext.appendMessage(message);

        const builtMessages = OpenAIAdapter.buildMessages(chatContext, false, {
            assistantReplayByMessageId: new Map([[message.message_id, { roundRef: rounds[1].ref }]])
        });
        const serialized = JSON.stringify(builtMessages);

        expect(serialized).toContain('continue task');
        expect(serialized).not.toContain('round-1');
        expect(serialized).toContain('round-2');
        expect(serialized).toContain('round-3');
    });
});
