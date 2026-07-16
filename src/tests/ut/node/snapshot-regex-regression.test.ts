/**
 * 回归测试：验证 snapshot 中空白字符正则不会错误地过滤数字 "0"
 *
 * Bug 背景：snapshot.ts 中 SNAPSHOT_INJECTION 模板字符串内的正则表达式
 * 因过度转义（文件中 4 个反斜杠 → 正则匹配字面字符 \、s、u、0、A），
 * 导致 replace 时把所有 "0" 替换为空格。
 * 正确写法应是文件中 2 个反斜杠 → 正则中 \s = 空白字符类。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

// 模拟注入脚本中正确版本的正则（模板字符串中 \\s → 正则中 \s）
const CORRECT_REGEX = /[\s\u00A0]+/g;

// 模拟之前有 bug 版本的正则（模板字符串中 \\\\s → 正则中 \\s 匹配字面 \s）

const BUGGY_REGEX = /[\\s\\u00A0]+/g;

describe('snapshot 空白正则回归测试', () => {
    const testCases = [
        { input: '正常文本: 0天3小时', expected: '正常文本: 0天3小时' },
        { input: '0天3小时', expected: '0天3小时' },
        { input: '', expected: '' },
        { input: 'rowgroup', expected: 'rowgroup' },
        { input: 'step10_role=cell', expected: 'step10_role=cell' },
        { input: '  leading space', expected: 'leading space' },
        { input: 'trailing space  ', expected: 'trailing space' },
        { input: 'a\u00A0b\tc\nd', expected: 'a b c d' }
    ];

    for (const { input, expected } of testCases) {
        it(`正确正则不应损坏 "${input}"`, () => {
            const result = input.replace(CORRECT_REGEX, ' ').trim();
            assert.strictEqual(result, expected);
        });
    }

    it('bug 版本正则会过滤掉数字 0', () => {
        const result = '正常文本: 0天3小时'.replace(BUGGY_REGEX, ' ').trim();
        assert.notStrictEqual(result, '正常文本: 0天3小时');
        // 0 被替换为空格；原始文本 "正常文本: 0天3小时"
        // 冒号后原本有空格，0 也变空格 → 冒号后两个空格；trim 只去首尾
        assert.ok(result.includes('  '), '应该出现连续两个空格（原空格 + 0 变空格）');
    });

    it('bug 版本正则会损坏 "rowgroup" 中的 u', () => {
        const result = 'rowgroup'.replace(BUGGY_REGEX, ' ').trim();
        assert.notStrictEqual(result, 'rowgroup');
        // u 在字符类中，被替换为空格
        assert.ok(result.includes('rowgro'), 'rowgroup 中的 u 被替换');
    });
});
