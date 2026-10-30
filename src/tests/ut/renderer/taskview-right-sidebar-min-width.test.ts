import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

/**
 * 右侧面板向左弹出（展开）时，TaskView 的聊天区必须保留至少 350px 的显示空间。
 * 约束需要覆盖三条写入面板宽度的路径：展开/恢复、拖拽调整、工作空间聚焦布局（70%）。
 */
const MIN_CHAT_AREA_WIDTH = 350;
const RESIZER_WIDTH = 4;

function expectedChatWidth(containerWidth: number, panelWidth: string): number {
    return containerWidth - Number.parseFloat(panelWidth) - RESIZER_WIDTH;
}

describe('task-view right sidebar keeps the chat area at least 350px wide', () => {
    let pendingAnimationFrames: FrameRequestCallback[] = [];
    let animationFrameId = 0;

    /** 运行已排队的动画帧回调（拖拽与动画都通过 rAF 落地宽度） */
    function flushAnimationFrames(): void {
        const pending = pendingAnimationFrames;
        pendingAnimationFrames = [];
        for (const callback of pending) callback(0);
    }

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
                pendingAnimationFrames.push(callback);
                animationFrameId += 1;
                return animationFrameId;
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

    /** linkedom 未提供可构造的 PointerEvent，用 Event 补齐 button/clientX/pointerId */
    function pointerEvent(type: string, clientX: number, pointerId = 1): Event {
        const event = new window.Event(type, { bubbles: true, cancelable: true }) as Event & {
            clientX: number;
            button: number;
            pointerId: number;
        };
        Object.defineProperty(event, 'clientX', { value: clientX });
        Object.defineProperty(event, 'button', { value: 0 });
        Object.defineProperty(event, 'pointerId', { value: pointerId });
        return event;
    }

    /** 渲染一个已展开右侧面板的 TaskView，并把内容行模拟成指定宽度 */
    function renderExpandedTaskView(containerWidth: number) {
        const taskView = document.createElement('task-view') as any;
        taskView.task_id = 'task-1';
        taskView._rightSidebarExpanded = true;
        taskView.render();

        const container = taskView.querySelector<HTMLElement>('#task-task-1-content-row')!;
        Object.defineProperty(container, 'clientWidth', {
            configurable: true,
            writable: true,
            value: containerWidth
        });
        container.getBoundingClientRect = () =>
            ({
                right: containerWidth,
                left: 0,
                top: 0,
                bottom: 600,
                width: containerWidth,
                height: 600,
                x: 0,
                y: 0
            }) as DOMRect;

        return {
            taskView,
            container,
            artifacts: taskView.querySelector<HTMLElement>('#task-task-1-artifacts')!,
            resizer: taskView.querySelector<HTMLElement>('#task-task-1-resizer')!
        };
    }

    test('expanding on a narrow container shrinks the panel instead of the chat area', () => {
        const { taskView, artifacts, resizer, container } = renderExpandedTaskView(700);
        taskView._rightSidebarWidth = 380;

        taskView._expandRightSidebar(artifacts, resizer);
        flushAnimationFrames();

        expect(artifacts.style.width).toBe('346px');
        expect(expectedChatWidth(container.clientWidth, artifacts.style.width)).toBeGreaterThanOrEqual(
            MIN_CHAT_AREA_WIDTH
        );
    });

    test('keeps the preferred panel width when the container is wide enough', () => {
        const { taskView, artifacts, resizer } = renderExpandedTaskView(1600);
        taskView._rightSidebarWidth = 380;

        taskView._expandRightSidebar(artifacts, resizer);
        flushAnimationFrames();

        expect(artifacts.style.width).toBe('380px');
    });

    test('dragging the resizer cannot push the chat area below the minimum width', () => {
        const { artifacts, resizer } = renderExpandedTaskView(1000);

        // 触摸拖动不会派发 mousemove，拖拽必须走指针事件
        resizer.dispatchEvent(pointerEvent('pointerdown', 600));
        window.dispatchEvent(pointerEvent('pointermove', 500));
        flushAnimationFrames();
        expect(artifacts.style.width).toBe('500px');

        // 1000 - 100 = 900 > 上限 646，拖拽被忽略
        window.dispatchEvent(pointerEvent('pointermove', 100));
        flushAnimationFrames();
        expect(artifacts.style.width).toBe('500px');

        // 上限 1000 - 350 - 4 = 646，正好落在边界上时仍然生效
        window.dispatchEvent(pointerEvent('pointermove', 354));
        flushAnimationFrames();
        expect(artifacts.style.width).toBe('646px');

        window.dispatchEvent(pointerEvent('pointerup', 354));
    });

    test('dragging keeps following the pointer that started it', () => {
        const { artifacts, resizer } = renderExpandedTaskView(1000);

        resizer.dispatchEvent(pointerEvent('pointerdown', 600));
        window.dispatchEvent(pointerEvent('pointermove', 500));
        flushAnimationFrames();
        expect(artifacts.style.width).toBe('500px');

        // 触摸屏上的第二根手指（掌压）既不能改宽度，也不能把拖动提前结束
        window.dispatchEvent(pointerEvent('pointermove', 700, 2));
        flushAnimationFrames();
        expect(artifacts.style.width).toBe('500px');

        window.dispatchEvent(pointerEvent('pointerup', 700, 2));
        window.dispatchEvent(pointerEvent('pointermove', 450));
        flushAnimationFrames();
        expect(artifacts.style.width).toBe('550px');

        window.dispatchEvent(pointerEvent('pointerup', 400));
    });

    test('the focused workspace layout (70%) is clamped on a narrow container', () => {
        const { taskView, artifacts } = renderExpandedTaskView(1000);

        taskView.dispatchEvent(
            new window.CustomEvent('workspace-focus-layout-change', { detail: { active: true, fullscreen: true } })
        );
        flushAnimationFrames();

        // 70% = 700px 会留下 296px 聊天区，被收敛到 646px
        expect(artifacts.style.width).toBe('646px');

        taskView.dispatchEvent(
            new window.CustomEvent('workspace-focus-layout-change', { detail: { active: false, fullscreen: false } })
        );
        flushAnimationFrames();
        expect(artifacts.style.width).toBe('380px');
    });

    test('collapsing does not bake a chat-area-clamped width into the preferred width', () => {
        const { taskView, artifacts, resizer } = renderExpandedTaskView(700);
        taskView._rightSidebarWidth = 380;

        taskView._expandRightSidebar(artifacts, resizer);
        flushAnimationFrames();
        expect(artifacts.style.width).toBe('346px');

        taskView._collapseRightSidebar(artifacts, resizer);
        flushAnimationFrames();

        expect(taskView._rightSidebarWidth).toBe(380);
    });
});
