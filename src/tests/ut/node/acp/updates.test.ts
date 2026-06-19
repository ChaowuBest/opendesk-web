import test from 'node:test';
import assert from 'node:assert/strict';
import {
    AcpUpdateTranslator,
    mapToolKind,
    mapToolStatus,
    toJsonCompatible
} from '../../../../main/server/acp/updates.js';

class FakeConnection {
    updates: unknown[] = [];

    async sessionUpdate(params: unknown): Promise<void> {
        this.updates.push(params);
    }
}

test('ACP update translator emits text deltas', async () => {
    const connection = new FakeConnection();
    const translator = new AcpUpdateTranslator();

    await translator.publish(connection as any, 'session-1', {
        type: 'assistant',
        task_id: 'task-1',
        task_status: 'running',
        message_id: 'message-1',
        last_part_index: 0,
        last_part: { type: 'text', text: 'Hello' }
    } as any);
    await translator.publish(connection as any, 'session-1', {
        type: 'assistant',
        task_id: 'task-1',
        task_status: 'running',
        message_id: 'message-1',
        last_part_index: 0,
        last_part: { type: 'text', text: 'Hello world' }
    } as any);

    assert.equal(connection.updates.length, 2);
    assert.deepEqual(connection.updates, [
        {
            sessionId: 'session-1',
            update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Hello' }
            }
        },
        {
            sessionId: 'session-1',
            update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: ' world' }
            }
        }
    ]);
});

test('ACP update translator emits tool create and update events', async () => {
    const connection = new FakeConnection();
    const translator = new AcpUpdateTranslator();

    await translator.publish(connection as any, 'session-1', {
        type: 'assistant',
        task_id: 'task-1',
        task_status: 'running',
        message_id: 'message-1',
        last_part_index: 0,
        last_part: {
            type: 'tool_call',
            toolcalls: [
                {
                    id: 'call-1',
                    index: 0,
                    tool_name: 'filemgr-readFile',
                    args_string: '{"path":"/tmp/a.txt"}',
                    args_object: {},
                    status: 'running'
                }
            ]
        }
    } as any);

    assert.equal(connection.updates.length, 2);
    assert.deepEqual((connection.updates[0] as any).update, {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-1',
        title: 'filemgr-readFile',
        kind: 'read',
        status: 'in_progress',
        locations: [{ path: '/tmp/a.txt' }],
        rawInput: { path: '/tmp/a.txt' }
    });
    assert.deepEqual((connection.updates[1] as any).update, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        kind: 'read',
        status: 'in_progress',
        title: 'filemgr-readFile',
        locations: [{ path: '/tmp/a.txt' }],
        rawInput: { path: '/tmp/a.txt' }
    });
});

test('ACP tool kind and status mapping uses protocol values', () => {
    assert.equal(mapToolKind('executeBash'), 'execute');
    assert.equal(mapToolKind('searchReplace'), 'edit');
    assert.equal(mapToolKind('webFetch'), 'fetch');
    assert.equal(mapToolStatus('pending'), 'pending');
    assert.equal(mapToolStatus('running'), 'in_progress');
    assert.equal(mapToolStatus('success'), 'completed');
    assert.equal(mapToolStatus('error'), 'failed');
});

test('ACP JSON compatibility sanitizes raw protocol payloads', () => {
    const circular: Record<string, unknown> = { value: 1n };
    circular.self = circular;

    assert.equal(toJsonCompatible(circular), '[object Object]');
    assert.deepEqual(toJsonCompatible({ nested: ['ok'] }), { nested: ['ok'] });
    assert.equal(toJsonCompatible(undefined), undefined);
});
