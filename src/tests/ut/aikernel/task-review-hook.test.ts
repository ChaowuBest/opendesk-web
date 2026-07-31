import { jest } from '@jest/globals';
import { HookRegistry } from '../../../main/aikernel/hooks.js';
import { AssistantMessage, ChatContext, UserMessage } from '../../../main/aikernel/messages.js';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';

function resetHookRegistry(): void {
    HookRegistry.beforeFinishTurnCallbacks = [];
    HookRegistry.afterFinishTurnCallbacks = [];
    HookRegistry.beforeTaskStartCallbacks = [];
    HookRegistry.onTaskReviewCallbacks = [];
    HookRegistry.onTaskRevertCallbacks = [];
    HookRegistry.afterParseToolcallCallbacks = [];
    HookRegistry.beforeToolCallCallbacks = [];
    HookRegistry.afterToolCallCallbacks = [];
}

describe('onTaskReview hook', () => {
    let previousIdleMs: number;

    beforeEach(() => {
        previousIdleMs = TaskState.TASK_REVIEW_IDLE_MS;
        TaskState.TASK_REVIEW_IDLE_MS = 100;
        resetHookRegistry();
        jest.useFakeTimers();
    });

    afterEach(() => {
        TaskState.TASK_REVIEW_IDLE_MS = previousIdleMs;
        resetHookRegistry();
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    test('fires task-level and global callbacks once after the task is idle', async () => {
        const task = new TaskState(new TaskManagerState());
        const calls: string[] = [];
        const receivedTasks: TaskState[] = [];
        const startIndexes: number[] = [];

        task.hooks.onTaskReview(async (receivedTask, start_message_index) => {
            calls.push('task');
            receivedTasks.push(receivedTask);
            startIndexes.push(start_message_index);
        });
        HookRegistry.onTaskReview((receivedTask, start_message_index) => {
            calls.push('global');
            receivedTasks.push(receivedTask);
            startIndexes.push(start_message_index);
        });

        task.recordTaskInteraction();
        task.chat_context.appendMessage(new UserMessage('hello'));

        await jest.advanceTimersByTimeAsync(99);
        expect(calls).toEqual([]);

        await jest.advanceTimersByTimeAsync(1);
        expect(calls).toEqual(['task', 'global']);
        expect(receivedTasks).toEqual([task, task]);
        expect(startIndexes).toEqual([0, 0]);

        await jest.advanceTimersByTimeAsync(200);
        expect(calls).toEqual(['task', 'global']);
    });

    test('noticeTaskReview returns true only when a callback reports work started', async () => {
        const task = new TaskState(new TaskManagerState());
        const calls: string[] = [];

        task.hooks.onTaskReview(() => {
            calls.push('task-noop');
        });
        HookRegistry.onTaskReview(() => {
            calls.push('global-started');
            return true;
        });

        await expect(task.hooks.noticeTaskReview(task, 0)).resolves.toBe(true);
        expect(calls).toEqual(['task-noop', 'global-started']);

        resetHookRegistry();
        const noopTask = new TaskState(new TaskManagerState());
        noopTask.hooks.onTaskReview(() => {
            calls.push('task-noop-again');
        });

        await expect(noopTask.hooks.noticeTaskReview(noopTask, 0)).resolves.toBe(false);
    });

    test('preserves the earliest review start index across interactions in the same idle window', async () => {
        const task = new TaskState(new TaskManagerState());
        const callback = jest.fn();
        HookRegistry.onTaskReview(callback);

        task.recordTaskInteraction();
        task.chat_context.appendMessage(new UserMessage('message A'));
        const assistantA = new AssistantMessage();
        assistantA.appendText('answer A');
        task.chat_context.appendMessage(assistantA);

        await jest.advanceTimersByTimeAsync(60);

        task.recordTaskInteraction();
        task.chat_context.appendMessage(new UserMessage('message B'));

        await jest.advanceTimersByTimeAsync(99);
        expect(callback).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(1);
        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith(task, 0);
    });

    test('resets the idle window when a new user or assistant message is appended', async () => {
        const task = new TaskState(new TaskManagerState());
        const callback = jest.fn();
        HookRegistry.onTaskReview(callback);

        task.recordTaskInteraction();
        task.chat_context.appendMessage(new UserMessage('hello'));

        await jest.advanceTimersByTimeAsync(60);
        task.chat_context.appendMessage(new AssistantMessage());

        await jest.advanceTimersByTimeAsync(99);
        expect(callback).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(1);
        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith(task, 0);

        task.recordTaskInteraction();
        task.chat_context.appendMessage(new UserMessage('hello again'));
        await jest.advanceTimersByTimeAsync(100);
        expect(callback).toHaveBeenCalledTimes(2);
        expect(callback).toHaveBeenLastCalledWith(task, 2);
    });

    test('submitUserMessage activates review scheduling for an existing task', async () => {
        const manager = new TaskManagerState();
        manager.save = jest.fn();
        manager.publishTaskListUpdate = jest.fn();

        const task = new TaskState(manager);
        task.task_name = 'existing task';
        task.chat_context.appendMessage(new UserMessage('previous input'));
        task.chat_context.appendMessage(new AssistantMessage());
        manager.tasks.push(task);

        task.markCompacted();
        jest.spyOn(task, 'buildToolsets').mockResolvedValue([]);
        const processTurnSpy = jest.spyOn(task, 'processTaskTurn').mockResolvedValue();
        const callback = jest.fn();
        HookRegistry.onTaskReview(callback);

        await task.submitUserMessage('new input');

        expect(processTurnSpy).toHaveBeenCalledTimes(1);
        expect(task.chat_context.messages).toHaveLength(4);
        expect(callback).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(99);
        expect(callback).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(1);
        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith(task, 2);
    });

    test('continues observing messages after chat_context is replaced', async () => {
        const task = new TaskState(new TaskManagerState());
        const callback = jest.fn();
        HookRegistry.onTaskReview(callback);

        task.chat_context = new ChatContext();
        task.recordTaskInteraction();
        task.chat_context.appendMessage(new UserMessage('message after replacement'));

        await jest.advanceTimersByTimeAsync(100);

        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith(task, 0);
    });
});
