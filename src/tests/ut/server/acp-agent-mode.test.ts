import { jest } from '@jest/globals';
import { OpenDeskAcpAgent } from '../../../main/server/acp/agent.js';
import { AcpExitPlanModeProvider } from '../../../main/server/acp/exitPlanMode.js';
import { GlobalState } from '../../../main/aikernel/states/global.js';
import { TaskState } from '../../../main/aikernel/states/tasks.js';
import { HarnessContext } from '../../../main/aikernel/security/harness.js';
import { MAIN_AGENT_PLAN_MODE, MAIN_AGENT_STANDARD_MODE } from '../../../main/aikernel/agents/main/modes/index.js';

describe('OpenDesk ACP task modes', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('exitPlanMode replaces the task permission harness before reporting the new mode', async () => {
        const taskManagerState = {
            initHarness: jest.fn(async (task: TaskState, workspace: string, mode: typeof MAIN_AGENT_PLAN_MODE) => {
                task.harnessContext = await HarnessContext.createForMode(workspace, mode);
                task.workspace = workspace;
                task.activeModeId = mode.id;
                task.allowedTools = mode.allowedTools;
                task.disabledTools = mode.disabledTools;
            }),
            clearLazyTaskSystemPromptRefresh: jest.fn(),
            toolsetProvider: {
                listAvailableToolsets: jest.fn(async () => [])
            }
        };
        jest.spyOn(GlobalState, 'getInstance').mockReturnValue({ taskManagerState } as any);

        let modeSwitcher: ((modeId: string) => Promise<void>) | undefined;
        jest.spyOn(AcpExitPlanModeProvider.prototype, 'setModeSwitcher').mockImplementation((switcher) => {
            modeSwitcher = switcher;
        });

        const connection = {
            sessionUpdate: jest.fn(async () => undefined)
        };
        const task = new TaskState(taskManagerState as any);
        task.task_id = 'acp-mode-task';
        jest.spyOn(task, 'rebuildSystemPrompt').mockResolvedValue(undefined);
        jest.spyOn(task, 'buildSystemPrompt').mockResolvedValue('system:standard');

        const session = {
            sessionId: 'acp-session',
            cwd: '/acp-workspace',
            task,
            mode: MAIN_AGENT_PLAN_MODE,
            updates: {},
            createdAt: new Date(),
            cancelled: false
        };
        const agent = new OpenDeskAcpAgent(connection as any);
        await (agent as any).configureTaskForSession(session, MAIN_AGENT_PLAN_MODE);
        const planPermission = task.harnessContext.permission;

        expect(modeSwitcher).toBeDefined();
        await modeSwitcher?.(MAIN_AGENT_STANDARD_MODE.id);

        expect(task.harnessContext.workspace).toBe('/acp-workspace');
        expect(task.harnessContext.permission).not.toBe(planPermission);
        expect(task.activeModeId).toBe(MAIN_AGENT_STANDARD_MODE.id);
        expect(task.disabledTools).toEqual(MAIN_AGENT_STANDARD_MODE.disabledTools);
        expect(session.mode.id).toBe(MAIN_AGENT_STANDARD_MODE.id);
        expect(connection.sessionUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                update: {
                    sessionUpdate: 'current_mode_update',
                    currentModeId: MAIN_AGENT_STANDARD_MODE.id
                }
            })
        );
    });
});
