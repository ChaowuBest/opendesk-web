import { jest } from '@jest/globals';
import { LLM } from '../../../main/aikernel/llm.js';
import { AssistantMessage, TextMessagePart, UserMessage } from '../../../main/aikernel/messages.js';
import { checkTermination } from '../../../main/aikernel/termination.js';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';

describe('task model routing', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('generateTaskName uses task model instead of default model', async () => {
        const ask = jest.spyOn(LLM, 'ask').mockResolvedValue('任务名');
        const task = new TaskState(new TaskManagerState());
        task.model = 'mock-b';

        await task.generateTaskName('hello');

        expect(ask).toHaveBeenCalledWith(expect.stringContaining('hello'), 'mock-b', { reasoningEffort: 'none' });
        expect(task.task_name).toBe('任务名');
    });

    test('checkTermination uses task model instead of default model', async () => {
        const ask = jest.spyOn(LLM, 'ask').mockResolvedValue('finished');
        const task = new TaskState(new TaskManagerState());
        task.model = 'mock-b';
        task.chat_context.appendMessage(new UserMessage('hello'));
        task.chat_context.appendMessage(new AssistantMessage([new TextMessagePart('done.')]));

        const result = await checkTermination(task);

        expect(result).toBe('finished');
        expect(ask).toHaveBeenCalledWith(expect.stringContaining('hello'), 'mock-b', { reasoningEffort: 'none' });
    });
});
