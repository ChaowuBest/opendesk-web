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
        expect(placeholder?.textContent).toContain('正在等待模型响应');
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
        expect(placeholder?.textContent).toContain('正在等待模型响应');
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

    test('assistant progress without an explicit part index renders safely', () => {
        const taskView = document.createElement('task-view') as HTMLElement & {
            task_id: string;
            _renderAssistantProgress: (progress: Record<string, unknown>, historyContainer: HTMLElement) => boolean;
        };
        taskView.task_id = 'task-1';
        taskView.innerHTML = '<div id="taskview-chat-history"></div>';
        const historyContainer = taskView.querySelector('#taskview-chat-history') as HTMLElement;

        expect(
            taskView._renderAssistantProgress(
                {
                    task_status: 'running',
                    message_id: 'assistant-missing-index',
                    last_part: { type: 'text', rendered: 'safe output' }
                },
                historyContainer
            )
        ).toBe(true);

        expect(taskView.querySelector('#message-content-assistant-missing-index')?.textContent).toContain(
            'safe output'
        );
    });

    test('keeps previous usage visible until assistant progress has non-zero usage', () => {
        const taskView = document.createElement('task-view') as HTMLElement & {
            task_id: string;
            _renderAssistantProgress: (progress: Record<string, unknown>, historyContainer: HTMLElement) => boolean;
        };
        taskView.task_id = 'task-1';
        taskView.innerHTML = `
            <div id="taskview-chat-history">
                <div class="od-assistant-msg-container">
                    <div id="message-container-assistant-1">
                        <div id="message-content-assistant-1">
                            <div class="markdown-body">previous answer</div>
                        </div>
                        <span class="message-usage" data-prompt-tokens="12" data-completion-tokens="34" data-total-tokens="46" data-streaming="false">
                            <span class="usage-spinner" style="display:none;"></span>
                            <span class="usage-text">已输出 34 词, 总计 46 词</span>
                        </span>
                    </div>
                </div>
            </div>
        `;
        const historyContainer = taskView.querySelector('#taskview-chat-history') as HTMLElement;

        expect(
            taskView._renderAssistantProgress(
                {
                    task_status: 'running',
                    message_id: 'assistant-2',
                    last_part: { type: 'text', rendered: 'new output' },
                    last_part_index: 0,
                    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
                },
                historyContainer
            )
        ).toBe(true);

        expect(taskView.querySelector('#message-content-assistant-2')?.textContent).toContain('new output');
        expect(taskView.querySelector('#message-container-assistant-1 .message-usage')).not.toBeNull();
        expect(taskView.querySelector('#message-container-assistant-2 .message-usage')).toBeNull();
        expect(taskView.querySelector('.usage-text')?.textContent?.trim()).toBe('已输出 34 词, 总计 46 词');

        expect(
            taskView._renderAssistantProgress(
                {
                    task_status: 'stopped',
                    message_id: 'assistant-2',
                    last_part: { type: 'text', rendered: 'new output done' },
                    last_part_index: 0,
                    usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 }
                },
                historyContainer
            )
        ).toBe(true);

        expect(taskView.querySelectorAll('.message-usage')).toHaveLength(1);
        expect(taskView.querySelector('#message-container-assistant-1 .message-usage')).toBeNull();
        expect(taskView.querySelector('#message-container-assistant-2 .usage-text')?.textContent?.trim()).toBe(
            '已输出 5 词, 总计 16 词'
        );
    });

    test('reload renders the latest assistant usage that is not zero-only', async () => {
        window.taskManagerAPI = {
            ...window.taskManagerAPI,
            getFullTask: jest.fn(async () => ({
                task_status: 'stopped',
                chat_context: {
                    messages: [
                        {
                            role: 'assistant',
                            message_id: 'assistant-1',
                            content: [{ type: 'text', rendered: 'previous answer' }],
                            usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 }
                        },
                        {
                            role: 'user',
                            message_id: 'user-2',
                            rawText: 'next',
                            content: [{ type: 'text', rendered: '<p>next</p>' }]
                        },
                        {
                            role: 'assistant',
                            message_id: 'assistant-2',
                            content: [{ type: 'text', rendered: 'latest answer' }],
                            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
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

        expect(taskView.querySelectorAll('.message-usage')).toHaveLength(1);
        expect(taskView.querySelector('#message-container-assistant-1 .usage-text')?.textContent?.trim()).toBe(
            '已输出 34 词, 总计 46 词'
        );
        expect(taskView.querySelector('#message-container-assistant-2 .message-usage')).toBeNull();
    });

    test('goal command messages render as normal user messages and consumed supplements render user text', async () => {
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
                origin: { source: 'internal', reason: 'goal_hook' },
                execution: { controller: 'goal' }
            },
            content: [{ type: 'text', rendered: '<p>hidden internal message</p>' }]
        };
        const consumedSupplementMessage = {
            role: 'user',
            internal: true,
            rawText: 'Use packages/appsdk as the target.',
            metadata: {
                origin: { source: 'internal', reason: 'goal_supplement' },
                execution: { controller: 'goal' }
            },
            content: [{ type: 'text', rendered: '<p>&lt;system-reminder&gt;hidden internal prompt</p>' }]
        };
        const rawlessSupplementMessage = {
            ...consumedSupplementMessage,
            rawText: ''
        };

        expect(shouldRenderUserHistoryMessage(goalMessage)).toBe(true);
        expect(shouldRenderUserHistoryMessage(ordinaryInternalMessage)).toBe(false);
        expect(shouldRenderUserHistoryMessage(consumedSupplementMessage)).toBe(true);
        expect(shouldRenderUserHistoryMessage(rawlessSupplementMessage)).toBe(false);

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
                        },
                        {
                            ...consumedSupplementMessage,
                            message_id: 'goal-supplement-user-1',
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
        expect(taskView.textContent).toContain('Use packages/appsdk as the target.');
        expect(taskView.textContent).not.toContain('system-reminder');
        expect(taskView.textContent).not.toContain('hidden internal message');
    });

    test('renders only the latest history batch on reload and prepends older messages on demand', async () => {
        const { TASKVIEW_HISTORY_BATCH_MESSAGE_LIMIT } = await import('../../../renderer/components/taskview.js');
        const messages = Array.from({ length: TASKVIEW_HISTORY_BATCH_MESSAGE_LIMIT + 5 }, (_, index) => ({
            role: 'user',
            message_id: `user-${index}`,
            rawText: `message ${index}`,
            content: [{ type: 'text', rendered: `<p>message ${index}</p>` }]
        }));

        window.taskManagerAPI = {
            ...window.taskManagerAPI,
            getFullTask: jest.fn(async () => ({
                task_status: 'stopped',
                chat_context: { messages },
                model: 'model-a'
            })),
            getModelContextSize: jest.fn(async () => 0)
        };

        const taskView = document.createElement('task-view') as HTMLElement & {
            task_id: string;
            reload: () => Promise<void>;
            _historyRenderStartIndex: number;
            _loadOlderHistoryFromScroll: () => boolean;
            _loadOlderHistoryBatch: () => boolean;
        };
        taskView.task_id = 'task-1';
        taskView.innerHTML = '<div id="taskview-chat-history"></div>';

        await taskView.reload();

        const historyContainer = taskView.querySelector('#taskview-chat-history') as HTMLElement;
        expect(historyContainer.querySelectorAll('.od-user-msg-container')).toHaveLength(
            TASKVIEW_HISTORY_BATCH_MESSAGE_LIMIT
        );
        expect(taskView._historyRenderStartIndex).toBe(5);
        expect(historyContainer.querySelector('#user-msg-user-0')).toBeNull();
        expect(historyContainer.querySelector('#user-msg-user-5')).not.toBeNull();

        historyContainer.scrollTop = 0;
        expect(taskView._loadOlderHistoryFromScroll()).toBe(true);

        expect(taskView._historyRenderStartIndex).toBe(0);
        expect(historyContainer.querySelector('#user-msg-user-0')).not.toBeNull();
        expect(historyContainer.querySelectorAll('.od-user-msg-container')).toHaveLength(
            TASKVIEW_HISTORY_BATCH_MESSAGE_LIMIT + 5
        );
    });

    test('keeps an oversized rendered-html message as its own lazy history batch', async () => {
        const { TASKVIEW_HISTORY_BATCH_HTML_CHAR_LIMIT } = await import('../../../renderer/components/taskview.js');
        const hugeHtml = `<p>${'x'.repeat(TASKVIEW_HISTORY_BATCH_HTML_CHAR_LIMIT + 1)}</p>`;
        const messages = [
            {
                role: 'user',
                message_id: 'user-old',
                rawText: 'old',
                content: [{ type: 'text', rendered: '<p>old</p>' }]
            },
            {
                role: 'assistant',
                message_id: 'assistant-huge',
                content: [{ type: 'text', rendered: hugeHtml }]
            },
            {
                role: 'user',
                message_id: 'user-latest',
                rawText: 'latest',
                content: [{ type: 'text', rendered: '<p>latest</p>' }]
            }
        ];

        window.taskManagerAPI = {
            ...window.taskManagerAPI,
            getFullTask: jest.fn(async () => ({
                task_status: 'stopped',
                chat_context: { messages },
                model: 'model-a'
            })),
            getModelContextSize: jest.fn(async () => 0)
        };

        const taskView = document.createElement('task-view') as HTMLElement & {
            task_id: string;
            reload: () => Promise<void>;
            _loadOlderHistoryBatch: () => boolean;
        };
        taskView.task_id = 'task-1';
        taskView.innerHTML = '<div id="taskview-chat-history"></div>';

        await taskView.reload();

        expect(taskView.querySelector('#user-msg-user-latest')).not.toBeNull();
        expect(taskView.querySelector('#message-container-assistant-huge')).toBeNull();
        expect(taskView.querySelector('#user-msg-user-old')).toBeNull();

        expect(taskView._loadOlderHistoryBatch()).toBe(true);

        expect(taskView.querySelector('#message-container-assistant-huge')).not.toBeNull();
        expect(taskView.querySelector('#user-msg-user-old')).toBeNull();

        expect(taskView._loadOlderHistoryBatch()).toBe(true);
        expect(taskView.querySelector('#user-msg-user-old')).not.toBeNull();
    });

    test('loads older history before scrolling to a goal timeline anchor', async () => {
        jest.useFakeTimers();
        const { TASKVIEW_HISTORY_BATCH_MESSAGE_LIMIT } = await import('../../../renderer/components/taskview.js');
        const messages = Array.from({ length: TASKVIEW_HISTORY_BATCH_MESSAGE_LIMIT + 3 }, (_, index) => ({
            role: 'user',
            message_id: `user-${index}`,
            rawText: `message ${index}`,
            content: [{ type: 'text', rendered: `<p>message ${index}</p>` }]
        }));
        const scrollIntoView = jest.fn();
        const originalScrollIntoView = (window.HTMLElement.prototype as any).scrollIntoView;
        (window.HTMLElement.prototype as any).scrollIntoView = scrollIntoView;

        window.taskManagerAPI = {
            ...window.taskManagerAPI,
            getFullTask: jest.fn(async () => ({
                task_status: 'stopped',
                chat_context: { messages },
                model: 'model-a'
            })),
            getModelContextSize: jest.fn(async () => 0)
        };

        const taskView = document.createElement('task-view') as HTMLElement & {
            task_id: string;
            reload: () => Promise<void>;
            scrollToMessage: (messageId: string) => Promise<boolean>;
            setAutoScrollingToBottom: jest.Mock;
        };
        taskView.task_id = 'task-1';
        taskView.setAutoScrollingToBottom = jest.fn();
        taskView.innerHTML = '<div id="taskview-chat-history"></div>';

        try {
            await taskView.reload();

            expect(taskView.querySelector('#user-msg-user-0')).toBeNull();
            await expect(taskView.scrollToMessage('user-0')).resolves.toBe(true);

            expect(taskView.querySelector('#user-msg-user-0')).not.toBeNull();
            expect(taskView.setAutoScrollingToBottom).toHaveBeenCalledWith(false);
            expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
            jest.runOnlyPendingTimers();
        } finally {
            (window.HTMLElement.prototype as any).scrollIntoView = originalScrollIntoView;
            jest.useRealTimers();
        }
    });

    test('shows goal supplement as pending until the consumed message enters chat history', async () => {
        const addGoalSupplement = jest.fn(async () => ({ ok: true }));
        window.taskManagerAPI = {
            ...window.taskManagerAPI,
            addGoalSupplement
        };

        const taskView = document.createElement('task-view') as HTMLElement & {
            task_id: string;
            _submitGoalSupplement: (detail: { message: string }) => Promise<boolean>;
            _renderUserProgress: (progress: Record<string, unknown>, historyContainer: HTMLElement) => boolean;
            _pendingGoalSupplementMessages: unknown[];
        };
        taskView.task_id = 'task-1';
        taskView.innerHTML = '<div id="taskview-chat-history"></div>';
        const history = taskView.querySelector('#taskview-chat-history') as HTMLElement & { scroll?: jest.Mock };
        history.scroll = jest.fn();

        await expect(taskView._submitGoalSupplement({ message: 'Use packages/appsdk as the target.' })).resolves.toBe(
            true
        );

        expect(addGoalSupplement).toHaveBeenCalledWith('task-1', 'Use packages/appsdk as the target.');
        expect(taskView._pendingGoalSupplementMessages).toHaveLength(1);
        expect(history.querySelector('.goal-supplement-pending')?.textContent).toContain(
            'Use packages/appsdk as the target.'
        );
        expect(history.querySelector('.od-user-msg')).toBeNull();

        expect(
            taskView._renderUserProgress(
                {
                    type: 'user',
                    task_status: 'running',
                    message_id: 'goal-supplement-user-1',
                    last_part_index: 0,
                    last_part: {
                        type: 'text',
                        rendered: '<p>&lt;system-reminder&gt;hidden internal prompt</p>'
                    },
                    internal: true,
                    rawText: 'Use packages/appsdk as the target.',
                    metadata: {
                        origin: { source: 'internal', reason: 'goal_supplement' },
                        execution: { controller: 'goal' }
                    }
                },
                history
            )
        ).toBe(true);
        expect(taskView._pendingGoalSupplementMessages).toHaveLength(0);
        expect(history.querySelector('.goal-supplement-pending')).toBeNull();
        expect(history.querySelector('.od-user-msg')?.textContent).toContain('Use packages/appsdk as the target.');
        expect(history.textContent).not.toContain('system-reminder');
    });

    test('shows pending goal edit until the matching internal reminder enters chat history', () => {
        const taskView = document.createElement('task-view') as HTMLElement & {
            task_id: string;
            showPendingGoalEdit: (type: 'create' | 'edit', objective: string, goalId: string, taskId?: string) => void;
            _renderUserProgress: (progress: Record<string, unknown>, historyContainer: HTMLElement) => boolean;
            _pendingGoalEditMessage: unknown;
        };
        taskView.task_id = 'task-1';
        taskView.innerHTML = '<div id="taskview-chat-history"></div>';
        const history = taskView.querySelector('#taskview-chat-history') as HTMLElement;

        taskView.showPendingGoalEdit('edit', '更新导出目标', 'goal-1', 'task-1');

        expect(taskView.querySelector('.goal-edit-pending')?.textContent).toContain('更新导出目标');
        expect(taskView._pendingGoalEditMessage).not.toBeNull();

        expect(
            taskView._renderUserProgress(
                {
                    type: 'user',
                    task_status: 'running',
                    message_id: 'goal-edit-user-1',
                    last_part_index: 0,
                    last_part: {
                        type: 'text',
                        rendered: '<p>&lt;system-reminder&gt;hidden internal prompt</p>'
                    },
                    internal: true,
                    rawText: 'hidden internal prompt',
                    metadata: {
                        origin: { source: 'internal', reason: 'goal_edit' },
                        execution: { controllerId: 'goal-1' }
                    }
                },
                history
            )
        ).toBe(false);
        expect(taskView._pendingGoalEditMessage).toBeNull();
        expect(taskView.querySelector('.goal-edit-pending')).toBeNull();
    });

    test('forwards live task todo updates to artifacts with live-update source', async () => {
        let taskTodosUpdatedHandler: ((payload: unknown) => void) | null = null;
        const setTaskTodos = jest.fn();
        window.applicationRegistryAPI = {
            subscribeEvent: jest.fn(async (_appId: string, eventName: string, handler: (payload: unknown) => void) => {
                if (eventName === 'taskTodosUpdated') {
                    taskTodosUpdatedHandler = handler;
                }
                return jest.fn();
            })
        };

        const taskView = document.createElement('task-view') as HTMLElement & {
            task_id: string;
            _taskTodos: unknown[];
            _subscribeTaskTodos: () => Promise<void>;
            _getRightSidebarEl: () => unknown;
            _ensureRightSidebarOpen: jest.Mock;
        };
        taskView.task_id = 'task-1';
        taskView._taskTodos = [
            {
                id: 'todo-0',
                title: 'Existing todo',
                status: 'pending'
            }
        ];
        taskView._getRightSidebarEl = () => ({
            setTaskTodos,
            hasGoalSuggestion: () => false
        });
        taskView._ensureRightSidebarOpen = jest.fn();

        await taskView._subscribeTaskTodos();
        taskTodosUpdatedHandler?.({
            taskId: 'task-1',
            todos: [
                {
                    id: 'todo-1',
                    title: 'New todo',
                    status: 'pending'
                }
            ]
        });

        expect(setTaskTodos).toHaveBeenCalledWith(
            [
                {
                    id: 'todo-1',
                    title: 'New todo',
                    status: 'pending'
                }
            ],
            { source: 'live-update' }
        );
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
