import { AssistantMessage, ToolCall, ToolCallMessagePart } from '../../../main/aikernel/messages.js';
import { findToolCallDetail } from '../../../main/aikernel/task/tool-call-detail.js';

function toolPart(...calls: ToolCall[]): ToolCallMessagePart {
    const part = new ToolCallMessagePart();
    part.toolcalls.push(...calls);
    return part;
}

describe('tool call detail lookup', () => {
    test('uses the message and part position when providers reuse a tool call id', () => {
        const firstCall = new ToolCall(0, 'reused-id', 'Read', '{"path":"first"}');
        firstCall.result = 'first result';
        const secondCall = new ToolCall(0, 'reused-id', 'Read', '{"path":"second"}');
        secondCall.result = 'second result';
        secondCall.elapsedSeconds = 1.2;
        secondCall.rendered = '<div>second render</div>';

        const firstMessage = new AssistantMessage([toolPart(firstCall)]);
        firstMessage.message_id = 'message-1';
        const secondMessage = new AssistantMessage([toolPart(secondCall)]);
        secondMessage.message_id = 'message-2';
        const task = { chat_context: { messages: [firstMessage, secondMessage] } };

        expect(findToolCallDetail(task, 'message-2', 0, 0, 'reused-id')).toEqual({
            args_string: '{"path":"second"}',
            result: 'second result',
            rendered: '<div>second render</div>',
            status: 'pending',
            elapsedSeconds: 1.2
        });
    });

    test('rejects a mismatched id instead of returning the call at the requested position', () => {
        const call = new ToolCall(0, 'call-1', 'Read', '{}');
        const message = new AssistantMessage([toolPart(call)]);
        message.message_id = 'message-1';
        const task = { chat_context: { messages: [message] } };

        expect(findToolCallDetail(task, 'message-1', 0, 0, 'different-id')).toBeUndefined();
    });
});
