import assert from 'node:assert/strict';
import test from 'node:test';
import * as acp from '@agentclientprotocol/sdk';
import { encodeSessionSnapshot } from '../../../../../main/applications/mobileaccess/acp/mobile/acp-endpoint/session-notification-encoder.js';
import { sessionNotificationWireBytes } from '../../../../../main/applications/mobileaccess/acp/mobile/acp-endpoint/session-message-mapper.js';
import type { PublicSessionState } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session.js';
import { deriveRunToken } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session-identifiers.js';

const V = '550e8400-e29b-41d4-a716-446655440000';

function openDeskMeta(notification: acp.SessionNotification): Record<string, unknown> {
    const meta = notification.update._meta;
    assert.ok(meta && typeof meta === 'object');
    const openDesk = (meta as Record<string, unknown>).opendesk;
    assert.ok(openDesk && typeof openDesk === 'object');
    return openDesk as Record<string, unknown>;
}

test('encodes every snapshot carrier in exact order without forbidden fields', () => {
    const state: PublicSessionState = {
        sessionId: 's1',
        title: null,
        cwd: '/work',
        updatedAt: '2026-08-22T00:00:00.000Z',
        taskStatus: 'stopped',
        completionStatus: 'success',
        runToken: null,
        history: {
            messages: [
                {
                    role: 'user',
                    messageId: V,
                    timestamp: 1,
                    parts: [
                        { type: 'text', text: '' },
                        { type: 'unavailable_attachment', attachmentKind: 'file' }
                    ]
                },
                { role: 'assistant', messageId: '6ba7b811-9dad-11d1-80b4-00c04fd430c8', timestamp: 2, parts: [] },
                {
                    role: 'assistant',
                    messageId: '6ba7b812-9dad-11d1-80b4-00c04fd430c8',
                    parts: [
                        { type: 'reasoning', content: 'think', elapsedSeconds: 0 },
                        {
                            type: 'tool_call',
                            toolCalls: [
                                {
                                    toolCallId: 't1',
                                    toolName: 'executeBash',
                                    status: 'success',
                                    resultText: 'done'
                                }
                            ]
                        },
                        { type: 'error', title: 'Title', message: 'Message' }
                    ]
                },
                { role: 'compact_boundary' }
            ]
        }
    };
    const first = encodeSessionSnapshot(state);
    assert.deepEqual(encodeSessionSnapshot(state), first);
    assert.deepEqual(
        first.notifications.map((value) => value.update.sessionUpdate),
        [
            'session_info_update',
            'user_message_chunk',
            'user_message_chunk',
            'agent_message_chunk',
            'agent_thought_chunk',
            'tool_call',
            'agent_message_chunk',
            'agent_message_chunk'
        ]
    );
    assert.deepEqual(first.notifications[0], {
        sessionId: 's1',
        update: {
            sessionUpdate: 'session_info_update',
            title: null,
            updatedAt: '2026-08-22T00:00:00.000Z',
            _meta: {
                opendesk: {
                    schemaVersion: 1,
                    cwd: '/work',
                    taskStatus: 'stopped',
                    completionStatus: 'success',
                    runToken: null
                }
            }
        }
    });
    assert.equal(openDeskMeta(first.notifications[1]).timestamp, 1);
    assert.equal(openDeskMeta(first.notifications[2]).timestamp, undefined);
    assert.equal(openDeskMeta(first.notifications[3]).eventType, 'empty_message');
    assert.equal(openDeskMeta(first.notifications[4]).elapsedSeconds, 0);
    assert.deepEqual(first.notifications[5].update, {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'executeBash',
        kind: 'execute',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'done' } }],
        _meta: {
            opendesk: {
                schemaVersion: 1,
                messageId: '6ba7b812-9dad-11d1-80b4-00c04fd430c8',
                partIndex: 1,
                callIndex: 0
            }
        }
    });
    assert.equal(openDeskMeta(first.notifications[7]).eventType, 'compact_boundary');
    assert.equal('messageId' in first.notifications[7].update, false);
    const json = JSON.stringify(first.notifications);
    for (const forbidden of ['rawInput', 'rawOutput', 'locations', 'args_string', 'rendered']) {
        assert.equal(json.includes(forbidden), false);
    }
    assert.equal(
        first.wireBytes,
        first.notifications.reduce((sum, value) => sum + sessionNotificationWireBytes(value), 0)
    );
});

test('encodes running and terminal run tokens on the same snapshot info carrier', () => {
    const running: PublicSessionState = {
        sessionId: 's1',
        title: 'Session',
        cwd: '/work',
        updatedAt: '2026-08-22T00:00:00.000Z',
        taskStatus: 'running',
        completionStatus: null,
        runToken: deriveRunToken('s1', 3),
        history: { messages: [] }
    };
    const runningMeta = openDeskMeta(encodeSessionSnapshot(running).notifications[0]);
    assert.equal(runningMeta.runToken, deriveRunToken('s1', 3));
    const stoppedMeta = openDeskMeta(
        encodeSessionSnapshot({ ...running, taskStatus: 'stopped', runToken: null }).notifications[0]
    );
    assert.equal(stoppedMeta.runToken, null);
});
