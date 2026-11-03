import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';

/**
 * 与 goal.test.ts / taskview-message-queue.test.ts 保持一致：
 * 部分 Node + Jest ESM 组合下，jest.useRealTimers() 恢复后会把计时器全局变量
 * 置为 undefined，因此在模块加载时保存真实计时器引用，恢复时显式写回 globalThis。
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

/**
 * 长任务历史流式渲染热路径的回归护栏（性能诊断基线）。
 *
 * 背景：任务历史较长时整个 UI 卡顿（renderer CPU ~109%、GPU ~25%），根因：
 * 1. reasoning 流式更新每帧把「全文」写进预览与全文节点（O(累计长度)/帧）；
 * 2. 已完成思考块的全文用 max-height:0 折叠，文本仍留在布局树参与每次强制回流；
 * 3. 流式文本每次合并更新都重新解析整份渲染快照。
 *
 * 修复后此处用确定性的工作量计数（而非墙钟时间）锁定修复效果：
 * - 流式思考只写尾部切片，全文节点折叠期间零写入、finalize 一次性回填；
 * - 全文区折叠态由 CSS display:none 移出布局树；
 * - 流式文本头部冻结，每次更新只解析变更尾部，且稳定块保持节点身份。
 */
describe('task-view long-history streaming hot path', () => {
    let TaskViewClass: any;

    /** 手动驱动的 RAF 队列：真实浏览器 RAF 是异步的，这里用显式 flush 复现相同语义。 */
    const rafQueue: FrameRequestCallback[] = [];

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
                rafQueue.push(callback);
                return rafQueue.length;
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
        window.taskManagerAPI = {};

        await import('../../../renderer/components/taskview.js');
        TaskViewClass = window.customElements.get('task-view');
        // 等待 loadSettingObject 的 promise 链完成，确保 taskViewT 已初始化
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    function flushRaf(): void {
        while (rafQueue.length > 0) {
            const callback = rafQueue.shift()!;
            callback(16);
        }
    }

    function spyTextContent(node: Element): { totalWritten: () => number } {
        let total = 0;
        Object.defineProperty(node, 'textContent', {
            configurable: true,
            get: () => (node.firstChild ? node.firstChild.data : ''),
            set: (next: unknown) => {
                const text = String(next);
                total += text.length;
                // 保持原生语义：真实重建子文本节点，保证后续 appendData 增量路径可命中
                while (node.firstChild) node.removeChild(node.firstChild);
                if (text) {
                    const textNode = node.ownerDocument.createTextNode(text);
                    const originalAppendData = textNode.appendData.bind(textNode);
                    textNode.appendData = (data: string) => {
                        total += String(data).length;
                        return originalAppendData(data);
                    };
                    node.appendChild(textNode);
                }
            }
        });
        return { totalWritten: () => total };
    }

    function createStreamingReasoningBlock(): HTMLElement {
        const host = document.createElement('div');
        host.innerHTML = TaskViewClass.createReasoningPartHtml('', true);
        return host.firstElementChild as HTMLElement;
    }

    function readCustomCss(): string {
        return readFileSync(new URL('../../../renderer/styles/custom.css', import.meta.url), 'utf8');
    }

    test('reasoning 流式更新只写尾部切片，全文节点折叠期间零写入', () => {
        jest.useFakeTimers();
        const el = createStreamingReasoningBlock();
        const previewNode = el.querySelector('.reasoning-preview-content');
        const fullNode = el.querySelector('.reasoning-content');
        const previewSpy = spyTextContent(previewNode);
        const fullSpy = spyTextContent(fullNode);

        try {
            const updates = 30;
            const charsPerUpdate = 1000;
            let text = '';
            for (let i = 0; i < updates; i += 1) {
                text += 'x'.repeat(charsPerUpdate);
                TaskViewClass.scheduleReasoningPreviewUpdate(el, text);
                flushRaf();
                jest.advanceTimersByTime(TaskViewClass.REASONING_UPDATE_FALLBACK_MS + 1);
            }

            // 每帧只写尾部切片：累计写入为 O(切片长度 × 帧数)，而非 O(累计长度 × 帧数)
            // （修复前该值 >10× 全文长度；O(delta) 实现约 1~2× 全文长度）
            const finalLength = text.length;
            expect(previewSpy.totalWritten()).toBeLessThan(finalLength * 2);
            // 全文节点折叠期间完全跳写
            expect(fullSpy.totalWritten()).toBe(0);
            // 预览始终是全文的尾部（行对齐切片不会破坏后缀关系）
            expect(text.endsWith(previewNode.textContent)).toBe(true);
        } finally {
            TaskViewClass.finalizeReasoningBlock(el);
            restoreRealTimerGlobals();
        }
    });

    test('finalize 一次性回填全文，折叠态由 CSS display:none 移出布局树', () => {
        jest.useFakeTimers();
        const el = createStreamingReasoningBlock();
        const text = 'y'.repeat(20000);
        try {
            TaskViewClass.scheduleReasoningPreviewUpdate(el, text);
            flushRaf();
            jest.advanceTimersByTime(TaskViewClass.REASONING_UPDATE_FALLBACK_MS + 1);
            // 流式期间全文区保持为空
            expect(el.querySelector('.reasoning-content')?.textContent).toBe('');

            TaskViewClass.finalizeReasoningBlock(el);

            // 完成后全文回填，展开可见完整内容
            expect(el.querySelector('.reasoning-content')?.textContent).toBe(text);
            // 折叠态的 display:none 来自样式表（而非内联），锁定修复不被回退
            const css = readCustomCss();
            expect(css).toMatch(/\.reasoning-block-od \.reasoning-full-area \{[^}]*display:\s*none/s);
        } finally {
            TaskViewClass.finalizeReasoningBlock(el);
            restoreRealTimerGlobals();
        }
    });

    test('展开态全文区随流式推进且每帧只追加增量（O(delta) 而非 O(全文)）', () => {
        jest.useFakeTimers();
        // 展开块：详细模式默认展开，全文区可见，必须实时刷新
        const host = document.createElement('div');
        host.innerHTML = TaskViewClass.createReasoningPartHtml('', true, 0, null, true);
        const el = host.firstElementChild as HTMLElement;
        const fullNode = el.querySelector('.reasoning-content');
        const fullSpy = spyTextContent(fullNode);

        try {
            const updates = 30;
            const charsPerUpdate = 1000;
            let text = '';
            for (let i = 0; i < updates; i += 1) {
                text += 'x'.repeat(charsPerUpdate);
                TaskViewClass.scheduleReasoningPreviewUpdate(el, text);
                flushRaf();
                jest.advanceTimersByTime(TaskViewClass.REASONING_UPDATE_FALLBACK_MS + 1);
                // 展开的全文区必须实时推进，不能空白到 finalize
                expect(fullNode.textContent).toBe(text);
            }

            // 前缀增量追加：累计写入 ≈ 全文长度（快照首帧 O(全文) + 每帧 O(delta)），
            // 而非每帧全量重写的 O(累计长度 × 帧数)
            expect(fullSpy.totalWritten()).toBeLessThan(text.length * 2);
        } finally {
            TaskViewClass.finalizeReasoningBlock(el);
            restoreRealTimerGlobals();
        }
    });

    test('渲染窗口内每条历史思考块全文仍被保留（display:none 折叠不影响展开回看）', () => {
        const reasoningChars = 8000;
        const pairs = 12;
        const messages: Array<Record<string, unknown>> = [];
        for (let i = 0; i < pairs; i += 1) {
            messages.push({
                role: 'user',
                message_id: `perf-user-${i}`,
                content: [{ type: 'text', rendered: `<p>question ${i}</p>` }]
            });
            messages.push({
                role: 'assistant',
                message_id: `perf-assistant-${i}`,
                content: [
                    { type: 'reasoning', rendered: 'r'.repeat(reasoningChars) },
                    { type: 'text', rendered: `<p>answer ${i}</p>` }
                ]
            });
        }

        const taskView = document.createElement('task-view') as any;
        taskView.task_id = 'perf-history';
        taskView.innerHTML = '<div id="taskview-chat-history"></div>';
        try {
            taskView._renderInitialHistoryWindow(messages);

            const history = taskView.querySelector('#taskview-chat-history');
            const fullAreas = Array.from(history.querySelectorAll('.reasoning-full-area')) as HTMLElement[];
            // 初始窗口上限 20 条消息 → 24 条中渲染最近的 20 条 = 10 对
            expect(fullAreas.length).toBe(10);

            let retained = 0;
            for (const area of fullAreas) {
                retained += (area.querySelector('.reasoning-content')?.textContent || '').length;
            }
            // 保留的思考全文总量 = 块数 × 单块长度（DOM 中保留供展开，布局成本由 CSS 折叠承担）
            expect(retained).toBe(fullAreas.length * reasoningChars);
        } finally {
            taskView.remove();
        }
    });

    test('流式文本头部冻结：每次更新只解析变更尾部，稳定块保持节点身份', async () => {
        const { updateStreamingText } = await import('../../../renderer/utils/streaming-text.js');
        const container = document.createElement('div');

        const originalCreateElement = document.createElement.bind(document);
        // 找到模板元素 innerHTML 的原始描述符，计数的同时保留真实解析行为
        let templateDescriptor: PropertyDescriptor | undefined;
        for (
            let proto = Object.getPrototypeOf(originalCreateElement('template'));
            proto;
            proto = Object.getPrototypeOf(proto)
        ) {
            templateDescriptor = Object.getOwnPropertyDescriptor(proto, 'innerHTML');
            if (templateDescriptor?.set) break;
            templateDescriptor = undefined;
        }
        let parsedChars = 0;
        (document as any).createElement = (tag: string, options?: ElementCreationOptions) => {
            const el = originalCreateElement(tag, options);
            if (tag === 'template' && templateDescriptor?.set) {
                Object.defineProperty(el, 'innerHTML', {
                    configurable: true,
                    get: templateDescriptor.get,
                    set: (next: string) => {
                        parsedChars += next.length;
                        templateDescriptor!.set!.call(el, next);
                    }
                });
            }
            return el;
        };

        try {
            const updates = 20;
            const charsPerUpdate = 2500;
            let html = '';
            for (let i = 0; i < updates; i += 1) {
                html += `<p>paragraph ${i} ${'z'.repeat(charsPerUpdate)}</p>`;
                updateStreamingText(container, html);
            }

            // 首次更新解析全量，此后每次只解析新增段落：
            // 累计解析量为 O(最终内容) 而非 O(更新次数 × 快照长度)
            expect(parsedChars).toBeLessThan(html.length * 2);
            expect(container.children).toHaveLength(updates);
            expect(container.textContent).toContain('paragraph 0');
            expect(container.textContent).toContain(`paragraph ${updates - 1}`);

            // 稳定头部块复用已挂载节点（复制按钮等增强不因流式更新而重建）
            const firstBlock = container.children[0];
            html += `<p>paragraph tail</p>`;
            updateStreamingText(container, html);
            expect(container.children[0]).toBe(firstBlock);
            expect(container.children).toHaveLength(updates + 1);
        } finally {
            (document as any).createElement = originalCreateElement;
        }
    });

    test('流式文本快照正确性：增长的尾块被整体替换，前部块被修订时退回全量解析', async () => {
        const { updateStreamingText } = await import('../../../renderer/utils/streaming-text.js');
        const container = document.createElement('div');

        // 尾部块增长（`</p>` 前追加字符）：不得产生重复/残留节点
        updateStreamingText(container, '<p>abc</p>');
        updateStreamingText(container, '<p>abcd</p>');
        expect(container.children).toHaveLength(1);
        expect(container.children[0].textContent).toBe('abcd');

        // 后到的语法修订前面的块：头部前缀比较失败 → 全量重解析，两块均正确
        updateStreamingText(container, '<p>A</p><p>B</p>');
        updateStreamingText(container, '<p><strong>A</strong></p><p>B</p>');
        expect(container.children).toHaveLength(2);
        expect(container.children[0].querySelector('strong')?.textContent).toBe('A');
        expect(container.children[1].textContent).toBe('B');
    });

    test('任务运行状态切换时同步 streaming 属性（流式期间禁用队列面板模糊）', () => {
        const taskView = document.createElement('task-view') as any;
        taskView.task_id = 'perf-streaming-attr';
        try {
            expect(taskView.hasAttribute('streaming')).toBe(false);

            taskView._handleTaskStatusUpdate('running');
            expect(taskView.hasAttribute('streaming')).toBe(true);

            taskView._handleTaskStatusUpdate('stopped');
            expect(taskView.hasAttribute('streaming')).toBe(false);
        } finally {
            taskView.remove();
        }
    });
});
