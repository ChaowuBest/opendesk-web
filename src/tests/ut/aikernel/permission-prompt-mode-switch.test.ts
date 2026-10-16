import { z } from 'zod';
import { BaseTool } from '../../../main/aikernel/tool';
import { ToolCall } from '../../../main/aikernel/messages';
import type {
    PermissionPromptContext,
    PermissionPromptProvider,
    PermissionRequest,
    PermissionTaskInfo,
    PermissionUserResponse
} from '../../../main/aikernel/security/permission';
import { HarnessContext } from '../../../main/aikernel/security/harness';
import { MAIN_AGENT_SOLO_MODE } from '../../../main/aikernel/agents/main/modes/solo';
import { MAIN_AGENT_STANDARD_MODE } from '../../../main/aikernel/agents/main/modes/standard';
import { promptPermissionBatchForTask } from '../../../main/aikernel/task/permission';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks';

class RecordingPromptProvider implements PermissionPromptProvider {
    prompts: PermissionRequest[][] = [];
    response: PermissionUserResponse = { decision: 'allow', rememberScope: 'none' };
    beforeRespond: (() => Promise<void>) | null = null;

    async prompt(
        requests: PermissionRequest[],
        _toolName: string,
        _prefixOptions: { label: string; pattern: string }[],
        _taskInfo?: PermissionTaskInfo,
        _context?: PermissionPromptContext
    ): Promise<PermissionUserResponse> {
        this.prompts.push(requests);
        await this.beforeRespond?.();
        return this.response;
    }
}

const paramsSchema = z.object({});

/** 一次调用声明两组不同类型权限的工具，复现权限检查与弹窗之间的时间差。 */
class MultiGroupPermissionTool extends BaseTool<typeof paramsSchema> {
    constructor(private readonly requests: PermissionRequest[]) {
        super('multiGroupTool', 'Multi group permission tool', paramsSchema);
        this.setExecutor(async () => 'ok');
    }

    override getDeclaredPermissions(): PermissionRequest[] {
        return this.requests;
    }
}

async function createTask(provider: RecordingPromptProvider, taskId: string): Promise<TaskState> {
    const manager = new TaskManagerState();
    const task = new TaskState(manager, null);
    task.task_id = taskId;
    task.task_status = 'running';
    task.harnessContext = await HarnessContext.createForMode('/workspace', MAIN_AGENT_STANDARD_MODE);
    task.harnessContext.permissionPrompt = provider;
    task.activeModeId = MAIN_AGENT_STANDARD_MODE.id;
    return task;
}

/** 模拟用户在权限弹窗挂起期间切换到效率模式（solo）。 */
async function switchTaskToSolo(task: TaskState, provider: RecordingPromptProvider): Promise<void> {
    task.harnessContext = await HarnessContext.createForMode('/workspace', MAIN_AGENT_SOLO_MODE);
    task.harnessContext.permissionPrompt = provider;
    task.activeModeId = MAIN_AGENT_SOLO_MODE.id;
}

describe('permission prompt re-check against the current enforcer', () => {
    test('skips prompting when the current enforcer already allows the pending request', async () => {
        const provider = new RecordingPromptProvider();
        const task = await createTask(provider, 'task-standard-to-solo');
        const request: PermissionRequest = {
            resourceType: 'file',
            action: 'read',
            resourcePath: '/outside-workspace/secret.txt'
        };

        // 权限检查已经用标准模式引擎判定为 ask（弹窗本该出现），
        // 但用户此刻切到了效率模式，solo 引擎已放通该请求。
        await switchTaskToSolo(task, provider);

        const response = await promptPermissionBatchForTask(
            task,
            [request],
            'readFile',
            [],
            new ToolCall(0, 'tc-1', 'readFile', '{}')
        );

        expect(response.decision).toBe('allow');
        expect(provider.prompts).toHaveLength(0);
    });

    test('still prompts while the current enforcer asks', async () => {
        const provider = new RecordingPromptProvider();
        const task = await createTask(provider, 'task-still-asks');
        const request: PermissionRequest = {
            resourceType: 'file',
            action: 'read',
            resourcePath: '/outside-workspace/secret.txt'
        };

        const response = await promptPermissionBatchForTask(
            task,
            [request],
            'readFile',
            [],
            new ToolCall(0, 'tc-2', 'readFile', '{}')
        );

        expect(response.decision).toBe('allow');
        expect(provider.prompts).toHaveLength(1);
    });

    test('does not re-prompt later permission groups after switching to solo mid-tool', async () => {
        const provider = new RecordingPromptProvider();
        const task = await createTask(provider, 'task-multi-group');
        provider.beforeRespond = async () => {
            // 第一个弹窗挂起期间用户切换到效率模式：solo 引擎会放通剩余请求
            await switchTaskToSolo(task, provider);
        };
        const tool = new MultiGroupPermissionTool([
            { resourceType: 'file', action: 'read', resourcePath: '/outside-workspace/a.txt' },
            { resourceType: 'file', action: 'write', resourcePath: '/outside-workspace/b.txt' }
        ]);

        const denied = await (
            task as unknown as {
                handleToolPermissions(
                    tool: BaseTool<any>,
                    args: Record<string, unknown>,
                    toolCall: ToolCall
                ): Promise<boolean>;
            }
        ).handleToolPermissions(tool, {}, new ToolCall(0, 'tc-3', 'multiGroupTool', '{}'));

        expect(denied).toBe(false);
        expect(provider.prompts).toHaveLength(1);
    });
});
