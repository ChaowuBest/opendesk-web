import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AgentDecl, ModeDecl } from '../../../../main/aikernel/agents/common.js';
import type { TaskState } from '../../../../main/aikernel/states/tasks.js';
import type { StaffTaskRecord } from '../../../../main/applications/agentoffice/common.js';
import { GlobalState } from '../../../../main/aikernel/states/global.js';
import { setPlatform, type AbstractPlatform } from '../../../../platforms/base.js';
import {
    acquireStaffTaskForMessage,
    AgentOfficeApplication,
    applyStaffModelToTask,
    applyStaffPermissionToTask,
    assignStaffAgentToTask,
    findRunningStaffTaskBySource,
    interpolateAgentOfficePrompt,
    mergeStaffTaskRecord
} from '../../../../main/applications/agentoffice/app.js';

test('agent office prompt interpolation preserves dollar sequences in workspace and message content', () => {
    assert.equal(
        interpolateAgentOfficePrompt('Workspace: ${workspace}\nMessage: ${message}', {
            workspace: '/tmp/$&-workspace',
            message: "keep $` and $' unchanged"
        }),
        "Workspace: /tmp/$&-workspace\nMessage: keep $` and $' unchanged"
    );
});

test('application worker boundary keeps the result unwrapping function at runtime', async () => {
    const application = new AgentOfficeApplication();
    application.callWorker = async (methodName: string) => ({
        status: 'ok',
        data: { methodName, id: 'staff-id' }
    });

    const created = (await application.createStaff({
        name: 'Avery',
        vendor_name: 'OpenDesk',
        title: 'Research Analyst',
        specialties: []
    })) as { methodName: string; id: string };

    assert.deepEqual(created, { methodName: 'createStaff', id: 'staff-id' });
});

test('office is declared as an experimental application', () => {
    const application = new AgentOfficeApplication();

    assert.equal(application.isExperimental(), true);
    assert.equal(application.toJSON().isExperimental, true);
});

test('portrait updates accept cropped PNG data and reject other data URI formats', async () => {
    const application = new AgentOfficeApplication();
    let forwardedInput: unknown;
    application.callWorker = async (_methodName: string, _staffId: string, input: unknown) => {
        forwardedInput = input;
        return { status: 'ok', data: { id: 'staff-id' } };
    };
    const portrait = 'data:image/png;base64,iVBORw0KGgo=';

    await application.updateStaff('staff-id', { portrait_data_uri: portrait });

    assert.deepEqual(forwardedInput, { portrait_data_uri: portrait });
    await assert.rejects(application.updateStaff('staff-id', { portrait_data_uri: 'data:image/jpeg;base64,/9j/4AAQ' }));
});

test('batch staff Skill import reports individual successes and failures', async () => {
    const application = new AgentOfficeApplication();
    application.callWorker = async (_methodName: string, _staffId: string, sourcePath: string) =>
        sourcePath.endsWith('bad')
            ? { status: 'error', message: 'invalid Skill' }
            : { status: 'ok', data: { name: 'good-skill' } };

    const result = await application.addSkillSources('staff-id', ['/skills/good', '/skills/bad', '/skills/good']);

    assert.deepEqual(result, {
        added: [{ path: '/skills/good', name: 'good-skill' }],
        errors: [{ path: '/skills/bad', message: 'invalid Skill' }]
    });
});

test('URL staff Skill import limits the download and removes its temporary archive', async () => {
    setPlatform({
        fetch: async () => new Response(Buffer.from('zip data'), { status: 200 })
    } as unknown as AbstractPlatform);
    const application = new AgentOfficeApplication();
    let archivePath = '';
    application.callWorker = async (_methodName: string, _staffId: string, sourcePath: string) => {
        archivePath = sourcePath;
        assert.equal(fs.existsSync(sourcePath), true);
        return { status: 'ok', data: { name: 'downloaded-skill' } };
    };

    const result = await application.addSkillFromUrl('staff-id', 'https://example.com/skill.zip');

    assert.deepEqual(result, { name: 'downloaded-skill' });
    assert.equal(fs.existsSync(archivePath), false);
    await assert.rejects(application.addSkillFromUrl('staff-id', 'file:///tmp/skill.zip'));
});

test('a running staff task is interrupted and reused instead of creating another task', () => {
    const stopReasons: string[] = [];
    let internalMarkCount = 0;
    const activeTask = {
        task_id: 'active-task',
        task_status: 'running',
        usage_summary: { input_tokens: 12, output_tokens: 4 },
        getTurnGeneration: () => 3,
        markAsInternal: () => {
            internalMarkCount += 1;
        },
        stop: (reason: string) => stopReasons.push(reason)
    } as unknown as TaskState;
    let createCount = 0;
    const manager = {
        getTask: (taskId: string) => (taskId === activeTask.task_id ? activeTask : undefined),
        createTask: () => {
            createCount += 1;
            throw new Error('createTask must not be called while the staff task is running');
        }
    } as unknown as Parameters<typeof acquireStaffTaskForMessage>[1];
    const records: StaffTaskRecord[] = [
        {
            task_id: activeTask.task_id,
            message_ids: ['message-1'],
            status: 'running',
            created_at: '2026-07-19T10:00:00.000Z',
            updated_at: '2026-07-19T10:00:00.000Z'
        }
    ];
    const interrupted: string[] = [];

    const selected = acquireStaffTaskForMessage(records, manager, 'unused task name', (_task, turnKey) => {
        interrupted.push(turnKey);
    });

    assert.equal(selected.task, activeTask);
    assert.equal(selected.reused, true);
    assert.equal(selected.interruptedTurnKey, 'active-task:3');
    assert.equal(createCount, 0);
    assert.equal(internalMarkCount, 1);
    assert.deepEqual(stopReasons, ['user']);
    assert.deepEqual(interrupted, ['active-task:3']);
});

test('a new staff task is created as an internal task', () => {
    const createdTask = { task_id: 'new-task' } as TaskState;
    let options: unknown;
    const manager = {
        getTask: () => undefined,
        createTask: (_model: unknown, createOptions: unknown) => {
            options = createOptions;
            return createdTask;
        }
    } as unknown as Parameters<typeof acquireStaffTaskForMessage>[1];

    const selected = acquireStaffTaskForMessage([], manager, '[Digital Staff] hello', () => {});

    assert.equal(selected.task, createdTask);
    assert.equal(selected.reused, false);
    assert.deepEqual(options, { taskName: '[Digital Staff] hello', internal: true });
});

test('a running scheduled task is not reused or interrupted by a user message', () => {
    const scheduledTask = {
        task_id: 'scheduled-task',
        task_status: 'running',
        getTurnGeneration: () => 1
    } as unknown as TaskState;
    const userTask = { task_id: 'user-task' } as TaskState;
    let createCount = 0;
    const manager = {
        getTask: (taskId: string) => (taskId === scheduledTask.task_id ? scheduledTask : undefined),
        createTask: () => {
            createCount += 1;
            return userTask;
        }
    } as unknown as Parameters<typeof acquireStaffTaskForMessage>[1];
    const records: StaffTaskRecord[] = [
        {
            task_id: scheduledTask.task_id,
            message_ids: [],
            status: 'running',
            source: 'scheduled',
            triggered_at: '2026-07-19T10:00:00.000Z',
            created_at: '2026-07-19T10:00:00.000Z',
            updated_at: '2026-07-19T10:00:00.000Z'
        }
    ];
    let interrupted = false;

    const selected = acquireStaffTaskForMessage(records, manager, '[Digital Staff] hello', () => {
        interrupted = true;
    });

    assert.equal(selected.task, userTask);
    assert.equal(selected.reused, false);
    assert.equal(createCount, 1);
    assert.equal(interrupted, false);
});

test('running staff task selection keeps user and scheduled sources isolated', () => {
    const userTask = { task_id: 'user-task', task_status: 'running' } as TaskState;
    const scheduledTask = { task_id: 'scheduled-task', task_status: 'running' } as TaskState;
    const manager = {
        getTask: (taskId: string) => (taskId === userTask.task_id ? userTask : scheduledTask)
    } as Pick<Parameters<typeof findRunningStaffTaskBySource>[1], 'getTask'>;
    const records: StaffTaskRecord[] = [
        {
            task_id: userTask.task_id,
            message_ids: [],
            status: 'running',
            created_at: '2026-07-19T10:00:00.000Z',
            updated_at: '2026-07-19T10:00:00.000Z'
        },
        {
            task_id: scheduledTask.task_id,
            message_ids: [],
            status: 'running',
            source: 'scheduled',
            created_at: '2026-07-19T10:01:00.000Z',
            updated_at: '2026-07-19T10:01:00.000Z'
        }
    ];

    assert.equal(findRunningStaffTaskBySource(records, manager, 'user'), userTask);
    assert.equal(findRunningStaffTaskBySource(records, manager, 'scheduled'), scheduledTask);
});

test('scheduler recovery resumes waiting scheduled tasks and settles stale records', async (context) => {
    const application = new AgentOfficeApplication() as any;
    const scheduledWaitingTask = {
        task_id: 'scheduled-waiting',
        task_status: 'waiting',
        usage_summary: undefined
    } as TaskState;
    const scheduledFailedTask = {
        task_id: 'scheduled-failed',
        task_status: 'failed',
        usage_summary: { total_tokens: 4 }
    } as TaskState;
    const userWaitingTask = {
        task_id: 'user-waiting',
        task_status: 'waiting',
        usage_summary: undefined
    } as TaskState;
    const tasks = new Map(
        [scheduledWaitingTask, scheduledFailedTask, userWaitingTask].map((task) => [task.task_id, task])
    );
    const manager = GlobalState.getInstance().taskManagerState;
    const originalGetTask = manager.getTask;
    manager.getTask = (taskId: string) => tasks.get(taskId);
    context.after(() => {
        manager.getTask = originalGetTask;
    });

    const records: StaffTaskRecord[] = [
        {
            task_id: scheduledWaitingTask.task_id,
            message_ids: [],
            source: 'scheduled',
            status: 'waiting',
            created_at: '2026-07-19T10:00:00.000Z',
            updated_at: '2026-07-19T10:00:00.000Z'
        },
        {
            task_id: scheduledFailedTask.task_id,
            message_ids: [],
            source: 'scheduled',
            status: 'running',
            created_at: '2026-07-19T10:01:00.000Z',
            updated_at: '2026-07-19T10:01:00.000Z'
        },
        {
            task_id: userWaitingTask.task_id,
            message_ids: [],
            source: 'user',
            status: 'running',
            created_at: '2026-07-19T10:02:00.000Z',
            updated_at: '2026-07-19T10:02:00.000Z'
        }
    ];
    const resumed: string[] = [];
    const updates: StaffTaskRecord[] = [];
    application.enqueueScheduledTask = (_staffId: string, task: TaskState) => resumed.push(task.task_id);
    application.callWorker = async (methodName: string, ...args: unknown[]) => {
        if (methodName === 'listStaffs') {
            return {
                status: 'ok',
                data: [
                    {
                        id: 'staff-id',
                        name: 'Ada',
                        vendor_name: 'OpenDesk',
                        title: 'Researcher',
                        specialties: [],
                        trigger_interval: '5m',
                        hired_at: '2026-07-19T09:00:00.000Z',
                        enabled: true,
                        message_count: 0,
                        task_count: records.length,
                        skill_count: 0
                    }
                ]
            };
        }
        if (methodName === 'readTasks') return { status: 'ok', data: records };
        if (methodName === 'upsertTask') {
            updates.push(args[1] as StaffTaskRecord);
            return { status: 'ok' };
        }
        throw new Error(`unexpected worker method: ${methodName}`);
    };

    await application.recoverStaffTaskRecords();

    assert.deepEqual(resumed, ['scheduled-waiting']);
    assert.deepEqual(
        updates.map((record) => ({ task_id: record.task_id, status: record.status })),
        [
            { task_id: 'scheduled-failed', status: 'failed' },
            { task_id: 'user-waiting', status: 'stopped' }
        ]
    );
});

test('reusing a staff task appends the new message while preserving task identity and creation time', () => {
    const task = {
        task_id: 'active-task',
        usage_summary: { input_tokens: 21, output_tokens: 8 }
    } as unknown as TaskState;
    const existing: StaffTaskRecord = {
        task_id: task.task_id,
        message_ids: ['message-1', 'reply-1'],
        status: 'running',
        created_at: '2026-07-19T10:00:00.000Z',
        updated_at: '2026-07-19T10:01:00.000Z'
    };

    const merged = mergeStaffTaskRecord(existing, task, 'message-2', '2026-07-19T10:02:00.000Z');

    assert.equal(merged.task_id, 'active-task');
    assert.deepEqual(merged.message_ids, ['message-1', 'reply-1', 'message-2']);
    assert.equal(merged.created_at, existing.created_at);
    assert.equal(merged.updated_at, '2026-07-19T10:02:00.000Z');
    assert.deepEqual(merged.usage_summary, task.usage_summary);
});

test('staff model overrides the task model and an empty selection restores global fallback', () => {
    let validationCount = 0;
    const task = {
        model: undefined,
        ensureValidModelOrFallback: () => {
            validationCount += 1;
            return undefined;
        }
    } as unknown as Pick<TaskState, 'model' | 'ensureValidModelOrFallback'>;

    applyStaffModelToTask(task, ' employee-model ');
    assert.equal(task.model, 'employee-model');
    applyStaffModelToTask(task, undefined);
    assert.equal(task.model, undefined);
    assert.equal(validationCount, 2);
});

test('staff task assignment preserves then refreshes permissions from Staff data', async (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentoffice-task-runtime-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace');
    const resourcesDirectory = path.join(root, 'resources');
    const protectedDirectory = path.join(root, 'protected');
    const externalDirectory = path.join(root, 'external');
    const originalPermission = { marker: 'original' };
    const task = {
        agentId: undefined,
        activeModeId: undefined,
        allowedTools: undefined,
        disabledTools: undefined,
        harnessContext: {
            permission: originalPermission
        }
    } as unknown as Pick<TaskState, 'agentId' | 'activeModeId' | 'allowedTools' | 'disabledTools' | 'harnessContext'>;
    const agent = { agentId: path.join(root, 'staff', 'agent') } as AgentDecl;
    const mode = {
        id: 'default',
        allowedTools: ['staffReply'],
        disabledTools: ['exitPlanMode']
    } as ModeDecl;

    assignStaffAgentToTask(task, agent, mode);

    assert.equal(task.agentId, agent.agentId);
    assert.equal(task.activeModeId, 'default');
    assert.deepEqual(task.allowedTools, ['staffReply']);
    assert.deepEqual(task.disabledTools, ['exitPlanMode']);
    assert.equal(task.harnessContext.permission, originalPermission);

    await applyStaffPermissionToTask(task, {
        workspace,
        resourcesDirectory,
        protectedDirectory,
        permission: {
            directories: [{ path: externalDirectory, access: 'read' }],
            network_access: false
        }
    });

    assert.notEqual(task.harnessContext.permission, originalPermission);
    assert.equal(
        (
            await task.harnessContext.permission!.check({
                resourceType: 'file',
                action: 'write',
                resourcePath: path.join(workspace, 'result.md')
            })
        ).effect,
        'allow'
    );
    assert.equal(
        (
            await task.harnessContext.permission!.check({
                resourceType: 'file',
                action: 'write',
                resourcePath: path.join(externalDirectory, 'result.md')
            })
        ).effect,
        'deny'
    );
    assert.equal(
        (
            await task.harnessContext.permission!.check({
                resourceType: 'network',
                action: 'access',
                resourcePath: 'https://example.com'
            })
        ).effect,
        'deny'
    );
});
