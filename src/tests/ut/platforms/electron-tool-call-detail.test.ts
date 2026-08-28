import { AssistantMessage, ToolCall, ToolCallMessagePart } from '../../../main/aikernel/messages.js';
import {
    TOOL_CALL_DETAIL_RENDERED_MAX_BYTES,
    TOOL_CALL_DETAIL_RESULT_MAX_BYTES,
    findToolCallDetail
} from '../../../platforms/electron-tool-call-detail.js';

function toolPart(...calls: ToolCall[]): ToolCallMessagePart {
    const part = new ToolCallMessagePart();
    part.toolcalls.push(...calls);
    return part;
}

describe('Electron tool call detail lookup', () => {
    test('keeps the IPC display limits deliberately small', () => {
        expect(TOOL_CALL_DETAIL_RESULT_MAX_BYTES).toBe(24 * 1024);
        expect(TOOL_CALL_DETAIL_RENDERED_MAX_BYTES).toBe(8 * 1024);
    });

    test('uses the message and part position when providers reuse a tool call id', () => {
        const firstCall = new ToolCall(0, 'reused-id', 'Read', '{"path":"first"}');
        firstCall.result = 'first result';
        const secondCall = new ToolCall(0, 'reused-id', 'Read', '{"path":"second"}');
        secondCall.result = 'second result';
        secondCall.elapsedSeconds = 1.2;
        secondCall.rendered = '<div>second render</div>';
        secondCall.presentation = { displayName: 'Read', detailMode: 'custom' };

        const firstMessage = new AssistantMessage([toolPart(firstCall)]);
        firstMessage.message_id = 'message-1';
        const secondMessage = new AssistantMessage([toolPart(secondCall)]);
        secondMessage.message_id = 'message-2';
        const task = { chat_context: { messages: [firstMessage, secondMessage] } };

        expect(findToolCallDetail(task, 'message-2', 0, 0, 'reused-id')).toEqual({
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

    test('bounds large detail fields by UTF-8 bytes before returning them to Electron', () => {
        const args = JSON.stringify({ command: '测'.repeat(40_000) });
        const result = `head\n${'结'.repeat(80_000)}\ntail`;
        const rendered = `<pre>${'页'.repeat(40_000)}</pre>`;
        const call = new ToolCall(0, 'large-call', 'terminal-executeZsh', args);
        call.result = result;
        call.rendered = rendered;
        call.presentation = { displayName: 'Zsh', detailMode: 'custom' };
        const message = new AssistantMessage([toolPart(call)]);
        message.message_id = 'message-large';
        const task = { chat_context: { messages: [message] } };

        const detail = findToolCallDetail(task, 'message-large', 0, 0, 'large-call');

        expect(detail).not.toHaveProperty('args_string');
        expect(Buffer.byteLength(detail?.result || '', 'utf8')).toBeLessThanOrEqual(TOOL_CALL_DETAIL_RESULT_MAX_BYTES);
        expect(detail?.result).toContain('head');
        expect(detail?.result).toContain('tail');
        expect(detail?.rendered).toBeUndefined();
        expect(detail?.truncation).toEqual({
            result: { originalBytes: Buffer.byteLength(result, 'utf8') },
            rendered: { originalBytes: Buffer.byteLength(rendered, 'utf8') }
        });
        expect(TOOL_CALL_DETAIL_RENDERED_MAX_BYTES).toBeGreaterThan(0);
    });

    test('does not return legacy rendered HTML without an explicit custom-detail opt-in', () => {
        const call = new ToolCall(0, 'unsafe-render', 'terminal-executeZsh', '{"command":"secret"}');
        call.rendered = '<details class="terminal-tool"><pre>secret</pre></details>';
        const message = new AssistantMessage([toolPart(call)]);
        message.message_id = 'message-unsafe-render';
        const task = { chat_context: { messages: [message] } };

        expect(findToolCallDetail(task, 'message-unsafe-render', 0, 0, 'unsafe-render')).toEqual({
            status: 'pending',
            elapsedSeconds: undefined
        });
    });
});
