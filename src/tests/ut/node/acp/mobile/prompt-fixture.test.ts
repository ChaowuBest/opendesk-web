import assert from 'node:assert/strict';
import test from 'node:test';
import {
    RemotePromptDomainError,
    type RemoteSessionCreationService,
    type RemoteSessionService
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/service.js';
import type { PublicSessionUpdate } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session.js';
import type { PublicSessionSyncHandle } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session-sync.js';
import { createPromptFixtureService } from '../../../../../main/applications/mobileaccess/acp/mobile/testing/prompt-fixture.js';
import type { PromptFaultPlan } from '../../../../../main/applications/mobileaccess/acp/mobile/testing/prompt-fixture.js';

interface Context {
    plan: PromptFaultPlan;
}

const extensionSentinel = Symbol('prompt-fixture-extension');

function fixture() {
    let consumer: ((update: PublicSessionUpdate) => Promise<void>) | undefined;
    const sync: PublicSessionSyncHandle = {
        sessionId: 's1',
        phase: 'live',
        installFatalSink() {},
        async activate(next) {
            consumer = next;
        },
        stop() {}
    };
    const calls: string[] = [];
    const stopCalls: Array<[string, string]> = [];
    const interactiveValues: Array<boolean | undefined> = [];
    const delegate: RemoteSessionService & RemoteSessionCreationService & { [extensionSentinel]: object } = {
        [extensionSentinel]: Object.freeze({ preserved: true }),
        async resolveDefaultWorkspace() {
            return { workspace: '/extension-workspace' };
        },
        async createSession(input) {
            return { kind: 'created', sessionId: 'extension-session', workspace: input.workspace };
        },
        stopCurrentRun(sessionId, runToken) {
            stopCalls.push([sessionId, runToken]);
        },
        async listSessions() {
            return [];
        },
        setSessionModelConfiguration() {
            throw new Error('configuration_unavailable');
        },
        beginSessionLoad() {
            return {
                snapshot: {
                    sessionId: 's1',
                    title: null,
                    cwd: '/tmp',
                    updatedAt: '2026-08-24T00:00:00.000Z',
                    taskStatus: 'stopped',
                    completionStatus: 'success',
                    runToken: null,
                    history: { messages: [] }
                },
                sync
            };
        },
        async startPrompt(_sessionId, _text, interactive) {
            calls.push('delegate');
            interactiveValues.push(interactive);
            return {
                kind: 'started',
                userMessageId: '550e8400-e29b-41d4-a716-446655440000',
                completion: Promise.resolve({ stoppedByUser: false })
            };
        }
    };
    return { delegate, calls, stopCalls, interactiveValues, getConsumer: () => consumer };
}

test('forwards stop through the fixture wrapper without rewriting identity', () => {
    const source = fixture();
    const context: Context = { plan: {} };
    const service = createPromptFixtureService(source.delegate, {
        getPlan: () => context.plan
    });
    assert.equal(service[extensionSentinel], source.delegate[extensionSentinel]);
    assert.equal(service.createSession, source.delegate.createSession);
    service.stopCurrentRun('s1', 'token');
    assert.deepEqual(source.stopCalls, [['s1', 'token']]);
});

test('recorded fixture emits committed user part before returning the Task error result', async () => {
    const source = fixture();
    const order: string[] = [];
    const context: Context = { plan: { promptMode: 'recorded_not_started' } };
    const service = createPromptFixtureService(source.delegate, {
        getPlan: () => context.plan,
        createUserMessageId: () => '550e8400-e29b-41d4-a716-446655440777',
        now: () => 3,
        onFixtureEvent: (event) => order.push(event)
    });
    const begun = service.beginSessionLoad('s1', (() => undefined) as never);
    const updates: PublicSessionUpdate[] = [];
    await begun.sync.activate(async (update) => {
        order.push('user_update');
        updates.push(update);
    });
    const result = await service.startPrompt('s1', 'private prompt');
    order.push('returned');

    assert.deepEqual(order, ['committed', 'user_update', 'returned']);
    assert.deepEqual(result, {
        kind: 'recorded_not_started',
        userMessageId: '550e8400-e29b-41d4-a716-446655440777'
    });
    assert.deepEqual(updates, [
        {
            type: 'part_state',
            role: 'user',
            messageId: '550e8400-e29b-41d4-a716-446655440777',
            partIndex: 0,
            part: { type: 'text', text: 'private prompt' },
            messageTimestamp: 3
        }
    ]);
    assert.deepEqual(source.calls, []);
});

test('reject-before-commit never emits a user update or calls the delegate', async () => {
    const source = fixture();
    const context: Context = { plan: { promptMode: 'reject_before_commit' } };
    const service = createPromptFixtureService(source.delegate, {
        getPlan: () => context.plan
    });
    const begun = service.beginSessionLoad('s1', (() => undefined) as never);
    const updates: PublicSessionUpdate[] = [];
    await begun.sync.activate(async (update) => {
        updates.push(update);
    });
    await assert.rejects(
        service.startPrompt('s1', 'private prompt'),
        (error: unknown) => error instanceof RemotePromptDomainError && error.code === 'prompt_failed'
    );
    assert.deepEqual(updates, []);
    assert.deepEqual(source.calls, []);
});

test('normal mode delegates and applies only the connection-local completion delay', async () => {
    const source = fixture();
    const delays: number[] = [];
    const context: Context = { plan: { promptMode: 'normal', delayPromptCompletionMs: 12 } };
    const service = createPromptFixtureService(source.delegate, {
        getPlan: () => context.plan,
        delay: async (milliseconds) => {
            delays.push(milliseconds);
        }
    });
    const started = await service.startPrompt('s1', 'private prompt', true);
    assert.equal(started.kind, 'started');
    if (started.kind === 'started') await started.completion;
    assert.deepEqual(source.calls, ['delegate']);
    assert.deepEqual(source.interactiveValues, [true]);
    assert.deepEqual(delays, [12]);
});
