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
    /** 最近一次创建 TaskView 时注册的 ResizeObserver 回调（模拟聊天区尺寸变化）。 */
    let resizeObserverCallback: (() => void) | null = null;

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
        // 模拟 ResizeObserver：捕获回调，供测试手动触发（模拟放大预览等布局变化）
        Object.defineProperty(window, 'ResizeObserver', {
            value: class {
                constructor(callback: () => void) {
                    resizeObserverCallback = callback;
                }
                observe() {}
                unobserve() {}
                disconnect() {}
            },
            configurable: true
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

    function dispatchWheel(
        container: HTMLElement,
        deltaY: number,
        ctrlKey = false,
        metaKey = false,
        composedPath?: EventTarget[]
    ) {
        const event = new window.Event('wheel', { bubbles: true });
        Object.defineProperty(event, 'deltaY', { value: deltaY });
        Object.defineProperty(event, 'ctrlKey', { value: ctrlKey });
        Object.defineProperty(event, 'metaKey', { value: metaKey });
        if (composedPath) Object.defineProperty(event, 'composedPath', { value: () => composedPath });
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

    test('快速导航内的方向键不应被识别为聊天区滚动意图', () => {
        const taskView = createTaskView();
        const history = getHistory(taskView);
        const rail = taskView.querySelector('.od-chat-nav-rail');
        const button = document.createElement('button');
        rail.append(button);
        taskView._lastUserScrollTs = 0;
        taskView.setAutoScrollingToBottom(true);
        mockScrolledAway(history);
        taskView._historyScrollKeydownHandler({ key: 'ArrowDown', target: button });
        dispatchScroll(history);
        expect(taskView.auto_scrolling_to_bottom).toBe(true);
        taskView._chatNavigation.destroy();
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

    test('向上滚轮在底部立即解锁，阻止待执行的自动滚动抢回位置', () => {
        const taskView = createTaskView();
        const history = getHistory(taskView);
        taskView.setAutoScrollingToBottom(true);
        setScrollMetrics(history, 2500, 3000, 500);
        taskView._programmaticScrolling = true;
        dispatchWheel(history, -20);
        expect(taskView.auto_scrolling_to_bottom).toBe(false);

        taskView._programmaticScrolling = false;
        setScrollMetrics(history, 2480, 3000, 500);
        dispatchScroll(history);
        expect(taskView.auto_scrolling_to_bottom).toBe(false);
        setScrollMetrics(history, 2480, 3100, 500);
        taskView.tryScrollToEnd();
        expect(history.scrollTop).toBe(2480);

        setScrollMetrics(history, 2590, 3100, 500);
        dispatchWheel(history, 20);
        expect(taskView.auto_scrolling_to_bottom).toBe(true);
    });

    test('内层终端可以消费向上滚轮时不解除外层自动跟随', () => {
        const taskView = createTaskView();
        const history = getHistory(taskView);
        setScrollMetrics(history, 2500, 3000, 500);
        const terminal = document.createElement('div');
        terminal.style.overflowY = 'auto';
        history.appendChild(terminal);
        setScrollMetrics(terminal as any, 200, 1000, 200);
        const original = window.getComputedStyle;
        window.getComputedStyle = ((el: HTMLElement) => el.style) as any;
        try {
            dispatchWheel(terminal, -100);
            expect(taskView.auto_scrolling_to_bottom).toBe(true);
            setScrollMetrics(terminal as any, 0, 1000, 200);
            terminal.style.overscrollBehaviorY = 'contain';
            dispatchWheel(terminal, -100);
            expect(taskView.auto_scrolling_to_bottom).toBe(true);
            terminal.style.overscrollBehaviorY = 'auto';
            dispatchWheel(terminal, -100);
            expect(taskView.auto_scrolling_to_bottom).toBe(false);
        } finally {
            window.getComputedStyle = original;
        }
    });

    test.each([
        { scrollTop: 200, deltaY: -100, overscroll: 'auto', before: true, after: true },
        { scrollTop: 0, deltaY: -100, overscroll: 'auto', before: true, after: false },
        { scrollTop: 0, deltaY: -100, overscroll: 'contain', before: true, after: true },
        { scrollTop: 400, deltaY: 100, overscroll: 'auto', before: false, after: false },
        { scrollTop: 800, deltaY: 100, overscroll: 'auto', before: false, after: true },
        { scrollTop: 800, deltaY: 100, overscroll: 'none', before: false, after: false }
    ])('Shadow DOM 预览按真实滚动路径决定跟随状态：%j', (scenario) => {
        const taskView = createTaskView();
        const history = getHistory(taskView);
        setScrollMetrics(history, 2500, 3000, 500);
        taskView.setAutoScrollingToBottom(scenario.before);
        const host = document.createElement('div');
        history.appendChild(host);
        const shadow = host.attachShadow({ mode: 'open' });
        const scroller = document.createElement('div');
        scroller.style.overflowY = 'auto';
        scroller.style.overscrollBehaviorY = scenario.overscroll;
        shadow.appendChild(scroller);
        const content = document.createElement('span');
        scroller.appendChild(content);
        setScrollMetrics(scroller as any, scenario.scrollTop, 1000, 200);
        const original = window.getComputedStyle;
        window.getComputedStyle = ((el: HTMLElement) => el.style) as any;
        try {
            // linkedom 不模拟 Shadow DOM 的事件重定向；显式提供浏览器的 target/path 组合。
            dispatchWheel(host, scenario.deltaY, false, false, [content, scroller, shadow, host, history]);
            expect(taskView.auto_scrolling_to_bottom).toBe(scenario.after);
        } finally {
            window.getComputedStyle = original;
            taskView.disconnectedCallback();
        }
    });

    test('无可滚动历史时向上滚轮不解除底部锁定', () => {
        const taskView = createTaskView();
        const history = getHistory(taskView);
        setScrollMetrics(history, 0, 500, 500);
        dispatchWheel(history, -20);
        expect(taskView.auto_scrolling_to_bottom).toBe(true);
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

    test('展开的过程块不再限高，只有完整思考区参与底部跟随', () => {
        const taskView = createTaskView();
        taskView.setAutoScrollingToBottom(true);
        const message = document.createElement('div');
        message.id = 'message-content-scroll-follow';
        message.innerHTML = `
            <div id="process-scroll-follow" class="od-process-detail is-open">
                <div class="reasoning-block-od reasoning-expanded">
                    <div class="reasoning-full-area" data-reasoning-scroll-key="0"></div>
                </div>
            </div>`;
        taskView.appendChild(message);

        const reasoning = message.querySelector('.reasoning-full-area') as HTMLElement;
        setScrollMetrics(reasoning, 120, 320, 200);
        const followState = taskView._captureProcessScrollFollowState(message);
        expect([...followState.keys()]).toEqual(['reasoning:0']);

        message.innerHTML = `
            <div id="process-scroll-follow" class="od-process-detail is-open">
                <div class="reasoning-block-od reasoning-expanded">
                    <div class="reasoning-full-area" data-reasoning-scroll-key="0"></div>
                </div>
            </div>`;
        const updatedReasoning = message.querySelector('.reasoning-full-area') as HTMLElement;
        setScrollMetrics(updatedReasoning, 120, 560, 200);

        taskView._restoreProcessScrollFollowState(message, followState);

        expect(updatedReasoning.scrollTop).toBe(360);
    });

    test('内部已向上滚动或外层已解除底部锁定时，思考区不强制跟随', () => {
        const taskView = createTaskView();
        taskView.setAutoScrollingToBottom(true);
        const message = document.createElement('div');
        message.id = 'message-content-scroll-detached';
        message.innerHTML = `
            <div class="od-process-detail is-open">
                <div class="reasoning-block-od reasoning-expanded">
                    <div class="reasoning-full-area" data-reasoning-scroll-key="0"></div>
                </div>
            </div>`;
        taskView.appendChild(message);
        const reasoning = message.querySelector('.reasoning-full-area') as HTMLElement;

        setScrollMetrics(reasoning, 80, 500, 300);
        const detachedState = taskView._captureProcessScrollFollowState(message);
        setScrollMetrics(reasoning, 80, 800, 300);
        taskView._restoreProcessScrollFollowState(message, detachedState);
        expect(reasoning.scrollTop).toBe(80);

        taskView.setAutoScrollingToBottom(false);
        setScrollMetrics(reasoning, 500, 800, 300);
        const unlockedState = taskView._captureProcessScrollFollowState(message);
        setScrollMetrics(reasoning, 500, 1000, 300);
        taskView._restoreProcessScrollFollowState(message, unlockedState);
        expect(reasoning.scrollTop).toBe(500);
    });

    // ------------------------------------------------------------------
    // 放大预览场景：侧边栏展开/收起、预览卡片加载等布局变化会导致聊天区
    // 尺寸变化，锁定状态下应重新滚到底部；预览区域内的键盘滚动不应被
    // 误判为聊天区滚动意图。
    // ------------------------------------------------------------------

    /** 直接调用 keydown 意图监听，模拟指定焦点目标（linkedom 无法自定义 dispatchEvent target）。 */
    function dispatchKeyDownWithTarget(taskView: any, key: string, target: unknown) {
        taskView._historyScrollKeydownHandler({ key, ctrlKey: false, metaKey: false, target });
    }

    test('放大预览（聊天区尺寸变化）后，锁定状态下重新滚到底部', () => {
        const taskView = createTaskView();
        const history = getHistory(taskView);
        taskView.setAutoScrollingToBottom(true);
        mockScrolledAway(history); // scrollTop=1000, scrollHeight=3000, clientHeight=500

        // 模拟侧边栏展开导致的聊天区尺寸变化
        resizeObserverCallback?.();

        // 锁定状态保持
        expect(taskView.auto_scrolling_to_bottom).toBe(true);
        // 且视图被重新滚到底部（target = 3000 - 500 = 2500）
        expect(history.scrollTop).toBe(2500);
    });

    test('放大预览后未锁定底部时，尺寸变化不强制滚动', () => {
        const taskView = createTaskView();
        const history = getHistory(taskView);
        taskView.setAutoScrollingToBottom(false);
        mockScrolledAway(history);

        resizeObserverCallback?.();

        expect(taskView.auto_scrolling_to_bottom).toBe(false);
        expect(history.scrollTop).toBe(1000);
    });

    test('焦点在右侧边栏预览中时键盘滚动不标记意图，不解除锁定', () => {
        const taskView = createTaskView();
        const history = getHistory(taskView);
        taskView.setAutoScrollingToBottom(true);
        mockScrolledAway(history);

        // 复用 render() 已创建的右侧边栏（task-artifacts），在其中放置获得焦点的元素
        const artifacts = taskView.querySelector('#task-task-scroll-1-artifacts');
        const focusTarget = document.createElement('button');
        artifacts.appendChild(focusTarget);

        dispatchKeyDownWithTarget(taskView, 'PageDown', focusTarget);
        dispatchScroll(history);

        expect(taskView.auto_scrolling_to_bottom).toBe(true);
    });

    test('焦点在画中画浮窗中时键盘滚动不标记意图，不解除锁定', () => {
        const taskView = createTaskView();
        const history = getHistory(taskView);
        taskView.setAutoScrollingToBottom(true);
        mockScrolledAway(history);

        const pip = document.createElement('div');
        pip.className = 'browser-pip';
        taskView.appendChild(pip);
        const focusTarget = document.createElement('button');
        pip.appendChild(focusTarget);

        dispatchKeyDownWithTarget(taskView, 'ArrowDown', focusTarget);
        dispatchScroll(history);

        expect(taskView.auto_scrolling_to_bottom).toBe(true);
    });

    test('焦点在聊天区消息内时键盘滚动仍正常解除锁定', () => {
        const taskView = createTaskView();
        const history = getHistory(taskView);
        taskView.setAutoScrollingToBottom(true);
        mockScrolledAway(history);

        const msg = document.createElement('div');
        history.appendChild(msg);

        dispatchKeyDownWithTarget(taskView, 'PageDown', msg);
        dispatchScroll(history);

        expect(taskView.auto_scrolling_to_bottom).toBe(false);
    });
});

describe('task-view 发送消息时强制进入滚动到底部状态', () => {
    function createTaskView() {
        const taskView = document.createElement('task-view') as any;
        taskView.setAttribute('task_id', 'task-scroll-send-1');
        taskView.task_id = 'task-scroll-send-1';
        taskView.render();
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

    function mockScrolledAway(
        container: HTMLElement & { scrollTop: number; scrollHeight: number; clientHeight: number }
    ) {
        Object.defineProperty(container, 'scrollTop', { value: 1000, configurable: true, writable: true });
        Object.defineProperty(container, 'scrollHeight', { value: 3000, configurable: true, writable: true });
        Object.defineProperty(container, 'clientHeight', { value: 500, configurable: true, writable: true });
    }

    /** 关闭发送流程中与滚动无关的 UI 副作用，保持测试聚焦。 */
    function stubSendSideEffects(taskView: any) {
        taskView.emitTaskStatusChanged = jest.fn();
        taskView._syncArtifactsTaskStatus = jest.fn();
        taskView._cancelBrowserIdleTimer = jest.fn();
        taskView.updateStopButtonVisibility = jest.fn();
        taskView._updateMessageQueuePanel = jest.fn();
    }

    test('输入新信息发送时，即使此前离开过底部也强制重新锁定并滚到底部', async () => {
        const prevAPI = window.taskManagerAPI;
        const taskView = createTaskView();
        const history = getHistory(taskView);
        taskView.setAutoScrollingToBottom(false);
        mockScrolledAway(history);
        window.taskManagerAPI = { submitMessage: jest.fn(async () => undefined) };
        taskView._isActiveGoalRunningNow = jest.fn(async () => false);
        taskView._showWaitingAssistantPlaceholder = jest.fn();
        stubSendSideEffects(taskView);

        const input = taskView.querySelector('#task-task-scroll-send-1-input');
        input.dispatchEvent(new window.CustomEvent('submit', { detail: { message: 'hello' } }));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(taskView.auto_scrolling_to_bottom).toBe(true);
        expect(history.scrollTop).toBe(2500);
        window.taskManagerAPI = prevAPI;
    });

    test('队列消息自动发出时，即使此前离开过底部也强制重新锁定并滚到底部', () => {
        const prevAPI = window.taskManagerAPI;
        const taskView = createTaskView();
        const history = getHistory(taskView);
        taskView.setAutoScrollingToBottom(false);
        mockScrolledAway(history);
        window.taskManagerAPI = { submitMessage: jest.fn(async () => undefined) };
        stubSendSideEffects(taskView);
        taskView.task_status = 'stopped';
        taskView.messageQueue = [
            {
                id: 'queue-1',
                message: 'queued message',
                attachedFilePaths: [],
                attachedImages: [],
                selectedModel: undefined,
                reasoningEffort: undefined,
                selectedExecutionNodeId: undefined
            }
        ];

        taskView._autoSendQueueMessages();

        expect(taskView.auto_scrolling_to_bottom).toBe(true);
        expect(history.scrollTop).toBe(2500);
        window.taskManagerAPI = prevAPI;
    });

    test('点击立即发送队列消息时，即使此前离开过底部也强制重新锁定并滚到底部', async () => {
        const prevAPI = window.taskManagerAPI;
        const taskView = createTaskView();
        const history = getHistory(taskView);
        taskView.setAutoScrollingToBottom(false);
        mockScrolledAway(history);
        window.taskManagerAPI = {
            interruptForNewMessage: jest.fn(async () => undefined),
            submitMessage: jest.fn(async () => undefined)
        };
        stubSendSideEffects(taskView);
        taskView.task_status = 'running';
        taskView.messageQueue = [
            {
                id: 'queue-1',
                message: 'send now',
                attachedFilePaths: [],
                attachedImages: [],
                selectedModel: undefined,
                reasoningEffort: undefined,
                selectedExecutionNodeId: undefined
            }
        ];
        taskView._handleRunningGoalInput = jest.fn(async () => undefined);

        await taskView.sendQueueMessageImmediately('queue-1');

        expect(taskView.auto_scrolling_to_bottom).toBe(true);
        expect(history.scrollTop).toBe(2500);
        window.taskManagerAPI = prevAPI;
    });
});

describe('task-view 流式快照期间滚动跟随不滞后', () => {
    function createTaskView() {
        const taskView = document.createElement('task-view') as any;
        taskView.setAttribute('task_id', 'task-scroll-follow-1');
        taskView.task_id = 'task-scroll-follow-1';
        taskView.render();
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

    /**
     * 复现 bug：工具流式刷新（主进程 ~8Hz 快照）期间，每次快照把聊天内容增高，
     * 滚动跟随的 150ms 节流窗口会让 DOM 增长与滚动执行之间出现最长 150ms 的滞后，
     * 期间滚动条 thumb 停在旧位置（相对上移），随后被拉回底部，形成每秒多次的
     * "上移-回落"抖动。修复后每次快照都在下一帧（rAF 合并）跟随到最新底部，不滞后。
     */
    test('锁定底部时，节流窗口内连续快照仍应立即跟随到最新底部', () => {
        const taskView = createTaskView();
        const history = getHistory(taskView);
        taskView.setAutoScrollingToBottom(true);
        setScrollMetrics(history, 2500, 3000, 500);

        // 快照 1：内容增高后触发滚动跟随，应滚到新底部（3300 - 500 = 2800）
        setScrollMetrics(history, 2500, 3300, 500);
        taskView.tryScrollToEnd();
        expect(history.scrollTop).toBe(2800);

        // 快照 2：紧跟其后的下一次流式刷新（仍在 150ms 节流窗口内），内容再次增高。
        // 手动清掉已消费的 rAF id，模拟真实浏览器中上一帧 rAF 已经执行完毕。
        taskView._scrollRafId = null;
        setScrollMetrics(history, 2800, 3600, 500);
        taskView.tryScrollToEnd();
        // 修复前：滚动被节流 timer 延迟，scrollTop 停留在 2800（滞后一整批快照）；
        // 修复后：rAF 合并，立即跟随到 3600 - 500 = 3100。
        expect(history.scrollTop).toBe(3100);
    });
});
