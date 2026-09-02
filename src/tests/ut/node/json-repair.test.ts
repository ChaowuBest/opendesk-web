import assert from 'node:assert/strict';
import test from 'node:test';
import { jsonrepair } from 'jsonrepair';
import { parseJsonWithRepair, repairJsonString } from '../../../utils/json.js';

/**
 * jsonrepair 3.15 对「最后一个字符串值含未闭合花括号的合法 JSON」误判：
 * JSON.parse 成功但 jsonrepair 抛 JSONRepairError。这是 OpenDesk 中大量
 * editFile/searchReplace 工具调用失败的根因（参数 newString 常为未闭合代码片段）。
 */
const OPEN_BRACE = '\u007b'; // 字面量 '{'（用转义书写避免文件本身触发 jsonrepair bug）
// {"filePath": "a.ts", "oldString": "abc", "newString": "    foo() {"}
const TRIGGER_JSON = '{"filePath": "a.ts", "oldString": "abc", "newString": "    foo() ' + OPEN_BRACE + '"}';

test('bug 复现：含未闭合花括号的合法 JSON 会被 jsonrepair 误报', () => {
    assert.doesNotThrow(() => JSON.parse(TRIGGER_JSON));
    assert.throws(() => jsonrepair(TRIGGER_JSON));
});

test('parseJsonWithRepair 能解析含未闭合花括号的合法 JSON（绕开 jsonrepair bug）', () => {
    const parsed = parseJsonWithRepair<{ filePath: string; newString: string }>(TRIGGER_JSON);
    assert.equal(parsed.filePath, 'a.ts');
    assert.equal(parsed.newString, '    foo() ' + OPEN_BRACE);
});

test('parseJsonWithRepair 对坏 JSON（尾逗号）走 jsonrepair 修复', () => {
    assert.deepEqual(parseJsonWithRepair<{ a: number }>('{"a": 1,}'), { a: 1 });
});

test('parseJsonWithRepair 对无法修复的输入抛错', () => {
    assert.throws(() => parseJsonWithRepair('{"a": "b"} "extra"'));
});

test('repairJsonString 对合法 JSON 原样返回', () => {
    const s = '{"a": 1}';
    assert.equal(repairJsonString(s), s);
});

test('repairJsonString 对含未闭合花括号的合法 JSON 原样返回', () => {
    assert.equal(repairJsonString(TRIGGER_JSON), TRIGGER_JSON);
});

test('repairJsonString 对坏 JSON 返回修复结果', () => {
    assert.equal(repairJsonString('{"a": 1,}'), '{"a": 1}');
});

test('模拟任务中真实 editFile 参数：newString 为未闭合代码片段', () => {
    const args = {
        filePath: 'C:/Projects/OpenDesk/resources/plugins/feishu/feishu.mjs',
        oldString: '    _buildApprovalCard(payload) ' + OPEN_BRACE,
        newString:
            "        const confirmLabel = (payload.confirmLabel || 'Confirm').slice(0, 20);\n        return " +
            OPEN_BRACE
    };
    // 序列化后 oldString/newString 均含未闭合花括号，但整体是合法 JSON
    const json = JSON.stringify(args);
    assert.doesNotThrow(() => JSON.parse(json));
    const parsed = parseJsonWithRepair<{ oldString: string; newString: string }>(json);
    assert.equal(parsed.oldString, args.oldString);
    assert.equal(parsed.newString, args.newString);
});
