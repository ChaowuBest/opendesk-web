import { jest } from '@jest/globals';
import { GoalController } from '../../../main/aikernel/goal/controller.js';
import { GoalStates } from '../../../main/aikernel/goal/state.js';
import { LLM } from '../../../main/aikernel/llm.js';
import { OpenDeskTUI } from '../../../main/tui/entry.js';
import { Setting } from '../../../main/utils/setting.js';

describe('OpenDeskTUI active task view state', () => {
    test('refreshes model info after creating a new task', async () => {
        const previousTask = { task_id: 'task-a', message_queue: [] };
        const newTask = {
            task_id: 'task-b',
            message_queue: [],
            rebuildSystemPrompt: jest.fn(async () => undefined)
        };
        const resolveModelInfo = jest.fn(function (this: OpenDeskTUI) {
            expect(this.activeTaskId).toBe(newTask.task_id);
            expect(this.taskView.taskState).toBe(newTask);
        });
        const tui = Object.assign(Object.create(OpenDeskTUI.prototype), {
            activeTaskId: previousTask.task_id,
            model: undefined,
            pendingTaskName: null,
            taskManagerState: {
                createTask: jest.fn(() => newTask),
                getTask: jest.fn(() => previousTask)
            },
            taskView: {
                taskState: previousTask,
                clearMessages: jest.fn()
            },
            inputArea: {
                getQueueSnapshot: jest.fn(() => []),
                bindToTaskQueue: jest.fn(),
                setStatus: jest.fn(),
                statusBar: {
                    stopTimer: jest.fn(),
                    resetAccumulated: jest.fn(),
                    update: jest.fn()
                }
            },
            initTaskHarness: jest.fn(async () => undefined),
            updateGoalPanelFromTask: jest.fn(),
            syncRetryCommandAvailability: jest.fn(),
            syncTaskName: jest.fn(),
            resolveModelInfo,
            tui: {
                requestRender: jest.fn()
            }
        }) as any;

        await tui.createNewTask();

        expect(resolveModelInfo).toHaveBeenCalledTimes(1);
    });

    test('refreshes model info after switching to another task', async () => {
        const previousTask = { task_id: 'task-a', message_queue: [] };
        const nextTask = {
            task_id: 'task-b',
            task_status: 'stopped',
            message_queue: [],
            total_elapsed_ms: 0,
            _corrupted: false,
            ensureValidModelOrFallback: jest.fn(),
            ensureToolsResolved: jest.fn(async () => undefined),
            getWorkspace: jest.fn(() => '/workspace')
        };
        const resolveModelInfo = jest.fn(function (this: OpenDeskTUI) {
            expect(this.activeTaskId).toBe(nextTask.task_id);
            expect(this.taskView.taskState).toBe(nextTask);
        });
        const tui = Object.assign(Object.create(OpenDeskTUI.prototype), {
            activeTaskId: previousTask.task_id,
            workspace: '/workspace',
            taskManagerState: {
                refreshLazyTaskSystemPrompt: jest.fn(async () => undefined),
                getTask: jest.fn(() => previousTask)
            },
            taskView: {
                taskState: previousTask,
                clearMessages: jest.fn(),
                rebuildFromHistory: jest.fn()
            },
            inputArea: {
                getQueueSnapshot: jest.fn(() => []),
                bindToTaskQueue: jest.fn(),
                setStatus: jest.fn(),
                statusBar: {
                    stopTimer: jest.fn(),
                    setAccumulatedMs: jest.fn(),
                    update: jest.fn()
                }
            },
            updateGoalPanelFromTask: jest.fn(),
            syncRetryCommandAvailability: jest.fn(),
            syncTaskName: jest.fn(),
            startRunningMonitorForTask: jest.fn(),
            processPendingPrompts: jest.fn(),
            resolveModelInfo,
            tui: {
                requestRender: jest.fn()
            }
        }) as any;

        await tui.switchToTask(nextTask as any);

        expect(resolveModelInfo).toHaveBeenCalledTimes(1);
    });

    test('ignores stale asynchronous model info after the active task changes', async () => {
        let resolveClaudeVision!: (value: boolean) => void;
        let resolveGptVision!: (value: boolean) => void;
        const claudeVision = new Promise<boolean>((resolve) => {
            resolveClaudeVision = resolve;
        });
        const gptVision = new Promise<boolean>((resolve) => {
            resolveGptVision = resolve;
        });
        const settingData = {
            locale: 'en-US',
            default_model: 'gpt-5',
            models: [
                { alias: 'claude', model_name: 'claude', model_type: 'chat', context_length: 100_000 },
                { alias: 'gpt-5', model_name: 'gpt-5', model_type: 'chat', context_length: 100_000 }
            ]
        };
        const setting = {
            data: settingData,
            getData: () => ({
                ...settingData
            }),
            getModelInstance: jest.fn()
        };
        const settingSpy = jest.spyOn(Setting, 'getInstance').mockReturnValue(setting as any);
        const visionSpy = jest.spyOn(LLM, 'supportsVision').mockImplementation((model) => {
            return model === 'claude' ? claudeVision : gptVision;
        });
        let activeTask = {
            task_id: 'task-a',
            model: 'claude',
            ensureValidModelOrFallback: jest.fn(),
            getWorkspace: jest.fn(() => '/workspace-a')
        };
        const update = jest.fn();
        const tui = Object.assign(Object.create(OpenDeskTUI.prototype), {
            activeTaskId: activeTask.task_id,
            lastGlobalDefaultModel: 'gpt-5',
            modelInfoRefreshGeneration: 0,
            workspace: '/workspace',
            taskManagerState: {
                getTask: () => activeTask
            },
            getActiveTask: () => activeTask,
            isTaskStarted: () => true,
            hideModelNotConfiguredNotice: jest.fn(),
            inputArea: {
                statusBar: { update }
            },
            tui: {
                requestRender: jest.fn()
            }
        }) as any;

        try {
            tui.resolveModelInfo();
            activeTask = {
                task_id: 'task-b',
                model: 'gpt-5',
                ensureValidModelOrFallback: jest.fn(),
                getWorkspace: jest.fn(() => '/workspace-b')
            };
            tui.activeTaskId = activeTask.task_id;
            tui.resolveModelInfo();

            resolveGptVision(true);
            await gptVision;
            await Promise.resolve();
            resolveClaudeVision(false);
            await claudeVision;
            await Promise.resolve();

            const modelUpdates = update.mock.calls
                .map(([value]) => value.modelName)
                .filter((value) => value !== undefined);
            expect(modelUpdates.at(-1)).toBe('gpt-5 📷');
        } finally {
            visionSpy.mockRestore();
            settingSpy.mockRestore();
        }
    });

    test('uses the configured output display shortcut instead of fixed Ctrl+O', () => {
        Setting.clearCache();
        Setting.updateInstanceData({
            cli_config: {
                shortcuts: {
                    output_display: 'ctrl+u'
                }
            }
        });
        let inputListener: ((data: string) => { consume?: boolean } | undefined) | undefined;
        const cycleOutputDisplayLevel = jest.fn();
        const input = {};
        const tui = Object.assign(Object.create(OpenDeskTUI.prototype), {
            configComponent: undefined,
            textPageActive: false,
            cycleOutputDisplayLevel,
            inputArea: {
                input,
                hasPromptWidget: jest.fn(() => false),
                shellResultPanel: { isVisible: jest.fn(() => false) },
                btwResultPanel: { isVisible: jest.fn(() => false) }
            },
            tui: {
                start: jest.fn(),
                addInputListener: jest.fn((listener) => {
                    inputListener = listener;
                    return jest.fn();
                }),
                setFocus: jest.fn()
            },
            shortcutManager: { attach: jest.fn() }
        }) as any;
        Object.defineProperty(tui, 'hasOpenOverlay', { value: false, writable: true });

        tui.start();

        expect(inputListener?.('\x0f')).toBeUndefined();
        expect(cycleOutputDisplayLevel).not.toHaveBeenCalled();
        expect(inputListener?.('\x15')).toEqual({ consume: true });
        expect(cycleOutputDisplayLevel).toHaveBeenCalledTimes(1);
    });

    test('cycles the current task output display without persisting configuration', () => {
        Setting.clearCache();
        Setting.updateInstanceData({
            cli_config: {
                output_display: 'minimal',
                show_all_reasoning: false
            }
        });
        const setOutputDisplayLevel = jest.fn();
        const updateStatusBar = jest.fn();
        const requestRender = jest.fn();
        const tui = Object.assign(Object.create(OpenDeskTUI.prototype), {
            activeTaskId: 'task-1',
            taskOutputDisplayLevels: new Map([['task-1', 'minimal']]),
            taskView: {
                getOutputDisplayLevel: jest.fn(() => 'minimal'),
                setOutputDisplayLevel
            },
            inputArea: { statusBar: { update: updateStatusBar } },
            tui: { requestRender }
        }) as any;

        expect(tui.cycleOutputDisplayLevel()).toBe('verbose');
        expect(setOutputDisplayLevel).toHaveBeenCalledWith('verbose');
        expect(updateStatusBar).toHaveBeenCalledWith({ outputDisplayLevel: 'verbose' });
        expect(tui.taskOutputDisplayLevels.get('task-1')).toBe('verbose');
        expect(Setting.getInstance().getData().cli_config?.output_display).toBe('minimal');
        expect(requestRender).toHaveBeenCalled();
    });

    test('preserves a task temporary level while new tasks use the persisted default', () => {
        Setting.clearCache();
        Setting.updateInstanceData({
            cli_config: {
                output_display: 'minimal',
                show_all_reasoning: false
            }
        });
        const setOutputDisplayLevel = jest.fn();
        const updateStatusBar = jest.fn();
        const tui = Object.assign(Object.create(OpenDeskTUI.prototype), {
            taskOutputDisplayLevels: new Map([['task-1', 'verbose']]),
            taskView: { setOutputDisplayLevel },
            inputArea: { statusBar: { update: updateStatusBar } }
        }) as any;

        tui.bindOutputDisplayLevelToTask('task-1');
        tui.bindOutputDisplayLevelToTask('task-2');

        expect(setOutputDisplayLevel).toHaveBeenNthCalledWith(1, 'verbose');
        expect(setOutputDisplayLevel).toHaveBeenNthCalledWith(2, 'minimal');
        expect(updateStatusBar).toHaveBeenNthCalledWith(1, { outputDisplayLevel: 'verbose' });
        expect(updateStatusBar).toHaveBeenNthCalledWith(2, { outputDisplayLevel: 'minimal' });
    });

    test('syncs input status from the current task instead of forcing idle', () => {
        const task = { task_id: 'task-1', task_status: 'running' };
        const setStatus = jest.fn();
        const startTimer = jest.fn();
        const stopTimer = jest.fn();
        const tui = Object.assign(Object.create(OpenDeskTUI.prototype), {
            activeTaskId: task.task_id,
            taskManagerState: {
                getTask: jest.fn(() => task)
            },
            inputArea: {
                setStatus,
                statusBar: { startTimer, stopTimer }
            }
        }) as any;

        expect(tui.syncInputStatusFromTask(task.task_id)).toBe(true);

        expect(setStatus).toHaveBeenLastCalledWith('running');
        expect(startTimer).toHaveBeenCalledTimes(1);
        expect(stopTimer).not.toHaveBeenCalled();

        task.task_status = 'stopped';
        expect(tui.syncInputStatusFromTask(task.task_id)).toBe(false);

        expect(stopTimer).toHaveBeenCalledTimes(1);
        expect(setStatus).toHaveBeenLastCalledWith('idle');
    });

    test('clearActiveTask clears stale active task state', () => {
        const clearTodos = jest.fn();
        const resolveModelInfo = jest.fn();
        const tui = Object.assign(Object.create(OpenDeskTUI.prototype), {
            taskView: {
                taskState: { task_id: 'task-1' },
                clearMessages: jest.fn()
            },
            todoList: {
                clear: clearTodos
            },
            activeTaskId: 'task-1',
            goalEvaluationInProgressByTask: new Map(),
            resolveModelInfo,
            syncRetryCommandAvailability: jest.fn(),
            inputArea: {
                clearMessageQueue: jest.fn(),
                clearGoalSupplementQueuedHint: jest.fn(),
                setStatus: jest.fn(),
                statusBar: {
                    stopTimer: jest.fn(),
                    resetAccumulated: jest.fn(),
                    update: jest.fn()
                }
            },
            tui: {
                requestRender: jest.fn()
            }
        }) as any;

        tui.clearActiveTask();

        expect(tui.taskView.taskState).toBeUndefined();
        expect(tui.activeTaskId).toBeUndefined();
        expect(clearTodos).toHaveBeenCalledTimes(1);
        expect(tui.inputArea.clearGoalSupplementQueuedHint).toHaveBeenCalled();
        expect(resolveModelInfo).toHaveBeenCalledTimes(1);
        expect(tui.tui.requestRender).toHaveBeenCalled();
    });

    test('running active goal input is submitted as supplemental context without starting a user turn', async () => {
        const task = {
            task_id: 'task-1',
            task_status: 'stopped',
            task_name: 'Task',
            chat_context: {
                messages: [],
                appendMessage: jest.fn()
            },
            goal_state: undefined,
            goal_event_log: undefined,
            task_manager_state: {
                publishTaskListUpdate: jest.fn()
            },
            persistLater: jest.fn(),
            sendSubscriptionFeedback: jest.fn(),
            isGoalRuntimeInterrupted: jest.fn(() => false)
        } as any;
        GoalController.create(task, { objective: 'ship fix', source: 'tui' });
        task.task_status = 'running';

        const communicate = jest.fn();
        const appendPendingGoalSupplementMessage = jest.fn();
        const syncGoalPanel = jest.fn();
        const startTimer = jest.fn();
        const tui = Object.assign(Object.create(OpenDeskTUI.prototype), {
            taskView: {
                taskState: task,
                communicate,
                appendLocalUserMessage: jest.fn(),
                appendPendingGoalSupplementMessage,
                syncGoalPanel
            },
            activeTaskId: 'task-1',
            goalEvaluationInProgressByTask: new Map(),
            taskManagerState: {
                getTask: jest.fn(() => task)
            },
            inputArea: {
                clearGoalSupplementQueuedHint: jest.fn(),
                statusBar: {
                    startTimer,
                    stopTimer: jest.fn(),
                    getAccumulatedMs: jest.fn(() => 0),
                    update: jest.fn()
                },
                setStatus: jest.fn()
            },
            resolveModelInfo: jest.fn(),
            processQueue: jest.fn(),
            tui: {
                requestRender: jest.fn()
            }
        }) as any;

        await tui.onRequestSubmit('Use packages/appsdk as the target.');

        expect(communicate).not.toHaveBeenCalled();
        expect(startTimer).not.toHaveBeenCalled();
        expect(task.goal_state?.pendingSupplements).toHaveLength(1);
        expect(task.goal_state?.pendingSupplements[0].content).toBe('Use packages/appsdk as the target.');
        expect(task.goal_state?.pendingSupplements[0].source).toBe('user_message');
        expect(task.chat_context.messages).toHaveLength(0);
        expect(appendPendingGoalSupplementMessage).toHaveBeenCalledWith(
            'Use packages/appsdk as the target.',
            task.goal_state?.pendingSupplements[0].id
        );
        expect(syncGoalPanel).toHaveBeenCalledWith({
            goalState: task.goal_state,
            totalTokens: 0,
            elapsedMs: expect.any(Number)
        });
    });

    test.each(['complete', 'cleared'] as const)(
        'processes queued task messages after a goal becomes %s',
        async (status) => {
            const queue = ['continue with ordinary task work'];
            const goal = GoalStates.create('task-1', { objective: 'goal' });
            goal.status = status;
            const task = {
                task_id: 'task-1',
                task_status: 'stopped',
                goal_state: goal,
                message_queue: [...queue]
            };
            const communicate = jest.fn(async () => {});
            const clearMessageQueue = jest.fn();
            const tui = Object.assign(Object.create(OpenDeskTUI.prototype), {
                activeTaskId: task.task_id,
                taskManagerState: {
                    getTask: jest.fn(() => task)
                },
                taskView: {
                    communicate
                },
                inputArea: {
                    hasQueuedMessages: jest.fn(() => queue.length > 0),
                    getQueueSnapshot: jest.fn(() => [...queue]),
                    dequeueMessage: jest.fn(() => queue.shift()),
                    clearMessageQueue,
                    setStatus: jest.fn(),
                    statusBar: {
                        startTimer: jest.fn(),
                        stopTimer: jest.fn()
                    }
                },
                undoStacks: new Map()
            }) as any;

            await tui.processQueue();

            expect(communicate).toHaveBeenCalledWith('continue with ordinary task work');
            expect(clearMessageQueue).not.toHaveBeenCalled();
            expect(task.message_queue).toEqual([]);
        }
    );

    test('goal evaluation end immediately moves terminal goal panel into task history', () => {
        const goal = GoalStates.create('task-1', { objective: 'ship fix' });
        goal.createdAt = '2026-01-01T00:00:00.000Z';
        goal.executionStarted = true;
        goal.startedAt = '2026-01-01T00:00:00.000Z';
        goal.status = 'complete';
        goal.completedAt = '2026-01-01T00:00:05.000Z';
        const task = {
            task_id: 'task-1',
            goal_state: goal,
            chat_context: {
                messages: []
            }
        } as any;
        const syncGoalPanel = jest.fn();
        const requestRender = jest.fn();
        const tui = Object.assign(Object.create(OpenDeskTUI.prototype), {
            taskView: {
                taskState: task,
                syncGoalPanel
            },
            activeTaskId: 'task-1',
            goalEvaluationInProgressByTask: new Map([[task.task_id, `${goal.id}:${goal.revision}`]]),
            inputArea: {
                clearGoalSupplementQueuedHint: jest.fn()
            },
            tui: {
                requestRender
            }
        }) as any;

        tui.handleGoalEvalUpdate({
            type: 'goal_eval',
            task_id: 'task-1',
            task_status: 'running',
            goalId: goal.id,
            goalRevision: goal.revision,
            phase: 'end',
            evaluationId: 'eval-1',
            status: 'met',
            message: 'done',
            evidence: [],
            evaluatedAt: '2026-01-01T00:00:05.000Z'
        });

        expect(syncGoalPanel).toHaveBeenCalledWith({
            goalState: goal,
            totalTokens: 0,
            elapsedMs: 5_000,
            evaluating: false
        });
        expect(requestRender).toHaveBeenCalled();
    });

    test('goal evaluation superseded by edit keeps goal panel evaluating', () => {
        const goal = GoalStates.create('task-1', { objective: 'replacement goal' });
        goal.revision = 2;
        const task = {
            task_id: 'task-1',
            goal_state: goal,
            chat_context: {
                messages: []
            }
        } as any;
        const syncGoalPanel = jest.fn();
        const requestRender = jest.fn();
        const tui = Object.assign(Object.create(OpenDeskTUI.prototype), {
            taskView: {
                taskState: task,
                syncGoalPanel
            },
            activeTaskId: 'task-1',
            goalEvaluationInProgressByTask: new Map([[task.task_id, `${goal.id}:1`]]),
            tui: {
                requestRender
            }
        }) as any;

        tui.handleGoalEvalUpdate({
            type: 'goal_eval',
            task_id: 'task-1',
            task_status: 'running',
            goalId: goal.id,
            goalRevision: goal.revision,
            phase: 'end',
            evaluationId: 'eval-1',
            status: 'superseded',
            message: 'edited during evaluation',
            evaluatedAt: '2026-01-01T00:00:05.000Z'
        });

        expect(syncGoalPanel).toHaveBeenCalledWith({
            goalState: goal,
            totalTokens: 0,
            elapsedMs: expect.any(Number),
            evaluating: true
        });
        expect(tui.goalEvaluationInProgressByTask.get('task-1')).toBe(`${goal.id}:${goal.revision}`);
        expect(requestRender).toHaveBeenCalled();
    });
});

describe('OpenDeskTUI focusInputAreaIfAvailable', () => {
    test('restores focus in modelNotConfiguredMode so /model overlay does not freeze', () => {
        const setFocus = jest.fn();
        const input = { type: 'input' };
        const tui = Object.assign(Object.create(OpenDeskTUI.prototype), {
            isConfigMode: jest.fn(() => false),
            isModelNotConfiguredMode: jest.fn(() => true),
            isInputAreaMounted: jest.fn(() => true),
            inputArea: { input },
            tui: { setFocus }
        }) as any;

        tui.focusInputAreaIfAvailable();

        // Before the fix, setFocus was NOT called when modelNotConfiguredMode=true,
        // causing the focus to be lost after InfoOverlay closes (the "freeze" bug).
        expect(setFocus).toHaveBeenCalledWith(input);
    });

    test('still skips focus in configMode', () => {
        const setFocus = jest.fn();
        const tui = Object.assign(Object.create(OpenDeskTUI.prototype), {
            isConfigMode: jest.fn(() => true),
            isModelNotConfiguredMode: jest.fn(() => false),
            isInputAreaMounted: jest.fn(() => true),
            inputArea: { input: {} },
            tui: { setFocus }
        }) as any;

        tui.focusInputAreaIfAvailable();

        expect(setFocus).not.toHaveBeenCalled();
    });
});

describe('OpenDeskTUI model notice layout focus', () => {
    const createLayoutTui = (promptOpen: boolean) => {
        const input = { type: 'input' };
        const tui = Object.assign(Object.create(OpenDeskTUI.prototype), {
            configComponent: undefined,
            textPageActive: false,
            workspace: '/workspace',
            container: {
                clear: jest.fn(),
                addChild: jest.fn(),
                setMinLines: jest.fn()
            },
            taskView: {},
            todoList: {},
            logPanel: { mode: 'off' },
            dashboardBar: {},
            inputArea: {
                input,
                hasPromptWidget: jest.fn(() => promptOpen)
            },
            tui: {
                requestRender: jest.fn(),
                setFocus: jest.fn(),
                terminal: { rows: 40 }
            }
        }) as any;
        // hasOpenOverlay 在原型上是 setter（置 false 时会注册 processPendingPrompts 定时器），
        // 用自有数据属性绕过，避免无关定时器混入 fake timer 队列
        Object.defineProperty(tui, 'hasOpenOverlay', { value: promptOpen, writable: true, configurable: true });
        return tui;
    };

    afterEach(() => {
        jest.useRealTimers();
    });

    test('delayed focus after hiding model notice does not steal focus from the /model success overlay', () => {
        jest.useFakeTimers();
        const tui = createLayoutTui(false);
        tui.modelNotConfiguredNotice = { render: () => [] };
        tui.modelNotConfiguredMode = true;

        // /model <alias> 切换默认模型：resolveModelInfo() 隐藏引导布局并调度延迟焦点恢复
        tui.hideModelNotConfiguredNotice();

        // 命令随后显示切换成功 InfoOverlay：挂到输入区 prompt 插槽并持有焦点
        tui.hasOpenOverlay = true;
        tui.inputArea.hasPromptWidget.mockReturnValue(true);
        const overlayList = { type: 'select-list' };
        tui.tui.setFocus(overlayList);
        tui.tui.setFocus.mockClear();

        jest.advanceTimersByTime(10);

        // 延迟焦点不得把焦点从成功提示上抢走，否则提示永远无法关闭
        expect(tui.tui.setFocus).not.toHaveBeenCalled();
    });

    test('hiding model notice restores input focus when no prompt is open', () => {
        jest.useFakeTimers();
        const tui = createLayoutTui(false);
        tui.modelNotConfiguredNotice = { render: () => [] };
        tui.modelNotConfiguredMode = true;

        tui.hideModelNotConfiguredNotice();
        jest.advanceTimersByTime(10);

        expect(tui.tui.setFocus).toHaveBeenCalledWith(tui.inputArea.input);
    });

    test('showing model notice also skips delayed focus while a prompt overlay is open', () => {
        jest.useFakeTimers();
        const tui = createLayoutTui(true);

        tui.showModelNotConfiguredNotice();
        jest.advanceTimersByTime(10);

        expect(tui.tui.setFocus).not.toHaveBeenCalled();
    });
});
