import assert from 'node:assert/strict';
import test from 'node:test';
import * as acp from '@agentclientprotocol/sdk';
import type { Client } from '@agentclientprotocol/sdk';
import { MobileAcpConnectionHost } from '../../../../../main/applications/mobileaccess/acp/mobile/acp-endpoint/connection-host.js';
import type {
    PublicSessionState,
    PublicSessionUpdate
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session.js';
import type { RemoteSessionService } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/service.js';
import { deriveRunToken } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session-identifiers.js';
import type {
    PublicSessionSyncHandle,
    PublicSessionSyncPhase
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session-sync.js';
import { createAcpMessageStream } from '../../../../../main/applications/mobileaccess/acp/mobile/transport/acp-message-stream.js';
import { createTestChannelPair, TestAcpMessageChannel } from './test-channel.js';

const MESSAGE_ID = '550e8400-e29b-41d4-a716-446655440000';

const snapshot = (sessionId: string): PublicSessionState => ({
    sessionId,
    title: sessionId,
    cwd: '/work',
    updatedAt: '2026-08-22T00:00:00.000Z',
    taskStatus: 'running',
    completionStatus: null,
    runToken: deriveRunToken(sessionId, 1),
    history: { messages: [{ role: 'assistant', messageId: MESSAGE_ID, parts: [{ type: 'text', text: 'initial' }] }] }
});

const textUpdate = (text: string): PublicSessionUpdate => ({
    type: 'part_state',
    role: 'assistant',
    messageId: MESSAGE_ID,
    partIndex: 0,
    part: { type: 'text', text }
});

class ControlledFeed implements PublicSessionSyncHandle {
    phase: PublicSessionSyncPhase = 'buffering';
    private pending: PublicSessionUpdate[] = [];
    private consumer?: (update: PublicSessionUpdate) => Promise<void>;
    private fatalSink?: (error: Error) => void;
    private serial = Promise.resolve();
    stopCalls = 0;

    constructor(readonly sessionId: string) {}

    installFatalSink(sink: (error: Error) => void): void {
        this.fatalSink = sink;
    }

    async activate(consumer: (update: PublicSessionUpdate) => Promise<void>): Promise<void> {
        assert.equal(this.phase, 'buffering');
        this.phase = 'live';
        this.consumer = consumer;
        const frozen = this.pending;
        this.pending = [];
        try {
            for (const update of frozen) await consumer(update);
        } catch (error) {
            const failure = error instanceof Error ? error : new Error(String(error));
            this.stop();
            this.fatalSink?.(failure);
            throw failure;
        }
    }

    publish(update: PublicSessionUpdate): Promise<void> {
        if (this.phase === 'stopped') return Promise.resolve();
        if (this.phase === 'buffering') {
            this.pending.push(update);
            return Promise.resolve();
        }
        this.serial = this.serial
            .then(() => this.consumer?.(update))
            .then(
                () => undefined,
                (error) => {
                    this.stop();
                    this.fatalSink?.(error instanceof Error ? error : new Error(String(error)));
                }
            );
        return this.serial;
    }

    fail(error = new Error('controlled feed fatal')): void {
        if (this.phase === 'stopped') return;
        this.stop();
        this.fatalSink?.(error);
    }

    stop(): void {
        if (this.phase === 'stopped') return;
        this.stopCalls += 1;
        this.phase = 'stopped';
        this.pending = [];
        this.consumer = undefined;
    }
}

function updateText(notification: acp.SessionNotification): string | undefined {
    if (
        notification.update.sessionUpdate !== 'agent_message_chunk' &&
        notification.update.sessionUpdate !== 'agent_thought_chunk' &&
        notification.update.sessionUpdate !== 'user_message_chunk'
    )
        return undefined;
    const content = notification.update.content;
    return content?.type === 'text' ? content.text : undefined;
}

async function waitFor(predicate: () => boolean): Promise<void> {
    for (let index = 0; index < 100; index += 1) {
        if (predicate()) return;
        await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error('condition was not reached');
}

async function openLivePair(options: { sessionInvalidation?: boolean } = {}) {
    const feeds = new Map<string, ControlledFeed>();
    const failures = new Set<string>();
    const rss: RemoteSessionService = {
        setSessionModelConfiguration() {
            throw new Error('fixture has no configuration target');
        },
        stopCurrentRun() {
            throw new Error('fixture has no stop target');
        },
        async listSessions() {
            return [];
        },
        async startPrompt() {
            throw new Error('fixture has no Prompt target');
        },
        beginSessionLoad(sessionId) {
            if (failures.has(sessionId)) throw new Error(`private failure ${sessionId}`);
            const feed = new ControlledFeed(sessionId);
            feeds.set(sessionId, feed);
            return { snapshot: snapshot(sessionId), sync: feed };
        }
    };
    const [clientPort, serverPort] = createTestChannelPair();
    const host = new MobileAcpConnectionHost({ remoteSessionService: rss, diagnose: () => undefined });
    const hosted = host.open(serverPort, {});
    const updates: acp.SessionNotification[] = [];
    const extensions: Array<{ method: string; params: Record<string, unknown> }> = [];
    const binding = createAcpMessageStream(clientPort, new AbortController());
    const client = new acp.ClientSideConnection(
        (): Client => ({
            async requestPermission() {
                return { outcome: { outcome: 'cancelled' } };
            },
            async sessionUpdate(value) {
                updates.push(value);
            },
            async extNotification(method, params) {
                extensions.push({ method, params });
            }
        }),
        binding.stream
    );
    await client.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: options.sessionInvalidation
            ? { _meta: { opendesk: { sessionInvalidation: { schemaVersion: 1 } } } }
            : {}
    });
    return { client, hosted, host, clientPort, serverPort, feeds, failures, updates, extensions };
}

const load = (sessionId: string): acp.LoadSessionRequest => ({ sessionId, cwd: '/work', mcpServers: [] });

const invalidProjectionUpdate = (): PublicSessionUpdate =>
    ({
        type: 'part_state',
        role: 'user',
        messageId: MESSAGE_ID,
        partIndex: 0,
        part: { type: 'tool_call', toolCalls: [] }
    }) as unknown as PublicSessionUpdate;

test('sends frozen pending before the load response and continues live afterward', async () => {
    const pair = await openLivePair();
    pair.serverPort.afterSend = () => {
        const feed = pair.feeds.get('A');
        if (feed?.phase === 'buffering' && pair.updates.length === 1) void feed.publish(textUpdate('pending'));
    };
    const response = await pair.client.loadSession(load('A'));
    assert.deepEqual(response, {});
    assert.deepEqual(pair.updates.map(updateText), [undefined, 'initial', 'pending']);
    await pair.feeds.get('A')!.publish(textUpdate('live'));
    await waitFor(() => pair.updates.some((value) => updateText(value) === 'live'));
    assert.equal(pair.feeds.get('A')!.phase, 'live');
    await pair.hosted.close();
});

test('A to B stops A first and a B failure never restores it', async () => {
    const pair = await openLivePair();
    await pair.client.loadSession(load('A'));
    const aFeed = pair.feeds.get('A')!;
    pair.failures.add('B');
    await assert.rejects(pair.client.loadSession(load('B')));
    assert.equal(aFeed.phase, 'stopped');
    const before = pair.updates.length;
    await aFeed.publish(textUpdate('late-A'));
    assert.equal(pair.updates.length, before);
    await pair.hosted.close();
});

test('wrong and repeated unsubscribe are no-ops while the matching one stops only the feed', async () => {
    const pair = await openLivePair();
    await pair.client.loadSession(load('A'));
    const feed = pair.feeds.get('A')!;
    await pair.client.extNotification('_opendesk/session/unsubscribe', { sessionId: 'B' });
    assert.equal(feed.phase, 'live');
    await pair.client.extNotification('_opendesk/session/unsubscribe', { sessionId: 'A' });
    await pair.client.extNotification('_opendesk/session/unsubscribe', { sessionId: 'A' });
    assert.equal(feed.phase, 'stopped');
    await assert.doesNotReject(pair.client.listSessions({}));
    await pair.hosted.close();
});

test('rejects a concurrent load while the first snapshot send is blocked and releases it after failure', async () => {
    const pair = await openLivePair();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
        release = resolve;
    });
    let block = true;
    pair.serverPort.beforeSend = async () => {
        if (block) {
            block = false;
            await blocked;
        }
    };
    const first = pair.client.loadSession(load('A'));
    await new Promise((resolve) => setImmediate(resolve));
    const second = pair.client.loadSession(load('B'));
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await assert.rejects(second, (error: unknown) => {
        assert.deepEqual((error as acp.RequestError).data, {
            opendesk: { schemaVersion: 1, code: 'session_load_failed' }
        });
        return true;
    });
    await first;
    await pair.hosted.close();
});

test('a post-response live send failure stops the feed and fails the connection closed', async () => {
    const pair = await openLivePair({ sessionInvalidation: true });
    await pair.client.loadSession(load('A'));
    const feed = pair.feeds.get('A')!;
    pair.serverPort.failSendWith = new Error('injected live send failure');
    await feed.publish(textUpdate('will-fail'));
    await pair.hosted.closed;
    assert.equal(feed.phase, 'stopped');
    assert.equal(pair.serverPort.listenerCount, 0);
    assert.equal(pair.extensions.length, 0);
});

test('a committed RSS fatal invalidates once and keeps the connection usable', async () => {
    const pair = await openLivePair({ sessionInvalidation: true });
    await pair.client.loadSession(load('A'));
    const feed = pair.feeds.get('A')!;
    const cause = new Error('committed continuity failure');
    feed.fail(cause);
    feed.fail(cause);
    await waitFor(() => pair.extensions.length === 1);
    assert.equal(feed.phase, 'stopped');
    assert.equal(feed.stopCalls, 1);
    assert.deepEqual(pair.extensions, [
        {
            method: '_opendesk/session/invalidated',
            params: { schemaVersion: 1, sessionId: 'A' }
        }
    ]);
    await assert.doesNotReject(pair.client.listSessions({}));
    assert.equal(pair.serverPort.events.filter((value) => value === 'port-close').length, 0);
    await pair.hosted.close();
});

test('a committed fatal without invalidation capability fails the connection closed', async () => {
    const pair = await openLivePair();
    await pair.client.loadSession(load('A'));
    pair.feeds.get('A')!.fail();
    await pair.hosted.closed;
    assert.equal(pair.extensions.length, 0);
    assert.equal(pair.serverPort.events.filter((value) => value === 'port-close').length, 1);
});

test('Session invalidation send rejection upgrades to one Connection close', async () => {
    const pair = await openLivePair({ sessionInvalidation: true });
    await pair.client.loadSession(load('A'));
    pair.serverPort.failSendWith = new Error('invalidation send rejected');
    pair.feeds.get('A')!.fail();
    await pair.hosted.closed;
    assert.equal(pair.extensions.length, 0);
    assert.equal(pair.serverPort.events.filter((value) => value === 'port-close').length, 1);
});

test('an Active Load fatal remains request-local and never sends invalidation', async () => {
    const pair = await openLivePair({ sessionInvalidation: true });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
        release = resolve;
    });
    pair.serverPort.beforeSend = () => blocked;
    const loading = pair.client.loadSession(load('A'));
    await waitFor(() => pair.feeds.has('A'));
    pair.feeds.get('A')!.fail(new Error('T0 continuity failure'));
    release();
    await assert.rejects(loading);
    assert.equal(pair.extensions.length, 0);
    await assert.doesNotReject(pair.client.listSessions({}));
    await pair.hosted.close();
});

test('an Active Load encoder projection fatal remains request-local', async () => {
    const pair = await openLivePair({ sessionInvalidation: true });
    pair.serverPort.afterSend = () => {
        const feed = pair.feeds.get('A');
        if (feed?.phase === 'buffering' && pair.updates.length === 1) {
            void feed.publish(invalidProjectionUpdate());
        }
    };

    await assert.rejects(pair.client.loadSession(load('A')));
    assert.equal(pair.extensions.length, 0);
    assert.equal(pair.serverPort.events.filter((value) => value === 'port-close').length, 0);
    await assert.doesNotReject(pair.client.listSessions({}));
    await pair.hosted.close();
});

test('a committed encoder projection fatal invalidates without closing the connection', async () => {
    const pair = await openLivePair({ sessionInvalidation: true });
    await pair.client.loadSession(load('A'));

    await pair.feeds.get('A')!.publish(invalidProjectionUpdate());
    await waitFor(() => pair.extensions.length === 1);

    assert.deepEqual(pair.extensions, [
        {
            method: '_opendesk/session/invalidated',
            params: { schemaVersion: 1, sessionId: 'A' }
        }
    ]);
    assert.equal(pair.serverPort.events.filter((value) => value === 'port-close').length, 0);
    await assert.doesNotReject(pair.client.listSessions({}));
    await pair.hosted.close();
});
