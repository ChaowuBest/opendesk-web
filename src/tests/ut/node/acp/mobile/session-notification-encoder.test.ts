import assert from 'node:assert/strict';
import test from 'node:test';
import * as acp from '@agentclientprotocol/sdk';
import { SessionNotificationEncoder } from '../../../../../main/applications/mobileaccess/acp/mobile/acp-endpoint/session-notification-encoder.js';
import type {
    PublicAssistantPart,
    PublicSessionState,
    PublicSessionUpdate,
    PublicToolCall
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session.js';
import { PublicSessionProjectionError } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session.js';
import { deriveRunToken } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session-identifiers.js';

const MESSAGE_ID = '550e8400-e29b-41d4-a716-446655440000';

function openDeskMeta(notification: acp.SessionNotification): Record<string, unknown> {
    const meta = notification.update._meta;
    assert.ok(meta && typeof meta === 'object');
    const openDesk = (meta as Record<string, unknown>).opendesk;
    assert.ok(openDesk && typeof openDesk === 'object');
    return openDesk as Record<string, unknown>;
}

function baseSnapshot(parts: PublicAssistantPart[] = []): PublicSessionState {
    return {
        sessionId: 's1',
        title: 'Session',
        cwd: '/work',
        updatedAt: '2026-08-22T00:00:00.000Z',
        taskStatus: 'running',
        completionStatus: null,
        runToken: deriveRunToken('s1', 1),
        history: {
            messages: [{ role: 'assistant', messageId: MESSAGE_ID, timestamp: 1, parts }]
        }
    };
}

function toolPartUpdate(toolCalls: PublicToolCall[]): Extract<PublicSessionUpdate, { type: 'part_state' }> {
    return {
        type: 'part_state',
        role: 'assistant',
        messageId: MESSAGE_ID,
        partIndex: 0,
        messageTimestamp: 1,
        part: { type: 'tool_call', toolCalls }
    };
}

test('sends a new tool_call then complete updates including explicit null result', () => {
    const encoder = new SessionNotificationEncoder(
        's1',
        baseSnapshot([
            {
                type: 'tool_call',
                toolCalls: [
                    {
                        toolCallId: 't1',
                        toolName: 'x',
                        status: 'running',
                        resultText: 'old'
                    }
                ]
            }
        ])
    );
    const changed = encoder.encode(
        toolPartUpdate([
            { toolCallId: 't1', toolName: 'x', status: 'success' },
            { toolCallId: 't2', toolName: 'y', status: 'pending' }
        ])
    );
    assert.deepEqual(
        changed.notifications.map((value) => value.update),
        [
            {
                sessionUpdate: 'tool_call_update',
                toolCallId: 't1',
                title: 'x',
                kind: 'other',
                status: 'completed',
                content: null,
                _meta: { opendesk: { schemaVersion: 1, messageId: MESSAGE_ID, partIndex: 0, callIndex: 0 } }
            },
            {
                sessionUpdate: 'tool_call',
                toolCallId: 't2',
                title: 'y',
                kind: 'other',
                status: 'pending',
                _meta: { opendesk: { schemaVersion: 1, messageId: MESSAGE_ID, partIndex: 0, callIndex: 1 } }
            }
        ]
    );
    assert.equal(
        encoder.encode(
            toolPartUpdate([
                { toolCallId: 't1', toolName: 'x', status: 'success' },
                { toolCallId: 't2', toolName: 'y', status: 'pending' }
            ])
        ).notifications.length,
        2
    );
    changed.commit();
    assert.deepEqual(
        encoder.encode(
            toolPartUpdate([
                { toolCallId: 't1', toolName: 'x', status: 'success' },
                { toolCallId: 't2', toolName: 'y', status: 'pending' }
            ])
        ).notifications,
        []
    );
});

test('uses true call indexes and commits a multi-call tool group only after every send', () => {
    const encoder = new SessionNotificationEncoder('s1', baseSnapshot());
    const first = encoder.encode(
        toolPartUpdate([
            { toolCallId: 't1', toolName: 'executeBash', status: 'running' },
            { toolCallId: 't2', toolName: 'readFile', status: 'success', resultText: 'done' }
        ])
    );
    assert.deepEqual(
        first.notifications.map(openDeskMeta).map((meta) => meta.callIndex),
        [0, 1]
    );
    assert.equal(first.notifications[0].update.sessionUpdate, 'tool_call');
    assert.equal(first.notifications[1].update.sessionUpdate, 'tool_call');
    assert.equal(
        encoder.encode(
            toolPartUpdate([
                { toolCallId: 't1', toolName: 'executeBash', status: 'running' },
                { toolCallId: 't2', toolName: 'readFile', status: 'success', resultText: 'done' }
            ])
        ).notifications.length,
        2
    );
    first.commit();
    assert.equal(
        encoder.encode(
            toolPartUpdate([
                { toolCallId: 't1', toolName: 'executeBash', status: 'running' },
                { toolCallId: 't2', toolName: 'readFile', status: 'success', resultText: 'done' }
            ])
        ).notifications.length,
        0
    );
});

test('encodes full text, reasoning, error, attachment and session info carriers', () => {
    const encoder = new SessionNotificationEncoder('s1', baseSnapshot());
    const inputs: PublicSessionUpdate[] = [
        {
            type: 'part_state',
            role: 'assistant',
            messageId: MESSAGE_ID,
            partIndex: 0,
            part: { type: 'text', text: 'hi' }
        },
        {
            type: 'part_state',
            role: 'assistant',
            messageId: MESSAGE_ID,
            partIndex: 1,
            part: { type: 'reasoning', content: 'why', elapsedSeconds: 0 }
        },
        {
            type: 'part_state',
            role: 'assistant',
            messageId: MESSAGE_ID,
            partIndex: 2,
            part: { type: 'error', title: 'Oops', message: 'No' }
        },
        {
            type: 'part_state',
            role: 'user',
            messageId: 'u1',
            partIndex: 0,
            messageTimestamp: 2,
            part: { type: 'unavailable_attachment', attachmentKind: 'file' }
        },
        {
            type: 'session_info_replace',
            info: {
                title: null,
                cwd: '/next',
                updatedAt: '2026-08-22T01:00:00.000Z',
                taskStatus: 'stopped',
                completionStatus: 'success',
                runToken: null
            }
        }
    ];
    assert.deepEqual(
        inputs.flatMap((input) => encoder.encode(input).notifications.map((value) => value.update.sessionUpdate)),
        [
            'agent_message_chunk',
            'agent_thought_chunk',
            'agent_message_chunk',
            'user_message_chunk',
            'session_info_update'
        ]
    );
    assert.equal(openDeskMeta(encoder.encode(inputs[1]).notifications[0]).elapsedSeconds, 0);
    assert.equal(openDeskMeta(encoder.encode(inputs[2]).notifications[0]).eventType, 'error');
    assert.equal(openDeskMeta(encoder.encode(inputs[3]).notifications[0]).eventType, 'unavailable_attachment');
});

test('preserves a generation-only run token update across commit', () => {
    const encoder = new SessionNotificationEncoder('s1', baseSnapshot());
    const first = encoder.encode({
        type: 'session_info_replace',
        info: {
            title: 'Session',
            cwd: '/work',
            updatedAt: '2026-08-22T00:00:00.000Z',
            taskStatus: 'running',
            completionStatus: null,
            runToken: deriveRunToken('s1', 2)
        }
    });
    assert.equal(openDeskMeta(first.notifications[0]).runToken, deriveRunToken('s1', 2));
    first.commit();
    const second = encoder.encode({
        type: 'session_info_replace',
        info: {
            title: 'Session',
            cwd: '/work',
            updatedAt: '2026-08-22T00:00:00.000Z',
            taskStatus: 'stopped',
            completionStatus: null,
            runToken: null
        }
    });
    assert.equal(openDeskMeta(second.notifications[0]).runToken, null);
});

test('encodes an assistant timestamp as a metadata-only mobile profile carrier', () => {
    const encoder = new SessionNotificationEncoder('s1', baseSnapshot());
    const encoded = encoder.encode({
        type: 'assistant_timestamp_state',
        messageId: MESSAGE_ID,
        timestamp: 2
    });
    assert.deepEqual(
        encoded.notifications.map((value) => value.update),
        [
            {
                sessionUpdate: 'agent_message_chunk',
                messageId: MESSAGE_ID,
                content: { type: 'text', text: '' },
                _meta: {
                    opendesk: {
                        schemaVersion: 1,
                        eventType: 'assistant_timestamp_state',
                        timestamp: 2
                    }
                }
            }
        ]
    );
});

test('wraps a complete assistant message replacement in one atomic outer notification', () => {
    const encoder = new SessionNotificationEncoder('s1', baseSnapshot());
    const encoded = encoder.encode({
        type: 'message_replace',
        message: {
            role: 'assistant',
            messageId: MESSAGE_ID,
            timestamp: 2,
            parts: [
                { type: 'reasoning', content: 'r' },
                {
                    type: 'tool_call',
                    toolCalls: [{ toolCallId: 't', toolName: 'x', status: 'success', resultText: 'done' }]
                }
            ]
        }
    });
    assert.equal(encoded.notifications.length, 1);
    const outer = encoded.notifications[0];
    assert.equal(outer.update.sessionUpdate, 'agent_message_chunk');
    assert.deepEqual(outer.update.content, { type: 'text', text: '' });
    const nested = openDeskMeta(outer).replacementUpdates;
    assert.ok(Array.isArray(nested));
    assert.equal(nested.length, 2);
    assert.equal(
        nested.some((value) => typeof value === 'object' && value !== null && 'sessionId' in value),
        false
    );
    assert.equal(
        nested.some(
            (value) =>
                typeof value === 'object' &&
                value !== null &&
                (value as { sessionUpdate?: unknown }).sessionUpdate === 'tool_call_update'
        ),
        false
    );
    encoded.commit();
    assert.deepEqual(
        encoder.encode({
            ...toolPartUpdate([{ toolCallId: 't', toolName: 'x', status: 'success', resultText: 'done' }]),
            partIndex: 1
        }).notifications,
        []
    );
});

test('encodes user and empty assistant replacements and rejects an empty user replacement', () => {
    const encoder = new SessionNotificationEncoder('s1', baseSnapshot());
    const user = encoder.encode({
        type: 'message_replace',
        message: { role: 'user', messageId: MESSAGE_ID, timestamp: 3, parts: [{ type: 'text', text: 'question' }] }
    });
    assert.equal(user.notifications[0].update.sessionUpdate, 'user_message_chunk');
    assert.deepEqual(
        (openDeskMeta(user.notifications[0]).replacementUpdates as acp.SessionUpdate[]).map(
            (value) => value.sessionUpdate
        ),
        ['user_message_chunk']
    );
    const empty = encoder.encode({
        type: 'message_replace',
        message: { role: 'assistant', messageId: MESSAGE_ID, parts: [] }
    });
    assert.equal((openDeskMeta(empty.notifications[0]).replacementUpdates as acp.SessionUpdate[]).length, 1);
    assert.throws(() =>
        encoder.encode({
            type: 'message_replace',
            message: { role: 'user', messageId: MESSAGE_ID, timestamp: 3, parts: [] }
        })
    );
});

test('rejects normal tool identity changes', () => {
    const encoder = new SessionNotificationEncoder(
        's1',
        baseSnapshot([
            {
                type: 'tool_call',
                toolCalls: [
                    {
                        toolCallId: 't1',
                        toolName: 'x',
                        status: 'running'
                    }
                ]
            }
        ])
    );
    assert.throws(() =>
        encoder.encode({
            ...toolPartUpdate([{ toolCallId: 't1', toolName: 'renamed', status: 'running' }]),
            partIndex: 1
        })
    );
});

test('dispose is idempotent and rejects every later encode without changing sent state', () => {
    const encoder = new SessionNotificationEncoder('s1', baseSnapshot());
    encoder.dispose();
    encoder.dispose();
    assert.throws(
        () => encoder.encode(toolPartUpdate([{ toolCallId: 't1', toolName: 'x', status: 'running' }])),
        (error: unknown) =>
            error instanceof PublicSessionProjectionError &&
            error.code === 'session_load_failed' &&
            error.message === 'session notification encoder is disposed'
    );
});
