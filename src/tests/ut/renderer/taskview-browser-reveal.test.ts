import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

describe('task-view pending browser reveal', () => {
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
            renderMermaidBlocks: jest.fn()
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

    function createTaskViewWithArtifacts() {
        const taskView = document.createElement('task-view') as HTMLElement & {
            task_id: string;
            _rightSidebarExpanded: boolean;
            syncRightSidebarState: () => void;
        };
        taskView.task_id = 'task-1';
        const artifacts = document.createElement('task-artifacts') as HTMLElement & {
            applyPendingBrowserAutoReveal?: jest.Mock;
            forceBrowserActive?: jest.Mock;
            restoreSelectedBrowser?: jest.Mock;
        };
        artifacts.id = 'task-task-1-artifacts';
        taskView.appendChild(artifacts);
        return { taskView, artifacts };
    }

    test('applies the pending browser reveal when the user switches back to the task', () => {
        const { taskView, artifacts } = createTaskViewWithArtifacts();
        // 上次离开任务时侧边栏处于折叠状态（收起后侧边栏保持 display:none/离屏）
        taskView._rightSidebarExpanded = false;
        artifacts.style.display = 'none';
        artifacts.applyPendingBrowserAutoReveal = jest.fn(() => true);
        artifacts.forceBrowserActive = jest.fn();
        artifacts.restoreSelectedBrowser = jest.fn();

        taskView.syncRightSidebarState();

        expect(artifacts.applyPendingBrowserAutoReveal).toHaveBeenCalledTimes(1);
        // 任务状态要求进入浏览器大屏预览：强制展开侧边栏并聚焦浏览器 tab，
        // 不保留折叠状态、也不改用画中画。
        expect(artifacts.forceBrowserActive).toHaveBeenCalledTimes(1);
        expect(taskView._rightSidebarExpanded).toBe(true);
        expect(artifacts.restoreSelectedBrowser).toHaveBeenCalledTimes(1);
    });

    test('keeps the previous per-task layout when no pending reveal exists', () => {
        const { taskView, artifacts } = createTaskViewWithArtifacts();
        taskView._rightSidebarExpanded = false;
        artifacts.applyPendingBrowserAutoReveal = jest.fn(() => false);
        artifacts.forceBrowserActive = jest.fn();

        taskView.syncRightSidebarState();

        // 无待应用状态时保留用户离开时的折叠布局，不自动展开。
        expect(artifacts.forceBrowserActive).not.toHaveBeenCalled();
        expect(taskView._rightSidebarExpanded).toBe(false);
        expect(artifacts.style.display).toBe('');
    });

    test('keeps the expanded layout restored when returning without a pending reveal', () => {
        const { taskView, artifacts } = createTaskViewWithArtifacts();
        taskView._rightSidebarExpanded = true;
        artifacts.applyPendingBrowserAutoReveal = jest.fn(() => false);
        artifacts.forceBrowserActive = jest.fn();

        taskView.syncRightSidebarState();

        expect(artifacts.forceBrowserActive).not.toHaveBeenCalled();
        expect(artifacts.style.display).toBe('');
        expect(taskView._rightSidebarExpanded).toBe(true);
    });
});
