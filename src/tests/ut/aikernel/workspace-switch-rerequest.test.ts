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
const { replaceTaskHarnessForWorkspace, updateTaskWorkspace } = await import('../../../main/aikernel/task/mode.js');

const taskAgentRef = AgentRegistry.getMainAgent();

// 测试工作区根：Windows 上必须是带盘符的绝对路径（裸 /root 会被 path.resolve
// 补成 "当前盘:/root"，与无盘符的请求路径形态不一致），POSIX 上以 / 为根
const TEST_WORKSPACE_ROOT = process.platform === 'win32' ? 'C:/opendesk-test-ws' : '';

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
    // 权限引擎按 path.resolve 后的模式匹配请求路径：workspace 必须是带盘符的
    // 绝对路径（Windows 上 path.resolve 会给裸根路径补当前盘符，导致规则模式
    // 与请求路径形态不一致而全部落到隐式 ask；POSIX 上也会拼到 cwd 下）。
    // enforcer 是纯模式匹配，合成路径无需真实存在
    const OLD_WORKSPACE = `${TEST_WORKSPACE_ROOT}/opendesk-test-old-workspace`;
    const OTHER_WORKSPACE = `${TEST_WORKSPACE_ROOT}/opendesk-test-other-workspace`;

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

describe('shared task workspace operation', () => {
    const standard: ModeDecl = {
        ...MAIN_AGENT_STANDARD_MODE,
        id: 'workspace-standard',
        onEnterMode: undefined
    };
    const selected: ModeDecl = { ...standard, id: 'workspace-selected' };
    const worker: ModeDecl = { ...standard, id: 'workspace-worker' };
    const mainAgent = {
        agentId: 'workspace-main',
        supportedModes: () => [standard, selected],
        getDefaultMode: () => standard
    } as ReturnType<typeof AgentRegistry.getMainAgent>;

    function fixture(options: { customAgent?: boolean; existingProvider?: boolean } = {}) {
        const calls: string[] = [];
        const task = new TaskState(new TaskManagerState());
        task.task_id = 'workspace-operation';
        task.workspace = '/old';
        task.harnessContext = new HarnessContext();
        task.harnessContext.workspace = '/old';
        const environment = { PRIVATE_TASK_ENV: 'retained' };
        task.harnessContext.environ = environment;
        const executionHost = {
            type: 'node' as const,
            nodeId: 'remote-host',
            capabilities: { nodeId: 'remote-host', commands: [], shells: [] }
        };
        task.harnessContext.executionHost = executionHost;
        const provider = createRecordingProvider().provider;
        if (options.existingProvider) task.harnessContext.permissionPrompt = provider;
        const createProvider = jest.fn(() => provider);
        const agent = options.customAgent
            ? ({
                  agentId: 'workspace-worker',
                  supportedModes: () => [worker],
                  getDefaultMode: () => worker
              } as typeof mainAgent)
            : mainAgent;
        jest.spyOn(AgentRegistry, 'getMainAgent').mockReturnValue(mainAgent);
        jest.spyOn(task, 'getAgent').mockReturnValue(agent);
        jest.spyOn(task, 'getAgentMode').mockReturnValue(worker);
        const build = jest.spyOn(task, 'buildSystemPrompt').mockImplementation(async () => {
            calls.push('prompt');
            return 'workspace operation prompt';
        });
        jest.spyOn(task, 'installBuiltSystemPrompt').mockImplementation(() => calls.push('install'));
        jest.spyOn(task.task_manager_state, 'clearLazyTaskSystemPromptRefresh').mockImplementation(() => {});
        jest.spyOn(task, 'refreshBaseToolsets').mockImplementation(async () => {
            calls.push('base-tools');
        });
        jest.spyOn(task, 'persistLater').mockImplementation(() => {
            calls.push('persist');
        });
        jest.spyOn(task, 'refreshToolsets').mockImplementation(async () => {
            calls.push('all-tools');
        });
        const createContext = jest.spyOn(HarnessContext, 'createForMode').mockImplementation(async (workspace) => {
            calls.push('harness');
            const context = new HarnessContext();
            context.workspace = workspace;
            jest.spyOn(context, 'grantTaskArtifactAccess').mockImplementation(async () => {
                calls.push('artifact');
            });
            return context;
        });
        return { task, calls, environment, executionHost, provider, createProvider, createContext, build };
    }

    afterEach(() => jest.restoreAllMocks());

    test('main task mode wins over global defaults while preserving environment, node and permission owner', async () => {
        const { task, calls, environment, executionHost, provider, createProvider, createContext } = fixture({
            existingProvider: true
        });
        task.activeModeId = selected.id;
        await updateTaskWorkspace(task, '/new', {
            currentModeId: standard.id,
            permissionPromptFactory: createProvider
        });
        expect(createContext).toHaveBeenCalledWith('/new', selected);
        expect(task.harnessContext.environ).toBe(environment);
        expect(task.harnessContext.executionHost).toBe(executionHost);
        expect(task.harnessContext.permissionPrompt).toBe(provider);
        expect(createProvider).not.toHaveBeenCalled();
        expect(task.workspace).toBe('/new');
        expect(calls).toEqual(['harness', 'artifact', 'prompt', 'install', 'base-tools', 'persist', 'all-tools']);
    });

    test.each([
        { active: undefined, global: selected.id, expected: selected },
        { active: 'removed-mode', global: selected.id, expected: standard },
        { active: undefined, global: 'removed-mode', expected: standard }
    ])('resolves main mode for active=$active and global=$global', async ({ active, global, expected }) => {
        const { task, createProvider, createContext, provider } = fixture();
        task.activeModeId = active;
        await updateTaskWorkspace(task, '/new', { currentModeId: global, permissionPromptFactory: createProvider });
        expect(createContext).toHaveBeenCalledWith('/new', expected);
        expect(createProvider).toHaveBeenCalledTimes(1);
        expect(task.harnessContext.permissionPrompt).toBe(provider);
    });

    test('custom agents retain their bound mode instead of a main/global mode', async () => {
        const { task, createProvider, createContext } = fixture({ customAgent: true });
        task.activeModeId = worker.id;
        await updateTaskWorkspace(task, '/new', {
            currentModeId: selected.id,
            permissionPromptFactory: createProvider
        });
        expect(createContext).toHaveBeenCalledWith('/new', worker);
        expect(task.activeModeId).toBe(worker.id);
    });

    test('a failed transition keeps the original provider and harness without persistence or full refresh', async () => {
        const { task, calls, createProvider, build } = fixture();
        task.activeModeId = selected.id;
        const previous = task.harnessContext;
        build.mockRejectedValueOnce(new Error('cannot build task prompt'));
        await expect(
            updateTaskWorkspace(task, '/new', {
                currentModeId: standard.id,
                permissionPromptFactory: createProvider
            })
        ).rejects.toThrow('cannot build task prompt');
        expect(task.harnessContext).toBe(previous);
        expect(task.harnessContext.permissionPrompt).toBeNull();
        expect(task.workspace).toBe('/old');
        expect(task.activeModeId).toBe(selected.id);
        expect(calls).not.toContain('persist');
        expect(calls).not.toContain('all-tools');
    });
});
