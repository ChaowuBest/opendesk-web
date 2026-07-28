import { describe, expect, jest, test } from '@jest/globals';
import { MAIN_AGENT_STANDARD_MODE } from '../../../main/aikernel/agents/main/modes/standard.js';
import { MAIN_AGENT_UNLIMITED_MODE } from '../../../main/aikernel/agents/main/modes/unlimited.js';
import { GlobPermissionEnforcer } from '../../../main/aikernel/security/enforcer.js';
import { HarnessContext } from '../../../main/aikernel/security/harness.js';
import type {
    PermissionCheckResult,
    PermissionEnforcer,
    PermissionPromptProvider,
    PermissionRequest
} from '../../../main/aikernel/security/permission.js';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';
import { handleToolPermissionsForTask } from '../../../main/aikernel/task/permission.js';
import { TUIPermissionPromptProvider } from '../../../main/tui/components/permission.js';
import { OpenDeskTUI } from '../../../main/tui/entry.js';

const outsideWorkspaceRequest: PermissionRequest = {
    resourceType: 'file',
    action: 'read',
    resourcePath: '/outside-workspace/secret.txt'
};

function createPromptProvider() {
    const prompt = jest.fn(async () => ({ decision: 'allow', rememberScope: 'none' }) as const);
    return {
        provider: { prompt } satisfies PermissionPromptProvider,
        prompt
    };
}

function createTool(request: PermissionRequest) {
    return {
        name: 'testPermissionTool',
        getDeclaredPermissions: jest.fn(() => [request])
    } as any;
}

function createToolCall() {
    return {
        id: 'tool-call-1',
        status: 'pending',
        args_object: {}
    } as any;
}

describe('CLI unlimited permission regressions', () => {
    test('unlimited remains prompt-free when explicit ask rules are added later', async () => {
        const manager = new TaskManagerState();
        const task = new TaskState(manager);
        const { provider, prompt } = createPromptProvider();
        task.harnessContext = await HarnessContext.createForMode('/workspace', MAIN_AGENT_UNLIMITED_MODE);
        task.harnessContext.permissionPrompt = provider;

        await task.harnessContext.permission!.addRule({
            resourceType: 'file',
            action: 'read',
            pathPattern: '/outside-workspace/**',
            effect: 'ask'
        });

        const blocked = await handleToolPermissionsForTask(
            task,
            createTool(outsideWorkspaceRequest),
            {},
            createToolCall()
        );

        expect(blocked).toBe(false);
        expect(prompt).not.toHaveBeenCalled();
    });

    test('lazy initialization keeps resumed unlimited tasks prompt-free', async () => {
        const manager = new TaskManagerState();
        const task = new TaskState(manager);
        task.task_id = 'resumed-task';
        task.workspace = '/workspace';
        manager.tasks.push(task);
        const { provider, prompt } = createPromptProvider();

        await manager.setupLazyHarnessInit(MAIN_AGENT_UNLIMITED_MODE, '/workspace', () => provider);
        manager.getTask(task.task_id);
        await task.harnessContext.permission!.addRule({
            resourceType: 'file',
            action: 'read',
            pathPattern: '/outside-workspace/**',
            effect: 'ask'
        });

        const blocked = await handleToolPermissionsForTask(
            task,
            createTool(outsideWorkspaceRequest),
            {},
            createToolCall()
        );

        expect(blocked).toBe(false);
        expect(task.activeModeId).toBe(MAIN_AGENT_UNLIMITED_MODE.id);
        expect(prompt).not.toHaveBeenCalled();
        manager.disposeLazyHarnessInit();
    });

    test('lazy tasks initialize with the latest TUI mode after switching in both directions', async () => {
        const manager = new TaskManagerState();
        const firstTask = new TaskState(manager);
        firstTask.task_id = 'first-lazy-task';
        firstTask.workspace = '/workspace';
        const secondTask = new TaskState(manager);
        secondTask.task_id = 'second-lazy-task';
        secondTask.workspace = '/workspace';
        manager.tasks.push(firstTask, secondTask);
        const { provider } = createPromptProvider();

        await manager.setupLazyHarnessInit(MAIN_AGENT_UNLIMITED_MODE, '/workspace', () => provider);
        const tui = Object.assign(Object.create(OpenDeskTUI.prototype), {
            _activeMode: MAIN_AGENT_UNLIMITED_MODE,
            workspace: '/workspace',
            agentDecl: {
                supportedModes: () => [MAIN_AGENT_STANDARD_MODE, MAIN_AGENT_UNLIMITED_MODE],
                createSystemPrompt: jest.fn(async (activeMode) => `system:${activeMode.id}`)
            },
            taskManagerState: manager,
            syncModeDisplay: jest.fn(),
            tui: {
                requestRender: jest.fn()
            }
        }) as OpenDeskTUI;

        await tui.setMode(MAIN_AGENT_STANDARD_MODE.id);
        manager.getTask(firstTask.task_id);
        expect(firstTask.activeModeId).toBe(MAIN_AGENT_STANDARD_MODE.id);
        await expect(firstTask.harnessContext.permission!.check(outsideWorkspaceRequest)).resolves.toMatchObject({
            effect: 'ask'
        });

        await tui.setMode(MAIN_AGENT_UNLIMITED_MODE.id);
        manager.getTask(secondTask.task_id);
        expect(secondTask.activeModeId).toBe(MAIN_AGENT_UNLIMITED_MODE.id);
        await expect(secondTask.harnessContext.permission!.check(outsideWorkspaceRequest)).resolves.toMatchObject({
            effect: 'allow'
        });

        manager.disposeLazyHarnessInit();
    });

    test('switching to unlimited updates default child tasks that inherited the parent enforcer', async () => {
        const manager = new TaskManagerState();
        const parent = new TaskState(manager);
        parent.task_id = 'parent-task';
        const child = new TaskState(manager, parent.task_id);
        child.task_id = 'child-task';
        const secondParent = new TaskState(manager);
        secondParent.task_id = 'second-parent-task';
        const secondChild = new TaskState(manager, secondParent.task_id);
        secondChild.task_id = 'second-child-task';
        manager.tasks.push(parent, child, secondParent, secondChild);

        const standardContext = await HarnessContext.createForMode('/workspace', MAIN_AGENT_STANDARD_MODE);
        const { provider, prompt } = createPromptProvider();
        standardContext.permissionPrompt = provider;
        parent.harnessContext = standardContext;
        parent.activeModeId = MAIN_AGENT_STANDARD_MODE.id;
        secondParent.harnessContext.permission = standardContext.permission;
        secondParent.harnessContext.permissionPrompt = provider;
        secondParent.harnessContext.workspace = standardContext.workspace;
        child.harnessContext.permission = standardContext.permission;
        child.harnessContext.permissionPrompt = provider;
        child.harnessContext.workspace = standardContext.workspace;
        secondChild.harnessContext.permission = standardContext.permission;
        secondChild.harnessContext.permissionPrompt = provider;
        secondChild.harnessContext.workspace = standardContext.workspace;

        const tui = Object.assign(Object.create(OpenDeskTUI.prototype), {
            _activeMode: MAIN_AGENT_STANDARD_MODE,
            workspace: '/workspace',
            agentDecl: {
                supportedModes: () => [MAIN_AGENT_STANDARD_MODE, MAIN_AGENT_UNLIMITED_MODE],
                createSystemPrompt: jest.fn(async (activeMode) => `system:${activeMode.id}`)
            },
            taskManagerState: manager,
            syncModeDisplay: jest.fn(),
            tui: {
                requestRender: jest.fn()
            }
        }) as OpenDeskTUI;

        await tui.setMode(MAIN_AGENT_UNLIMITED_MODE.id);
        const blocked = await handleToolPermissionsForTask(
            child,
            createTool(outsideWorkspaceRequest),
            {},
            createToolCall()
        );

        expect(blocked).toBe(false);
        expect(child.harnessContext.permission).toBe(parent.harnessContext.permission);
        expect(secondChild.harnessContext.permission).toBe(secondParent.harnessContext.permission);
        expect(child.harnessContext.permission).not.toBe(secondChild.harnessContext.permission);
        expect(prompt).not.toHaveBeenCalled();
    });

    test('TUI mode switching preserves each task workspace and remote execution host', async () => {
        const manager = new TaskManagerState();
        const task = new TaskState(manager);
        task.task_id = 'remote-task';
        task.workspace = '/task-workspace';
        task.harnessContext = await HarnessContext.createForMode('/task-workspace', MAIN_AGENT_STANDARD_MODE);
        const remoteHost = {
            type: 'node',
            nodeId: 'node-1',
            nodeLabel: 'Remote node',
            capabilities: {
                nodeId: 'node-1',
                workspace: '/remote-workspace',
                commands: [],
                shells: []
            }
        } as const;
        task.harnessContext.executionHost = remoteHost;
        manager.tasks.push(task);
        const tui = Object.assign(Object.create(OpenDeskTUI.prototype), {
            _activeMode: MAIN_AGENT_STANDARD_MODE,
            workspace: '/global-workspace',
            agentDecl: {
                supportedModes: () => [MAIN_AGENT_STANDARD_MODE, MAIN_AGENT_UNLIMITED_MODE],
                createSystemPrompt: jest.fn(async (activeMode) => `system:${activeMode.id}`)
            },
            taskManagerState: manager,
            syncModeDisplay: jest.fn(),
            tui: {
                requestRender: jest.fn()
            }
        }) as OpenDeskTUI;

        await tui.setMode(MAIN_AGENT_UNLIMITED_MODE.id);

        expect(task.harnessContext.workspace).toBe('/task-workspace');
        expect(task.harnessContext.executionHost).toBe(remoteHost);
    });

    test('TUI mode switching refreshes the system prompt for loaded main tasks', async () => {
        const manager = new TaskManagerState();
        const task = new TaskState(manager);
        task.task_id = 'prompt-task';
        task.harnessContext = await HarnessContext.createForMode('/workspace', MAIN_AGENT_STANDARD_MODE);
        task.setSystemPrompt('system:standard');
        manager.tasks.push(task);
        const createSystemPrompt = jest.fn(async (activeMode) => `system:${activeMode.id}`);
        const tui = Object.assign(Object.create(OpenDeskTUI.prototype), {
            _activeMode: MAIN_AGENT_STANDARD_MODE,
            workspace: '/workspace',
            agentDecl: {
                supportedModes: () => [MAIN_AGENT_STANDARD_MODE, MAIN_AGENT_UNLIMITED_MODE],
                createSystemPrompt
            },
            taskManagerState: manager,
            syncModeDisplay: jest.fn(),
            tui: {
                requestRender: jest.fn()
            }
        }) as OpenDeskTUI;

        await tui.setMode(MAIN_AGENT_UNLIMITED_MODE.id);

        expect(createSystemPrompt).toHaveBeenCalledWith(MAIN_AGENT_UNLIMITED_MODE, task);
        expect(task.chat_context.system_prompt?.content).toBe('system:unlimited');
    });

    test('TUI mode switching keeps the previous mode when system prompt preparation fails', async () => {
        const manager = new TaskManagerState();
        const task = new TaskState(manager);
        task.task_id = 'atomic-prompt-task';
        task.harnessContext = await HarnessContext.createForMode('/workspace', MAIN_AGENT_STANDARD_MODE);
        task.activeModeId = MAIN_AGENT_STANDARD_MODE.id;
        task.setSystemPrompt('system:standard');
        manager.tasks.push(task);
        const previousContext = task.harnessContext;
        const tui = Object.assign(Object.create(OpenDeskTUI.prototype), {
            _activeMode: MAIN_AGENT_STANDARD_MODE,
            workspace: '/workspace',
            agentDecl: {
                supportedModes: () => [MAIN_AGENT_STANDARD_MODE, MAIN_AGENT_UNLIMITED_MODE],
                createSystemPrompt: jest.fn(async () => {
                    throw new Error('prompt generation failed');
                })
            },
            taskManagerState: manager,
            syncModeDisplay: jest.fn(),
            tui: {
                requestRender: jest.fn()
            }
        }) as OpenDeskTUI;

        await expect(tui.setMode(MAIN_AGENT_UNLIMITED_MODE.id)).resolves.toBe(false);
        expect(tui.activeMode).toBe(MAIN_AGENT_STANDARD_MODE);
        expect(task.harnessContext).toBe(previousContext);
        expect(task.activeModeId).toBe(MAIN_AGENT_STANDARD_MODE.id);
        expect(task.chat_context.system_prompt?.content).toBe('system:standard');
    });

    test('queued TUI prompts are auto-resolved after unlimited rules take effect', async () => {
        const showPromptWidget = jest.fn();
        const fakeTui = {
            activeTaskId: 'task-1',
            isInputBlocked: jest.fn(() => true),
            inputArea: {
                showPromptWidget,
                hidePromptWidget: jest.fn()
            },
            focusInputAreaIfAvailable: jest.fn(),
            tui: {
                requestRender: jest.fn(),
                setFocus: jest.fn()
            }
        } as any;
        const provider = new TUIPermissionPromptProvider(fakeTui);
        const response = provider.prompt([outsideWorkspaceRequest], 'testPermissionTool', []);
        const unlimitedEnforcer = await GlobPermissionEnforcer.create([
            { resourceType: '*', action: '*', pathPattern: '**', effect: 'allow' }
        ]);

        expect(provider.notifyPermissionRulesChanged).toBeDefined();
        await provider.notifyPermissionRulesChanged!(unlimitedEnforcer);

        await expect(response).resolves.toEqual({ decision: 'allow', rememberScope: 'none' });
        expect(showPromptWidget).not.toHaveBeenCalled();
    });

    test('an already visible TUI permission prompt is dismissed when unlimited takes effect', async () => {
        const hidePromptWidget = jest.fn();
        const closeInputPrompt = jest.fn(() => {
            hidePromptWidget();
            return null;
        });
        const fakeTui = {
            activeTaskId: 'task-1',
            isInputBlocked: jest.fn(() => false),
            inputArea: {
                showPromptWidget: jest.fn(),
                hidePromptWidget
            },
            closeInputPrompt,
            focusAfterInputPromptClose: jest.fn(),
            focusInputAreaIfAvailable: jest.fn(),
            tui: {
                requestRender: jest.fn(),
                setFocus: jest.fn()
            }
        } as any;
        const provider = new TUIPermissionPromptProvider(fakeTui);
        const response = provider.prompt([outsideWorkspaceRequest], 'testPermissionTool', []);
        const unlimitedContext = await HarnessContext.createForMode('/workspace', MAIN_AGENT_UNLIMITED_MODE);

        await provider.notifyPermissionRulesChanged!(unlimitedContext.permission!);

        await expect(response).resolves.toEqual({ decision: 'allow', rememberScope: 'none' });
        expect(closeInputPrompt).toHaveBeenCalledTimes(1);
    });

    test('task-scoped rule updates do not auto-approve another task queue', async () => {
        const fakeTui = {
            activeTaskId: 'task-1',
            isInputBlocked: jest.fn(() => true),
            inputArea: {
                showPromptWidget: jest.fn(),
                hidePromptWidget: jest.fn()
            },
            focusInputAreaIfAvailable: jest.fn(),
            tui: {
                requestRender: jest.fn(),
                setFocus: jest.fn()
            }
        } as any;
        const provider = new TUIPermissionPromptProvider(fakeTui);
        const first = provider.prompt([outsideWorkspaceRequest], 'firstTool', [], {
            taskId: 'task-1',
            taskName: 'first'
        });
        const second = provider.prompt([outsideWorkspaceRequest], 'secondTool', [], {
            taskId: 'task-2',
            taskName: 'second'
        });
        let secondSettled = false;
        void second.then(() => {
            secondSettled = true;
        });
        const unlimitedContext = await HarnessContext.createForMode('/workspace', MAIN_AGENT_UNLIMITED_MODE);

        await provider.notifyPermissionRulesChanged!(unlimitedContext.permission!, ['task-1']);

        await expect(first).resolves.toEqual({ decision: 'allow', rememberScope: 'none' });
        await Promise.resolve();
        expect(secondSettled).toBe(false);

        provider.cancelTaskPrompts(['task-2']);
        await expect(second).resolves.toEqual({
            decision: 'deny',
            rememberScope: 'none',
            denyReason: 'task_stopped'
        });
    });

    test('an async current re-check cannot approve the next task prompt', async () => {
        const shownWidgets: any[] = [];
        const closeInputPrompt = jest.fn(() => null);
        const fakeTui = {
            activeTaskId: 'task-1',
            isInputBlocked: jest.fn(() => false),
            inputArea: {
                showPromptWidget: jest.fn((widget: any) => shownWidgets.push(widget)),
                hidePromptWidget: jest.fn()
            },
            closeInputPrompt,
            focusAfterInputPromptClose: jest.fn(),
            focusInputAreaIfAvailable: jest.fn(),
            tui: {
                requestRender: jest.fn(),
                setFocus: jest.fn()
            }
        } as any;
        const provider = new TUIPermissionPromptProvider(fakeTui);
        const first = provider.prompt([outsideWorkspaceRequest], 'firstTool', [], {
            taskId: 'task-1',
            taskName: 'first'
        });
        const second = provider.prompt([outsideWorkspaceRequest], 'secondTool', [], {
            taskId: 'task-2',
            taskName: 'second'
        });
        let resolveCheck!: (results: PermissionCheckResult[]) => void;
        const delayedEnforcer: PermissionEnforcer = {
            check: async (request) => ({ effect: 'allow', request }),
            checkAll: async () => null,
            checkAllDetailed: () =>
                new Promise<PermissionCheckResult[]>((resolve) => {
                    resolveCheck = resolve;
                }),
            addRule: async () => {},
            removeRule: async () => {}
        };

        const notifying = provider.notifyPermissionRulesChanged!(delayedEnforcer, ['task-1']);
        shownWidgets[0].onDone({ decision: 'allow', rememberScope: 'none' });
        resolveCheck([]);
        await notifying;
        provider.cancelTaskPrompts(['task-2']);

        await expect(first).resolves.toEqual({ decision: 'allow', rememberScope: 'none' });
        await expect(second).resolves.toEqual({
            decision: 'deny',
            rememberScope: 'none',
            denyReason: 'task_stopped'
        });
    });

    test('an async queued re-check dismisses the same prompt if it becomes visible', async () => {
        let inputBlocked = true;
        const shownWidgets: any[] = [];
        const hidePromptWidget = jest.fn();
        const closeInputPrompt = jest.fn(() => {
            hidePromptWidget();
            return null;
        });
        const fakeTui = {
            activeTaskId: 'task-1',
            isInputBlocked: jest.fn(() => inputBlocked),
            inputArea: {
                showPromptWidget: jest.fn((widget: any) => shownWidgets.push(widget)),
                hidePromptWidget
            },
            closeInputPrompt,
            focusAfterInputPromptClose: jest.fn(),
            focusInputAreaIfAvailable: jest.fn(),
            tui: {
                requestRender: jest.fn(),
                setFocus: jest.fn()
            }
        } as any;
        const provider = new TUIPermissionPromptProvider(fakeTui);
        const prompt = provider.prompt([outsideWorkspaceRequest], 'queuedTool', [], {
            taskId: 'task-1',
            taskName: 'queued'
        });
        let resolveCheck!: (results: PermissionCheckResult[]) => void;
        const delayedEnforcer: PermissionEnforcer = {
            check: async (request) => ({ effect: 'allow', request }),
            checkAll: async () => null,
            checkAllDetailed: () =>
                new Promise<PermissionCheckResult[]>((resolve) => {
                    resolveCheck = resolve;
                }),
            addRule: async () => {},
            removeRule: async () => {}
        };

        const notifying = provider.notifyPermissionRulesChanged!(delayedEnforcer, ['task-1']);
        inputBlocked = false;
        provider.processQueueIfReady();
        expect(shownWidgets).toHaveLength(1);
        resolveCheck([]);
        await notifying;

        await expect(prompt).resolves.toEqual({ decision: 'allow', rememberScope: 'none' });
        expect(hidePromptWidget).toHaveBeenCalledTimes(1);
        provider.cancelTaskPrompts(['task-1']);
        expect(hidePromptWidget).toHaveBeenCalledTimes(1);
    });

    test('auto-resolving a TUI permission prompt leaves a newer stacked prompt in place', async () => {
        const promptStack: any[] = [];
        const closeInputPrompt = jest.fn((widget: any) => {
            const index = promptStack.lastIndexOf(widget);
            if (index >= 0) {
                promptStack.splice(index, 1);
            }
            return promptStack.at(-1) ?? null;
        });
        const fakeTui = {
            activeTaskId: 'task-1',
            isInputBlocked: jest.fn(() => promptStack.length > 0),
            inputArea: {
                showPromptWidget: jest.fn((widget: any) => promptStack.push(widget)),
                hidePromptWidget: jest.fn(() => promptStack.pop())
            },
            closeInputPrompt,
            focusAfterInputPromptClose: jest.fn(),
            focusInputAreaIfAvailable: jest.fn(),
            tui: {
                requestRender: jest.fn(),
                setFocus: jest.fn()
            }
        } as any;
        const provider = new TUIPermissionPromptProvider(fakeTui);
        const response = provider.prompt([outsideWorkspaceRequest], 'testPermissionTool', [], {
            taskId: 'task-1',
            taskName: 'Task 1'
        });
        const permissionWidget = promptStack[0];
        const newerPrompt = { kind: 'newer-prompt' };
        promptStack.push(newerPrompt);
        const unlimitedContext = await HarnessContext.createForMode('/workspace', MAIN_AGENT_UNLIMITED_MODE);

        await provider.notifyPermissionRulesChanged!(unlimitedContext.permission!, ['task-1']);

        await expect(response).resolves.toEqual({ decision: 'allow', rememberScope: 'none' });
        expect(closeInputPrompt).toHaveBeenCalledWith(permissionWidget);
        expect(promptStack).toEqual([newerPrompt]);
        expect(fakeTui.focusAfterInputPromptClose).toHaveBeenCalledWith(newerPrompt);
        expect(fakeTui.focusInputAreaIfAvailable).not.toHaveBeenCalled();
    });

    test.each(['user response', 'task cancellation'])(
        '%s closes the exact TUI permission widget and preserves a newer prompt',
        async (completionType) => {
            const promptStack: any[] = [];
            const closeInputPrompt = jest.fn((widget: any) => {
                const index = promptStack.lastIndexOf(widget);
                if (index >= 0) {
                    promptStack.splice(index, 1);
                }
                return promptStack.at(-1) ?? null;
            });
            const fakeTui = {
                activeTaskId: 'task-1',
                isInputBlocked: jest.fn(() => promptStack.length > 0),
                inputArea: {
                    showPromptWidget: jest.fn((widget: any) => promptStack.push(widget)),
                    hidePromptWidget: jest.fn((widget?: any) => {
                        const target = widget ?? promptStack.at(-1);
                        const index = promptStack.lastIndexOf(target);
                        if (index >= 0) {
                            promptStack.splice(index, 1);
                        }
                        return promptStack.at(-1) ?? null;
                    })
                },
                closeInputPrompt,
                focusAfterInputPromptClose: jest.fn(),
                focusInputAreaIfAvailable: jest.fn(),
                tui: {
                    requestRender: jest.fn(),
                    setFocus: jest.fn()
                }
            } as any;
            const provider = new TUIPermissionPromptProvider(fakeTui);
            const response = provider.prompt([outsideWorkspaceRequest], 'testPermissionTool', [], {
                taskId: 'task-1',
                taskName: 'Task 1'
            });
            const permissionWidget = promptStack[0];
            const newerPrompt = { kind: 'newer-prompt' };
            promptStack.push(newerPrompt);

            if (completionType === 'user response') {
                permissionWidget.onDone({ decision: 'allow', rememberScope: 'none' });
                await expect(response).resolves.toEqual({ decision: 'allow', rememberScope: 'none' });
            } else {
                provider.cancelTaskPrompts(['task-1']);
                await expect(response).resolves.toEqual({
                    decision: 'deny',
                    rememberScope: 'none',
                    denyReason: 'task_stopped'
                });
            }

            expect(closeInputPrompt).toHaveBeenCalledWith(permissionWidget);
            expect(promptStack).toEqual([newerPrompt]);
            expect(fakeTui.focusAfterInputPromptClose).toHaveBeenCalledWith(newerPrompt);
            expect(fakeTui.focusInputAreaIfAvailable).not.toHaveBeenCalled();
        }
    );
});
