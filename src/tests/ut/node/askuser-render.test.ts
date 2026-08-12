/**
 * 验证 AskUserTool renderToolCall 的 GUI 渲染逻辑：
 * 1. running + prompting → body 显示简短等待提示，不展开问题详情
 * 2. running + !prompting → body 展示问题详情
 * 3. success → body 展示回答结果
 * 4. cancelled → body 显示取消文案
 * 5. error → body 显示红色错误
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

// 延迟加载，因为模块顶层有副作用
const { AskUserTool } = await import('../../../main/aikernel/interaction/tools.js');

const mockQuestions = [
    {
        question: '你想用哪个方案？',
        header: '选择方案',
        options: [
            { label: '方案A', description: '用 React 重构' },
            { label: '方案B', description: '保持 Vue' }
        ],
        multiple: false
    }
];

function makeToolCall(overrides: Record<string, unknown>) {
    return {
        index: 0,
        id: 'tc_test',
        name: 'askUser',
        args: JSON.stringify({ questions: mockQuestions }),
        args_object: { questions: mockQuestions },
        status: 'running',
        result: undefined,
        call_id: 'call_1',
        ...overrides
    } as any;
}

describe('AskUserTool renderToolCall (GUI)', () => {
    it('running + prompting → 展示等待提示而非问题详情', async () => {
        const tool = new AskUserTool();
        // 模拟 provider 正在 prompting
        tool.setProvider({ isPrompting: () => true } as any);

        const tc = makeToolCall({ status: 'running' });
        const html = await tool.renderToolCall(tc);

        assert.ok(html, '应返回 HTML');
        assert.ok(!html.includes('你想用哪个方案？'), '不应包含问题文本');
        assert.ok(html.includes('请在下方面板中回答'), '应包含等待提示');
        assert.ok(html.includes('ask-user-tool'), '应包含语义类');
        assert.ok(html.includes('等待回答'), '应包含等待状态徽章');
    });

    it('running + !prompting → 展示问题详情（防御分支）', async () => {
        const tool = new AskUserTool();
        tool.setProvider({ isPrompting: () => false } as any);

        const tc = makeToolCall({ status: 'running' });
        const html = await tool.renderToolCall(tc);

        assert.ok(html, '应返回 HTML');
        assert.ok(html.includes('你想用哪个方案？'), '应包含问题文本');
        assert.ok(html.includes('方案A'), '应包含选项A');
        assert.ok(html.includes('方案B'), '应包含选项B');
    });

    it('success → 展示回答结果', async () => {
        const tool = new AskUserTool();

        const tc = makeToolCall({
            status: 'success',
            result: JSON.stringify({ answers: { '0': ['方案A'] } })
        });
        const html = await tool.renderToolCall(tc);

        assert.ok(html, '应返回 HTML');
        assert.ok(html.includes('已回答'), '应包含成功状态徽章');
        assert.ok(html.includes('选择方案'), '应包含问题 header');
        assert.ok(html.includes('方案A'), '应包含选中答案');
        assert.ok(html.includes('bg-emerald-50'), '应使用翠绿徽章');
    });

    it('cancelled → 显示取消文案', async () => {
        const tool = new AskUserTool();

        const tc = makeToolCall({
            status: 'success',
            result: JSON.stringify({ answers: {}, cancelled: true })
        });
        const html = await tool.renderToolCall(tc);

        assert.ok(html, '应返回 HTML');
        assert.ok(html.includes('用户取消了本次询问'), '应包含取消文案');
        assert.ok(!html.includes('bg-emerald-50'), '不应包含成功徽章');
    });

    it('error → 显示红色错误', async () => {
        const tool = new AskUserTool();

        const tc = makeToolCall({
            status: 'error',
            result: '用户超时未响应'
        });
        const html = await tool.renderToolCall(tc);

        assert.ok(html, '应返回 HTML');
        assert.ok(html.includes('失败'), '应包含失败状态徽章');
        assert.ok(html.includes('用户超时未响应'), '应包含错误信息');
        assert.ok(html.includes('border-red-200'), '应使用红色边框');
    });

    it('多问题 success → 每条结果独立展示', async () => {
        const tool = new AskUserTool();

        const twoQuestions = [
            { question: 'Q1', header: 'H1', options: [{ label: 'A', description: '' }], multiple: false },
            { question: 'Q2', header: 'H2', options: [{ label: 'B', description: '' }], multiple: false }
        ];
        const tc = {
            index: 0,
            id: 'tc_test',
            name: 'askUser',
            args: JSON.stringify({ questions: twoQuestions }),
            args_object: { questions: twoQuestions },
            status: 'success',
            result: JSON.stringify({ answers: { '0': ['A'], '1': ['B'] } }),
            call_id: 'call_1'
        } as any;
        const html = await tool.renderToolCall(tc);

        assert.ok(html, '应返回 HTML');
        assert.ok(html.includes('H1'), '应包含第一题 header');
        assert.ok(html.includes('H2'), '应包含第二题 header');
        assert.ok(html.includes('A'), '应包含第一题答案');
        assert.ok(html.includes('B'), '应包含第二题答案');
    });
});
