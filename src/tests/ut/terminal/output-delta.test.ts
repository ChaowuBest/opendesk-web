import { describe, expect, test } from '@jest/globals';
import { computeTerminalOutputDelta } from '../../../main/applications/terminal/output-delta.js';

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
