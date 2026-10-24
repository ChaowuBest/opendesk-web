/**
 * Issue #332 回归测试：termination check 输入截断。
 *
 * 现象（反馈包 app-2026-10-21.log）：
 * - 中断判定发生在 lastTextResponse=53297/65087 字符的轮次，5 万+字符原文
 *   被整段塞进 termination check 的 prompt，judge 模型在超长输入下极易
 *   误判 interrupted（截断的数学推导天然"看起来没写完"）。
 * 修复：判定输入按窗口截断（上限 4000 字符），超长时取前 1000 + 末尾 3000，
 * 中间以省略标记衔接，兼顾开头上下文与结尾完整性判断。
 */
import { jest } from '@jest/globals';
import { LLM } from '../../../main/aikernel/llm.js';
import { checkTerminationFromMessages, fastInterruptionCheck } from '../../../main/aikernel/termination.js';
import { Setting } from '../../../main/utils/setting.js';

describe('termination check 输入截断 (issue #332)', () => {
    afterEach(() => {
        jest.restoreAllMocks();
        Setting.clearCache();
    });

    test('超长回复取前 1000 + 末尾 3000，中间以省略标记衔接', async () => {
        const askSpy = jest.spyOn(LLM, 'ask').mockResolvedValue('finished');
        const head = '引理陈述与记号约定：' + 'A'.repeat(995);
        const middle = 'M'.repeat(50_000);
        const tail = '推导过程从略。' + 'T'.repeat(2990) + '综上，证毕。';
        const response = head + middle + tail;
        expect(response.length).toBeGreaterThan(53_000);

        const result = await checkTerminationFromMessages('请证明引理', response, 'test-model');

        expect(result).toBe('finished');
        expect(askSpy).toHaveBeenCalledTimes(1);
        const prompt = askSpy.mock.calls[0][0] as string;
        // 开头上下文保留
        expect(prompt).toContain('引理陈述与记号约定');
        // 结尾完整性保留
        expect(prompt).toContain('综上，证毕。');
        // 中间有省略标记
        expect(prompt).toContain('省略');
        // prompt 体积有上界（回答窗口 4000 + 模板与问题），远小于原始 53K
        expect(prompt.length).toBeLessThan(6_000);
    });

    test('恰好 4000 字符不截断，4001 字符触发首尾截断', async () => {
        const askSpy = jest.spyOn(LLM, 'ask').mockResolvedValue('finished');

        await checkTerminationFromMessages('请证明引理', 'x'.repeat(4000), 'test-model');
        expect(askSpy.mock.calls[0][0] as string).not.toContain('省略');

        await checkTerminationFromMessages('请证明引理', 'x'.repeat(4001), 'test-model');
        expect(askSpy.mock.calls[1][0] as string).toContain('省略');
    });

    test('不超过窗口上限的回复不受影响', async () => {
        const askSpy = jest.spyOn(LLM, 'ask').mockResolvedValue('finished');

        const result = await checkTerminationFromMessages('请证明引理', '任务已完成，无遗留步骤。', 'test-model');

        expect(result).toBe('finished');
        const prompt = askSpy.mock.calls[0][0] as string;
        expect(prompt).toContain('任务已完成，无遗留步骤。');
        expect(prompt).not.toContain('省略');
    });

    test('fastInterruptionCheck 对以中文冒号结尾的截断文本保持命中', () => {
        expect(fastInterruptionCheck('首先读取配置文件：')).toBe('interrupted');
        expect(fastInterruptionCheck('任务已全部完成。')).toBeNull();
    });
});
