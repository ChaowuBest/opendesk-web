import { jest } from '@jest/globals';
import { GlobalHooks } from '../../../main/aikernel/hooks.js';
import { AssistantMessage, ChatContext, UserMessage } from '../../../main/aikernel/messages.js';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';
import { formatConversationForMemoryReview } from '../../../main/aikernel/memory/review.js';

function resetHookRegistry(): void {
    GlobalHooks.beforeFinishTurnHooks = [];
    GlobalHooks.afterFinishTurnHooks = [];
    GlobalHooks.beforeTaskStartHooks = [];
    GlobalHooks.onTaskReviewHooks = [];
    GlobalHooks.onTaskRevertHooks = [];
    GlobalHooks.afterToolcallParseHooks = [];
    GlobalHooks.beforeToolCallHooks = [];
    GlobalHooks.afterToolCallHooks = [];
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

        task.hooks.onTaskReview(async ({ task: receivedTask, startMessageIndex: start_message_index }) => {
            calls.push('task');
            receivedTasks.push(receivedTask);
            startIndexes.push(start_message_index);
        });
        GlobalHooks.onTaskReview(({ task: receivedTask, startMessageIndex: start_message_index }) => {
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

    test('noticeOnTaskReview invokes all registered callbacks without short-circuit', async () => {
        const task = new TaskState(new TaskManagerState());
        const calls: string[] = [];

        task.hooks.onTaskReview(() => {
            calls.push('task');
        });
        GlobalHooks.onTaskReview(() => {
            calls.push('global');
        });

        await task.hooks.noticeOnTaskReview({ task, startMessageIndex: 0 });
        expect(calls).toEqual(['task', 'global']);

        resetHookRegistry();
        const noopTask = new TaskState(new TaskManagerState());
        noopTask.hooks.onTaskReview(() => {
            calls.push('task-again');
        });

        await noopTask.hooks.noticeOnTaskReview({ task: noopTask, startMessageIndex: 0 });
        expect(calls).toEqual(['task', 'global', 'task-again']);
    });

    test('onTaskReview returns a disposer that unregisters the callback', async () => {
        const task = new TaskState(new TaskManagerState());
        const callback = jest.fn();
        const dispose = GlobalHooks.onTaskReview(callback);

        dispose();
        await task.hooks.noticeOnTaskReview({ task, startMessageIndex: 0 });

        expect(callback).not.toHaveBeenCalled();
    });

    test('preserves the earliest review start index across interactions in the same idle window', async () => {
        const task = new TaskState(new TaskManagerState());
        const callback = jest.fn();
        GlobalHooks.onTaskReview(callback);

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
        expect(callback).toHaveBeenCalledWith({ task, startMessageIndex: 0 });
    });

    test('resets the idle window when a new user or assistant message is appended', async () => {
        const task = new TaskState(new TaskManagerState());
        const callback = jest.fn();
        GlobalHooks.onTaskReview(callback);

        task.recordTaskInteraction();
        task.chat_context.appendMessage(new UserMessage('hello'));

        await jest.advanceTimersByTimeAsync(60);
        task.chat_context.appendMessage(new AssistantMessage());

        await jest.advanceTimersByTimeAsync(99);
        expect(callback).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(1);
        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith({ task, startMessageIndex: 0 });

        task.recordTaskInteraction();
        task.chat_context.appendMessage(new UserMessage('hello again'));
        await jest.advanceTimersByTimeAsync(100);
        expect(callback).toHaveBeenCalledTimes(2);
        expect(callback).toHaveBeenLastCalledWith({ task, startMessageIndex: 2 });
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
        GlobalHooks.onTaskReview(callback);

        await task.submitUserMessage('new input');

        expect(processTurnSpy).toHaveBeenCalledTimes(1);
        expect(task.chat_context.messages).toHaveLength(4);
        expect(callback).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(99);
        expect(callback).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(1);
        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith({ task, startMessageIndex: 2 });
    });

    test('review captures real input and output without request-only TailCard state', async () => {
        const manager = new TaskManagerState();
        manager.save = jest.fn();
        manager.publishTaskListUpdate = jest.fn();
        manager.moveTaskToEnd = jest.fn();
        const task = new TaskState(manager);
        task.task_name = 'existing task';
        task.chat_context.appendMessage(new UserMessage('previous input'));
        task.chat_context.appendMessage(new AssistantMessage());
        task.setFrontendTailCardSection('knowledge-mode', 'turn control prompt with /workspace/opaque-source');
        task.markCompacted();
        jest.spyOn(task, 'buildToolsets').mockResolvedValue([]);
        jest.spyOn(task, 'processTaskTurn').mockResolvedValue();
        let transcript = '';
        let receivedStartIndex = -1;
        GlobalHooks.onTaskReview(({ task: receivedTask, startMessageIndex }) => {
            receivedStartIndex = startMessageIndex;
            transcript = formatConversationForMemoryReview(receivedTask, startMessageIndex);
        });

        await task.submitUserMessage('real user input');
        const assistant = task.chat_context.messages.at(-1) as AssistantMessage;
        assistant.appendText('assistant response');

        await jest.advanceTimersByTimeAsync(100);

        expect(receivedStartIndex).toBe(2);
        expect(transcript).not.toContain('turn control prompt');
        expect(transcript).not.toContain('/workspace/opaque-source');
        expect(transcript).toContain('real user input');
        expect(transcript).toContain('assistant response');
    });

    test('continues observing messages after chat_context is replaced', async () => {
        const task = new TaskState(new TaskManagerState());
        const callback = jest.fn();
        GlobalHooks.onTaskReview(callback);

        task.chat_context = new ChatContext();
        task.recordTaskInteraction();
        task.chat_context.appendMessage(new UserMessage('message after replacement'));

        await jest.advanceTimersByTimeAsync(100);

        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith({ task, startMessageIndex: 0 });
    });
});
