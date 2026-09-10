import { afterEach, beforeAll, describe, expect, jest, test } from '@jest/globals';
import {
    clearInterval as nativeClearInterval,
    clearTimeout as nativeClearTimeout,
    setInterval as nativeSetInterval,
    setTimeout as nativeSetTimeout
} from 'node:timers';
import { parseHTML } from 'linkedom';

const showInfoModal = jest.fn(async () => undefined);

jest.unstable_mockModule('../../../renderer/components/confirmModal.js', () => ({
    showConfirmModal: jest.fn(async () => true),
    showInfoModal,
    showCloseDialog: jest.fn(),
    bindOverlayDismiss: jest.fn(),
    detectDarkMode: jest.fn(() => false),
    MODAL_CSS: '',
    renderIcon: jest.fn(() => ''),
    shouldConfirmOnEnter: jest.fn(() => false),
    MODAL_ANIM_DURATION_IN: 250,
    MODAL_ANIM_DURATION_OUT: 180,
    // 与真实实现同构的轻量转换：转义 HTML 并保留换行
    escapeModalText: (text: string) =>
        text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
}));

let lastBrowserConstructorArgs: unknown[] = [];
let mockBrowserHasActiveContent = false;
const restoredBrowserState = {
    tabs: [
        { url: 'https://example.com/one', title: 'One' },
        { url: 'https://example.com/two', title: 'Two' }
    ],
    activeIndex: 1
};

describe('task artifacts goal disclosure state', () => {
    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            Element: window.Element,
            HTMLTextAreaElement: window.HTMLTextAreaElement,
            HTMLButtonElement: window.HTMLButtonElement,
            CustomEvent: window.CustomEvent,
            customElements: window.customElements,
            ResizeObserver: class {
                observe() {}
                disconnect() {}
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
        (window as any).setTimeout = nativeSetTimeout;
        (window as any).clearTimeout = nativeClearTimeout;
        (window as any).setInterval = nativeSetInterval;
        (window as any).clearInterval = nativeClearInterval;

        await jest.unstable_mockModule('../../../renderer/components/fileExplorer.ts', () => ({
            FileExplorer: class {
                onOpenInBrowser: ((filePath: string) => void) | null = null;
                onWorkspaceFocusLayoutChange: ((state: { active: boolean; fullscreen: boolean }) => void) | null = null;
                mount() {}
                refresh() {}
                softRefresh() {}
                selectFile(filePath: string) {
                    this.onWorkspaceFocusLayoutChange?.({ active: filePath.endsWith('.pptx'), fullscreen: true });
                }
                closeEditor() {
                    this.onWorkspaceFocusLayoutChange?.({ active: false, fullscreen: false });
                }
                openEditor() {}
                isEditorOpen() {
                    return false;
                }
            },
            getFileExplorerCSS: () => '',
            isHtmlFile: (filePath: string) => {
                const ext = filePath.split('.').pop()?.toLowerCase();
                return ext === 'html' || ext === 'htm';
            }
        }));
        await jest.unstable_mockModule('../../../renderer/browser.ts', () => ({
            EmbeddedBrowser: class {
                onTabsChanged: (() => void) | null = null;
                constructor(...args: unknown[]) {
                    lastBrowserConstructorArgs = args;
                }
                register() {}
                unregister() {}
                destroy() {}
                setPreviewMode() {}
                getSessionState() {
                    return restoredBrowserState;
                }
                hasActiveContent() {
                    return mockBrowserHasActiveContent;
                }
            }
        }));
        await jest.unstable_mockModule('../../../renderer/theme/theme-shadow-overrides.ts', () => ({
            syncShadowHostTheme: jest.fn()
        }));

        (window as any).settingAPI = {
            loadSettingObject: async () => ({}),
            onSettingChanged: () => undefined
        };
        (window as any).taskManagerAPI = {};

        await import('../../../renderer/components/taskartifacts.ts');
    });

    afterEach(() => {
        for (const artifacts of document.querySelectorAll<HTMLElement>('task-artifacts')) {
            artifacts.remove();
        }
        document.body.replaceChildren();
        mockBrowserHasActiveContent = false;
        jest.useRealTimers();
        (window as any).setTimeout = nativeSetTimeout;
        (window as any).clearTimeout = nativeClearTimeout;
        (window as any).setInterval = nativeSetInterval;
        (window as any).clearInterval = nativeClearInterval;
    });

    function createArtifacts(): HTMLElement & {
        setGoalState: (goal: any) => void;
        setGoalEvalProgress: (progress: any) => void;
        setTaskTodos: (todos: any[], options?: { source?: 'refresh' | 'live-update' }) => void;
        showGoalCreationForm: () => void;
    } {
        const artifacts = document.createElement('task-artifacts') as HTMLElement & {
            setGoalState: (goal: any) => void;
            setGoalEvalProgress: (progress: any) => void;
            setTaskTodos: (todos: any[], options?: { source?: 'refresh' | 'live-update' }) => void;
            showGoalCreationForm: () => void;
        };
        document.body.appendChild(artifacts);
        return artifacts;
    }

    function createRunningTaskArtifacts(): HTMLElement & {
        setGoalState: (goal: any) => void;
    } {
        const taskView = document.createElement('task-view') as HTMLElement & { task_status: string };
        taskView.task_status = 'running';
        const artifacts = document.createElement('task-artifacts') as HTMLElement & {
            setGoalState: (goal: any) => void;
        };
        artifacts.setAttribute('task-id', 'task-1');
        taskView.appendChild(artifacts);
        document.body.appendChild(taskView);
        return artifacts;
    }

    test('disconnecting the component clears duration and delayed layout timers', () => {
        jest.useFakeTimers();
        (window as any).setTimeout = globalThis.setTimeout;
        (window as any).clearTimeout = globalThis.clearTimeout;
        (window as any).setInterval = globalThis.setInterval;
        (window as any).clearInterval = globalThis.clearInterval;
        const baselineTimers = jest.getTimerCount();
        const artifacts = createArtifacts();

        artifacts.setTaskTodos([
            {
                id: 'todo-running',
                title: 'Running todo',
                status: 'in_progress',
                updated_at: '2026-07-08T10:01:00.000Z'
            }
        ]);

        expect(jest.getTimerCount()).toBeGreaterThan(baselineTimers);
        artifacts.remove();
        expect(jest.getTimerCount()).toBe(baselineTimers);
    });

    test('extends a focused file preview across the workspace tab header', () => {
        const artifacts = createArtifacts() as ReturnType<typeof createArtifacts> & {
            openFilePreview: (filePath: string) => void;
        };
        const focusStates: Array<{ active: boolean; fullscreen: boolean }> = [];
        artifacts.addEventListener('workspace-focus-layout-change', (event) => {
            focusStates.push((event as CustomEvent<{ active: boolean; fullscreen: boolean }>).detail);
        });

        artifacts.openFilePreview('/workspace/deck.pptx');

        expect(artifacts.hasAttribute('data-workspace-focus-fullscreen')).toBe(true);
        expect(artifacts.shadowRoot?.querySelector('style')?.textContent).toContain(
            ':host([data-workspace-focus-fullscreen]) .tab-header'
        );
        expect(focusStates).toEqual([{ active: true, fullscreen: true }]);
    });

    test('activates focus layout when browser becomes active and restores on destroy', () => {
        const artifacts = createArtifacts() as ReturnType<typeof createArtifacts> & {
            forceBrowserActive: () => void;
            destroyBrowser: () => void;
        };
        const focusStates: Array<{ active: boolean; fullscreen: boolean }> = [];
        artifacts.addEventListener('workspace-focus-layout-change', (event) => {
            focusStates.push((event as CustomEvent<{ active: boolean; fullscreen: boolean }>).detail);
        });

        artifacts.forceBrowserActive();

        expect(artifacts.hasAttribute('data-workspace-focus-fullscreen')).toBe(true);
        expect(focusStates).toContainEqual({ active: true, fullscreen: true });

        artifacts.destroyBrowser();

        expect(artifacts.hasAttribute('data-workspace-focus-fullscreen')).toBe(false);
        expect(focusStates).toContainEqual({ active: false, fullscreen: false });
    });

    test('does not let the initial about:blank navigation undo an explicit Browser reveal', () => {
        const artifacts = createArtifacts() as ReturnType<typeof createArtifacts> & {
            forceBrowserActive: () => void;
            _activeTab: string;
            _browserVisible: boolean;
            _browser: { onTabsChanged: (() => void) | null };
        };

        artifacts.forceBrowserActive();
        artifacts._browser.onTabsChanged?.();

        expect(artifacts._activeTab).toBe('browser');
        expect(artifacts._browserVisible).toBe(true);

        mockBrowserHasActiveContent = true;
        artifacts._browser.onTabsChanged?.();
        mockBrowserHasActiveContent = false;
        artifacts._browser.onTabsChanged?.();

        expect(artifacts._activeTab).toBe('workspace');
        expect(artifacts._browserVisible).toBe(false);
    });

    test('recycles the physical browser while preserving its logical tabs and selected Browser tab', () => {
        const artifacts = createArtifacts() as ReturnType<typeof createArtifacts> & {
            forceBrowserActive: () => void;
            recycleBrowser: () => void;
            restoreSelectedBrowser: () => void;
            _activeTab: string;
            _browser: unknown;
        };

        artifacts.forceBrowserActive();
        artifacts.recycleBrowser();

        expect(artifacts._browser).toBeNull();
        expect(artifacts._activeTab).toBe('browser');

        artifacts.restoreSelectedBrowser();

        expect(lastBrowserConstructorArgs[2]).toEqual(restoredBrowserState);
        expect(artifacts._activeTab).toBe('browser');
    });

    test('keeps the browser tab selected when only editor overlays and preview layout are suspended', () => {
        const artifacts = createArtifacts() as ReturnType<typeof createArtifacts> & {
            forceBrowserActive: () => void;
            closeEditor: () => void;
            suspendPreviewLayout: () => void;
            exitPreview: () => void;
            _activeTab: string;
        };
        const focusStates: Array<{ active: boolean; fullscreen: boolean }> = [];
        artifacts.addEventListener('workspace-focus-layout-change', (event) => {
            focusStates.push((event as CustomEvent<{ active: boolean; fullscreen: boolean }>).detail);
        });

        artifacts.forceBrowserActive();
        artifacts.closeEditor();

        expect(artifacts._activeTab).toBe('browser');

        artifacts.suspendPreviewLayout();

        expect(artifacts._activeTab).toBe('browser');
        expect(artifacts.hasAttribute('data-workspace-focus-fullscreen')).toBe(false);
        expect(focusStates.at(-1)).toEqual({ active: false, fullscreen: false });

        artifacts.exitPreview();

        expect(artifacts._activeTab).toBe('workspace');
    });

    test('keeps user-requested HTML previews as an explicit browser activation', () => {
        const artifacts = createArtifacts() as ReturnType<typeof createArtifacts> & {
            forceBrowserActive: jest.Mock;
            browserAddTab: jest.Mock;
            openFilePreview: (filePath: string) => void;
        };
        artifacts.forceBrowserActive = jest.fn();
        artifacts.browserAddTab = jest.fn();

        artifacts.openFilePreview('/workspace/index.html');

        expect(artifacts.forceBrowserActive).toHaveBeenCalledTimes(1);
        expect(artifacts.browserAddTab).toHaveBeenCalledWith('file:///workspace/index.html');
    });

    function terminalGoal(id: string) {
        return {
            id,
            status: 'complete',
            revision: 1,
            objective: `Goal ${id}`,
            pendingContinuation: false,
            updatedAt: '2026-07-08T10:00:00.000Z',
            evaluations: [
                {
                    evaluationId: `${id}-eval`,
                    goalRevision: 1,
                    phase: 'end',
                    status: 'met',
                    message: 'Done',
                    evaluatedAt: '2026-07-08T10:00:00.000Z'
                }
            ],
            objectiveEvents: [
                {
                    type: 'created',
                    revision: 1,
                    timestamp: '2026-07-08T09:59:00.000Z',
                    source: 'user',
                    objective: `Goal ${id}`
                }
            ]
        };
    }

    function getDetails(artifacts: HTMLElement) {
        const root = artifacts.shadowRoot!;
        return {
            evalStack: root.querySelector<HTMLDetailsElement>('details.goal-eval-stack')!,
            timeline: root.querySelector<HTMLDetailsElement>('details.goal-timeline')!
        };
    }

    test('live task todo changes collapse terminal goal evaluation and timeline once', () => {
        const artifacts = createArtifacts();
        artifacts.setGoalState(terminalGoal('goal-1'));
        artifacts.setTaskTodos([
            {
                id: 'todo-1',
                title: 'Initial todo',
                status: 'pending',
                updated_at: '2026-07-08T10:01:00.000Z'
            }
        ]);

        let details = getDetails(artifacts);
        expect(details.evalStack.hasAttribute('open')).toBe(true);
        expect(details.timeline.hasAttribute('open')).toBe(true);

        artifacts.setTaskTodos(
            [
                {
                    id: 'todo-1',
                    title: 'Initial todo',
                    status: 'completed',
                    updated_at: '2026-07-08T10:02:00.000Z',
                    completed_at: '2026-07-08T10:02:00.000Z'
                }
            ],
            { source: 'live-update' }
        );

        details = getDetails(artifacts);
        expect(details.evalStack.hasAttribute('open')).toBe(false);
        expect(details.timeline.hasAttribute('open')).toBe(false);

        details.evalStack.setAttribute('open', '');
        details.timeline.setAttribute('open', '');
        artifacts.setTaskTodos(
            [
                {
                    id: 'todo-1',
                    title: 'Initial todo',
                    status: 'completed',
                    updated_at: '2026-07-08T10:03:00.000Z',
                    completed_at: '2026-07-08T10:03:00.000Z'
                }
            ],
            { source: 'live-update' }
        );

        details = getDetails(artifacts);
        expect(details.evalStack.hasAttribute('open')).toBe(true);
        expect(details.timeline.hasAttribute('open')).toBe(true);
    });

    test('new goals do not inherit a previous goal auto-collapsed state', () => {
        const artifacts = createArtifacts();
        artifacts.setGoalState(terminalGoal('goal-1'));
        artifacts.setTaskTodos([
            {
                id: 'todo-1',
                title: 'Initial todo',
                status: 'pending',
                updated_at: '2026-07-08T10:01:00.000Z'
            }
        ]);
        artifacts.setTaskTodos(
            [
                {
                    id: 'todo-1',
                    title: 'Initial todo',
                    status: 'completed',
                    updated_at: '2026-07-08T10:02:00.000Z',
                    completed_at: '2026-07-08T10:02:00.000Z'
                }
            ],
            { source: 'live-update' }
        );

        artifacts.setGoalState(terminalGoal('goal-2'));

        const details = getDetails(artifacts);
        expect(details.evalStack.hasAttribute('open')).toBe(true);
        expect(details.timeline.hasAttribute('open')).toBe(true);
    });

    test('live todo updates preserve an in-progress goal creation draft and textarea DOM', () => {
        const artifacts = createArtifacts();
        artifacts.setTaskTodos([
            {
                id: 'todo-1',
                title: 'Initial todo',
                status: 'pending',
                updated_at: '2026-07-08T10:01:00.000Z'
            }
        ]);
        artifacts.showGoalCreationForm();

        const objectiveInput = artifacts.shadowRoot?.querySelector<HTMLTextAreaElement>(
            '[data-goal-creation-input="objective"]'
        );
        expect(objectiveInput).not.toBeNull();
        objectiveInput!.value = 'Keep this draft';
        objectiveInput!.dispatchEvent(new window.Event('input', { bubbles: true }));

        artifacts.setTaskTodos(
            [
                {
                    id: 'todo-1',
                    title: 'Updated todo',
                    status: 'in_progress',
                    updated_at: '2026-07-08T10:02:00.000Z'
                }
            ],
            { source: 'live-update' }
        );

        const preservedInput = artifacts.shadowRoot?.querySelector<HTMLTextAreaElement>(
            '[data-goal-creation-input="objective"]'
        );
        expect(preservedInput).toBe(objectiveInput);
        expect(preservedInput?.value).toBe('Keep this draft');
    });

    test('a newer goal revision supersedes stale live evaluation until the persisted result arrives', () => {
        const artifacts = createArtifacts();
        artifacts.setGoalState({
            id: 'goal-1',
            status: 'active',
            revision: 1,
            objective: 'Old objective',
            pendingContinuation: false,
            updatedAt: '2026-07-08T10:00:00.000Z'
        });
        artifacts.setGoalEvalProgress({
            evaluationId: 'eval-1',
            goalId: 'goal-1',
            goalRevision: 1,
            phase: 'start',
            message: 'Evaluating',
            startedAt: '2026-07-08T10:01:00.000Z'
        });

        artifacts.setGoalState({
            id: 'goal-1',
            status: 'active',
            revision: 2,
            objective: 'New objective',
            pendingContinuation: false,
            updatedAt: '2026-07-08T10:02:00.000Z'
        });

        expect(artifacts.shadowRoot?.querySelector('.goal-evaluation-superseded')).not.toBeNull();

        artifacts.setGoalState({
            id: 'goal-1',
            status: 'active',
            revision: 2,
            objective: 'New objective',
            pendingContinuation: false,
            updatedAt: '2026-07-08T10:03:00.000Z',
            evaluations: [
                {
                    evaluationId: 'eval-1',
                    goalId: 'goal-1',
                    goalRevision: 2,
                    phase: 'end',
                    status: 'not_met',
                    message: 'Persisted result',
                    evaluatedAt: '2026-07-08T10:03:00.000Z'
                }
            ]
        });

        expect(artifacts.shadowRoot?.querySelector('.goal-evaluation-superseded')).toBeNull();
        expect(artifacts.shadowRoot?.innerHTML).toContain('Persisted result');
    });

    test('editing an active running goal dispatches pending event before display message exists', async () => {
        const editGoal = jest.fn(async () => ({
            ok: true,
            startedScheduler: false,
            summary: {
                id: 'goal-1',
                status: 'active',
                revision: 2,
                objective: 'New objective',
                pendingContinuation: false,
                updatedAt: '2026-07-08T10:05:00.000Z',
                objectiveEvents: [
                    {
                        type: 'edited',
                        revision: 2,
                        timestamp: '2026-07-08T10:05:00.000Z',
                        source: 'user',
                        objective: 'New objective',
                        previousObjective: 'Old objective'
                    }
                ]
            }
        }));
        (window as any).taskManagerAPI = { editGoal };
        const pendingEvents: CustomEvent[] = [];
        const onPending = (event: Event) => pendingEvents.push(event as CustomEvent);
        document.addEventListener('goal-pending', onPending);

        try {
            const artifacts = createRunningTaskArtifacts();
            artifacts.setGoalState({
                id: 'goal-1',
                status: 'active',
                revision: 1,
                objective: 'Old objective',
                pendingContinuation: false,
                updatedAt: '2026-07-08T10:00:00.000Z'
            });

            artifacts.shadowRoot
                ?.querySelector<HTMLElement>('[data-goal-action="edit-start"]')
                ?.dispatchEvent(new window.Event('click', { bubbles: true }));
            const input = artifacts.shadowRoot?.querySelector<HTMLTextAreaElement>('[data-goal-edit-input="1"]');
            if (input) {
                input.value = 'New objective';
                input.dispatchEvent(new window.Event('input', { bubbles: true }));
            }
            artifacts.shadowRoot
                ?.querySelector<HTMLElement>('[data-goal-action="edit-save"]')
                ?.dispatchEvent(new window.Event('click', { bubbles: true }));

            await Promise.resolve();
            await Promise.resolve();

            expect(editGoal).toHaveBeenCalledWith('task-1', 'New objective');
            expect(pendingEvents).toHaveLength(1);
            expect(pendingEvents[0].detail).toEqual(
                expect.objectContaining({
                    taskId: 'task-1',
                    type: 'edit',
                    objective: 'New objective',
                    goalId: 'goal-1',
                    goalRevision: 2,
                    source: 'goal_editor'
                })
            );
        } finally {
            document.removeEventListener('goal-pending', onPending);
        }
    });

    test('editing uses explicit task running state when dispatching pending event', async () => {
        const editGoal = jest.fn(async () => ({
            ok: true,
            startedScheduler: false,
            summary: {
                id: 'goal-1',
                status: 'active',
                revision: 2,
                objective: 'New objective',
                pendingContinuation: false,
                updatedAt: '2026-07-08T10:05:00.000Z'
            }
        }));
        (window as any).taskManagerAPI = { editGoal };
        const pendingEvents: CustomEvent[] = [];
        const onPending = (event: Event) => pendingEvents.push(event as CustomEvent);
        document.addEventListener('goal-pending', onPending);

        try {
            const artifacts = createArtifacts() as HTMLElement & {
                setGoalState: (goal: any) => void;
                setTaskRunning: (running: boolean) => void;
            };
            artifacts.setAttribute('task-id', 'task-1');
            artifacts.setTaskRunning(true);
            artifacts.setGoalState({
                id: 'goal-1',
                status: 'active',
                revision: 1,
                objective: 'Old objective',
                pendingContinuation: false,
                updatedAt: '2026-07-08T10:00:00.000Z'
            });

            artifacts.shadowRoot
                ?.querySelector<HTMLElement>('[data-goal-action="edit-start"]')
                ?.dispatchEvent(new window.Event('click', { bubbles: true }));
            const input = artifacts.shadowRoot?.querySelector<HTMLTextAreaElement>('[data-goal-edit-input="1"]');
            if (input) {
                input.value = 'New objective';
                input.dispatchEvent(new window.Event('input', { bubbles: true }));
            }
            artifacts.shadowRoot
                ?.querySelector<HTMLElement>('[data-goal-action="edit-save"]')
                ?.dispatchEvent(new window.Event('click', { bubbles: true }));

            await Promise.resolve();
            await Promise.resolve();

            expect(editGoal).toHaveBeenCalledWith('task-1', 'New objective');
            expect(pendingEvents).toHaveLength(1);
            expect(pendingEvents[0].detail).toEqual(
                expect.objectContaining({
                    taskId: 'task-1',
                    type: 'edit',
                    objective: 'New objective',
                    goalId: 'goal-1',
                    goalRevision: 2,
                    source: 'goal_editor'
                })
            );
        } finally {
            document.removeEventListener('goal-pending', onPending);
        }
    });

    test('pending goal edit disables the objective edit entrypoint', async () => {
        const artifacts = createRunningTaskArtifacts() as HTMLElement & {
            setGoalState: (goal: any) => void;
            setGoalEditPending: (pending: boolean) => void;
        };
        artifacts.setGoalState({
            id: 'goal-1',
            status: 'active',
            revision: 1,
            objective: 'Old objective',
            pendingContinuation: false,
            updatedAt: '2026-07-08T10:00:00.000Z'
        });

        artifacts.setGoalEditPending(true);
        artifacts.shadowRoot
            ?.querySelector<HTMLElement>('[data-goal-action="edit-start"]')
            ?.dispatchEvent(new window.Event('click', { bubbles: true }));
        await new Promise((resolve) => nativeSetTimeout(resolve, 0));

        expect(artifacts.shadowRoot?.querySelector('[data-goal-edit-input="1"]')).toBeNull();
        // goal 提示统一走页内模态弹窗（issue #265：原生 window.alert 关闭后使窗口失焦）
        expect(showInfoModal).toHaveBeenCalledWith(
            expect.objectContaining({
                message: 'Goal 编辑正在处理中，请等待当前变更进入上下文后再编辑。'
            })
        );

        showInfoModal.mockClear();
        artifacts.setGoalEditPending(false);
        artifacts.shadowRoot
            ?.querySelector<HTMLElement>('[data-goal-action="edit-start"]')
            ?.dispatchEvent(new window.Event('click', { bubbles: true }));
        await new Promise((resolve) => nativeSetTimeout(resolve, 0));

        expect(artifacts.shadowRoot?.querySelector('[data-goal-edit-input="1"]')).not.toBeNull();
        expect(showInfoModal).not.toHaveBeenCalled();
    });

    test('terminal goal edit entrypoint shows an unavailable status message', async () => {
        const artifacts = createRunningTaskArtifacts() as HTMLElement & {
            setGoalState: (goal: any) => void;
        };
        artifacts.setGoalState({
            id: 'goal-1',
            status: 'complete',
            revision: 2,
            objective: 'Finished objective',
            pendingContinuation: false,
            updatedAt: '2026-07-08T10:00:00.000Z'
        });

        artifacts.shadowRoot
            ?.querySelector<HTMLElement>('[data-goal-action="edit-start"]')
            ?.dispatchEvent(new window.Event('click', { bubbles: true }));
        await new Promise((resolve) => nativeSetTimeout(resolve, 0));

        expect(artifacts.shadowRoot?.querySelector('[data-goal-edit-input="1"]')).toBeNull();
        expect(showInfoModal).toHaveBeenCalledWith(
            expect.objectContaining({
                message: '当前 Goal 状态不支持编辑。'
            })
        );
    });
});
