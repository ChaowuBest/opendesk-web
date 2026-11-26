/// <reference types="node" />

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    PUBLIC_TEXT_MAX_BYTES,
    applyPublicSessionUpdate,
    type PublicSessionState,
    type PublicSessionUpdate
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session.js';
import { deriveRunToken } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session-identifiers.js';

const base = (): PublicSessionState => ({
    sessionId: 's1',
    title: 'Session',
    cwd: '/work',
    updatedAt: '2026-08-22T00:00:00.000Z',
    taskStatus: 'running',
    completionStatus: null,
    runToken: deriveRunToken('s1', 1),
    history: {
        messages: [
            {
                role: 'assistant',
                messageId: 'a1',
                timestamp: 1,
                parts: [{ type: 'text', text: 'hello' }]
            }
        ]
    }
});

test('applies the frozen cross-platform append/overwrite/tool/info vector exactly', () => {
    let state = base();
    state = applyPublicSessionUpdate(state, {
        type: 'part_state',
        messageId: 'u2',
        role: 'user',
        partIndex: 0,
        messageTimestamp: 2,
        part: { type: 'text', text: 'question' }
    });
    state = applyPublicSessionUpdate(state, {
        type: 'part_state',
        messageId: 'a3',
        role: 'assistant',
        partIndex: 0,
        part: {
            type: 'tool_call',
            toolCalls: [
                {
                    toolCallId: 't1',
                    toolName: 'readFile',
                    status: 'running'
                }
            ]
        }
    });
    state = applyPublicSessionUpdate(state, {
        type: 'part_state',
        messageId: 'a3',
        role: 'assistant',
        partIndex: 0,
        part: {
            type: 'tool_call',
            toolCalls: [
                { toolCallId: 't1', toolName: 'readFile', status: 'success', resultText: 'done' },
                { toolCallId: 't2', toolName: 'grepFiles', status: 'pending' }
            ]
        }
    });
    state = applyPublicSessionUpdate(state, {
        type: 'session_info_replace',
        info: {
            title: null,
            cwd: '/next',
            updatedAt: '2026-08-22T02:00:00.000Z',
            taskStatus: 'stopped',
            completionStatus: 'success',
            runToken: null
        }
    });
    assert.deepEqual(state, {
        sessionId: 's1',
        title: null,
        cwd: '/next',
        updatedAt: '2026-08-22T02:00:00.000Z',
        taskStatus: 'stopped',
        completionStatus: 'success',
        runToken: null,
        history: {
            messages: [
                { role: 'assistant', messageId: 'a1', timestamp: 1, parts: [{ type: 'text', text: 'hello' }] },
                { role: 'user', messageId: 'u2', timestamp: 2, parts: [{ type: 'text', text: 'question' }] },
                {
                    role: 'assistant',
                    messageId: 'a3',
                    parts: [
                        {
                            type: 'tool_call',
                            toolCalls: [
                                { toolCallId: 't1', toolName: 'readFile', status: 'success', resultText: 'done' },
                                { toolCallId: 't2', toolName: 'grepFiles', status: 'pending' }
                            ]
                        }
                    ]
                }
            ]
        }
    });
});

test('rejects role, timestamp, part type and tool continuity changes', () => {
    const state = applyPublicSessionUpdate(base(), {
        type: 'part_state',
        messageId: 'a1',
        role: 'assistant',
        partIndex: 1,
        part: { type: 'tool_call', toolCalls: [{ toolCallId: 't1', toolName: 'readFile', status: 'running' }] }
    });
    for (const update of [
        { type: 'part_state', messageId: 'a1', role: 'user', partIndex: 0, part: { type: 'text', text: 'x' } },
        {
            type: 'part_state',
            messageId: 'a1',
            role: 'assistant',
            partIndex: 0,
            messageTimestamp: 2,
            part: { type: 'text', text: 'x' }
        },
        {
            type: 'part_state',
            messageId: 'a1',
            role: 'assistant',
            partIndex: 0,
            part: { type: 'reasoning', content: 'x' }
        },
        {
            type: 'part_state',
            messageId: 'a1',
            role: 'assistant',
            partIndex: 1,
            part: { type: 'tool_call', toolCalls: [] }
        },
        {
            type: 'part_state',
            messageId: 'a1',
            role: 'assistant',
            partIndex: 1,
            part: { type: 'tool_call', toolCalls: [{ toolCallId: 't1', toolName: 'renamed', status: 'running' }] }
        }
    ] as PublicSessionUpdate[]) {
        assert.throws(() => applyPublicSessionUpdate(state, update));
    }
});

test('rejects missing/role-changing replacements, duplicate identities and field limits', () => {
    const state = base();
    assert.throws(() =>
        applyPublicSessionUpdate(state, {
            type: 'message_replace',
            message: { role: 'assistant', messageId: 'missing', parts: [] }
        })
    );
    assert.throws(() =>
        applyPublicSessionUpdate(state, {
            type: 'message_replace',
            message: { role: 'user', messageId: 'a1', timestamp: 1, parts: [{ type: 'text', text: 'x' }] }
        })
    );
    assert.throws(() =>
        applyPublicSessionUpdate(state, {
            type: 'part_state',
            messageId: 'a2',
            role: 'assistant',
            partIndex: 0,
            part: {
                type: 'tool_call',
                toolCalls: [
                    { toolCallId: 'same', toolName: 'x', status: 'pending' },
                    { toolCallId: 'same', toolName: 'y', status: 'pending' }
                ]
            }
        })
    );
    assert.throws(() =>
        applyPublicSessionUpdate(state, {
            type: 'part_state',
            messageId: 'a1',
            role: 'assistant',
            partIndex: 0,
            part: { type: 'text', text: 'x'.repeat(PUBLIC_TEXT_MAX_BYTES + 1) }
        })
    );
});

test('applies the four public update variants without mutating the input', () => {
    const state = base();
    const before = structuredClone(state);
    const part: PublicSessionUpdate = {
        type: 'part_state',
        messageId: 'a1',
        role: 'assistant',
        partIndex: 0,
        messageTimestamp: 1,
        part: { type: 'text', text: 'short' }
    };
    const changed = applyPublicSessionUpdate(state, part);
    assert.equal(
        changed.history.messages[0].role === 'assistant' && changed.history.messages[0].parts[0].type === 'text'
            ? changed.history.messages[0].parts[0].text
            : undefined,
        'short'
    );
    assert.deepEqual(state, before);
    const replaced = applyPublicSessionUpdate(changed, {
        type: 'message_replace',
        message: { role: 'assistant', messageId: 'a1', parts: [] }
    });
    assert.deepEqual(replaced.history.messages, [{ role: 'assistant', messageId: 'a1', parts: [] }]);
    const info = applyPublicSessionUpdate(replaced, {
        type: 'session_info_replace',
        info: {
            title: null,
            cwd: '/next',
            updatedAt: '2026-08-22T01:00:00.000Z',
            taskStatus: 'stopped',
            completionStatus: 'success',
            runToken: null
        }
    });
    assert.equal(info.cwd, '/next');
    assert.equal(info.sessionId, 's1');
    const timestamped = applyPublicSessionUpdate(info, {
        type: 'assistant_timestamp_state',
        messageId: 'a1',
        timestamp: 2
    });
    assert.equal(timestamped.history.messages[0].role, 'assistant');
    assert.equal(timestamped.history.messages[0].timestamp, 2);
});

test('atomically replaces the run token with info and terminal null', () => {
    const running = applyPublicSessionUpdate(base(), {
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
    assert.equal(running.runToken, deriveRunToken('s1', 2));
    const stopped = applyPublicSessionUpdate(running, {
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
    assert.equal(stopped.runToken, null);
});

test('updates only an existing assistant timestamp and preserves empty messages', () => {
    const state = base();
    state.history.messages.push({ role: 'assistant', messageId: 'empty', parts: [] });
    const first = applyPublicSessionUpdate(state, {
        type: 'assistant_timestamp_state',
        messageId: 'a1',
        timestamp: 2
    });
    const second = applyPublicSessionUpdate(first, {
        type: 'assistant_timestamp_state',
        messageId: 'empty',
        timestamp: 3
    });
    assert.deepEqual(second.history.messages, [
        { role: 'assistant', messageId: 'a1', timestamp: 2, parts: [{ type: 'text', text: 'hello' }] },
        { role: 'assistant', messageId: 'empty', timestamp: 3, parts: [] }
    ]);
    assert.strictEqual(
        applyPublicSessionUpdate(second, {
            type: 'assistant_timestamp_state',
            messageId: 'empty',
            timestamp: 3
        }),
        second
    );
});

test('rejects invalid assistant timestamp targets without mutating state', () => {
    const state = base();
    state.history.messages.push({
        role: 'user',
        messageId: 'u1',
        timestamp: 1,
        parts: [{ type: 'text', text: 'question' }]
    });
    const before = structuredClone(state);
    for (const update of [
        { type: 'assistant_timestamp_state', messageId: 'missing', timestamp: 2 },
        { type: 'assistant_timestamp_state', messageId: 'u1', timestamp: 2 },
        { type: 'assistant_timestamp_state', messageId: 'a1', timestamp: Number.NaN }
    ] as PublicSessionUpdate[]) {
        assert.throws(() => applyPublicSessionUpdate(state, update));
        assert.deepEqual(state, before);
    }
});

test('rejects holes and returns the same object for a duplicate update', () => {
    const state = base();
    assert.throws(() =>
        applyPublicSessionUpdate(state, {
            type: 'part_state',
            messageId: 'new',
            role: 'assistant',
            partIndex: 1,
            part: { type: 'text', text: 'hole' }
        })
    );
    assert.strictEqual(
        applyPublicSessionUpdate(state, {
            type: 'part_state',
            messageId: 'a1',
            role: 'assistant',
            partIndex: 0,
            messageTimestamp: 1,
            part: { type: 'text', text: 'hello' }
        }),
        state
    );
});
