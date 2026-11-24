/// <reference types="node" />

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    createPublicSessionSync,
    type RemoteTaskManagerSubscriber,
    type RemoteTaskUpdateSubscriber
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session-sync.js';
import {
    PUBLIC_TEXT_MAX_BYTES,
    applyPublicSessionUpdate,
    type PublicSessionState,
    type PublicSessionUpdate
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session.js';
import {
    createPublicSessionIdentifierPlan,
    deriveRunToken,
    type PublicSessionIdentifierPlan
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session-identifiers.js';
import {
    collectPublicSessionIdentifierCandidates,
    projectPublicMessageReplacement,
    projectPublicPartState,
    projectTaskChunk
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/session-projector.js';
import { sourceTask } from './session-projector-fixtures.js';

const state = (): PublicSessionState => ({
    sessionId: 's1',
    title: 'Session',
    cwd: '/work',
    updatedAt: '2026-08-22T00:00:00.000Z',
    taskStatus: 'running',
    completionStatus: null,
    runToken: deriveRunToken('s1', 1),
    history: { messages: [] }
});

const identity = (): PublicSessionIdentifierPlan => ({
    hasMessage: () => false,
    hasToolCall: () => false,
    messageId: () => 'a1',
    toolCallId: () => 't1',
    registerMessage: () => 'a1',
    registerToolCall: () => 't1',
    rebindMessageToolCalls: () => []
});

test('registers observers before T0, freezes pending, then pumps serial live updates', async () => {
    let taskSubscriber: RemoteTaskUpdateSubscriber | undefined;
    const updates: PublicSessionUpdate[] = [];
    const setup = createPublicSessionSync('s1', {
        subscribeTask(subscriber) {
            taskSubscriber = subscriber;
            return () => undefined;
        },
        subscribeTaskManager() {
            return () => undefined;
        },
        projectChunk(chunk) {
            return (chunk as unknown as { update: PublicSessionUpdate }).update;
        },
        projectInfo: () => ({
            title: 'Session',
            cwd: '/work',
            updatedAt: '2026-08-22T00:00:00.000Z',
            taskStatus: 'running',
            completionStatus: null,
            runToken: deriveRunToken('s1', 1)
        }),
        assertStillAuthorized: () => undefined,
        projectAuthoritativeState: () => {
            const result = state();
            for (const update of updates) {
                if (update.type === 'part_state')
                    result.history.messages.push({
                        role: 'assistant',
                        messageId: update.messageId,
                        parts: [update.part as never]
                    });
            }
            return result;
        }
    });
    assert.ok(taskSubscriber);
    setup.initializeT0(state(), identity());
    const pending: PublicSessionUpdate = {
        type: 'part_state',
        messageId: 'a1',
        role: 'assistant',
        partIndex: 0,
        part: { type: 'text', text: 'pending' }
    };
    updates.push(pending);
    taskSubscriber.send({
        type: 'assistant',
        task_id: 's1',
        message_id: 'a1',
        last_part_index: 0,
        last_part: { type: 'text', text: 'pending' },
        update: pending
    } as never);
    const observed: PublicSessionUpdate[] = [];
    await setup.handle.activate(async (update) => {
        observed.push(update);
    });
    assert.deepEqual(observed, [pending]);
    setup.handle.stop();
    assert.equal(setup.handle.phase, 'stopped');
});

class MemoryTaskPublisher {
    subscribers: RemoteTaskUpdateSubscriber[] = [];
    subscribe(value: RemoteTaskUpdateSubscriber): () => void {
        this.subscribers.push(value);
        return () => {
            this.subscribers = this.subscribers.filter((item) => item !== value);
        };
    }
    publish(
        update: PublicSessionUpdate,
        taskId = 's1',
        taskStatus: PublicSessionState['taskStatus'] = 'running'
    ): void {
        const chunk = { task_id: taskId, task_status: taskStatus, update } as never;
        for (const subscriber of [...this.subscribers]) subscriber.send(chunk);
    }
}

class MemoryManagerPublisher {
    subscribers: RemoteTaskManagerSubscriber[] = [];
    subscribe(value: RemoteTaskManagerSubscriber): () => void {
        this.subscribers.push(value);
        return () => {
            this.subscribers = this.subscribers.filter((item) => item !== value);
        };
    }
    publish(): void {
        for (const subscriber of [...this.subscribers]) subscriber.send([]);
    }
}

function textState(text: string): PublicSessionState {
    const result = state();
    result.history.messages.push({ role: 'assistant', messageId: 'a1', parts: [{ type: 'text', text }] });
    return result;
}

function text(textValue: string): Extract<PublicSessionUpdate, { type: 'part_state' }> {
    return {
        type: 'part_state',
        messageId: 'a1',
        role: 'assistant',
        partIndex: 0,
        part: { type: 'text', text: textValue }
    };
}

function fixture(initial = textState('base')) {
    const task = new MemoryTaskPublisher();
    const manager = new MemoryManagerPublisher();
    let authoritative = initial;
    let info = {
        title: initial.title,
        cwd: initial.cwd,
        updatedAt: initial.updatedAt,
        taskStatus: initial.taskStatus,
        completionStatus: initial.completionStatus,
        runToken: initial.runToken
    };
    let authorized = true;
    let fatalCalls = 0;
    const setup = createPublicSessionSync('s1', {
        subscribeTask: (subscriber) => task.subscribe(subscriber),
        subscribeTaskManager: (subscriber) => manager.subscribe(subscriber),
        projectChunk: (chunk) => structuredClone((chunk as unknown as { update: PublicSessionUpdate }).update),
        projectInfo: () => info,
        assertStillAuthorized() {
            if (!authorized) throw new Error('authorization changed');
        },
        projectAuthoritativeState: () => authoritative
    });
    setup.handle.installFatalSink(() => {
        fatalCalls += 1;
    });
    setup.initializeT0(initial, identity());
    return {
        feed: setup.handle,
        task,
        manager,
        publish(update: PublicSessionUpdate) {
            authoritative = applyPublicSessionUpdate(authoritative, structuredClone(update));
            task.publish(update);
        },
        publishRaw(
            update: PublicSessionUpdate,
            taskId = 's1',
            taskStatus: PublicSessionState['taskStatus'] = 'running'
        ) {
            task.publish(update, taskId, taskStatus);
        },
        setAuthoritative(next: PublicSessionState) {
            authoritative = next;
            info = {
                title: next.title,
                cwd: next.cwd,
                updatedAt: next.updatedAt,
                taskStatus: next.taskStatus,
                completionStatus: next.completionStatus,
                runToken: next.runToken
            };
        },
        replaceInfo(next: typeof info) {
            info = next;
            authoritative = applyPublicSessionUpdate(authoritative, { type: 'session_info_replace', info: next });
            manager.publish();
        },
        revoke() {
            authorized = false;
            manager.publish();
        },
        fatalCalls: () => fatalCalls,
        authoritative: () => authoritative
    };
}

test('coalesces only unsent consecutive text snapshots and preserves creation metadata and terminal ordering', async () => {
    const initial = state();
    const current = fixture(initial);
    const sent: PublicSessionUpdate[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
        release = resolve;
    });
    await current.feed.activate(async (update) => {
        sent.push(update);
        if (sent.length === 1) await blocked;
    });
    // Occupy the transport so the first text (including its timestamp) is still queued.
    current.replaceInfo({
        title: 'renamed',
        cwd: '/work',
        updatedAt: initial.updatedAt,
        taskStatus: 'running',
        completionStatus: null,
        runToken: initial.runToken
    });
    current.publish({ ...text('1'), messageTimestamp: 17 });
    for (let i = 2; i <= 500; i++) current.publish(text(String(i)));
    const replacement: PublicSessionUpdate = {
        type: 'message_replace',
        message: { role: 'assistant', messageId: 'a1', timestamp: 17, parts: [{ type: 'text', text: 'corrected' }] }
    };
    current.publish(replacement);
    current.publish(text('final'));
    current.replaceInfo({
        title: 'renamed',
        cwd: '/work',
        updatedAt: initial.updatedAt,
        taskStatus: 'stopped',
        completionStatus: 'success',
        runToken: null
    });
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sent.length, 5);
    assert.deepEqual(sent[1], { ...text('500'), messageTimestamp: 17 });
    assert.deepEqual(sent[2], replacement);
    assert.deepEqual(sent.reduce(applyPublicSessionUpdate, initial), current.authoritative());
    assert.equal(current.fatalCalls(), 0);
    current.feed.stop();
});

test('drops exact duplicates and ignores another task before the consumer', async () => {
    const current = fixture();
    const sent: PublicSessionUpdate[] = [];
    await current.feed.activate(async (update) => {
        sent.push(update);
    });
    current.publish(text('base'));
    current.publishRaw(text('other'), 'other-task');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sent.length, 0);
    assert.equal(current.feed.phase, 'live');
    current.feed.stop();
});

test('accepts a normal part change, atomic replacement and manager info update in order', async () => {
    const current = fixture();
    const sent: PublicSessionUpdate[] = [];
    await current.feed.activate(async (update) => {
        sent.push(update);
    });
    current.publish(text('changed'));
    current.publish({
        type: 'message_replace',
        message: { role: 'assistant', messageId: 'a1', parts: [{ type: 'reasoning', content: 'thinking' }] }
    });
    current.replaceInfo({
        title: null,
        cwd: '/next',
        updatedAt: '2026-08-22T01:00:00.000Z',
        taskStatus: 'stopped',
        completionStatus: 'success',
        runToken: null
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
        sent.map((value) => value.type),
        ['part_state', 'message_replace', 'session_info_replace']
    );
    assert.deepEqual(
        sent.reduce((value, update) => applyPublicSessionUpdate(value, update), textState('base')),
        current.authoritative()
    );
    current.feed.stop();
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('generation-only token change emits info and preserves T0/live continuity', async () => {
    const current = fixture();
    const updates: PublicSessionUpdate[] = [];
    await current.feed.activate(async (update) => {
        updates.push(update);
    });
    current.replaceInfo({
        title: 'Session',
        cwd: '/work',
        updatedAt: '2026-08-22T00:00:00.000Z',
        taskStatus: 'running',
        completionStatus: null,
        runToken: deriveRunToken('s1', 2)
    });
    await flush();

    assert.deepEqual(updates, [
        {
            type: 'session_info_replace',
            info: {
                title: 'Session',
                cwd: '/work',
                updatedAt: '2026-08-22T00:00:00.000Z',
                taskStatus: 'running',
                completionStatus: null,
                runToken: deriveRunToken('s1', 2)
            }
        }
    ]);
    assert.equal(current.feed.phase, 'live');
});

test('terminal reconciliation emits null token before continuity succeeds', async () => {
    const current = fixture();
    const updates: PublicSessionUpdate[] = [];
    await current.feed.activate(async (update) => {
        updates.push(update);
    });
    current.replaceInfo({
        title: 'Session',
        cwd: '/work',
        updatedAt: '2026-08-22T00:00:00.000Z',
        taskStatus: 'stopped',
        completionStatus: null,
        runToken: null
    });
    await flush();
    assert.deepEqual(updates, [
        {
            type: 'session_info_replace',
            info: {
                title: 'Session',
                cwd: '/work',
                updatedAt: '2026-08-22T00:00:00.000Z',
                taskStatus: 'stopped',
                completionStatus: null,
                runToken: null
            }
        }
    ]);
    assert.equal(current.fatalCalls(), 0);
    assert.equal(current.feed.phase, 'live');
});

test('manager stopped updates info before delayed stopped task content converges', async () => {
    const initial = textState('running');
    const current = fixture(initial);
    const updates: PublicSessionUpdate[] = [];
    await current.feed.activate(async (update) => {
        updates.push(update);
    });

    const stopped = textState('interrupted');
    stopped.updatedAt = '2026-08-22T01:30:00.000Z';
    stopped.taskStatus = 'stopped';
    stopped.runToken = null;
    current.setAuthoritative(stopped);
    current.manager.publish();
    await flush();

    assert.equal(current.feed.phase, 'live');
    assert.equal(current.fatalCalls(), 0);
    assert.deepEqual(updates, [
        {
            type: 'session_info_replace',
            info: {
                title: stopped.title,
                cwd: stopped.cwd,
                updatedAt: stopped.updatedAt,
                taskStatus: 'stopped',
                completionStatus: stopped.completionStatus,
                runToken: null
            }
        }
    ]);

    current.publishRaw(text('interrupted'), 's1', 'stopped');
    const later = applyPublicSessionUpdate(stopped, text('tool output after stop'));
    current.setAuthoritative(later);
    current.publishRaw(text('tool output after stop'), 's1', 'stopped');
    await flush();

    assert.equal(current.feed.phase, 'live');
    assert.equal(current.fatalCalls(), 0);
    assert.deepEqual(
        updates.reduce((state, update) => applyPublicSessionUpdate(state, update), initial),
        later
    );
});

test('allows ordered running observations to catch up with an atomically advanced task', async () => {
    const initial = state();
    initial.history.messages.push({
        role: 'assistant',
        messageId: 'a1',
        parts: [{ type: 'reasoning', content: 'draft' }]
    });
    const current = fixture(initial);
    const sent: PublicSessionUpdate[] = [];
    await current.feed.activate(async (update) => {
        sent.push(update);
    });
    const reasoning: PublicSessionUpdate = {
        type: 'part_state',
        messageId: 'a1',
        role: 'assistant',
        partIndex: 0,
        part: { type: 'reasoning', content: 'final' }
    };
    const answer: PublicSessionUpdate = {
        type: 'part_state',
        messageId: 'a1',
        role: 'assistant',
        partIndex: 1,
        part: { type: 'text', text: 'visible' }
    };
    const running = applyPublicSessionUpdate(applyPublicSessionUpdate(initial, reasoning), answer);
    current.setAuthoritative(running);

    current.publishRaw(reasoning);
    assert.equal(current.feed.phase, 'live');
    current.publishRaw(answer);
    const final = structuredClone(running);
    final.taskStatus = 'stopped';
    final.updatedAt = '2026-08-22T02:00:00.000Z';
    current.setAuthoritative(final);
    current.publishRaw(answer, 's1', 'stopped');
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(current.feed.phase, 'live');
    assert.deepEqual(
        sent.reduce((value, update) => applyPublicSessionUpdate(value, update), initial),
        final
    );
    current.feed.stop();
});

// 以下 4 个测试专门锁定 public-session-sync.ts 中已被注释的权威一致性校验：
// 终态时用增量结果与权威快照逐字节比对、不一致即 fail closed，以及随该比对进行的
// Assistant 时间戳补推。第一版不做该校验（原因见 public-session-sync.ts 的 settleObservation），
// 故一并注释；恢复该校验时同步恢复这些测试。
// test('fails closed when a stopped observation reaches a non-converged authoritative state', () => {
//     const current = fixture();
//     const final = textState('missing update');
//     final.taskStatus = 'stopped';
//     final.updatedAt = '2026-08-22T03:00:00.000Z';
//     current.setAuthoritative(final);
//
//     current.publishRaw(text('base'), 's1', 'stopped');
//
//     assert.equal(current.feed.phase, 'stopped');
//     assert.equal(current.fatalCalls(), 1);
//     assert.equal(current.task.subscribers.length, 0);
//     assert.equal(current.manager.subscribers.length, 0);
// });
//
// test('defers a running authoritative divergence but fails closed if it remains at terminal', async () => {
//     const current = fixture();
//     await current.feed.activate(async () => undefined);
//     const authoritative = textState('unobserved');
//     current.setAuthoritative(authoritative);
//
//     current.publishRaw(text('base'));
//     await new Promise((resolve) => setImmediate(resolve));
//     assert.equal(current.feed.phase, 'live');
//     assert.equal(current.fatalCalls(), 0);
//
//     authoritative.taskStatus = 'stopped';
//     authoritative.updatedAt = '2026-08-22T03:30:00.000Z';
//     current.setAuthoritative(authoritative);
//     current.publishRaw(text('base'), 's1', 'stopped');
//     await new Promise((resolve) => setImmediate(resolve));
//
//     assert.equal(current.feed.phase, 'stopped');
//     assert.equal(current.fatalCalls(), 1);
//     assert.equal(current.task.subscribers.length, 0);
//     assert.equal(current.manager.subscribers.length, 0);
// });
//
// test('reconciles all final assistant timestamps from stopped task content after manager info', async () => {
//     const initial = state();
//     initial.history.messages.push(
//         { role: 'assistant', messageId: 'a1', parts: [{ type: 'text', text: 'first' }] },
//         { role: 'assistant', messageId: 'a2', parts: [] }
//     );
//     const current = fixture(initial);
//     const sent: PublicSessionUpdate[] = [];
//     await current.feed.activate(async (update) => {
//         sent.push(update);
//     });
//     const runningWithTimestamps = structuredClone(initial);
//     const first = runningWithTimestamps.history.messages[0];
//     const second = runningWithTimestamps.history.messages[1];
//     if (first.role !== 'assistant' || second.role !== 'assistant') throw new Error('expected assistant messages');
//     first.timestamp = 11;
//     second.timestamp = 12;
//     current.setAuthoritative(runningWithTimestamps);
//     current.manager.publish();
//     await new Promise((resolve) => setImmediate(resolve));
//     assert.equal(sent.length, 0);
//
//     const final = structuredClone(runningWithTimestamps);
//     final.taskStatus = 'stopped';
//     final.updatedAt = '2026-08-22T04:00:00.000Z';
//     current.setAuthoritative(final);
//     current.manager.publish();
//     await new Promise((resolve) => setImmediate(resolve));
//
//     assert.deepEqual(
//         sent.map((update) => update.type),
//         ['session_info_replace']
//     );
//     current.publishRaw(text('first'), 's1', 'stopped');
//     await new Promise((resolve) => setImmediate(resolve));
//
//     assert.equal(current.feed.phase, 'live');
//     assert.deepEqual(
//         sent.map((update) => update.type),
//         ['session_info_replace', 'assistant_timestamp_state', 'assistant_timestamp_state']
//     );
//     assert.deepEqual(
//         sent.reduce((value, update) => applyPublicSessionUpdate(value, update), initial),
//         final
//     );
//     current.feed.stop();
// });
//
// test('manager stopped defers a content gap but stopped task content still fails closed', async () => {
//     const initial = textState('base');
//     const current = fixture(initial);
//     const sent: PublicSessionUpdate[] = [];
//     await current.feed.activate(async (update) => {
//         sent.push(update);
//     });
//     const final = textState('missing');
//     const message = final.history.messages[0];
//     if (message.role !== 'assistant') throw new Error('expected assistant message');
//     message.timestamp = 9;
//     final.taskStatus = 'stopped';
//     current.setAuthoritative(final);
//
//     current.manager.publish();
//     await new Promise((resolve) => setImmediate(resolve));
//
//     assert.equal(current.feed.phase, 'live');
//     assert.equal(current.fatalCalls(), 0);
//     assert.deepEqual(
//         sent.map((update) => update.type),
//         ['session_info_replace']
//     );
//
//     current.publishRaw(text('base'), 's1', 'stopped');
//     await new Promise((resolve) => setImmediate(resolve));
//
//     assert.equal(current.feed.phase, 'stopped');
//     assert.equal(current.fatalCalls(), 1);
//     assert.deepEqual(
//         sent.map((update) => update.type),
//         ['session_info_replace']
//     );
// });

test('rejects a part hole and releases both observers with one fatal notification', () => {
    const current = fixture();
    const subscriber = current.task.subscribers[0];
    current.publishRaw({
        type: 'part_state',
        messageId: 'a1',
        role: 'assistant',
        partIndex: 2,
        part: { type: 'text', text: 'hole' }
    });
    assert.equal(current.feed.phase, 'stopped');
    assert.equal(current.fatalCalls(), 1);
    assert.equal(subscriber.isAvailable(), false);
    assert.equal(current.task.subscribers.length, 0);
    assert.equal(current.manager.subscribers.length, 0);
    assert.doesNotThrow(() => current.task.publish(text('late')));
    assert.equal(current.fatalCalls(), 1);
});

test('authorization loss from the manager fails closed before emitting stale info', async () => {
    const current = fixture();
    const sent: PublicSessionUpdate[] = [];
    await current.feed.activate(async (update) => {
        sent.push(update);
    });
    current.revoke();
    assert.equal(current.feed.phase, 'stopped');
    assert.equal(current.fatalCalls(), 1);
    assert.deepEqual(sent, []);
});

test('waits only the frozen prefix and uses one serial consumer', async () => {
    const current = fixture();
    current.publish(text('p1'));
    current.publish(text('p2'));
    const started: string[] = [];
    const resolvers = new Map<string, () => void>();
    let concurrent = 0;
    let maximum = 0;
    const frozen = current.feed.activate(async (update) => {
        const value = update.type === 'part_state' && update.part.type === 'text' ? update.part.text : '';
        started.push(value);
        concurrent += 1;
        maximum = Math.max(maximum, concurrent);
        await new Promise<void>((resolve) => resolvers.set(value, resolve));
        concurrent -= 1;
    });
    await new Promise((resolve) => setImmediate(resolve));
    current.publish(text('live3'));
    assert.deepEqual(started, ['p1']);
    resolvers.get('p1')!();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started, ['p1', 'p2']);
    resolvers.get('p2')!();
    await frozen;
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started, ['p1', 'p2', 'live3']);
    assert.equal(maximum, 1);
    resolvers.get('live3')!();
    current.feed.stop();
});

test('stop is synchronous and idempotent, drops unstarted work and rejects the frozen waiter', async () => {
    const current = fixture();
    current.publish(text('p1'));
    current.publish(text('p2'));
    const started: string[] = [];
    let release!: () => void;
    const frozen = current.feed.activate(async (update) => {
        const value = update.type === 'part_state' && update.part.type === 'text' ? update.part.text : '';
        started.push(value);
        await new Promise<void>((resolve) => {
            release = resolve;
        });
    });
    await new Promise((resolve) => setImmediate(resolve));
    current.feed.stop(new Error('stop'));
    current.feed.stop();
    await assert.rejects(frozen, /stop/);
    assert.equal(current.feed.phase, 'stopped');
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started, ['p1']);
    assert.equal(current.task.subscribers.length, 0);
    assert.equal(current.manager.subscribers.length, 0);
});

test('consumer rejection stops the feed and reports fatal once', async () => {
    const current = fixture();
    await current.feed.activate(async () => {
        throw new Error('send failed');
    });
    current.publish(text('will-fail'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(current.feed.phase, 'stopped');
    assert.equal(current.fatalCalls(), 1);
    assert.equal(current.task.subscribers.length, 0);
    assert.equal(current.manager.subscribers.length, 0);
});

test('fails closed when unstarted live backlog exceeds the shared state budget', async () => {
    const current = fixture();
    let release!: () => void;
    await current.feed.activate(async () => {
        await new Promise<void>((resolve) => {
            release = resolve;
        });
    });
    for (let ordinal = 0; ordinal < 12 && current.feed.phase !== 'stopped'; ordinal += 1) {
        const suffix = String(ordinal).padStart(2, '0');
        current.publish(text(`${'x'.repeat(PUBLIC_TEXT_MAX_BYTES - suffix.length)}${suffix}`));
        // An intervening metadata event is a barrier and cannot be discarded to make room.
        current.replaceInfo({
            title: suffix,
            cwd: '/work',
            updatedAt: state().updatedAt,
            taskStatus: 'running',
            completionStatus: null,
            runToken: state().runToken
        });
    }
    assert.equal(current.feed.phase, 'stopped');
    assert.equal(current.fatalCalls(), 1);
    assert.equal(current.task.subscribers.length, 0);
    assert.equal(current.manager.subscribers.length, 0);
    release();
    await new Promise((resolve) => setImmediate(resolve));
});

test('projects normal append, overwrite and ignored private chunks through the public identity port', () => {
    const task = sourceTask({
        messages: [{ role: 'assistant', message_id: 'existing', content: [{ type: 'text', text: 'old' }] }]
    });
    const identityPlan = createPublicSessionIdentifierPlan(
        's1',
        collectPublicSessionIdentifierCandidates(task.chat_context.messages)
    );
    const part = { type: 'text' as const, text: 'full' };
    task.chat_context.messages.push({ role: 'assistant', message_id: 'new', timestamp: 17, content: [part] });
    assert.deepEqual(
        projectPublicPartState(
            task,
            {
                type: 'assistant',
                task_id: 's1',
                message_id: 'new',
                last_part_index: 0,
                last_part: part
            },
            identityPlan
        ),
        {
            type: 'part_state',
            messageId: identityPlan.messageId(1),
            role: 'assistant',
            partIndex: 0,
            part: { type: 'text', text: 'full' },
            messageTimestamp: 17
        }
    );
    const shortened = { type: 'text' as const, text: 'short' };
    const appended = task.chat_context.messages[1];
    assert.equal(appended.role, 'assistant');
    appended.content[0] = shortened;
    assert.deepEqual(
        projectPublicPartState(
            task,
            {
                type: 'assistant',
                task_id: 's1',
                message_id: 'new',
                last_part_index: 0,
                last_part: shortened
            },
            identityPlan
        ),
        {
            type: 'part_state',
            messageId: identityPlan.messageId(1),
            role: 'assistant',
            partIndex: 0,
            part: { type: 'text', text: 'short' }
        }
    );
    assert.equal(projectTaskChunk(task, { type: 'retry', task_id: 's1' }, identityPlan), undefined);
    assert.equal(projectTaskChunk(task, { type: 'goal_eval', task_id: 's1' }, identityPlan), undefined);
    assert.equal(projectTaskChunk(task, { type: 'compact', task_id: 's1' }, identityPlan), undefined);
});

test('atomically rebinds deterministic tool identities for a replacement reorder and append', () => {
    const firstPart = {
        type: 'tool_call' as const,
        toolcalls: [
            { id: 'tool-a', tool_name: 'readFile', status: 'success' as const, result: 'a' },
            { id: 'tool-b', tool_name: 'grepFiles', status: 'success' as const, result: 'b' }
        ]
    };
    const task = sourceTask({ messages: [{ role: 'assistant', message_id: 'source', content: [firstPart] }] });
    const identityPlan = createPublicSessionIdentifierPlan(
        's1',
        collectPublicSessionIdentifierCandidates(task.chat_context.messages)
    );
    const replacement = {
        type: 'tool_call' as const,
        toolcalls: [
            { id: 'tool-b', tool_name: 'grepFiles', status: 'running' as const, result: '' },
            { id: 'tool-new', tool_name: 'readFile', status: 'pending' as const, result: '' }
        ]
    };
    const message = task.chat_context.messages[0];
    assert.equal(message.role, 'assistant');
    message.content = [replacement];
    const update = projectPublicMessageReplacement(
        task,
        {
            type: 'assistant_replace',
            task_id: 's1',
            message_id: 'source',
            parts: [replacement]
        },
        identityPlan
    );
    if (!update || update.message.role !== 'assistant') throw new Error('expected assistant replacement');
    const toolPart = update.message.parts[0];
    if (toolPart.type !== 'tool_call') throw new Error('expected tool part');
    assert.deepEqual(
        toolPart.toolCalls.map((call) => call.toolCallId),
        ['tool-b', 'tool-new']
    );
    assert.equal(identityPlan.toolCallId(0, 0, 0), 'tool-b');
    assert.equal(identityPlan.toolCallId(0, 0, 1), 'tool-new');
});
