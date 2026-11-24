import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveRunToken } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session-identifiers.js';
import {
    RemoteSessionStopError,
    createRemoteSessionService
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/service.js';
import { createInteractionSessionScopeResolver } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/session-projector.js';
import type {
    LoadedPublicSessionTask,
    RemoteSessionTaskEntry
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/session-projector.js';
import { unavailableSessionConfigurationBinding } from './session-projector-fixtures.js';
import type { HostSessionConfigurableTask } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/host-binding.js';

const row = (id = 's1', overrides: Partial<RemoteSessionTaskEntry> = {}): RemoteSessionTaskEntry => ({
    task_id: id,
    parent_id: null,
    task_name: 'Visible',
    task_status: 'running',
    completion_status: null,
    workspace: '/work',
    created_at: '2026-08-27T00:00:00.000Z',
    updated_at: '2026-08-27T00:00:00.000Z',
    ...overrides
});

function loaded(
    options: {
        id?: string;
        parentId?: string | null;
        internal?: boolean;
        status?: string;
        generation?: number;
        stop?: (reason: 'user' | 'system') => void;
    } = {}
): HostSessionConfigurableTask {
    return {
        ...row(options.id ?? 's1'),
        task_id: options.id ?? 's1',
        parent_id: options.parentId ?? null,
        internal: options.internal ?? false,
        task_status: options.status ?? 'running',
        chat_context: { messages: [] },
        getTurnGeneration: () => options.generation ?? 7,
        stop: options.stop ?? (() => undefined),
        async submitUserMessage() {
            return { status: 'ok' };
        },
        async waitUntilFinished() {},
        persistLater() {}
    };
}

function fixture(
    options: {
        lists?: readonly RemoteSessionTaskEntry[][];
        task?: HostSessionConfigurableTask;
        corrupted?: boolean;
    } = {}
) {
    const lists = options.lists ?? [[row()], [row()]];
    let listRead = 0;
    const getTaskList = () => lists[Math.min(listRead++, lists.length - 1)];
    const sequence: string[] = [];
    const task = options.task ?? loaded({ stop: (reason) => sequence.push(`stop:${reason}`) });
    const binding = {
        ...unavailableSessionConfigurationBinding,
        getTaskList() {
            sequence.push('visible');
            return getTaskList();
        },
        getTaskLoadResult() {
            sequence.push('load');
            return { task, corrupted: options.corrupted ?? false };
        },
        getDefaultWorkspace: () => '/work',
        subscribeTaskUpdates: () => () => undefined,
        subscribeTaskManagerUpdates: () => () => undefined
    };
    const service = createRemoteSessionService(binding, {
        resolveInteractionSessionScope: createInteractionSessionScopeResolver(() => lists[0])
    });
    return { service, task, sequence };
}

function refusal(reason: 'unavailable_or_unauthorized' | 'not_running' | 'stale_run') {
    return (error: unknown): boolean => {
        assert.ok(error instanceof RemoteSessionStopError);
        assert.equal(error.reason, reason);
        return true;
    };
}

test('authorizes in the fixed order and synchronously stops exactly once', () => {
    const current = fixture();
    current.service.stopCurrentRun('s1', deriveRunToken('s1', 7));
    assert.deepEqual(current.sequence, ['visible', 'load', 'visible', 'stop:user']);
});

test('duplicate cancel becomes not_running and never stops twice', () => {
    let status = 'running';
    let calls = 0;
    const task = loaded({
        stop(reason) {
            assert.equal(reason, 'user');
            calls += 1;
            status = 'stopped';
            task.task_status = status;
        }
    });
    const current = fixture({ task });
    current.service.stopCurrentRun('s1', deriveRunToken('s1', 7));
    assert.throws(() => current.service.stopCurrentRun('s1', deriveRunToken('s1', 7)), refusal('not_running'));
    assert.equal(calls, 1);
});

test('late A cancel cannot stop running B', () => {
    let calls = 0;
    const task = loaded({
        generation: 8,
        stop: () => {
            calls += 1;
        }
    });
    const current = fixture({ task });
    assert.throws(() => current.service.stopCurrentRun('s1', deriveRunToken('s1', 7)), refusal('stale_run'));
    assert.equal(calls, 0);
});

test('rejects invisible, corrupted and changed loaded identity without stop', () => {
    const cases = [
        fixture({ lists: [[], []] }),
        fixture({ corrupted: true }),
        fixture({ task: loaded({ id: 'other' }) }),
        fixture({ task: loaded({ parentId: 'other-parent' }) }),
        fixture({ task: loaded({ internal: true }) }),
        fixture({ lists: [[row()], []] })
    ];
    for (const current of cases) {
        assert.throws(
            () => current.service.stopCurrentRun('s1', deriveRunToken('s1', 7)),
            refusal('unavailable_or_unauthorized')
        );
        assert.equal(
            current.sequence.some((value) => value.startsWith('stop:')),
            false
        );
    }
});

test('rejects non-running, malformed/stale token, invalid generation and stop failure', () => {
    const notRunning = fixture({ task: loaded({ status: 'stopped' }) });
    assert.throws(() => notRunning.service.stopCurrentRun('s1', deriveRunToken('s1', 7)), refusal('not_running'));
    for (const token of ['', 'bad', deriveRunToken('s1', 8)]) {
        const current = fixture();
        assert.throws(() => current.service.stopCurrentRun('s1', token), refusal('stale_run'));
    }
    const invalidGeneration = fixture({ task: loaded({ generation: 0 }) });
    assert.throws(
        () => invalidGeneration.service.stopCurrentRun('s1', deriveRunToken('s1', 7)),
        refusal('unavailable_or_unauthorized')
    );
    const failingStop = fixture({
        task: loaded({
            stop: () => {
                throw new Error('/private/path');
            }
        })
    });
    assert.throws(
        () => failingStop.service.stopCurrentRun('s1', deriveRunToken('s1', 7)),
        refusal('unavailable_or_unauthorized')
    );
});
