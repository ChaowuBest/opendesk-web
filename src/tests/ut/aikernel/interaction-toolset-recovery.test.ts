import { jest } from '@jest/globals';
import { BaseTool, BaseToolset, InteractiveToolset, ToolResult } from '../../../main/aikernel/tool.js';
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
        }),
        'tools.askUser.name'
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

const sharedCreateInteractionToolset = jest.fn().mockReturnValue(createMockInteractionToolset());

jest.unstable_mockModule('../../../platforms/base.js', () => ({
    getPlatform: () => ({
        getName: () => 'test',
        initPlatformHarness: jest.fn(),
        createInteractionToolset: sharedCreateInteractionToolset
    }),
    setPlatform: () => {},
    AbstractPlatform: class {}
}));

jest.unstable_mockModule('../../../main/aikernel/planning/tools.js', () => ({
    createMainPlanningToolset: () => new BaseToolset('planning'),
    createSubTaskPlanningToolset: () => new BaseToolset('planning'),
    startSubTask: jest.fn()
}));

function toolNames(toolsets: BaseToolset[]): string[] {
    return toolsets.flatMap((ts) => Array.from(ts.tools.keys()));
}

async function makeTask(parentId: string | null) {
    const { TaskState } = await import('../../../main/aikernel/states/tasks.js');
    const { TaskManagerState } = await import('../../../main/aikernel/task/manager.js');
    const manager = new TaskManagerState();
    manager.save = jest.fn();
    manager.publishTaskListUpdate = jest.fn();
    manager.moveTaskToEnd = jest.fn();
    const task = new TaskState(manager, null);
    task.task_id = 'test-task';
    task.task_status = 'running';
    task.model = 'test-model';
    task.parent_id = parentId;
    return task;
}

async function makeTaskWithMode(modeId: string) {
    const task = await makeTask(null);
    task.activeModeId = modeId;
    return task;
}

/** 用真实 AskUserTool / ExitPlanModeTool 构建交互工具集，使 isAvailable 逻辑真正生效。 */
async function makeRealInteractionToolset(askProvider?: unknown, exitProvider?: unknown) {
    const { createInteractionToolset } = await import('../../../main/aikernel/interaction/tools.js');
    return createInteractionToolset(
        (askProvider ?? { cancelCurrent: jest.fn() }) as any,
        (exitProvider ?? { cancelCurrent: jest.fn() }) as any
    );
}

describe('交互工具集挂载语义（interactive 决定）', () => {
    test('interactive 时挂载交互工具集', async () => {
        const { buildToolsetsForTask } = await import('../../../main/aikernel/task/tool-resolver.js');
        const task = await makeTask(null);
        const interaction = createMockInteractionToolset();

        const toolsets = await buildToolsetsForTask(task, interaction);

        expect(toolNames(toolsets)).toContain('askUser');
        expect(toolNames(toolsets)).toContain('exitPlanMode');
    });

    test('非 interactive 时不挂载交互工具集', async () => {
        const { buildToolsetsForTask } = await import('../../../main/aikernel/task/tool-resolver.js');
        const task = await makeTask(null);

        const toolsets = await buildToolsetsForTask(task, null);

        expect(toolNames(toolsets)).not.toContain('askUser');
        expect(toolNames(toolsets)).not.toContain('exitPlanMode');
    });

    test('entryToolset 始终挂载（无论 interactive）', async () => {
        const { buildToolsetsForTask } = await import('../../../main/aikernel/task/tool-resolver.js');
        const task = await makeTask(null);
        task.entryToolset = createMockInteractionToolset();

        const toolsets = await buildToolsetsForTask(task, null);

        expect(toolNames(toolsets)).toContain('askUser');
        expect(toolNames(toolsets)).toContain('exitPlanMode');
    });

    test('disabledTools 通用过滤机制（保留）', async () => {
        const { buildToolsetsForTask } = await import('../../../main/aikernel/task/tool-resolver.js');
        const task = await makeTask(null);
        const interaction = createMockInteractionToolset();
        task.disabledTools = ['exitPlanMode'];

        const toolsets = await buildToolsetsForTask(task, interaction);

        expect(toolNames(toolsets)).toContain('askUser');
        expect(toolNames(toolsets)).not.toContain('exitPlanMode');
    });

    test('interactive 且 interactionToolset 为空时从 platform 懒注入', async () => {
        const { TaskState } = await import('../../../main/aikernel/states/tasks.js');
        const { TaskManagerState } = await import('../../../main/aikernel/task/manager.js');
        const manager = new TaskManagerState();
        manager.save = jest.fn();
        manager.publishTaskListUpdate = jest.fn();
        manager.moveTaskToEnd = jest.fn();
        const task = new TaskState(manager, null);
        task.task_id = 'test-lazy-inject';
        task.task_status = 'running';
        task.model = 'test-model';
        task.parent_id = null;
        task.interactionToolset = null;
        (task as any)._currentTurnInteractive = true;

        sharedCreateInteractionToolset.mockClear();

        const toolsets = await task.buildToolsets();

        expect(sharedCreateInteractionToolset).toHaveBeenCalledWith(task);
        expect(toolNames(toolsets)).toContain('askUser');
        expect(task.interactionToolset).not.toBeNull();
    });
});

describe('cancelInteractionPrompts', () => {
    test('以正确的 this 绑定调用工具的 cancelCurrent（不抛 TypeError）', async () => {
        const { AskUserTool } = await import('../../../main/aikernel/interaction/tools.js');
        const task = await makeTask(null);

        const provider = { cancelCurrent: jest.fn() };
        const tool = new AskUserTool();
        tool.setProvider(provider as any);

        const toolset = new InteractiveToolset('interaction');
        toolset.addTool(tool);
        task.interactionToolset = toolset;

        expect(() => task.cancelInteractionPrompts()).not.toThrow();
        expect(provider.cancelCurrent).toHaveBeenCalledTimes(1);
    });
});

describe('交互工具挂载场景（standard / solo / unlimited / plan）', () => {
    const getBuilder = async () => {
        const { buildToolsetsForTask } = await import('../../../main/aikernel/task/tool-resolver.js');
        return buildToolsetsForTask;
    };

    test('standard 模式：挂载 askUser，但不挂载 exitPlanMode', async () => {
        const buildToolsetsForTask = await getBuilder();
        const task = await makeTaskWithMode('standard');
        const interaction = await makeRealInteractionToolset();

        const toolsets = await buildToolsetsForTask(task, interaction);

        expect(toolNames(toolsets)).toContain('askUser');
        expect(toolNames(toolsets)).not.toContain('exitPlanMode');
    });

    test('readonly 模式：挂载 askUser，但不挂载 exitPlanMode', async () => {
        const buildToolsetsForTask = await getBuilder();
        const task = await makeTaskWithMode('readonly');
        const interaction = await makeRealInteractionToolset();

        const toolsets = await buildToolsetsForTask(task, interaction);

        expect(toolNames(toolsets)).toContain('askUser');
        expect(toolNames(toolsets)).not.toContain('exitPlanMode');
    });

    test('plan 模式：挂载 askUser 和 exitPlanMode', async () => {
        const buildToolsetsForTask = await getBuilder();
        const task = await makeTaskWithMode('plan');
        const interaction = await makeRealInteractionToolset();

        const toolsets = await buildToolsetsForTask(task, interaction);

        expect(toolNames(toolsets)).toContain('askUser');
        expect(toolNames(toolsets)).toContain('exitPlanMode');
    });

    test.each(['solo', 'unlimited'])('%s 模式：不挂载 askUser / exitPlanMode', async (modeId) => {
        const buildToolsetsForTask = await getBuilder();
        const task = await makeTaskWithMode(modeId);
        const interaction = await makeRealInteractionToolset();

        const toolsets = await buildToolsetsForTask(task, interaction);

        expect(toolNames(toolsets)).not.toContain('askUser');
        expect(toolNames(toolsets)).not.toContain('exitPlanMode');
    });

    test('solo → standard 切换：askUser 重新挂载（过滤不污染原始工具集）', async () => {
        const buildToolsetsForTask = await getBuilder();
        const task = await makeTaskWithMode('solo');
        const interaction = await makeRealInteractionToolset();

        // solo 模式先 build 一次，askUser 被 isAvailable 过滤
        const soloToolsets = await buildToolsetsForTask(task, interaction);
        expect(toolNames(soloToolsets)).not.toContain('askUser');
        // 原始交互工具集未被就地删除
        expect(Array.from(interaction.tools.keys())).toEqual(expect.arrayContaining(['askUser', 'exitPlanMode']));

        // 切到 standard，重新 build
        task.activeModeId = 'standard';
        const stdToolsets = await buildToolsetsForTask(task, interaction);
        expect(toolNames(stdToolsets)).toContain('askUser');
    });

    test('非 interactive turn（agentoffice / channel 入口）：不挂载交互工具', async () => {
        const task = await makeTaskWithMode('standard');
        task.interactionToolset = await makeRealInteractionToolset();
        (task as any)._currentTurnInteractive = false;

        const toolsets = await task.buildToolsets();

        expect(toolNames(toolsets)).not.toContain('askUser');
        expect(toolNames(toolsets)).not.toContain('exitPlanMode');
    });

    test('老任务（无 activeModeId/agentId、未注入 interactionToolset）interactive turn 应挂载 askUser', async () => {
        const task = await makeTask(null);
        // 模拟磁盘恢复的老任务：旧版本创建，JSON 中无 activeModeId/agentId，
        // 运行时 interactionToolset 不持久化为 null，依赖 buildToolsets 的 platform fallback
        task.agentId = undefined;
        task.activeModeId = undefined as any;
        task.interactionToolset = null;
        (task as any)._currentTurnInteractive = true;

        const toolsets = await task.buildToolsets();

        expect(toolNames(toolsets)).toContain('askUser');
        expect(toolNames(toolsets)).toContain('exitPlanMode');
    });

    test('standard → solo 切换：交互工具从 chat_context 移除并取消待处理提示', async () => {
        const askProvider = { cancelCurrent: jest.fn() };
        const exitProvider = { cancelCurrent: jest.fn() };
        const task = await makeTaskWithMode('standard');
        task.interactionToolset = await makeRealInteractionToolset(askProvider, exitProvider);
        (task as any)._currentTurnInteractive = true;

        // standard 模式挂载交互工具
        await task.refreshBaseToolsets();
        expect(task.chat_context.getTool('askUser')).toBeDefined();

        // 切到 solo：refreshBaseToolsets 重建（askUser 被过滤），cancelInteractionPrompts 取消 pending
        task.activeModeId = 'solo';
        await task.refreshBaseToolsets();
        task.cancelInteractionPrompts();

        expect(task.chat_context.getTool('askUser')).toBeUndefined();
        expect(askProvider.cancelCurrent).toHaveBeenCalledTimes(1);
        expect(exitProvider.cancelCurrent).toHaveBeenCalledTimes(1);
    });
});

describe('手动停止/中断任务时自动取消交互提示（askUser / exitPlanMode）', () => {
    async function makeStoppingTask() {
        const task = await makeTask(null);
        const askProvider = { cancelCurrent: jest.fn() };
        const exitProvider = { cancelCurrent: jest.fn() };
        task.interactionToolset = await makeRealInteractionToolset(askProvider, exitProvider);
        return { task, askProvider, exitProvider };
    }

    test('stop() 取消 askUser / exitPlanMode 交互提示', async () => {
        const { task, askProvider, exitProvider } = await makeStoppingTask();
        task.stop('user');
        expect(askProvider.cancelCurrent).toHaveBeenCalledTimes(1);
        expect(exitProvider.cancelCurrent).toHaveBeenCalledTimes(1);
    });

    test('interruptForNewMessage() 取消交互提示', async () => {
        const { task, askProvider, exitProvider } = await makeStoppingTask();
        task.interruptForNewMessage();
        expect(askProvider.cancelCurrent).toHaveBeenCalledTimes(1);
        expect(exitProvider.cancelCurrent).toHaveBeenCalledTimes(1);
    });

    test('interruptRunningTurn() 取消交互提示（goal 停止/清除路径）', async () => {
        const { task, askProvider, exitProvider } = await makeStoppingTask();
        await task.interruptRunningTurn({
            reason: 'goal_pause',
            stopRunningTools: true,
            cancelPermissionPrompts: true,
            userInitiated: true,
            skipFinishHooks: true
        });
        expect(askProvider.cancelCurrent).toHaveBeenCalledTimes(1);
        expect(exitProvider.cancelCurrent).toHaveBeenCalledTimes(1);
    });
});
