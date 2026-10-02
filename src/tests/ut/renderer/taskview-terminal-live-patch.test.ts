import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

/**
 * 终端 live 输出快路径的回归测试：
 * - canPatchRunningTerminalToolCall：快路径判定（含 isRunning 参数时序回归）
 * - patchRunningTerminalToolOutput：只替换卡片输出区域，卡片其余部分保持原节点
 *
 * 回归背景：判定逻辑曾以实例字段方式引用尚未声明的 isRunning（TDZ 崩溃），
 * 且提取为静态纯函数后需保证各回退条件不被误判。
 */
const realTimerGlobals = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    setImmediate: globalThis.setImmediate,
    clearImmediate: globalThis.clearImmediate
};

function restoreRealTimerGlobals(): void {
    jest.useRealTimers();
    Object.assign(globalThis, realTimerGlobals);
}

describe('task-view terminal live output fast path', () => {
    let TaskViewClass: any;

    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            CustomEvent: window.CustomEvent,
            customElements: window.customElements,
            MutationObserver: window.MutationObserver,
            Node: window.Node,
            sessionStorage: {
                getItem: () => null,
                removeItem: () => undefined
            },
            requestAnimationFrame: (callback: FrameRequestCallback) => {
                callback(0);
                return 0;
            },
            cancelAnimationFrame: () => undefined
        });
        Object.defineProperty(globalThis, 'navigator', {
            value: { languages: ['zh-CN'], language: 'zh-CN' },
            configurable: true
        });

        await jest.unstable_mockModule('../../../renderer/components/toolbar.ts', () => ({
            ElasticToolbarWidget: class extends HTMLElement {
                setToolbarTitle() {}
                setToolbarSubtitle() {}
            }
        }));
        await jest.unstable_mockModule('../../../renderer/components/taskartifacts.ts', () => ({}));
        await jest.unstable_mockModule('../../../renderer/components/browserPip.ts', () => ({
            BrowserPip: class {
                destroy() {}
                hide() {}
                isClosed() {
                    return false;
                }
                isVisible() {
                    return false;
                }
                resetClosed() {}
                show() {}
                triggerCapture() {}
            }
        }));
        await jest.unstable_mockModule('../../../renderer/components/imageLightbox.js', () => ({
            showImageLightbox: jest.fn()
        }));
        await jest.unstable_mockModule('../../../renderer/components/previewer.ts', () => ({
            enhanceCodeBlocks: jest.fn(),
            enhanceToolPreviewCards: jest.fn(),
            renderMermaidBlocks: jest.fn(),
            untrackPreviewerContainers: jest.fn()
        }));

        window.settingAPI = {
            loadSettingObject: async () => ({}),
            onSettingChanged: () => undefined
        };

        customElements.define(
            'agent-input',
            class extends HTMLElement {
                availableModels: unknown[] = [];
                attachedImages: unknown[] = [];
                setDisabled() {}
                setModel() {}
                setReasoningEffort() {}
                setStopMode() {}
                setSlashCommandContext() {}
            }
        );
        customElements.define(
            'message-queue-panel',
            class extends HTMLElement {
                setCallbacks() {}
                setQueue() {}
            }
        );

        await import('../../../renderer/components/taskview.js');
        TaskViewClass = customElements.get('task-view');
    });

    afterAll(() => {
        restoreRealTimerGlobals();
    });

    function toolCallPart(id: string, status: string) {
        return {
            type: 'tool_call',
            rendered: terminalCardHtml(id, 'output'),
            toolcalls: [{ id, status }]
        };
    }

    function terminalCardHtml(id: string, output: string) {
        return (
            `<details data-toolcall-id="${id}" class="terminal-tool" open>` +
            `<summary class="terminal-tool-summary">cmd</summary>` +
            `<div class="terminal-tool-scroll"><pre class="terminal-tool-output">${output}</pre></div>` +
            `</details>`
        );
    }

    function makeMessageContent(cardId: string, output: string) {
        const container = document.createElement('div');
        container.innerHTML = terminalCardHtml(cardId, output);
        return container;
    }

    describe('canPatchRunningTerminalToolCall', () => {
        test('同 id 且前后均 running → 走快路径', () => {
            const progress = { last_part: toolCallPart('tc1', 'running') };
            const previousPart = toolCallPart('tc1', 'running');
            expect(TaskViewClass.canPatchRunningTerminalToolCall(progress, previousPart, true)).toBe(true);
        });

        test('前一部分状态非 running（如首轮 live 更新前）→ 回退全量路径', () => {
            const progress = { last_part: toolCallPart('tc1', 'running') };
            const previousPart = toolCallPart('tc1', 'pending');
            expect(TaskViewClass.canPatchRunningTerminalToolCall(progress, previousPart, true)).toBe(false);
        });

        test('任务非 running（工具已完成/终态）→ 回退全量路径', () => {
            const progress = { last_part: toolCallPart('tc1', 'success') };
            const previousPart = toolCallPart('tc1', 'running');
            expect(TaskViewClass.canPatchRunningTerminalToolCall(progress, previousPart, false)).toBe(false);
        });

        test('toolcall 数量或 id 不一致 → 回退全量路径', () => {
            const previousPart = toolCallPart('tc1', 'running');
            const progress = {
                last_part: {
                    type: 'tool_call',
                    rendered: '',
                    toolcalls: [
                        { id: 'tc1', status: 'running' },
                        { id: 'tc2', status: 'running' }
                    ]
                }
            };
            expect(TaskViewClass.canPatchRunningTerminalToolCall(progress, previousPart, true)).toBe(false);

            const progressRenamed = { last_part: toolCallPart('tcX', 'running') };
            expect(TaskViewClass.canPatchRunningTerminalToolCall(progressRenamed, previousPart, true)).toBe(false);
        });

        test('前一部分缺失或非 tool_call → 回退全量路径', () => {
            const progress = { last_part: toolCallPart('tc1', 'running') };
            expect(TaskViewClass.canPatchRunningTerminalToolCall(progress, undefined, true)).toBe(false);
            expect(TaskViewClass.canPatchRunningTerminalToolCall(progress, { type: 'text', text: 'x' }, true)).toBe(
                false
            );
        });

        test('last_part 缺失时安全返回 false', () => {
            expect(TaskViewClass.canPatchRunningTerminalToolCall({}, toolCallPart('tc1', 'running'), true)).toBe(false);
        });
    });

    describe('patchRunningTerminalToolOutput', () => {
        test('只替换输出区域内容，卡片其余节点保持原引用', () => {
            const content = makeMessageContent('tc1', 'old output');
            const liveCard = content.querySelector('[data-toolcall-id="tc1"]')!;
            const liveSummary = liveCard.querySelector('summary')!;

            const freshHtml = terminalCardHtml('tc1', 'brand new output');
            const patched = TaskViewClass.patchRunningTerminalToolOutput(
                content,
                [{ id: 'tc1', status: 'running' }],
                freshHtml
            );

            expect(patched).toBe(true);
            expect(content.querySelector('[data-toolcall-id="tc1"]')).toBe(liveCard);
            expect(liveCard.querySelector('summary')).toBe(liveSummary);
            expect(liveCard.querySelector('.terminal-tool-output')!.textContent).toBe('brand new output');
        });

        test('DOM 中卡片缺失（如尚未渲染）→ 返回 false 且不改 DOM', () => {
            const content = makeMessageContent('tc-other', 'output');
            const before = content.innerHTML;
            const patched = TaskViewClass.patchRunningTerminalToolOutput(
                content,
                [{ id: 'tc1', status: 'running' }],
                terminalCardHtml('tc1', 'x')
            );
            expect(patched).toBe(false);
            expect(content.innerHTML).toBe(before);
        });

        test('rendered 中无对应终端卡片（非终端工具自定义渲染）→ 返回 false', () => {
            const content = makeMessageContent('tc1', 'output');
            const patched = TaskViewClass.patchRunningTerminalToolOutput(
                content,
                [{ id: 'tc1', status: 'running' }],
                '<div class="some-custom-tool-render">x</div>'
            );
            expect(patched).toBe(false);
        });

        test('rendered 为空或 toolcalls 为空 → 返回 false', () => {
            const content = makeMessageContent('tc1', 'output');
            expect(TaskViewClass.patchRunningTerminalToolOutput(content, [{ id: 'tc1', status: 'running' }], '')).toBe(
                false
            );
            expect(TaskViewClass.patchRunningTerminalToolOutput(content, [], terminalCardHtml('tc1', 'x'))).toBe(false);
        });

        test('同 part 多个运行中终端卡片全部替换', () => {
            const content = document.createElement('div');
            content.innerHTML = terminalCardHtml('tc1', 'a-old') + terminalCardHtml('tc2', 'b-old');
            const freshHtml = terminalCardHtml('tc1', 'a-new') + terminalCardHtml('tc2', 'b-new');
            const patched = TaskViewClass.patchRunningTerminalToolOutput(
                content,
                [
                    { id: 'tc1', status: 'running' },
                    { id: 'tc2', status: 'running' }
                ],
                freshHtml
            );
            expect(patched).toBe(true);
            const outputs = [...content.querySelectorAll('.terminal-tool-output')].map((el) => el.textContent);
            expect(outputs).toEqual(['a-new', 'b-new']);
        });

        describe('incremental outputDelta fast path', () => {
            test('携带 outputDelta 时只追加文本，不解析 part HTML', () => {
                const content = makeMessageContent('tc1', 'base');
                const liveCard = content.querySelector('[data-toolcall-id="tc1"]')!;
                const livePre = liveCard.querySelector('.terminal-tool-output')!;
                const patched = TaskViewClass.patchRunningTerminalToolOutput(
                    content,
                    [{ id: 'tc1', status: 'running', outputDelta: ' new tail' }],
                    '' // 增量路径不依赖 rendered
                );
                expect(patched).toBe(true);
                expect(content.querySelector('[data-toolcall-id="tc1"]')).toBe(liveCard);
                expect(content.querySelector('.terminal-tool-output')).toBe(livePre);
                expect(livePre.textContent).toBe('base new tail');
            });

            test('outputReset 为 true 时整体重写输出区（缓冲截断）', () => {
                const content = makeMessageContent('tc1', 'head that is now gone');
                const patched = TaskViewClass.patchRunningTerminalToolOutput(
                    content,
                    [{ id: 'tc1', status: 'running', outputDelta: 'head+tail', outputReset: true }],
                    ''
                );
                expect(patched).toBe(true);
                expect(content.querySelector('.terminal-tool-output')!.textContent).toBe('head+tail');
            });

            test('卡片缺失时增量失败 → 返回 false 由上层全量渲染兜底', () => {
                const content = makeMessageContent('tc-other', 'output');
                const before = content.innerHTML;
                const patched = TaskViewClass.patchRunningTerminalToolOutput(
                    content,
                    [{ id: 'tc1', status: 'running', outputDelta: 'x' }],
                    terminalCardHtml('tc1', 'fresh')
                );
                expect(patched).toBe(false);
                expect(content.innerHTML).toBe(before);
            });

            test('无 outputDelta（旧主进程/非终端工具）→ 走既有全量路径', () => {
                const content = makeMessageContent('tc1', 'old');
                const patched = TaskViewClass.patchRunningTerminalToolOutput(
                    content,
                    [{ id: 'tc1', status: 'running' }],
                    terminalCardHtml('tc1', 'full replace')
                );
                expect(patched).toBe(true);
                expect(content.querySelector('.terminal-tool-output')!.textContent).toBe('full replace');
            });

            test('同 part 多卡片全部增量追加', () => {
                const content = document.createElement('div');
                content.innerHTML = terminalCardHtml('tc1', 'a') + terminalCardHtml('tc2', 'b');
                const patched = TaskViewClass.patchRunningTerminalToolOutput(
                    content,
                    [
                        { id: 'tc1', status: 'running', outputDelta: 'A' },
                        { id: 'tc2', status: 'running', outputDelta: 'B' }
                    ],
                    ''
                );
                expect(patched).toBe(true);
                const outputs = [...content.querySelectorAll('.terminal-tool-output')].map((el) => el.textContent);
                expect(outputs).toEqual(['aA', 'bB']);
            });

            test('增量内容以纯文本插入，不解析 HTML（防注入）', () => {
                const content = makeMessageContent('tc1', 'before');
                TaskViewClass.patchRunningTerminalToolOutput(
                    content,
                    [{ id: 'tc1', status: 'running', outputDelta: '<img src=x onerror=1>' }],
                    ''
                );
                const pre = content.querySelector('.terminal-tool-output')!;
                expect(pre.querySelector('img')).toBeNull();
                expect(pre.textContent).toBe('before<img src=x onerror=1>');
            });
        });
    });
});
