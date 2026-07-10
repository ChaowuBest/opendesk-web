import test from 'node:test';
import assert from 'node:assert/strict';
import { GoalRuntimeAdapter, type GoalRuntimeCheckpointOptions } from '../../../main/aikernel/goal/runtime-adapter.js';

test('GoalRuntimeAdapter checkpoint delegates materialize options and result', async () => {
    const calls: GoalRuntimeCheckpointOptions[] = [];
    const adapter = new GoalRuntimeAdapter(async (options = {}) => {
        calls.push(options);
        return options.includeSupplements !== false;
    });

    assert.equal(await adapter.checkpoint('after_completion', { includeSupplements: false }), false);
    assert.equal(await adapter.checkpoint('before_finish'), true);
    assert.deepEqual(calls, [{ includeSupplements: false }, {}]);
});
