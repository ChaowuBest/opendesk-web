import { Setting } from '../../../../main/utils/setting';
import { TaskSwitcher } from '../../../../main/tui/components/taskswitcher';
import type { TaskState } from '../../../../main/aikernel/states/tasks';

function createSwitcher(developerMode: boolean): TaskSwitcher {
    Setting.clearCache();
    Setting.updateInstanceData({
        debug: {
            developer_mode: developerMode,
            experimental_feature: false
        }
    });

    const visibleTask = {
        task_id: 'visible-task',
        task_name: 'Visible task',
        task_status: 'stopped'
    } as TaskState;
    const internalTask = {
        task_id: 'internal-task',
        task_name: 'Internal task',
        task_status: 'stopped',
        internal: true
    } as TaskState;

    return new TaskSwitcher({
        taskManagerState: {
            tasks: [visibleTask, internalTask]
        }
    } as any);
}

describe('TaskSwitcher', () => {
    afterEach(() => {
        Setting.clearCache();
    });

    test('hides internal tasks when developer mode is disabled', () => {
        const switcher = createSwitcher(false);

        expect(switcher.getTasks().map((task) => task.task_id)).toEqual(['visible-task']);
    });

    test('shows internal tasks when developer mode is enabled', () => {
        const switcher = createSwitcher(true);

        expect(switcher.getTasks().map((task) => task.task_id)).toEqual(['visible-task', 'internal-task']);
    });
});
