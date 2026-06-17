import { z } from 'zod';
import { BaseTool } from '../../../main/aikernel/tool';
import { ToolCall } from '../../../main/aikernel/messages';
import { GlobPermissionEnforcer } from '../../../main/aikernel/security/enforcer';
import type {
    PermissionCheckResult,
    PermissionEnforcer,
    PermissionPromptContext,
    PermissionPromptProvider,
    PermissionRequest,
    PermissionTaskInfo,
    PermissionUserResponse
} from '../../../main/aikernel/security/permission';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks';

function readRequest(filePath: string): PermissionRequest {
    return { resourceType: 'file', action: 'read', resourcePath: filePath };
}

const readFileParamsSchema = z.object({});

class ReadFilePermissionTool extends BaseTool<typeof readFileParamsSchema> {
    constructor(private readonly request: PermissionRequest) {
        super('readFile', 'Read a file', readFileParamsSchema);
    }

    override getDeclaredPermissions(): PermissionRequest[] {
        return [this.request];
    }
}

class RecordingPromptProvider implements PermissionPromptProvider {
    prompts: Array<{
        requests: PermissionRequest[];
        toolName: string;
        prefixOptions: { label: string; pattern: string }[];
        taskInfo?: PermissionTaskInfo;
        context?: PermissionPromptContext;
    }> = [];
    notifiedEnforcers: PermissionEnforcer[] = [];
    notificationChecks: PermissionCheckResult[] = [];

    constructor(
        private readonly response: PermissionUserResponse,
        private readonly requestToCheckOnNotify: PermissionRequest
    ) {}

    async prompt(
        requests: PermissionRequest[],
        toolName: string,
        prefixOptions: { label: string; pattern: string }[],
        taskInfo?: PermissionTaskInfo,
        context?: PermissionPromptContext
    ): Promise<PermissionUserResponse> {
        this.prompts.push({ requests, toolName, prefixOptions, taskInfo, context });
        return this.response;
    }

    async notifyPermissionRulesChanged(enforcer: PermissionEnforcer): Promise<void> {
        this.notifiedEnforcers.push(enforcer);
        this.notificationChecks.push(await enforcer.check(this.requestToCheckOnNotify));
    }
}

describe('TaskState persistent permission allow handling', () => {
    test('child persistent allow writes parent and child enforcers, then refreshes parent queue once', async () => {
        const manager = new TaskManagerState();
        const parent = new TaskState(manager, null);
        parent.task_id = 'task-parent';
        parent.task_name = 'Parent task';

        const child = new TaskState(manager, parent.task_id);
        child.task_id = 'task-child';
        child.task_name = 'Child task';
        manager.tasks.push(parent, child);

        const requestedFile = '/tmp/opendesk-permission/a.txt';
        const requestedPermission = readRequest(requestedFile);
        const parentEnforcer = await GlobPermissionEnforcer.create([]);
        const childEnforcer = await GlobPermissionEnforcer.create([]);
        const provider = new RecordingPromptProvider(
            {
                decision: 'allow',
                rememberScope: 'prefix',
                selectedPrefixPattern: '/tmp/opendesk-permission/**'
            },
            requestedPermission
        );

        parent.harnessContext.permission = parentEnforcer;
        child.harnessContext.permission = childEnforcer;
        parent.harnessContext.permissionPrompt = provider;
        child.harnessContext.permissionPrompt = provider;

        const denied = await (
            child as unknown as {
                handleToolPermissions(
                    tool: BaseTool<any>,
                    args: Record<string, unknown>,
                    toolCall: ToolCall
                ): Promise<boolean>;
            }
        ).handleToolPermissions(
            new ReadFilePermissionTool(requestedPermission),
            {},
            new ToolCall(0, 'tc-1', 'readFile', '{}')
        );

        expect(denied).toBe(false);
        expect(provider.prompts).toHaveLength(1);
        expect(provider.prompts[0].taskInfo).toMatchObject({
            taskId: parent.task_id,
            sourceTaskId: child.task_id,
            parentTaskId: parent.task_id
        });
        expect(provider.notifiedEnforcers).toEqual([parentEnforcer]);
        expect(provider.notificationChecks).toHaveLength(1);
        expect(provider.notificationChecks[0].effect).toBe('allow');
        await expect(parentEnforcer.check(requestedPermission)).resolves.toMatchObject({ effect: 'allow' });
        await expect(childEnforcer.check(requestedPermission)).resolves.toMatchObject({ effect: 'allow' });
    });
});
