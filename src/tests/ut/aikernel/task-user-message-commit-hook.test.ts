import { getLocale } from '../../../locale/index.js';
import { jest } from '@jest/globals';
import { AssistantMessage, UserMessage } from '../../../main/aikernel/messages.js';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';

function createSubmitReadyTask(): TaskState {
    const manager = new TaskManagerState();
    manager.save = jest.fn();
    manager.publishTaskListUpdate = jest.fn();
    manager.moveTaskToEnd = jest.fn();
    const task = new TaskState(manager);
    task.task_name = 'existing task';
    task.currentLocale = getLocale();
    manager.tasks.push(task);
    task.markCompacted();
    jest.spyOn(task, 'buildToolsets').mockResolvedValue([]);
    jest.spyOn(task, 'processTaskTurn').mockResolvedValue();
    return task;
}

describe('TaskState onUserMessageCommitted', () => {
    afterEach(() => jest.restoreAllMocks());

    test('fires once after append and before the first matching feedback', async () => {
        const task = createSubmitReadyTask();
        const order: string[] = [];
        let committedId: string | undefined;
        jest.spyOn(task, 'sendSubscriptionFeedback').mockImplementation(async partIndex => {
            const last = task.chat_context.lastMessage();
            expect(last).toBeInstanceOf(UserMessage);
            expect(last?.message_id).toBe(committedId);
            order.push(`feedback:${partIndex}`);
        });

        const result = await task.submitUserMessage('hello', {
            onUserMessageCommitted(messageId) {
                const last = task.chat_context.lastMessage();
                expect(last).toBeInstanceOf(UserMessage);
                expect(last?.message_id).toBe(messageId);
                committedId = messageId;
                order.push('committed');
            }
        });

        expect(result).toEqual({ status: 'ok' });
        expect(committedId).toMatch(/^[0-9a-f-]{36}$/i);
        expect(order[0]).toBe('committed');
        expect(order.filter(value => value === 'committed')).toHaveLength(1);
        expect(order).toContain('feedback:0');
    });

    test('isolates observer failure and preserves feedback plus turn start', async () => {
        const task = createSubmitReadyTask();
        const feedback = jest.spyOn(task, 'sendSubscriptionFeedback').mockResolvedValue();
        const processTurn = jest.spyOn(task, 'processTaskTurn');

        await expect(
            task.submitUserMessage('continue', {
                onUserMessageCommitted() {
                    throw new Error('observer private failure');
                }
            })
        ).resolves.toEqual({ status: 'ok' });

        expect(feedback).toHaveBeenCalledWith(0);
        expect(processTurn).toHaveBeenCalledTimes(1);
        expect(task.chat_context.messages.filter(message => message instanceof UserMessage)).toHaveLength(1);
        expect(task.chat_context.messages.filter(message => message instanceof AssistantMessage)).toHaveLength(1);
    });

    test('does not call the observer when an extension consumes the input before append', async () => {
        const task = createSubmitReadyTask();
        const observer = jest.fn();
        jest.spyOn(task.extensions, 'handleUserMessage').mockResolvedValue({
            status: 'ok',
            supplementId: 'supplement-1'
        });

        await expect(
            task.submitUserMessage('goal supplement', { onUserMessageCommitted: observer })
        ).resolves.toEqual({ status: 'ok', supplementId: 'supplement-1' });

        expect(observer).not.toHaveBeenCalled();
        expect(task.chat_context.messages).toEqual([]);
    });

    test('keeps every existing caller unchanged when the option is absent', async () => {
        const task = createSubmitReadyTask();
        await expect(task.submitUserMessage('legacy caller')).resolves.toEqual({ status: 'ok' });
        expect(task.chat_context.messages).toHaveLength(2);
    });
});
