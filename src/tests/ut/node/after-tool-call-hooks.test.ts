import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolCall } from '../../../main/aikernel/messages.js';
import { Hooks, MAX_HOOK_PRIORITY } from '../../../main/aikernel/hooks.js';
import type { TaskState } from '../../../main/aikernel/states/tasks.js';

test('afterToolCall supports unregistration without changing execution order or error isolation', async () => {
    const hooks = Hooks.createGlobal();
    const task = {} as TaskState;
    const toolCall = new ToolCall(0, 'call-1', 'demo', '{}');
    let removableCalls = 0;
    let trailingCalls = 0;
    const callOrder: string[] = [];

    const unregister = hooks.afterToolCall(() => {
        removableCalls += 1;
        callOrder.push('removable');
    });
    hooks.afterToolCall(() => {
        throw new Error('expected after-tool hook error');
    });
    hooks.afterToolCall(
        () => {
            callOrder.push('plugin');
        },
        { priority: MAX_HOOK_PRIORITY }
    );
    hooks.afterToolCall(() => {
        trailingCalls += 1;
        callOrder.push('trailing');
    });

    await hooks.noticeAfterToolCall({ task, toolCall });

    assert.equal(removableCalls, 1);
    assert.equal(trailingCalls, 1);
    assert.deepEqual(callOrder, ['removable', 'trailing', 'plugin']);

    unregister();
    await hooks.noticeAfterToolCall({ task, toolCall });

    assert.equal(removableCalls, 1);
    assert.equal(trailingCalls, 2);
    assert.deepEqual(callOrder, ['removable', 'trailing', 'plugin', 'trailing', 'plugin']);
});
