import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTurnReasoningEffort } from '../../../../main/aikernel/task/completion.js';

void test('resolveTurnReasoningEffort 优先级：explicit > task > modelDefault', () => {
    // 1. 调用方显式档位优先
    assert.equal(resolveTurnReasoningEffort('high', 'low', 'medium'), 'high', 'explicit 应优先于 task 和 modelDefault');

    // 2. task 覆盖值次之
    assert.equal(resolveTurnReasoningEffort(undefined, 'low', 'medium'), 'low', 'task 应次优先于 modelDefault');

    // 3. 回退到 modelDefault（task 未设置）
    assert.equal(
        resolveTurnReasoningEffort(undefined, undefined, 'medium'),
        'medium',
        'task 为 undefined 时应回退到 modelDefault'
    );
});

void test('resolveTurnReasoningEffort 空字符串回退行为', () => {
    // '' 语义为「模型默认」，应回退到 modelDefault
    assert.equal(resolveTurnReasoningEffort(undefined, '', 'high'), 'high', 'task 为 "" 时应回退到 modelDefault');
});

void test('resolveTurnReasoningEffort 三者皆空/默认时返回模型默认档位', () => {
    assert.equal(
        resolveTurnReasoningEffort(undefined, undefined, undefined),
        undefined,
        '所有档位都为 undefined 时应返回 undefined'
    );
    // modelDefault 为 ""（模型默认）时返回 "" 而非 undefined：
    // 返回 undefined 会让 adapter 回退到 LLM.__getAdapter 缓存的旧档位，
    // 返回 "" 则明确表达「模型默认」并阻断该回退路径。
    assert.equal(resolveTurnReasoningEffort(undefined, undefined, ''), '', 'modelDefault 为 "" 时应保留 ""');
});

void test('resolveTurnReasoningEffort "none" 保持原样', () => {
    // "none" 是有效的 task 显式值，不应回退到 modelDefault
    assert.equal(
        resolveTurnReasoningEffort(undefined, 'none', 'medium'),
        'none',
        'task 为 "none" 时应保留，不回退到 modelDefault'
    );
});

void test('resolveTurnReasoningEffort explicit 为 "" 时保持原样', () => {
    // 调用方显式传 "" 时应保留（'' 是非 undefined，但具体场景中极少出现）
    assert.equal(resolveTurnReasoningEffort('', 'low', 'medium'), '', 'explicit 为 "" 时保留');
});
