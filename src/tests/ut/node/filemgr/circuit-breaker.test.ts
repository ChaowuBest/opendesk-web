import assert from 'node:assert/strict';
import test from 'node:test';
import { GlobalHooks } from '../../../../main/aikernel/hooks.js';
import { ToolCall } from '../../../../main/aikernel/messages.js';

function makeToolCall(name: string, args: Record<string, unknown>, status: ToolCall['status'], result = ''): ToolCall {
    const call = new ToolCall(0, `${name}-call`, name, JSON.stringify(args));
    call.args_object = args;
    call.status = status;
    call.result = result;
    return call;
}

test('a failed read does not reset the repeated-edit circuit breaker', async () => {
    await import('../../../../main/applications/filemgr/harness/circuit-breaker.js');

    const beforeToolCall = GlobalHooks.beforeToolCallHooks.at(-1)?.callback;
    const afterToolCall = GlobalHooks.afterToolCallHooks.at(-1)?.callback;
    assert.ok(beforeToolCall);
    assert.ok(afterToolCall);

    const task = {
        task_id: 'circuit-breaker-test',
        appendInternalUserMessage: () => undefined
    } as any;
    const editArgs = {
        filePath: '/tmp/circuit-breaker-target.txt',
        oldString: 'before',
        newString: 'after'
    };

    assert.deepEqual(await beforeToolCall({ task, toolCall: makeToolCall('filemgr-editFile', editArgs, 'running') }), {
        operation: 'allow'
    });

    await afterToolCall({
        task,
        toolCall: makeToolCall(
            'filemgr-readFile',
            { file_path: editArgs.filePath },
            'error',
            'permission denied while reading file'
        )
    });

    const repeatedEdit = await beforeToolCall({
        task,
        toolCall: makeToolCall('filemgr-editFile', editArgs, 'running')
    });
    assert.equal(repeatedEdit.operation, 'deny');
});

test('a successful read resets the repeated-edit circuit breaker for that file', async () => {
    await import('../../../../main/applications/filemgr/harness/circuit-breaker.js');

    const beforeToolCall = GlobalHooks.beforeToolCallHooks.at(-1)?.callback;
    const afterToolCall = GlobalHooks.afterToolCallHooks.at(-1)?.callback;
    assert.ok(beforeToolCall);
    assert.ok(afterToolCall);

    const task = {
        task_id: 'circuit-breaker-success-test',
        appendInternalUserMessage: () => undefined
    } as any;
    const filePath = '/tmp/circuit-breaker-success-target.txt';
    const editArgs = { filePath, oldString: 'before', newString: 'after' };

    assert.equal(
        (await beforeToolCall({ task, toolCall: makeToolCall('filemgr-editFile', editArgs, 'running') })).operation,
        'allow'
    );

    await afterToolCall({
        task,
        toolCall: makeToolCall(
            'filemgr-readFile',
            { file_path: filePath },
            'success',
            `[文件] ${filePath} · 共 1 行 · 显示第 1-1 行\n     1\tafter`
        )
    });

    assert.equal(
        (await beforeToolCall({ task, toolCall: makeToolCall('filemgr-editFile', editArgs, 'running') })).operation,
        'allow'
    );
});
