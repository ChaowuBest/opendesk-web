/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TaskHooks } from '../../../../main/aikernel/hooks.js';
import {
    AssistantMessage,
    ChatContext,
    ToolCall,
    ToolCallMessagePart,
    UserMessage
} from '../../../../main/aikernel/messages.js';
import type { TaskState } from '../../../../main/aikernel/states/tasks.js';
import type { WorkflowDefinition, WorkflowJSONValue } from '../../../../main/aikernel/workflow.js';
import type { WorkflowAgentResult } from '../../../../main/applications/workflow/agent/contract.js';
import {
    WORKFLOW_AGENT_COMPLETION_TOOL_NAME,
    WorkflowAgentRunner
} from '../../../../main/applications/workflow/agent/runner.js';
import { WorkflowAuthoringService } from '../../../../main/applications/workflow/authoring/service.js';
import { WorkflowManager } from '../../../../main/applications/workflow/manager.js';
import {
    WorkflowRuntime,
    type WorkflowRuntimeEngine,
    type WorkflowRuntimeExecution,
    type WorkflowRuntimeStartInput
} from '../../../../main/applications/workflow/run/runtime/host.js';
import {
    AuthorWorkflowTool,
    ListWorkflowsTool,
    RunWorkflowTool,
    type WorkflowToolHost
} from '../../../../main/applications/workflow/tooling/tools.js';

class AcceptedRuntime implements WorkflowRuntimeEngine {
    private readonly sourceValidator = new WorkflowRuntime();
    private rejectCompletion?: (error: Error) => void;

    validateSource(source: string): void {
        this.sourceValidator.validateSource(source);
    }

    async start(_input: WorkflowRuntimeStartInput): Promise<WorkflowRuntimeExecution> {
        return {
            completion: new Promise<WorkflowJSONValue>((_resolve, reject) => {
                this.rejectCompletion = reject;
            }),
            stop: async () => {
                this.rejectCompletion?.(new Error('stopped'));
            }
        };
    }
}

class DeterministicAuthoringRunner extends WorkflowAgentRunner {
    override async run(...args: Parameters<WorkflowAgentRunner['run']>): ReturnType<WorkflowAgentRunner['run']> {
        const completion = {
            status: 'success' as const,
            summary: 'Created a daily brief Workflow',
            output: {
                name: 'daily-brief',
                description: 'Create a concise daily brief',
                whenToUse: 'When a daily summary is requested',
                phases: [{ name: 'Draft' }],
                inputSchema: {
                    type: 'object',
                    properties: {
                        topic: { type: 'string' }
                    },
                    required: ['topic'],
                    additionalProperties: false
                },
                script: [
                    "await phase('Draft');",
                    'const output = { topic: args.topic };',
                    'await report(output);',
                    'return output;'
                ].join('\n')
            }
        };
        const task = args[0];
        let accepted: WorkflowAgentResult | undefined;
        args[2]?.configureTask?.(task, {
            toolName: WORKFLOW_AGENT_COMPLETION_TOOL_NAME,
            parse: (toolCall) => toolCall.args_object as WorkflowAgentResult,
            accept: (_activeTask, _toolCall, result) => {
                accepted = result;
            },
            fail: (_activeTask, error) => {
                throw error;
            }
        });
        for (const id of ['review', 'accepted']) {
            const toolCall = new ToolCall(0, id, WORKFLOW_AGENT_COMPLETION_TOOL_NAME, JSON.stringify(completion));
            toolCall.args_object = completion;
            toolCall.status = 'success';
            await task.hooks.noticeAfterToolCall(task, toolCall);
        }
        assert.ok(accepted);
        return accepted;
    }
}

test('AuthorWorkflow, ListWorkflows, and RunWorkflow preserve a Task-local definition into its run', async () => {
    const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'opendesk-workflow-flow-'));
    const runtime = new AcceptedRuntime();
    const manager = new WorkflowManager({
        dataDirectory: rootDirectory,
        runRootDirectory: rootDirectory,
        runtime,
        builtins: [],
        runAgent: async () => ({ status: 'success', summary: 'unused' })
    });
    const hostTask = {
        task_id: 'task-flow',
        chat_context: new ChatContext(),
        disabledTools: [],
        hooks: new TaskHooks(),
        stop: () => undefined,
        task_manager_state: {
            toolsetProvider: {
                listAvailableToolsets: async () => []
            }
        },
        waitUntilFinished: async () => await new Promise<never>(() => undefined)
    } as TaskState;
    hostTask.chat_context.appendMessage(new UserMessage('Create a daily brief'));
    const authoring = new WorkflowAuthoringService(new DeterministicAuthoringRunner(), manager);
    const host: WorkflowToolHost = {
        authorWorkflow: async (task, onProgress) => await authoring.author(task, onProgress),
        listWorkflows: () => manager.listAvailableDefinitions(),
        runWorkflow: async (target, input, task) => {
            assert.equal(typeof target, 'object');
            const definition = target as WorkflowDefinition;
            assert.equal(definition.name, 'daily-brief');
            return await manager.launch(definition, input, task.task_id);
        },
        stopWorkflow: async () => {
            throw new Error('unused');
        }
    };

    try {
        const authored = await new AuthorWorkflowTool(host).execute({}, undefined, hostTask);
        const authorCall = new ToolCall(0, 'call-author', 'workflow-AuthorWorkflow', '{}');
        authorCall.status = authored.status;
        authorCall.result = authored.result;
        authorCall.result_object = authored.result_object;
        const authorPart = new ToolCallMessagePart();
        authorPart.push(authorCall);
        hostTask.chat_context.appendMessage(new AssistantMessage([authorPart]));
        hostTask.chat_context.appendMessage(new UserMessage('Workflow MVP'));

        const listed = await new ListWorkflowsTool(host).execute({}, undefined, hostTask);
        const temporary = (
            listed.result_object as {
                workflows: Array<{
                    source: string;
                    reference: string;
                    invocation: { reference: string; input?: Record<string, string> };
                }>;
            }
        ).workflows[0];
        assert.equal(temporary.source, 'task');
        assert.match(temporary.reference, /^authoring_/);
        assert.deepEqual(temporary.invocation.input, { topic: '<topic>' });

        const launched = await new RunWorkflowTool(host).execute(
            {
                reference: temporary.reference,
                input: { topic: 'Workflow MVP' }
            },
            undefined,
            hostTask
        );
        const runId = (launched.result_object as { runId: string }).runId;
        const run = manager.getRun(runId);
        const authorProtocol = JSON.parse(authored.result) as {
            launchReady: boolean;
            missingRequiredInputs: string[];
            invocation?: unknown;
            nextAction?: {
                type: string;
                requiredInputs?: string[];
                reference?: string;
            };
        };

        assert.equal(authored.status, 'success');
        assert.equal(authorProtocol.launchReady, false);
        assert.deepEqual(authorProtocol.missingRequiredInputs, ['topic']);
        assert.deepEqual(authorProtocol.invocation, { reference: temporary.reference });
        assert.deepEqual(
            {
                type: authorProtocol.nextAction?.type,
                requiredInputs: authorProtocol.nextAction?.requiredInputs,
                reference: authorProtocol.nextAction?.reference
            },
            {
                type: 'collect_input',
                requiredInputs: ['topic'],
                reference: temporary.reference
            }
        );
        assert.equal(launched.status, 'success');
        assert.equal(run?.hostTaskId, hostTask.task_id);
        assert.equal(run?.definition.name, 'daily-brief');
        assert.deepEqual(run?.input, { topic: 'Workflow MVP' });
        await assert.rejects(() => readFile(path.join(rootDirectory, 'workflow.json'), 'utf8'));
        const persistedRun = JSON.parse(
            await readFile(path.join(rootDirectory, hostTask.task_id, 'workflow-runs', runId, 'run.json'), 'utf8')
        );
        assert.equal(persistedRun.definition.name, 'daily-brief');
        assert.equal(persistedRun.status, 'running');

        await manager.stop(runId);
    } finally {
        await rm(rootDirectory, { recursive: true, force: true });
    }
});
