import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as acp from '@agentclientprotocol/sdk';
import type { Client } from '@agentclientprotocol/sdk';
import { MobileAcpConnectionHost } from '../../../../../main/applications/mobileaccess/acp/mobile/acp-endpoint/connection-host.js';
import {
    applyPublicSessionUpdate,
    type PublicSessionState,
    type PublicSessionUpdate
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session.js';
import type { RemoteSessionService } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/service.js';
import { createRemoteSessionService } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/service.js';
import { deriveRunToken } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session-identifiers.js';
import type {
    PublicSessionSyncHandle,
    PublicSessionSyncPhase,
    RemoteTaskManagerSubscriber,
    RemoteTaskUpdateSubscriber
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session-sync.js';
import { createInteractionSessionScopeResolver } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/session-projector.js';
import { createAcpMessageStream } from '../../../../../main/applications/mobileaccess/acp/mobile/transport/acp-message-stream.js';
import { sourceTask, unavailableSessionConfigurationBinding } from './session-projector-fixtures.js';
import { createTestChannelPair } from './test-channel.js';

const MESSAGE_ID = '550e8400-e29b-41d4-a716-446655440000';

const textUpdate = (text: string): Extract<PublicSessionUpdate, { type: 'part_state' }> => ({
    type: 'part_state',
    role: 'assistant',
    messageId: MESSAGE_ID,
    partIndex: 0,
    part: { type: 'text', text }
});

class IntegrationFeed implements PublicSessionSyncHandle {
    phase: PublicSessionSyncPhase = 'buffering';
    private consumer?: (update: PublicSessionUpdate) => Promise<void>;
    private pending: PublicSessionUpdate[] = [];
    private serial = Promise.resolve();

    constructor(readonly sessionId: string) {}

    installFatalSink(): void {}

    stage(update: PublicSessionUpdate): void {
        this.pending.push(update);
    }

    async activate(consumer: (update: PublicSessionUpdate) => Promise<void>): Promise<void> {
        this.consumer = consumer;
        this.phase = 'live';
        const frozen = this.pending;
        this.pending = [];
        for (const update of frozen) await consumer(update);
    }

    publish(update: PublicSessionUpdate): Promise<void> {
        this.serial = this.serial.then(() => this.consumer?.(update)).then(() => undefined);
        return this.serial;
    }

    stop(): void {
        this.phase = 'stopped';
        this.pending = [];
        this.consumer = undefined;
    }
}

function frameText(frame: Record<string, unknown>): string | undefined {
    const params = frame.params as { update?: { content?: { type?: string; text?: string } } } | undefined;
    return params?.update?.content?.type === 'text' ? params.update.content.text : undefined;
}

function assistantSource(text: string) {
    return {
        role: 'assistant' as const,
        message_id: 'source-message',
        content: [{ type: 'text' as const, text }]
    };
}

async function openSdkConnection(host: MobileAcpConnectionHost, connectionId: string) {
    const [clientChannel, serverChannel] = createTestChannelPair();
    const hosted = host.open(serverChannel, { connectionId });
    const updates: acp.SessionNotification[] = [];
    const binding = createAcpMessageStream(clientChannel, new AbortController());
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
    return { client, hosted, updates };
}

test('keeps T0-pending-live continuous over the real SDK and a substitutable text port', async () => {
    const snapshot: PublicSessionState = {
        sessionId: 's1',
        title: 'Session',
        cwd: '/work',
        updatedAt: '2026-08-22T00:00:00.000Z',
        taskStatus: 'running',
        completionStatus: null,
        runToken: deriveRunToken('s1', 1),
        history: { messages: [{ role: 'assistant', messageId: MESSAGE_ID, parts: [{ type: 'text', text: 'A' }] }] }
    };
    let authoritative = snapshot;
    const feed = new IntegrationFeed('s1');
    const pending = textUpdate('AB');
    authoritative = applyPublicSessionUpdate(authoritative, pending);
    feed.stage(pending);
    const service: RemoteSessionService = {
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
        beginSessionLoad() {
            return { snapshot, sync: feed };
        }
    };
    const [clientPort, serverPort] = createTestChannelPair();
    const host = new MobileAcpConnectionHost({ remoteSessionService: service, diagnose: () => undefined });
    const hosted = host.open(serverPort, {});
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
    await client.loadSession({ sessionId: 's1', cwd: '/work', mcpServers: [] });
    const live = textUpdate('ABC');
    authoritative = applyPublicSessionUpdate(authoritative, live);
    await feed.publish(live);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(
        updates.map((value) => value.update.sessionUpdate),
        ['session_info_update', 'agent_message_chunk', 'agent_message_chunk', 'agent_message_chunk']
    );
    assert.deepEqual(
        updates.map((value) => frameText({ params: value })),
        [undefined, 'A', 'AB', 'ABC']
    );
    assert.equal(
        authoritative.history.messages[0].role === 'assistant' &&
            authoritative.history.messages[0].parts[0].type === 'text'
            ? authoritative.history.messages[0].parts[0].text
            : undefined,
        'ABC'
    );

    const frames = serverPort.sent.map((value) => JSON.parse(value) as Record<string, unknown>);
    const pendingOrdinal = frames.findIndex((frame) => frameText(frame) === 'AB');
    const responseOrdinal = frames.findIndex((frame, index) => index > pendingOrdinal && 'result' in frame);
    const liveOrdinal = frames.findIndex((frame) => frameText(frame) === 'ABC');
    assert.ok(pendingOrdinal >= 0 && responseOrdinal > pendingOrdinal && liveOrdinal > responseOrdinal);
    await hosted.close();
});

test('a closed SDK connection cannot leak its subscriber into a fresh connection snapshot or live stream', async () => {
    const task = sourceTask({ messages: [assistantSource('A0')] });
    const taskSubscribers: RemoteTaskUpdateSubscriber[] = [];
    const managerSubscribers: RemoteTaskManagerSubscriber[] = [];
    const subscribeEvents: string[] = [];
    let taskUnsubscribeCount = 0;
    let managerUnsubscribeCount = 0;
    const service = createRemoteSessionService(
        {
            ...unavailableSessionConfigurationBinding,
            getTaskList: () => [task],
            getTaskLoadResult: (sessionId) => ({
                task: sessionId === task.task_id ? task : undefined,
                corrupted: false
            }),
            getDefaultWorkspace: () => '/work',
            subscribeTaskUpdates(_task, subscriber) {
                taskSubscribers.push(subscriber);
                const ordinal = taskSubscribers.length;
                subscribeEvents.push(`task-subscribe-${ordinal}`);
                let removed = false;
                return () => {
                    if (removed) return;
                    removed = true;
                    taskUnsubscribeCount += 1;
                    subscribeEvents.push(`task-unsubscribe-${ordinal}`);
                };
            },
            subscribeTaskManagerUpdates(subscriber) {
                managerSubscribers.push(subscriber);
                const ordinal = managerSubscribers.length;
                subscribeEvents.push(`manager-subscribe-${ordinal}`);
                let removed = false;
                return () => {
                    if (removed) return;
                    removed = true;
                    managerUnsubscribeCount += 1;
                    subscribeEvents.push(`manager-unsubscribe-${ordinal}`);
                };
            }
        },
        {
            resolveInteractionSessionScope: createInteractionSessionScopeResolver(() => [task])
        }
    );
    const host = new MobileAcpConnectionHost({ remoteSessionService: service, diagnose: () => undefined });
    const connectionA = await openSdkConnection(host, 'A');
    let connectionB: Awaited<ReturnType<typeof openSdkConnection>> | undefined;
    try {
        await connectionA.client.loadSession({ sessionId: 's1', cwd: '/work', mcpServers: [] });
        assert.equal(taskSubscribers.length, 1);
        assert.equal(managerSubscribers.length, 1);
        const subscriberA = taskSubscribers[0];

        const aReadLoop = connectionA.client.closed;
        const aHostReadLoop = connectionA.hosted.closed;
        await connectionA.hosted.close();
        await Promise.all([aReadLoop, aHostReadLoop]);
        assert.equal(taskUnsubscribeCount, 1);
        assert.equal(managerUnsubscribeCount, 1);

        task.chat_context.messages = [assistantSource('B0')];
        connectionB = await openSdkConnection(host, 'B');
        await connectionB.client.loadSession({ sessionId: 's1', cwd: '/work', mcpServers: [] });
        assert.equal(taskSubscribers.length, 2);
        assert.equal(managerSubscribers.length, 2);
        assert.deepEqual(subscribeEvents.slice(0, 6), [
            'task-subscribe-1',
            'manager-subscribe-1',
            'task-unsubscribe-1',
            'manager-unsubscribe-1',
            'task-subscribe-2',
            'manager-subscribe-2'
        ]);
        assert.deepEqual(
            connectionB.updates.map((value) => frameText({ params: value })),
            [undefined, 'B0']
        );

        const aLatePart = { type: 'text' as const, text: 'A-late' };
        task.chat_context.messages = [{ role: 'assistant', message_id: 'source-message', content: [aLatePart] }];
        subscriberA.send({
            type: 'assistant',
            task_id: 's1',
            message_id: 'source-message',
            last_part_index: 0,
            last_part: aLatePart
        });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(
            connectionB.updates.some((value) => frameText({ params: value }) === 'A-late'),
            false
        );

        const bLivePart = { type: 'text' as const, text: 'B-live' };
        task.chat_context.messages = [{ role: 'assistant', message_id: 'source-message', content: [bLivePart] }];
        taskSubscribers[1].send({
            type: 'assistant',
            task_id: 's1',
            message_id: 'source-message',
            last_part_index: 0,
            last_part: bLivePart
        });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(
            connectionB.updates.some((value) => frameText({ params: value }) === 'B-live'),
            true
        );
    } finally {
        if (connectionB) {
            const bReadLoop = connectionB.client.closed;
            const bHostReadLoop = connectionB.hosted.closed;
            await connectionB.hosted.close();
            await Promise.all([bReadLoop, bHostReadLoop]);
        }
        await host.close();
    }
    assert.equal(taskUnsubscribeCount, 2);
    assert.equal(managerUnsubscribeCount, 2);
});

test('formal live modules remain independent of Test Transport and future DataChannel details', () => {
    const root = new URL('../../../../../main/applications/mobileaccess/acp/mobile/', import.meta.url);
    const names = [
        'remote-session-service/public-session.ts',
        'remote-session-service/session-projector.ts',
        'remote-session-service/public-session-sync.ts',
        'remote-session-service/service.ts',
        'acp-endpoint/session-notification-encoder.ts',
        'acp-endpoint/agent-adapter.ts',
        'acp-endpoint/connection-host.ts'
    ];
    const forbidden = /WebSocket|\/testing\/|streamEpoch|reset_snapshot|\brevision\b|\bresume\b|\back\b/i;
    for (const name of names) assert.doesNotMatch(readFileSync(new URL(name, root), 'utf8'), forbidden);
    assert.doesNotMatch(
        readFileSync(new URL('remote-session-service/public-session-sync.ts', root), 'utf8'),
        /@agentclientprotocol\/sdk/
    );
    assert.doesNotMatch(
        readFileSync(new URL('acp-endpoint/session-notification-encoder.ts', root), 'utf8'),
        /aikernel\/states|TaskManager|TaskState/
    );
});
