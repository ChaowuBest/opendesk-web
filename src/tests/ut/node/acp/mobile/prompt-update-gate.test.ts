import assert from 'node:assert/strict';
import test from 'node:test';
import type * as acp from '@agentclientprotocol/sdk';
import {
    PromptUpdateGate,
    PromptUpdateGateError
} from '../../../../../main/applications/mobileaccess/acp/mobile/acp-endpoint/prompt-update-gate.js';
import type { EncodedPublicUpdate } from '../../../../../main/applications/mobileaccess/acp/mobile/acp-endpoint/session-notification-encoder.js';

const P = '550e8400-e29b-41d4-a716-446655440555';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}

const info = (value: string): acp.SessionNotification => ({
    sessionId: 's1',
    update: {
        sessionUpdate: 'session_info_update',
        title: value,
        updatedAt: '2026-08-24T00:00:00.000Z',
        _meta: {
            opendesk: {
                schemaVersion: 1,
                cwd: '/work',
                taskStatus: 'running',
                completionStatus: null
            }
        }
    }
});

const user = (messageId = P, partIndex = 0): acp.SessionNotification => ({
    sessionId: 's1',
    update: {
        sessionUpdate: 'user_message_chunk',
        messageId,
        content: { type: 'text', text: 'hello' },
        _meta: { opendesk: { schemaVersion: 1, partIndex, timestamp: 1 } }
    }
});

const userReplace = (messageId = P): acp.SessionNotification => ({
    sessionId: 's1',
    update: {
        sessionUpdate: 'user_message_chunk',
        messageId,
        content: { type: 'text', text: '' },
        _meta: {
            opendesk: {
                schemaVersion: 1,
                eventType: 'message_replace',
                replacementUpdates: [
                    {
                        sessionUpdate: 'user_message_chunk',
                        messageId,
                        content: { type: 'text', text: '/skillname rewritten' },
                        _meta: { opendesk: { schemaVersion: 1, partIndex: 0, timestamp: 1 } }
                    }
                ]
            }
        }
    }
});

function encoded(notifications: acp.SessionNotification[], commits: string[], name: string): EncodedPublicUpdate {
    return { notifications, commit: () => commits.push(name) };
}

function submission(notification: acp.SessionNotification): unknown {
    const meta = notification.update._meta as { opendesk?: { submissionState?: unknown } } | undefined;
    return meta?.opendesk?.submissionState;
}

function infoTitle(notification: acp.SessionNotification): string | undefined {
    return notification.update.sessionUpdate === 'session_info_update'
        ? (notification.update.title ?? undefined)
        : undefined;
}

test('keeps direct send then commit semantics', async () => {
    const sent: acp.SessionNotification[] = [];
    const commits: string[] = [];
    const wire = new PromptUpdateGate({
        sessionId: 's1',
        send: async (value) => void sent.push(structuredClone(value)),
        onFatal: (error) => assert.fail(error)
    });
    await wire.consume(encoded([info('a'), info('b')], commits, 'direct'));
    assert.deepEqual(sent.map(infoTitle), ['a', 'b']);
    assert.deepEqual(commits, ['direct']);
});

test('buffers complete batches commits immediately and drains FIFO with accepted in place', async () => {
    const sent: acp.SessionNotification[] = [];
    const commits: string[] = [];
    const wire = new PromptUpdateGate({
        sessionId: 's1',
        send: async (value) => void sent.push(structuredClone(value)),
        onFatal: (error) => assert.fail(error)
    });
    const window = wire.beginPrompt();
    await wire.consume(encoded([info('before')], commits, 'before'));
    await wire.consume(encoded([user()], commits, 'user'));
    await wire.consume(encoded([info('after')], commits, 'after'));
    assert.deepEqual(commits, ['before', 'user', 'after']);
    assert.equal(sent.length, 0);

    await window.markAndDrain(P, 'accepted');
    await wire.whenDirect();

    assert.deepEqual(
        sent.map((value) => value.update.sessionUpdate),
        ['session_info_update', 'user_message_chunk', 'session_info_update']
    );
    assert.equal(submission(sent[1]), 'accepted');
    assert.equal(submission(user()), undefined);
    assert.equal(wire.phase, 'direct');
});

test('marks only the original user part when slash-skill replacement shares the window', async () => {
    const sent: acp.SessionNotification[] = [];
    const wire = new PromptUpdateGate({
        sessionId: 's1',
        send: async (value) => void sent.push(structuredClone(value)),
        onFatal: (error) => assert.fail(error)
    });
    const replacement = userReplace();
    const expectedReplacement = structuredClone(replacement);
    const window = wire.beginPrompt();
    await wire.consume(encoded([user(), replacement, info('tail')], [], 'slash-skill'));
    await window.markAndDrain(P, 'accepted');
    await wire.whenDirect();

    assert.deepEqual(
        sent.map((value) => value.update.sessionUpdate),
        ['user_message_chunk', 'user_message_chunk', 'session_info_update']
    );
    assert.equal(submission(sent[0]), 'accepted');
    assert.equal(submission(sent[1]), undefined);
    assert.deepEqual(sent[1], expectedReplacement);
    const nested = (
        sent[1].update._meta as {
            opendesk: { replacementUpdates: acp.SessionUpdate[] };
        }
    ).opendesk.replacementUpdates;
    assert.equal(
        nested.some((value) => submission({ sessionId: 's1', update: value })),
        false
    );
});

test('releases the buffered prefix and marks a target that arrives from upstream later', async () => {
    const firstSend = deferred<void>();
    const sent: acp.SessionNotification[] = [];
    const commits: string[] = [];
    let ordinal = 0;
    const wire = new PromptUpdateGate({
        sessionId: 's1',
        send: async (value) => {
            sent.push(structuredClone(value));
            if (++ordinal === 1) await firstSend.promise;
        },
        onFatal: (error) => assert.fail(error)
    });
    const window = wire.beginPrompt();
    await wire.consume(encoded([info('prefix')], commits, 'prefix'));
    const delivered = window.markAndDrain(P, 'recorded_not_started');
    await Promise.resolve();
    await wire.consume(encoded([user(), info('tail')], commits, 'target'));
    firstSend.resolve();
    await delivered;
    await wire.whenDirect();

    assert.deepEqual(
        sent.map((value) => value.update.sessionUpdate),
        ['session_info_update', 'user_message_chunk', 'session_info_update']
    );
    assert.equal(submission(sent[1]), 'recorded_not_started');
    assert.deepEqual(commits, ['prefix', 'target']);
});

test('resolves marker delivery only after the target notification is sent', async () => {
    const targetSend = deferred<void>();
    let resolved = false;
    const wire = new PromptUpdateGate({
        sessionId: 's1',
        send: async (value) => {
            if (value.update.sessionUpdate === 'user_message_chunk') await targetSend.promise;
        },
        onFatal: (error) => assert.fail(error)
    });
    const window = wire.beginPrompt();
    await wire.consume(encoded([user()], [], 'user'));
    const delivery = window.markAndDrain(P, 'accepted').then(() => (resolved = true));
    await Promise.resolve();
    assert.equal(resolved, false);
    targetSend.resolve();
    await delivery;
    assert.equal(resolved, true);
});

test('releases an explicit pre-P rejection without adding any marker', async () => {
    const sent: acp.SessionNotification[] = [];
    const wire = new PromptUpdateGate({
        sessionId: 's1',
        send: async (value) => void sent.push(structuredClone(value)),
        onFatal: (error) => assert.fail(error)
    });
    const window = wire.beginPrompt();
    await wire.consume(encoded([info('concurrent PC update')], [], 'info'));
    await window.releaseUnmarked();
    assert.equal(sent.length, 1);
    assert.equal(submission(sent[0]), undefined);
    assert.equal(wire.phase, 'direct');
});

test('never marks the wrong session role id or part and fails duplicate target classification', async () => {
    const wrongSession = { ...user(), sessionId: 's2' };
    const wrongId = user('550e8400-e29b-41d4-a716-446655440999');
    const wrongPart = user(P, 1);
    const assistant: acp.SessionNotification = {
        sessionId: 's1',
        update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: P,
            content: { type: 'text', text: 'assistant' },
            _meta: { opendesk: { schemaVersion: 1, partIndex: 0, timestamp: 1 } }
        }
    };
    const wire = new PromptUpdateGate({
        sessionId: 's1',
        send: async () => undefined,
        onFatal: () => undefined
    });
    const window = wire.beginPrompt();
    await wire.consume(encoded([wrongSession, wrongId, wrongPart, assistant, user(), user()], [], 'mixed'));
    await assert.rejects(window.markAndDrain(P, 'accepted'), PromptUpdateGateError);
    assert.equal(submission(wrongSession), undefined);
    assert.equal(submission(wrongId), undefined);
    assert.equal(submission(wrongPart), undefined);
    assert.equal(submission(assistant), undefined);
});

test('enforces the 8 MiB queued wire limit and fails closed', async () => {
    const fat = user();
    if (fat.update.sessionUpdate !== 'user_message_chunk' || fat.update.content.type !== 'text') {
        assert.fail('expected user text');
    }
    fat.update.content.text = 'x'.repeat(8 * 1024 * 1024);
    const fatals: Error[] = [];
    const wire = new PromptUpdateGate({
        sessionId: 's1',
        send: async () => undefined,
        onFatal: (error) => fatals.push(error)
    });
    wire.beginPrompt();
    await assert.rejects(wire.consume(encoded([fat], [], 'fat')), PromptUpdateGateError);
    assert.equal(wire.phase, 'stopped');
    assert.equal(fatals.length, 1);
    assert.equal(wire.bufferedWireBytes, 0);
});

test('send failure rejects waiters clears state and invokes fatal once', async () => {
    const fatals: Error[] = [];
    const wire = new PromptUpdateGate({
        sessionId: 's1',
        send: async () => {
            throw new Error('send failed');
        },
        onFatal: (error) => fatals.push(error)
    });
    const window = wire.beginPrompt();
    await wire.consume(encoded([user()], [], 'user'));
    await assert.rejects(window.markAndDrain(P, 'accepted'));
    assert.equal(wire.phase, 'stopped');
    assert.equal(fatals.length, 1);
    assert.equal(wire.bufferedWireBytes, 0);
});

test('normal stop rejects the bound window without calling fatal or retaining references', async () => {
    const fatals: Error[] = [];
    const wire = new PromptUpdateGate({
        sessionId: 's1',
        send: async () => undefined,
        onFatal: (error) => fatals.push(error)
    });
    const window = wire.beginPrompt();
    const delivery = window.markAndDrain(P, 'accepted');
    wire.stop(new Error('normal session switch'));
    await assert.rejects(delivery);
    assert.equal(fatals.length, 0);
    assert.equal(wire.phase, 'stopped');
    assert.equal(wire.bufferedWireBytes, 0);
});

test('keeps one FIFO when one hundred batches append during drain', async () => {
    const firstSend = deferred<void>();
    const sent: number[] = [];
    let blocked = true;
    const wire = new PromptUpdateGate({
        sessionId: 's1',
        send: async (value) => {
            const title = infoTitle(value);
            if (typeof title === 'string') sent.push(Number(title));
            if (blocked) {
                blocked = false;
                await firstSend.promise;
            }
        },
        onFatal: (error) => assert.fail(error)
    });
    const window = wire.beginPrompt();
    await wire.consume(encoded([info('1')], [], '1'));
    const draining = window.releaseUnmarked();
    await Promise.resolve();
    for (let ordinal = 2; ordinal <= 100; ordinal += 1) {
        await wire.consume(encoded([info(String(ordinal))], [], String(ordinal)));
    }
    firstSend.resolve();
    await draining;
    assert.deepEqual(
        sent,
        Array.from({ length: 100 }, (_, index) => index + 1)
    );
});

test('rejects a second simultaneous annotation window', () => {
    const wire = new PromptUpdateGate({
        sessionId: 's1',
        send: async () => undefined,
        onFatal: (error) => assert.fail(error)
    });
    wire.beginPrompt();
    assert.throws(() => wire.beginPrompt(), PromptUpdateGateError);
});
