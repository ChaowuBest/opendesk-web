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

    test('goal command messages render as normal user messages', async () => {
        const { shouldRenderUserHistoryMessage } = await import('../../../renderer/components/taskview.js');
        const goalMessage = {
            role: 'user',
            rawText: '/goal 修复导出问题',
            metadata: {
                origin: { source: 'internal', reason: 'goal_create_display' },
                execution: { controller: 'goal' }
            },
            content: [{ type: 'text', rendered: '<p>/goal 修复导出问题</p>' }]
        };
        const ordinaryInternalMessage = {
            role: 'user',
            internal: true,
            rawText: 'hidden internal message',
            metadata: {
                origin: { source: 'internal', reason: 'goal_supplement' },
                execution: { controller: 'goal' }
            },
            content: [{ type: 'text', rendered: '<p>hidden internal message</p>' }]
        };

        expect(shouldRenderUserHistoryMessage(goalMessage)).toBe(true);
        expect(shouldRenderUserHistoryMessage(ordinaryInternalMessage)).toBe(false);

        window.taskManagerAPI = {
            ...window.taskManagerAPI,
            getFullTask: jest.fn(async () => ({
                task_status: 'stopped',
                chat_context: {
                    messages: [
                        {
                            ...goalMessage,
                            message_id: 'goal-user-1',
                            timestamp: Date.now()
                        },
                        {
                            ...ordinaryInternalMessage,
                            message_id: 'internal-user-1',
                            timestamp: Date.now()
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

        expect(taskView.textContent).toContain('/goal 修复导出问题');
        expect(taskView.textContent).not.toContain('system-reminder');
        expect(taskView.textContent).not.toContain('hidden internal message');
    });

    test('scrolls to the user message referenced by a goal timeline anchor', () => {
        jest.useFakeTimers();
        const taskView = document.createElement('task-view') as HTMLElement & {
            _scrollToGoalMessage: (messageId: string) => boolean;
            setAutoScrollingToBottom: jest.Mock;
        };
        taskView.innerHTML = `
            <div id="taskview-chat-history">
                <div id="user-msg-goal-message-1" class="od-user-msg-container" data-message-id="goal-message-1" data-raw-text="/goal 修复导出问题">
                    <div class="od-user-msg">/goal 修复导出问题</div>
                </div>
            </div>
        `;
        const target = taskView.querySelector('#user-msg-goal-message-1') as HTMLElement & {
            scrollIntoView: jest.Mock;
        };
        target.scrollIntoView = jest.fn();
        taskView.setAutoScrollingToBottom = jest.fn();

        try {
            expect(taskView._scrollToGoalMessage('goal-message-1')).toBe(true);

            expect(taskView.setAutoScrollingToBottom).toHaveBeenCalledWith(false);
            expect(target.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
            expect((target.querySelector('.od-user-msg') as HTMLElement).style.outline).toContain('124, 77, 255');
            jest.runOnlyPendingTimers();
        } finally {
            jest.useRealTimers();
        }
    });

    test('scrolls to the assistant output referenced by a goal timeline anchor', () => {
        jest.useFakeTimers();
        const taskView = document.createElement('task-view') as HTMLElement & {
            _scrollToGoalMessage: (messageId: string) => boolean;
            setAutoScrollingToBottom: jest.Mock;
        };
        taskView.innerHTML = `
            <div id="taskview-chat-history">
                <div class="od-assistant-msg-container">
                    <div id="message-container-goal-output-1">
                        <div id="message-content-goal-output-1">
                            <div class="markdown-body">Goal 信息</div>
                        </div>
                    </div>
                </div>
            </div>
        `;
        const target = taskView.querySelector('#message-container-goal-output-1') as HTMLElement & {
            scrollIntoView: jest.Mock;
        };
        const content = taskView.querySelector('#message-content-goal-output-1') as HTMLElement;
        target.scrollIntoView = jest.fn();
        taskView.setAutoScrollingToBottom = jest.fn();

        try {
            expect(taskView._scrollToGoalMessage('goal-output-1')).toBe(true);

            expect(taskView.setAutoScrollingToBottom).toHaveBeenCalledWith(false);
            expect(target.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
            expect(content.style.outline).toContain('124, 77, 255');
            jest.runOnlyPendingTimers();
        } finally {
            jest.useRealTimers();
        }
    });

    test('does not duplicate a goal edit display message after reload and incremental update race', async () => {
        window.taskManagerAPI = {
            ...window.taskManagerAPI,
            getFullTask: jest.fn(async () => ({
                task_status: 'stopped',
                chat_context: {
                    messages: [
                        {
                            role: 'user',
                            message_id: 'goal-edit-1',
                            rawText: '/goal 编辑后的目标',
                            content: [{ type: 'text', rendered: '<p>/goal 编辑后的目标</p>' }],
                            metadata: {
                                scope: 'goal',
                                origin: { source: 'internal', reason: 'goal_edit_display' }
                            }
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
            _renderUserProgress: (progress: Record<string, unknown>, historyContainer: HTMLElement) => boolean;
        };
        taskView.task_id = 'task-1';
        taskView.innerHTML = '<div id="taskview-chat-history"></div>';

        await taskView.reload();

        const historyContainer = taskView.querySelector('#taskview-chat-history') as HTMLElement;
        const rendered = taskView._renderUserProgress(
            {
                type: 'user',
                message_id: 'goal-edit-1',
                rawText: '/goal 编辑后的目标',
                last_part: { type: 'text', rendered: '<p>/goal 编辑后的目标</p>' },
                last_part_index: 0,
                isLastPart: true,
                task_status: 'stopped'
            },
            historyContainer
        );

        expect(rendered).toBe(false);
        expect(historyContainer.querySelectorAll('#user-msg-goal-edit-1 .od-user-msg')).toHaveLength(1);
        expect(historyContainer.textContent?.match(/编辑后的目标/g)).toHaveLength(1);
    });
});
