import test from 'node:test';
import assert from 'node:assert/strict';
import {
    RemoteSessionContractError,
    createRemoteSessionService
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/service.js';
import type {
    RemoteSessionConfigurationHostBinding,
    RemoteSessionReadHostBinding
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/host-binding.js';
import { deriveRunToken } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session-identifiers.js';
import type {
    LoadedPublicSessionTask,
    RemoteSessionTaskEntry
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/session-projector.js';
import { createInteractionSessionScopeResolver } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/session-projector.js';
import { candidatePlan, sourceTask, unavailableSessionConfigurationBinding } from './session-projector-fixtures.js';

const DEFAULT_WORKSPACE = '/Users/stella/OpenDesk';
const noObservers = {
    ...unavailableSessionConfigurationBinding,
    subscribeTaskUpdates: () => () => undefined,
    subscribeTaskManagerUpdates: () => () => undefined
};

function task(taskId: string | undefined, overrides: Partial<RemoteSessionTaskEntry> = {}): RemoteSessionTaskEntry {
    return {
        task_id: taskId,
        parent_id: null,
        task_name: taskId ?? 'broken',
        task_status: 'stopped',
        completion_status: null,
        workspace: '/work/main',
        created_at: '2026-08-17T00:00:00.000Z',
        updated_at: '2026-08-18T00:00:00.000Z',
        finished_at: null,
        ...overrides
    };
}

function serviceFor(entries: RemoteSessionTaskEntry[]) {
    let reads = 0;
    const diagnostics: Array<{ code: string; taskId?: string }> = [];
    const getTaskList = () => {
        reads += 1;
        return entries;
    };
    return {
        service: createRemoteSessionService(
            {
                ...noObservers,
                getTaskList,
                getTaskLoadResult: () => ({ task: undefined, corrupted: false }),
                getDefaultWorkspace: () => DEFAULT_WORKSPACE
            },
            {
                resolveInteractionSessionScope: createInteractionSessionScopeResolver(getTaskList),
                diagnose: (diagnostic) => diagnostics.push(diagnostic)
            }
        ),
        reads: () => reads,
        diagnostics
    };
}

test('lists one snapshot of all product-visible roots', async () => {
    const { service, reads } = serviceFor([
        task('named-root', { task_name: '  Named root  ' }),
        task('pending-root', { task_name: '', name_pending: true }),
        task('hidden-root', { task_name: ' ', name_pending: false })
    ]);

    const result = await service.listSessions({});

    assert.equal(reads(), 1);
    assert.deepEqual(
        result.map(({ sessionId, title }) => ({ sessionId, title })),
        [
            { sessionId: 'named-root', title: 'Named root' },
            { sessionId: 'pending-root', title: null }
        ]
    );
});

test('keeps visible parents for tree construction before excluding internal roots', async () => {
    const fixture = [
        task('parent'),
        task('child', { parent_id: 'parent' }),
        task('orphan', { parent_id: 'missing' }),
        task('hidden-parent', { task_name: ' ', name_pending: false }),
        task('promoted-from-hidden', { parent_id: 'hidden-parent' }),
        task('internal-parent', { internal: true }),
        task('child-of-internal', { parent_id: 'internal-parent' }),
        task('internal-orphan', { parent_id: 'missing', internal: true })
    ];
    const { service, reads } = serviceFor(fixture);

    const result = await service.listSessions({});

    assert.equal(reads(), 1);
    assert.deepEqual(result.map((entry) => entry.sessionId).sort(), ['orphan', 'parent', 'promoted-from-hidden']);
});

test('normalizes workspace time and states without dropping recoverable rows', async () => {
    let workspaceReads = 0;
    const diagnostics: Array<{ code: string; taskId?: string }> = [];
    const entries = [
        task('explicit', {
            workspace: '/work/explicit',
            created_at: '2026-08-17T00:00:00.000Z',
            updated_at: '2026-08-18T00:00:00.000Z',
            finished_at: '2026-08-19T00:00:00.000Z',
            task_status: 'failed',
            completion_status: 'ask'
        }),
        task('blank', {
            workspace: '',
            created_at: 'bad',
            updated_at: undefined,
            finished_at: null,
            task_status: 'paused',
            completion_status: 'cancelled'
        }),
        task('relative', { workspace: 'relative/work' }),
        task('missing-status', { task_status: undefined, completion_status: undefined })
    ];
    const getTaskList = () => entries;
    const service = createRemoteSessionService(
        {
            ...noObservers,
            getTaskList,
            getTaskLoadResult: () => ({ task: undefined, corrupted: false }),
            getDefaultWorkspace: () => {
                workspaceReads += 1;
                return DEFAULT_WORKSPACE;
            }
        },
        {
            resolveInteractionSessionScope: createInteractionSessionScopeResolver(getTaskList),
            diagnose: (diagnostic) => diagnostics.push(diagnostic)
        }
    );

    const result = await service.listSessions({});
    const byId = new Map(result.map((entry) => [entry.sessionId, entry]));

    assert.equal(workspaceReads, 1);
    assert.equal(byId.get('explicit')?.cwd, '/work/explicit');
    assert.equal(byId.get('explicit')?.updatedAt, '2026-08-19T00:00:00.000Z');
    assert.equal(byId.get('explicit')?.taskStatus, 'failed');
    assert.equal(byId.get('explicit')?.completionStatus, 'ask');
    assert.equal(byId.get('blank')?.cwd, DEFAULT_WORKSPACE);
    assert.equal(byId.get('relative')?.cwd, DEFAULT_WORKSPACE);
    assert.equal(byId.get('blank')?.updatedAt, '1970-01-01T00:00:00.000Z');
    assert.equal(byId.get('blank')?.taskStatus, 'stopped');
    assert.equal(byId.get('blank')?.completionStatus, null);
    assert.equal(byId.get('missing-status')?.taskStatus, 'stopped');
    assert.equal(byId.get('missing-status')?.completionStatus, null);
    assert.deepEqual(
        diagnostics
            .filter(({ taskId }) => taskId === 'blank')
            .map(({ code }) => code)
            .sort(),
        ['invalid_activity_time', 'unknown_completion_status', 'unknown_task_status', 'workspace_fallback']
    );
});

test('preserves stable identity and deterministic ordering', async () => {
    const { service } = serviceFor([
        task('same-b', { updated_at: '2026-08-19T00:00:00.000Z' }),
        task('newest', { updated_at: '2026-08-20T00:00:00.000Z' }),
        task('same-a', { updated_at: '2026-08-19T00:00:00.000Z' })
    ]);

    const first = await service.listSessions({});
    const second = await service.listSessions({});

    assert.deepEqual(
        first.map((entry) => entry.sessionId),
        ['newest', 'same-a', 'same-b']
    );
    assert.deepEqual(
        second.map((entry) => entry.sessionId),
        first.map((entry) => entry.sessionId)
    );
});

test('fails the whole snapshot for missing or duplicate selected ids', async () => {
    const missing = serviceFor([task(undefined)]).service.listSessions({});
    await assert.rejects(missing, RemoteSessionContractError);
    const duplicate = serviceFor([task('same'), task('same')]).service.listSessions({});
    await assert.rejects(duplicate, RemoteSessionContractError);
});

test('filters cwd after visibility and normalization', async () => {
    const { service, reads } = serviceFor([
        task('defaulted', { workspace: '' }),
        task('explicit', { workspace: '/work/other' }),
        task('child', { parent_id: 'explicit', workspace: DEFAULT_WORKSPACE })
    ]);

    assert.deepEqual(
        (await service.listSessions({ cwd: DEFAULT_WORKSPACE })).map((entry) => entry.sessionId),
        ['defaulted']
    );
    assert.equal(reads(), 1);
});

test('host binding has five required members and RSS never consults an extra physical-liveness probe', async () => {
    let physicalLivenessCalls = 0;
    const loaded = sourceTask({ task_id: 's1', task_name: 'Visible', task_status: 'stopped' });
    Object.assign(loaded, {
        async submitUserMessage(_text: string, options: { onUserMessageCommitted(id: string): void }) {
            options.onUserMessageCommitted('550e8400-e29b-41d4-a716-446655440111');
            return { status: 'ok' as const };
        },
        async waitUntilFinished() {}
    });
    const rows = [loaded] as LoadedPublicSessionTask[];
    const binding = {
        ...unavailableSessionConfigurationBinding,
        getTaskList: () => rows,
        getTaskLoadResult: () => ({ task: loaded, corrupted: false }),
        getDefaultWorkspace: () => DEFAULT_WORKSPACE,
        subscribeTaskUpdates: () => () => undefined,
        subscribeTaskManagerUpdates: () => () => undefined
    } satisfies RemoteSessionReadHostBinding & RemoteSessionConfigurationHostBinding;
    const hostWithLegacyProbe = {
        ...binding,
        isConnectionActive() {
            physicalLivenessCalls += 1;
            throw new Error('RSS must not inspect physical connection liveness');
        }
    };
    const service = createRemoteSessionService(hostWithLegacyProbe, {
        resolveInteractionSessionScope: createInteractionSessionScopeResolver(binding.getTaskList)
    });

    await service.listSessions({});
    const begun = service.beginSessionLoad('s1', (_sessionId, candidates) => candidatePlan(candidates));
    begun.sync.stop();
    const prompted = await service.startPrompt('s1', 'hello');
    if (prompted.kind === 'started') await prompted.completion;
    loaded.task_status = 'running';
    service.stopCurrentRun('s1', deriveRunToken('s1', 1));
    service.authorizeInteractionAnswer('s1', 's1');

    assert.equal(physicalLivenessCalls, 0);
});
