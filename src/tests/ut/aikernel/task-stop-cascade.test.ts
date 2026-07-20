import { jest } from '@jest/globals';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';
import { Setting } from '../../../main/utils/setting.js';

function createTaskTree(parentStatus: TaskState['task_status'] = 'running'): {
    manager: TaskManagerState;
    parent: TaskState;
    child: TaskState;
} {
    const manager = new TaskManagerState();
    manager.save = jest.fn();
    manager.publishTaskListUpdate = jest.fn();
    manager.moveTaskToEnd = jest.fn();

    const parent = new TaskState(manager, null);
    parent.task_id = 'task-parent';
    parent.task_status = parentStatus;

    const child = new TaskState(manager, parent.task_id);
    child.task_id = 'task-child';
    child.task_status = 'running';

    manager.tasks.push(parent, child);
    return { manager, parent, child };
}

describe('TaskState.stop() child task cascade', () => {
    afterEach(() => {
        jest.restoreAllMocks();
        Setting.clearCache();
    });

    test('stops running child tasks when parent is running', () => {
        const { parent, child } = createTaskTree('running');

        parent.stop('system');

        expect(parent.task_status).toBe('stopped');
        expect(child.task_status).toBe('stopped');
    });

    test('stops running child tasks even when parent has already finished', () => {
        const { parent, child } = createTaskTree('stopped');

        parent.stop('system');

        expect(parent.task_status).toBe('stopped');
        expect(child.task_status).toBe('stopped');
    });

    test('allows a normally finished task to start a new user turn', async () => {
        Setting.updateInstanceData({
            default_model: 'mock-model',
            providers: [
                {
                    name: 'mock-provider',
                    provider_type: 'openai',
                    base_url: 'https://mock.local/v1',
                    api_key: 'test-key',
                    no_proxy: true
                }
            ],
            models: [
                {
                    alias: 'mock-model',
                    provider_name: 'mock-provider',
                    model_name: 'mock/model'
                }
            ]
        });
        const manager = new TaskManagerState();
        manager.save = jest.fn();
        manager.publishTaskListUpdate = jest.fn();
        manager.moveTaskToEnd = jest.fn();
        const task = new TaskState(manager, null);
        task.task_status = 'stopped';
        manager.tasks.push(task);
        jest.spyOn(task, 'buildToolsets').mockResolvedValue([]);
        const processSpy = jest.spyOn(task, 'processTaskTurn').mockResolvedValue();

        const result = await task.submitUserMessage('continue');

        expect(result).toEqual({ status: 'ok' });
        expect(task.task_status).toBe('running');
        expect(processSpy).toHaveBeenCalledTimes(1);
    });
});
