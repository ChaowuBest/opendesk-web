import { describe, expect, test } from '@jest/globals';
import {
    computeTerminalLiveOutputFrame,
    computeTerminalOutputDelta
} from '../../../main/applications/terminal/output-delta.js';

/**
 * 终端 live 输出增量的回归测试：
 * BoundedOutputBuffer 未截断时输出只做尾部追加，tick 推送应携带纯增量；
 * 截断（head+marker+tail 结构生效）或重置会破坏前缀关系，必须整体重写。
 */
describe('computeTerminalOutputDelta', () => {
    test('尾部追加时携带纯增量，不置 reset', () => {
        expect(computeTerminalOutputDelta('line1\n', 'line1\nline2\n')).toEqual({
            reset: false,
            delta: 'line2\n'
        });
    });

    test('首次推送（上次为空）携带全量但不置 reset：渲染端尚无卡片，走全量渲染兜底', () => {
        expect(computeTerminalOutputDelta('', 'first output')).toEqual({ reset: false, delta: 'first output' });
    });

    test('缓冲截断后前缀关系破坏 → reset 且 delta 为全量', () => {
        const lastSent = 'head...tail-old';
        const current = 'head...marker...tail-new';
        expect(computeTerminalOutputDelta(lastSent, current)).toEqual({ reset: true, delta: current });
    });

    test('输出收缩（如终端清屏重写）→ reset', () => {
        expect(computeTerminalOutputDelta('longer output', 'short')).toEqual({ reset: true, delta: 'short' });
    });

    test('内容未变化返回空增量（调用方通常提前短路，不触发推送）', () => {
        expect(computeTerminalOutputDelta('same', 'same')).toEqual({ reset: false, delta: '' });
    });

    test('连续追加可链式累积还原全量', () => {
        let sent = '';
        let acc = '';
        for (const chunk of ['a', 'b\n', 'ccc\n']) {
            acc += chunk;
            const { reset, delta } = computeTerminalOutputDelta(sent, acc);
            expect(reset).toBe(false);
            expect(delta).toBe(chunk);
            sent = acc;
        }
        expect(sent).toBe('ab\nccc\n');
    });
});

/**
 * live tick 的增量帧必须在「剥离 ANSI 之后」求增量。
 *
 * 回归背景：渲染端整份渲染用的是 stripAnsi(toolcall.result)，而增量此前是在原始文本上
 * 切分、再逐段 stripAnsi。转义序列恰好跨 tick 边界时，前后两段各残留半个序列，
 * 「增量拼接结果」与「全量渲染结果」不再一致，要等终态全量渲染才自愈。
 */
describe('computeTerminalLiveOutputFrame', () => {
    test('未截断时返回剥离后的增量，且与全量剥离结果一致', () => {
        const frame = computeTerminalLiveOutputFrame('', '\u001b[32mok\u001b[0m line1\n');

        expect(frame.reset).toBe(false);
        expect(frame.delta).toBe('ok line1\n');
        expect(frame.stripped).toBe('ok line1\n');

        const next = computeTerminalLiveOutputFrame(frame.stripped, '\u001b[32mok\u001b[0m line1\nline2\n');
        expect(next.delta).toBe('line2\n');
        // 增量拼接 == 全量剥离
        expect(frame.delta + next.delta).toBe(next.stripped);
    });

    test('转义序列跨 tick 边界时，增量拼接仍与全量渲染逐字一致', () => {
        // tick1：输出停在转义序列中间（"\u001b[3"）
        const frame1 = computeTerminalLiveOutputFrame('', 'abc\u001b[3');
        expect(frame1.stripped).toBe('abc');
        expect(frame1.delta).toBe('abc');

        // tick2：补上剩余部分，完整序列 + 文本
        const frame2 = computeTerminalLiveOutputFrame(frame1.stripped, 'abc\u001b[31mred\u001b[0m');
        expect(frame2.stripped).toBe('abcred');
        expect(frame2.delta).toBe('red');
        // 若在原始文本上切分（旧实现），这里会残留 "31m" 之类的可见片段
        expect(frame1.delta + frame2.delta).toBe(frame2.stripped);
    });

    test('截断后前缀关系破坏 → reset 且 delta 为剥离后的全量文本', () => {
        const frame = computeTerminalLiveOutputFrame('head...tail-old', 'head...\u001b[33mmarker\u001b[0m...tail-new');

        expect(frame.reset).toBe(true);
        expect(frame.delta).toBe('head...marker...tail-new');
    });

    test('keeps an unfinished OSC or standalone escape pending until its next snapshot', () => {
        expect(computeTerminalLiveOutputFrame('', 'text\u001b]0;window title').stripped).toBe('text');
        expect(computeTerminalLiveOutputFrame('text', 'text\u001b]0;window title\u0007more').delta).toBe('more');
        expect(computeTerminalLiveOutputFrame('', 'text\u001b').stripped).toBe('text');
    });

    test.each(['\u0007', '\u001b\\', '\u009c'])(
        'completed OSC with terminator %j preserves following text',
        (terminator) => {
            expect(computeTerminalLiveOutputFrame('', `before\u001b]0;window title${terminator}after`)).toEqual({
                stripped: 'beforeafter',
                reset: false,
                delta: 'beforeafter'
            });
        }
    );

    test('an OSC and its ST terminator may span several snapshots without exposing control text', () => {
        let raw = '';
        let sent = '';
        for (const [chunk, expectedDelta] of [
            ['before\u001b]', 'before'],
            ['0;window title', ''],
            ['\u001b', ''],
            ['\\after', 'after']
        ]) {
            raw += chunk;
            const frame = computeTerminalLiveOutputFrame(sent, raw);
            expect(frame.reset).toBe(false);
            expect(frame.delta).toBe(expectedDelta);
            sent = frame.stripped;
        }
        expect(sent).toBe('beforeafter');
    });

    test.each(['\u001b', '\u001b[', '\u001b[3', '\u001b[31;', '\u001b[?25'])(
        'a pending escape or CSI suffix %j never enters a delta',
        (suffix) => {
            expect(computeTerminalLiveOutputFrame('text', `text${suffix}`)).toEqual({
                stripped: 'text',
                reset: false,
                delta: ''
            });
        }
    );

    test('complete styling and cursor sequences preserve ordinary bracket and semicolon text', () => {
        expect(
            computeTerminalLiveOutputFrame('', '\u001b[31m[3;window title\u001b[0m\u001b[?25h]0;plain').stripped
        ).toBe('[3;window title]0;plain');
    });
});
