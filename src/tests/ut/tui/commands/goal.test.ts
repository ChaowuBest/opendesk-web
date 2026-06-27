import { jest } from '@jest/globals';
import { SlashCommandRegistry } from '../../../../main/tui/commands/base';
import { GoalController } from '../../../../main/aikernel/goal/controller';
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
        expect(overlayShows.at(-1)?.message).not.toContain('/goal resume [note]');
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
        const userMessage = task.chat_context.messages[0] as any;
        expect(userMessage.internal).toBe(true);
        expect(userMessage.metadata.execution.controller).toBe('goal');
    });

    test('completes budget flags after objective and applies them on create', async () => {
        const { registry, task } = await createTui();
        const goalCommand = registry.get('goal');

        expect(goalCommand?.getArgumentCompletions?.('')).toEqual([]);
        expect(goalCommand?.getArgumentCompletions?.('   ')).toEqual([]);
        expect(goalCommand?.getArgumentCompletions?.('he')?.map((item) => item.label)).toContain('help');
        expect(goalCommand?.getArgumentCompletions?.('sta')?.map((item) => item.label)).not.toContain('status');

        const completions = goalCommand?.getArgumentCompletions?.('fix export ');
        expect(completions?.map((item) => item.label)).toEqual(
            expect.arrayContaining(['--token-budget', '--max-attempts'])
        );
        expect(completions?.find((item) => item.label === '--token-budget')?.value).toBe('fix export --token-budget ');

        const partialFlagCompletions = goalCommand?.getArgumentCompletions?.('fix export --to');
        expect(partialFlagCompletions?.find((item) => item.label === '--token-budget')?.value).toBe(
            'fix export --token-budget '
        );
        expect(
            goalCommand?.getArgumentCompletions?.('fix export --token-budget 50000 --')?.map((item) => item.label)
        ).toEqual(['--max-attempts']);

        expect(await registry.execute('/goal fix export --token-budget 50000 --max-attempts 5')).toBe(true);
        expect(task.goal_state?.objective).toBe('fix export');
        expect(task.goal_state?.tokenBudget?.maxTotalTokens).toBe(50000);
        expect(task.goal_state?.maxAttempts).toBe(5);
    });

    test('asks before replacing an active goal and resets token usage for the new goal', async () => {
        const { registry, task } = await createTui();
        GoalController.create(task, {
            objective: 'initial goal',
            source: 'tui',
            tokenBudget: { maxTotalTokens: 1000, usedTotalTokens: 0 }
        });
        task.chat_context.messages.push({
            role: 'assistant',
            usage: { total_tokens: 250 },
            content: []
        } as any);
        const originalGoalId = task.goal_state!.id;
        expect(GoalController.getStatus(task).summary?.tokenBudget?.usedTotalTokens).toBe(250);

        const cancelPending = registry.execute('/goal replacement goal --token-budget 500');
        await Promise.resolve();
        expect(confirmShows).toHaveLength(1);
        expect(confirmShows.at(-1)?.message).toContain('initial goal');
        confirmShows.at(-1)?.onCancel?.();
        await cancelPending;

        expect(task.goal_state?.id).toBe(originalGoalId);
        expect(task.goal_state?.objective).toBe('initial goal');

        const confirmPending = registry.execute('/goal replacement goal --token-budget 500');
        await Promise.resolve();
        expect(confirmShows).toHaveLength(2);
        confirmShows.at(-1)?.onConfirm?.();
        await confirmPending;

        expect(task.goal_state?.id).not.toBe(originalGoalId);
        expect(task.goal_state?.objective).toBe('replacement goal');
        expect(task.goal_state?.tokenBudget?.maxTotalTokens).toBe(500);
        expect(GoalController.getStatus(task).summary?.tokenBudget?.usedTotalTokens).toBe(0);
    });

    test('replaces a running goal only after the old run interrupt settles', async () => {
        const { tui, registry, task } = await createTui();
        GoalController.create(task, { objective: 'initial running goal', source: 'tui' });
        task.task_status = 'running';
        const interruptSpy = jest.spyOn(task, 'interruptRunningTurn').mockImplementation(async (options) => {
            task.runtimeInterrupt = {
                requested: true,
                reason: options.reason,
                requestedAt: new Date().toISOString()
            };
            task.task_status = 'stopped';
            setTimeout(() => {
                task.runtimeInterrupt = undefined;
            }, 100);
        });

        jest.useFakeTimers();
        try {
            const pending = registry.execute('/goal replacement after interrupt');
            await Promise.resolve();
            expect(confirmShows).toHaveLength(1);

            confirmShows.at(-1)?.onConfirm?.();
            await Promise.resolve();
            expect(interruptSpy).toHaveBeenCalledWith({
                reason: 'goal_clear',
                stopRunningTools: true,
                cancelPermissionPrompts: true
            });

            await jest.advanceTimersByTimeAsync(150);
            await pending;
        } finally {
            jest.useRealTimers();
        }

        expect(task.goal_state?.objective).toBe('replacement after interrupt');
        expect(task.goal_state?.status).toBe('active');
        expect(task.task_status).toBe('running');
        expect(task.runtimeInterrupt).toBeUndefined();
        expect(task.processTaskTurn).toHaveBeenCalledTimes(1);
        expect(tui.followRunningTask).toHaveBeenLastCalledWith(task);
    });

    test('does not clear an active goal when replacement objective is empty', async () => {
        const { registry, task } = await createTui();
        GoalController.create(task, { objective: 'initial goal', source: 'tui' });
        const originalGoalId = task.goal_state!.id;

        expect(await registry.execute('/goal --token-budget 500')).toBe(true);

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

    test('help and edit-prefixed objective do not expose a goal edit command', async () => {
        const { registry, task } = await createTui();
        GoalController.create(task, { objective: 'initial goal', source: 'tui' });
        const revision = task.goal_state!.revision;

        expect(await registry.execute('/goal help')).toBe(true);
        expect(overlayShows.at(-1)?.message).toContain('/goal help');
        expect(overlayShows.at(-1)?.message).not.toContain('/goal status');

        expect(await registry.execute('/goal status')).toBe(true);
        expect(overlayShows.at(-1)?.message).toContain('/goal help');
        expect(task.goal_state?.revision).toBe(revision);

        const pending = registry.execute('/goal edit replacement objective');
        await Promise.resolve();
        expect(confirmShows).toHaveLength(1);
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

        expect(await registry.execute('/goal clear')).toBe(true);
        expect(task.goal_state?.status).toBe('cleared');
        expect(task.goal_state?.pendingContinuation).toBeUndefined();
        expect(task.goal_state?.schedulerLease).toBeUndefined();
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
