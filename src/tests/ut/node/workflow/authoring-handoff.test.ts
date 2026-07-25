import assert from 'node:assert/strict';
import test from 'node:test';

import { AssistantMessage, ToolCall, ToolCallMessagePart } from '../../../../main/aikernel/messages.js';
import type { TaskState } from '../../../../main/aikernel/states/tasks.js';
import { resolveAuthoredDefinitionFromTask } from '../../../../main/applications/workflowMgr/tooling/tools.js';

test('RunWorkflow resolves a temporary definition only from the current Task ToolCall result', () => {
    const toolCall = new ToolCall(0, 'call-author', 'workflow-AuthorWorkflow', '{}');
    toolCall.status = 'success';
    toolCall.result_object = {
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
            script: 'return args;',
            inputSchema: { type: 'object' },
            phases: [],
            createdAt: '2026-07-19T00:00:00.000Z',
            updatedAt: '2026-07-19T00:00:00.000Z'
        }
    };
    const part = new ToolCallMessagePart();
    part.push(toolCall);
    const task = {
        chat_context: {
            messages: [new AssistantMessage([part])]
        }
    } as TaskState;

    const definition = resolveAuthoredDefinitionFromTask(task, 'authoring_1');

    assert.equal(definition.name, 'daily-brief');
    assert.notEqual(definition, (toolCall.result_object as { definition: object }).definition);
    assert.throws(() => resolveAuthoredDefinitionFromTask(task, 'authoring_other'), /authoring_other/);
    assert.throws(
        () =>
            resolveAuthoredDefinitionFromTask(
                {
                    chat_context: {
                        messages: []
                    }
                } as TaskState,
                'authoring_1'
            ),
        /authoring_1/
    );
});
