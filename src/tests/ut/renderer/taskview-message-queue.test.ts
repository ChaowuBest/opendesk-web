import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

/**
 * 与 goal.test.ts 保持一致的处理：
 * 部分 Node + Jest ESM 组合下，jest.useRealTimers() 恢复后会把计时器全局变量
 * 置为 undefined（表现为后续用例 ReferenceError: setInterval is not defined），
 * 因此在模块加载时保存真实计时器引用，恢复时显式写回 globalThis。
 */
const realTimerGlobals = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    setImmediate: globalThis.setImmediate,
    clearImmediate: globalThis.clearImmediate
};

function restoreRealTimerGlobals(): void {
    jest.useRealTimers();
    Object.assign(globalThis, realTimerGlobals);
}

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

    beforeEach(() => {
        submitMessage = jest.fn(async () => undefined);
        window.taskManagerAPI = {
            submitMessage
        };
    });

    test('interrupts the current turn without stopping child tasks before sending a queued message immediately', async () => {
        const interruptForNewMessage = jest.fn(async () => undefined);
        window.taskManagerAPI = {
            submitMessage,
            interruptForNewMessage
        };
        const taskView = document.createElement('task-view') as HTMLElement & {
            task_id: string;
            task_status: string;
            messageQueue: Array<{
                id: string;
                message: string;
                attachedFilePaths: string[];
                attachedImages: string[];
                selectedExecutionNodeId?: string | null;
            }>;
            _handleRunningGoalInput: jest.Mock;
            _updateMessageQueuePanel: jest.Mock;
            sendQueueMessageImmediately: (id: string) => Promise<void>;
        };
        taskView.task_id = 'task-1';
        taskView.task_status = 'running';
        taskView.messageQueue = [
            {
                id: 'queue-1',
                message: 'send now',
                attachedFilePaths: [],
                attachedImages: [],
                selectedExecutionNodeId: 'node-1'
            }
        ];
        taskView._handleRunningGoalInput = jest.fn(async () => 'not-goal');
        taskView._updateMessageQueuePanel = jest.fn();

        await taskView.sendQueueMessageImmediately('queue-1');

        expect(interruptForNewMessage).toHaveBeenCalledWith('task-1');
        expect(submitMessage).toHaveBeenCalledWith('task-1', {
            message: 'send now',
            attachedFilePaths: [],
            attachedImages: [],
            selectedModel: undefined,
            reasoningEffort: undefined,
            selectedExecutionNodeId: 'node-1'
        });
        expect(interruptForNewMessage.mock.invocationCallOrder[0]).toBeLessThan(
            submitMessage.mock.invocationCallOrder[0]
        );
        expect(taskView.messageQueue).toHaveLength(0);
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

    test('cancels an idle browser recycle timer when reload observes a running task', async () => {
        const cancelBrowserIdleTimer = jest.fn();
        window.taskManagerAPI = {
            ...window.taskManagerAPI,
            getFullTask: jest.fn(async () => ({
                task_status: 'running',
                chat_context: { messages: [] }
            })),
            getModelContextSize: jest.fn(async () => 0),
            getTaskTodos: jest.fn(async () => [])
        };
        const taskView = document.createElement('task-view') as HTMLElement & {
            task_id: string;
            task_status: string;
            reload: () => Promise<void>;
            _cancelBrowserIdleTimer: jest.Mock;
        };
        taskView.task_id = 'task-running-after-reload';
        taskView.task_status = 'stopped';
        taskView._cancelBrowserIdleTimer = cancelBrowserIdleTimer;
        taskView.innerHTML = '<div id="taskview-chat-history"></div>';

        await taskView.reload();

        expect(taskView.task_status).toBe('running');
        expect(cancelBrowserIdleTimer).toHaveBeenCalledTimes(1);
    });

    test('signals first-screen readiness when reload completes', async () => {
        window.taskManagerAPI = {
            ...window.taskManagerAPI,
            getFullTask: jest.fn(async () => ({
                task_status: 'running',
                chat_context: { messages: [] }
            })),
            getModelContextSize: jest.fn(async () => 0),
            getTaskTodos: jest.fn(async () => [])
        };
        const taskView = document.createElement('task-view') as HTMLElement & {
            task_id: string;
            reload: () => Promise<void>;
        };
        taskView.task_id = 'task-ready-success';
        taskView.innerHTML = '<div id="taskview-chat-history"></div>';
        const readyListener = jest.fn();
        taskView.addEventListener('task-view-content-ready', readyListener);

        await taskView.reload();

        // openTask 的加载占位依赖该信号淡出，正常加载完成必须派发
        expect(readyListener).toHaveBeenCalledTimes(1);
    });

    test('signals first-screen readiness even when reload fails', async () => {
        window.taskManagerAPI = {
            ...window.taskManagerAPI,
            getFullTask: jest.fn(async () => {
                throw new Error('task load failed');
            })
        };
        const taskView = document.createElement('task-view') as HTMLElement & {
            task_id: string;
            reload: () => Promise<void>;
        };
        taskView.task_id = 'task-ready-failure';
        const readyListener = jest.fn();
        taskView.addEventListener('task-view-content-ready', readyListener);

        // 加载异常时也必须派发，否则 openTask 的加载占位要等到超时兜底才消失
        await expect(taskView.reload()).rejects.toThrow('task load failed');
        expect(readyListener).toHaveBeenCalledTimes(1);
    });

    test('a stale idle timer rechecks task status before recycling the browser', () => {
        jest.useFakeTimers();
        try {
            const recycleBrowser = jest.fn();
            const destroyBrowser = jest.fn();
            const taskView = document.createElement('task-view') as HTMLElement & {
                task_id: string;
                task_status: string;
                _getRightSidebarEl: () => {
                    isBrowserVisible: () => boolean;
                    recycleBrowser: jest.Mock;
                    destroyBrowser: jest.Mock;
                };
                _startBrowserIdleTimer: () => void;
            };
            taskView.task_id = 'task-stale-idle-timer';
            taskView.task_status = 'stopped';
            taskView._getRightSidebarEl = () => ({
                isBrowserVisible: () => true,
                recycleBrowser,
                destroyBrowser
            });

            taskView._startBrowserIdleTimer();
            taskView.task_status = 'running';
            jest.advanceTimersByTime(5 * 60 * 1000);

            expect(recycleBrowser).not.toHaveBeenCalled();
            expect(destroyBrowser).not.toHaveBeenCalled();
        } finally {
            restoreRealTimerGlobals();
        }
    });

    test('idle recycling waits while the user is currently viewing the Browser tab', () => {
        jest.useFakeTimers();
        try {
            const recycleBrowser = jest.fn();
            const taskView = document.createElement('task-view') as HTMLElement & {
                task_id: string;
                task_status: string;
                _getRightSidebarEl: () => {
                    isBrowserVisible: () => boolean;
                    isBrowserPresentedToUser: () => boolean;
                    recycleBrowser: jest.Mock;
                };
                _startBrowserIdleTimer: () => void;
            };
            taskView.task_id = 'task-visible-browser';
            taskView.task_status = 'stopped';
            taskView._getRightSidebarEl = () => ({
                isBrowserVisible: () => true,
                isBrowserPresentedToUser: () => true,
                recycleBrowser
            });

            taskView._startBrowserIdleTimer();
            jest.advanceTimersByTime(5 * 60 * 1000);

            expect(recycleBrowser).not.toHaveBeenCalled();
            expect(jest.getTimerCount()).toBe(1);
        } finally {
            restoreRealTimerGlobals();
        }
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

    test('animates the task and focused workspace columns to a one-to-three ratio', () => {
        const taskView = document.createElement('task-view') as HTMLElement & {
            task_id: string;
            _rightSidebarExpanded: boolean;
            render: () => void;
        };
        taskView.task_id = 'task-1';
        taskView._rightSidebarExpanded = true;
        taskView.render();
        const artifacts = taskView.querySelector<HTMLElement>('#task-task-1-artifacts')!;
        const collapseRequests: Array<{ collapsed?: boolean; persist?: boolean }> = [];
        const onCollapseRequest = (event: Event) => {
            collapseRequests.push((event as CustomEvent<{ collapsed?: boolean; persist?: boolean }>).detail);
        };
        document.addEventListener('sidebar-collapse-request', onCollapseRequest);

        taskView.dispatchEvent(
            new CustomEvent('workspace-focus-layout-change', { detail: { active: true, fullscreen: true } })
        );

        expect(artifacts.style.width).toBe('70%');
        expect(artifacts.style.transition).toContain('width');
        expect(collapseRequests).toEqual([{ collapsed: true, persist: false }]);

        taskView.dispatchEvent(
            new CustomEvent('workspace-focus-layout-change', { detail: { active: false, fullscreen: false } })
        );

        expect(artifacts.style.width).toBe('380px');
        document.removeEventListener('sidebar-collapse-request', onCollapseRequest);
    });

    test('suspends preview layout without changing the selected tab when the right sidebar is collapsed', () => {
        const taskView = document.createElement('task-view') as HTMLElement & {
            task_id: string;
            _rightSidebarExpanded: boolean;
            _rightSidebarWidth: number;
            render: () => void;
            _collapseRightSidebar: (rightSidebar: HTMLElement, resizer: HTMLElement | null) => void;
            _expandRightSidebar: (rightSidebar: HTMLElement, resizer: HTMLElement | null) => void;
        };
        taskView.task_id = 'task-1';
        taskView._rightSidebarExpanded = true;
        taskView.render();
        const artifacts = taskView.querySelector<HTMLElement>('#task-task-1-artifacts')! as HTMLElement & {
            suspendPreviewLayout: jest.Mock;
        };
        const resizer = taskView.querySelector<HTMLElement>('#task-task-1-resizer');
        artifacts.suspendPreviewLayout = jest.fn();

        taskView.dispatchEvent(
            new CustomEvent('workspace-focus-layout-change', { detail: { active: true, fullscreen: true } })
        );
        taskView._collapseRightSidebar(artifacts, resizer);

        expect(artifacts.suspendPreviewLayout).toHaveBeenCalled();
        expect(taskView._rightSidebarWidth).toBe(380);

        taskView._expandRightSidebar(artifacts, resizer);

        expect(artifacts.style.width).toBe('70%');
    });

    test('opens a slash skill pill in the shared skill detail modal', async () => {
        const callMainWorld = jest.fn(async () => ({
            id: 'calendar/calendar',
            name: 'calendar',
            description: 'Calendar skill',
            body: '# Calendar',
            directory: '/skills/calendar'
        }));
        Object.defineProperty(window, 'applicationRegistryAPI', {
            configurable: true,
            writable: true,
            value: { callMainWorld }
        });
        const taskView = document.createElement('task-view') as HTMLElement & {
            _handleSkillPillClick: (event: unknown) => Promise<void>;
        };
        const pill = document.createElement('a');
        pill.className = 'od-skill-pill';
        pill.dataset.skillBundle = 'calendar';
        pill.dataset.skillName = 'calendar';
        taskView.appendChild(pill);

        await taskView._handleSkillPillClick({
            target: pill,
            preventDefault: jest.fn(),
            stopPropagation: jest.fn()
        });

        expect(callMainWorld).toHaveBeenCalledWith('skillmgr', 'getSkillDetailForReference', 'calendar', 'calendar');
        const card = taskView.querySelector('#taskview-skill-detail') as HTMLElement & { shadowRoot: ShadowRoot };
        expect(card).not.toBeNull();
        expect(card.shadowRoot.querySelector('.detail-dialog')).not.toBeNull();
        expect(card.shadowRoot.querySelector('.detail-name')?.textContent).toBe('calendar');
        taskView.remove();
        Object.defineProperty(window, 'applicationRegistryAPI', {
            configurable: true,
            writable: true,
            value: undefined
        });
    });

    test('reveals a Windows file pill through the filesystem API', () => {
        const showItemInFolder = jest.fn(async () => undefined);
        window.fsAPI = { showItemInFolder };
        const taskView = document.createElement('task-view') as HTMLElement & {
            _handleFilePillContextMenu: (event: unknown) => void;
        };
        const pill = document.createElement('a');
        pill.className = 'od-file-pill';
        pill.dataset.openPreview = 'C:\\Users\\Alice\\report.html';
        taskView.appendChild(pill);

        taskView._handleFilePillContextMenu({
            target: pill,
            preventDefault: jest.fn(),
            stopPropagation: jest.fn(),
            clientX: 0,
            clientY: 0
        });
        (document.querySelector('[data-action="reveal"]') as HTMLButtonElement).click();

        expect(showItemInFolder).toHaveBeenCalledWith('C:\\Users\\Alice\\report.html');
        taskView.remove();
        delete window.fsAPI;
    });

    test('restores the configured width when switching back to a cached task with an expanded sidebar', () => {
        const taskView = document.createElement('task-view') as HTMLElement & {
            task_id: string;
            _rightSidebarExpanded: boolean;
            _rightSidebarWidth: number;
            render: () => void;
            syncRightSidebarState: () => void;
        };
        taskView.task_id = 'task-1';
        taskView._rightSidebarExpanded = true;
        taskView._rightSidebarWidth = 512;
        taskView.render();
        const artifacts = taskView.querySelector<HTMLElement>('#task-task-1-artifacts')!;
        artifacts.style.width = '0px';

        expect(() => taskView.syncRightSidebarState()).not.toThrow();
        expect(artifacts.style.width).toBe('512px');
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

    async function createStreamingSubscription() {
        let receive!: (progress: Record<string, unknown>) => void;
        window.taskManagerAPI = {
            getFullTask: jest.fn(async () => ({ task_status: 'running', chat_context: { messages: [] } })),
            getModelContextSize: jest.fn(async () => 0),
            getTaskTodos: jest.fn(async () => []),
            subscribeTaskUpdate: jest.fn(async (_id, callback) => {
                receive = callback;
                return 'stream-sub';
            }),
            unsubscribeTaskUpdate: jest.fn(async () => undefined)
        };
        const view = document.createElement('task-view') as any;
        view.setAttribute('task_id', 'stream-task');
        view.setAttribute('embedded', '');
        document.body.appendChild(view);
        for (let i = 0; i < 10 && !receive; i++) await Promise.resolve();
        expect(receive).toBeDefined();
        return { view, receive };
    }

    function streamedText(text: string, status = 'running') {
        return {
            type: 'assistant',
            task_id: 'stream-task',
            task_status: status,
            message_id: 'stream-message',
            last_part_index: 0,
            last_part: { type: 'text', text, rendered: `<p>${text}</p>` }
        };
    }

    test('coalesces subscribed text bursts and flushes final content before completion cleanup', async () => {
        const { view, receive } = await createStreamingSubscription();
        const render = jest.spyOn(view, '_renderAssistantProgress');
        jest.useFakeTimers();
        try {
            for (let i = 0; i < 100; i++) receive(streamedText(`answer ${i}`));
            expect(render).not.toHaveBeenCalled();
            jest.advanceTimersByTime(50);
            expect(render).toHaveBeenCalledTimes(1);
            expect(view.querySelector('.markdown-body').textContent).toBe('answer 99');
            receive(streamedText('pending tail'));
            receive(streamedText('complete answer', 'stopped'));
            expect(view.querySelector('.markdown-body').textContent).toBe('complete answer');
            expect(view.task_status).toBe('stopped');
            expect(view.querySelectorAll('.stream-cursor')).toHaveLength(0);
            jest.advanceTimersByTime(100);
            expect(view.querySelector('.markdown-body').textContent).toBe('complete answer');
        } finally {
            view.remove();
            restoreRealTimerGlobals();
        }
    });

    test('manual stop flushes pending text without resurrecting running status or the cursor', async () => {
        const { view, receive } = await createStreamingSubscription();
        jest.useFakeTimers();
        try {
            receive(streamedText('last received text'));
            view.task_status = 'stopped';
            view._cleanupStreamingState();
            expect(view.querySelector('.markdown-body').textContent).toBe('last received text');
            expect(view.task_status).toBe('stopped');
            expect(view.querySelectorAll('.stream-cursor')).toHaveLength(0);
            jest.advanceTimersByTime(100);
            expect(view.querySelectorAll('.stream-cursor')).toHaveLength(0);
        } finally {
            view.remove();
            restoreRealTimerGlobals();
        }
    });

    test('replacement and tool boundaries cannot be overwritten by buffered text', async () => {
        const { view, receive } = await createStreamingSubscription();
        jest.useFakeTimers();
        try {
            receive(streamedText('pending text'));
            receive({
                ...streamedText(''),
                last_part_index: 1,
                last_part: { type: 'tool_call', rendered: '<div>tool result</div>' }
            });
            expect(view.textContent).toContain('pending text');
            expect(view.textContent).toContain('tool result');
            receive(streamedText('queued correction'));
            receive({
                type: 'assistant_replace',
                task_status: 'running',
                message_id: 'stream-message',
                parts: [{ type: 'text', rendered: '<p>authoritative replacement</p>' }]
            });
            jest.advanceTimersByTime(100);
            expect(view.querySelector('.markdown-body').textContent).toBe('authoritative replacement');
            expect(view.textContent).not.toContain('queued correction');
        } finally {
            view.remove();
            restoreRealTimerGlobals();
        }
    });

    test.each(['reload', 'remove', 'background'] as const)('discards buffered text on %s', async (action) => {
        const { view, receive } = await createStreamingSubscription();
        const render = jest.spyOn(view, '_renderAssistantProgress');
        jest.useFakeTimers();
        try {
            receive(streamedText('stale text'));
            if (action === 'reload') await view.reload();
            if (action === 'remove') view.remove();
            if (action === 'background') {
                view.style.display = 'none';
                receive(streamedText('hidden text'));
                view.style.display = '';
            }
            jest.advanceTimersByTime(100);
            expect(render).not.toHaveBeenCalled();
            expect(view.textContent).not.toContain('stale text');
        } finally {
            view.remove();
            restoreRealTimerGlobals();
        }
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

    test('streaming text keeps completed blocks and their controls while updating the tail', () => {
        const taskView = document.createElement('task-view') as HTMLElement & {
            task_id: string;
            _renderAssistantProgress: (progress: Record<string, unknown>, historyContainer: HTMLElement) => boolean;
        };
        taskView.task_id = 'task-streaming-text';
        taskView.innerHTML = '<div id="taskview-chat-history"></div>';
        const history = taskView.querySelector('#taskview-chat-history') as HTMLElement;
        const update = (rendered: string) =>
            taskView._renderAssistantProgress(
                {
                    task_status: 'running',
                    message_id: 'streaming-text',
                    last_part_index: 0,
                    last_part: { type: 'text', rendered }
                },
                history
            );
        const prefix = '<h2>Completed section</h2><div class="code-block-wrapper"><pre>const n = 1;</pre></div>';
        update(prefix + '<p>Partial</p>');
        const heading = taskView.querySelector('h2');
        const block = taskView.querySelector('.code-block-wrapper')!;
        const button = document.createElement('button');
        const copy = jest.fn();
        button.addEventListener('click', copy);
        block.appendChild(button);

        update(prefix + '<p>Partial answer</p>');
        expect(taskView.querySelector('h2')).toBe(heading);
        expect(taskView.querySelector('.code-block-wrapper')).toBe(block);
        expect(taskView.contains(button)).toBe(true);
        button.click();
        expect(copy).toHaveBeenCalledTimes(1);
        expect(taskView.querySelector('.markdown-body')?.textContent).toContain('Partial answer');
        expect(taskView.querySelectorAll('.stream-cursor')).toHaveLength(1);
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

    test('shows estimated usage during streaming and corrects it when real usage arrives', () => {
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
                    last_part: { type: 'text', rendered: 'new output', text: 'new output' },
                    last_part_index: 0,
                    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
                },
                historyContainer
            )
        ).toBe(true);

        expect(taskView.querySelector('#message-content-assistant-2')?.textContent).toContain('new output');
        // 新消息流式期间立即出现按 chars/4 估算的胶囊（'new output' 11 chars → 3 词），
        // 同时按「仅保留最新一条胶囊」的既有规则移除旧消息上的 usage
        expect(taskView.querySelector('#message-container-assistant-1 .message-usage')).toBeNull();
        expect(taskView.querySelector('#message-container-assistant-2 .usage-text')?.textContent?.trim()).toBe(
            '已输出 3 词, 总计 3 词'
        );

        expect(
            taskView._renderAssistantProgress(
                {
                    task_status: 'stopped',
                    message_id: 'assistant-2',
                    last_part: { type: 'text', rendered: 'new output done', text: 'new output done' },
                    last_part_index: 0,
                    usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 }
                },
                historyContainer
            )
        ).toBe(true);

        // 真实 usage 到达后校正，旧消息上的胶囊随之移除
        expect(taskView.querySelectorAll('.message-usage')).toHaveLength(1);
        expect(taskView.querySelector('#message-container-assistant-1 .message-usage')).toBeNull();
        expect(taskView.querySelector('#message-container-assistant-2 .usage-text')?.textContent?.trim()).toBe(
            '已输出 5 词, 总计 16 词'
        );
    });

    test('renders estimated usage with output speed anchored to the current streaming part', async () => {
        const taskView = document.createElement('task-view') as HTMLElement & {
            task_id: string;
            _renderAssistantProgress: (progress: Record<string, unknown>, historyContainer: HTMLElement) => boolean;
            _speedPartState: { key: string; startMs: number; partChars: number; partStartUsage: number | null } | null;
            _speedMessageState: {
                messageId: string;
                messageChars: number;
                messageUsage: { p: number; c: number; t: number } | null;
            } | null;
        };
        taskView.task_id = 'task-1';
        taskView.innerHTML = '<div id="taskview-chat-history"></div>';
        const historyContainer = taskView.querySelector('#taskview-chat-history') as HTMLElement;

        // 无 usage 时：「已输出/总计」立即按消息 chars/4 估算显示；elapsed < 500ms 时不显示速度
        const baseTime = Date.now();
        const dateNow = jest.spyOn(Date, 'now');
        let now = baseTime;
        dateNow.mockImplementation(() => now);

        expect(
            taskView._renderAssistantProgress(
                {
                    task_status: 'running',
                    message_id: 'assistant-speed',
                    last_part: { type: 'text', text: 'a'.repeat(40) },
                    last_part_index: 0
                },
                historyContainer
            )
        ).toBe(true);
        expect(taskView.querySelector('#message-container-assistant-speed .usage-text')?.textContent?.trim()).toBe(
            '已输出 10 词, 总计 10 词'
        );

        now = baseTime + 1000;
        expect(
            taskView._renderAssistantProgress(
                {
                    task_status: 'running',
                    message_id: 'assistant-speed',
                    last_part: { type: 'text', text: 'a'.repeat(400) },
                    last_part_index: 0
                },
                historyContainer
            )
        ).toBe(true);
        // 400 chars / 4 = 100 tokens / 1s = 100 token/s，速度内联在「已输出」之后
        expect(taskView.querySelector('#message-container-assistant-speed .usage-text')?.textContent?.trim()).toBe(
            '已输出 100 词 (100 词/秒), 总计 100 词'
        );

        // 工具 part 插入：速度锚点清零，但胶囊上已显示的内容保持原状
        expect(
            taskView._renderAssistantProgress(
                {
                    task_status: 'running',
                    message_id: 'assistant-speed',
                    last_part: { type: 'tool_call', rendered: '<div>tool</div>' },
                    last_part_index: 1
                },
                historyContainer
            )
        ).toBe(true);
        expect(taskView._speedPartState).toBeNull();
        expect(taskView._speedMessageState?.messageChars).toBe(400);
        expect(taskView.querySelector('#message-container-assistant-speed .usage-text')?.textContent?.trim()).toBe(
            '已输出 100 词 (100 词/秒), 总计 100 词'
        );

        // 下一个生成 part：速度重新锚定（elapsed 不足时保持旧速度），估算累计跨 part / 工具间隙继续
        expect(
            taskView._renderAssistantProgress(
                {
                    task_status: 'running',
                    message_id: 'assistant-speed',
                    last_part: { type: 'text', text: 'b'.repeat(200) },
                    last_part_index: 2
                },
                historyContainer
            )
        ).toBe(true);
        expect(taskView._speedPartState?.key).toBe('assistant-speed:2:text');
        // messageChars = 400 + 200 = 600 → 估算 150；速度保持上一个值 100
        expect(taskView.querySelector('#message-container-assistant-speed .usage-text')?.textContent?.trim()).toBe(
            '已输出 150 词 (100 词/秒), 总计 150 词'
        );

        // usage 到达后校正为真实值；速度按 usage 相对 part 基线的增量计算：
        // baseline = 90 - round(200/4) = 40 → 增量 50 token / 1s = 50 token/s
        now = baseTime + 2000;
        expect(
            taskView._renderAssistantProgress(
                {
                    task_status: 'running',
                    message_id: 'assistant-speed',
                    last_part: { type: 'text', text: 'b'.repeat(200) },
                    last_part_index: 2,
                    usage: { prompt_tokens: 10, completion_tokens: 90, total_tokens: 100 }
                },
                historyContainer
            )
        ).toBe(true);
        const usageEl = taskView.querySelector('#message-container-assistant-speed .usage-text');
        expect(usageEl?.textContent?.trim()).toBe('已输出 90 词 (50 词/秒), 总计 100 词');
        expect(usageEl?.closest('.message-usage')?.getAttribute('data-speed-value')).toBe('50');

        dateNow.mockRestore();
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
            restoreRealTimerGlobals();
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
            restoreRealTimerGlobals();
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
            restoreRealTimerGlobals();
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

    test('coalesces rapid reasoning streaming updates to one per animation frame', () => {
        // updateReasoningPreview 会启动每秒一次的 setInterval 计时器，
        // 与文件中其他用例一致使用 fake timers，不依赖环境是否暴露真实计时器全局变量
        jest.useFakeTimers();
        const originalRaf = globalThis.requestAnimationFrame;
        const originalCaf = globalThis.cancelAnimationFrame;
        const rafCallbacks = new Map<number, FrameRequestCallback>();
        let nextRafId = 1;
        globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
            const id = nextRafId;
            nextRafId += 1;
            rafCallbacks.set(id, cb);
            return id;
        };
        globalThis.cancelAnimationFrame = (id: number) => {
            rafCallbacks.delete(id);
        };

        try {
            const TaskViewClass = customElements.get('task-view') as any;
            const taskView = document.createElement('task-view') as HTMLElement & {
                task_id: string;
                _renderAssistantProgress: (progress: Record<string, unknown>, historyContainer: HTMLElement) => boolean;
            };
            taskView.task_id = 'task-1';
            taskView.innerHTML = '<div id="taskview-chat-history"></div>';
            const historyContainer = taskView.querySelector('#taskview-chat-history') as HTMLElement;

            // Stream several reasoning tokens in quick succession (the "thinking" phase).
            for (let i = 1; i <= 5; i += 1) {
                taskView._renderAssistantProgress(
                    {
                        task_status: 'running',
                        message_id: 'assistant-1',
                        last_part_index: 0,
                        last_part: { type: 'reasoning', rendered: `reasoning token ${i} ` }
                    },
                    historyContainer
                );
            }

            const reasoningContent = taskView.querySelector('.reasoning-content');
            expect(reasoningContent).not.toBeNull();
            // No frame has fired yet, so the DOM must not have been written once per token.
            expect(reasoningContent?.textContent).toBe('');
            // All five tokens were coalesced into a single pending animation frame.
            expect(rafCallbacks.size).toBe(1);

            // Flush the frame: only the latest text is applied, once.
            Array.from(rafCallbacks.values()).forEach((cb) => cb(0));
            rafCallbacks.clear();
            expect(reasoningContent?.textContent).toBe('reasoning token 5 ');

            // Finalizing flushes a pending update synchronously (no frame required).
            taskView._renderAssistantProgress(
                {
                    task_status: 'running',
                    message_id: 'assistant-1',
                    last_part_index: 0,
                    last_part: { type: 'reasoning', rendered: 'reasoning token 6 ' }
                },
                historyContainer
            );
            expect(rafCallbacks.size).toBe(1);

            const block = taskView.querySelector('.reasoning-block-od') as HTMLElement;
            TaskViewClass.finalizeReasoningBlock(block);
            expect(rafCallbacks.size).toBe(0);
            expect(reasoningContent?.textContent).toBe('reasoning token 6 ');
        } finally {
            globalThis.requestAnimationFrame = originalRaf;
            globalThis.cancelAnimationFrame = originalCaf;
            restoreRealTimerGlobals();
        }
    });

    test('reasoning preview keeps advancing when animation frames are suspended (background throttling)', () => {
        // 复现：窗口最小化/后台时 requestAnimationFrame 暂停触发，但 setInterval 仍在走，
        // 导致标题栏字数在变、内容预览却冻结。内容更新必须有独立于 RAF 的兜底节流。
        jest.useFakeTimers();
        const originalRaf = globalThis.requestAnimationFrame;
        const originalCaf = globalThis.cancelAnimationFrame;
        // RAF 挂起：回调只排队、从不执行（模拟 Electron backgroundThrottling）。
        const rafCallbacks = new Map<number, FrameRequestCallback>();
        let nextRafId = 1;
        globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
            const id = nextRafId;
            nextRafId += 1;
            rafCallbacks.set(id, cb);
            return id;
        };
        globalThis.cancelAnimationFrame = (id: number) => {
            rafCallbacks.delete(id);
        };

        try {
            const TaskViewClass = customElements.get('task-view') as any;
            const taskView = document.createElement('task-view') as HTMLElement & {
                task_id: string;
                _renderAssistantProgress: (progress: Record<string, unknown>, historyContainer: HTMLElement) => boolean;
            };
            taskView.task_id = 'task-1';
            taskView.innerHTML = '<div id="taskview-chat-history"></div>';
            const historyContainer = taskView.querySelector('#taskview-chat-history') as HTMLElement;

            taskView._renderAssistantProgress(
                {
                    task_status: 'running',
                    message_id: 'assistant-1',
                    last_part_index: 0,
                    last_part: { type: 'reasoning', rendered: 'reasoning v1 ' }
                },
                historyContainer
            );

            const reasoningContent = taskView.querySelector('.reasoning-content') as HTMLElement;
            expect(reasoningContent).not.toBeNull();
            // RAF 全程挂起：未到兜底时间前不更新。
            expect(reasoningContent.textContent).toBe('');

            // 推进兜底定时器：即使 RAF 从不触发，内容也必须推进。
            jest.advanceTimersByTime(1000);
            expect(reasoningContent.textContent).toBe('reasoning v1 ');

            // 持续流式更新，RAF 仍挂起：内容应继续推进，而不是冻结在旧状态。
            taskView._renderAssistantProgress(
                {
                    task_status: 'running',
                    message_id: 'assistant-1',
                    last_part_index: 0,
                    last_part: { type: 'reasoning', rendered: 'reasoning v1 reasoning v2 ' }
                },
                historyContainer
            );
            jest.advanceTimersByTime(1000);
            expect(reasoningContent.textContent).toBe('reasoning v1 reasoning v2 ');

            // 挂起的 RAF 回调应当已被取消，不会在恢复后重复写 DOM。
            expect(rafCallbacks.size).toBe(0);
        } finally {
            globalThis.requestAnimationFrame = originalRaf;
            globalThis.cancelAnimationFrame = originalCaf;
            restoreRealTimerGlobals();
        }
    });

    test('finalizes active reasoning blocks when interrupting a running turn to send a queued message immediately', async () => {
        // 复现：思考过程中插队发新消息，后端 _turnRunning=true 时不发送 stopped 订阅反馈，
        // 旧回合收尾又因 _turnGeneration 被新回合取代而跳过 feedback，前端状态一直 running，
        // 旧 reasoning 块若不 finalize 会与新一轮思考块同时活跃、同时计时。
        jest.useFakeTimers();
        try {
            const TaskViewClass = customElements.get('task-view') as any;
            const interruptForNewMessage = jest.fn(async () => undefined);
            window.taskManagerAPI = {
                submitMessage,
                interruptForNewMessage
            };

            const taskView = document.createElement('task-view') as HTMLElement & {
                task_id: string;
                task_status: string;
                messageQueue: Array<{
                    id: string;
                    message: string;
                    attachedFilePaths: string[];
                    attachedImages: string[];
                    selectedExecutionNodeId?: string | null;
                }>;
                _handleRunningGoalInput: jest.Mock;
                _updateMessageQueuePanel: jest.Mock;
                sendQueueMessageImmediately: (id: string) => Promise<void>;
            };
            taskView.task_id = 'task-1';
            taskView.task_status = 'running';
            taskView.innerHTML = '<div id="taskview-chat-history"></div>';
            const historyContainer = taskView.querySelector('#taskview-chat-history') as HTMLElement;

            // 构造正在流式输出、正在计时的 reasoning 块
            historyContainer.insertAdjacentHTML(
                'beforeend',
                TaskViewClass.createReasoningPartHtml('thinking...', true)
            );
            const reasoningEl = historyContainer.querySelector('.reasoning-block-od') as HTMLElement & {
                _reasoningTimeInterval: ReturnType<typeof setInterval> | null;
            };
            TaskViewClass.updateReasoningPreview(reasoningEl, 'thinking...');
            expect(reasoningEl.classList.contains('reasoning-active')).toBe(true);
            expect(reasoningEl._reasoningTimeInterval).not.toBeNull();

            taskView.messageQueue = [
                {
                    id: 'queue-1',
                    message: 'send now',
                    attachedFilePaths: [],
                    attachedImages: []
                }
            ];
            taskView._handleRunningGoalInput = jest.fn(async () => 'not-goal');
            taskView._updateMessageQueuePanel = jest.fn();

            await taskView.sendQueueMessageImmediately('queue-1');

            // 中断后旧回合的思考块必须立即完成计时，而不是继续运行
            expect(interruptForNewMessage).toHaveBeenCalledWith('task-1');
            expect(submitMessage).toHaveBeenCalledWith('task-1', {
                message: 'send now',
                attachedFilePaths: [],
                attachedImages: [],
                selectedModel: undefined,
                reasoningEffort: undefined,
                selectedExecutionNodeId: null
            });
            expect(reasoningEl.classList.contains('reasoning-completed')).toBe(true);
            expect(reasoningEl._reasoningTimeInterval).toBeNull();
        } finally {
            restoreRealTimerGlobals();
        }
    });

    test('does not restart the timer when stale progress arrives after a reasoning block is finalized', () => {
        // 防御：插队后旧回合晚到的残余 progress 不得让已 finalize 的思考块重启计时器。
        jest.useFakeTimers();
        try {
            const TaskViewClass = customElements.get('task-view') as any;
            const el = document.createElement('div');
            el.innerHTML = TaskViewClass.createReasoningPartHtml('', true);
            const block = el.querySelector('.reasoning-block-od') as HTMLElement & {
                _reasoningTimeInterval: ReturnType<typeof setInterval> | null;
            };
            TaskViewClass.updateReasoningPreview(block, 'thinking...');
            expect(block._reasoningTimeInterval).not.toBeNull();

            TaskViewClass.finalizeReasoningBlock(block);
            expect(block._reasoningTimeInterval).toBeNull();
            const timeEl = block.querySelector('.reasoning-time') as HTMLElement;
            const frozenTime = timeEl.textContent;

            // 模拟旧回合晚到的残余 progress
            TaskViewClass.updateReasoningPreview(block, 'more thinking...');
            expect(block._reasoningTimeInterval).toBeNull();
            expect(timeEl.textContent).toBe(frozenTime);
        } finally {
            restoreRealTimerGlobals();
        }
    });

    test('finalizes active reasoning blocks when a new user message starts the next turn', () => {
        // 覆盖直接提交路径：任何新用户消息（新回合开始信号）都会兜底结束旧回合
        // 活跃 reasoning 块的计时，即使后端未发送 stopped 订阅反馈。
        jest.useFakeTimers();
        try {
            const TaskViewClass = customElements.get('task-view') as any;
            const taskView = document.createElement('task-view') as HTMLElement & {
                task_id: string;
                _renderUserProgress: (progress: Record<string, unknown>, historyContainer: HTMLElement) => boolean;
            };
            taskView.task_id = 'task-1';
            taskView.innerHTML = '<div id="taskview-chat-history"></div>';
            const historyContainer = taskView.querySelector('#taskview-chat-history') as HTMLElement;

            // 旧回合的活跃（计时中）reasoning 块
            historyContainer.insertAdjacentHTML(
                'beforeend',
                TaskViewClass.createReasoningPartHtml('thinking...', true)
            );
            const reasoningEl = historyContainer.querySelector('.reasoning-block-od') as HTMLElement & {
                _reasoningTimeInterval: ReturnType<typeof setInterval> | null;
            };
            TaskViewClass.updateReasoningPreview(reasoningEl, 'thinking...');
            expect(reasoningEl._reasoningTimeInterval).not.toBeNull();

            // 新回合开始：收到用户消息 progress
            taskView._renderUserProgress(
                {
                    type: 'user',
                    task_status: 'running',
                    message_id: 'user-2',
                    rawText: '继续',
                    isLastPart: true,
                    timestamp: Date.now(),
                    last_part: { type: 'text', rendered: '继续' },
                    parts: [{ type: 'text', rendered: '继续' }]
                },
                historyContainer
            );

            expect(reasoningEl.classList.contains('reasoning-completed')).toBe(true);
            expect(reasoningEl._reasoningTimeInterval).toBeNull();
        } finally {
            restoreRealTimerGlobals();
        }
    });

    test('the first visible browser app event may activate the browser layout', () => {
        const TaskViewClass = customElements.get('task-view') as any;
        TaskViewClass.rightSidebarExpanded = true;

        const sidebar = {
            _suppressBrowserAutoSwitch: true,
            consumeInitialBrowserAutoReveal: jest.fn(() => true),
            forceBrowserActive: jest.fn(),
            browserNavigate: jest.fn()
        };
        const taskView = document.createElement('task-view') as HTMLElement & {
            task_id: string;
            _browserPip: null;
            _ensureRightSidebarOpen: jest.Mock;
            _getRightSidebarEl: jest.Mock;
            _showBrowserPipIfNeeded: jest.Mock;
            _handleBrowserEvent: (method: string, taskId: string, ...args: unknown[]) => void;
        };

        taskView.task_id = 'task-1';
        taskView._browserPip = null;
        taskView._ensureRightSidebarOpen = jest.fn();
        taskView._getRightSidebarEl = jest.fn(() => sidebar);
        taskView._showBrowserPipIfNeeded = jest.fn();

        taskView._handleBrowserEvent('browserNavigate', 'task-1', 'https://example.com');

        expect(sidebar.consumeInitialBrowserAutoReveal).toHaveBeenCalledTimes(1);
        expect(taskView._ensureRightSidebarOpen).toHaveBeenCalledTimes(1);
        expect(sidebar._suppressBrowserAutoSwitch).toBe(false);
        expect(sidebar.forceBrowserActive).toHaveBeenCalledTimes(1);
        expect(sidebar.browserNavigate).toHaveBeenCalledWith('https://example.com');

        TaskViewClass.rightSidebarExpanded = false;
    });

    test('repeated browser app events preserve the current task layout', () => {
        const sidebar = {
            _suppressBrowserAutoSwitch: false,
            consumeInitialBrowserAutoReveal: jest.fn(() => false),
            ensureBrowserReady: jest.fn(),
            forceBrowserActive: jest.fn(),
            keepBrowserPanelRenderable: jest.fn(),
            browserNavigate: jest.fn()
        };
        const taskView = document.createElement('task-view') as HTMLElement & {
            task_id: string;
            _browserPip: null;
            _ensureRightSidebarOpen: jest.Mock;
            _getRightSidebarEl: jest.Mock;
            _showBrowserPipIfNeeded: jest.Mock;
            _handleBrowserEvent: (method: string, taskId: string, ...args: unknown[]) => void;
        };

        taskView.task_id = 'task-1';
        taskView._browserPip = null;
        taskView._ensureRightSidebarOpen = jest.fn();
        taskView._getRightSidebarEl = jest.fn(() => sidebar);
        taskView._showBrowserPipIfNeeded = jest.fn();

        taskView._handleBrowserEvent('browserNavigate', 'task-1', 'https://example.com');

        expect(taskView._ensureRightSidebarOpen).not.toHaveBeenCalled();
        expect(sidebar.forceBrowserActive).not.toHaveBeenCalled();
        expect(sidebar.ensureBrowserReady).toHaveBeenCalledWith(false);
        expect(sidebar.keepBrowserPanelRenderable).toHaveBeenCalledTimes(1);
        expect(sidebar._suppressBrowserAutoSwitch).toBe(true);
        expect(sidebar.browserNavigate).toHaveBeenCalledWith('https://example.com');
    });

    test('opens a workspace file through the existing right sidebar', async () => {
        const sidebar = {
            openFilePreview: jest.fn()
        };
        const taskView = document.createElement('task-view') as HTMLElement & {
            _forceExpandRightSidebar: jest.Mock;
            _getRightSidebarEl: jest.Mock;
            openFileInSidebar: (filePath: string, line?: number, onSwitchBlocked?: () => void) => Promise<void>;
        };
        taskView._forceExpandRightSidebar = jest.fn();
        taskView._getRightSidebarEl = jest.fn(() => sidebar);
        const onSwitchBlocked = jest.fn();

        // openFileInSidebar 现在会先经 fsAPI 校验存在性（测试环境无 fsAPI，跳过校验）
        await taskView.openFileInSidebar('/workspace/deck.pptx', undefined, onSwitchBlocked);
        expect(taskView._forceExpandRightSidebar).toHaveBeenCalledTimes(1);
        expect(sidebar.openFilePreview).toHaveBeenCalledWith('/workspace/deck.pptx', undefined, onSwitchBlocked);
    });

    test('opens a user-selected link through an explicit browser activation', () => {
        const sidebar = {
            forceBrowserActive: jest.fn(),
            browserAddTab: jest.fn()
        };
        const taskView = document.createElement('task-view') as HTMLElement & {
            _forceExpandRightSidebar: jest.Mock;
            _getRightSidebarEl: jest.Mock;
            openUrlInSidebar: (url: string) => void;
        };
        taskView._forceExpandRightSidebar = jest.fn();
        taskView._getRightSidebarEl = jest.fn(() => sidebar);

        taskView.openUrlInSidebar('https://example.com');

        expect(taskView._forceExpandRightSidebar).toHaveBeenCalledTimes(1);
        expect(sidebar.forceBrowserActive).toHaveBeenCalledTimes(1);
        expect(sidebar.browserAddTab).toHaveBeenCalledWith('https://example.com');
    });
});
