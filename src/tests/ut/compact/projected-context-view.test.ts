import {
    buildProjectedActiveContextView,
    buildActiveContextView
} from '../../../main/aikernel/compaction/context-view';
import {
    AssistantMessage,
    ChatContext,
    CompactSeparatorMessage,
    ToolCall,
    ToolCallMessagePart,
    UserMessage
} from '../../../main/aikernel/messages';

function createToolCallPart(partLabel: string, toolCallCount: number): ToolCallMessagePart {
    const part = new ToolCallMessagePart();
    for (let index = 0; index < toolCallCount; index++) {
        const toolCall = new ToolCall(
            index,
            `${partLabel}-tool-call-${index}`,
            'demo_tool',
            `{"part":"${partLabel}","toolCallIndex":${index}}`
        );
        toolCall.status = 'success';
        toolCall.result = `${partLabel} result ${index}`;
        part.push(toolCall);
    }
    return part;
}

function createMultiRoundAssistant(): AssistantMessage {
    const message = new AssistantMessage();
    message.appendReasoningContent('reasoning round-1');
    message.appendText('visible round-1');
    message.appendToolCallPart(createToolCallPart('round-1', 1));
    message.appendReasoningContent('reasoning round-2');
    message.appendToolCallPart(createToolCallPart('round-2', 2));
    message.appendText('tail round-3');
    return message;
}

describe('projected active context view', () => {
    test('在保留现有 active context 的同时，把 assistant 展开为多个 round item', () => {
        const chatContext = new ChatContext();
        const hiddenUser = new UserMessage('hidden user before boundary');
        const hiddenAssistant = new AssistantMessage().appendText('hidden assistant before boundary');
        const boundary = new CompactSeparatorMessage('older compact summary', {
            boundary_id: 'boundary-step2',
            created_at: '2026-04-27T00:00:00.000Z'
        });
        const user = new UserMessage('active user after boundary');
        const assistant = createMultiRoundAssistant();
        const trailingUser = new UserMessage('next user after assistant');

        chatContext.appendMessage(hiddenUser);
        chatContext.appendMessage(hiddenAssistant);
        chatContext.appendMessage(boundary);
        chatContext.appendMessage(user);
        chatContext.appendMessage(assistant);
        chatContext.appendMessage(trailingUser);

        const activeContext = buildActiveContextView(chatContext);
        const projectedView = buildProjectedActiveContextView(chatContext);

        expect(projectedView.startIndex).toBe(activeContext.startIndex);
        expect(projectedView.messages).toEqual(activeContext.messages);
        expect(projectedView.boundary).toEqual(activeContext.boundary);
        expect(projectedView.messages).toEqual([boundary, user, assistant, trailingUser]);
        expect(projectedView.projectedItems.map((item) => item.kind)).toEqual([
            'compact_boundary',
            'user_message',
            'assistant_round',
            'assistant_round',
            'assistant_round',
            'user_message'
        ]);
        expect(projectedView.projectedItems.map((item) => item.messageIndex)).toEqual([2, 3, 4, 4, 4, 5]);
        expect(projectedView.projectedItems.map((item) => item.messageId)).toEqual([
            'boundary-step2',
            user.message_id,
            assistant.message_id,
            assistant.message_id,
            assistant.message_id,
            trailingUser.message_id
        ]);

        const assistantRoundItems = projectedView.projectedItems.filter((item) => item.kind === 'assistant_round');
        expect(assistantRoundItems.map((item) => item.round.kind)).toEqual([
            'tool_call_batch',
            'tool_call_batch',
            'message_tail'
        ]);
        expect(assistantRoundItems.map((item) => item.roundRef)).toEqual([
            {
                assistantMessageId: assistant.message_id,
                roundIndex: 0,
                startPartIndex: 0,
                endPartIndexExclusive: 3
            },
            {
                assistantMessageId: assistant.message_id,
                roundIndex: 1,
                startPartIndex: 3,
                endPartIndexExclusive: 5
            },
            {
                assistantMessageId: assistant.message_id,
                roundIndex: 2,
                startPartIndex: 5,
                endPartIndexExclusive: 6
            }
        ]);
    });

    test('assistant round 的顺序与 toOpenAIMessages 的回放语义一致', () => {
        const chatContext = new ChatContext();
        const user = new UserMessage('continue task');
        const assistant = createMultiRoundAssistant();
        chatContext.appendMessage(user);
        chatContext.appendMessage(assistant);

        const projectedView = buildProjectedActiveContextView(chatContext);
        const assistantRoundItems = projectedView.projectedItems.filter((item) => item.kind === 'assistant_round');
        const roundLabels = assistantRoundItems.map((item) =>
            item.round.parts
                .filter((part) => part.type === 'text')
                .map((part) => part.text)
                .join(' | ')
        );
        const serializedOpenAIMessages = JSON.stringify(assistant.toOpenAIMessages());

        expect(roundLabels).toEqual(['visible round-1', '', 'tail round-3']);
        expect(serializedOpenAIMessages.indexOf('visible round-1')).toBeGreaterThanOrEqual(0);
        expect(serializedOpenAIMessages.indexOf('reasoning round-2')).toBeGreaterThan(
            serializedOpenAIMessages.indexOf('visible round-1')
        );
        expect(serializedOpenAIMessages.indexOf('tail round-3')).toBeGreaterThan(
            serializedOpenAIMessages.indexOf('reasoning round-2')
        );
    });
});
