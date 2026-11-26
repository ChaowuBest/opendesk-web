import assert from 'node:assert/strict';
import test from 'node:test';
import type {
    PublicSessionState,
    PublicSessionUpdate
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session.js';
import type {
    RemoteSessionCreationService,
    RemoteSessionService
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/service.js';
import type { PublicSessionSyncHandle } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session-sync.js';
import {
    deriveRunToken,
    type PublicSessionIdentifierPlanFactory
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session-identifiers.js';
import {
    observePublicSessionTrace,
    type PublicSessionTraceSnapshot
} from '../../../../../main/applications/mobileaccess/acp/mobile/testing/public-session-trace.js';

const snapshot: PublicSessionState = {
    sessionId: 's1',
    title: 'Secret title',
    cwd: '/secret/cwd',
    updatedAt: '2026-08-22T00:00:00.000Z',
    taskStatus: 'running',
    completionStatus: null,
    runToken: deriveRunToken('s1', 1),
    history: {
        messages: [{ role: 'assistant', messageId: 'a1', parts: [{ type: 'text', text: 'secret body' }] }]
    }
};

const extensionSentinel = Symbol('public-session-trace-extension');

function fixture() {
    let consumer: ((update: PublicSessionUpdate) => Promise<void>) | undefined;
    let phase: PublicSessionSyncHandle['phase'] = 'buffering';
    let stopCalls = 0;
    const interactiveValues: Array<boolean | undefined> = [];
    const remoteStopCalls: Array<[string, string]> = [];
    const sync: PublicSessionSyncHandle = {
        sessionId: 's1',
        get phase() {
            return phase;
        },
        installFatalSink() {},
        async activate(next) {
            consumer = next;
            phase = 'live';
        },
        stop() {
            stopCalls += 1;
            phase = 'stopped';
        }
    };
    const delegate: RemoteSessionService & RemoteSessionCreationService & { [extensionSentinel]: object } = {
        [extensionSentinel]: Object.freeze({ preserved: true }),
        async resolveDefaultWorkspace() {
            return { workspace: '/extension-workspace' };
        },
        async createSession(input) {
            return { kind: 'created', sessionId: 'extension-session', workspace: input.workspace };
        },
        stopCurrentRun(sessionId, runToken) {
            remoteStopCalls.push([sessionId, runToken]);
        },
        async listSessions() {
            return [];
        },
        setSessionModelConfiguration() {
            throw new Error('configuration_unavailable');
        },
        async startPrompt(_sessionId, _text, interactive) {
            interactiveValues.push(interactive);
            return { kind: 'recorded_not_started', userMessageId: 'message-1' };
        },
        beginSessionLoad() {
            return { snapshot, sync };
        }
    };
    return {
        delegate,
        emit: async (update: PublicSessionUpdate) => consumer?.(update),
        stopCalls: () => stopCalls,
        interactiveValues,
        remoteStopCalls
    };
}

test('forwards stop through the public trace wrapper without rewriting identity', () => {
    const source = fixture();
    const observed = observePublicSessionTrace(source.delegate, () => undefined);
    assert.equal(observed[extensionSentinel], source.delegate[extensionSentinel]);
    assert.equal(observed.createSession, source.delegate.createSession);
    observed.stopCurrentRun('s1', 'token');
    assert.deepEqual(source.remoteStopCalls, [['s1', 'token']]);
});

test('emits scalar snapshot/live hashes and releases trace state on stop', async () => {
    const source = fixture();
    const traces: PublicSessionTraceSnapshot[] = [];
    const observed = observePublicSessionTrace(source.delegate, (value) => traces.push(value));
    const begun = observed.beginSessionLoad('s1', (() => undefined) as unknown as PublicSessionIdentifierPlanFactory);
    assert.equal(traces[0].feedPhase, 'buffering');
    assert.equal(traces[0].messageCount, 1);
    assert.match(traces[0].stateHash ?? '', /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(traces[0]), /Secret title|secret body|\/secret\/cwd/);

    const delivered: PublicSessionUpdate[] = [];
    await begun.sync.activate(async (update) => {
        delivered.push(update);
    });
    const update: PublicSessionUpdate = {
        type: 'part_state',
        messageId: 'a1',
        role: 'assistant',
        partIndex: 0,
        part: { type: 'text', text: 'changed secret' }
    };
    await source.emit(update);
    assert.deepEqual(delivered, [update]);
    assert.equal(traces.at(-1)?.lastUpdateType, 'part_state');
    assert.notEqual(traces.at(-1)?.stateHash, traces[0].stateHash);
    begun.sync.stop();
    assert.equal(source.stopCalls(), 1);
    assert.deepEqual(traces.at(-1), { messageCount: 0, partCount: 0, publicBytes: 0, feedPhase: 'stopped' });
});

test('forwards the optional interactive prompt flag without interpreting it', async () => {
    const source = fixture();
    const observed = observePublicSessionTrace(source.delegate, () => undefined);
    await observed.startPrompt('s1', 'local');
    await observed.startPrompt('s1', 'mobile', true);
    assert.deepEqual(source.interactiveValues, [undefined, true]);
});

test('does not swallow consumer rejection or emit raw error detail', async () => {
    const source = fixture();
    const traces: PublicSessionTraceSnapshot[] = [];
    const observed = observePublicSessionTrace(source.delegate, (value) => traces.push(value));
    const begun = observed.beginSessionLoad('s1', (() => undefined) as unknown as PublicSessionIdentifierPlanFactory);
    await begun.sync.activate(async () => {
        throw new Error('consumer secret');
    });
    await assert.rejects(
        source.emit({
            type: 'part_state',
            messageId: 'a1',
            role: 'assistant',
            partIndex: 0,
            part: { type: 'text', text: 'changed secret' }
        }),
        /consumer secret/
    );
    assert.doesNotMatch(JSON.stringify(traces), /consumer secret|changed secret/);
});
