import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import {
    MobileAcpAgentAdapter,
    type MobileAcpDiagnosticEvent
} from '../../../../../main/applications/mobileaccess/acp/mobile/acp-endpoint/agent-adapter.js';
import {
    RemoteSessionStopError,
    type RemoteSessionService
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/service.js';
import { deriveRunToken } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session-identifiers.js';

function service(stopCurrentRun: RemoteSessionService['stopCurrentRun']): RemoteSessionService {
    return {
        setSessionModelConfiguration() {
            throw new Error('fixture has no configuration target');
        },
        stopCurrentRun,
        async listSessions() {
            return [];
        },
        beginSessionLoad() {
            throw new Error('unused');
        },
        async startPrompt() {
            throw new Error('unused');
        }
    };
}

function adapter(
    options: {
        stop?: RemoteSessionService['stopCurrentRun'];
        diagnose?: (event: MobileAcpDiagnosticEvent) => void;
        aborted?: boolean;
    } = {}
) {
    const controller = new AbortController();
    if (options.aborted) controller.abort();
    let failClosed = 0;
    const instance = new MobileAcpAgentAdapter(
        {} as AgentSideConnection,
        controller.signal,
        service(options.stop ?? (() => undefined)),
        options.diagnose ?? (() => undefined),
        () => {
            failClosed += 1;
        },
        () => undefined,
        'test'
    );
    return { instance, failClosed: () => failClosed };
}

const token = deriveRunToken('s1', 7);
const valid = { sessionId: 's1', _meta: { opendesk: { schemaVersion: 1, runToken: token } } };

test('passes only the session id and parsed token to RSS', async () => {
    const calls: unknown[] = [];
    const current = adapter({
        stop: (sessionId, runToken) => {
            calls.push({ sessionId, runToken });
        }
    });
    await current.instance.cancel(valid);
    assert.deepEqual(calls, [
        {
            sessionId: 's1',
            runToken: token
        }
    ]);
    assert.equal(current.failClosed(), 0);
});

test('invalid profile is one diagnostic no-op and never reaches RSS', async () => {
    let calls = 0;
    const diagnostics: MobileAcpDiagnosticEvent[] = [];
    const current = adapter({
        stop: () => {
            calls += 1;
        },
        diagnose: (event) => diagnostics.push(event)
    });
    for (const invalid of [
        { sessionId: 's1' },
        { sessionId: '   ', _meta: { opendesk: { schemaVersion: 1, runToken: token } } },
        { sessionId: 's1', _meta: { opendesk: { schemaVersion: 1, runToken: '' } } }
    ]) {
        await current.instance.cancel(invalid);
    }
    assert.equal(calls, 0);
    assert.deepEqual(diagnostics, [
        { code: 'session_cancel_ignored', reason: 'invalid_profile' },
        { code: 'session_cancel_ignored', reason: 'invalid_profile' },
        { code: 'session_cancel_ignored', reason: 'invalid_profile' }
    ]);
    assert.equal(current.failClosed(), 0);
});

test('all RSS refusal classes and unknown exceptions resolve void without failClosed', async () => {
    const reasons = ['unavailable_or_unauthorized', 'not_running', 'stale_run'] as const;
    for (const reason of reasons) {
        const diagnostics: MobileAcpDiagnosticEvent[] = [];
        const current = adapter({
            stop: () => {
                throw new RemoteSessionStopError(reason, { cause: new Error('/secret') });
            },
            diagnose: (event) => diagnostics.push(event)
        });
        await assert.doesNotReject(current.instance.cancel(valid));
        assert.deepEqual(diagnostics, [{ code: 'session_cancel_ignored', reason }]);
        assert.equal(JSON.stringify(diagnostics).includes('secret'), false);
        assert.equal(current.failClosed(), 0);
    }
    const diagnostics: MobileAcpDiagnosticEvent[] = [];
    const unknown = adapter({
        stop: () => {
            throw new Error('/private/path token=' + token);
        },
        diagnose: (event) => diagnostics.push(event)
    });
    await assert.doesNotReject(unknown.instance.cancel(valid));
    assert.deepEqual(diagnostics, [
        {
            code: 'session_cancel_ignored',
            reason: 'unavailable_or_unauthorized'
        }
    ]);
    assert.equal(JSON.stringify(diagnostics).includes('private'), false);
});

test('diagnostic sink failure and already-aborted connection are swallowed', async () => {
    const sinkFailure = adapter({
        stop: () => {
            throw new RemoteSessionStopError('stale_run');
        },
        diagnose: () => {
            throw new Error('sink');
        }
    });
    await assert.doesNotReject(sinkFailure.instance.cancel(valid));
    assert.equal(sinkFailure.failClosed(), 0);

    let calls = 0;
    const aborted = adapter({
        aborted: true,
        stop: () => {
            calls += 1;
        }
    });
    await aborted.instance.cancel(valid);
    assert.equal(calls, 0);
    assert.equal(aborted.failClosed(), 0);
});
