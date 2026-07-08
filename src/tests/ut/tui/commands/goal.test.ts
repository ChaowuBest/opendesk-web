import { jest } from '@jest/globals';
import { SlashCommandRegistry } from '../../../../main/tui/commands/base';
import { GoalController, getGoalTokenUsage } from '../../../../main/aikernel/goal/controller';
import { GoalScheduler } from '../../../../main/aikernel/goal/scheduler';
import { GoalEvents } from '../../../../main/aikernel/goal/state';
import { TaskManagerState, TaskState } from '../../../../main/aikernel/states/tasks';
import { setRuntimeLocale } from '../../../../locale/index';

const overlayShows: Array<{ title?: string; message?: string }> = [];
const confirmShows: Array<{
    title?: string;
    message?: string;
    onConfirm?: () => void;
    onCancel?: () => void;
}> = [];

jest.unstable_mockModule('../../../../main/tui/components/notice.js', () => ({
    ConfirmOverlay: class {
        options: { title?: string; message?: string };

        constructor(_tui: unknown, options: { title?: string; message?: string }) {
            this.options = options;
        }

        show(onConfirm?: () => void, onCancel?: () => void): void {
            confirmShows.push({
                title: this.options.title,
                message: this.options.message,
                onConfirm,
                onCancel
            });
        }
    },
    InfoOverlay: class {
        options: { title?: string; message?: string };

        constructor(_tui: unknown, options: { title?: string; message?: string }) {
            this.options = options;
        }

        show(): void {
            overlayShows.push({ title: this.options.title, message: this.options.message });
        }
    }
}));

function createTask(taskId = 'task-goal-command'): TaskState {
    const manager = new TaskManagerState();
    manager.save = jest.fn();
    manager.publishTaskListUpdate = jest.fn();
    manager.moveTaskToEnd = jest.fn();
    const task = new TaskState(manager);
    task.task_id = taskId;
    manager.tasks.push(task);
    jest.spyOn(task, 'buildToolsets').mockResolvedValue([]);
    jest.spyOn(task, 'processTaskTurn').mockResolvedValue();
    return task;
}

async function createTui(task = createTask()) {
    const { registerGoalCommand } = await import('../../../../main/tui/commands/goal.js');
    const { registerStopCommand } = await import('../../../../main/tui/commands/stop.js');
    const registry = new SlashCommandRegistry();
    const tui = {
        commandRegistry: registry,
        activeTaskId: task.task_id,
        taskManagerState: task.task_manager_state,
        taskView: {
            syncUserMessageFromHistory: jest.fn(),
            showPendingGoalEdit: jest.fn()
        },
        inputArea: {
            statusBar: { stopTimer: jest.fn() },
            setStatus: jest.fn(),
            clearMessageQueue: jest.fn()
        },
        followRunningTask: jest.fn(),
        tui: { requestRender: jest.fn() }
    } as any;
    registerGoalCommand(tui);
    registerStopCommand(tui);
    return { tui, registry, task };
}

async function createTuiWithoutActiveTask() {
    const { registerGoalCommand } = await import('../../../../main/tui/commands/goal.js');
    const registry = new SlashCommandRegistry();
    const manager = new TaskManagerState();
    manager.save = jest.fn();
    manager.publishTaskListUpdate = jest.fn();
    manager.moveTaskToEnd = jest.fn();
    const tui = {
        commandRegistry: registry,
        activeTaskId: undefined,
        taskManagerState: manager,
        createNewTask: jest.fn(async () => {
            const task = new TaskState(manager);
            task.task_id = 'created-by-goal';
            manager.tasks.push(task);
            jest.spyOn(task, 'buildToolsets').mockResolvedValue([]);
            jest.spyOn(task, 'processTaskTurn').mockResolvedValue();
            tui.activeTaskId = task.task_id;
        }),
        taskView: {
            syncUserMessageFromHistory: jest.fn(),
            showPendingGoalEdit: jest.fn()
        },
        inputArea: {
            statusBar: { stopTimer: jest.fn() },
            setStatus: jest.fn(),
            clearMessageQueue: jest.fn()
        },
        followRunningTask: jest.fn(),
        tui: { requestRender: jest.fn() }
    } as any;
    registerGoalCommand(tui);
    return { tui, registry, manager };
}

describe('/goal command', () => {
    beforeEach(() => {
        overlayShows.length = 0;
        confirmShows.length = 0;
        setRuntimeLocale('en-US');
    });

    afterEach(() => {
        setRuntimeLocale(null);
        jest.restoreAllMocks();
    });

    test('bare /goal shows help and does not create a goal', async () => {
        const { registry, task } = await createTui();

        expect(await registry.execute('/goal    ')).toBe(true);

        expect(task.goal_state).toBeUndefined();
        expect(overlayShows.at(-1)?.message).toContain('/goal <objective>');
    });

    test('creates and starts a goal through the scheduler', async () => {
        const { tui, registry, task } = await createTui();

        expect(await registry.execute('/goal fix export rendering')).toBe(true);

        expect(task.goal_state?.status).toBe('active');
        expect(task.goal_state?.objective).toBe('fix export rendering');
        expect(task.goal_state?.schedulerLease?.reason).toBe('create');
        expect(task.task_status).toBe('running');
        expect(task.processTaskTurn).toHaveBeenCalledTimes(1);
        expect(tui.followRunningTask).toHaveBeenCalledWith(task);
        // Display message at [0], scheduler internal message at [1]
        const displayMessage = task.chat_context.messages[0] as any;
        expect(displayMessage.rawText).toBe('/goal fix export rendering');
        expect(displayMessage.metadata.execution.controller).toBe('goal');
        const schedulerMessage = task.chat_context.messages[1] as any;
        expect(schedulerMessage.internal).toBe(true);
        expect(schedulerMessage.metadata.execution.controller).toBe('goal');
    });

    test('creates a goal during a running task without starting another scheduler turn', async () => {
        const { tui, registry, task } = await createTui();
        task.task_status = 'running';

        expect(await registry.execute('/goal track current TodoWrite')).toBe(true);

        expect(task.goal_state?.status).toBe('active');
        expect(task.goal_state?.objective).toBe('track current TodoWrite');
        expect(task.goal_state?.schedulerLease).toBeUndefined();
        expect(task.task_status).toBe('running');
        expect(task.processTaskTurn).not.toHaveBeenCalled();
        expect(tui.followRunningTask).not.toHaveBeenCalled();
        expect(tui.taskView.showPendingGoalEdit).toHaveBeenCalledWith(
            'create',
            'track current TodoWrite',
            task.goal_state?.id,
            task.goal_state?.revision
        );
    });

    test('completes subcommands only and treats additional text as objective text', async () => {
        const { registry, task } = await createTui();
        const goalCommand = registry.get('goal');

        expect(goalCommand?.getArgumentCompletions?.('')).toEqual([]);
        expect(goalCommand?.getArgumentCompletions?.('   ')).toEqual([]);
        expect(goalCommand?.getArgumentCompletions?.('he')?.map((item) => item.label)).toContain('help');
        expect(goalCommand?.getArgumentCompletions?.('sta')?.map((item) => item.label)).not.toContain('status');

        expect(goalCommand?.getArgumentCompletions?.('fix export ')).toEqual([]);
        expect(goalCommand?.getArgumentCompletions?.('fix export --option')).toEqual([]);

        expect(await registry.execute('/goal fix export --option value')).toBe(true);
        expect(task.goal_state?.objective).toBe('fix export --option value');
    });

    test('asks before editing an active goal and keeps token usage baseline', async () => {
        const { registry, task } = await createTui();
        GoalController.create(task, { objective: 'initial goal', source: 'tui' });
        task.chat_context.messages.push({
            role: 'assistant',
            usage: { total_tokens: 250 },
            content: []
        } as any);
        const originalGoalId = task.goal_state!.id;
        expect(getGoalTokenUsage(task)).toBe(250);

        const cancelPending = registry.execute('/goal replacement goal');
        await Promise.resolve();
        expect(confirmShows).toHaveLength(1);
        expect(confirmShows.at(-1)?.message).toContain('initial goal');
        confirmShows.at(-1)?.onCancel?.();
        await cancelPending;

        expect(task.goal_state?.id).toBe(originalGoalId);
        expect(task.goal_state?.objective).toBe('initial goal');
        expect(task.goal_state?.revision).toBe(1);

        const confirmPending = registry.execute('/goal replacement goal');
        await Promise.resolve();
        expect(confirmShows).toHaveLength(2);
        confirmShows.at(-1)?.onConfirm?.();
        await confirmPending;

        expect(task.goal_state?.id).toBe(originalGoalId);
        expect(task.goal_state?.objective).toBe('replacement goal');
        expect(task.goal_state?.revision).toBe(2);
        expect(getGoalTokenUsage(task)).toBe(250);
    });

    test('edits a running goal after confirmation without clearing the current runner', async () => {
        const { tui, registry, task } = await createTui();
        GoalController.create(task, { objective: 'initial running goal', source: 'tui' });
        const originalGoalId = task.goal_state!.id;
        task.task_status = 'running';
        const waitForRuntimeInterruptSettledSpy = jest.spyOn(task, 'waitForRuntimeInterruptSettled');
        const interruptSpy = jest.spyOn(task, 'interruptRunningTurn');

        const pending = registry.execute('/goal replacement after interrupt');
        await Promise.resolve();
        expect(confirmShows).toHaveLength(1);

        confirmShows.at(-1)?.onConfirm?.();
        await pending;

        expect(task.goal_state?.id).toBe(originalGoalId);
        expect(task.goal_state?.objective).toBe('replacement after interrupt');
        expect(task.goal_state?.revision).toBe(2);
        expect(task.goal_state?.status).toBe('active');
        expect(task.task_status).toBe('running');
        expect(task.runtimeInterrupt).toBeUndefined();
        expect(task.goal_state?.pendingContinuation?.reason).toBe('edit');
        expect(task.goal_state?.pendingContinuation?.goalRevision).toBe(2);
        expect(interruptSpy).not.toHaveBeenCalled();
        expect(waitForRuntimeInterruptSettledSpy).not.toHaveBeenCalled();
        expect(task.processTaskTurn).not.toHaveBeenCalled();
        expect(tui.followRunningTask).not.toHaveBeenCalled();
        expect((task as any)._pendingGoalEditReminders).toHaveLength(1);
        expect(tui.taskView.showPendingGoalEdit).toHaveBeenCalledWith(
            'edit',
            'replacement after interrupt',
            task.goal_state?.id,
            task.goal_state?.revision
        );
    });

    test('auto-starts a pending edit continuation after the current turn finishes', async () => {
        const task = createTask();
        GoalController.create(task, { objective: 'initial goal', source: 'tui' });
        GoalController.editObjective(task, 'replacement goal', 'tui');
        task.task_status = 'stopped';
        const startExecutionSpy = jest.spyOn(GoalScheduler, 'startExecution').mockResolvedValue({
            ok: true,
            status: 'active',
            startedScheduler: true
        });

        (task as any).maybeStartPendingGoalContinuationAfterTurn();
        await Promise.resolve();

        expect(startExecutionSpy).toHaveBeenCalledWith(task, 'resume');
    });

    test('does not clear an active goal when showing help', async () => {
        const { registry, task } = await createTui();
        GoalController.create(task, { objective: 'initial goal', source: 'tui' });
        const originalGoalId = task.goal_state!.id;

        expect(await registry.execute('/goal    ')).toBe(true);

        expect(confirmShows).toHaveLength(0);
        expect(task.goal_state?.id).toBe(originalGoalId);
        expect(task.goal_state?.objective).toBe('initial goal');
        expect(overlayShows.at(-1)?.message).toContain('/goal help');
    });

    test('creates a task before creating a goal when there is no active task', async () => {
        const { tui, registry, manager } = await createTuiWithoutActiveTask();

        expect(await registry.execute('/goal fix export rendering')).toBe(true);

        const task = manager.getTask('created-by-goal');
        expect(tui.createNewTask).toHaveBeenCalledTimes(1);
        expect(tui.activeTaskId).toBe('created-by-goal');
        expect(task?.goal_state?.status).toBe('active');
        expect(task?.goal_state?.objective).toBe('fix export rendering');
        expect(task?.task_status).toBe('running');
        expect(tui.followRunningTask).toHaveBeenCalledWith(task);
    });

    test('help and reserved-looking objectives do not expose extra goal commands', async () => {
        const { registry, task } = await createTui();
        GoalController.create(task, { objective: 'initial goal', source: 'tui' });
        const revision = task.goal_state!.revision;

        expect(await registry.execute('/goal help')).toBe(true);
        expect(overlayShows.at(-1)?.message).toContain('/goal help');
        expect(overlayShows.at(-1)?.message).not.toContain('/goal status');

        const statusPending = registry.execute('/goal status');
        await Promise.resolve();
        expect(confirmShows).toHaveLength(1);
        confirmShows.at(-1)?.onCancel?.();
        await statusPending;
        expect(task.goal_state?.revision).toBe(revision);
        expect(task.goal_state?.objective).toBe('initial goal');

        const pending = registry.execute('/goal edit replacement objective');
        await Promise.resolve();
        expect(confirmShows).toHaveLength(2);
        confirmShows.at(-1)?.onCancel?.();
        await pending;

        expect(task.goal_state?.revision).toBe(revision);
        expect(task.goal_state?.objective).toBe('initial goal');
        expect(overlayShows.at(-1)?.message).not.toContain('/goal edit');
    });

    test('pause resume and clear go through shared goal service semantics', async () => {
        const { tui, registry, task } = await createTui();
        await registry.execute('/goal ship feature');

        expect(await registry.execute('/goal pause waiting for review')).toBe(true);
        expect(task.goal_state?.status).toBe('active');
        expect(overlayShows.at(-1)?.message).toContain('pause does not accept arguments');

        expect(await registry.execute('/goal pause')).toBe(true);
        expect(task.goal_state?.status).toBe('paused');
        expect(task.goal_state?.pauseReason).toBeUndefined();
        expect(task.task_status).toBe('stopped');

        expect(await registry.execute('/goal resume waiting for review')).toBe(true);
        expect(task.goal_state?.status).toBe('paused');
        expect(task.task_status).toBe('stopped');
        expect(overlayShows.at(-1)?.message).toContain('resume does not accept arguments');

        expect(await registry.execute('/goal resume')).toBe(true);
        expect(task.goal_state?.status).toBe('active');
        expect(task.task_status).toBe('running');
        expect(tui.followRunningTask).toHaveBeenLastCalledWith(task);
        const resumedEvent = GoalEvents.getTail(task.goal_event_log).find((event) => event.type === 'resumed');
        expect(resumedEvent?.payload).toBeUndefined();

        expect(await registry.execute('/goal clear unexpected')).toBe(true);
        expect(task.goal_state?.status).toBe('active');
        expect(overlayShows.at(-1)?.message).toContain('clear does not accept arguments');

        task.message_queue = ['queued while goal is running'];
        expect(await registry.execute('/goal clear')).toBe(true);
        expect(task.goal_state?.status).toBe('cleared');
        expect(task.goal_state?.pendingContinuation).toBeUndefined();
        expect(task.goal_state?.schedulerLease).toBeUndefined();
        expect(task.message_queue).toEqual([]);
        expect(tui.inputArea.clearMessageQueue).toHaveBeenCalled();
    });

    test('/stop rejects active goal without calling ordinary task stop', async () => {
        const { registry, task, tui } = await createTui();
        await registry.execute('/goal active work');
        const stopSpy = jest.spyOn(task, 'stop');

        expect(await registry.execute('/stop')).toBe(true);

        expect(stopSpy).not.toHaveBeenCalled();
        expect(task.goal_state?.status).toBe('active');
        expect(task.task_status).toBe('running');
        expect(tui.inputArea.statusBar.stopTimer).not.toHaveBeenCalled();
        expect(overlayShows.at(-1)?.message).toContain('/goal pause');
    });
});
