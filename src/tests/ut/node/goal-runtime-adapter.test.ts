import test from 'node:test';
import assert from 'node:assert/strict';
import { GoalRuntimeAdapter, type GoalRuntimeCheckpointOptions } from '../../../main/aikernel/goal/runtime-adapter.js';

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
