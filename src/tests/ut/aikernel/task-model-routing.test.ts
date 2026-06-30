import { jest } from '@jest/globals';
import { LLM } from '../../../main/aikernel/llm.js';
import { AssistantMessage, TextMessagePart, UserMessage } from '../../../main/aikernel/messages.js';
import { checkTermination } from '../../../main/aikernel/termination.js';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';
import { Setting } from '../../../main/utils/setting.js';

function configureModels(models: string[] = ['mock-a', 'mock-b'], defaultModel = 'mock-a'): void {
    Setting.updateInstanceData({
        default_model: defaultModel,
        providers: [
            {
                name: 'mock-provider',
                provider_type: 'openai',
                base_url: 'https://mock.local/v1',
                api_key: 'test-key',
                no_proxy: true
            }
        ],
        models: models.map((alias) => ({
            alias,
            provider_name: 'mock-provider',
            model_name: `mock/${alias}`
        }))
    });
}

describe('task model routing', () => {
    beforeEach(() => {
        configureModels();
    });

    afterEach(() => {
        jest.restoreAllMocks();
        Setting.clearCache();
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

    test('invalid task model falls back to global default model', async () => {
        configureModels(['mock-a'], 'mock-a');
        const ask = jest.spyOn(LLM, 'ask').mockResolvedValue('任务名');
        const manager = new TaskManagerState();
        manager.save = jest.fn();
        const task = new TaskState(manager);
        task.model = 'deleted-model';
        manager.tasks.push(task);

        await task.generateTaskName('hello');

        expect(task.model).toBeUndefined();
        expect(manager.save).toHaveBeenCalledTimes(1);
        expect(ask).toHaveBeenCalledWith(expect.stringContaining('hello'), undefined, { reasoningEffort: 'none' });
        expect(task.task_name).toBe('任务名');
    });

    test('createTask ignores model aliases that are not in the chat model list', () => {
        configureModels(['mock-a'], 'mock-a');
        const manager = new TaskManagerState();
        manager.save = jest.fn();
        manager.publishTaskListUpdate = jest.fn();

        const task = manager.createTask('deleted-model');

        expect(task.model).toBeUndefined();
        expect(manager.tasks).toContain(task);
    });

    test('createTask assigns an explicit task name before first persistence', () => {
        const manager = new TaskManagerState();
        manager.save = jest.fn();
        manager.publishTaskListUpdate = jest.fn();

        const task = manager.createTask(undefined, { taskName: '指定任务名' });

        expect(task.task_name).toBe('指定任务名');
        expect(manager.save).toHaveBeenCalledTimes(1);
        expect(manager.publishTaskListUpdate).toHaveBeenCalledTimes(1);
    });
});
