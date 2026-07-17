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
            enhanceToolPreviewCards: jest.fn()
        }));

        window.settingAPI = {
            loadSettingObject: async () => ({}),
            onSettingChanged: () => undefined
        };

        customElements.define(
            'agent-input',
            class extends HTMLElement {
                setDisabled() {}
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

        taskView.setAttribute('task_id', 'task-1');
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

    test('uses the shared task view with an input in embedded mode', () => {
        const taskView = document.createElement('task-view') as HTMLElement & {
            task_id: string;
            render: () => void;
        };
        taskView.setAttribute('task_id', 'embedded-task');
        taskView.setAttribute('embedded', '');
        taskView.task_id = 'embedded-task';

        taskView.render();

        expect(taskView.querySelector('#task-embedded-task-input')).not.toBeNull();
        expect(taskView.querySelector('#taskview-chat-history')).not.toBeNull();
        expect(taskView.querySelector('#taskview-toolbar')).toBeNull();
        expect(taskView.querySelector('task-artifacts')).toBeNull();
    });

    test('emits task status changes for embedded hosts', () => {
        const taskView = document.createElement('task-view') as HTMLElement & {
            task_id: string;
            task_status: string;
            messageQueue: unknown[];
            _handleTaskStatusUpdate: (status: string) => boolean;
            updateStopButtonVisibility: jest.Mock;
            _startBrowserIdleTimer: jest.Mock;
        };
        taskView.task_id = 'embedded-task';
        taskView.task_status = 'running';
        taskView.messageQueue = [];
        taskView.updateStopButtonVisibility = jest.fn();
        taskView._startBrowserIdleTimer = jest.fn();
        const statuses: string[] = [];
        taskView.addEventListener('task-status-changed', (event) => {
            statuses.push((event as CustomEvent<{ status: string }>).detail.status);
        });

        expect(taskView._handleTaskStatusUpdate('stopped')).toBe(true);
        expect(statuses).toEqual(['stopped']);
    });

    test('does not subscribe after an embedded view is removed during reload', async () => {
        let resolveTask!: (task: Record<string, unknown>) => void;
        const taskState = new Promise<Record<string, unknown>>((resolve) => {
            resolveTask = resolve;
        });
        const subscribeTaskUpdate = jest.fn(async () => 'subscription-1');
        const unsubscribeTaskUpdate = jest.fn(async () => undefined);
        window.taskManagerAPI = {
            getFullTask: jest.fn(() => taskState),
            getModelContextSize: jest.fn(async () => 0),
            getTaskTodos: jest.fn(async () => []),
            subscribeTaskUpdate,
            unsubscribeTaskUpdate
        };
        const taskView = document.createElement('task-view');
        taskView.setAttribute('task_id', 'embedded-task');
        taskView.setAttribute('embedded', '');
        document.body.appendChild(taskView);

        taskView.remove();
        resolveTask({
            task_status: 'waiting',
            chat_context: { messages: [] }
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(subscribeTaskUpdate).not.toHaveBeenCalled();
        expect(unsubscribeTaskUpdate).not.toHaveBeenCalled();
    });

    test('unsubscribes when removal races with subscription setup', async () => {
        let resolveSubscription!: (subscriptionId: string) => void;
        const subscription = new Promise<string>((resolve) => {
            resolveSubscription = resolve;
        });
        const subscribeTaskUpdate = jest.fn(() => subscription);
        const unsubscribeTaskUpdate = jest.fn(async () => undefined);
        window.taskManagerAPI = {
            getFullTask: jest.fn(async () => ({
                task_status: 'waiting',
                chat_context: { messages: [] }
            })),
            getModelContextSize: jest.fn(async () => 0),
            getTaskTodos: jest.fn(async () => []),
            subscribeTaskUpdate,
            unsubscribeTaskUpdate
        };
        const taskView = document.createElement('task-view');
        taskView.setAttribute('task_id', 'embedded-task');
        taskView.setAttribute('embedded', '');
        document.body.appendChild(taskView);
        for (let index = 0; index < 6 && subscribeTaskUpdate.mock.calls.length === 0; index += 1) {
            await Promise.resolve();
        }

        expect(subscribeTaskUpdate).toHaveBeenCalledTimes(1);
        taskView.remove();
        resolveSubscription('subscription-late');
        await Promise.resolve();
        await Promise.resolve();

        expect(unsubscribeTaskUpdate).toHaveBeenCalledWith('embedded-task', 'subscription-late');
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
            getModelContextSize: jest.fn(async () => 0),
            unsubscribeTaskUpdate: jest.fn()
        };

        const taskView = document.createElement('task-view') as HTMLElement & {
            task_id: string;
            reload: () => Promise<void>;
        };
        taskView.setAttribute('task_id', 'task-1');
        taskView.task_id = 'task-1';
        taskView.innerHTML = '<div id="taskview-chat-history"></div>';

        await taskView.reload();

        const placeholder = taskView.querySelector('.waiting-usage-placeholder');
        expect(placeholder?.textContent).toContain('正在等待模型响应');
        expect(taskView.querySelector('.message-usage')).toBeNull();
    });

    test('does not show thinking placeholder after a running goal becomes blocked', async () => {
        window.taskManagerAPI = {
            ...window.taskManagerAPI,
            getFullTask: jest.fn(async () => ({
                task_status: 'running',
                chat_context: {
                    messages: [
                        {
                            role: 'user',
                            message_id: 'user-1',
                            content: [{ type: 'text', rendered: '继续' }]
                        },
                        {
                            role: 'assistant',
                            message_id: 'assistant-1',
                            content: []
                        }
                    ]
                },
                goal: {
                    id: 'goal-1',
                    status: 'blocked',
                    revision: 2,
                    objective: 'Ship the CLI export fix',
                    pendingContinuation: false,
                    updatedAt: '2026-07-09T10:00:00.000Z'
                },
                model: 'model-a'
            })),
            getModelContextSize: jest.fn(async () => 0),
            unsubscribeTaskUpdate: jest.fn()
        };

        const taskView = document.createElement('task-view') as HTMLElement & {
            task_id: string;
            reload: () => Promise<void>;
        };
        taskView.setAttribute('task_id', 'task-1');
        taskView.task_id = 'task-1';
        taskView.innerHTML = `
            <div id="taskview-chat-history"></div>
            <task-artifacts id="task-task-1-artifacts"></task-artifacts>
        `;
        const artifacts = taskView.querySelector('#task-task-1-artifacts') as HTMLElement & {
            setGoalState: jest.Mock;
            setTaskRunning: jest.Mock;
        };
        artifacts.setGoalState = jest.fn();
        artifacts.setTaskRunning = jest.fn();

        await taskView.reload();

        expect(taskView.querySelector('.waiting-usage-placeholder')).toBeNull();
        expect(artifacts.setGoalState).toHaveBeenCalledWith(
            expect.objectContaining({
                status: 'blocked'
            })
        );
    });

    test('removes an existing thinking placeholder when goal state becomes blocked', () => {
        const taskView = document.createElement('task-view') as HTMLElement & {
            task_id: string;
            _syncArtifactsGoalState: (goal: Record<string, unknown>) => boolean;
        };
        const setGoalState = jest.fn();
        taskView.task_id = 'task-1';
        taskView.innerHTML = `
            <div id="taskview-chat-history">
                <div class="waiting-usage-placeholder od-assistant-msg-container">OpenDesk思考中……</div>
            </div>
            <task-artifacts id="task-task-1-artifacts"></task-artifacts>
        `;
        const artifacts = taskView.querySelector('#task-task-1-artifacts') as HTMLElement & {
            setGoalState: jest.Mock;
        };
        artifacts.setGoalState = setGoalState;

        taskView._syncArtifactsGoalState({
            id: 'goal-1',
            status: 'blocked',
            revision: 2,
            objective: 'Ship the CLI export fix',
            pendingContinuation: false,
            updatedAt: '2026-07-09T10:00:00.000Z'
        });

        expect(taskView.querySelector('.waiting-usage-placeholder')).toBeNull();
        expect(setGoalState).toHaveBeenCalledWith(
            expect.objectContaining({
                status: 'blocked'
            })
        );
    });

    test('renders final snapshot evaluation after a new goal replaces the completed goal', async () => {
        window.taskManagerAPI = {
            ...window.taskManagerAPI,
            getFullTask: jest.fn(async () => ({
                task_status: 'stopped',
                chat_context: {
                    messages: [
                        {
                            role: 'assistant',
                            message_id: 'assistant-old-goal',
                            content: [{ type: 'text', rendered: '旧目标已完成' }]
                        },
                        {
                            role: 'user',
                            message_id: 'user-new-goal',
                            rawText: '/goal new objective',
                            content: [{ type: 'text', rendered: '<p>/goal new objective</p>' }]
                        }
                    ]
                },
                goal: {
                    id: 'goal-new',
                    status: 'active',
                    revision: 1,
                    objective: 'new objective',
                    pendingContinuation: false,
                    updatedAt: '2026-07-09T10:05:00.000Z'
                },
                goal_final_snapshots: [
                    {
                        id: 'goal-final:goal-old',
                        taskId: 'task-1',
                        goalId: 'goal-old',
                        goalRevision: 1,
                        objective: 'old objective',
                        status: 'complete',
                        lastEvaluation: {
                            evaluationId: 'eval-old',
                            goalId: 'goal-old',
                            goalRevision: 1,
                            status: 'met',
                            reason: '旧目标已经验收通过',
                            evidence: ['旧目标证据'],
                            evaluatedAt: '2026-07-09T10:00:00.000Z'
                        },
                        totalTokens: 1200,
                        elapsedMs: 60000,
                        createdAt: '2026-07-09T09:59:00.000Z',
                        finalizedAt: '2026-07-09T10:00:00.000Z',
                        completedAt: '2026-07-09T10:00:00.000Z',
                        anchorMessageId: 'assistant-old-goal',
                        anchorMessageIndex: 0
                    }
                ],
                model: 'model-a'
            })),
            getModelContextSize: jest.fn(async () => 0),
            unsubscribeTaskUpdate: jest.fn()
        };

        const taskView = document.createElement('task-view') as HTMLElement & {
            task_id: string;
            reload: () => Promise<void>;
            disconnectedCallback?: () => void;
        };
        taskView.setAttribute('task_id', 'task-1');
        taskView.task_id = 'task-1';
        taskView.innerHTML = '<div id="taskview-chat-history"></div>';

        try {
            await taskView.reload();

            const evaluation = taskView.querySelector('.od-goal-eval-container[data-goal-id="goal-old"]');
            expect(evaluation?.textContent).toContain('旧目标已经验收通过');
            expect(evaluation?.textContent).toContain('旧目标证据');
            expect(taskView.querySelector('.od-goal-eval-container[data-goal-id="goal-new"]')).toBeNull();
        } finally {
            taskView.disconnectedCallback?.();
        }
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

    test('shows goal supplement pending input as a user echo with the shared thinking placeholder', () => {
        const taskView = document.createElement('task-view') as HTMLElement & {
            task_id: string;
            showPendingGoalSupplement: (content: string, supplementId?: string) => void;
        };
        taskView.task_id = 'task-1';
        taskView.innerHTML = '<div id="taskview-chat-history"></div>';

        taskView.showPendingGoalSupplement('Use packages/appsdk as the target.');

        const echo = taskView.querySelector('.od-pending-context-entry');
        const placeholder = taskView.querySelector('.waiting-usage-placeholder');
        expect(echo?.textContent).toContain('Use packages/appsdk as the target.');
        expect(echo?.classList.contains('od-user-msg-container')).toBe(true);
        expect(echo?.getAttribute('data-pending-context-type')).toBe('goal_supplement');
        expect(taskView.querySelector('.goal-supplement-pending')).toBeNull();
        expect(placeholder?.textContent).toContain('正在等待模型响应');
        expect(placeholder).toBe(taskView.querySelector('#taskview-chat-history')?.lastElementChild);
    });

    test('replaces a pending goal supplement echo when the internal user message arrives', () => {
        const taskView = document.createElement('task-view') as HTMLElement & {
            task_id: string;
            showPendingGoalSupplement: (content: string, supplementId?: string) => void;
            _renderUserProgress: (progress: Record<string, unknown>, historyContainer: HTMLElement) => boolean;
        };
        taskView.task_id = 'task-1';
        taskView.innerHTML = '<div id="taskview-chat-history"></div>';
        const historyContainer = taskView.querySelector('#taskview-chat-history') as HTMLElement;

        taskView.showPendingGoalSupplement('Use packages/appsdk as the target.', 'supp-1');
        expect(taskView.querySelector('.od-pending-context-entry')).not.toBeNull();

        expect(
            taskView._renderUserProgress(
                {
                    type: 'user',
                    task_status: 'running',
                    message_id: 'goal-supplement-user-1',
                    rawText: 'Use packages/appsdk as the target.',
                    internal: true,
                    metadata: {
                        origin: { source: 'internal', reason: 'goal_supplement' },
                        execution: { controller: 'goal', supplementIds: ['supp-1'] }
                    },
                    last_part: { type: 'text', rendered: '<p>hidden prompt</p>' },
                    last_part_index: 0,
                    isLastPart: true
                },
                historyContainer
            )
        ).toBe(true);

        expect(taskView.querySelector('.od-pending-context-entry')).toBeNull();
        expect(taskView.querySelector('#user-msg-goal-supplement-user-1')?.textContent).toContain(
            'Use packages/appsdk as the target.'
        );
        expect(taskView.textContent).not.toContain('hidden prompt');
        expect(taskView.querySelector('.waiting-usage-placeholder')?.textContent).toContain('正在等待模型响应');
    });

    test('removes pending goal supplement echoes by id instead of text containment', () => {
        const taskView = document.createElement('task-view') as HTMLElement & {
            task_id: string;
            showPendingGoalSupplement: (content: string, supplementId?: string) => void;
            _renderUserProgress: (progress: Record<string, unknown>, historyContainer: HTMLElement) => boolean;
        };
        taskView.task_id = 'task-1';
        taskView.innerHTML = '<div id="taskview-chat-history"></div>';
        const historyContainer = taskView.querySelector('#taskview-chat-history') as HTMLElement;

        taskView.showPendingGoalSupplement('first', 'supp-1');
        taskView.showPendingGoalSupplement('first\n\nsecond', 'supp-2');

        expect(
            taskView._renderUserProgress(
                {
                    type: 'user',
                    task_status: 'running',
                    message_id: 'goal-supplement-user-2',
                    rawText: 'first\n\nsecond',
                    internal: true,
                    metadata: {
                        origin: { source: 'internal', reason: 'goal_supplement' },
                        execution: { controller: 'goal', supplementIds: ['supp-2'] }
                    },
                    last_part: { type: 'text', rendered: '<p>hidden prompt</p>' },
                    last_part_index: 0,
                    isLastPart: true
                },
                historyContainer
            )
        ).toBe(true);

        const pending = Array.from(taskView.querySelectorAll('.od-pending-context-entry')).map((el) => el.textContent);
        expect(pending).toHaveLength(1);
        expect(pending[0]).toContain('first');
        expect(pending[0]).not.toContain('second');
    });

    test('shows pending goal edits as user echoes with the shared thinking placeholder', () => {
        const taskView = document.createElement('task-view') as HTMLElement & {
            task_id: string;
            task_status: string;
            showPendingGoalEdit: (
                type: 'create' | 'edit',
                objective: string,
                goalId: string,
                taskId?: string,
                goalRevision?: number
            ) => void;
        };
        taskView.task_id = 'task-1';
        taskView.task_status = 'running';
        taskView.innerHTML = '<div id="taskview-chat-history"></div>';

        taskView.showPendingGoalEdit('edit', 'Ship the CLI export fix', 'goal-1', 'task-1', 2);

        const echo = taskView.querySelector('.od-pending-context-entry');
        const placeholder = taskView.querySelector('.waiting-usage-placeholder');
        expect(echo?.textContent).toContain('Ship the CLI export fix');
        expect(echo?.getAttribute('data-pending-context-type')).toBe('goal_edit');
        expect(taskView.querySelector('.goal-edit-pending')).toBeNull();
        expect(placeholder?.textContent).toContain('正在等待模型响应');
        expect(placeholder).toBe(taskView.querySelector('#taskview-chat-history')?.lastElementChild);
    });

    test('does not echo pending goal creation when the slash command is already visible', () => {
        const taskView = document.createElement('task-view') as HTMLElement & {
            task_id: string;
            showPendingGoalEdit: (
                type: 'create' | 'edit',
                objective: string,
                goalId: string,
                taskId?: string,
                goalRevision?: number
            ) => void;
        };
        taskView.task_id = 'task-1';
        taskView.innerHTML = `
            <div id="taskview-chat-history">
                <div id="user-msg-goal-command-1" class="od-user-msg-container">
                    <div class="od-user-msg">/goal Ship the CLI export fix</div>
                </div>
            </div>
        `;

        taskView.showPendingGoalEdit('create', 'Ship the CLI export fix', 'goal-1', 'task-1', 1);

        const historyContainer = taskView.querySelector('#taskview-chat-history');
        expect(taskView.querySelector('.od-pending-context-entry')).toBeNull();
        expect(taskView.textContent?.match(/Ship the CLI export fix/g)).toHaveLength(1);
        expect(taskView.querySelector('.waiting-usage-placeholder')?.textContent).toContain('正在等待模型响应');
        expect(taskView.querySelector('.waiting-usage-placeholder')).toBe(historyContainer?.lastElementChild);
    });

    test('does not echo slash-command goal edits when the slash command is already visible', () => {
        const taskView = document.createElement('task-view') as HTMLElement & {
            task_id: string;
            showPendingSlashGoalCommand: () => void;
        };
        taskView.task_id = 'task-1';
        taskView.innerHTML = `
            <div id="taskview-chat-history">
                <div id="user-msg-goal-command-1" class="od-user-msg-container">
                    <div class="od-user-msg">/goal Ship the CLI export fix</div>
                </div>
            </div>
        `;
        taskView.showPendingSlashGoalCommand();

        const historyContainer = taskView.querySelector('#taskview-chat-history');
        expect(taskView.querySelector('.od-pending-context-entry')).toBeNull();
        expect(taskView.textContent?.match(/Ship the CLI export fix/g)).toHaveLength(1);
        expect(taskView.querySelector('.waiting-usage-placeholder')?.textContent).toContain('正在等待模型响应');
        expect(taskView.querySelector('.waiting-usage-placeholder')).toBe(historyContainer?.lastElementChild);
    });

    test('does not echo goal editor pending objective when the display message is already visible', () => {
        const taskView = document.createElement('task-view') as HTMLElement & {
            task_id: string;
            showPendingGoalEdit: (
                type: 'create' | 'edit',
                objective: string,
                goalId: string,
                taskId?: string,
                goalRevision?: number,
                options?: { suppressEcho?: boolean }
            ) => void;
            _pendingGoalEditMessage: unknown;
        };
        taskView.task_id = 'task-1';
        taskView.innerHTML = `
            <div id="taskview-chat-history">
                <div id="user-msg-goal-command-1" class="od-user-msg-container">
                    <div class="od-user-msg">/goal Ship the CLI export fix</div>
                </div>
            </div>
        `;

        taskView.showPendingGoalEdit('edit', 'Ship the CLI export fix', 'goal-1', 'task-1', 2, {
            suppressEcho: true
        });

        const historyContainer = taskView.querySelector('#taskview-chat-history');
        expect(taskView.querySelector('.od-pending-context-entry')).toBeNull();
        expect(taskView.textContent?.match(/Ship the CLI export fix/g)).toHaveLength(1);
        expect(taskView.querySelector('.waiting-usage-placeholder')?.textContent).toContain('正在等待模型响应');
        expect(taskView.querySelector('.waiting-usage-placeholder')).toBe(historyContainer?.lastElementChild);
        expect(taskView._pendingGoalEditMessage).not.toBeNull();
    });

    test('restores thinking placeholder after reload with a suppressed pending goal edit', () => {
        const taskView = document.createElement('task-view') as HTMLElement & {
            task_id: string;
            task_status: string;
            showPendingGoalEdit: (
                type: 'create' | 'edit',
                objective: string,
                goalId: string,
                taskId?: string,
                goalRevision?: number,
                options?: { suppressEcho?: boolean }
            ) => void;
            _renderInitialHistoryWindow: (
                messages: Array<Record<string, unknown>>,
                options?: Record<string, unknown>
            ) => void;
        };
        taskView.task_id = 'task-1';
        taskView.task_status = 'running';
        taskView.innerHTML = '<div id="taskview-chat-history"></div>';

        taskView.showPendingGoalEdit('edit', 'Ship the CLI export fix', 'goal-1', 'task-1', 2, {
            suppressEcho: true
        });
        taskView._renderInitialHistoryWindow([
            {
                role: 'user',
                message_id: 'goal-edit-display-1',
                rawText: '/goal Ship the CLI export fix',
                content: [{ type: 'text', rendered: '<p>/goal Ship the CLI export fix</p>' }],
                metadata: {
                    scope: 'goal',
                    origin: { source: 'internal', reason: 'goal_edit_display' }
                }
            }
        ]);

        const historyContainer = taskView.querySelector('#taskview-chat-history');
        expect(taskView.querySelector('.od-pending-context-entry')).toBeNull();
        expect(taskView.textContent?.match(/Ship the CLI export fix/g)).toHaveLength(1);
        expect(taskView.querySelector('.waiting-usage-placeholder')?.textContent).toContain('正在等待模型响应');
        expect(taskView.querySelector('.waiting-usage-placeholder')).toBe(historyContainer?.lastElementChild);
    });

    test('keeps a pending goal edit until the internal context reminder enters context', () => {
        const taskView = document.createElement('task-view') as HTMLElement & {
            task_id: string;
            showPendingGoalEdit: (
                type: 'create' | 'edit',
                objective: string,
                goalId: string,
                taskId?: string,
                goalRevision?: number
            ) => void;
            _renderUserProgress: (progress: Record<string, unknown>, historyContainer: HTMLElement) => boolean;
            _pendingGoalEditMessage: unknown;
        };
        taskView.task_id = 'task-1';
        taskView.innerHTML = '<div id="taskview-chat-history"></div>';
        const historyContainer = taskView.querySelector('#taskview-chat-history') as HTMLElement;

        taskView.showPendingGoalEdit('edit', 'Ship the CLI export fix', 'goal-1', 'task-1', 2);
        expect(taskView.querySelector('.od-pending-context-entry')).not.toBeNull();

        expect(
            taskView._renderUserProgress(
                {
                    type: 'user',
                    task_status: 'running',
                    message_id: 'goal-edit-display-1',
                    rawText: '/goal Ship the CLI export fix',
                    metadata: {
                        origin: { source: 'internal', reason: 'goal_edit_display' },
                        execution: { controllerId: 'goal-1' }
                    },
                    last_part: { type: 'text', rendered: '<p>/goal Ship the CLI export fix</p>' },
                    last_part_index: 0,
                    isLastPart: true
                },
                historyContainer
            )
        ).toBe(true);

        expect(taskView._pendingGoalEditMessage).not.toBeNull();
        expect(taskView.querySelector('.od-pending-context-entry')).not.toBeNull();
        expect(taskView.textContent).toContain('/goal Ship the CLI export fix');
        expect(taskView.querySelector('.waiting-usage-placeholder')?.textContent).toContain('正在等待模型响应');
    });

    test('syncs pending goal edit state to the artifacts panel', () => {
        const taskView = document.createElement('task-view') as HTMLElement & {
            task_id: string;
            showPendingGoalEdit: (
                type: 'create' | 'edit',
                objective: string,
                goalId: string,
                taskId?: string,
                goalRevision?: number
            ) => void;
            removePendingGoalEditByGoalId: (goalId: string) => void;
        };
        const setGoalEditPending = jest.fn();
        taskView.task_id = 'task-1';
        taskView.innerHTML = `
            <div id="taskview-chat-history"></div>
            <task-artifacts id="task-task-1-artifacts"></task-artifacts>
        `;
        const artifacts = taskView.querySelector('#task-task-1-artifacts') as HTMLElement & {
            setGoalEditPending: jest.Mock;
        };
        artifacts.setGoalEditPending = setGoalEditPending;

        taskView.showPendingGoalEdit('edit', 'Ship the CLI export fix', 'goal-1', 'task-1', 2);
        taskView.removePendingGoalEditByGoalId('goal-1');

        expect(setGoalEditPending).toHaveBeenNthCalledWith(1, true);
        expect(setGoalEditPending).toHaveBeenNthCalledWith(2, false);
    });

    test('keeps goal editing locked when refreshed goal summary reaches the pending revision', () => {
        const taskView = document.createElement('task-view') as HTMLElement & {
            task_id: string;
            showPendingGoalEdit: (
                type: 'create' | 'edit',
                objective: string,
                goalId: string,
                taskId?: string,
                goalRevision?: number
            ) => void;
            _syncArtifactsGoalState: (goal: Record<string, unknown>) => boolean;
            _pendingGoalEditMessage: { contextAccepted?: boolean } | null;
        };
        const setGoalEditPending = jest.fn();
        const setGoalState = jest.fn();
        taskView.task_id = 'task-1';
        taskView.task_status = 'running';
        taskView.innerHTML = `
            <div id="taskview-chat-history"></div>
            <task-artifacts id="task-task-1-artifacts"></task-artifacts>
        `;
        const artifacts = taskView.querySelector('#task-task-1-artifacts') as HTMLElement & {
            setGoalEditPending: jest.Mock;
            setGoalState: jest.Mock;
        };
        artifacts.setGoalEditPending = setGoalEditPending;
        artifacts.setGoalState = setGoalState;

        taskView.showPendingGoalEdit('edit', 'Ship the CLI export fix', 'goal-1', 'task-1', 2);
        expect(taskView._pendingGoalEditMessage).not.toBeNull();

        taskView._syncArtifactsGoalState({
            id: 'goal-1',
            status: 'active',
            revision: 2,
            objective: 'Ship the CLI export fix',
            pendingContinuation: false,
            updatedAt: '2026-07-09T10:00:00.000Z'
        });

        expect(taskView._pendingGoalEditMessage).not.toBeNull();
        expect(taskView._pendingGoalEditMessage?.contextAccepted).toBe(true);
        expect(setGoalEditPending).toHaveBeenNthCalledWith(1, true);
        expect(setGoalEditPending).toHaveBeenNthCalledWith(2, true);
        expect(setGoalState).toHaveBeenCalledWith(
            expect.objectContaining({
                id: 'goal-1',
                revision: 2
            })
        );
    });

    test('keeps thinking placeholder after reload once a sidebar goal edit summary is refreshed', () => {
        const taskView = document.createElement('task-view') as HTMLElement & {
            task_id: string;
            task_status: string;
            showPendingGoalEdit: (
                type: 'create' | 'edit',
                objective: string,
                goalId: string,
                taskId?: string,
                goalRevision?: number,
                options?: { suppressEcho?: boolean }
            ) => void;
            _syncArtifactsGoalState: (goal: Record<string, unknown>) => boolean;
            _renderInitialHistoryWindow: (
                messages: Array<Record<string, unknown>>,
                options?: Record<string, unknown>
            ) => void;
            _pendingGoalEditMessage: { contextAccepted?: boolean } | null;
        };
        const setGoalEditPending = jest.fn();
        const setGoalState = jest.fn();
        taskView.task_id = 'task-1';
        taskView.task_status = 'running';
        taskView.innerHTML = `
            <div id="taskview-chat-history"></div>
            <task-artifacts id="task-task-1-artifacts"></task-artifacts>
        `;
        const artifacts = taskView.querySelector('#task-task-1-artifacts') as HTMLElement & {
            setGoalEditPending: jest.Mock;
            setGoalState: jest.Mock;
        };
        artifacts.setGoalEditPending = setGoalEditPending;
        artifacts.setGoalState = setGoalState;

        taskView.showPendingGoalEdit('edit', 'Ship the CLI export fix', 'goal-1', 'task-1', 2, {
            suppressEcho: true
        });
        taskView._syncArtifactsGoalState({
            id: 'goal-1',
            status: 'active',
            revision: 2,
            objective: 'Ship the CLI export fix',
            pendingContinuation: false,
            updatedAt: '2026-07-09T10:00:00.000Z'
        });
        expect(taskView._pendingGoalEditMessage?.contextAccepted).toBe(true);

        taskView._renderInitialHistoryWindow([
            {
                role: 'user',
                message_id: 'goal-edit-display-1',
                rawText: '/goal Ship the CLI export fix',
                content: [{ type: 'text', rendered: '<p>/goal Ship the CLI export fix</p>' }],
                metadata: {
                    scope: 'goal',
                    origin: { source: 'internal', reason: 'goal_edit_display' }
                }
            }
        ]);

        const historyContainer = taskView.querySelector('#taskview-chat-history');
        expect(taskView._pendingGoalEditMessage).not.toBeNull();
        expect(taskView.querySelector('.od-pending-context-entry')).toBeNull();
        expect(taskView.textContent?.match(/Ship the CLI export fix/g)).toHaveLength(1);
        expect(taskView.querySelector('.waiting-usage-placeholder')?.textContent).toContain('正在等待模型响应');
        expect(taskView.querySelector('.waiting-usage-placeholder')).toBe(historyContainer?.lastElementChild);
        expect(setGoalEditPending).toHaveBeenNthCalledWith(1, true);
        expect(setGoalEditPending).toHaveBeenNthCalledWith(2, true);
        expect(setGoalEditPending).toHaveBeenNthCalledWith(3, true);
        expect(setGoalState).toHaveBeenCalledWith(expect.objectContaining({ id: 'goal-1' }));
    });

    test('does not restore thinking placeholder for an accepted sidebar goal edit after the task stops', () => {
        const taskView = document.createElement('task-view') as HTMLElement & {
            task_id: string;
            task_status: string;
            showPendingGoalEdit: (
                type: 'create' | 'edit',
                objective: string,
                goalId: string,
                taskId?: string,
                goalRevision?: number,
                options?: { suppressEcho?: boolean }
            ) => void;
            _syncArtifactsGoalState: (goal: Record<string, unknown>) => boolean;
            _renderInitialHistoryWindow: (
                messages: Array<Record<string, unknown>>,
                options?: Record<string, unknown>
            ) => void;
            _pendingGoalEditMessage: { contextAccepted?: boolean } | null;
        };
        const setGoalEditPending = jest.fn();
        const setGoalState = jest.fn();
        taskView.task_id = 'task-1';
        taskView.task_status = 'running';
        taskView.innerHTML = `
            <div id="taskview-chat-history"></div>
            <task-artifacts id="task-task-1-artifacts"></task-artifacts>
        `;
        const artifacts = taskView.querySelector('#task-task-1-artifacts') as HTMLElement & {
            setGoalEditPending: jest.Mock;
            setGoalState: jest.Mock;
        };
        artifacts.setGoalEditPending = setGoalEditPending;
        artifacts.setGoalState = setGoalState;

        taskView.showPendingGoalEdit('edit', 'Ship the CLI export fix', 'goal-1', 'task-1', 2, {
            suppressEcho: true
        });
        const goal = {
            id: 'goal-1',
            status: 'active',
            revision: 2,
            objective: 'Ship the CLI export fix',
            pendingContinuation: false,
            updatedAt: '2026-07-09T10:00:00.000Z'
        };
        taskView._syncArtifactsGoalState(goal);
        taskView.task_status = 'stopped';

        taskView._renderInitialHistoryWindow(
            [
                {
                    role: 'user',
                    message_id: 'goal-edit-display-1',
                    rawText: '/goal Ship the CLI export fix',
                    content: [{ type: 'text', rendered: '<p>/goal Ship the CLI export fix</p>' }],
                    metadata: {
                        scope: 'goal',
                        origin: { source: 'internal', reason: 'goal_edit_display' }
                    }
                }
            ],
            { goal }
        );

        expect(taskView._pendingGoalEditMessage).not.toBeNull();
        expect(taskView.querySelector('.waiting-usage-placeholder')).toBeNull();
        expect(taskView.querySelector('.od-pending-context-entry')).toBeNull();
        expect(setGoalEditPending).toHaveBeenNthCalledWith(1, true);
        expect(setGoalEditPending).toHaveBeenNthCalledWith(2, true);
        expect(setGoalEditPending).toHaveBeenNthCalledWith(3, true);
    });

    test('clears pending goal edit when the task leaves running state before the reminder arrives', () => {
        const taskView = document.createElement('task-view') as HTMLElement & {
            task_id: string;
            task_status: string;
            showPendingGoalEdit: (
                type: 'create' | 'edit',
                objective: string,
                goalId: string,
                taskId?: string,
                goalRevision?: number
            ) => void;
            _handleTaskStatusUpdate: (nextStatus?: string) => boolean;
            _pendingGoalEditMessage: unknown;
        };
        const setGoalEditPending = jest.fn();
        taskView.task_id = 'task-1';
        taskView.task_status = 'running';
        taskView.innerHTML = `
            <div id="taskview-chat-history"></div>
            <task-artifacts id="task-task-1-artifacts"></task-artifacts>
        `;
        const artifacts = taskView.querySelector('#task-task-1-artifacts') as HTMLElement & {
            setGoalEditPending: jest.Mock;
            setTaskRunning: jest.Mock;
        };
        artifacts.setGoalEditPending = setGoalEditPending;
        artifacts.setTaskRunning = jest.fn();

        taskView.showPendingGoalEdit('edit', 'Ship the CLI export fix', 'goal-1', 'task-1', 2);
        expect(taskView._pendingGoalEditMessage).not.toBeNull();

        expect(taskView._handleTaskStatusUpdate('stopped')).toBe(true);

        expect(taskView._pendingGoalEditMessage).toBeNull();
        expect(taskView.querySelector('.od-pending-context-entry')).toBeNull();
        expect(setGoalEditPending).toHaveBeenNthCalledWith(1, true);
        expect(setGoalEditPending).toHaveBeenNthCalledWith(2, false);
    });

    test('clears pending goal edit when the current goal changes before the reminder arrives', () => {
        const taskView = document.createElement('task-view') as HTMLElement & {
            task_id: string;
            showPendingGoalEdit: (
                type: 'create' | 'edit',
                objective: string,
                goalId: string,
                taskId?: string,
                goalRevision?: number
            ) => void;
            _syncArtifactsGoalState: (goal: Record<string, unknown>) => boolean;
            _pendingGoalEditMessage: unknown;
        };
        const setGoalEditPending = jest.fn();
        const setGoalState = jest.fn();
        taskView.task_id = 'task-1';
        taskView.innerHTML = `
            <div id="taskview-chat-history"></div>
            <task-artifacts id="task-task-1-artifacts"></task-artifacts>
        `;
        const artifacts = taskView.querySelector('#task-task-1-artifacts') as HTMLElement & {
            setGoalEditPending: jest.Mock;
            setGoalState: jest.Mock;
        };
        artifacts.setGoalEditPending = setGoalEditPending;
        artifacts.setGoalState = setGoalState;

        taskView.showPendingGoalEdit('edit', 'Ship the CLI export fix', 'goal-1', 'task-1', 2);
        taskView._syncArtifactsGoalState({
            id: 'goal-2',
            status: 'active',
            revision: 1,
            objective: 'New goal',
            pendingContinuation: false,
            updatedAt: '2026-07-09T10:05:00.000Z'
        });

        expect(taskView._pendingGoalEditMessage).toBeNull();
        expect(setGoalEditPending).toHaveBeenNthCalledWith(1, true);
        expect(setGoalEditPending).toHaveBeenNthCalledWith(2, false);
        expect(setGoalState).toHaveBeenCalledWith(
            expect.objectContaining({
                id: 'goal-2'
            })
        );
    });

    test('replaces an active goal evaluation card when editing supersedes the evaluation', () => {
        const taskView = document.createElement('task-view') as HTMLElement & {
            task_id: string;
            _handleGoalEvalProgress: (progress: Record<string, unknown>) => void;
        };
        taskView.task_id = 'task-1';
        taskView.innerHTML = '<div id="taskview-chat-history"></div>';

        taskView._handleGoalEvalProgress({
            type: 'goal_eval',
            task_id: 'task-1',
            phase: 'start',
            status: 'running',
            goalId: 'goal-1',
            goalRevision: 2,
            startedAt: '2026-07-09T10:00:00.000Z',
            message: ''
        });
        expect(taskView.querySelector('.od-goal-eval-start')?.textContent).toContain('正在评估目标达成情况');

        taskView._handleGoalEvalProgress({
            type: 'goal_eval',
            task_id: 'task-1',
            phase: 'end',
            status: 'superseded',
            goalId: 'goal-1',
            goalRevision: 2,
            updatedAt: '2026-07-09T10:01:00.000Z',
            message: '当前 goal objective 已在评估过程中被用户修改，请按新的 objective 继续推进。'
        });

        expect(taskView.querySelector('.od-goal-eval-start')).toBeNull();
        expect(taskView.querySelectorAll('.od-goal-eval-container')).toHaveLength(1);
        expect(taskView.querySelector('.od-goal-eval-end.od-goal-eval-status-superseded')?.textContent).toContain(
            '已被取代'
        );
        expect(taskView.textContent).not.toContain('正在评估目标达成情况');
        expect(taskView.querySelector('.waiting-usage-placeholder')?.textContent).toContain('正在等待模型响应');
    });

    test('moves a superseded evaluation below a goal edit when the edit message renders late', () => {
        const taskView = document.createElement('task-view') as HTMLElement & {
            task_id: string;
            _handleGoalEvalProgress: (progress: Record<string, unknown>) => void;
            _renderUserProgress: (progress: Record<string, unknown>, historyContainer: HTMLElement) => boolean;
        };
        taskView.task_id = 'task-1';
        taskView.innerHTML = `
            <div id="taskview-chat-history">
                <div class="od-assistant-msg-container">
                    <div id="message-container-assistant-1">
                        <div id="message-content-assistant-1">Previous goal output</div>
                    </div>
                </div>
            </div>
        `;
        const historyContainer = taskView.querySelector('#taskview-chat-history') as HTMLElement;

        taskView._handleGoalEvalProgress({
            type: 'goal_eval',
            task_id: 'task-1',
            phase: 'start',
            goalId: 'goal-1',
            goalRevision: 1,
            evaluationId: 'eval-1',
            anchorMessageId: 'assistant-1',
            startedAt: '2026-07-09T10:00:00.000Z'
        });
        taskView._handleGoalEvalProgress({
            type: 'goal_eval',
            task_id: 'task-1',
            phase: 'end',
            status: 'superseded',
            goalId: 'goal-1',
            goalRevision: 1,
            evaluationId: 'eval-1',
            anchorMessageId: 'goal-edit-display-1',
            evaluatedAt: '2026-07-09T10:01:00.000Z',
            message: 'The goal changed during evaluation.'
        });

        expect(
            taskView._renderUserProgress(
                {
                    type: 'user',
                    task_status: 'running',
                    message_id: 'goal-edit-display-1',
                    rawText: '/goal Updated goal',
                    metadata: {
                        origin: { source: 'internal', reason: 'goal_edit_display' },
                        execution: { controllerId: 'goal-1', controllerRevision: 2 }
                    },
                    last_part: { type: 'text', rendered: '<p>/goal Updated goal</p>' },
                    last_part_index: 0,
                    isLastPart: true
                },
                historyContainer
            )
        ).toBe(true);

        const children = Array.from(historyContainer.children);
        const editMessage = taskView.querySelector('#user-msg-goal-edit-display-1');
        const evaluation = taskView.querySelector('.od-goal-eval-end.od-goal-eval-status-superseded');
        const placeholder = taskView.querySelector('.waiting-usage-placeholder');
        expect(children.indexOf(editMessage as Element)).toBeLessThan(children.indexOf(evaluation as Element));
        expect(children.indexOf(evaluation as Element)).toBeLessThan(children.indexOf(placeholder as Element));
    });

    test('does not replace an arbitrary active evaluation when fallback identity is ambiguous', () => {
        const taskView = document.createElement('task-view') as HTMLElement & {
            task_id: string;
            _handleGoalEvalProgress: (progress: Record<string, unknown>) => void;
        };
        taskView.task_id = 'task-1';
        taskView.innerHTML = '<div id="taskview-chat-history"></div>';

        taskView._handleGoalEvalProgress({
            type: 'goal_eval',
            task_id: 'task-1',
            phase: 'start',
            status: 'running',
            goalId: 'goal-1',
            goalRevision: 2,
            startedAt: '2026-07-09T10:00:00.000Z'
        });
        taskView._handleGoalEvalProgress({
            type: 'goal_eval',
            task_id: 'task-1',
            phase: 'start',
            status: 'running',
            goalId: 'goal-1',
            goalRevision: 2,
            startedAt: '2026-07-09T10:00:01.000Z'
        });

        taskView._handleGoalEvalProgress({
            type: 'goal_eval',
            task_id: 'task-1',
            phase: 'end',
            status: 'superseded',
            goalId: 'goal-1',
            goalRevision: 2,
            updatedAt: '2026-07-09T10:01:00.000Z'
        });

        expect(taskView.querySelectorAll('.od-goal-eval-start')).toHaveLength(2);
        expect(taskView.querySelectorAll('.od-goal-eval-end.od-goal-eval-status-superseded')).toHaveLength(1);
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
        const addGoalSupplement = jest.fn(async () => ({ ok: true, supplementId: 'supp-1' }));
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
        expect(history.querySelector('.od-pending-context-entry')?.textContent).toContain(
            'Use packages/appsdk as the target.'
        );
        expect(history.querySelector('.od-pending-context-entry')?.classList.contains('od-user-msg-container')).toBe(
            true
        );
        expect(history.querySelector('.goal-supplement-pending')).toBeNull();
        expect(history.querySelector('.waiting-usage-placeholder')?.textContent).toContain('正在等待模型响应');

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
                        execution: { controller: 'goal', supplementIds: ['supp-1'] }
                    }
                },
                history
            )
        ).toBe(true);
        expect(taskView._pendingGoalSupplementMessages).toHaveLength(0);
        expect(history.querySelector('.od-pending-context-entry')).toBeNull();
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

        expect(taskView.querySelector('.od-pending-context-entry')?.textContent).toContain('更新导出目标');
        expect(taskView.querySelector('.od-pending-context-entry')?.getAttribute('data-pending-context-type')).toBe(
            'goal_edit'
        );
        expect(taskView.querySelector('.goal-edit-pending')).toBeNull();
        expect(taskView.querySelector('.waiting-usage-placeholder')?.textContent).toContain('正在等待模型响应');
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
        expect(taskView.querySelector('.od-pending-context-entry')).toBeNull();
    });

    test('consumes internal goal edit reminders even when incremental rendering is skipped', () => {
        const taskView = document.createElement('task-view') as HTMLElement & {
            task_id: string;
            showPendingGoalEdit: (type: 'create' | 'edit', objective: string, goalId: string, taskId?: string) => void;
            _consumeGoalEditReminder: (progress: Record<string, unknown>) => void;
            _pendingGoalEditMessage: unknown;
        };
        taskView.task_id = 'task-1';
        taskView.innerHTML = '<div id="taskview-chat-history"></div>';

        taskView.showPendingGoalEdit('edit', '更新导出目标', 'goal-1', 'task-1');
        expect(taskView._pendingGoalEditMessage).not.toBeNull();

        taskView._consumeGoalEditReminder({
            type: 'user',
            task_status: 'running',
            message_id: 'goal-edit-user-1',
            internal: true,
            metadata: {
                origin: { source: 'internal', reason: 'goal_edit' },
                execution: { controllerId: 'goal-1' }
            },
            last_part: {
                type: 'text',
                rendered: '<p>&lt;system-reminder&gt;hidden internal prompt</p>'
            },
            last_part_index: 0
        });

        expect(taskView._pendingGoalEditMessage).toBeNull();
        expect(taskView.querySelector('.od-pending-context-entry')).toBeNull();
    });

    test('restores the thinking placeholder when an internal goal edit reminder starts the next turn', () => {
        const taskView = document.createElement('task-view') as HTMLElement & {
            task_id: string;
            task_status: string;
            _currentGoal: Record<string, unknown>;
            _renderUserProgress: (progress: Record<string, unknown>, historyContainer: HTMLElement) => boolean;
        };
        taskView.task_id = 'task-1';
        taskView.task_status = 'stopped';
        taskView._currentGoal = { id: 'goal-1', status: 'active', revision: 2 };
        taskView.innerHTML = `
            <div id="taskview-chat-history">
                <div class="od-assistant-msg-container">
                    <div id="message-container-assistant-1">
                        <div id="message-content-assistant-1">Previous goal output</div>
                    </div>
                </div>
            </div>
        `;
        const history = taskView.querySelector('#taskview-chat-history') as HTMLElement;

        expect(
            taskView._renderUserProgress(
                {
                    type: 'user',
                    task_status: 'running',
                    message_id: 'goal-edit-user-1',
                    internal: true,
                    metadata: {
                        origin: { source: 'internal', reason: 'goal_edit' },
                        execution: { controllerId: 'goal-1', controllerRevision: 2 }
                    },
                    last_part: { type: 'text', rendered: '<p>hidden internal prompt</p>' },
                    last_part_index: 0
                },
                history
            )
        ).toBe(false);

        expect(history.textContent).not.toContain('hidden internal prompt');
        expect(history.querySelector('.waiting-usage-placeholder')?.textContent).toContain('正在等待模型响应');
        expect(history.querySelector('.waiting-usage-placeholder')).toBe(history.lastElementChild);
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
