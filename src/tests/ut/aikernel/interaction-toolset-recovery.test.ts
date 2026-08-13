import { jest } from '@jest/globals';
import { BaseTool, BaseToolset, ToolResult } from '../../../main/aikernel/tool.js';
import { z } from 'zod';

function createMockInteractionToolset(): BaseToolset {
    const toolset = new BaseToolset('interaction');

    const askUserTool = new BaseTool(
        'askUser',
        '向用户提出多选问题以收集信息、澄清需求或让用户在多个方案中做出选择。',
        z.object({
            questions: z.array(
                z.object({
                    question: z.string(),
                    header: z.string(),
                    options: z.array(
                        z.object({
                            label: z.string(),
                            description: z.string()
                        })
                    ),
                    multiple: z.boolean().default(false)
                })
            )
        })
    );
    askUserTool.setUniversalExecutor(async (_args: any, _result: ToolResult) => {
        // no-op
    });
    toolset.addTool(askUserTool);

    const exitPlanModeTool = new BaseTool('exitPlanMode', '退出计划模式。', z.object({}));
    exitPlanModeTool.setUniversalExecutor(async (_args: any, _result: ToolResult) => {
        // no-op
    });
    toolset.addTool(exitPlanModeTool);

    return toolset;
}

const mockInteractionToolset = createMockInteractionToolset();

// 使用共享的 mock 函数，确保 getPlatform 返回同一个 mock 对象
const sharedInitPlatformHarness = jest.fn().mockImplementation((task: any) => {
    task.interactionToolset = mockInteractionToolset;
});

const mockPlatform = {
    initPlatformHarness: sharedInitPlatformHarness
};

jest.unstable_mockModule('../../../platforms/base.js', () => ({
    getPlatform: () => mockPlatform,
    setPlatform: () => {},
    AbstractPlatform: class {}
}));

jest.unstable_mockModule('../../../main/aikernel/planning/tools.js', () => ({
    createMainPlanningToolset: () => new BaseToolset('planning'),
    createSubTaskPlanningToolset: () => new BaseToolset('planning'),
    startSubTask: jest.fn()
}));

beforeEach(() => {
    jest.restoreAllMocks();
    sharedInitPlatformHarness.mockClear();
});

describe('interactionToolset 恢复', () => {
    test('从磁盘恢复的主任务 buildToolsets 时应自动注入 interactionToolset', async () => {
        const { TaskState } = await import('../../../main/aikernel/states/tasks.js');
        const { TaskManagerState } = await import('../../../main/aikernel/task/manager.js');

        const manager = new TaskManagerState();
        manager.save = jest.fn();
        manager.publishTaskListUpdate = jest.fn();
        manager.moveTaskToEnd = jest.fn();

        const task = new TaskState(manager, null);
        task.task_id = 'test-recovery-task';
        task.task_status = 'running';
        task.model = 'test-model';
        task.parent_id = null;
        task.interactionToolset = null;

        const toolsets = await task.buildToolsets();

        expect(sharedInitPlatformHarness).toHaveBeenCalledWith(task);
        expect(task.interactionToolset).not.toBeNull();

        const allToolNames = toolsets.flatMap((ts) => Array.from(ts.tools.keys()));
        expect(allToolNames).toContain('askUser');
        expect(allToolNames).toContain('exitPlanMode');
    });

    test('已有 interactionToolset 的主任务不会重复调用 initPlatformHarness', async () => {
        const { TaskState } = await import('../../../main/aikernel/states/tasks.js');
        const { TaskManagerState } = await import('../../../main/aikernel/task/manager.js');

        const manager = new TaskManagerState();
        manager.save = jest.fn();
        manager.publishTaskListUpdate = jest.fn();
        manager.moveTaskToEnd = jest.fn();

        const task = new TaskState(manager, null);
        task.task_id = 'test-existing-task';
        task.task_status = 'running';
        task.model = 'test-model';
        task.parent_id = null;
        task.interactionToolset = mockInteractionToolset;

        await task.buildToolsets();

        expect(sharedInitPlatformHarness).not.toHaveBeenCalled();
    });

    test('子任务不需要 interactionToolset', async () => {
        const { TaskState } = await import('../../../main/aikernel/states/tasks.js');
        const { TaskManagerState } = await import('../../../main/aikernel/task/manager.js');

        const manager = new TaskManagerState();
        manager.save = jest.fn();
        manager.publishTaskListUpdate = jest.fn();
        manager.moveTaskToEnd = jest.fn();

        const task = new TaskState(manager, null);
        task.task_id = 'test-subtask';
        task.task_status = 'running';
        task.model = 'test-model';
        task.parent_id = 'parent-task-id';
        task.interactionToolset = null;

        await task.buildToolsets();

        expect(sharedInitPlatformHarness).not.toHaveBeenCalled();
    });

    test('initPlatformHarness 失败时不应阻断 buildToolsets', async () => {
        const { TaskState } = await import('../../../main/aikernel/states/tasks.js');
        const { TaskManagerState } = await import('../../../main/aikernel/task/manager.js');

        const manager = new TaskManagerState();
        manager.save = jest.fn();
        manager.publishTaskListUpdate = jest.fn();
        manager.moveTaskToEnd = jest.fn();

        const task = new TaskState(manager, null);
        task.task_id = 'test-error-task';
        task.task_status = 'running';
        task.model = 'test-model';
        task.parent_id = null;
        task.interactionToolset = null;

        // 让 initPlatformHarness 抛错
        sharedInitPlatformHarness.mockRejectedValueOnce(new Error('platform not available'));

        const toolsets = await task.buildToolsets();
        expect(Array.isArray(toolsets)).toBe(true);
    });
});
