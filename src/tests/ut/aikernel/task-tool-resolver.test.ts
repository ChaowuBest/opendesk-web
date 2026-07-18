import { BaseToolset } from '../../../main/aikernel/tool.js';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';

describe('TaskState.buildToolsets()', () => {
    test('filters out toolsets that are initially empty', async () => {
        const manager = new TaskManagerState();
        manager.toolsetProvider = {
            listAvailableToolsets: async () => [new BaseToolset('empty')]
        };
        const task = new TaskState(manager);

        const toolsets = await task.buildToolsets();

        expect(toolsets.some((toolset) => toolset.name === 'empty')).toBe(false);
    });
});
