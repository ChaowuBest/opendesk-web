import { jest } from '@jest/globals';
import type { AgentDecl, ModeDecl } from '../../../main/aikernel/agents/common.js';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';
import { Setting } from '../../../main/utils/setting.js';

describe('dispatched task names', () => {
    const mode = { id: 'standard' } as ModeDecl;
    const agent = {
        agentId: 'test-agent',
        supportedModes: () => [mode],
        getDefaultMode: () => mode
    } as AgentDecl;
    let manager: TaskManagerState;
    let snapshots: Array<Array<{ name: string | null; pending: boolean }>>;
    let generateName: ReturnType<typeof jest.spyOn>;

    beforeEach(() => {
        Setting.updateInstanceData({
            ...Setting.getInstance().getData(),
            task_config: {
                auto_retry: true,
                generate_taskname: true,
                termination_check: true,
                evidence_card: false
            }
        });
        manager = new TaskManagerState();
        snapshots = [];
        jest.spyOn(manager, 'save').mockImplementation(() => {
            snapshots.push(manager.tasks.map((task) => ({ name: task.task_name, pending: task.name_pending })));
        });
        jest.spyOn(manager, 'publishTaskListUpdate').mockImplementation(() => undefined);
        jest.spyOn(manager, 'moveTaskToEnd').mockImplementation(() => undefined);
        jest.spyOn(manager, 'initHarness').mockImplementation(async (task, workspace) => {
            task.workspace = workspace;
        });
        jest.spyOn(TaskState.prototype, 'buildToolsets').mockResolvedValue([]);
        jest.spyOn(TaskState.prototype, 'rebuildSystemPrompt').mockResolvedValue(undefined);
        jest.spyOn(TaskState.prototype, 'processTaskTurn').mockResolvedValue(undefined);
        jest.spyOn(TaskState.prototype, 'persistLater').mockImplementation(() => undefined);
        generateName = jest.spyOn(TaskState.prototype, 'generateTaskName').mockImplementation(async function (
            this: TaskState
        ) {
            this.task_name = '模型生成的任务名';
        });
    });

    afterEach(() => {
        jest.restoreAllMocks();
        Setting.clearCache();
    });

    test.each([true, false])('keeps the supplied name when automatic naming is %s', async (generateTaskname) => {
        const data = Setting.getInstance().getData();
        Setting.updateInstanceData({
            ...data,
            task_config: { ...data.task_config, generate_taskname: generateTaskname }
        });
        const taskName = '每日🌏AI新闻：研究、产品和开源项目进展汇总';

        const task = await manager.dispatchPromptToAgent(agent, undefined, '请执行以下全局待办事项', {
            workspace: '/workspace',
            taskName
        });

        expect(task.task_name).toBe(taskName);
        expect(task.name_pending).toBe(false);
        expect(snapshots[0]).toEqual([{ name: taskName, pending: false }]);
        expect(generateName).not.toHaveBeenCalled();
        await task.submitUserMessage('补充要求');
        expect(task.task_name).toBe(taskName);
        expect(generateName).not.toHaveBeenCalled();
    });

    test('separate runs can share a name while retaining independent task identities', async () => {
        const options = { workspace: '/workspace', taskName: '每日AI新闻' };

        const first = await manager.dispatchPromptToAgent(agent, undefined, '第一天', options);
        const second = await manager.dispatchPromptToAgent(agent, undefined, '第二天', options);

        expect(first.task_id).not.toBe(second.task_id);
        expect(first.task_name).toBe(options.taskName);
        expect(second.task_name).toBe(options.taskName);
        expect(manager.tasks).toEqual([first, second]);
        expect(generateName).not.toHaveBeenCalled();
    });

    test('omitting the name retains automatic naming for existing callers', async () => {
        const task = await manager.dispatchPromptToAgent(agent, undefined, '普通任务内容', {
            workspace: '/workspace'
        });

        expect(generateName).toHaveBeenCalledTimes(1);
        expect(task.task_name).toBe('模型生成的任务名');
    });

    test('omitting the name retains prompt naming when automatic naming is disabled', async () => {
        const data = Setting.getInstance().getData();
        Setting.updateInstanceData({ ...data, task_config: { ...data.task_config, generate_taskname: false } });
        const prompt = '执行普通后台任务并把处理结果保存为文档，包含详细的变更摘要以及验证步骤';

        const task = await manager.dispatchPromptToAgent(agent, undefined, prompt, { workspace: '/workspace' });

        expect(task.task_name).toBe(prompt.substring(0, 30) + '...');
        expect(generateName).not.toHaveBeenCalled();
    });
});
