import { describe, expect, jest, test } from '@jest/globals';
import stripAnsi from 'strip-ansi';

// ansi-regex 6.2.2 consumed ESC ] 0 even without an OSC terminator.
// Keep complete-sequence handling real while reproducing that dependency behavior.
const partialOscStripper = jest.fn((value: string) => stripAnsi(value).replace(/\u001b\]0/g, ''));
jest.unstable_mockModule('strip-ansi', () => ({ default: partialOscStripper }));
const { computeTerminalLiveOutputFrame } = await import('../../../main/applications/terminal/output-delta.js');

describe('terminal output with a dependency that consumes incomplete OSC introducers', () => {
    test('removes an unfinished suffix before strip-ansi can destroy its introducer', () => {
        const frame = computeTerminalLiveOutputFrame('', 'text\u001b]0;window title');
        expect(frame).toEqual({ stripped: 'text', reset: false, delta: 'text' });
        expect(partialOscStripper).toHaveBeenLastCalledWith('text');
    });

    test.each(['\u0007', '\u001b\\', '\u009c'])(
        'OSC completion with %j produces only new visible text',
        (terminator) => {
            const first = computeTerminalLiveOutputFrame('', 'text\u001b]0;window title');
            const next = computeTerminalLiveOutputFrame(first.stripped, `text\u001b]0;window title${terminator}more`);
            expect(next).toEqual({ stripped: 'textmore', reset: false, delta: 'more' });
            expect(first.delta + next.delta).toBe(next.stripped);
        }
    );
});
