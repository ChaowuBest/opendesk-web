import assert from 'node:assert/strict';
import test from 'node:test';
import * as acp from '@agentclientprotocol/sdk';
import type { Client } from '@agentclientprotocol/sdk';
import { MobileAcpConnectionHost } from '../../../../../main/applications/mobileaccess/acp/mobile/acp-endpoint/connection-host.js';
import type {
    PublicSessionState,
    PublicSessionUpdate
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session.js';
import {
    RemotePromptContractError,
    RemotePromptDomainError,
    type RemotePromptCompletion,
    type RemotePromptStart,
    type RemoteSessionService
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/service.js';
import { deriveRunToken } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session-identifiers.js';
import type {
    PublicSessionSyncHandle,
    PublicSessionSyncPhase
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session-sync.js';
import { createAcpMessageStream } from '../../../../../main/applications/mobileaccess/acp/mobile/transport/acp-message-stream.js';
import { createTestChannelPair } from './test-channel.js';

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

function snapshot(sessionId: string): PublicSessionState {
    return {
        sessionId,
        title: sessionId,
        cwd: '/work',
        updatedAt: '2026-08-24T00:00:00.000Z',
        taskStatus: 'stopped',
        completionStatus: null,
        runToken: null,
        history: { messages: [] }
    };
}

class PromptFeed implements PublicSessionSyncHandle {
    phase: PublicSessionSyncPhase = 'buffering';
    private consumer?: (update: PublicSessionUpdate) => Promise<void>;
    private pending: PublicSessionUpdate[] = [];
    private fatalSink?: (error: Error) => void;

    constructor(readonly sessionId: string) {}

    installFatalSink(sink: (error: Error) => void): void {
        this.fatalSink = sink;
    }

    async activate(consumer: (update: PublicSessionUpdate) => Promise<void>): Promise<void> {
        this.phase = 'live';
        this.consumer = consumer;
        const pending = this.pending;
        this.pending = [];
        for (const update of pending) await consumer(update);
    }

    async publish(update: PublicSessionUpdate): Promise<void> {
        if (this.phase === 'stopped') return;
        if (this.phase === 'buffering') {
            this.pending.push(update);
            return;
        }
        try {
            await this.consumer?.(update);
        } catch (error) {
            this.stop(error instanceof Error ? error : new Error(String(error)));
            this.fatalSink?.(error instanceof Error ? error : new Error(String(error)));
            throw error;
        }
    }

    stop(_reason?: Error): void {
        this.phase = 'stopped';
        this.pending = [];
        this.consumer = undefined;
    }
}

type StartMode = 'started' | 'recorded' | 'domain_busy' | 'contract_failure';

class PromptHarness {
    readonly feeds = new Map<string, PromptFeed>();
    readonly completions: Array<ReturnType<typeof deferred<RemotePromptCompletion>>> = [];
    readonly calls: Array<{ sessionId: string; text: string }> = [];
    readonly stopCalls: Array<{ sessionId: string; runToken: string }> = [];
    readonly stopPublications: Promise<void>[] = [];
    mode: StartMode = 'started';

    readonly service: RemoteSessionService = {
        setSessionModelConfiguration() {
            throw new Error('fixture has no configuration target');
        },
        stopCurrentRun: (sessionId, runToken) => {
            assert.equal(runToken, deriveRunToken(sessionId, 1));
            const feed = this.feeds.get(sessionId);
            const completion = this.completions.at(-1);
            assert.ok(feed);
            assert.ok(completion);
            this.stopCalls.push({ sessionId, runToken });
            this.stopPublications.push(
                feed.publish({
                    type: 'session_info_replace',
                    info: {
                        title: sessionId,
                        cwd: '/work',
                        updatedAt: '2026-08-24T00:00:02.000Z',
                        taskStatus: 'stopped',
                        completionStatus: null,
                        runToken: null
                    }
                })
            );
            completion.resolve({ stoppedByUser: true });
        },
        listSessions: async () => [],
        beginSessionLoad: (sessionId) => {
            const feed = new PromptFeed(sessionId);
            this.feeds.set(sessionId, feed);
            return { snapshot: snapshot(sessionId), sync: feed };
        },
        startPrompt: async (sessionId, text) => {
            this.calls.push({ sessionId, text });
            if (this.mode === 'domain_busy') throw new RemotePromptDomainError('task_busy');
            if (this.mode === 'contract_failure') {
                throw new RemotePromptContractError('private /Users/stella contract detail');
            }
            const feed = this.feeds.get(sessionId);
            assert.ok(feed);
            await feed.publish({
                type: 'session_info_replace',
                info: {
                    title: sessionId,
                    cwd: '/work',
                    updatedAt: '2026-08-24T00:00:01.000Z',
                    taskStatus: 'running',
                    completionStatus: null,
                    runToken: deriveRunToken(sessionId, 1)
                }
            });
            await feed.publish({
                type: 'part_state',
                role: 'user',
                messageId: P,
                partIndex: 0,
                part: { type: 'text', text },
                messageTimestamp: 1
            });
            if (this.mode === 'recorded') {
                return { kind: 'recorded_not_started', userMessageId: P };
            }
            const completion = deferred<RemotePromptCompletion>();
            this.completions.push(completion);
            return { kind: 'started', userMessageId: P, completion: completion.promise };
        }
    };
}

async function waitFor(predicate: () => boolean): Promise<void> {
    for (let index = 0; index < 100; index += 1) {
        if (predicate()) return;
        await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error('condition was not reached');
}

function marker(notification: acp.SessionNotification): unknown {
    const meta = notification.update._meta as { opendesk?: { submissionState?: unknown } } | undefined;
    return meta?.opendesk?.submissionState;
}

async function openPair(harness = new PromptHarness()) {
    const diagnostics: unknown[] = [];
    const host = new MobileAcpConnectionHost({
        remoteSessionService: harness.service,
        diagnose: (event) => diagnostics.push(event)
    });
    const [clientPort, serverPort] = createTestChannelPair();
    const hosted = host.open(serverPort, Object.freeze({ connectionId: 'trusted' }));
    const updates: acp.SessionNotification[] = [];
    const binding = createAcpMessageStream(clientPort, new AbortController());
    const client = new acp.ClientSideConnection(
        (): Client => ({
            async requestPermission() {
                return { outcome: { outcome: 'cancelled' } };
            },
            async sessionUpdate(value) {
                updates.push(value);
            }
        }),
        binding.stream
    );
    await client.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    return { harness, diagnostics, host, hosted, client, clientPort, serverPort, updates };
}

const load = (sessionId = 's1'): acp.LoadSessionRequest => ({
    sessionId,
    cwd: '/work',
    mcpServers: []
});

async function expectProductCode(operation: Promise<unknown>, code: string): Promise<void> {
    await assert.rejects(operation, (error) => {
        assert.ok(error instanceof acp.RequestError);
        assert.equal(error.code, -32603);
        assert.deepEqual(error.data, { opendesk: { schemaVersion: 1, code } });
        assert.equal(JSON.stringify(error).includes('/Users/'), false);
        return true;
    });
}

test('requires the exact live session and rejects invalid blocks before RSS', async () => {
    const pair = await openPair();
    await expectProductCode(
        pair.client.prompt({ sessionId: 's1', prompt: [{ type: 'text', text: 'before load' }] }),
        'session_not_live'
    );
    assert.equal(pair.harness.calls.length, 0);
    await pair.client.loadSession(load());
    await expectProductCode(
        pair.client.prompt({ sessionId: 's2', prompt: [{ type: 'text', text: 'wrong session' }] }),
        'session_not_live'
    );
    await assert.rejects(
        pair.client.prompt({
            sessionId: 's1',
            prompt: [{ type: 'image', mimeType: 'image/png', data: 'AA==' }]
        }),
        (error) => error instanceof acp.RequestError && error.code === -32602
    );
    assert.equal(pair.harness.calls.length, 0);
    await pair.hosted.close();
});

test('sends accepted on first wire preserves FIFO and returns only at turn completion', async () => {
    const pair = await openPair();
    await pair.client.loadSession(load());
    pair.updates.length = 0;
    const pending = pair.client.prompt({
        sessionId: 's1',
        prompt: [{ type: 'text', text: 'continue from phone' }],
        _meta: { forged: { submissionState: 'accepted' } }
    });
    await waitFor(() => pair.updates.some((value) => marker(value) === 'accepted'));
    assert.deepEqual(
        pair.updates.map((value) => value.update.sessionUpdate),
        ['session_info_update', 'user_message_chunk']
    );
    assert.equal(pair.updates.filter((value) => marker(value) === 'accepted').length, 1);
    const carrier = pair.updates.find((value) => marker(value) === 'accepted');
    assert.equal(carrier?.sessionId, 's1');
    assert.equal(carrier?.update.sessionUpdate, 'user_message_chunk');
    if (carrier?.update.sessionUpdate === 'user_message_chunk') {
        assert.equal(carrier.update.messageId, P);
    }
    assert.deepEqual(pair.harness.calls, [{ sessionId: 's1', text: 'continue from phone' }]);
    assert.equal(await Promise.race([pending.then(() => 'done'), Promise.resolve('pending')]), 'pending');

    const second = pair.client.prompt({ sessionId: 's1', prompt: [{ type: 'text', text: 'second' }] });
    await expectProductCode(second, 'prompt_in_flight');
    assert.equal(pair.harness.calls.length, 1);

    pair.harness.completions[0].resolve({ stoppedByUser: false });
    const response = await pending;
    assert.deepEqual(response, { stopReason: 'end_turn' });
    await pair.hosted.close();
});

test('maps local user stop to cancelled and system or natural completion to end_turn', async () => {
    const pair = await openPair();
    await pair.client.loadSession(load());
    const first = pair.client.prompt({ sessionId: 's1', prompt: [{ type: 'text', text: 'first' }] });
    await waitFor(() => pair.harness.completions.length === 1);
    pair.harness.completions[0].resolve({ stoppedByUser: true });
    assert.deepEqual(await first, { stopReason: 'cancelled' });
    await pair.client.loadSession(load());
    const second = pair.client.prompt({ sessionId: 's1', prompt: [{ type: 'text', text: 'second' }] });
    await waitFor(() => pair.harness.completions.length === 2);
    pair.harness.completions[1].resolve({ stoppedByUser: false });
    assert.deepEqual(await second, { stopReason: 'end_turn' });
    await pair.hosted.close();
});

test('stopping a Mobile prompt resolves that same prompt as cancelled', async () => {
    const pair = await openPair();
    await pair.client.loadSession(load());
    pair.updates.length = 0;
    const prompt = pair.client.prompt({
        sessionId: 's1',
        prompt: [{ type: 'text', text: 'stop this run' }]
    });
    await waitFor(() => pair.updates.some((value) => marker(value) === 'accepted'));
    const runToken = deriveRunToken('s1', 1);
    await pair.client.cancel({
        sessionId: 's1',
        _meta: { opendesk: { schemaVersion: 1, runToken } }
    });
    await waitFor(() => pair.harness.stopPublications.length === 1);
    await pair.harness.stopPublications[0];

    assert.deepEqual(await prompt, { stopReason: 'cancelled' });
    assert.deepEqual(pair.harness.stopCalls, [{ sessionId: 's1', runToken }]);
    const terminal = pair.updates.at(-1)?.update._meta as
        | {
              opendesk?: { taskStatus?: unknown; runToken?: unknown };
          }
        | undefined;
    assert.deepEqual(terminal?.opendesk, {
        schemaVersion: 1,
        cwd: '/work',
        taskStatus: 'stopped',
        completionStatus: null,
        runToken: null
    });
    await pair.hosted.close();
});

test('delivers recorded marker before the sanitized recorded error', async () => {
    const harness = new PromptHarness();
    harness.mode = 'recorded';
    const pair = await openPair(harness);
    await pair.client.loadSession(load());
    pair.updates.length = 0;
    await expectProductCode(
        pair.client.prompt({ sessionId: 's1', prompt: [{ type: 'text', text: 'record me' }] }),
        'prompt_recorded_not_started'
    );
    assert.deepEqual(pair.updates.map(marker), [undefined, 'recorded_not_started']);
    assert.equal(pair.harness.calls.length, 1);
    await pair.hosted.close();
});

test('releases unmarked domain rejection and keeps the connection usable', async () => {
    const harness = new PromptHarness();
    harness.mode = 'domain_busy';
    const pair = await openPair(harness);
    await pair.client.loadSession(load());
    await expectProductCode(
        pair.client.prompt({ sessionId: 's1', prompt: [{ type: 'text', text: 'busy' }] }),
        'task_busy'
    );
    assert.equal(pair.updates.filter((value) => marker(value) !== undefined).length, 0);
    assert.equal(pair.harness.calls.length, 1);
    await assert.doesNotReject(pair.client.listSessions({}));
    await pair.hosted.close();
});

test('fails closed and sanitizes an internal Prompt contract failure', async () => {
    const harness = new PromptHarness();
    harness.mode = 'contract_failure';
    const pair = await openPair(harness);
    await pair.client.loadSession(load());
    await assert.rejects(
        pair.client.prompt({ sessionId: 's1', prompt: [{ type: 'text', text: 'contract' }] }),
        (error) => JSON.stringify(error).includes('/Users/') === false
    );
    await pair.hosted.closed;
    assert.equal(pair.serverPort.listenerCount, 0);
    assert.equal(pair.diagnostics.length, 1);
});

test('normal unsubscribe after accepted does not close the connection or stop completion', async () => {
    const pair = await openPair();
    await pair.client.loadSession(load('s1'));
    const pending = pair.client.prompt({ sessionId: 's1', prompt: [{ type: 'text', text: 'continue' }] });
    await waitFor(() => pair.updates.some((value) => marker(value) === 'accepted'));
    await pair.client.extNotification('_opendesk/session/unsubscribe', { sessionId: 's1' });
    await waitFor(() => pair.harness.feeds.get('s1')?.phase === 'stopped');
    assert.equal(pair.harness.feeds.get('s1')?.phase, 'stopped');
    pair.harness.completions[0].resolve({ stoppedByUser: false });
    assert.deepEqual(await pending, { stopReason: 'end_turn' });
    await assert.doesNotReject(pair.client.listSessions({}));
    await pair.hosted.close();
});

test('cancel notification and connection close never create a second submit or stop operation', async () => {
    const pair = await openPair();
    await pair.client.loadSession(load());
    const pending = pair.client.prompt({ sessionId: 's1', prompt: [{ type: 'text', text: 'long' }] });
    await waitFor(() => pair.harness.completions.length === 1);
    await pair.client.cancel({ sessionId: 's1' });
    assert.equal(pair.harness.calls.length, 1);
    pair.clientPort.close();
    await assert.rejects(pending);
    assert.equal(pair.harness.calls.length, 1);
    pair.harness.completions[0].resolve({ stoppedByUser: false });
    await pair.hosted.closed;
});
