import assert from 'node:assert/strict';
import test from 'node:test';

import type {
    PermissionEnforcer,
    PermissionPromptContext,
    PermissionPromptProvider,
    PermissionRequest,
    PermissionTaskInfo,
    PermissionUserResponse
} from '../../../../main/aikernel/security/permission.js';
import { TaskManagerState, TaskState } from '../../../../main/aikernel/states/tasks.js';
import {
    bindWorkflowAgentAccess,
    createWorkflowAgentCompletionSchema,
    WorkflowAgentRunner
} from '../../../../main/applications/workflowMgr/agent/runner.js';

test('Workflow completion Tool exposes and accepts the requested structured output contract', () => {
    const outputSchema = {
        type: 'object',
        properties: {
            name: { type: 'string' },
            script: { type: 'string' }
        },
        required: ['name', 'script'],
        additionalProperties: false
    };
    const completionSchema = createWorkflowAgentCompletionSchema(outputSchema);
    const toolSchema = completionSchema.toJSONSchema() as {
        type?: string;
        properties?: {
            status?: { enum?: string[] };
            output?: {
                type?: string;
                properties?: Record<string, { type?: string }>;
            };
        };
    };

    assert.equal(toolSchema.type, 'object');
    assert.deepEqual(toolSchema.properties?.status?.enum, ['success', 'fail']);
    assert.equal(toolSchema.properties?.output?.type, 'object');
    assert.equal(toolSchema.properties?.output?.properties?.name?.type, 'string');
    assert.doesNotThrow(() =>
        completionSchema.parse({
            status: 'success',
            summary: 'Created a runnable Workflow',
            output: {
                name: 'daily-brief',
                script: "await phase('Draft');"
            }
        })
    );
});

test('Workflow Agent inherits the host Task model in the MVP', async () => {
    const manager = new TaskManagerState();
    const hostTask = new TaskState(manager);
    hostTask.model = 'parent-model';
    let selectedModel: string | undefined;
    manager.createTask = (model?: string): TaskState => {
        selectedModel = model;
        throw new Error('model captured');
    };

    await assert.rejects(
        new WorkflowAgentRunner().run(hostTask, {
            prompt: 'Research the topic',
            model: 'definition-model'
        }),
        /model captured/
    );
    assert.equal(selectedModel, 'parent-model');
});

test('Workflow Agent inherits the host access boundary and routes permission requests to the host Task', async () => {
    const manager = new TaskManagerState();
    const hostTask = new TaskState(manager);
    hostTask.task_id = 'task-host';
    hostTask.task_name = 'Host task';
    hostTask.workspace = '/workspace';
    hostTask.allowedTools = ['WebSearch', 'writeFile', 'executeBash'];
    hostTask.disabledTools = ['file-write'];

    const agentTask = new TaskState(manager);
    agentTask.task_id = 'task-workflow-agent';
    agentTask.task_name = 'Workflow phase agent';
    agentTask.disabledTools = ['browser-open'];

    const enforcer = {} as PermissionEnforcer;
    let receivedTaskInfo: PermissionTaskInfo | undefined;
    let receivedContext: PermissionPromptContext | undefined;
    const promptProvider: PermissionPromptProvider = {
        async prompt(
            _requests: PermissionRequest[],
            _toolName: string,
            _prefixOptions: { label: string; pattern: string }[],
            taskInfo?: PermissionTaskInfo,
            context?: PermissionPromptContext
        ): Promise<PermissionUserResponse> {
            receivedTaskInfo = taskInfo;
            receivedContext = context;
            return { decision: 'allow', rememberScope: 'none' };
        }
    };
    hostTask.harnessContext.permission = enforcer;
    hostTask.harnessContext.permissionPrompt = promptProvider;

    bindWorkflowAgentAccess(agentTask, hostTask, ['WebSearch', 'writeFile', 'executeBash', 'file-write']);

    assert.equal(agentTask.parent_id, null);
    assert.equal(agentTask.harnessContext.permission, enforcer);
    assert.deepEqual(agentTask.allowedTools, ['WebSearch', 'writeFile', 'CompleteWorkflowAgent']);
    assert.deepEqual(agentTask.disabledTools, ['browser-open', 'file-write']);

    const context = { toolCallId: 'tool-call-1' };
    await agentTask.harnessContext.permissionPrompt?.prompt(
        [{ resourceType: 'file', action: 'write', resourcePath: '/workspace/report.html' }],
        'file-write',
        [],
        {
            taskId: agentTask.task_id,
            taskName: agentTask.task_name,
            sourceTaskId: agentTask.task_id
        },
        context
    );

    assert.deepEqual(receivedTaskInfo, {
        taskId: hostTask.task_id,
        taskName: hostTask.task_name,
        workspace: '/workspace',
        sourceTaskId: agentTask.task_id,
        sourceTaskName: agentTask.task_name,
        parentTaskId: hostTask.task_id
    });
    assert.equal(receivedContext, context);
});
