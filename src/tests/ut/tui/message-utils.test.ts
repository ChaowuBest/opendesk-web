import { jest } from '@jest/globals';
import { getLastNonInternalUserMessageText } from '../../../main/tui/message-utils';
import { UserMessage } from '../../../main/aikernel/messages';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks';

function createTask(): TaskState {
    const manager = new TaskManagerState();
    manager.save = jest.fn();
    manager.publishTaskListUpdate = jest.fn();
    manager.moveTaskToEnd = jest.fn();
    const task = new TaskState(manager);
    manager.tasks.push(task);
    return task;
}

describe('getLastNonInternalUserMessageText', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('returns the latest non-internal user message and skips scheduler messages', () => {
        const task = createTask();
        task.chat_context.appendMessage(new UserMessage('first visible message'));
        const internal = new UserMessage('internal goal prompt');
        internal.internal = true;
        task.chat_context.appendMessage(internal);
        task.chat_context.appendMessage(new UserMessage('second visible message'));

        expect(getLastNonInternalUserMessageText(task)).toBe('second visible message');
    });

    test('prefers raw text for previous message recall', () => {
        const task = createTask();
        const message = new UserMessage('expanded skill prompt');
        message.rawText = '/skill original input';
        task.chat_context.appendMessage(message);

        expect(getLastNonInternalUserMessageText(task)).toBe('/skill original input');
    });

    test('handles role-based user messages without class prototype', () => {
        const task = createTask();
        task.chat_context.messages.push({
            role: 'user',
            internal: true,
            content: [{ type: 'text', text: 'hidden scheduler prompt' }]
        } as any);
        task.chat_context.messages.push({
            role: 'user',
            content: [{ type: 'text', text: 'restored visible prompt' }]
        } as any);

        expect(getLastNonInternalUserMessageText(task)).toBe('restored visible prompt');
    });
});
