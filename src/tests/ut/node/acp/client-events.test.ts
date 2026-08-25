import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { AcpEventJournal } from '../../../../main/applications/acpmgr/runtime/journal.js';
import { AcpSessionUpdateMapper } from '../../../../main/applications/acpmgr/runtime/mapper.js';

test('ACP event journal appends ordered recoverable JSONL records', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-acp-journal-'));
    try {
        const journal = new AcpEventJournal(directory);
        const first = journal.append('inbound', 'session/update', { text: 'one' });
        const second = journal.append('outbound', 'session/prompt', { text: 'two' });
        const reopened = new AcpEventJournal(directory);
        const third = reopened.append('lifecycle', 'disconnected', { reason: 'closed' });

        assert.equal(first.sequence, 1);
        assert.equal(second.sequence, 2);
        assert.equal(third.sequence, 3);
        assert.deepEqual(
            reopened.readAll().map((entry) => ({
                sequence: entry.sequence,
                direction: entry.direction,
                method: entry.method,
                payload: entry.payload
            })),
            [
                { sequence: 1, direction: 'inbound', method: 'session/update', payload: { text: 'one' } },
                { sequence: 2, direction: 'outbound', method: 'session/prompt', payload: { text: 'two' } },
                { sequence: 3, direction: 'lifecycle', method: 'disconnected', payload: { reason: 'closed' } }
            ]
        );
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('ACP update mapper converts streamed messages and merges tool progress', () => {
    const mapper = new AcpSessionUpdateMapper();

    assert.deepEqual(
        mapper.map({
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: 'Think' }
        }),
        [{ type: 'thought_delta', text: 'Think' }]
    );
    assert.deepEqual(
        mapper.map({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Answer' }
        }),
        [{ type: 'message_delta', text: 'Answer' }]
    );

    const created: SessionUpdate = {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-1',
        title: 'Read file',
        kind: 'read',
        status: 'in_progress',
        locations: [{ path: '/workspace/a.ts', line: 3 }],
        rawInput: { path: '/workspace/a.ts' }
    };
    const updated: SessionUpdate = {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        status: 'completed',
        rawOutput: { content: 'done' }
    };

    assert.deepEqual(mapper.map(created), [
        {
            type: 'tool_call',
            toolCallId: 'call-1',
            title: 'Read file',
            status: 'in_progress',
            locations: [{ path: '/workspace/a.ts', line: 3 }],
            rawInput: { path: '/workspace/a.ts' }
        }
    ]);
    assert.deepEqual(mapper.map(updated), [
        {
            type: 'tool_call',
            toolCallId: 'call-1',
            title: 'Read file',
            status: 'completed',
            locations: [{ path: '/workspace/a.ts', line: 3 }],
            rawInput: { path: '/workspace/a.ts' },
            rawOutput: { content: 'done' }
        }
    ]);
});

test('ACP update mapper retains plans and session metadata for local checkpoints', () => {
    const mapper = new AcpSessionUpdateMapper();
    assert.deepEqual(
        mapper.map({
            sessionUpdate: 'plan',
            entries: [{ content: 'Inspect', status: 'in_progress', priority: 'high' }]
        }),
        [
            {
                type: 'plan',
                entries: [{ content: 'Inspect', status: 'in_progress', priority: 'high' }]
            }
        ]
    );
    assert.deepEqual(
        mapper.map({
            sessionUpdate: 'current_mode_update',
            currentModeId: 'plan'
        }),
        [
            {
                type: 'metadata',
                data: { sessionUpdate: 'current_mode_update', currentModeId: 'plan' }
            }
        ]
    );
});

test('ACP update mapper preserves v2 message identity and replacement semantics', () => {
    const mapper = new AcpSessionUpdateMapper();

    assert.deepEqual(
        mapper.map({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'draft' },
            _meta: { 'opendesk/messageId': 'message-1' }
        }),
        [{ type: 'message_delta', text: 'draft', messageId: 'message-1' }]
    );
    assert.deepEqual(
        mapper.map({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'final' },
            _meta: { 'opendesk/messageId': 'message-1', 'opendesk/replace': true }
        }),
        [{ type: 'message_replace', text: 'final', messageId: 'message-1' }]
    );
});
