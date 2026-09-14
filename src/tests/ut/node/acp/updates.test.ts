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

test('pwsh uses the ACP execution tool kind', () => {
    assert.equal(mapToolKind('terminal-executePwsh'), 'execute');
});

test('ACP update translator emits text deltas', async () => {
    const connection = new FakeConnection();
    const translator = new AcpUpdateTranslator();
    const messageId = '11111111-1111-4111-8111-111111111111';

    await translator.publish(connection as any, 'session-1', {
        type: 'assistant',
        task_id: 'task-1',
        task_status: 'running',
        message_id: messageId,
        last_part_index: 0,
        last_part: { type: 'text', text: 'Hello' }
    } as any);
    await translator.publish(connection as any, 'session-1', {
        type: 'assistant',
        task_id: 'task-1',
        task_status: 'running',
        message_id: messageId,
        last_part_index: 0,
        last_part: { type: 'text', text: 'Hello world' }
    } as any);

    assert.equal(connection.updates.length, 2);
    assert.deepEqual(connection.updates, [
        {
            sessionId: 'session-1',
            update: {
                sessionUpdate: 'agent_message_chunk',
                messageId,
                _meta: {
                    opendesk: {
                        blockId: `${messageId}:0`,
                        messageId,
                        partIndex: 0,
                        partType: 'text'
                    }
                },
                content: { type: 'text', text: 'Hello' }
            }
        },
        {
            sessionId: 'session-1',
            update: {
                sessionUpdate: 'agent_message_chunk',
                messageId,
                _meta: {
                    opendesk: {
                        blockId: `${messageId}:0`,
                        messageId,
                        partIndex: 0,
                        partType: 'text'
                    }
                },
                content: { type: 'text', text: ' world' }
            }
        }
    ]);
});

test('ACP update translator buffers provisional text until it is final', async () => {
    const connection = new FakeConnection();
    const translator = new AcpUpdateTranslator();
    const messageId = '88888888-8888-4888-8888-888888888888';

    await translator.publish(connection as any, 'session-1', {
        type: 'assistant',
        task_id: 'task-1',
        task_status: 'running',
        message_id: messageId,
        last_part_index: 0,
        provisional: 'implicit_think_close_candidate',
        last_part: { type: 'text', text: 'Plain' }
    } as any);
    await translator.publish(connection as any, 'session-1', {
        type: 'assistant',
        task_id: 'task-1',
        task_status: 'stopped',
        message_id: messageId,
        last_part_index: 0,
        provisional: 'implicit_think_close_candidate',
        last_part: { type: 'text', text: 'Plain answer' }
    } as any);

    assert.equal(connection.updates.length, 1);
    assert.deepEqual((connection.updates[0] as any).update, {
        sessionUpdate: 'agent_message_chunk',
        messageId,
        _meta: {
            opendesk: {
                blockId: `${messageId}:0`,
                messageId,
                partIndex: 0,
                partType: 'text'
            }
        },
        content: { type: 'text', text: 'Plain answer' }
    });
});

test('ACP update translator rebases provisional text to thought on assistant replace', async () => {
    const connection = new FakeConnection();
    const translator = new AcpUpdateTranslator();
    const messageId = '99999999-9999-4999-8999-999999999999';

    await translator.publish(connection as any, 'session-1', {
        type: 'assistant',
        task_id: 'task-1',
        task_status: 'running',
        message_id: messageId,
        last_part_index: 0,
        provisional: 'implicit_think_close_candidate',
        last_part: { type: 'text', text: 'hidden' }
    } as any);
    await translator.publish(connection as any, 'session-1', {
        type: 'assistant_replace',
        task_id: 'task-1',
        task_status: 'running',
        message_id: messageId,
        parts: [
            { type: 'reasoning', content: 'hidden' },
            { type: 'text', text: 'visible' }
        ]
    } as any);

    const updates = connection.updates.map((entry) => (entry as any).update);
    assert.equal(updates.length, 3);
    assert.equal(updates[0].sessionUpdate, 'agent_thought_chunk');
    assert.equal(updates[0].content.text, 'hidden');
    assert.equal(updates[0]._meta.opendesk.blockId, `${messageId}:0`);
    assert.equal(updates[0]._meta.opendesk.partType, 'reasoning');
    assert.equal(updates[1].sessionUpdate, 'user_message_chunk');
    assert.equal(updates[1].content.text, '');
    assert.equal(updates[2].sessionUpdate, 'agent_message_chunk');
    assert.equal(updates[2].content.text, 'visible');
    assert.equal(updates[2]._meta.opendesk.blockId, `${messageId}:1`);
    assert.equal(updates[2]._meta.opendesk.partType, 'text');
});

test('ACP update translator emits tool create and update events', async () => {
    const connection = new FakeConnection();
    const translator = new AcpUpdateTranslator();
    const messageId = '22222222-2222-4222-8222-222222222222';

    await translator.publish(connection as any, 'session-1', {
        type: 'assistant',
        task_id: 'task-1',
        task_status: 'running',
        message_id: messageId,
        last_part_index: 2,
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
        _meta: {
            opendesk: {
                blockId: `${messageId}:2:tool_call`,
                messageId,
                partIndex: 2,
                partType: 'tool_call',
                toolCallId: 'call-1',
                toolCallIndex: 0
            }
        },
        locations: [{ path: '/tmp/a.txt' }],
        rawInput: { path: '/tmp/a.txt' }
    });
    assert.deepEqual((connection.updates[1] as any).update, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        kind: 'read',
        status: 'in_progress',
        title: 'filemgr-readFile',
        _meta: {
            opendesk: {
                blockId: `${messageId}:2:tool_call`,
                messageId,
                partIndex: 2,
                partType: 'tool_call',
                toolCallId: 'call-1',
                toolCallIndex: 0
            }
        },
        locations: [{ path: '/tmp/a.txt' }],
        rawInput: { path: '/tmp/a.txt' }
    });
});

test('ACP update translator carries distinct message ids through a complex turn', async () => {
    const connection = new FakeConnection();
    const translator = new AcpUpdateTranslator();
    const firstMessageId = '33333333-3333-4333-8333-333333333333';
    const secondMessageId = '44444444-4444-4444-8444-444444444444';

    await translator.publish(connection as any, 'session-1', {
        type: 'assistant',
        task_id: 'task-1',
        task_status: 'running',
        message_id: firstMessageId,
        last_part_index: 0,
        last_part: { type: 'reasoning', content: 'I should inspect the file.' }
    } as any);
    await translator.publish(connection as any, 'session-1', {
        type: 'assistant',
        task_id: 'task-1',
        task_status: 'running',
        message_id: firstMessageId,
        last_part_index: 1,
        last_part: { type: 'text', text: 'I will read it first.' }
    } as any);
    await translator.publish(connection as any, 'session-1', {
        type: 'assistant',
        task_id: 'task-1',
        task_status: 'running',
        message_id: firstMessageId,
        last_part_index: 2,
        last_part: {
            type: 'tool_call',
            toolcalls: [
                {
                    id: 'call-2',
                    index: 0,
                    tool_name: 'filemgr-readFile',
                    args_string: '{"path":"/tmp/a.txt"}',
                    args_object: {},
                    status: 'success',
                    result: 'content'
                }
            ]
        }
    } as any);
    await translator.publish(connection as any, 'session-1', {
        type: 'assistant',
        task_id: 'task-1',
        task_status: 'running',
        message_id: secondMessageId,
        last_part_index: 0,
        last_part: { type: 'text', text: 'Done.' }
    } as any);

    const updates = connection.updates.map((entry) => (entry as any).update);
    // 0: reasoning
    assert.equal(updates[0].sessionUpdate, 'agent_thought_chunk');
    assert.equal(updates[0].messageId, firstMessageId);
    assert.equal(updates[0]._meta.opendesk.blockId, `${firstMessageId}:0`);
    assert.equal(updates[0]._meta.opendesk.partType, 'reasoning');
    // 1: separator (reasoning→text)
    assert.equal(updates[1].sessionUpdate, 'user_message_chunk');
    assert.equal(updates[1].content.text, '');
    // 2: text
    assert.equal(updates[2].sessionUpdate, 'agent_message_chunk');
    assert.equal(updates[2].messageId, firstMessageId);
    assert.equal(updates[2]._meta.opendesk.blockId, `${firstMessageId}:1`);
    assert.equal(updates[2]._meta.opendesk.partIndex, 1);
    // 3: tool_call (text→tool_call，不注入分隔符)
    assert.equal(updates[3].sessionUpdate, 'tool_call');
    assert.equal(updates[3]._meta.opendesk.blockId, `${firstMessageId}:2:tool_call`);
    assert.equal(updates[3]._meta.opendesk.messageId, firstMessageId);
    // 4: tool_call_update
    assert.equal(updates[4].sessionUpdate, 'tool_call_update');
    assert.equal(updates[4]._meta.opendesk.toolCallId, 'call-2');
    // 5: new message text (跨消息 lastPartType 重置，无 separator)
    assert.equal(updates[5].sessionUpdate, 'agent_message_chunk');
    assert.equal(updates[5].messageId, secondMessageId);
    assert.equal(updates[5]._meta.opendesk.blockId, `${secondMessageId}:0`);
    assert.equal(updates[5]._meta.opendesk.messageId, secondMessageId);
});

test('ACP update translator fallback tool ids stay unique across messages', async () => {
    const connection = new FakeConnection();
    const translator = new AcpUpdateTranslator();
    const firstMessageId = '55555555-5555-4555-8555-555555555555';
    const secondMessageId = '66666666-6666-4666-8666-666666666666';

    for (const messageId of [firstMessageId, secondMessageId]) {
        await translator.publish(connection as any, 'session-1', {
            type: 'assistant',
            task_id: 'task-1',
            task_status: 'running',
            message_id: messageId,
            last_part_index: 0,
            last_part: {
                type: 'tool_call',
                toolcalls: [
                    {
                        id: '',
                        index: 0,
                        tool_name: 'filemgr-readFile',
                        args_string: '{"path":"/tmp/a.txt"}',
                        args_object: {},
                        status: 'running'
                    }
                ]
            }
        } as any);
    }

    const toolCreates = connection.updates
        .map((entry) => (entry as any).update)
        .filter((update) => update.sessionUpdate === 'tool_call');
    assert.equal(toolCreates.length, 2);
    assert.equal(toolCreates[0].toolCallId, `${firstMessageId}:0:filemgr-readFile:0`);
    assert.equal(toolCreates[1].toolCallId, `${secondMessageId}:0:filemgr-readFile:0`);
    assert.notEqual(toolCreates[0].toolCallId, toolCreates[1].toolCallId);
});

test('ACP update translator preserves error part type in metadata', async () => {
    const connection = new FakeConnection();
    const translator = new AcpUpdateTranslator();
    const messageId = '77777777-7777-4777-8777-777777777777';

    await translator.publish(connection as any, 'session-1', {
        type: 'assistant',
        task_id: 'task-1',
        task_status: 'running',
        message_id: messageId,
        last_part_index: 0,
        last_part: { type: 'error', title: 'Failure', message: 'boom' }
    } as any);

    assert.deepEqual((connection.updates[0] as any).update, {
        sessionUpdate: 'agent_message_chunk',
        messageId,
        _meta: {
            opendesk: {
                blockId: `${messageId}:0`,
                messageId,
                partIndex: 0,
                partType: 'error'
            }
        },
        content: { type: 'text', text: 'Failure: boom' }
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
