import assert from 'node:assert/strict';
import test from 'node:test';
import {
    HostSessionModelConfigurationError,
    type HostSessionConfigurableTask,
    type RemoteSessionConfigurationHostBinding
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/host-binding.js';
import { createInteractionSessionScopeResolver } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/session-projector.js';
import {
    RemoteSessionConfigurationError,
    createRemoteSessionService
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/service.js';
import { candidatePlan, sourceTask } from './session-projector-fixtures.js';

function configurableTask(overrides: Partial<HostSessionConfigurableTask> = {}): HostSessionConfigurableTask {
    return Object.assign(sourceTask({ task_id: 's1', task_status: 'running' }), {
        model: 'alpha',
        reasoningEffort: 'low' as const,
        persistLater() {},
        ...overrides
    });
}

function harness(task = configurableTask()) {
    let loadCalls = 0;
    let setCalls = 0;
    let read: RemoteSessionConfigurationHostBinding['readSessionModelConfiguration'] = () => ({
        current: { modelAlias: 'alpha', reasoningEffort: 'low' },
        candidates: [{ modelAlias: 'alpha', reasoningEfforts: ['', 'low'] }]
    });
    let set: RemoteSessionConfigurationHostBinding['setSessionModelConfiguration'] = (_task, selection) => {
        setCalls += 1;
        return {
            current: selection,
            candidates: [{ modelAlias: selection.modelAlias, reasoningEfforts: ['', selection.reasoningEffort] }]
        };
    };
    const binding = {
        getTaskList: () => [task],
        getTaskLoadResult: () => {
            loadCalls += 1;
            return { task, corrupted: false };
        },
        getDefaultWorkspace: () => '/work',
        subscribeTaskUpdates: () => () => undefined,
        subscribeTaskManagerUpdates: () => () => undefined,
        readSessionModelConfiguration: (value: HostSessionConfigurableTask) => read(value),
        setSessionModelConfiguration: (value: HostSessionConfigurableTask, selection: Parameters<typeof set>[1]) =>
            set(value, selection)
    };
    return {
        binding,
        loadCalls: () => loadCalls,
        setCalls: () => setCalls,
        replaceRead(value: typeof read) {
            read = value;
        },
        replaceSet(value: typeof set) {
            set = value;
        }
    };
}

const identityPlanFactory: Parameters<ReturnType<typeof createRemoteSessionService>['beginSessionLoad']>[1] = (
    _sessionId,
    candidates
) => candidatePlan(candidates);

test('load reads configuration on the same authorized task and degrades read failure', () => {
    const task = configurableTask();
    const h = harness(task);
    h.replaceRead((seen) => {
        assert.equal(seen, task);
        throw new Error('/private/path/model-config.json');
    });
    const diagnostics: unknown[] = [];
    const service = createRemoteSessionService(h.binding, {
        resolveInteractionSessionScope: createInteractionSessionScopeResolver(h.binding.getTaskList),
        diagnose: (event) => diagnostics.push(event)
    });
    const begun = service.beginSessionLoad('s1', identityPlanFactory);
    assert.equal(begun.configuration, undefined);
    assert.ok(Array.isArray(begun.snapshot.history.messages));
    assert.deepEqual(diagnostics, [{ code: 'session_configuration_unavailable', sessionId: 's1' }]);
    begun.sync.stop();
});

test('set reauthorizes and reloads on every call without status gating', () => {
    const task = configurableTask({ task_status: 'running' });
    const h = harness(task);
    const service = createRemoteSessionService(h.binding, {
        resolveInteractionSessionScope: createInteractionSessionScopeResolver(h.binding.getTaskList)
    });
    const begun = service.beginSessionLoad('s1', identityPlanFactory);
    begun.sync.stop();
    service.setSessionModelConfiguration('s1', { modelAlias: 'beta', reasoningEffort: 'max' });
    task.task_status = 'stopped';
    service.setSessionModelConfiguration('s1', { modelAlias: 'alpha', reasoningEffort: '' });
    assert.equal(h.loadCalls(), 3);
    assert.equal(h.setCalls(), 2);
});

test('an unavailable load configuration does not prevent a legal explicit set', () => {
    const h = harness();
    h.replaceRead(() => undefined);
    const service = createRemoteSessionService(h.binding, {
        resolveInteractionSessionScope: createInteractionSessionScopeResolver(h.binding.getTaskList)
    });
    const begun = service.beginSessionLoad('s1', identityPlanFactory);
    assert.equal(begun.configuration, undefined);
    begun.sync.stop();
    assert.deepEqual(
        service.setSessionModelConfiguration('s1', { modelAlias: 'beta', reasoningEffort: 'max' }).current,
        {
            modelAlias: 'beta',
            reasoningEffort: 'max'
        }
    );
});

test('set maps authorization, selection, and unexpected host failures without leaking host text', () => {
    const removed = harness();
    removed.binding.getTaskList = () => [];
    const removedService = createRemoteSessionService(removed.binding, {
        resolveInteractionSessionScope: () => undefined
    });
    assert.throws(
        () => removedService.setSessionModelConfiguration('s1', { modelAlias: 'beta', reasoningEffort: 'max' }),
        (error: unknown) => error instanceof RemoteSessionConfigurationError && error.code === 'session_unavailable'
    );

    const rejected = harness();
    rejected.replaceSet(() => {
        throw new HostSessionModelConfigurationError('invalid_selection');
    });
    const rejectedService = createRemoteSessionService(rejected.binding, {
        resolveInteractionSessionScope: () => undefined
    });
    assert.throws(
        () => rejectedService.setSessionModelConfiguration('s1', { modelAlias: 'beta', reasoningEffort: 'max' }),
        (error: unknown) => error instanceof RemoteSessionConfigurationError && error.code === 'selection_unavailable'
    );

    const failed = harness();
    failed.replaceSet(() => {
        throw new Error('/private/path/model-config.json');
    });
    const failedService = createRemoteSessionService(failed.binding, {
        resolveInteractionSessionScope: () => undefined
    });
    assert.throws(
        () => failedService.setSessionModelConfiguration('s1', { modelAlias: 'beta', reasoningEffort: 'max' }),
        (error: unknown) =>
            error instanceof RemoteSessionConfigurationError &&
            error.code === 'host_failure' &&
            !error.message.includes('/private/path')
    );
});
