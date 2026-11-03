import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

/**
 * 任务级浏览器的画中画浮窗只应在浏览器确有可展示内容时出现。
 * 只剩一个 about:blank 标签页（等同于没有标签页）时，收起侧边栏不应弹出画中画，
 * 也不应把折叠状态当成"浏览器正在使用"而阻止侧边栏展开。
 */
describe('task-view browser pip requires real browser content', () => {
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

    type FakePip = {
        show: jest.Mock;
        hide: jest.Mock;
        resetClosed: jest.Mock;
        isClosed: () => boolean;
        isVisible: () => boolean;
    };

    function createTaskView(): any {
        const taskView = document.createElement('task-view') as any;
        taskView.task_id = 'task-1';
        return taskView;
    }

    function makeFakePip(): FakePip {
        return {
            show: jest.fn(),
            hide: jest.fn(),
            resetClosed: jest.fn(),
            isClosed: () => false,
            isVisible: () => false
        };
    }

    /** 在 task-view 内挂载可折叠的右侧面板 + 拖拽条 */
    function mountSidebar(taskView: any): { artifacts: any; resizer: HTMLElement } {
        const artifacts = document.createElement('div') as any;
        artifacts.id = 'task-task-1-artifacts';
        artifacts.hasBrowserContent = () => false;
        artifacts.suspendPreviewLayout = jest.fn();
        artifacts.keepBrowserPanelRenderable = jest.fn();
        artifacts.restoreBrowserPanelLayout = jest.fn();
        // 展开态的侧边栏在生产中必有 inline width（_expandRightSidebar 写入）；
        // linkedom 对未设置的 style 属性返回 undefined（浏览器返回 ''），而
        // _collapseRightSidebar 读取 style.width.trim()，须预置以贴近真实 DOM
        artifacts.style.width = '320px';
        const resizer = document.createElement('div');
        resizer.id = 'task-task-1-resizer';
        taskView.appendChild(artifacts);
        taskView.appendChild(resizer);
        taskView._getRightSidebarEl = () => artifacts;
        return { artifacts, resizer };
    }

    test('does not open the pip when the browser only has a blank tab', () => {
        const taskView = createTaskView();
        taskView._getRightSidebarEl = () => ({
            isBrowserVisible: () => true,
            hasBrowserContent: () => false
        });
        taskView._initBrowserPip = jest.fn();
        taskView._browserPip = null;

        taskView._showBrowserPipIfNeeded();

        expect(taskView._initBrowserPip).not.toHaveBeenCalled();
        expect(taskView._browserPip).toBeNull();
    });

    test('hides an already visible pip once the browser loses its content', () => {
        const taskView = createTaskView();
        const pip = makeFakePip();
        taskView._getRightSidebarEl = () => ({
            isBrowserVisible: () => true,
            hasBrowserContent: () => false
        });
        taskView._browserPip = pip;

        taskView._showBrowserPipIfNeeded();

        expect(pip.show).not.toHaveBeenCalled();
        expect(pip.hide).toHaveBeenCalledTimes(1);
    });

    test('still shows the pip while the browser has real content', () => {
        const taskView = createTaskView();
        const pip = makeFakePip();
        taskView._getRightSidebarEl = () => ({
            isBrowserVisible: () => true,
            hasBrowserContent: () => true
        });
        taskView._browserPip = pip;

        taskView._showBrowserPipIfNeeded();

        expect(pip.show).toHaveBeenCalledTimes(1);
        expect(pip.hide).not.toHaveBeenCalled();
    });

    test('expands the collapsed sidebar instead of staying in pip mode for a blank browser', () => {
        const taskView = createTaskView();
        const { artifacts, resizer } = mountSidebar(taskView);
        artifacts.dataset.offscreen = '1';
        taskView._rightSidebarExpanded = false;
        const pip = makeFakePip();
        taskView._browserPip = pip;

        taskView._ensureRightSidebarOpen();

        expect(taskView._rightSidebarExpanded).toBe(true);
        expect(pip.show).not.toHaveBeenCalled();
    });

    test('keeps the collapsed layout and the pip when the browser has content', () => {
        const taskView = createTaskView();
        const { artifacts, resizer } = mountSidebar(taskView);
        artifacts.dataset.offscreen = '1';
        artifacts.hasBrowserContent = () => true;
        taskView._rightSidebarExpanded = false;
        const pip = makeFakePip();
        taskView._browserPip = pip;

        taskView._ensureRightSidebarOpen();

        expect(taskView._rightSidebarExpanded).toBe(false);
        expect(pip.show).toHaveBeenCalledTimes(1);
    });

    test('shows the pip only after the sidebar collapse animation settles', () => {
        const taskView = createTaskView();
        const { artifacts, resizer } = mountSidebar(taskView);
        artifacts.hasBrowserContent = () => true;
        taskView._rightSidebarExpanded = true;
        const pip = makeFakePip();
        taskView._browserPip = pip;

        taskView._collapseRightSidebar(artifacts, resizer);

        // 收起动画期间聊天区宽度仍在变化，此时不能显示浮窗
        expect(pip.show).not.toHaveBeenCalled();

        // 动画结束（width 过渡完成）
        const settled = new (globalThis as any).window.Event('transitionend');
        (settled as any).propertyName = 'width';
        artifacts.dispatchEvent(settled);

        expect(pip.show).toHaveBeenCalledTimes(1);
    });

    test('falls back to the animation duration when no transition event arrives', () => {
        jest.useFakeTimers();
        try {
            const taskView = createTaskView();
            const { artifacts, resizer } = mountSidebar(taskView);
            artifacts.hasBrowserContent = () => true;
            taskView._rightSidebarExpanded = true;
            const pip = makeFakePip();
            taskView._browserPip = pip;

            taskView._collapseRightSidebar(artifacts, resizer);
            jest.advanceTimersByTime(280);
            expect(pip.show).not.toHaveBeenCalled();

            jest.advanceTimersByTime(100);
            expect(pip.show).toHaveBeenCalledTimes(1);
        } finally {
            jest.useRealTimers();
        }
    });

    test('drops the queued pip when the sidebar is expanded again before the animation ends', () => {
        jest.useFakeTimers();
        try {
            const taskView = createTaskView();
            const { artifacts, resizer } = mountSidebar(taskView);
            artifacts.hasBrowserContent = () => true;
            taskView._rightSidebarExpanded = true;
            const pip = makeFakePip();
            taskView._browserPip = pip;

            taskView._collapseRightSidebar(artifacts, resizer);
            taskView._expandRightSidebar(artifacts, resizer);
            jest.advanceTimersByTime(1000);

            expect(pip.show).not.toHaveBeenCalled();
        } finally {
            jest.useRealTimers();
        }
    });
});
