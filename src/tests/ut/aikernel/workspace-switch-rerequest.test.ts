import { jest } from '@jest/globals';
import type { ModeDecl } from '../../../main/aikernel/agents/common';

// 测试链路（replaceTaskHarnessForWorkspace → buildSystemPrompt → SkillRegistry →
// SoulRegistry）会连带真实加载 logger 并触发文件 transport 懒激活，依赖
// Node 全局定时器；按项目惯例整体 mock logger，避免测试触碰真实日志落盘
jest.unstable_mockModule('../../../main/utils/logger.js', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    // ESM loader 对命名导入严格校验：import 链会连带 aikernel/messages.ts
    // （import { logger, getDebugMode }）等模块，mock 必须覆盖全部被引用导出
    getDebugMode: jest.fn().mockReturnValue(false),
    setDebugMode: jest.fn(),
    LogStream: class {}
}));

const { HarnessContext } = await import('../../../main/aikernel/security/harness.js');
const { MAIN_AGENT_STANDARD_MODE } = await import('../../../main/aikernel/agents/main/modes/standard.js');
const { AgentRegistry } = await import('../../../main/aikernel/agents/registry.js');
const { TaskManagerState, TaskState } = await import('../../../main/aikernel/states/tasks.js');
const { replaceTaskHarnessForWorkspace } = await import('../../../main/aikernel/task/mode.js');

const taskAgentRef = AgentRegistry.getMainAgent();

function createRecordingProvider() {
    const responses: Array<{ enforcer: unknown; taskIds?: string[] }> = [];
    const prompts: Array<{ resourcePath: string; resolve: (value: any) => void }> = [];
    return {
        provider: {
            prompt: (requests: any[]) =>
                new Promise((resolve) => {
                    prompts.push({ resourcePath: requests[0].resourcePath, resolve });
                }),
            notifyPermissionRulesChanged: async (enforcer: unknown, taskIds?: string[]) => {
                responses.push({ enforcer, taskIds });
            }
        },
        responses,
        prompts
    };
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('workspace switch re-checks queued permission prompts', () => {
    // 权限引擎按 path.resolve 后的模式匹配请求路径：workspace 必须是绝对路径，
    // 否则 macOS/Linux 上 path.resolve 会把它拼到 cwd 下，工作空间内路径
    // 将全部落到隐式 ask。enforcer 是纯模式匹配，合成路径无需真实存在
    const OLD_WORKSPACE = '/opendesk-test-old-workspace';
    const OTHER_WORKSPACE = '/opendesk-test-other-workspace';

    test('replacing the harness for a new workspace notifies the provider with the task scope', async () => {
        const manager = new TaskManagerState();
        const task = new TaskState(manager);
        task.task_id = 'ws-task-1';
        const { provider, responses, prompts } = createRecordingProvider();
        task.harnessContext = await HarnessContext.createForMode(OLD_WORKSPACE, MAIN_AGENT_STANDARD_MODE);
        task.harnessContext.permissionPrompt = provider;
        task.workspace = OLD_WORKSPACE;
        task.activeModeId = MAIN_AGENT_STANDARD_MODE.id;

        // 旧工作空间之外的路径处于 ask 等待中
        const pending = provider.prompt([
            { resourceType: 'file', action: 'read', resourcePath: `${OTHER_WORKSPACE}/file.txt` }
        ]);
        expect(prompts).toHaveLength(1);

        await replaceTaskHarnessForWorkspace(task, OTHER_WORKSPACE, (taskAgent) =>
            taskAgent === taskAgentRef ? MAIN_AGENT_STANDARD_MODE : task.getAgentMode()
        );

        // 新工作空间使该路径变为 allow：provider 应收到新 enforcer 的重评通知
        expect(responses).toHaveLength(1);
        expect(responses[0].taskIds).toEqual([task.task_id]);
        await expect(
            task.harnessContext.permission!.check({
                resourceType: 'file',
                action: 'read',
                resourcePath: `${OTHER_WORKSPACE}/file.txt`
            })
        ).resolves.toMatchObject({ effect: 'allow' });

        // provider 收到通知后放通等待中的请求
        expect(prompts[0].resolve).toBeDefined();
        prompts[0].resolve({ decision: 'allow', rememberScope: 'none' });
        await expect(pending).resolves.toMatchObject({ decision: 'allow' });
        expect(task.activeModeId).toBe(MAIN_AGENT_STANDARD_MODE.id);
        expect(task.workspace).toBe(OTHER_WORKSPACE);
    });

    test('switching workspace re-runs onEnterMode so plan mode creates .plan in the new workspace', async () => {
        const entered: string[] = [];
        const modeWithHook: ModeDecl = {
            ...MAIN_AGENT_STANDARD_MODE,
            id: 'hooked-standard',
            onEnterMode: (workspace: string) => {
                entered.push(workspace);
            }
        };
        const manager = new TaskManagerState();
        const task = new TaskState(manager);
        task.task_id = 'ws-task-hook';
        const { provider } = createRecordingProvider();
        task.harnessContext = await HarnessContext.createForMode(OLD_WORKSPACE, modeWithHook);
        task.harnessContext.permissionPrompt = provider;
        task.workspace = OLD_WORKSPACE;
        task.activeModeId = modeWithHook.id;

        await replaceTaskHarnessForWorkspace(task, OTHER_WORKSPACE, () => modeWithHook);

        expect(entered).toEqual([OTHER_WORKSPACE]);
        expect(task.workspace).toBe(OTHER_WORKSPACE);
    });

    test('a failing system prompt rebuild propagates and keeps the old harness', async () => {
        const manager = new TaskManagerState();
        const task = new TaskState(manager);
        task.task_id = 'ws-task-2';
        const { provider } = createRecordingProvider();
        task.harnessContext = await HarnessContext.createForMode(OLD_WORKSPACE, MAIN_AGENT_STANDARD_MODE);
        task.harnessContext.permissionPrompt = provider;
        task.workspace = OLD_WORKSPACE;
        task.activeModeId = MAIN_AGENT_STANDARD_MODE.id;
        const previousContext = task.harnessContext;
        jest.spyOn(task, 'buildSystemPrompt').mockRejectedValueOnce(new Error('prompt generation failed'));

        await expect(
            replaceTaskHarnessForWorkspace(task, OTHER_WORKSPACE, (taskAgent) =>
                taskAgent === AgentRegistry.getMainAgent() ? MAIN_AGENT_STANDARD_MODE : taskAgent.getDefaultMode()
            )
        ).rejects.toThrow('prompt generation failed');
        expect(task.harnessContext).toBe(previousContext);
        expect(task.activeModeId).toBe(MAIN_AGENT_STANDARD_MODE.id);
        expect(task.workspace).toBe(OLD_WORKSPACE);
    });
});
