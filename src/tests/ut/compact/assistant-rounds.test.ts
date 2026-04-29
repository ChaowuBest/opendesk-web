import {
    AssistantMessage,
    ErrorMessagePart,
    ReasoningMessagePart,
    TextMessagePart,
    ToolCall,
    ToolCallMessagePart
} from '../../../main/aikernel/messages';
import { buildAssistantRounds } from '../../../main/aikernel/compaction/assistant-rounds';

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

function partTypesOfRound(round: ReturnType<typeof buildAssistantRounds>[number]): string[] {
    return round.parts.map((part) => part.type);
}

describe('assistant round projection', () => {
    test('按 tool_call part 边界切分 round，并保留末尾非 tool_call part', () => {
        const message = new AssistantMessage([
            new ReasoningMessagePart('reasoning 1', 'reasoning_content'),
            new TextMessagePart('visible 1'),
            createToolCallPart('first', 1),
            new ReasoningMessagePart('reasoning 2', 'reasoning_content'),
            new ErrorMessagePart('Error', 'something failed'),
            createToolCallPart('second', 2),
            new TextMessagePart('tail text')
        ]);

        const rounds = buildAssistantRounds(message);

        expect(rounds).toHaveLength(3);
        expect(rounds.map((round) => round.kind)).toEqual(['tool_call_batch', 'tool_call_batch', 'message_tail']);
        expect(rounds.map((round) => round.ref)).toEqual([
            {
                assistantMessageId: message.message_id,
                roundIndex: 0,
                startPartIndex: 0,
                endPartIndexExclusive: 3
            },
            {
                assistantMessageId: message.message_id,
                roundIndex: 1,
                startPartIndex: 3,
                endPartIndexExclusive: 6
            },
            {
                assistantMessageId: message.message_id,
                roundIndex: 2,
                startPartIndex: 6,
                endPartIndexExclusive: 7
            }
        ]);
        expect(rounds.map(partTypesOfRound)).toEqual([
            ['reasoning', 'text', 'tool_call'],
            ['reasoning', 'error', 'tool_call'],
            ['text']
        ]);
        expect(rounds.map((round) => round.toolCallCount)).toEqual([1, 2, 0]);
    });

    test('连续 tool_call part 会形成多个独立 round，且不会切到 part 内部', () => {
        const firstToolPart = createToolCallPart('first', 2);
        const secondToolPart = createToolCallPart('second', 1);
        const message = new AssistantMessage([firstToolPart, secondToolPart]);

        const rounds = buildAssistantRounds(message);

        expect(rounds).toHaveLength(2);
        expect(rounds.map((round) => round.kind)).toEqual(['tool_call_batch', 'tool_call_batch']);
        expect(rounds.map((round) => round.ref.startPartIndex)).toEqual([0, 1]);
        expect(rounds.map((round) => round.ref.endPartIndexExclusive)).toEqual([1, 2]);
        expect(rounds.map((round) => round.parts)).toEqual([[firstToolPart], [secondToolPart]]);
        expect(rounds.map((round) => round.toolCallCount)).toEqual([2, 1]);
    });

    test('空 assistant message 不会生成 round', () => {
        expect(buildAssistantRounds(new AssistantMessage())).toEqual([]);
    });
});
