import assert from 'node:assert/strict';
import test from 'node:test';
import { createInteractionDeliveryRuntime } from '../../../../../main/aikernel/interaction/delivery.js';
import {
    createInteractionSessionScopeResolver,
    type RemoteSessionTaskEntry
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/session-projector.js';

function task(entry: RemoteSessionTaskEntry): RemoteSessionTaskEntry {
    return entry;
}

test('resolves a source task to the same product-visible root used by directory projection', () => {
    const tasks = [
        task({ task_id: 'root', task_name: 'Root' }),
        task({ task_id: 'child', parent_id: 'root', task_name: '' }),
        task({ task_id: 'leaf', parent_id: 'child', task_name: '' })
    ];
    const resolve = createInteractionSessionScopeResolver(() => tasks);
    assert.equal(resolve('leaf'), 'root');
    assert.equal(resolve('child'), 'root');
    assert.equal(resolve('root'), 'root');
});

for (const [name, tasks, source] of [
    ['missing source', [task({ task_id: 'root', task_name: 'Root' })], 'missing'],
    ['duplicate ids', [task({ task_id: 'x', task_name: 'One' }), task({ task_id: 'x', task_name: 'Two' })], 'x'],
    ['cycle', [task({ task_id: 'a', parent_id: 'b' }), task({ task_id: 'b', parent_id: 'a' })], 'a'],
    ['no public root', [task({ task_id: 'internal', task_name: 'Internal', internal: true })], 'internal']
] as const) {
    test(`fails closed for ${name}`, () => {
        assert.equal(createInteractionSessionScopeResolver(() => tasks)(source), undefined);
    });
}

test('reads the task list fresh and follows a changed public root', () => {
    let tasks: readonly RemoteSessionTaskEntry[] = [
        task({ task_id: 'root-a', task_name: 'A' }),
        task({ task_id: 'child', parent_id: 'root-a' })
    ];
    const resolve = createInteractionSessionScopeResolver(() => tasks);
    assert.equal(resolve('child'), 'root-a');
    tasks = [task({ task_id: 'root-b', task_name: 'B' }), task({ task_id: 'child', parent_id: 'root-b' })];
    assert.equal(resolve('child'), 'root-b');
});

test('ignores duplicate missing ids but fails closed for duplicate nonempty ids', () => {
    const legal = [
        task({ task_id: undefined }),
        task({ task_id: undefined }),
        task({ task_id: 'root', task_name: 'Root' }),
        task({ task_id: 'child', parent_id: 'root' })
    ];
    assert.equal(createInteractionSessionScopeResolver(() => legal)('child'), 'root');
    const duplicate = [...legal, task({ task_id: 'child', parent_id: 'root' })];
    assert.equal(createInteractionSessionScopeResolver(() => duplicate)('child'), undefined);
});

test('creates one resolver object shared by the runtime and channel', () => {
    let reads = 0;
    const resolver = createInteractionSessionScopeResolver(() => {
        reads += 1;
        return [task({ task_id: 'root', task_name: 'Root' }), task({ task_id: 'child', parent_id: 'root' })];
    });
    const runtime = createInteractionDeliveryRuntime(resolver);
    assert.equal(runtime.scopeResolver, resolver);
    const unregister = runtime.deliveryChannel.registerEndpoint({
        sessionId: 'root',
        tryDeliverAskUser: () => ({ delivered: true, close: () => undefined }),
        tryDeliverExitPlanMode: () => undefined,
        tryDeliverPermission: () => undefined
    });
    const handle = runtime.deliveryChannel.publishAskUser(
        {
            type: 'askUser',
            requestId: 'ask-1',
            sourceTaskId: 'child',
            request: {
                requestId: 'ask-1',
                questions: [],
                taskId: 'child',
                taskName: null
            }
        },
        () => true
    );
    assert.equal(handle?.delivered, true);
    assert.equal(reads, 1);
    unregister();
});
