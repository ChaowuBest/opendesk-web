import assert from 'node:assert/strict';
import test from 'node:test';
import { createInteractionSessionScopeResolver } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/session-projector.js';
import {
    RemoteInteractionAuthorizationError,
    createRemoteSessionService
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/service.js';
import type { RemoteSessionTaskEntry } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/session-projector.js';
import { unavailableSessionConfigurationBinding } from './session-projector-fixtures.js';

function row(taskId: string, parentId: string | null = null): RemoteSessionTaskEntry {
    return {
        task_id: taskId,
        parent_id: parentId,
        task_name: taskId,
        task_status: 'stopped',
        completion_status: null,
        workspace: '/workspace',
        created_at: '2026-08-25T00:00:00.000Z',
        updated_at: '2026-08-25T00:00:00.000Z'
    };
}

test('interaction answers preserve root-scope-root ordering and classify each boundary', () => {
    let entries: RemoteSessionTaskEntry[] = [row('root-a'), row('source', 'root-a')];
    const reads: string[] = [];
    const getTaskList = () => {
        reads.push('root-read');
        return entries;
    };
    const resolver = (sourceTaskId: string) => {
        reads.push(`scope:${sourceTaskId}`);
        return createInteractionSessionScopeResolver(getTaskList)(sourceTaskId);
    };
    const service = createRemoteSessionService(
        {
            ...unavailableSessionConfigurationBinding,
            getTaskList,
            getTaskLoadResult: () => ({ task: undefined, corrupted: false }),
            getDefaultWorkspace: () => '/workspace',
            subscribeTaskUpdates: () => () => undefined,
            subscribeTaskManagerUpdates: () => () => undefined
        },
        { resolveInteractionSessionScope: resolver }
    );

    service.authorizeInteractionAnswer('source', 'root-a');
    assert.deepEqual(reads, ['root-read', 'scope:source', 'root-read', 'root-read']);

    entries = [row('root-a'), row('root-b'), row('source', 'root-b')];
    assert.throws(
        () => service.authorizeInteractionAnswer('source', 'root-a'),
        (error: unknown) =>
            error instanceof RemoteInteractionAuthorizationError && error.code === 'interaction_invalid'
    );
    entries = [row('root-a')];
    assert.throws(
        () => service.authorizeInteractionAnswer('source', 'root-a'),
        (error: unknown) =>
            error instanceof RemoteInteractionAuthorizationError && error.code === 'interaction_invalid'
    );
    entries = [row('root-a'), row('source', 'root-a'), row('source', 'root-a')];
    assert.throws(
        () => service.authorizeInteractionAnswer('source', 'root-a'),
        (error: unknown) =>
            error instanceof RemoteInteractionAuthorizationError && error.code === 'interaction_invalid'
    );
    entries = [row('root-a'), row('source', 'other'), row('other', 'source')];
    assert.throws(
        () => service.authorizeInteractionAnswer('source', 'root-a'),
        (error: unknown) =>
            error instanceof RemoteInteractionAuthorizationError && error.code === 'interaction_invalid'
    );
});

test('interaction authorization rejects a root removed during the resolver read', () => {
    let reads = 0;
    const first = [row('root-a'), row('source', 'root-a')];
    const getTaskList = () => {
        reads += 1;
        return reads < 3 ? first : [row('root-b'), row('source', 'root-b')];
    };
    const service = createRemoteSessionService(
        {
            ...unavailableSessionConfigurationBinding,
            getTaskList,
            getTaskLoadResult: () => ({ task: undefined, corrupted: false }),
            getDefaultWorkspace: () => '/workspace',
            subscribeTaskUpdates: () => () => undefined,
            subscribeTaskManagerUpdates: () => () => undefined
        },
        { resolveInteractionSessionScope: createInteractionSessionScopeResolver(getTaskList) }
    );

    assert.throws(
        () => service.authorizeInteractionAnswer('source', 'root-a'),
        (error: unknown) =>
            error instanceof RemoteInteractionAuthorizationError && error.code === 'loaded_session_invalidated'
    );
});

test('root disappearance after scope resolution wins over a simultaneous mismatch', () => {
    let reads = 0;
    const getTaskList = () => {
        reads += 1;
        return reads < 3
            ? [row('root-a'), row('root-b'), row('source', 'root-b')]
            : [row('root-b'), row('source', 'root-b')];
    };
    const service = createRemoteSessionService(
        {
            ...unavailableSessionConfigurationBinding,
            getTaskList,
            getTaskLoadResult: () => ({ task: undefined, corrupted: false }),
            getDefaultWorkspace: () => '/workspace',
            subscribeTaskUpdates: () => () => undefined,
            subscribeTaskManagerUpdates: () => () => undefined
        },
        { resolveInteractionSessionScope: createInteractionSessionScopeResolver(getTaskList) }
    );

    assert.throws(
        () => service.authorizeInteractionAnswer('source', 'root-a'),
        (error: unknown) =>
            error instanceof RemoteInteractionAuthorizationError && error.code === 'loaded_session_invalidated'
    );
});
