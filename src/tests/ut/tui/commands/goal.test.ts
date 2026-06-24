import { jest } from '@jest/globals';
import { SlashCommandRegistry } from '../../../../main/tui/commands/base';
import { GoalController } from '../../../../main/aikernel/goal/controller';
import { TaskManagerState, TaskState } from '../../../../main/aikernel/states/tasks';
import { setRuntimeLocale } from '../../../../locale/index';

const overlayShows: Array<{ title?: string; message?: string }> = [];

jest.unstable_mockModule('../../../../main/tui/components/notice.js', () => ({
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
        const userMessage = task.chat_context.messages[0] as any;
        expect(userMessage.internal).toBe(true);
        expect(userMessage.metadata.execution.controller).toBe('goal');
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

    test('status and empty edit use localized overlays without mutating revision', async () => {
        const { registry, task } = await createTui();
        GoalController.create(task, { objective: 'initial goal', source: 'tui' });
        const revision = task.goal_state!.revision;

        expect(await registry.execute('/goal status')).toBe(true);
        expect(overlayShows.at(-1)?.message).toContain('initial goal');

        expect(await registry.execute('/goal edit   ')).toBe(true);
        expect(task.goal_state?.revision).toBe(revision);
        expect(overlayShows.at(-1)?.message).toContain('/goal <objective>');
    });

    test('pause resume and clear go through shared goal service semantics', async () => {
        const { tui, registry, task } = await createTui();
        await registry.execute('/goal ship feature');

        expect(await registry.execute('/goal pause waiting for review')).toBe(true);
        expect(task.goal_state?.status).toBe('paused');
        expect(task.goal_state?.pauseReason).toBe('waiting for review');
        expect(task.task_status).toBe('stopped');

        expect(await registry.execute('/goal resume')).toBe(true);
        expect(task.goal_state?.status).toBe('active');
        expect(task.task_status).toBe('running');
        expect(tui.followRunningTask).toHaveBeenLastCalledWith(task);

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
