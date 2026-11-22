import { AssistantMessage, TextMessagePart, ToolCall, ToolCallMessagePart } from '../../../main/aikernel/messages.js';
import { collectToolCalls, hasRequestToolCall } from '../../../main/aikernel/task/tool-resolver.js';

function part(call: ToolCall): ToolCallMessagePart {
    const result = new ToolCallMessagePart();
    result.toolcalls.push(call);
    return result;
}

test('request membership follows object identity across edits, removal and rollback', () => {
    const older = new ToolCall(0, 'same-id', 'fixture', '{}');
    const current = new ToolCall(0, 'same-id', 'fixture', '{}');
    const message = new AssistantMessage([part(older)]);
    const previous = new Set(collectToolCalls(message));
    const compare = () => expect(hasRequestToolCall(message, previous)).toBe(
        collectToolCalls(message).some(call => !previous.has(call))
    );
    compare();
    message.beginCompletionRound(false);
    message.content.push(part(current), new TextMessagePart(' '));
    compare();
    message.content[0] = part(current);
    message.rollbackToRoundStart();
    compare();
    message.content[0] = part(older);
    compare();
});

test('a current tool at the tail ends the presence check without enumerating history', () => {
    const older = new ToolCall(0, 'old', 'fixture', '{}');
    const historical = part(older);
    let reads = 0;
    Object.defineProperty(historical, 'toolcalls', { get: () => { reads++; return [older]; } });
    const current = new ToolCall(0, 'new', 'fixture', '{}');
    const answer = new AssistantMessage([historical, part(current), new TextMessagePart(' ')]);
    reads = 0;
    expect(hasRequestToolCall(answer, new Set([older]))).toBe(true);
    expect(reads).toBe(0);
});
