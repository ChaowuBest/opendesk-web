import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicSessionProjectionError } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session.js';
import type { PublicSessionIdentifierCandidate } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session-identifiers.js';
import {
    createInteractionSessionScopeResolver,
    type LoadedPublicSessionTask,
    type RemoteSessionTaskEntry
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/session-projector.js';
import { createRemoteSessionService } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/service.js';
import type { HostSessionConfigurableTask } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/host-binding.js';
import { candidatePlan, sourceTask, unavailableSessionConfigurationBinding } from './session-projector-fixtures.js';

const noObservers = {
    ...unavailableSessionConfigurationBinding,
    subscribeTaskUpdates: () => () => undefined,
    subscribeTaskManagerUpdates: () => () => undefined
};

function snapshot(
    service: ReturnType<typeof createRemoteSessionService>,
    sessionId: string,
    factory: Parameters<ReturnType<typeof createRemoteSessionService>['beginSessionLoad']>[1]
) {
    const begun = service.beginSessionLoad(sessionId, factory);
    begun.sync.stop();
    return begun.snapshot;
}

test('reauthorizes every load, checks corruption before empty history and never removes data', () => {
    let list: RemoteSessionTaskEntry[] = [sourceTask({ task_id: 's1', task_name: 'Visible' })];
    let loadResult: { task: HostSessionConfigurableTask | undefined; corrupted: boolean } = {
        task: sourceTask({ task_id: 's1', messages: [] }),
        corrupted: false
    };
    let loadCalls = 0;
    const getTaskList = () => list;
    const service = createRemoteSessionService(
        {
            ...noObservers,
            getTaskList,
            getTaskLoadResult: (sessionId) => {
                assert.equal(sessionId, 's1');
                loadCalls += 1;
                return loadResult;
            },
            getDefaultWorkspace: () => '/default'
        },
        { resolveInteractionSessionScope: createInteractionSessionScopeResolver(getTaskList) }
    );
    const identityFactory = (_sessionId: string, candidates: readonly PublicSessionIdentifierCandidate[]) =>
        candidatePlan(candidates);

    assert.deepEqual(snapshot(service, 's1', identityFactory).history.messages, []);
    assert.equal(loadCalls, 1);
    loadResult = { task: sourceTask({ task_id: 's1', messages: [] }), corrupted: true };
    assert.throws(() => snapshot(service, 's1', identityFactory), PublicSessionProjectionError);
    list = [];
    assert.throws(
        () => snapshot(service, 's1', identityFactory),
        (error: unknown) => {
            assert.ok(error instanceof PublicSessionProjectionError);
            assert.equal(error.code, 'session_unavailable');
            return true;
        }
    );
    assert.equal(loadCalls, 2);
});

test('rejects loaded ID, parent or internal changes and uses loaded cwd as authority', () => {
    const authorized = sourceTask({ task_id: 's1', task_name: 'Visible', workspace: '/authorized' });
    let loaded = sourceTask({ task_id: 'other', task_name: 'Visible', workspace: '/loaded' });
    const getTaskList = () => [authorized];
    const service = createRemoteSessionService(
        {
            ...noObservers,
            getTaskList,
            getTaskLoadResult: () => ({ task: loaded, corrupted: false }),
            getDefaultWorkspace: () => '/default'
        },
        { resolveInteractionSessionScope: createInteractionSessionScopeResolver(getTaskList) }
    );
    const factory = (_sessionId: string, candidates: readonly PublicSessionIdentifierCandidate[]) =>
        candidatePlan(candidates);
    assert.throws(() => snapshot(service, 's1', factory));
    loaded = sourceTask({ task_id: 's1', parent_id: 'new-parent' });
    assert.throws(() => snapshot(service, 's1', factory));
    loaded = sourceTask({ task_id: 's1', internal: true });
    assert.throws(() => snapshot(service, 's1', factory));
    loaded = sourceTask({ task_id: 's1', workspace: '/loaded' });
    assert.equal(snapshot(service, 's1', factory).cwd, '/loaded');
});
