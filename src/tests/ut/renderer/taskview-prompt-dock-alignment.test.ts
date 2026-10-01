import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

/**
 * task-view 底部 dock 区域的水平对齐约束：
 * permission / ask-user / exit-plan 三类 prompt 面板必须与 agent-input
 * 使用相同的水平 padding，保证左右边缘对齐。
 */
describe('task-view prompt dock alignment', () => {
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
            sessionStorage: { getItem: () => null, removeItem: () => undefined },
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

        customElements.define('agent-input', class extends HTMLElement {});
        customElements.define('message-queue-panel', class extends HTMLElement {});

        await import('../../../renderer/components/taskview.js');
        TaskViewClass = customElements.get('task-view');
    });

    /** 提取元素上的水平 padding 类（px-*）；无则返回 null */
    function horizontalPaddingClass(element: Element | null): string | null {
        if (!element) return null;
        return Array.from(element.classList).find((cls) => /^px-/.test(cls)) ?? null;
    }

    function expectPanelsAlignedWithInputDock(taskView: any): void {
        const input = taskView.querySelector('agent-input');
        expect(input).not.toBeNull();
        const inputDockPadding = horizontalPaddingClass(input!.parentElement);
        expect(inputDockPadding).not.toBeNull();

        for (const selector of ['permission-prompt', 'ask-user-prompt', 'exit-plan-mode-prompt']) {
            const panel = taskView.querySelector(selector);
            expect(panel).not.toBeNull();
            expect(horizontalPaddingClass(panel)).toBe(inputDockPadding);
        }
    }

    test('standalone layout aligns prompt panels with the agent input dock', () => {
        const taskView = new TaskViewClass();
        taskView.task_id = 'task-align-standalone';
        taskView.render();

        expectPanelsAlignedWithInputDock(taskView);
    });

    test('embedded layout aligns prompt panels with the agent input dock', () => {
        const taskView = new TaskViewClass();
        taskView.setAttribute('embedded', '');
        taskView.task_id = 'task-align-embedded';
        taskView.render();

        expectPanelsAlignedWithInputDock(taskView);
    });
});
