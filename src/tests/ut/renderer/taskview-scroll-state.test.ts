import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

/**
 * TaskView 滚动锁定状态与缩放（Ctrl/Cmd + /-、触控板捏合）事件的交互。
 *
 * 背景：滚动区域有两种状态——
 *  - auto_scrolling_to_bottom = true：锁定底部，持续跟随最新内容，不显示“滚动到底部”菜单；
 *  - auto_scrolling_to_bottom = false：用户手动滚动到历史，显示“滚动到底部”菜单。
 *
 * 复现的 bug：模型吐字（running）且锁定底部时，用户 Ctrl/Cmd +/- 缩放界面，
 * 会把缩放触发的 wheel/scroll 事件误判为“用户手动滚动”，从而错误解除锁定并弹出菜单。
 */
describe('task-view 滚动锁定状态与缩放事件', () => {
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
            enhanceToolPreviewCards: jest.fn()
        }));

        window.settingAPI = {
            loadSettingObject: async () => ({}),
            onSettingChanged: () => undefined
        };

        customElements.define(
            'agent-input',
            class extends HTMLElement {
                availableModels: unknown[] = [];
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
    });

    function createTaskView() {
        const taskView = document.createElement('task-view') as any;
        taskView.setAttribute('task_id', 'task-scroll-1');
        taskView.task_id = 'task-scroll-1';
        taskView.render();
        // createElement 不会触发 connectedCallback，需手动绑定事件监听器
        taskView.setUpEventListeners();
        return taskView;
    }

    function getHistory(taskView: any) {
        return taskView.querySelector('#taskview-chat-history') as HTMLElement & {
            scrollTop: number;
            scrollHeight: number;
            clientHeight: number;
        };
    }

    /** 覆盖 linkedom 只读的滚动/布局属性，模拟内容/布局变化后的滚动位置。 */
    function setScrollMetrics(
        container: HTMLElement & { scrollTop: number; scrollHeight: number; clientHeight: number },
        scrollTop: number,
        scrollHeight: number,
        clientHeight: number
    ) {
        Object.defineProperty(container, 'scrollTop', { value: scrollTop, configurable: true, writable: true });
        Object.defineProperty(container, 'scrollHeight', { value: scrollHeight, configurable: true, writable: true });
        Object.defineProperty(container, 'clientHeight', { value: clientHeight, configurable: true, writable: true });
    }

    /** 模拟内容/布局变化后 scrollTop 偏离底部（distanceToBottom = 1500 >= 80）。 */
    function mockScrolledAway(
        container: HTMLElement & { scrollTop: number; scrollHeight: number; clientHeight: number }
    ) {
        setScrollMetrics(container, 1000, 3000, 500);
    }

    function dispatchScroll(container: HTMLElement) {
        container.dispatchEvent(new window.Event('scroll'));
    }

    function dispatchWheel(container: HTMLElement, deltaY: number, ctrlKey = false, metaKey = false) {
        const event = new window.Event('wheel');
        Object.defineProperty(event, 'deltaY', { value: deltaY });
        Object.defineProperty(event, 'ctrlKey', { value: ctrlKey });
        Object.defineProperty(event, 'metaKey', { value: metaKey });
        container.dispatchEvent(event);
    }

    function dispatchKeyDown(key: string, ctrlKey = false) {
        // 注：linkedom 的 dispatchEvent 会强制将 event.target 设为 document，
        // 因此这里无法模拟"输入框内聚焦"的边界场景
        const event = new window.Event('keydown');
        Object.defineProperty(event, 'key', { value: key });
        Object.defineProperty(event, 'ctrlKey', { value: ctrlKey });
        document.dispatchEvent(event);
    }

    function dispatchPointerDown(container: HTMLElement, clientX: number, pointerType = 'mouse') {
        const event = new window.Event('pointerdown');
        Object.defineProperty(event, 'clientX', { value: clientX });
        Object.defineProperty(event, 'pointerType', { value: pointerType });
        container.dispatchEvent(event);
    }

    function dispatchTouchMove(container: HTMLElement) {
        container.dispatchEvent(new window.Event('touchmove'));
    }

    /** mock 布局：内容宽 900，滚动条位于 [900, 1000)，用于 pointerdown 命中滚动条判定。 */
    function mockScrollbarLayout(container: HTMLElement) {
        Object.defineProperty(container, 'clientWidth', { value: 900, configurable: true, writable: true });
        Object.defineProperty(container, 'getBoundingClientRect', {
            value: () => ({ left: 0 }),
            configurable: true
        });
    }

    test('缩放引起的被动 scroll（无用户滚动意图）不应解除底部锁定', () => {
        const taskView = createTaskView();
        const history = getHistory(taskView);
        taskView.setAutoScrollingToBottom(true);
        mockScrolledAway(history);
        taskView._lastUserScrollTs = 0;

        dispatchScroll(history);

        expect(taskView.auto_scrolling_to_bottom).toBe(true);
    });

    test('Ctrl+滚轮缩放（wheel + ctrlKey）不应解除底部锁定', () => {
        const taskView = createTaskView();
        const history = getHistory(taskView);
        taskView.setAutoScrollingToBottom(true);
        mockScrolledAway(history);
        taskView._lastUserScrollTs = 0;

        dispatchWheel(history, -100, true);

        expect(taskView.auto_scrolling_to_bottom).toBe(true);
    });

    test('Cmd/⌘+滚轮缩放（wheel + metaKey）不应解除底部锁定', () => {
        const taskView = createTaskView();
        const history = getHistory(taskView);
        taskView.setAutoScrollingToBottom(true);
        mockScrolledAway(history);
        taskView._lastUserScrollTs = 0;

        dispatchWheel(history, -100, false, true);

        expect(taskView.auto_scrolling_to_bottom).toBe(true);
    });

    test('普通滚轮向上滚动离开底部时仍正常解除锁定', () => {
        const taskView = createTaskView();
        const history = getHistory(taskView);
        taskView.setAutoScrollingToBottom(true);
        mockScrolledAway(history);

        dispatchWheel(history, -100);

        expect(taskView.auto_scrolling_to_bottom).toBe(false);
    });

    test('用户主动滚动意图后 scroll 离开底部时正常解除锁定', () => {
        const taskView = createTaskView();
        const history = getHistory(taskView);
        taskView.setAutoScrollingToBottom(true);
        mockScrolledAway(history);
        taskView._markUserScrollIntent();

        dispatchScroll(history);

        expect(taskView.auto_scrolling_to_bottom).toBe(false);
    });

    test('向下滚动接近底部时重新锁定（现有行为保持）', () => {
        const taskView = createTaskView();
        const history = getHistory(taskView);
        taskView.setAutoScrollingToBottom(false);
        setScrollMetrics(history, 2490, 3000, 500); // distanceToBottom = 10 < 80

        dispatchScroll(history);

        expect(taskView.auto_scrolling_to_bottom).toBe(true);
    });

    test('键盘滚动（PageDown）离开底部时正常解除锁定', () => {
        const taskView = createTaskView();
        const history = getHistory(taskView);
        taskView.setAutoScrollingToBottom(true);
        mockScrolledAway(history);

        dispatchKeyDown('PageDown');
        dispatchScroll(history);

        expect(taskView.auto_scrolling_to_bottom).toBe(false);
    });

    test('Ctrl+方向键（跳词）不标记滚动意图，不解除锁定', () => {
        const taskView = createTaskView();
        const history = getHistory(taskView);
        taskView.setAutoScrollingToBottom(true);
        mockScrolledAway(history);

        dispatchKeyDown('ArrowDown', true);
        dispatchScroll(history);

        expect(taskView.auto_scrolling_to_bottom).toBe(true);
    });

    test('拖动右侧滚动条（pointerdown 命中滚动条区域）离开底部时正常解除锁定', () => {
        const taskView = createTaskView();
        const history = getHistory(taskView);
        taskView.setAutoScrollingToBottom(true);
        mockScrolledAway(history);
        mockScrollbarLayout(history);

        dispatchPointerDown(history, 950); // 落在 [900, 1000) 滚动条区域
        dispatchScroll(history);

        expect(taskView.auto_scrolling_to_bottom).toBe(false);
    });

    test('在内容区点击（pointerdown 未命中滚动条）不标记意图，不解除锁定', () => {
        const taskView = createTaskView();
        const history = getHistory(taskView);
        taskView.setAutoScrollingToBottom(true);
        mockScrolledAway(history);
        mockScrollbarLayout(history);

        dispatchPointerDown(history, 100); // 落在内容区
        dispatchScroll(history);

        expect(taskView.auto_scrolling_to_bottom).toBe(true);
    });

    test('触控笔（pen）在内容区按下即视为滚动意图，离开底部时正常解除锁定', () => {
        const taskView = createTaskView();
        const history = getHistory(taskView);
        taskView.setAutoScrollingToBottom(true);
        mockScrolledAway(history);
        mockScrollbarLayout(history);

        dispatchPointerDown(history, 100, 'pen'); // pen 在内容区按下
        dispatchScroll(history);

        expect(taskView.auto_scrolling_to_bottom).toBe(false);
    });

    test('触摸拖动（touchmove）离开底部时正常解除锁定', () => {
        const taskView = createTaskView();
        const history = getHistory(taskView);
        taskView.setAutoScrollingToBottom(true);
        mockScrolledAway(history);

        dispatchTouchMove(history);
        dispatchScroll(history);

        expect(taskView.auto_scrolling_to_bottom).toBe(false);
    });

    test('纯点击（touchstart 无位移）不解除底部锁定', () => {
        const taskView = createTaskView();
        const history = getHistory(taskView);
        taskView.setAutoScrollingToBottom(true);
        mockScrolledAway(history);

        history.dispatchEvent(new window.Event('touchstart'));
        dispatchScroll(history);

        expect(taskView.auto_scrolling_to_bottom).toBe(true);
    });
});
