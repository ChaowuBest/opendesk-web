import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

/**
 * tool_call part 按卡片增量快路径的回归测试：
 * - canPatchToolCallCards：快路径判定（含 isRunning 参数时序回归）
 * - patchToolCallCards：按 toolcall 粒度更新卡片——终端卡追加输出/替换输出区，
 *   非终端卡整卡替换，卡片其余部分保持原节点
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
            untrackPreviewerContainers: jest.fn(),
            prepareSearchPreviews: async () => {},
            revealSearchPreview: jest.fn()
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

    describe('canPatchToolCallCards', () => {
        test('同 id 且前后均 running → 走快路径', () => {
            const progress = { last_part: toolCallPart('tc1', 'running') };
            const previousPart = toolCallPart('tc1', 'running');
            expect(TaskViewClass.canPatchToolCallCards(progress, previousPart, true)).toBe(true);
        });

        test('前一部分状态非 running（如首轮 live 更新前）→ 回退全量路径', () => {
            const progress = { last_part: toolCallPart('tc1', 'running') };
            const previousPart = toolCallPart('tc1', 'pending');
            expect(TaskViewClass.canPatchToolCallCards(progress, previousPart, true)).toBe(false);
        });

        test('任务非 running（工具已完成/终态）→ 回退全量路径', () => {
            const progress = { last_part: toolCallPart('tc1', 'success') };
            const previousPart = toolCallPart('tc1', 'running');
            expect(TaskViewClass.canPatchToolCallCards(progress, previousPart, false)).toBe(false);
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
            expect(TaskViewClass.canPatchToolCallCards(progress, previousPart, true)).toBe(false);

            const progressRenamed = { last_part: toolCallPart('tcX', 'running') };
            expect(TaskViewClass.canPatchToolCallCards(progressRenamed, previousPart, true)).toBe(false);
        });

        test('并行工具中部分已完成但状态未变时仍走快路径（避免每 tick 全量重渲整条消息）', () => {
            const progress = {
                last_part: {
                    type: 'tool_call',
                    rendered: '',
                    toolcalls: [
                        { id: 'tc1', status: 'running', outputDelta: 'x' },
                        { id: 'tc2', status: 'success' }
                    ]
                }
            };
            const previousPart = {
                type: 'tool_call',
                rendered: '',
                toolcalls: [
                    { id: 'tc1', status: 'running' },
                    { id: 'tc2', status: 'success' }
                ]
            };
            expect(TaskViewClass.canPatchToolCallCards(progress, previousPart, true)).toBe(true);
        });

        test('任一 toolcall 状态发生迁移 → 回退全量路径（否则终态卡片停在「运行中」）', () => {
            const progress = {
                last_part: {
                    type: 'tool_call',
                    rendered: '',
                    toolcalls: [
                        { id: 'tc1', status: 'running', outputDelta: 'x' },
                        { id: 'tc2', status: 'success' }
                    ]
                }
            };
            // 上一帧 tc2 仍是 running：本轮的成功终态必须靠全量渲染落到 DOM 上，
            // 不能被 tc1 的增量追加顺带吞掉。
            const previousPart = {
                type: 'tool_call',
                rendered: '',
                toolcalls: [
                    { id: 'tc1', status: 'running' },
                    { id: 'tc2', status: 'running' }
                ]
            };
            expect(TaskViewClass.canPatchToolCallCards(progress, previousPart, true)).toBe(false);
        });

        test('前一部分缺失或非 tool_call → 回退全量路径', () => {
            const progress = { last_part: toolCallPart('tc1', 'running') };
            expect(TaskViewClass.canPatchToolCallCards(progress, undefined, true)).toBe(false);
            expect(TaskViewClass.canPatchToolCallCards(progress, { type: 'text', text: 'x' }, true)).toBe(false);
        });

        test('last_part 缺失时安全返回 false', () => {
            expect(TaskViewClass.canPatchToolCallCards({}, toolCallPart('tc1', 'running'), true)).toBe(false);
        });
    });

    describe('patchToolCallCards', () => {
        test('只替换输出区域内容，卡片其余节点保持原引用', () => {
            const content = makeMessageContent('tc1', 'old output');
            const liveCard = content.querySelector('[data-toolcall-id="tc1"]')!;
            const liveSummary = liveCard.querySelector('summary')!;

            const freshHtml = terminalCardHtml('tc1', 'brand new output');
            const patched = TaskViewClass.patchToolCallCards(content, [{ id: 'tc1', status: 'running' }], freshHtml);

            expect(patched).toBe(true);
            expect(content.querySelector('[data-toolcall-id="tc1"]')).toBe(liveCard);
            expect(liveCard.querySelector('summary')).toBe(liveSummary);
            expect(liveCard.querySelector('.terminal-tool-output')!.textContent).toBe('brand new output');
        });

        test('DOM 中卡片缺失（如尚未渲染）→ 返回 false 且不改 DOM', () => {
            const content = makeMessageContent('tc-other', 'output');
            const before = content.innerHTML;
            const patched = TaskViewClass.patchToolCallCards(
                content,
                [{ id: 'tc1', status: 'running' }],
                terminalCardHtml('tc1', 'x')
            );
            expect(patched).toBe(false);
            expect(content.innerHTML).toBe(before);
        });

        test('rendered 中无对应终端卡片（非终端工具自定义渲染）→ 返回 false', () => {
            const content = makeMessageContent('tc1', 'output');
            const patched = TaskViewClass.patchToolCallCards(
                content,
                [{ id: 'tc1', status: 'running' }],
                '<div class="some-custom-tool-render">x</div>'
            );
            expect(patched).toBe(false);
        });

        test('rendered 为空或 toolcalls 为空 → 返回 false', () => {
            const content = makeMessageContent('tc1', 'output');
            expect(TaskViewClass.patchToolCallCards(content, [{ id: 'tc1', status: 'running' }], '')).toBe(false);
            expect(TaskViewClass.patchToolCallCards(content, [], terminalCardHtml('tc1', 'x'))).toBe(false);
        });

        test('同 part 多个运行中终端卡片全部替换', () => {
            const content = document.createElement('div');
            content.innerHTML = terminalCardHtml('tc1', 'a-old') + terminalCardHtml('tc2', 'b-old');
            const freshHtml = terminalCardHtml('tc1', 'a-new') + terminalCardHtml('tc2', 'b-new');
            const patched = TaskViewClass.patchToolCallCards(
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
                const patched = TaskViewClass.patchToolCallCards(
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
                const patched = TaskViewClass.patchToolCallCards(
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
                const patched = TaskViewClass.patchToolCallCards(
                    content,
                    [{ id: 'tc1', status: 'running', outputDelta: 'x' }],
                    terminalCardHtml('tc1', 'fresh')
                );
                expect(patched).toBe(false);
                expect(content.innerHTML).toBe(before);
            });

            test('无 outputDelta（旧主进程/非终端工具）→ 走既有全量路径', () => {
                const content = makeMessageContent('tc1', 'old');
                const patched = TaskViewClass.patchToolCallCards(
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
                const patched = TaskViewClass.patchToolCallCards(
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

            test('文本节点超过上限后合并，内容保持且节点数不再增长', () => {
                const content = makeMessageContent('tc1', '');
                const pre = content.querySelector('.terminal-tool-output')!;
                const limit = TaskViewClass.LIVE_OUTPUT_MAX_TEXT_NODES;
                let expected = '';

                for (let i = 0; i < limit + 10; i++) {
                    const delta = `chunk-${i};`;
                    expected += delta;
                    const patched = TaskViewClass.patchToolCallCards(
                        content,
                        [{ id: 'tc1', status: 'running', outputDelta: delta }],
                        ''
                    );
                    expect(patched).toBe(true);
                }

                expect(pre.textContent).toBe(expected);
                expect(pre.childNodes.length).toBeLessThanOrEqual(limit);
            });

            test('并行工具中已完成的卡片不参与增量，运行中的卡片照常追加', () => {
                const content = document.createElement('div');
                content.innerHTML = terminalCardHtml('tc1', 'live-') + terminalCardHtml('tc2', 'done');

                const patched = TaskViewClass.patchToolCallCards(
                    content,
                    [
                        { id: 'tc1', status: 'running', outputDelta: 'tail' },
                        { id: 'tc2', status: 'success' }
                    ],
                    ''
                );

                expect(patched).toBe(true);
                const outputs = [...content.querySelectorAll('.terminal-tool-output')].map((el) => el.textContent);
                expect(outputs).toEqual(['live-tail', 'done']);
            });

            test('增量内容以纯文本插入，不解析 HTML（防注入）', () => {
                const content = makeMessageContent('tc1', 'before');
                TaskViewClass.patchToolCallCards(
                    content,
                    [{ id: 'tc1', status: 'running', outputDelta: '<img src=x onerror=1>' }],
                    ''
                );
                const pre = content.querySelector('.terminal-tool-output')!;
                expect(pre.querySelector('img')).toBeNull();
                expect(pre.textContent).toBe('before<img src=x onerror=1>');
            });
        });

        describe('按 toolcall 粒度的非终端卡片增量替换', () => {
            /**
             * 非终端工具卡片（writeFile 等，主进程 ToolCall.render 统一补了
             * data-toolcall-id 根标识）。args 流式期间卡片详情每帧变化，
             * 快路径应整卡替换，而不是把整条消息退回全量渲染。
             */
            function writeFileCardHtml(id: string, detail: string) {
                return (
                    `<div data-toolcall-id="${id}" class="od-inline-toolcall-container">` +
                    `<div class="write-card-row"><span class="write-detail">${detail}</span></div>` +
                    `</div>`
                );
            }

            test('writeFile 卡片整卡替换，同 part 的终端卡片保持原节点', () => {
                const content = document.createElement('div');
                content.innerHTML = terminalCardHtml('tc-term', 'live output') + writeFileCardHtml('tc-write', 'a.txt');
                const termCard = content.querySelector('[data-toolcall-id="tc-term"]')!;
                const writeCard = content.querySelector('[data-toolcall-id="tc-write"]')!;

                const freshHtml =
                    terminalCardHtml('tc-term', 'live output') +
                    writeFileCardHtml('tc-write', 'a.txt · 正在写入 120 行');
                const patched = TaskViewClass.patchToolCallCards(
                    content,
                    [
                        { id: 'tc-term', status: 'running' },
                        { id: 'tc-write', status: 'running' }
                    ],
                    freshHtml
                );

                expect(patched).toBe(true);
                // 终端卡片节点未被重建：用户正在滚动的滚动条所在节点保持原引用
                expect(content.querySelector('[data-toolcall-id="tc-term"]')).toBe(termCard);
                expect(termCard.querySelector('.terminal-tool-output')!.textContent).toBe('live output');
                // 非终端卡片按 id 整卡替换为新渲染
                const newWriteCard = content.querySelector('[data-toolcall-id="tc-write"]')!;
                expect(newWriteCard).not.toBe(writeCard);
                expect(newWriteCard.querySelector('.write-detail')!.textContent).toContain('正在写入 120 行');
            });

            test('终端输出区有新全量内容时仍走输出区替换，卡片节点不变', () => {
                const content = document.createElement('div');
                content.innerHTML = terminalCardHtml('tc-term', 'old') + writeFileCardHtml('tc-write', 'd1');
                const termCard = content.querySelector('[data-toolcall-id="tc-term"]')!;

                const freshHtml = terminalCardHtml('tc-term', 'full text') + writeFileCardHtml('tc-write', 'd1');
                const patched = TaskViewClass.patchToolCallCards(
                    content,
                    [
                        { id: 'tc-term', status: 'running' },
                        { id: 'tc-write', status: 'running' }
                    ],
                    freshHtml
                );

                expect(patched).toBe(true);
                expect(content.querySelector('[data-toolcall-id="tc-term"]')).toBe(termCard);
                expect(termCard.querySelector('.terminal-tool-output')!.textContent).toBe('full text');
            });

            test('非终端卡片内容未变化时不重建节点', () => {
                const content = document.createElement('div');
                content.innerHTML = writeFileCardHtml('tc-write', 'same');
                const writeCard = content.querySelector('[data-toolcall-id="tc-write"]')!;

                const patched = TaskViewClass.patchToolCallCards(
                    content,
                    [{ id: 'tc-write', status: 'running' }],
                    writeFileCardHtml('tc-write', 'same')
                );

                expect(patched).toBe(true);
                expect(content.querySelector('[data-toolcall-id="tc-write"]')).toBe(writeCard);
                expect(writeCard.querySelector('.write-detail')).toBe(writeCard.querySelector('.write-detail'));
            });

            test('pending（args 流式期间）的非终端卡片同样整卡替换', () => {
                const content = document.createElement('div');
                content.innerHTML = writeFileCardHtml('tc-write', '');
                const patched = TaskViewClass.patchToolCallCards(
                    content,
                    [{ id: 'tc-write', status: 'pending' }],
                    writeFileCardHtml('tc-write', 'a.txt')
                );

                expect(patched).toBe(true);
                expect(content.querySelector('.write-detail')!.textContent).toBe('a.txt');
            });

            test('增量追加与非终端卡片替换可在同一帧共存（并行工具）', () => {
                const content = document.createElement('div');
                content.innerHTML = terminalCardHtml('tc-term', 'base-') + writeFileCardHtml('tc-write', 'old');
                const freshHtml = terminalCardHtml('tc-term', 'base-') + writeFileCardHtml('tc-write', 'new');
                const patched = TaskViewClass.patchToolCallCards(
                    content,
                    [
                        { id: 'tc-term', status: 'running', outputDelta: 'tail' },
                        { id: 'tc-write', status: 'running' }
                    ],
                    freshHtml
                );

                expect(patched).toBe(true);
                expect(content.querySelector('.terminal-tool-output')!.textContent).toBe('base-tail');
                expect(content.querySelector('.write-detail')!.textContent).toBe('new');
            });

            test('pending 终端卡片需要开合态归一 → 返回 false 走全量渲染', () => {
                const content = document.createElement('div');
                content.innerHTML = terminalCardHtml('tc-term', 'x');
                const before = content.innerHTML;
                const patched = TaskViewClass.patchToolCallCards(
                    content,
                    [{ id: 'tc-term', status: 'pending' }],
                    terminalCardHtml('tc-term', 'x')
                );

                expect(patched).toBe(false);
                expect(content.innerHTML).toBe(before);
            });

            test('需要刷新的非终端卡片在 DOM 中缺失 → 返回 false 且不改 DOM', () => {
                const content = document.createElement('div');
                content.innerHTML = terminalCardHtml('tc-term', 'x');
                const before = content.innerHTML;
                const patched = TaskViewClass.patchToolCallCards(
                    content,
                    [{ id: 'tc-write', status: 'pending' }],
                    writeFileCardHtml('tc-write', 'a.txt')
                );

                expect(patched).toBe(false);
                expect(content.innerHTML).toBe(before);
            });

            test('<details> 形态的非终端卡片替换时保留用户开合态', () => {
                const content = document.createElement('div');
                // 旧卡片被用户手动收起（无 open）
                content.innerHTML = `<details data-toolcall-id="tc-x" class="some-expandable-tool"><summary>s</summary><div>body-old</div></details>`;

                const patched = TaskViewClass.patchToolCallCards(
                    content,
                    [{ id: 'tc-x', status: 'running' }],
                    `<details data-toolcall-id="tc-x" class="some-expandable-tool" open><summary>s</summary><div>body-new</div></details>`
                );

                expect(patched).toBe(true);
                const card = content.querySelector('[data-toolcall-id="tc-x"]');
                expect(card?.hasAttribute('open')).toBe(false);
                expect(card!.textContent).toContain('body-new');
            });
        });
    });
});
