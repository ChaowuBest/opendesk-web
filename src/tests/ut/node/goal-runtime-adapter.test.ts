import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolCall, type RuntimeMetadata } from '../../../main/aikernel/messages.js';
import { GoalRuntimeAdapter, type GoalRuntimeCheckpointOptions } from '../../../main/aikernel/goal/runtime-adapter.js';
import type { GoalState } from '../../../main/aikernel/goal/state.js';
import type { TaskState } from '../../../main/aikernel/states/tasks.js';

function createAdapter(goal: GoalState | undefined): GoalRuntimeAdapter {
    const task = { task_id: 'task-1', goal_state: goal } as TaskState;
    return new GoalRuntimeAdapter(
        {
            getTask: () => task,
            getTurnGeneration: () => 0,
            async materializePromptTurn() {}
        },
        async () => false
    );
}

function createToolCall(metadata?: RuntimeMetadata): ToolCall {
    const toolCall = new ToolCall(0, 'tool-call-1', 'test-tool', '{}');
    toolCall.metadata = metadata;
    return toolCall;
}

test('GoalRuntimeAdapter checkpoint delegates materialize options and result', async () => {
    const calls: GoalRuntimeCheckpointOptions[] = [];
    const adapter = new GoalRuntimeAdapter(
        {
            getTask() {
                throw new Error('task should not be needed without pending reminders');
            },
            getTurnGeneration() {
                return 0;
            },
            async materializePromptTurn() {
                throw new Error('prompt should not be materialized without pending reminders');
            }
        },
        async (options = {}) => {
            calls.push(options);
            return true;
        }
    );

    assert.equal(await adapter.checkpoint('after_completion', { includeSupplements: false }), false);
    assert.equal(await adapter.checkpoint('before_finish'), true);
    assert.deepEqual(calls, [{}]);
});

test('GoalRuntimeAdapter leaves current and non-goal tool calls untouched', () => {
    const goal = { id: 'goal-1', revision: 2 } as GoalState;
    const adapter = createAdapter(goal);
    const currentGoalCall = createToolCall({
        scope: 'goal',
        execution: {
            controller: 'goal',
            controllerId: goal.id,
            controllerRevision: goal.revision
        }
    });
    const normalCall = createToolCall({
        scope: 'task',
        execution: {
            controller: 'normal',
            controllerRevision: 1
        }
    });

    assert.equal(adapter.beforeToolCall(currentGoalCall), false);
    assert.equal(adapter.beforeToolCall(normalCall), false);
    assert.equal(currentGoalCall.status, 'pending');
    assert.equal(normalCall.status, 'pending');
    assert.equal(currentGoalCall.result, undefined);
    assert.equal(normalCall.result, undefined);
});

test('GoalRuntimeAdapter marks stale goal tool calls with the original result contract', () => {
    const goal = { id: 'goal-1', revision: 2 } as GoalState;
    const adapter = createAdapter(goal);
    const toolCall = createToolCall({
        scope: 'goal',
        execution: {
            controller: 'goal',
            controllerId: goal.id,
            controllerRevision: 1
        }
    });
    toolCall.rendered = 'stale rendered output';

    assert.equal(adapter.beforeToolCall(toolCall), true);
    assert.equal(toolCall.status, 'error');
    assert.deepEqual(toolCall.result_object, {
        skipped: true,
        reason: 'stale_goal_revision',
        goalRevision: 1,
        currentGoalRevision: 2
    });
    assert.equal(
        toolCall.result,
        JSON.stringify({
            skipped: true,
            reason: 'stale_goal_revision',
            goalRevision: 1,
            currentGoalRevision: 2
        })
    );
    assert.equal(toolCall.rendered, undefined);
});
