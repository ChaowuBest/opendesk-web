import { afterEach, beforeAll, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

/**
 * 复现的 bug：OpenDesk 在后台运行重载任务（窗口最小化/被遮挡）时，任务视图仍是
 * 活跃视图，handleTaskUpdate 的丢帧条件只覆盖 display:none / data-background，
 * 不感知窗口可见性。backgroundThrottling 只节流 timer/rAF，IPC 到达后的 DOM 工作
 * 照常执行，后台期间持续积攒渲染债务；窗口拉回前台时合成器恢复需要主线程提交
 * 新帧，却被积压债务与 timer 补发潮占满，表现为回前台数秒 UI 不响应。
 *
 * 期望行为：窗口隐藏但视图活跃时，与视图不可见路径一致地丢帧（仅同步任务状态），
 * 并登记一次待补齐的 reload；窗口恢复可见（openDesk:visibilityChanged detail=true）
 * 时触发该 reload 补齐后台跳过的更新。
 */
describe('task-view 窗口隐藏期间的任务更新处理', () => {
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
            // linkedom 的 MutationObserver 回调要求节点有 ownerDocument；裸 HTMLElement
            // 实例没有该内部关联，appendChild 会炸。构造函数返回由 document 创建的
            // 真实元素（new 表达式结果即为其返回值），并挂上 connectedCallback 用到的方法。
            ElasticToolbarWidget: class {
                constructor() {
                    const el = document.createElement('elastic-toolbar-widget') as any;
                    el.setToolbarTitle = () => undefined;
                    el.setToolbarSubtitle = () => undefined;
                    return el;
                }
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
            // taskview 依赖链上的 chatFind/chatFindContent 消费这两个导出，
            // mock 缺失会导致整条 import 链模块链接失败
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
                setTaskLoading() {}
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

    // 可见性是全局可变状态：任一用例断言失败中断都会把 hidden / false 泄漏给
    // 后续用例（曾导致连锁误报），每个用例后统一复位
    afterEach(() => {
        window.__isWindowVisible = true;
        Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    });

    /** 终端类工具更新：AssistantProgressBuffer 对非文本快照同步渲染，可即时断言。 */
    const toolCallUpdate = {
        type: 'assistant',
        task_id: 'task-gate-1',
        task_status: 'running',
        message_id: 'm1',
        last_part_index: 1,
        last_part: { type: 'tool_call', rendered: '<div>tool</div>' }
    };

    async function createConnectedTaskView() {
        const taskView = document.createElement('task-view') as any;
        taskView.setAttribute('task_id', 'task-gate-1');
        taskView.task_id = 'task-gate-1';
        const subscribeTaskUpdate = jest.fn(async () => 'sub-1');
        window.taskManagerAPI = {
            getFullTask: jest.fn(async () => ({ task_id: 'task-gate-1', task_status: 'running' })),
            subscribeTaskUpdate,
            unsubscribeTaskUpdate: jest.fn(async () => undefined)
        };
        const reload = jest.fn(async () => undefined);
        taskView.reload = reload;
        // 不挂到 document（避免 linkedom 触发/不触发生命周期的歧义）：
        // connectedCallback 与 handleTaskUpdate 均检查 isConnected，覆盖为 true
        Object.defineProperty(taskView, 'isConnected', { value: true, configurable: true });
        window.__isWindowVisible = true;
        taskView.connectedCallback();
        // reload stub resolve → then 链创建 handleTaskUpdate → await subscribeTaskUpdate
        await new Promise((resolve) => setTimeout(resolve, 0));
        const handleTaskUpdate = subscribeTaskUpdate.mock.calls[0][1];
        const renderAssistantProgress = jest.fn();
        taskView._renderAssistantProgress = renderAssistantProgress;
        // connectedCallback 自身的 void this.reload() 已消耗 spy 首次调用，归零后
        // 各用例从 0 计数，只度量「窗口恢复可见触发的补齐 reload」
        reload.mockClear();
        return { taskView, handleTaskUpdate, reload, renderAssistantProgress };
    }

    /**
     * 模拟主进程恢复可见的联合行为：index.js 的全局监听器先更新
     * window.__isWindowVisible，随后 preload 派发 openDesk:visibilityChanged。
     */
    function dispatchWindowVisibility(visible: boolean) {
        window.__isWindowVisible = visible;
        window.dispatchEvent(new window.CustomEvent('openDesk:visibilityChanged', { detail: visible }));
    }

    /** 模拟 Chromium 遮挡检测解除：visibilityState 恢复可见后派发 visibilitychange。 */
    function dispatchDocumentVisible() {
        Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
        document.dispatchEvent(new window.Event('visibilitychange'));
    }

    test('复现：窗口最小化但视图活跃时，更新不再走渲染路径', async () => {
        const { taskView, handleTaskUpdate, renderAssistantProgress } = await createConnectedTaskView();
        window.__isWindowVisible = false;

        handleTaskUpdate(toolCallUpdate);

        expect(renderAssistantProgress).not.toHaveBeenCalled();
        expect(taskView.isConnected).toBe(true);
    });

    test('窗口可见时更新照常渲染', async () => {
        const { handleTaskUpdate, renderAssistantProgress } = await createConnectedTaskView();

        handleTaskUpdate(toolCallUpdate);

        expect(renderAssistantProgress).toHaveBeenCalledTimes(1);
    });

    test('丢帧后窗口恢复可见时 reload 补齐，且只补一次', async () => {
        const { handleTaskUpdate, reload } = await createConnectedTaskView();
        window.__isWindowVisible = false;

        handleTaskUpdate(toolCallUpdate);
        dispatchWindowVisibility(true);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(reload).toHaveBeenCalledTimes(1);

        // 没有新的丢帧，重复的可见事件不重复补齐
        dispatchWindowVisibility(true);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(reload).toHaveBeenCalledTimes(1);
    });

    test('后台期间多条更新合并为一次 reload', async () => {
        const { handleTaskUpdate, reload } = await createConnectedTaskView();
        window.__isWindowVisible = false;

        handleTaskUpdate(toolCallUpdate);
        handleTaskUpdate({ ...toolCallUpdate, last_part_index: 2 });
        handleTaskUpdate({ ...toolCallUpdate, last_part_index: 3 });
        dispatchWindowVisibility(true);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(reload).toHaveBeenCalledTimes(1);
    });

    test('50ms 缓冲快照跨隐藏边界丢弃时同样登记补齐', async () => {
        const { taskView, handleTaskUpdate, reload, renderAssistantProgress } = await createConnectedTaskView();
        // 文本快照在窗口可见时入缓冲（50ms 定时器挂起）
        handleTaskUpdate({
            type: 'assistant',
            task_id: 'task-gate-1',
            task_status: 'running',
            message_id: 'm1',
            last_part_index: 1,
            last_part: { type: 'text', rendered: '<span>partial</span>' }
        });
        window.__isWindowVisible = false;

        // 定时器在隐藏后到期：flush 走缓冲回调，快照被丢弃并登记补齐
        taskView._assistantProgressBuffer.flush();
        expect(renderAssistantProgress).not.toHaveBeenCalled();
        expect(reload).not.toHaveBeenCalled();

        dispatchWindowVisibility(true);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(reload).toHaveBeenCalledTimes(1);

        // 标记一次性：重复可见事件不重复补齐
        dispatchWindowVisibility(true);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(reload).toHaveBeenCalledTimes(1);
    });

    test('document.visibilityState 隐藏（遮挡检测）时同样丢帧', async () => {
        const { handleTaskUpdate, renderAssistantProgress } = await createConnectedTaskView();
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });

        try {
            handleTaskUpdate(toolCallUpdate);
            expect(renderAssistantProgress).not.toHaveBeenCalled();
        } finally {
            Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
        }
    });

    test('视图不可见路径保持既有语义：丢帧但不登记 reload（由 openTask 补齐）', async () => {
        const { taskView, handleTaskUpdate, reload, renderAssistantProgress } = await createConnectedTaskView();
        taskView.style.display = 'none';
        window.__isWindowVisible = false;

        handleTaskUpdate(toolCallUpdate);
        expect(renderAssistantProgress).not.toHaveBeenCalled();

        dispatchWindowVisibility(true);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(reload).not.toHaveBeenCalled();
    });

    test('窗口不可见但流式结束（状态迁移）仍同步任务状态', async () => {
        const { taskView, handleTaskUpdate, renderAssistantProgress } = await createConnectedTaskView();
        window.__isWindowVisible = false;
        taskView.task_status = 'running';

        handleTaskUpdate({ ...toolCallUpdate, task_status: 'stopped' });

        expect(renderAssistantProgress).not.toHaveBeenCalled();
        expect(taskView.task_status).toBe('stopped');
    });

    test('纯遮挡场景（主进程不感知）由 visibilitychange 补齐 reload', async () => {
        const { handleTaskUpdate, reload } = await createConnectedTaskView();
        // 窗口未被最小化/隐藏（主进程不发 visibilityChanged IPC，__isWindowVisible
        // 保持 true），仅被其他窗口完全遮挡：Chromium 将页面置为 hidden
        window.__isWindowVisible = true;
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });

        handleTaskUpdate(toolCallUpdate);

        // 窗口重新露出：只有渲染进程感知（无 IPC 事件），visibilitychange 触发消费
        dispatchDocumentVisible();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(reload).toHaveBeenCalledTimes(1);
    });

    test('IPC 先到而 visibilityState 尚未恢复时不提前补齐，恢复后再消费', async () => {
        const { handleTaskUpdate, reload } = await createConnectedTaskView();
        window.__isWindowVisible = false;

        handleTaskUpdate(toolCallUpdate);

        // 页面尚未恢复可见（hidden），主进程的恢复 IPC 先到达：不消费
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
        dispatchWindowVisibility(true);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(reload).not.toHaveBeenCalled();

        // visibilityState 恢复并派发 visibilitychange：消费
        dispatchDocumentVisible();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(reload).toHaveBeenCalledTimes(1);
    });

    test('reload 失败被吞掉，不产生 unhandled rejection', async () => {
        const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        const { taskView, handleTaskUpdate, reload } = await createConnectedTaskView();
        window.__isWindowVisible = false;

        handleTaskUpdate(toolCallUpdate);

        reload.mockImplementationOnce(async () => {
            throw new Error('getFullTask failed');
        });
        dispatchWindowVisibility(true);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(reload).toHaveBeenCalledTimes(1);
        expect(consoleError).toHaveBeenCalledWith(
            'Failed to reload task view after window became visible:',
            expect.any(Error)
        );
        consoleError.mockRestore();
    });
});
