import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

describe('task-view message queue', () => {
    let submitMessage: jest.Mock;

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

        await import('../../../renderer/components/taskview.js');
    });

    beforeEach(() => {
        submitMessage = jest.fn(async () => undefined);
        window.taskManagerAPI = {
            submitMessage
        };
    });

    test('auto-sends queued messages when a hidden running task stops', () => {
        const taskView = document.createElement('task-view') as HTMLElement & {
            task_id: string;
            task_status: string;
            messageQueue: Array<{
                id: string;
                message: string;
                attachedFilePaths: string[];
                attachedImages: string[];
                selectedModel?: string;
                reasoningEffort?: string;
                selectedExecutionNodeId?: string | null;
            }>;
            _immediateQueueSending: boolean;
            _handleTaskStatusUpdate: (status: string) => boolean;
            updateStopButtonVisibility: jest.Mock;
            _cancelBrowserIdleTimer: jest.Mock;
            _startBrowserIdleTimer: jest.Mock;
        };

        taskView.task_id = 'task-1';
        taskView.task_status = 'running';
        taskView.style.display = 'none';
        taskView.messageQueue = [
            {
                id: 'queue-1',
                message: 'next message',
                attachedFilePaths: ['/tmp/a.txt'],
                attachedImages: ['data:image/png;base64,AAAA'],
                selectedModel: 'model-a',
                reasoningEffort: 'high',
                selectedExecutionNodeId: 'node-a'
            }
        ];
        taskView._immediateQueueSending = false;
        taskView.updateStopButtonVisibility = jest.fn();
        taskView._cancelBrowserIdleTimer = jest.fn();
        taskView._startBrowserIdleTimer = jest.fn();

        expect(taskView._handleTaskStatusUpdate('stopped')).toBe(true);

        expect(submitMessage).toHaveBeenCalledWith('task-1', {
            message: 'next message',
            attachedFilePaths: ['/tmp/a.txt'],
            attachedImages: ['data:image/png;base64,AAAA'],
            selectedModel: 'model-a',
            reasoningEffort: 'high',
            selectedExecutionNodeId: 'node-a'
        });
        expect(taskView.messageQueue).toHaveLength(0);
        expect(taskView.task_status).toBe('running');
    });
});
