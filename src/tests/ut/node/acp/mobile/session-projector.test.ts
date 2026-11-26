import assert from 'node:assert/strict';
import test from 'node:test';
import {
    PUBLIC_REASONING_MAX_BYTES,
    PUBLIC_SESSION_STATE_MAX_BYTES,
    PUBLIC_TEXT_MAX_BYTES,
    PUBLIC_TOOL_RESULT_MAX_BYTES,
    PublicSessionProjectionError,
    publicStateBytes,
    utf8Bytes,
    type PublicSessionFailureCode
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session.js';
import { deriveRunToken } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session-identifiers.js';
import {
    collectPublicSessionIdentifierCandidates,
    projectPublicSessionInfo,
    projectPublicSessionLoadedInfo,
    projectPublicSessionState,
    selectProductVisibleRoots,
    type LoadedPublicSessionTask,
    type RemoteTaskSubmitOptions,
    type SourceChatMessage
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/session-projector.js';
import type { RemoteSessionTaskEntry } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/session-projector.js';
import { candidatePlan, sourceTask, UUID_1, UUID_2 } from './session-projector-fixtures.js';

const dependencies = { getDefaultWorkspace: () => '/default', diagnose: () => undefined };

test('remote submit options admit the interactive mobile call without widening other fields', () => {
    const options: RemoteTaskSubmitOptions = {
        interactive: true,
        onUserMessageCommitted: () => undefined
    };
    assert.equal(options.interactive, true);
});

function project(task: LoadedPublicSessionTask) {
    const candidates = collectPublicSessionIdentifierCandidates(task.chat_context.messages);
    return projectPublicSessionState(task, candidatePlan(candidates), dependencies);
}

function assertProjectionCode(code: PublicSessionFailureCode) {
    return (error: unknown): boolean => {
        assert.ok(error instanceof PublicSessionProjectionError);
        assert.equal(error.code, code);
        return true;
    };
}

function errorStateTask(targetBytes: number): LoadedPublicSessionTask {
    const make = (message: string) =>
        sourceTask({
            messages: [
                {
                    role: 'assistant',
                    message_id: 'state-limit',
                    content: [{ type: 'error', title: 'State limit', message }]
                }
            ] as SourceChatMessage[]
        });
    const fixedBytes = publicStateBytes(project(make('')));
    assert.ok(targetBytes >= fixedBytes);
    return make('x'.repeat(targetBytes - fixedBytes));
}

test('projects the complete whitelist, preserves order and releases all source references', () => {
    const tool: {
        id: string;
        tool_name: string;
        status: 'success' | 'error';
        result: string;
        result_object: { visible: string };
        args_string: string;
        rawInput: string;
    } = {
        id: '',
        tool_name: 'executeBash',
        status: 'success',
        result: '',
        result_object: { visible: 'result' },
        args_string: '{"secret":true}',
        rawInput: 'forbidden'
    };
    const messages = [
        {
            role: 'user',
            message_id: 'source-user',
            timestamp: 1,
            content: [
                { type: 'text', text: '' },
                { type: 'image_url', image_url: { url: 'https://secret/image' } },
                { type: 'file', path: '/secret/file' }
            ]
        },
        {
            role: 'user',
            message_id: 'internal',
            timestamp: 2,
            internal: true,
            content: [{ type: 'text', text: 'hidden goal' }]
        },
        {
            role: 'assistant',
            message_id: 'source-assistant',
            timestamp: 3,
            content: [
                { type: 'reasoning', content: '', elapsedSeconds: 0 },
                { type: 'tool_call', toolcalls: [tool] },
                { type: 'error', title: 'Visible title', message: 'Visible message' }
            ]
        },
        { role: 'compact_separator', summary: 'secret summary' }
    ] as SourceChatMessage[];
    const state = project(sourceTask({ messages }));

    assert.deepEqual(state, {
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
                    role: 'user',
                    messageId: UUID_1,
                    timestamp: 1,
                    parts: [
                        { type: 'text', text: '' },
                        { type: 'unavailable_attachment', attachmentKind: 'image' },
                        { type: 'unavailable_attachment', attachmentKind: 'file' }
                    ]
                },
                {
                    role: 'assistant',
                    messageId: UUID_2,
                    timestamp: 3,
                    parts: [
                        { type: 'reasoning', content: '', elapsedSeconds: 0 },
                        {
                            type: 'tool_call',
                            toolCalls: [
                                {
                                    toolCallId: '00000000-0000-5000-8000-000000000001',
                                    toolName: 'executeBash',
                                    status: 'success',
                                    resultText: '{"visible":"result"}'
                                }
                            ]
                        },
                        { type: 'error', title: 'Visible title', message: 'Visible message' }
                    ]
                },
                { role: 'compact_boundary' }
            ]
        }
    });
    const serialized = JSON.stringify(state);
    for (const forbidden of [
        'secret/image',
        'secret/file',
        'hidden goal',
        'args_string',
        'rawInput',
        'secret summary'
    ]) {
        assert.equal(serialized.includes(forbidden), false, forbidden);
    }
    messages.splice(0);
    tool.status = 'error';
    tool.result_object.visible = 'changed';
    assert.equal(JSON.stringify(state).includes('changed'), false);
});

test('keeps legal empty history and empty assistant, but rejects empty user and tool parts', () => {
    assert.deepEqual(project(sourceTask()).history.messages, []);
    assert.deepEqual(
        project(sourceTask({ messages: [{ role: 'assistant', message_id: 'a', content: [] } as SourceChatMessage] }))
            .history.messages[0],
        { role: 'assistant', messageId: UUID_1, parts: [] }
    );
    assert.throws(
        () =>
            project(
                sourceTask({
                    messages: [{ role: 'user', message_id: 'u', timestamp: 1, content: [] } as SourceChatMessage]
                })
            ),
        assertProjectionCode('session_load_failed')
    );
    assert.throws(
        () =>
            project(
                sourceTask({
                    messages: [
                        {
                            role: 'assistant',
                            message_id: 'a',
                            content: [{ type: 'tool_call', toolcalls: [] }]
                        } as SourceChatMessage
                    ]
                })
            ),
        assertProjectionCode('session_load_failed')
    );
});

test('normalizes list/load roots through one projector and selects listed roots', () => {
    const info = projectPublicSessionInfo(
        sourceTask({
            task_name: '  title  ',
            workspace: 'relative',
            task_status: 'future',
            completion_status: 'future',
            created_at: 'bad',
            updated_at: '2026-08-21T00:00:00.000Z',
            finished_at: '2026-08-22T00:00:00.000Z'
        }),
        { getDefaultWorkspace: () => '/fallback', diagnose: () => undefined }
    );
    assert.deepEqual(info, {
        sessionId: 's1',
        title: 'title',
        cwd: '/fallback',
        updatedAt: '2026-08-22T00:00:00.000Z',
        taskStatus: 'stopped',
        completionStatus: null
    });
    const tasks: RemoteSessionTaskEntry[] = [
        { task_id: 'root', task_name: 'Root' },
        { task_id: 'child', task_name: 'Child', parent_id: 'root' },
        { task_id: 'orphan', task_name: 'Orphan', parent_id: 'missing' },
        { task_id: 'pending', name_pending: true },
        { task_id: 'internal', task_name: 'Internal', internal: true },
        { task_id: 'hidden' }
    ];
    assert.deepEqual(
        selectProductVisibleRoots(tasks).map((task) => task.task_id),
        ['root', 'orphan', 'pending']
    );
});

test('projects runToken only for loaded running state and never into directory info', () => {
    const running = sourceTask({ task_id: 's1', task_status: 'running' });
    running.getTurnGeneration = () => 7;
    const directory = projectPublicSessionInfo(running, dependencies);
    const loaded = projectPublicSessionLoadedInfo(running, dependencies);
    const projectedState = projectPublicSessionState(running, candidatePlan([]), dependencies);

    assert.equal('runToken' in directory, false);
    assert.deepEqual(loaded, {
        title: directory.title,
        cwd: directory.cwd,
        updatedAt: directory.updatedAt,
        taskStatus: 'running',
        completionStatus: directory.completionStatus,
        runToken: deriveRunToken('s1', 7)
    });
    assert.equal(projectedState.runToken, deriveRunToken('s1', 7));

    for (const status of ['waiting', 'stopped', 'failed'] as const) {
        const terminal = sourceTask({ task_id: 's1', task_status: status });
        terminal.getTurnGeneration = () => 7;
        assert.equal(projectPublicSessionLoadedInfo(terminal, dependencies).runToken, null);
        assert.equal(projectPublicSessionState(terminal, candidatePlan([]), dependencies).runToken, null);
    }
});

test('fails closed when running has no valid positive generation', () => {
    for (const generation of [0, -1, 1.5, Number.NaN]) {
        const running = sourceTask({ task_id: 's1', task_status: 'running' });
        running.getTurnGeneration = () => generation;
        assert.throws(() => projectPublicSessionLoadedInfo(running, dependencies), /generation/);
    }
});

test('counts UTF-8 and enforces field limits minus one, at limit and plus one', () => {
    assert.equal(utf8Bytes('A中😀'), 8);
    const cases: Array<[number, (value: string) => LoadedPublicSessionTask]> = [
        [
            PUBLIC_TEXT_MAX_BYTES,
            (value) =>
                sourceTask({
                    messages: [
                        {
                            role: 'assistant',
                            message_id: 'a',
                            content: [{ type: 'text', text: value }]
                        } as SourceChatMessage
                    ]
                })
        ],
        [
            PUBLIC_REASONING_MAX_BYTES,
            (value) =>
                sourceTask({
                    messages: [
                        {
                            role: 'assistant',
                            message_id: 'a',
                            content: [{ type: 'reasoning', content: value }]
                        } as SourceChatMessage
                    ]
                })
        ],
        [
            PUBLIC_TOOL_RESULT_MAX_BYTES,
            (value) =>
                sourceTask({
                    messages: [
                        {
                            role: 'assistant',
                            message_id: 'a',
                            content: [
                                {
                                    type: 'tool_call',
                                    toolcalls: [
                                        {
                                            id: 't',
                                            tool_name: 'x',
                                            status: 'success',
                                            result: value
                                        }
                                    ]
                                }
                            ]
                        } as SourceChatMessage
                    ]
                })
        ]
    ];
    for (const [limit, make] of cases) {
        assert.doesNotThrow(() => project(make('a'.repeat(limit - 1))));
        assert.doesNotThrow(() => project(make('a'.repeat(limit))));
        assert.throws(() => project(make('a'.repeat(limit + 1))), assertProjectionCode('session_too_large'));
    }
    const envelopeHeavy = sourceTask({
        messages: Array.from({ length: 4_000 }, (_, index) => ({
            role: 'assistant',
            message_id: `a-${index}`,
            content: [{ type: 'text', text: 'x'.repeat(2_048) }]
        })) as SourceChatMessage[]
    });
    assert.throws(() => project(envelopeHeavy), assertProjectionCode('session_too_large'));
    assert.ok(
        PUBLIC_SESSION_STATE_MAX_BYTES <
            publicStateBytes({
                ...project(sourceTask()),
                history: {
                    messages: [
                        {
                            role: 'assistant',
                            messageId: UUID_1,
                            parts: [{ type: 'text', text: 'x'.repeat(PUBLIC_SESSION_STATE_MAX_BYTES) }]
                        }
                    ]
                }
            })
    );
});

test('enforces the exact complete state limit minus one, at limit and plus one', () => {
    for (const targetBytes of [PUBLIC_SESSION_STATE_MAX_BYTES - 1, PUBLIC_SESSION_STATE_MAX_BYTES]) {
        const state = project(errorStateTask(targetBytes));
        assert.equal(publicStateBytes(state), targetBytes);
    }
    assert.throws(
        () => project(errorStateTask(PUBLIC_SESSION_STATE_MAX_BYTES + 1)),
        assertProjectionCode('session_too_large')
    );
});

const invalidProjectionCases: Array<[string, SourceChatMessage]> = [
    [
        'user NaN timestamp',
        { role: 'user', message_id: 'u', timestamp: Number.NaN, content: [{ type: 'text', text: 'x' }] }
    ],
    [
        'user infinite timestamp',
        { role: 'user', message_id: 'u', timestamp: Number.POSITIVE_INFINITY, content: [{ type: 'text', text: 'x' }] }
    ],
    [
        'user string timestamp',
        { role: 'user', message_id: 'u', timestamp: '1', content: [{ type: 'text', text: 'x' }] }
    ],
    ['assistant NaN timestamp', { role: 'assistant', message_id: 'a', timestamp: Number.NaN, content: [] }],
    ['assistant string timestamp', { role: 'assistant', message_id: 'a', timestamp: '1', content: [] }],
    [
        'negative reasoning duration',
        { role: 'assistant', message_id: 'a', content: [{ type: 'reasoning', content: 'x', elapsedSeconds: -1 }] }
    ],
    [
        'NaN reasoning duration',
        {
            role: 'assistant',
            message_id: 'a',
            content: [{ type: 'reasoning', content: 'x', elapsedSeconds: Number.NaN }]
        }
    ],
    [
        'string reasoning duration',
        { role: 'assistant', message_id: 'a', content: [{ type: 'reasoning', content: 'x', elapsedSeconds: '0' }] }
    ],
    [
        'empty tool name',
        {
            role: 'assistant',
            message_id: 'a',
            content: [{ type: 'tool_call', toolcalls: [{ id: 't', tool_name: '', status: 'success' }] }]
        }
    ],
    [
        'blank tool name',
        {
            role: 'assistant',
            message_id: 'a',
            content: [{ type: 'tool_call', toolcalls: [{ id: 't', tool_name: '   ', status: 'success' }] }]
        }
    ],
    [
        'non-string tool name',
        {
            role: 'assistant',
            message_id: 'a',
            content: [{ type: 'tool_call', toolcalls: [{ id: 't', tool_name: 42, status: 'success' }] }]
        }
    ],
    [
        'unknown tool status',
        {
            role: 'assistant',
            message_id: 'a',
            content: [{ type: 'tool_call', toolcalls: [{ id: 't', tool_name: 'x', status: 'future' }] }]
        }
    ],
    ['non-string user text', { role: 'user', message_id: 'u', timestamp: 1, content: [{ type: 'text', text: 42 }] }],
    ['non-string assistant text', { role: 'assistant', message_id: 'a', content: [{ type: 'text', text: 42 }] }],
    ['non-string reasoning', { role: 'assistant', message_id: 'a', content: [{ type: 'reasoning', content: 42 }] }],
    [
        'non-string error title',
        { role: 'assistant', message_id: 'a', content: [{ type: 'error', title: 42, message: 'x' }] }
    ],
    [
        'non-string error message',
        { role: 'assistant', message_id: 'a', content: [{ type: 'error', title: 'x', message: 42 }] }
    ]
] as Array<[string, SourceChatMessage]>;

for (const [name, message] of invalidProjectionCases) {
    const tolerated =
        name.startsWith('assistant ') ||
        name.includes('reasoning duration') ||
        name.includes('tool name') ||
        name === 'non-string error title';
    test(`${tolerated ? 'normalizes' : 'rejects'} ${name}`, () => {
        if (!tolerated) {
            assert.throws(
                () => project(sourceTask({ messages: [message] })),
                assertProjectionCode('session_load_failed')
            );
            return;
        }
        const expected = structuredClone(message);
        if (expected.role !== 'assistant') throw new Error('expected assistant fixture');
        delete expected.timestamp;
        for (const part of expected.content) {
            if (part.type === 'reasoning') delete part.elapsedSeconds;
            if (part.type === 'tool_call') for (const call of part.toolcalls) call.tool_name = '';
            if (part.type === 'error') part.title = '';
        }
        assert.deepEqual(project(sourceTask({ messages: [message] })), project(sourceTask({ messages: [expected] })));
    });
}

test('rejects a relative default workspace', () => {
    const task = sourceTask({ workspace: '' });
    const candidates = collectPublicSessionIdentifierCandidates(task.chat_context.messages);
    assert.throws(
        () => projectPublicSessionState(task, candidatePlan(candidates), { getDefaultWorkspace: () => 'relative' }),
        assertProjectionCode('session_load_failed')
    );
});
