import { ToolCall } from '../../../main/aikernel/messages.js';

describe('ToolCall GUI render payload', () => {
    test('includes complete call data and elapsed time for expandable process details', () => {
        const call = new ToolCall(0, 'call-1', 'terminal-executeZsh', '{"command":"npm test"}');
        call.args_object = { command: 'npm test' };
        call.result = '6 passed';
        call.status = 'success';
        call.elapsedSeconds = 1.4;
        call.rendered = '<div>terminal result</div>';

        expect(call.toRenderJSON()).toEqual({
            index: 0,
            id: 'call-1',
            tool_name: 'terminal-executeZsh',
            status: 'success',
            args_string: '{"command":"npm test"}',
            result: '6 passed',
            elapsedSeconds: 1.4,
            rendered: '<div>terminal result</div>'
        });
    });

    test('records elapsed execution time once finalized', () => {
        const call = new ToolCall(0, 'call-1', 'Search', '{}');
        call.startTiming(1_000);
        call.finalizeTiming(2_450);

        expect(call.elapsedSeconds).toBe(1.5);
        call.finalizeTiming(9_000);
        expect(call.elapsedSeconds).toBe(1.5);
    });
});
