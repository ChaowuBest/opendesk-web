import assert from 'node:assert/strict';
import test from 'node:test';
import {
    RemotePromptDomainError,
    type RemoteSessionCreationService,
    type RemoteSessionService
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/service.js';
import {
    observePromptTrace,
    type PromptTraceSnapshot
} from '../../../../../main/applications/mobileaccess/acp/mobile/testing/prompt-trace.js';

interface Context {
    connectionId: string;
    fixture: boolean;
    outboundOrdinal: number;
}

const extensionSentinel = Symbol('prompt-trace-extension');

type ExtendedRemoteSessionService = RemoteSessionService &
    RemoteSessionCreationService & { [extensionSentinel]: object };

function delegate(
    start: RemoteSessionService['startPrompt'],
    stop: RemoteSessionService['stopCurrentRun'] = () => {
        throw new Error('fixture has no stop target');
    }
): ExtendedRemoteSessionService {
    return {
        [extensionSentinel]: Object.freeze({ preserved: true }),
        async resolveDefaultWorkspace() {
            return { workspace: '/extension-workspace' };
        },
        async createSession(input) {
            return { kind: 'created', sessionId: 'extension-session', workspace: input.workspace };
        },
        stopCurrentRun: stop,
        async listSessions() {
            return [];
        },
        setSessionModelConfiguration() {
            throw new Error('configuration_unavailable');
        },
        beginSessionLoad() {
            throw new Error('unused');
        },
        startPrompt: start
    };
}

test('forwards stop through the trace wrapper without rewriting identity', () => {
    const calls: Array<[string, string]> = [];
    const context: Context = { connectionId: 'c1', fixture: false, outboundOrdinal: 0 };
    const source = delegate(
        async () => ({ kind: 'recorded_not_started', userMessageId: 'unused' }),
        (sessionId, runToken) => calls.push([sessionId, runToken])
    );
    const service = observePromptTrace(source, {
        connectionId: () => context.connectionId,
        outboundOrdinal: () => 0,
        fixture: () => false,
        emit: () => undefined
    });
    assert.equal(service[extensionSentinel], source[extensionSentinel]);
    assert.equal(service.createSession, source.createSession);
    service.stopCurrentRun('s1', 'token');
    assert.deepEqual(calls, [['s1', 'token']]);
});

test('records only hashed identities and scalar prompt stages', async () => {
    const traces: PromptTraceSnapshot[] = [];
    const interactiveValues: Array<boolean | undefined> = [];
    const completion = Promise.resolve({ stoppedByUser: false });
    const context: Context = { connectionId: 'c1', fixture: false, outboundOrdinal: 7 };
    const service = observePromptTrace(
        delegate(async (_sessionId, _text, interactive) => {
            interactiveValues.push(interactive);
            return {
                kind: 'started',
                userMessageId: '550e8400-e29b-41d4-a716-446655440777',
                completion
            };
        }),
        {
            connectionId: () => context.connectionId,
            outboundOrdinal: () => context.outboundOrdinal,
            fixture: () => context.fixture,
            monotonicMs: () => 42,
            emit: (snapshot) => traces.push(snapshot)
        }
    );
    const result = await service.startPrompt('/private/session', 'private prompt body', true);
    assert.equal(result.kind, 'started');
    if (result.kind === 'started') await result.completion;

    assert.deepEqual(
        traces.map((trace) => trace.stage),
        ['requested', 'committed', 'accepted', 'completed']
    );
    assert.match(traces[0].sessionIdHash, /^[a-f0-9]{64}$/);
    assert.match(traces[2].userMessageIdHash ?? '', /^[a-f0-9]{64}$/);
    assert.equal(traces[2].markerCount, 1);
    assert.equal(traces[2].outboundOrdinal, 7);
    assert.doesNotMatch(JSON.stringify(traces), /private|550e8400|prompt body/);
    assert.deepEqual(interactiveValues, [true]);
});

test('reports a sanitized failure code without raw errors', async () => {
    const traces: PromptTraceSnapshot[] = [];
    const context: Context = { connectionId: 'c1', fixture: false, outboundOrdinal: 0 };
    const service = observePromptTrace(
        delegate(async () => {
            throw new RemotePromptDomainError('task_busy', {
                cause: new Error('/private/path')
            });
        }),
        {
            connectionId: () => context.connectionId,
            outboundOrdinal: () => 0,
            fixture: () => false,
            emit: (snapshot) => traces.push(snapshot)
        }
    );
    await assert.rejects(service.startPrompt('s1', 'secret'));
    assert.deepEqual(
        traces.map((trace) => trace.stage),
        ['requested', 'failed']
    );
    assert.equal(traces[1].resultCode, 'task_busy');
    assert.doesNotMatch(JSON.stringify(traces), /private|secret|stack/);
});
