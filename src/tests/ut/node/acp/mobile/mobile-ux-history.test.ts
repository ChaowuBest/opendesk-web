import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sourceTask } from './session-projector-fixtures.js';
import {
    collectPublicSessionIdentifierCandidates,
    projectPublicSessionState,
    projectTaskChunk,
    type AssistantMessagePart
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/session-projector.js';
import { createPublicSessionIdentifierPlan } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session-identifiers.js';
import {
    applyPublicSessionUpdate,
    type PublicSessionState
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session.js';
import {
    encodeSessionSnapshot,
    SessionNotificationEncoder
} from '../../../../../main/applications/mobileaccess/acp/mobile/acp-endpoint/session-notification-encoder.js';
import {
    createPublicSessionSync,
    type RemoteTaskUpdateSubscriber
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session-sync.js';

const dependencies = { getDefaultWorkspace: () => '/isolated' };
function fixture(timestamp: unknown = 0, name: unknown = 'readFile', duration: unknown = 0, title: unknown = 'Error') {
    const tool: AssistantMessagePart = {
        type: 'tool_call',
        toolcalls: [
            { id: 'first', tool_name: name, status: 'error', result: 'original result' },
            { id: 'second', tool_name: 'writeFile', status: 'success', result: 'second result' }
        ]
    };
    const reasoning = { type: 'reasoning' as const, content: 'original reasoning', elapsedSeconds: duration };
    const error = { type: 'error' as const, title, message: 'original error' };
    const message = {
        role: 'assistant' as const,
        message_id: 'answer',
        timestamp,
        content: [tool, reasoning, error, { type: 'text' as const, text: 'original answer' }]
    };
    const task = sourceTask({ task_status: 'stopped', messages: [message] });
    const identity = createPublicSessionIdentifierPlan(
        task.task_id,
        collectPublicSessionIdentifierCandidates(task.chat_context.messages)
    );
    const project = () => projectPublicSessionState(task, identity, dependencies);
    return { task, message, tool, reasoning, error, identity, project };
}

for (const invalid of [undefined, null, '', ' ', 42, Number.NaN, Infinity, -Infinity, {}]) {
    test(`normalizes only optional source fields: ${String(invalid)}`, () => {
        const f = fixture(invalid, invalid, invalid, invalid);
        // Explicit undefined must not activate fixture defaults.
        f.message.timestamp = invalid;
        f.tool.toolcalls[0].tool_name = invalid;
        f.reasoning.elapsedSeconds = invalid;
        f.error.title = invalid;
        const state = f.project();
        const message = state.history.messages[0];
        assert.ok(message.role === 'assistant');
        assert.ok(message.parts[0].type === 'tool_call');
        assert.equal('timestamp' in message, typeof invalid === 'number' && Number.isFinite(invalid));
        assert.equal(message.parts[0].toolCalls[0].toolName, '');
        assert.equal(message.parts[0].toolCalls[0].resultText, 'original result');
        assert.deepEqual(message.parts[1], {
            type: 'reasoning',
            content: 'original reasoning',
            ...(invalid === 42 ? { elapsedSeconds: 42 } : {})
        });
        assert.deepEqual(message.parts[2], {
            type: 'error',
            title: typeof invalid === 'string' ? invalid : '',
            message: 'original error'
        });
    });
}

test('new ordinary assistant parts normalize metadata without weakening new user timestamps', () => {
    const f = fixture(NaN, '', -1, null);
    const empty = sourceTask({ task_status: 'stopped' });
    const identity = createPublicSessionIdentifierPlan(empty.task_id, []);
    let state = projectPublicSessionState(empty, identity, dependencies);
    empty.chat_context.messages.push(f.message);
    for (const [partIndex, part] of f.message.content.entries()) {
        const update = projectTaskChunk(
            empty,
            {
                type: 'assistant',
                task_id: empty.task_id,
                message_id: f.message.message_id,
                last_part_index: partIndex,
                last_part: part
            },
            identity
        )!;
        state = applyPublicSessionUpdate(state, update);
    }
    assert.deepEqual(state, projectPublicSessionState(empty, identity, dependencies));
    const user = {
        role: 'user' as const,
        message_id: 'u',
        timestamp: 'bad',
        content: [{ type: 'text' as const, text: 'question' }]
    };
    empty.chat_context.messages.push(user);
    assert.throws(
        () =>
            projectTaskChunk(
                empty,
                {
                    type: 'user',
                    task_id: empty.task_id,
                    message_id: 'u',
                    last_part_index: 0,
                    last_part: user.content[0]
                },
                identity
            ),
        /timestamp/
    );
});

test('snapshot and message replacement carry a timestamp only on the first tool', () => {
    const f = fixture();
    const state = f.project();
    const encoder = new SessionNotificationEncoder(state.sessionId, state);
    const replacement = encoder.encode({ type: 'message_replace', message: state.history.messages[0] as never });
    for (const updates of [
        encodeSessionSnapshot(state)
            .notifications.slice(1)
            .map((n) => n.update),
        (replacement.notifications[0].update._meta!.opendesk as any).replacementUpdates
    ]) {
        assert.deepEqual(
            updates.map((u: any) => u._meta.opendesk.timestamp),
            [0, undefined, undefined, undefined, undefined]
        );
    }
});

for (const promoteWhileBuffering of [false, true]) {
    test(`unknown name can be filled in ${promoteWhileBuffering ? 'buffered' : 'live'} sync; named rename still closes feed`, async () => {
        const f = fixture(NaN, '');
        let state = f.project();
        let subscriber!: RemoteTaskUpdateSubscriber;
        const errors: Error[] = [];
        const sync = createPublicSessionSync(f.task.task_id, {
            subscribeTask: (value) => {
                subscriber = value;
                return () => {};
            },
            subscribeTaskManager: () => () => {},
            projectChunk: (chunk, identity) => projectTaskChunk(f.task, chunk, identity),
            projectInfo: () => f.project(),
            projectAuthoritativeState: f.project,
            assertStillAuthorized: () => {}
        });
        sync.handle.installFatalSink((error) => errors.push(error));
        sync.initializeT0(state, f.identity);
        const encoder = new SessionNotificationEncoder(state.sessionId, state);
        const send = () =>
            subscriber.send({
                type: 'assistant',
                task_id: f.task.task_id,
                message_id: f.message.message_id,
                last_part_index: 0,
                last_part: f.tool
            });
        f.tool.toolcalls[0].status = 'running';
        if (promoteWhileBuffering) f.tool.toolcalls[0].tool_name = 'readFile';
        send();
        await sync.handle.activate(async (update) => {
            state = applyPublicSessionUpdate(state, update);
            encoder.encode(update).commit();
        });
        f.tool.toolcalls[0].tool_name = 'readFile';
        send();
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(
            errors.map((error) => error.message),
            []
        );
        assert.deepEqual(state, f.project());
        f.tool.toolcalls[0].tool_name = 'writeFile';
        send();
        assert.equal(errors.length, 1);
        assert.match(errors[0].message, /identity changed/);
        sync.handle.stop();
    });
}

test(
    'PC to mobile snapshot, reconnect, ordinary update and replacement preserve normalized content',
    { skip: !process.env.OPENDESK_MOBILE_REPO },
    async () => {
        // Cross-repository import is optional, like the existing ACP recovery integration tests.
        const mobile = async (file: string) => {
            const module = await import(
                pathToFileURL(path.join(process.env.OPENDESK_MOBILE_REPO!, 'src/features/remote', file)).href
            );
            return module.default ?? module;
        };
        const profile = await mobile('acp/session-content-profile.ts');
        const snapshots = await mobile('acp/session-snapshot.ts');
        const reducer = await mobile('session/public-session.ts');
        const replay = (state: PublicSessionState) => {
            let draft = snapshots.createSnapshotDraft(state.sessionId);
            for (const notification of JSON.parse(JSON.stringify(encodeSessionSnapshot(state).notifications))) {
                draft = snapshots.reduceSnapshotEvent(
                    draft,
                    profile.decodeSnapshotNotification(state.sessionId, notification)
                );
            }
            const result = snapshots.finalizeSnapshot(draft);
            assert.deepEqual(result, state);
            return result;
        };
        for (const bad of [false, true]) {
            const f = bad ? fixture(NaN, '', -1, null) : fixture();
            let state = replay(f.project());
            const encoder = new SessionNotificationEncoder(state.sessionId, state);
            f.tool.toolcalls[0].tool_name = 'readFile';
            f.tool.toolcalls[0].result = 'updated result';
            const update = projectTaskChunk(
                f.task,
                {
                    type: 'assistant',
                    task_id: f.task.task_id,
                    message_id: f.message.message_id,
                    last_part_index: 0,
                    last_part: f.tool
                },
                f.identity
            )!;
            const encoded = encoder.encode(update);
            for (const notification of encoded.notifications) {
                state = reducer.applyPublicSessionUpdate(
                    state,
                    profile.decodeLiveSessionNotification(state, JSON.parse(JSON.stringify(notification)))
                );
            }
            encoded.commit();
            assert.deepEqual(state, f.project());
            replay(f.project());
            const replacement = projectTaskChunk(
                f.task,
                {
                    type: 'assistant_replace',
                    task_id: f.task.task_id,
                    message_id: f.message.message_id,
                    parts: f.message.content
                },
                f.identity
            )!;
            for (const notification of encoder.encode(replacement).notifications) {
                state = reducer.applyPublicSessionUpdate(
                    state,
                    profile.decodeLiveSessionNotification(state, JSON.parse(JSON.stringify(notification)))
                );
            }
            assert.deepEqual(state, f.project());
        }
    }
);
