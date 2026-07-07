import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

describe('task artifacts goal disclosure state', () => {
    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
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

        await jest.unstable_mockModule('../../../renderer/components/fileExplorer.ts', () => ({
            FileExplorer: class {
                onOpenInBrowser: ((filePath: string) => void) | null = null;
                mount() {}
                refresh() {}
                softRefresh() {}
                selectFile() {}
                closeEditor() {}
                openEditor() {}
                isEditorOpen() {
                    return false;
                }
            },
            getFileExplorerCSS: () => ''
        }));
        await jest.unstable_mockModule('../../../renderer/browser.ts', () => ({
            EmbeddedBrowser: class {
                constructor() {}
                register() {}
                unregister() {}
                destroy() {}
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

    function createArtifacts(): HTMLElement & {
        setGoalState: (goal: any) => void;
        setTaskTodos: (todos: any[], options?: { source?: 'refresh' | 'live-update' }) => void;
    } {
        const artifacts = document.createElement('task-artifacts') as HTMLElement & {
            setGoalState: (goal: any) => void;
            setTaskTodos: (todos: any[], options?: { source?: 'refresh' | 'live-update' }) => void;
        };
        document.body.appendChild(artifacts);
        artifacts.connectedCallback?.();
        return artifacts;
    }

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
});
