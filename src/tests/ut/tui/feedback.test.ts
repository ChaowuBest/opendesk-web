/**
 * CLI 反馈弹窗组件测试。
 *
 * pi-tui 组件由 jest.config moduleNameMapper 注入的全局 mock 提供
 * （见 src/tests/ut/search/__mocks__/pi-tui-mock.ts），本文件不重复自定义，
 * 以免与全局 mapper 冲突导致全量并行下 mock 失效。
 */

import { jest, describe, expect, it } from '@jest/globals';

jest.mock('chalk', () => {
    const makeChain = (): any => {
        const fn = (arg: any) => {
            if (typeof arg === 'string' && arg.startsWith('#')) return makeChain();
            if (typeof arg === 'string') return arg;
            return makeChain();
        };
        return new Proxy(fn, {
            get: (_t, prop) => {
                if (prop === 'cursorShow') return '';
                return makeChain();
            },
            apply: (_t, _t2, args) => fn(args[0])
        });
    };
    return makeChain();
});

import {
    FeedbackWidget,
    type FeedbackSubmitter,
    type FeedbackSubmitResult
} from '../../../main/tui/components/feedback.js';
import { setRuntimeLocale } from '../../../locale/index.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function createMockTui() {
    let capturedFn: ((data: string) => any) | null = null;
    return {
        tui: {
            requestRender: jest.fn(),
            setFocus: jest.fn(),
            addInputListener: jest.fn((fn: (data: string) => any) => {
                capturedFn = fn;
                return jest.fn();
            })
        },
        inputArea: {
            showPromptWidget: jest.fn(),
            hasPromptWidget: jest.fn(() => true)
        },
        hasOpenOverlay: false,
        deferInputPromptIfBlockedByMode: jest.fn(() => false),
        closeInputPrompt: jest.fn(() => null),
        focusAfterInputPromptClose: jest.fn(),
        _getListener: () => capturedFn
    } as any;
}

function join(lines: string[]): string {
    return lines.join('\n');
}

describe('FeedbackWidget', () => {
    beforeEach(() => {
        setRuntimeLocale('zh-CN');
    });

    afterEach(() => {
        setRuntimeLocale(null);
    });

    it('首屏展示许愿池与 Bug 选项卡', () => {
        const tui = createMockTui();
        const widget = new FeedbackWidget(tui, {
            submitter: async () => ({ status: 'ok' }),
            tasks: [],
            currentTaskId: null
        });
        widget.show();
        const text = join(widget.render(80));
        expect(text).toContain('许愿池');
        expect(text).toContain('有Bug');
    });

    it('首屏 Enter 进入许愿池表单（仅提交按钮）', () => {
        const tui = createMockTui();
        const widget = new FeedbackWidget(tui, {
            submitter: async () => ({ status: 'ok' }),
            tasks: [],
            currentTaskId: null
        });
        widget.show();
        tui._getListener()('enter');
        const text = join(widget.render(80));
        expect(text).toContain('新功能名称');
        expect(text).toContain('功能需求内容');
        expect(text).toContain('提交');
        // 只有一个提交按钮，无返回按钮
        expect(text).not.toContain('返回');
    });

    it('填写后 Ctrl+S 提交，触发 submitter 并进入成功态', async () => {
        let submitted: any = null;
        const submitter: FeedbackSubmitter = async (s) => {
            submitted = s;
            return { status: 'ok', id: 1 };
        };
        const tui = createMockTui();
        const widget = new FeedbackWidget(tui, { submitter, tasks: [], currentTaskId: null });
        widget.show();
        tui._getListener()('enter'); // → feature 表单，焦点在 name
        // name 字段输入 'Hi'，Tab 切到 content 输入 'Dark'
        tui._getListener()('H');
        tui._getListener()('i');
        tui._getListener()('tab');
        tui._getListener()('D');
        tui._getListener()('a');
        tui._getListener()('r');
        tui._getListener()('k');
        tui._getListener()('\u0013'); // Ctrl+S（raw ctrl char）
        await flush();

        expect(submitted).not.toBeNull();
        expect(submitted.type).toBe('feature');
        expect(submitted.content).toContain('Hi');
        expect(submitted.content).toContain('Dark');
        expect(submitted.includeSystemLog).toBe(false);

        const text = join(widget.render(80));
        expect(text).toContain('反馈已提交');
    });

    it('Bug 表单勾选任务内容后出现任务下拉并可切换', () => {
        const tui = createMockTui();
        const widget = new FeedbackWidget(tui, {
            submitter: async () => ({ status: 'ok' }),
            tasks: [
                { taskId: 't1', name: 'Task One' },
                { taskId: 't2', name: 'Task Two' }
            ],
            currentTaskId: 't1'
        });
        widget.show();
        tui._getListener()('down'); // homeIndex → bug
        tui._getListener()('enter'); // → bug 表单（焦点在 content）
        let text = join(widget.render(80));
        expect(text).toContain('[×]'); // 系统日志默认勾选
        expect(text).not.toContain('任务名称'); // taskJson 未勾选

        tui._getListener()('tab'); // → checkbox（systemLog）
        tui._getListener()('down'); // → taskJson
        tui._getListener()('space'); // 勾选 taskJson（全局 pi-tui mock 的键语义）
        text = join(widget.render(80));
        expect(text).toContain('Task One (当前任务)');

        tui._getListener()('tab'); // → taskCycler
        tui._getListener()('down'); // 切到 Task Two
        text = join(widget.render(80));
        expect(text).toContain('Task Two');
    });

    it('内容为空时提交失败，不发起 submitter', async () => {
        let called = false;
        const submitter: FeedbackSubmitter = async () => {
            called = true;
            return { status: 'ok' };
        };
        const tui = createMockTui();
        const widget = new FeedbackWidget(tui, { submitter, tasks: [], currentTaskId: null });
        widget.show();
        tui._getListener()('down'); // → bug
        tui._getListener()('enter'); // bug 表单，焦点 content
        tui._getListener()('\u0013'); // Ctrl+S，内容为空
        await flush();
        expect(called).toBe(false);
        const text = join(widget.render(80));
        expect(text).toContain('请填写反馈内容');
    });

    it('提交失败后展示错误信息', async () => {
        const submitter: FeedbackSubmitter = async (): Promise<FeedbackSubmitResult> => ({
            status: 'error',
            message: 'HTTP 500'
        });
        const tui = createMockTui();
        const widget = new FeedbackWidget(tui, { submitter, tasks: [], currentTaskId: null });
        widget.show();
        tui._getListener()('enter'); // feature 表单
        tui._getListener()('T');
        tui._getListener()('e');
        tui._getListener()('s');
        tui._getListener()('t');
        tui._getListener()('tab'); // → content
        tui._getListener()('C');
        tui._getListener()('o');
        tui._getListener()('n');
        tui._getListener()('\u0013'); // Ctrl+S
        await flush();
        const text = join(widget.render(80));
        expect(text).toContain('提交失败：HTTP 500');
    });

    it('成功态 Enter 关闭弹窗', () => {
        const tui = createMockTui();
        const widget = new FeedbackWidget(tui, {
            submitter: async () => ({ status: 'ok' }),
            tasks: [],
            currentTaskId: null
        });
        widget.show();
        tui._getListener()('enter'); // home → form
        // 直接进入成功态验证关闭
        (widget as any).view = 'success';
        tui._getListener()('enter'); // close
        expect(tui.closeInputPrompt).toHaveBeenCalled();
    });
});
