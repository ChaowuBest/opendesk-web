import test from 'node:test';
import assert from 'node:assert/strict';
import * as acp from '@agentclientprotocol/sdk';
import type { AgentSideConnection, Client } from '@agentclientprotocol/sdk';
import {
    MobileAcpAgentAdapter,
    type MobileAcpDiagnosticEvent
} from '../../../../../main/applications/mobileaccess/acp/mobile/acp-endpoint/agent-adapter.js';
import { MobileAcpConnectionHost } from '../../../../../main/applications/mobileaccess/acp/mobile/acp-endpoint/connection-host.js';
import {
    RemoteSessionContractError,
    type RemoteSessionDirectoryEntry,
    type RemoteSessionService
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/service.js';
import { createAcpMessageStream } from '../../../../../main/applications/mobileaccess/acp/mobile/transport/acp-message-stream.js';
import { PublicSessionProjectionError } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session.js';
import { createTestChannelPair, TestAcpMessageChannel } from './test-channel.js';

const unavailableCapture: RemoteSessionService['beginSessionLoad'] = () => {
    throw new PublicSessionProjectionError('session_unavailable', 'fixture has no load target');
};

const unavailablePrompt: RemoteSessionService['startPrompt'] = async () => {
    throw new Error('fixture has no Prompt target');
};

const unavailableStop: RemoteSessionService['stopCurrentRun'] = () => {
    throw new Error('fixture has no stop target');
};

const unavailableConfiguration: RemoteSessionService['setSessionModelConfiguration'] = () => {
    throw new Error('fixture has no configuration target');
};

const quietClient = (): Client => ({
    async requestPermission() {
        return { outcome: { outcome: 'cancelled' } };
    },
    async sessionUpdate() {}
});

function connectClient(port: TestAcpMessageChannel) {
    const binding = createAcpMessageStream(port, new AbortController());
    return new acp.ClientSideConnection(() => quietClient(), binding.stream);
}

const entry = (sessionId: string): RemoteSessionDirectoryEntry => ({
    sessionId,
    cwd: '/work/OpenDesk',
    title: 'Existing task',
    updatedAt: '2026-08-19T01:02:03.000Z',
    taskStatus: 'running',
    completionStatus: null
});

async function openSdkPair<TTrustedContext extends object>(
    host: MobileAcpConnectionHost<TTrustedContext>,
    trustedContext: TTrustedContext
) {
    const [clientPort, serverPort] = createTestChannelPair();
    const hosted = host.open(serverPort, trustedContext);
    const client = connectClient(clientPort);
    await client.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {}
    });
    return { client, hosted };
}

test('real SDK initialize advertises load and list while listSessions maps the exact profile', async () => {
    const trustedContext = Object.freeze({ connection: 'trusted' });
    const seenQueries: object[] = [];
    const rss: RemoteSessionService = {
        beginSessionLoad: unavailableCapture,
        startPrompt: unavailablePrompt,
        stopCurrentRun: unavailableStop,
        setSessionModelConfiguration: unavailableConfiguration,
        async listSessions(query) {
            seenQueries.push(query);
            assert.deepEqual(query, {});
            return [entry('task-1')];
        }
    };
    const host = new MobileAcpConnectionHost({
        remoteSessionService: rss,
        diagnose: () => undefined,
        agentVersion: '0.3.4'
    });
    const [clientPort, serverPort] = createTestChannelPair();
    const hosted = host.open(serverPort, trustedContext);
    const client = connectClient(clientPort);

    const initialized = await client.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        _meta: { connection: 'forged' }
    });
    assert.deepEqual(initialized.agentCapabilities, { loadSession: true, sessionCapabilities: { list: {} } });

    const response = await client.listSessions({ _meta: { connection: 'forged-again' } });
    assert.deepEqual(response, {
        sessions: [
            {
                sessionId: 'task-1',
                cwd: '/work/OpenDesk',
                title: 'Existing task',
                updatedAt: '2026-08-19T01:02:03.000Z',
                _meta: {
                    opendesk: {
                        schemaVersion: 1,
                        taskStatus: 'running',
                        completionStatus: null
                    }
                }
            }
        ]
    });
    assert.equal('nextCursor' in response, false);
    assert.deepEqual(seenQueries, [{}]);
    await hosted.close();
});

test('rejects unsupported request parameters before calling RSS', async () => {
    let calls = 0;
    const rss: RemoteSessionService = {
        beginSessionLoad: unavailableCapture,
        startPrompt: unavailablePrompt,
        stopCurrentRun: unavailableStop,
        setSessionModelConfiguration: unavailableConfiguration,
        async listSessions() {
            calls += 1;
            return [];
        }
    };
    const host = new MobileAcpConnectionHost({
        remoteSessionService: rss,
        diagnose: () => undefined,
        agentVersion: 'test'
    });
    const { client, hosted } = await openSdkPair(host, Object.freeze({ connectionId: 'trusted' }));

    for (const params of [{ cwd: 'relative/path' }, { cursor: 'non-empty' }]) {
        await assert.rejects(client.listSessions(params), (error: unknown) => {
            assert.equal((error as acp.RequestError).code, -32602);
            return true;
        });
    }
    await assert.doesNotReject(client.listSessions({ cursor: '' }));
    assert.equal(calls, 1);
    await hosted.close();
});

test('passes absolute cwd only after validation', async () => {
    const trustedContext = Object.freeze({ connectionId: 'trusted-reference' });
    let seenQuery: object | undefined;
    const host = new MobileAcpConnectionHost({
        remoteSessionService: {
            beginSessionLoad: unavailableCapture,
            startPrompt: unavailablePrompt,
            stopCurrentRun: unavailableStop,
            setSessionModelConfiguration: unavailableConfiguration,
            async listSessions(query) {
                seenQuery = query;
                return [];
            }
        },
        diagnose: () => undefined
    });
    const { client, hosted } = await openSdkPair(host, trustedContext);

    await client.listSessions({ cwd: '/work/selected', _meta: { connectionId: 'forged' } });

    assert.deepEqual(seenQuery, { cwd: '/work/selected' });
    await hosted.close();
});

test('rejects before RSS when the adapter scope is already closed', async () => {
    let calls = 0;
    const scope = new AbortController();
    scope.abort();
    const adapter = new MobileAcpAgentAdapter(
        {} as AgentSideConnection,
        scope.signal,
        {
            beginSessionLoad: unavailableCapture,
            startPrompt: unavailablePrompt,
            stopCurrentRun: unavailableStop,
            setSessionModelConfiguration: unavailableConfiguration,
            async listSessions() {
                calls += 1;
                return [];
            }
        },
        () => undefined,
        () => undefined,
        () => undefined,
        'test'
    );

    await assert.rejects(adapter.listSessions({}), (error: unknown) => {
        assert.equal((error as acp.RequestError).code, -32000);
        return true;
    });
    assert.equal(calls, 0);
});

test('drops a deferred RSS result after the hosted connection closes', async () => {
    let resolveEntries!: (entries: RemoteSessionDirectoryEntry[]) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
        markStarted = resolve;
    });
    const rss: RemoteSessionService = {
        beginSessionLoad: unavailableCapture,
        startPrompt: unavailablePrompt,
        stopCurrentRun: unavailableStop,
        setSessionModelConfiguration: unavailableConfiguration,
        listSessions() {
            markStarted();
            return new Promise((resolve) => {
                resolveEntries = resolve;
            });
        }
    };
    const host = new MobileAcpConnectionHost({ remoteSessionService: rss, diagnose: () => undefined });
    const { client, hosted } = await openSdkPair(host, Object.freeze({ connectionId: 'trusted' }));
    const pending = client.listSessions({});

    await started;
    const closing = hosted.close();
    resolveEntries([entry('late-task')]);

    await assert.rejects(pending);
    await closing;
});

test('maps RSS failures to sanitized internalError and records the private cause', async () => {
    const privateFailure = new Error('db=/Users/stella/private token=secret-value');
    const diagnostics: MobileAcpDiagnosticEvent[] = [];
    const host = new MobileAcpConnectionHost({
        remoteSessionService: {
            beginSessionLoad: unavailableCapture,
            startPrompt: unavailablePrompt,
            stopCurrentRun: unavailableStop,
            setSessionModelConfiguration: unavailableConfiguration,
            async listSessions() {
                throw privateFailure;
            }
        },
        diagnose: (event) => diagnostics.push(event)
    });
    const { client, hosted } = await openSdkPair(host, Object.freeze({ connectionId: 'trusted' }));

    await assert.rejects(client.listSessions({}), (error: unknown) => {
        const requestError = error as acp.RequestError;
        assert.equal(requestError.code, -32603);
        assert.match(requestError.message, /Unable to list sessions/);
        assert.doesNotMatch(JSON.stringify(requestError), /secret-value|\/Users\/stella\/private/);
        return true;
    });
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].error, privateFailure);
    await hosted.close();
});

test('maps RSS contract failures to sanitized internalError', async () => {
    const host = new MobileAcpConnectionHost({
        remoteSessionService: {
            beginSessionLoad: unavailableCapture,
            startPrompt: unavailablePrompt,
            stopCurrentRun: unavailableStop,
            setSessionModelConfiguration: unavailableConfiguration,
            async listSessions() {
                throw new RemoteSessionContractError('Duplicate private task id');
            }
        },
        diagnose: () => undefined
    });
    const { client, hosted } = await openSdkPair(host, Object.freeze({ connectionId: 'trusted' }));

    await assert.rejects(client.listSessions({}), (error: unknown) => {
        const requestError = error as acp.RequestError;
        assert.equal(requestError.code, -32603);
        assert.doesNotMatch(JSON.stringify(requestError), /Duplicate private task id/);
        return true;
    });
    await hosted.close();
});

test('returns every RSS entry without truncation or nextCursor', async () => {
    const host = new MobileAcpConnectionHost({
        remoteSessionService: {
            beginSessionLoad: unavailableCapture,
            startPrompt: unavailablePrompt,
            stopCurrentRun: unavailableStop,
            setSessionModelConfiguration: unavailableConfiguration,
            async listSessions() {
                return [entry('task-a'), entry('task-b')];
            }
        },
        diagnose: () => undefined
    });
    const { client, hosted } = await openSdkPair(host, Object.freeze({ connectionId: 'trusted' }));

    const response = await client.listSessions({});

    assert.deepEqual(
        response.sessions.map((session) => session.sessionId),
        ['task-a', 'task-b']
    );
    assert.equal('nextCursor' in response, false);
    await hosted.close();
});
