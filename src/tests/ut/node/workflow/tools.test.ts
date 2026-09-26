import assert from 'node:assert/strict';
import test from 'node:test';

import { AssistantMessage, ChatContext, ToolCall, ToolCallMessagePart } from '../../../../main/aikernel/messages.js';
import { GlobalHooks } from '../../../../main/aikernel/hooks.js';
import type { TaskState } from '../../../../main/aikernel/states/tasks.js';
import { WorkflowAuthoringCancelledError } from '../../../../main/applications/workflowMgr/authoring/service.js';
import { createWorkflowSkills } from '../../../../main/applications/workflowMgr/tooling/skills.js';
import {
    AuthorWorkflowTool,
    createWorkflowDiscoveryToolset,
    ListWorkflowsTool,
    RunWorkflowTool,
    StopWorkflowTool,
    type WorkflowToolHost
} from '../../../../main/applications/workflowMgr/tooling/tools.js';

const hostTask = { task_id: 'task-host' } as TaskState;

test('AuthorWorkflowTool creates a validated temporary definition with one update per attempt', async () => {
    const hostStages: string[] = [];
    const host: WorkflowToolHost = {
        authorWorkflow: async (task, onProgress) => {
            assert.equal(task.task_id, 'task-host');
            onProgress?.({
                stage: 'generate',
                userInputs: ['Create a daily brief']
            });
            onProgress?.({
                stage: 'validate',
                attempt: 1,
                definition: {
                    name: 'daily-brief',
                    description: 'Create a daily brief',
                    phases: [{ name: 'Draft' }],
                    inputSchema: { type: 'object' },
                    script: "await phase('Draft');\nreturn args;"
                }
            });
            onProgress?.({
                stage: 'review',
                attempt: 2,
                definition: {
                    name: 'daily-brief',
                    description: 'Create a daily brief',
                    phases: [{ name: 'Draft' }],
                    inputSchema: { type: 'object' },
                    script: "await phase('Draft');\nreturn args;"
                }
            });
            return {
                reference: 'authoring_1',
                workflowName: 'daily-brief',
                status: 'authored',
                inputSchema: { type: 'object' },
                missingRequiredInputs: [],
                launchReady: true,
                invocation: { reference: 'authoring_1' },
                message: 'authored',
                definition: {
                    id: 'workflow-1',
                    revision: 'revision-1',
                    name: 'daily-brief',
                    description: 'Create a daily brief',
                    phases: [{ name: 'Draft' }],
                    inputSchema: { type: 'object' },
                    script: "await phase('Draft');\nreturn args;",
                    createdAt: '2026-07-19T00:00:00.000Z',
                    updatedAt: '2026-07-19T00:00:00.000Z'
                }
            };
        },
        listWorkflows: () => [],
        runWorkflow: async () => {
            throw new Error('unused');
        },
        stopWorkflow: async () => {
            throw new Error('unused');
        }
    };
    const tool = new AuthorWorkflowTool(host);
    const authorSchema = tool.toJSON().params as { required?: string[] };
    assert.deepEqual(authorSchema.required ?? [], []);

    const result = await tool.execute(
        {},
        (update) => {
            const stage = (update.result_object as { stage?: string } | undefined)?.stage;
            if (stage && hostStages.at(-1) !== stage) {
                hostStages.push(stage);
            }
        },
        hostTask
    );
    const call = new ToolCall(0, 'call-author', 'workflow-AuthorWorkflow', '');
    call.args_object = {};
    call.result_object = result.result_object;
    call.status = result.status;
    const html = await tool.renderToolCall(call);

    const resultObject = result.result_object as {
        stage?: string;
        workflowName?: string;
        reference?: string;
    };
    assert.equal(result.status, 'success');
    assert.deepEqual(hostStages, ['generate', 'validate', 'review']);
    assert.equal(resultObject.stage, 'review');
    assert.equal(resultObject.workflowName, 'daily-brief');
    assert.equal(resultObject.reference, 'authoring_1');
    assert.deepEqual(JSON.parse(result.result).invocation, { reference: 'authoring_1' });
    assert.match(html ?? '', /View generation details|查看生成详情/);
    assert.match(html ?? '', /JavaScript source|JavaScript source/);
    assert.match(html ?? '', /Review|自查/);
    assert.match(html ?? '', /Create a daily brief/);
});

test('AuthorWorkflowTool renders a stopped terminal card when authoring is cancelled', async () => {
    const host: WorkflowToolHost = {
        authorWorkflow: async () => {
            throw new WorkflowAuthoringCancelledError();
        },
        listWorkflows: () => [],
        runWorkflow: async () => {
            throw new Error('unused');
        },
        stopWorkflow: async () => {
            throw new Error('unused');
        }
    };
    const tool = new AuthorWorkflowTool(host);

    const result = await tool.execute({}, undefined, hostTask);
    const call = new ToolCall(0, 'call-cancelled', 'workflow-AuthorWorkflow', '');
    call.args_object = {};
    call.result_object = result.result_object;
    call.status = result.status;
    const html = await tool.renderToolCall(call);

    assert.equal(result.status, 'success');
    assert.equal((result.result_object as { status?: string }).status, 'cancelled');
    assert.match(html ?? '', /Workflow creation stopped|Workflow 创建已停止/);
    assert.doesNotMatch(html ?? '', /fa-spinner/);
});

test('RunWorkflowTool returns a started result and owns its detail navigation card', async () => {
    let stopReason: 'user' | 'system' | undefined;
    const runTask = {
        task_id: 'task-host',
        hooks: GlobalHooks.createChildHooks(),
        stop: (reason: 'user' | 'system') => {
            stopReason = reason;
        }
    } as TaskState;
    const host: WorkflowToolHost = {
        authorWorkflow: async () => {
            throw new Error('unused');
        },
        listWorkflows: () => [],
        runWorkflow: async (reference, input, task) => {
            assert.equal(reference, 'deep-research');
            assert.deepEqual(input, { query: 'test' });
            assert.equal(task.task_id, 'task-host');
            return {
                runId: 'run-1',
                workflowName: 'deep-research',
                status: 'started',
                message: 'started'
            };
        },
        stopWorkflow: async () => {
            throw new Error('unused');
        }
    };
    const tool = new RunWorkflowTool(host);
    const result = await tool.execute(
        {
            reference: 'deep-research',
            input: { query: 'test' }
        },
        undefined,
        runTask
    );
    const call = new ToolCall(0, 'call-1', 'workflow-RunWorkflow', '');
    call.args_object = {
        reference: 'deep-research',
        input: { query: 'test' }
    };
    call.result_object = result.result_object;
    call.status = result.status;
    await runTask.hooks.noticeAfterToolCall({ task: runTask, toolCall: call });

    const html = await tool.renderToolCall(call);
    const resultObject = result.result_object as { runId?: string } | undefined;

    assert.equal(result.status, 'success');
    assert.equal(resultObject?.runId, 'run-1');
    assert.equal(stopReason, 'system');
    assert.match(result.result, /startup acknowledgement|启动回执/i);
    assert.match(html ?? '', /localStorage\.setItem\('opendesk\.workflow\.selectedRunId'/);
    assert.match(html ?? '', /applicationRegistryAPI\.callMainWorld\('workflowMgr','notifyRunSelectedForUI'/);
    assert.match(html ?? '', /globalControlAPI\.openApplication\('workflowMgr'\)/);
});

test('RunWorkflow starts a temporary definition with complete explicit input', async () => {
    const definition = {
        id: 'temporary-stock-analysis',
        revision: 'temporary-revision',
        name: 'stock-analysis',
        description: 'Analyze one stock',
        inputSchema: {
            type: 'object',
            properties: { stockName: { type: 'string' } },
            required: ['stockName'],
            additionalProperties: false
        },
        script: 'return args;',
        phases: [],
        createdAt: '2026-07-20T00:00:00.000Z',
        updatedAt: '2026-07-20T00:00:00.000Z'
    };
    const authorCall = new ToolCall(0, 'call-author', 'workflow-AuthorWorkflow', '{}');
    authorCall.status = 'success';
    authorCall.result_object = {
        reference: 'authoring_stock',
        workflowName: definition.name,
        status: 'authored',
        definition,
        inputSchema: definition.inputSchema,
        missingRequiredInputs: ['stockName'],
        launchReady: false,
        invocation: { reference: 'authoring_stock' },
        message: 'authored'
    };
    const authorPart = new ToolCallMessagePart();
    authorPart.push(authorCall);
    const authorMessage = new AssistantMessage([authorPart]);
    const task = {
        task_id: 'task-host',
        chat_context: new ChatContext(),
        hooks: GlobalHooks.createChildHooks(),
        stop: () => undefined
    } as TaskState;
    task.chat_context.appendMessage(authorMessage);

    let launchCount = 0;
    const host: WorkflowToolHost = {
        authorWorkflow: async () => {
            throw new Error('unused');
        },
        listWorkflows: () => [],
        runWorkflow: async (target, input) => {
            launchCount += 1;
            assert.deepEqual(target, definition);
            assert.deepEqual(input, { stockName: '生益科技' });
            return {
                runId: 'run-1',
                workflowName: definition.name,
                status: 'started',
                message: 'started'
            };
        },
        stopWorkflow: async () => {
            throw new Error('unused');
        }
    };
    const tool = new RunWorkflowTool(host);

    const launched = await tool.execute(
        { reference: 'authoring_stock', input: { stockName: '生益科技' } },
        undefined,
        task
    );
    assert.equal(launched.status, 'success');
    assert.equal((launched.result_object as { status?: string }).status, 'started');
    assert.equal(launchCount, 1);
});

test('StopWorkflowTool delegates cancellation by run id', async () => {
    const host: WorkflowToolHost = {
        authorWorkflow: async () => {
            throw new Error('unused');
        },
        listWorkflows: () => [],
        runWorkflow: async () => {
            throw new Error('unused');
        },
        stopWorkflow: async (runId, task) => {
            assert.equal(runId, 'run-1');
            assert.equal(task.task_id, 'task-host');
            return {
                runId,
                status: 'cancelled',
                message: 'stopped'
            };
        }
    };

    const result = await new StopWorkflowTool(host).execute({ runId: 'run-1' }, undefined, hostTask);

    assert.equal(result.status, 'success');
    assert.equal((result.result_object as { status?: string }).status, 'cancelled');
});

test('ListWorkflows exposes Task-local and global definitions through exact runnable contracts', async () => {
    const taskDefinition = {
        id: 'temporary-stock-analysis',
        revision: 'temporary-revision',
        name: 'stock-analysis',
        description: 'Analyze one stock',
        inputSchema: {
            type: 'object',
            properties: { stockName: { type: 'string' } },
            required: ['stockName'],
            additionalProperties: false
        },
        script: 'return args;',
        phases: [],
        createdAt: '2026-07-20T00:00:00.000Z',
        updatedAt: '2026-07-20T00:00:00.000Z'
    };
    const authorCall = new ToolCall(0, 'call-author', 'workflow-AuthorWorkflow', '{}');
    authorCall.status = 'success';
    authorCall.result_object = {
        reference: 'authoring_stock',
        workflowName: taskDefinition.name,
        status: 'authored',
        definition: taskDefinition,
        inputSchema: taskDefinition.inputSchema,
        missingRequiredInputs: ['stockName'],
        launchReady: false,
        invocation: { reference: 'authoring_stock' },
        message: 'authored'
    };
    const authorPart = new ToolCallMessagePart();
    authorPart.push(authorCall);
    const taskWithTemporaryDefinition = {
        task_id: 'task-host',
        chat_context: new ChatContext()
    } as TaskState;
    taskWithTemporaryDefinition.chat_context.appendMessage(new AssistantMessage([authorPart]));
    const host: WorkflowToolHost = {
        authorWorkflow: async () => {
            throw new Error('unused');
        },
        listWorkflows: () => [
            {
                source: 'builtin',
                definition: {
                    id: 'builtin-deep-research',
                    revision: 'revision-1',
                    name: 'deep-research',
                    description: 'Research a topic',
                    inputSchema: {
                        type: 'object',
                        properties: { query: { type: 'string' } },
                        required: ['query'],
                        additionalProperties: false
                    },
                    script: 'return args;',
                    phases: [],
                    createdAt: '2026-07-19T00:00:00.000Z',
                    updatedAt: '2026-07-19T00:00:00.000Z'
                }
            }
        ],
        runWorkflow: async () => {
            throw new Error('unused');
        },
        stopWorkflow: async () => {
            throw new Error('unused');
        }
    };

    const result = await new ListWorkflowsTool(host).execute({}, undefined, taskWithTemporaryDefinition);
    const listed = result.result_object as {
        workflows: Array<{
            reference: string;
            source: 'task' | 'saved' | 'builtin';
            inputSchema: Record<string, unknown>;
            invocation: { reference: string; input?: Record<string, string> };
        }>;
    };

    assert.equal(listed.workflows[0].source, 'task');
    assert.equal(listed.workflows[0].reference, 'authoring_stock');
    assert.deepEqual(listed.workflows[0].invocation, {
        reference: 'authoring_stock',
        input: { stockName: '<stockName>' }
    });
    assert.equal(listed.workflows[1].source, 'builtin');
    assert.deepEqual(listed.workflows[1].inputSchema.required, ['query']);
    assert.deepEqual(listed.workflows[1].invocation, {
        reference: 'deep-research',
        input: { query: '<query>' }
    });
});

test('Workflow Skills describe the direct creation and execution flow while discovery loads its action tools', async () => {
    const host = {
        authorWorkflow: async () => {
            throw new Error('unused');
        },
        listWorkflows: () => [],
        runWorkflow: async () => {
            throw new Error('unused');
        },
        stopWorkflow: async () => {
            throw new Error('unused');
        }
    } satisfies WorkflowToolHost;
    const skills = createWorkflowSkills(
        [
            {
                id: 'workflow-1',
                revision: 'revision-1',
                name: 'daily-brief',
                description: 'Create a daily brief',
                script: 'return args;',
                inputSchema: { type: 'object' },
                phases: [],
                createdAt: '2026-07-19T00:00:00.000Z',
                updatedAt: '2026-07-19T00:00:00.000Z'
            }
        ],
        host
    );

    assert.deepEqual(
        skills.map((skill) => skill.frontmatter.name),
        ['workflow', 'daily-brief']
    );
    assert.ok(skills.every((skill) => skill.frontmatter['user-invocable'] === true));
    assert.ok(skills.every((skill) => skill.frontmatter['disable-model-invocation'] === true));
    assert.ok(skills.every((skill) => skill.isUserInvocable));
    assert.ok(skills.every((skill) => !skill.isModelInvocable));
    assert.deepEqual(
        skills[1].toolsets?.flatMap((toolset) => [...toolset.tools.keys()]),
        ['LoadWorkflowTools']
    );
    assert.match(skills[1].body, /RunWorkflow/);
    assert.match(skills[1].body, /输入结构/);
    assert.deepEqual(
        skills[0].toolsets?.flatMap((toolset) => [...toolset.tools.keys()]),
        ['LoadWorkflowTools']
    );
    assert.match(skills[0].frontmatter.description, /Workflow/);
    assert.match(skills[0].body, /LoadWorkflowTools[\s\S]*AuthorWorkflow/);
    assert.match(skills[0].body, /真实原始输入/);
    assert.match(skills[0].body, /创建与运行是两次独立工具调用/);
    assert.match(skills[0].body, /AuthorWorkflow/);
    assert.match(skills[0].body, /RunWorkflow/);
    assert.match(skills[0].body, /status="started"/);

    const attachedToolsets: string[][] = [];
    const loader = createWorkflowDiscoveryToolset(host).getTool('LoadWorkflowTools');
    assert.ok(loader);
    assert.match(loader.description, /工作流|workflow|reusable process/i);
    assert.match(loader.description, /创建|create/i);
    const task = {
        attachToolset: async (toolset: { tools: Map<string, unknown> }) => {
            attachedToolsets.push([...toolset.tools.keys()]);
        }
    } as TaskState;

    const loaded = await loader.execute({}, undefined, task);

    assert.equal(loaded.status, 'success');
    assert.deepEqual(attachedToolsets, [['AuthorWorkflow', 'ListWorkflows', 'RunWorkflow', 'StopWorkflow']]);
});
