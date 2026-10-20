import assert from 'node:assert/strict';
import test from 'node:test';
import * as acp from '@agentclientprotocol/sdk';
import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import { MobileAcpAgentAdapter } from '../../../../../main/applications/mobileaccess/acp/mobile/acp-endpoint/agent-adapter.js';
import { deriveRunToken } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session-identifiers.js';
import type { PublicSessionState } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session.js';
import type { PublicSessionSyncHandle } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session-sync.js';
import {
    RemoteSessionConfigurationError,
    type RemoteSessionService
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/service.js';

const state = (sessionId: string): PublicSessionState => ({
    sessionId,
    title: sessionId,
    cwd: '/work',
    updatedAt: '2026-09-03T00:00:00.000Z',
    taskStatus: 'running',
    completionStatus: null,
    runToken: deriveRunToken(sessionId, 1),
    history: { messages: [] }
});

function feed(sessionId: string): PublicSessionSyncHandle {
    let phase: PublicSessionSyncHandle['phase'] = 'buffering';
    return {
        sessionId,
        get phase() {
            return phase;
        },
        installFatalSink() {},
        async activate() {
            phase = 'live';
        },
        stop() {
            phase = 'stopped';
        }
    };
}

const alpha = {
    current: { modelAlias: 'alpha', reasoningEffort: '' as const },
    candidates: [{ modelAlias: 'alpha', reasoningEfforts: ['', 'high'] as const }]
};
const beta = {
    current: { modelAlias: 'beta', reasoningEffort: 'max' as const },
    candidates: [{ modelAlias: 'beta', reasoningEfforts: ['', 'max'] as const }]
};

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function harness(options: { set?: RemoteSessionService['setSessionModelConfiguration'] } = {}) {
    const controller = new AbortController();
    let cleanup: () => void = () => undefined;
    const calls: unknown[][] = [];
    const service: RemoteSessionService = {
        listSessions: async () => [],
        stopCurrentRun() {},
        startPrompt: async () => {
            throw new Error('unused');
        },
        beginSessionLoad(sessionId) {
            return { snapshot: state(sessionId), sync: feed(sessionId), configuration: alpha };
        },
        setSessionModelConfiguration(sessionId, selection) {
            calls.push([sessionId, selection]);
            return options.set ? options.set(sessionId, selection) : beta;
        }
    };
    const connection = {
        sessionUpdate: async () => undefined,
        requestPermission: async () => ({ outcome: { outcome: 'cancelled' as const } })
    } as unknown as AgentSideConnection;
    const adapter = new MobileAcpAgentAdapter(
        connection,
        controller.signal,
        service,
        () => undefined,
        () => undefined,
        (callback) => {
            cleanup = callback;
        }
    );
    return { adapter, controller, calls, cleanup: () => cleanup() };
}

const load = (sessionId: string): acp.LoadSessionRequest => ({ sessionId, cwd: '/work', mcpServers: [] });
const set = (sessionId: string): acp.SetSessionConfigOptionRequest => ({
    sessionId,
    configId: 'opendesk.model_effort',
    value: '["beta","max"]'
});

test('load returns configOptions and set returns the full confirmed snapshot', async () => {
    const h = harness();
    const loaded = await h.adapter.loadSession(load('s1'));
    assert.equal(loaded.configOptions?.[0]?.id, 'opendesk.model_effort');
    const result = await h.adapter.setSessionConfigOption(set('s1'));
    assert.deepEqual(h.calls, [['s1', { modelAlias: 'beta', reasoningEffort: 'max' }]]);
    assert.equal(result.configOptions[0]?.currentValue, '["beta","max"]');
});

test('rejects a mismatched session, unknown id, noncanonical value, and boolean before RSS', async () => {
    for (const params of [
        set('s2'),
        { ...set('s1'), configId: 'unknown' },
        { ...set('s1'), value: '["beta", "max"]' },
        { sessionId: 's1', configId: 'opendesk.model_effort', type: 'boolean' as const, value: true }
    ]) {
        const h = harness();
        await h.adapter.loadSession(load('s1'));
        await assert.rejects(() => h.adapter.setSessionConfigOption(params as acp.SetSessionConfigOptionRequest));
        assert.equal(h.calls.length, 0);
    }
});

test('maps RSS errors to a fixed sanitized profile', async () => {
    for (const code of ['session_unavailable', 'selection_unavailable', 'host_failure'] as const) {
        const h = harness({
            set() {
                throw new RemoteSessionConfigurationError(code, { cause: new Error('/private/path/config.json') });
            }
        });
        await h.adapter.loadSession(load('s1'));
        await assert.rejects(
            () => h.adapter.setSessionConfigOption(set('s1')),
            (error: unknown) => {
                assert.ok(error instanceof acp.RequestError);
                assert.deepEqual(error.data, {
                    opendesk: { sessionConfiguration: { schemaVersion: 1, code } }
                });
                assert.doesNotMatch(error.message, /private\/path/);
                return true;
            }
        );
    }
});

test('connection close before completion never confirms an old set', async () => {
    const pending = deferred<typeof beta>();
    const h = harness({
        set: (() => pending.promise) as unknown as RemoteSessionService['setSessionModelConfiguration']
    });
    await h.adapter.loadSession(load('s1'));
    const operation = h.adapter.setSessionConfigOption(set('s1'));
    h.controller.abort(new Error('closed'));
    h.cleanup();
    pending.resolve(beta);
    await assert.rejects(operation);
    assert.equal(h.calls.length, 1);
});
