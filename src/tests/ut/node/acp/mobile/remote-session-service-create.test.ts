import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    RemoteSessionCreateError,
    RemoteSessionContractError,
    createRemoteSessionService,
    isCreationCapableRemoteSessionService
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/service.js';
import { unavailableSessionConfigurationBinding } from './session-projector-fixtures.js';

function tempDirectory(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

type CreateResult = { status: 'created'; taskId: string; workspace: string } | { status: 'not_created' };

function creationBinding(options: {
    defaultWorkspace: string;
    visibleWorkspace?: string;
    create?: (input: { workspace: string }) => Promise<CreateResult>;
}) {
    const createSessionTask =
        options.create ??
        (async ({ workspace }: { workspace: string }) => ({
            status: 'created' as const,
            taskId: 'task-1',
            workspace
        }));
    return {
        binding: {
            ...unavailableSessionConfigurationBinding,
            getTaskList: () =>
                options.visibleWorkspace
                    ? [
                          {
                              task_id: 'visible-1',
                              parent_id: undefined,
                              internal: false,
                              name_pending: false,
                              task_name: 'Visible',
                              task_status: 'waiting',
                              completion_status: null,
                              workspace: options.visibleWorkspace,
                              created_at: new Date(0).toISOString(),
                              updated_at: new Date(0).toISOString()
                          }
                      ]
                    : [],
            getTaskLoadResult: () => ({ task: undefined, corrupted: false }),
            getDefaultWorkspace: () => options.defaultWorkspace,
            subscribeTaskUpdates: () => () => undefined,
            subscribeTaskManagerUpdates: () => () => undefined,
            createSessionTask
        },
        createSessionTask
    };
}

function serviceOf(binding: ReturnType<typeof creationBinding>['binding']) {
    const service = createRemoteSessionService(binding, {
        resolveInteractionSessionScope: () => undefined
    });
    assert.ok(isCreationCapableRemoteSessionService(service));
    return service;
}

test('normalizes and authorizes the current default and visible root workspaces', async (context) => {
    const defaultWorkspace = tempDirectory('session-creation-default-');
    const visibleWorkspace = tempDirectory('session-creation-visible-');
    context.after(() => {
        fs.rmSync(defaultWorkspace, { recursive: true, force: true });
        fs.rmSync(visibleWorkspace, { recursive: true, force: true });
    });
    const fixture = creationBinding({ defaultWorkspace: ` ${defaultWorkspace}${path.sep} `, visibleWorkspace });
    const service = serviceOf(fixture.binding);

    assert.deepEqual(await service.resolveDefaultWorkspace(), { workspace: defaultWorkspace });
    assert.deepEqual(
        await service.createSession({ workspace: `  ${path.join(visibleWorkspace, '.', 'child', '..')}  ` }),
        { kind: 'created', sessionId: 'task-1', workspace: visibleWorkspace }
    );
});

test('rejects every unavailable workspace before host creation', async (context) => {
    const allowed = tempDirectory('session-creation-allowed-');
    const file = path.join(allowed, 'file.txt');
    fs.writeFileSync(file, 'x');
    const outside = tempDirectory('session-creation-outside-');
    context.after(() => {
        fs.rmSync(allowed, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    });
    let calls = 0;
    const fixture = creationBinding({
        defaultWorkspace: allowed,
        create: async ({ workspace }) => {
            calls += 1;
            return { status: 'created', taskId: 'unexpected', workspace };
        }
    });
    const service = serviceOf(fixture.binding);

    for (const value of ['', '   ', 'relative', path.join(allowed, 'missing'), file, outside]) {
        await assert.rejects(
            () => service.createSession({ workspace: value }),
            (error: unknown) => error instanceof RemoteSessionCreateError && error.code === 'workspace_unavailable'
        );
    }
    assert.equal(calls, 0);
});

test('does not authorize a different symlink spelling without an exact published identity', async (context) => {
    const workspace = tempDirectory('session-creation-symlink-target-');
    const linkRoot = tempDirectory('session-creation-symlink-root-');
    const link = path.join(linkRoot, 'workspace-link');
    fs.symlinkSync(workspace, link, 'dir');
    context.after(() => {
        fs.rmSync(linkRoot, { recursive: true, force: true });
        fs.rmSync(workspace, { recursive: true, force: true });
    });
    let calls = 0;
    const service = serviceOf(
        creationBinding({
            defaultWorkspace: workspace,
            create: async ({ workspace: createdWorkspace }) => {
                calls += 1;
                return { status: 'created', taskId: 'unexpected', workspace: createdWorkspace };
            }
        }).binding
    );

    await assert.rejects(
        () => service.createSession({ workspace: link }),
        (error: unknown) => error instanceof RemoteSessionCreateError && error.code === 'workspace_unavailable'
    );
    assert.equal(calls, 0);
});

test('maps only an explicit pre-create refusal and preserves post-create uncertainty', async (context) => {
    const workspace = tempDirectory('session-creation-create-');
    context.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const refused = serviceOf(
        creationBinding({
            defaultWorkspace: workspace,
            create: async () => ({ status: 'not_created' })
        }).binding
    );
    await assert.rejects(
        () => refused.createSession({ workspace }),
        (error: unknown) => error instanceof RemoteSessionCreateError && error.code === 'session_not_created'
    );

    const failure = new Error('host result is unknown');
    let calls = 0;
    const unknown = serviceOf(
        creationBinding({
            defaultWorkspace: workspace,
            create: async () => {
                calls += 1;
                throw failure;
            }
        }).binding
    );
    await assert.rejects(
        () => unknown.createSession({ workspace }),
        (error) => error === failure
    );
    assert.equal(calls, 1);
});

test('rejects invalid created results without inventing a second workspace authority', async (context) => {
    const workspace = tempDirectory('session-creation-contract-workspace-');
    const otherWorkspace = tempDirectory('session-creation-contract-other-');
    context.after(() => {
        fs.rmSync(workspace, { recursive: true, force: true });
        fs.rmSync(otherWorkspace, { recursive: true, force: true });
    });
    const invalidCreators = [
        async () => ({ status: 'created' as const, taskId: '   ', workspace }),
        async () => ({ status: 'created' as const, taskId: 'task-1', workspace: otherWorkspace })
    ];

    for (const create of invalidCreators) {
        const service = serviceOf(creationBinding({ defaultWorkspace: workspace, create }).binding);
        await assert.rejects(
            () => service.createSession({ workspace }),
            (error: unknown) =>
                error instanceof RemoteSessionContractError && error.message === 'invalid host session creation result'
        );
    }
});

test('classifies an unavailable default workspace without exposing creation capability side effects', async (context) => {
    const missing = path.join(tempDirectory('session-creation-missing-parent-'), 'missing');
    context.after(() => fs.rmSync(path.dirname(missing), { recursive: true, force: true }));
    let calls = 0;
    const service = serviceOf(
        creationBinding({
            defaultWorkspace: missing,
            create: async ({ workspace }) => {
                calls += 1;
                return { status: 'created', taskId: 'unexpected', workspace };
            }
        }).binding
    );

    await assert.rejects(
        () => service.resolveDefaultWorkspace(),
        (error: unknown) => error instanceof RemoteSessionCreateError && error.code === 'default_workspace_unavailable'
    );
    assert.equal(calls, 0);
});

test('keeps a read-only host binding creation-incapable', async (context) => {
    const workspace = tempDirectory('session-creation-read-only-');
    context.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const service = createRemoteSessionService(
        {
            ...unavailableSessionConfigurationBinding,
            getTaskList: () => [],
            getTaskLoadResult: () => ({ task: undefined, corrupted: false }),
            getDefaultWorkspace: () => workspace,
            subscribeTaskUpdates: () => () => undefined,
            subscribeTaskManagerUpdates: () => () => undefined
        },
        { resolveInteractionSessionScope: () => undefined }
    );

    assert.equal(isCreationCapableRemoteSessionService(service), false);
    assert.deepEqual(await service.listSessions({}), []);
});
