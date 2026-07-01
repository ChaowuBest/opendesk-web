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

    test('shows a thinking placeholder while waiting for the first assistant part', async () => {
        window.taskManagerAPI = {
            ...window.taskManagerAPI,
            getFullTask: jest.fn(async () => ({
                task_status: 'running',
                chat_context: {
                    messages: [
                        {
                            role: 'user',
                            message_id: 'user-1',
                            content: [{ type: 'text', rendered: '你好' }]
                        },
                        {
                            role: 'assistant',
                            message_id: 'assistant-1',
                            content: []
                        }
                    ]
                },
                model: 'model-a'
            })),
            getModelContextSize: jest.fn(async () => 0)
        };

        const taskView = document.createElement('task-view') as HTMLElement & {
            task_id: string;
            reload: () => Promise<void>;
        };
        taskView.task_id = 'task-1';
        taskView.innerHTML = '<div id="taskview-chat-history"></div>';

        await taskView.reload();

        const placeholder = taskView.querySelector('.waiting-usage-placeholder');
        expect(placeholder?.textContent).toContain('OpenDesk思考中……');
        expect(taskView.querySelector('.message-usage')).toBeNull();
    });

    test('does not re-show the thinking placeholder after assistant output starts', () => {
        const taskView = document.createElement('task-view') as HTMLElement & {
            task_id: string;
            _showWaitingAssistantPlaceholder: (options?: { force?: boolean }) => void;
        };
        taskView.task_id = 'task-1';
        taskView.innerHTML = `
            <div id="taskview-chat-history">
                <div id="user-msg-user-1" class="od-user-msg-container"></div>
                <div class="waiting-usage-placeholder od-assistant-msg-container"></div>
                <div class="od-assistant-msg-container">
                    <div id="message-container-assistant-1">
                        <div id="message-content-assistant-1">
                            <div class="markdown-body">模型已经开始输出</div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        taskView._showWaitingAssistantPlaceholder();

        expect(taskView.querySelector('.waiting-usage-placeholder')).toBeNull();
        expect(taskView.textContent).toContain('模型已经开始输出');
    });

    test('can force-show the thinking placeholder immediately for a newly submitted turn', () => {
        const taskView = document.createElement('task-view') as HTMLElement & {
            task_id: string;
            _showWaitingAssistantPlaceholder: (options?: { force?: boolean }) => void;
        };
        taskView.task_id = 'task-1';
        taskView.innerHTML = `
            <div id="taskview-chat-history">
                <div id="user-msg-user-1" class="od-user-msg-container"></div>
                <div class="od-assistant-msg-container">
                    <div id="message-container-assistant-1">
                        <div id="message-content-assistant-1">
                            <div class="markdown-body">上一轮回复</div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        taskView._showWaitingAssistantPlaceholder({ force: true });

        const placeholder = taskView.querySelector('.waiting-usage-placeholder');
        expect(placeholder?.textContent).toContain('OpenDesk思考中……');
        expect(placeholder).toBe(taskView.querySelector('#taskview-chat-history')?.lastElementChild);
    });

    test('assistant replace swaps a provisional text block for reasoning and visible text', () => {
        const taskView = document.createElement('task-view') as HTMLElement & {
            task_id: string;
            handleAssistantReplace: (progress: unknown) => void;
        };
        taskView.task_id = 'task-1';
        taskView.innerHTML = `
            <div id="taskview-chat-history">
                <div class="od-assistant-msg-container">
                    <div id="message-container-assistant-1">
                        <div id="message-content-assistant-1">
                            <div class="markdown-body">old provisional text</div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        taskView.handleAssistantReplace({
            type: 'assistant_replace',
            task_id: 'task-1',
            task_status: 'running',
            message_id: 'assistant-1',
            parts: [
                { type: 'reasoning', rendered: 'hidden reasoning', contentLength: 16 },
                { type: 'text', rendered: 'visible answer' }
            ]
        });

        expect(taskView.textContent).not.toContain('old provisional text');
        expect(taskView.querySelector('.reasoning-content')?.textContent?.trim()).toBe('hidden reasoning');
        expect(taskView.textContent).toContain('visible answer');
    });
});
