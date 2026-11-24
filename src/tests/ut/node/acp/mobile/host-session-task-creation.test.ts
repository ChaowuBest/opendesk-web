import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentRegistry } from '../../../../../main/aikernel/agents/registry.js';
import { BaseTaskManagerUpdateSubscriber, TaskManagerState } from '../../../../../main/aikernel/task/manager.js';
import {
    createHostSessionTask,
    type HostCreatedTask,
    type HostSessionTaskCreationDependencies,
    type HostTaskManager
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/host-binding.js';
import { getTaskDirectory, setCustomOpendeskDirectory } from '../../../../../main/utils/setting.js';
import { AbstractPlatform, setPlatform } from '../../../../../platforms/base.js';

class ThrowingHarnessPlatform extends AbstractPlatform {
    constructor(private readonly workspace: string) {
        super();
    }

    override getEffectiveWorkspace(): string {
        return this.workspace;
    }

    override async initPlatformHarness(): Promise<void> {
        throw new Error('isolated provider failure');
    }

    override fetch(input: string | URL, init?: RequestInit): Promise<Response> {
        return globalThis.fetch(input, init);
    }
}

class RecordingSubscriber extends BaseTaskManagerUpdateSubscriber {
    snapshots: object[][] = [];

    override send(taskList: object[]): void {
        this.snapshots.push(structuredClone(taskList));
    }
}

async function withIsolatedManager(
    body: (fixture: { manager: TaskManagerState; workspace: string; subscriber: RecordingSubscriber }) => Promise<void>
): Promise<void> {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-session-creation-profile-'));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-session-creation-workspace-'));
    setCustomOpendeskDirectory(profile);
    setPlatform(new ThrowingHarnessPlatform(workspace));
    AgentRegistry.initBuiltinAgents();
    const manager = new TaskManagerState();
    const subscriber = new RecordingSubscriber();
    manager.addSubscriber(subscriber);
    try {
        await body({ manager, workspace, subscriber });
        await manager.flushAllPendingSaves();
    } finally {
        manager.disposeLazyHarnessInit();
        setCustomOpendeskDirectory(undefined);
        fs.rmSync(profile, { recursive: true, force: true });
        fs.rmSync(workspace, { recursive: true, force: true });
    }
}

test('real TaskManager integration creates, owns, publishes and persists one task', async () => {
    await withIsolatedManager(async ({ manager, workspace, subscriber }) => {
        const before = manager.tasks.length;
        const diagnostics: unknown[] = [];
        const result = await createHostSessionTask(
            { workspace },
            {
                taskManager: manager,
                getDefaultExecutionNodeId: () => '',
                getExecutionNode: () => null,
                diagnose: (event) => diagnostics.push(event)
            }
        );

        assert.equal(result.status, 'created');
        if (result.status !== 'created') return;
        assert.equal(manager.tasks.length, before + 1);
        const task = manager.tasks.at(-1)!;
        assert.equal(task.task_id, result.taskId);
        assert.equal(task.workspace, workspace);
        assert.equal(task.activeModeId, task.getAgentMode().id);
        assert.deepEqual(task.getExecutionHost(), { type: 'local' });
        assert.ok(subscriber.snapshots.length >= 2);
        await manager.flushAllPendingSaves();
        const taskDirectory = getTaskDirectory();
        assert.ok(fs.existsSync(path.join(taskDirectory, `${task.task_id}.json`)));
        const index = JSON.parse(fs.readFileSync(path.join(taskDirectory, 'task_list.json'), 'utf8')) as Array<{
            task_id: string;
            workspace?: string;
        }>;
        assert.equal(index.filter((entry) => entry.task_id === task.task_id).length, 1);
        assert.equal(index.find((entry) => entry.task_id === task.task_id)?.workspace, workspace);
        assert.deepEqual(diagnostics, []);
    });
});

interface FakeContract {
    calls: string[];
    task: HostCreatedTask;
    manager: HostTaskManager;
}

function fakeContract(): FakeContract {
    const calls: string[] = [];
    const task: HostCreatedTask = {
        task_id: 'task-1',
        getAgentMode: () => ({ id: 'default' }) as never,
        setExecutionHost: async () => {
            calls.push('set_execution_host');
        },
        rebuildSystemPrompt: async () => {
            calls.push('rebuild_system_prompt');
        }
    };
    const manager: HostTaskManager = {
        tasks: [],
        createTask() {
            calls.push('create');
            (this.tasks as HostCreatedTask[]).push(task);
            return task;
        },
        async initHarness() {
            calls.push('init_harness');
        },
        publishTaskListUpdate() {
            calls.push('publish_task_list');
        }
    };
    return { calls, task, manager };
}

function dependencies(
    fixture: FakeContract,
    overrides: Partial<HostSessionTaskCreationDependencies> = {}
): HostSessionTaskCreationDependencies {
    return {
        taskManager: fixture.manager,
        getDefaultExecutionNodeId: () => '',
        getExecutionNode: () => null,
        diagnose: () => undefined,
        ...overrides
    };
}

test('helper contract rejects an unavailable execution node before create', async () => {
    const fixture = fakeContract();
    const result = await createHostSessionTask(
        { workspace: '/work' },
        dependencies(fixture, {
            getDefaultExecutionNodeId: () => 'missing',
            diagnose: () => fixture.calls.push('diagnose:execution_node_unavailable')
        })
    );

    assert.deepEqual(result, { status: 'not_created' });
    assert.deepEqual(fixture.calls, ['diagnose:execution_node_unavailable']);
    assert.equal(fixture.manager.tasks.length, 0);
});

test('helper contract propagates create failure without identity', async () => {
    const fixture = fakeContract();
    fixture.manager.createTask = () => {
        throw new Error('create failed');
    };

    await assert.rejects(() => createHostSessionTask({ workspace: '/work' }, dependencies(fixture)), /create failed/);
    assert.deepEqual(fixture.calls, []);
});

for (const step of ['init_harness', 'set_execution_host', 'rebuild_system_prompt', 'publish_task_list'] as const) {
    test(`helper contract continues after ${step} failure while still owned`, async () => {
        const fixture = fakeContract();
        if (step === 'init_harness') {
            fixture.manager.initHarness = async () => {
                fixture.calls.push('init_harness');
                throw new Error(step);
            };
        }
        if (step === 'set_execution_host') {
            fixture.task.setExecutionHost = async () => {
                fixture.calls.push('set_execution_host');
                throw new Error(step);
            };
        }
        if (step === 'rebuild_system_prompt') {
            fixture.task.rebuildSystemPrompt = async () => {
                fixture.calls.push('rebuild_system_prompt');
                throw new Error(step);
            };
        }
        if (step === 'publish_task_list') {
            fixture.manager.publishTaskListUpdate = () => {
                fixture.calls.push('publish_task_list');
                throw new Error(step);
            };
        }
        const diagnostics: unknown[] = [];

        const result = await createHostSessionTask(
            { workspace: '/work' },
            dependencies(fixture, { diagnose: (event) => diagnostics.push(event) })
        );

        assert.deepEqual(result, { status: 'created', taskId: 'task-1', workspace: '/work' });
        assert.deepEqual(diagnostics, [{ code: 'task_assembly_failed', step }]);
        assert.deepEqual(fixture.calls, [
            'create',
            'init_harness',
            'set_execution_host',
            'rebuild_system_prompt',
            'publish_task_list'
        ]);
    });
}

for (const step of ['create', 'init_harness', 'set_execution_host', 'rebuild_system_prompt'] as const) {
    test(`helper contract stops after ownership is lost following ${step}`, async () => {
        const fixture = fakeContract();
        const remove = () => {
            Object.assign(fixture.manager, { tasks: [] });
        };
        if (step === 'create') {
            const create = fixture.manager.createTask.bind(fixture.manager);
            fixture.manager.createTask = () => {
                const task = create();
                remove();
                return task;
            };
        }
        if (step === 'init_harness') {
            fixture.manager.initHarness = async () => {
                fixture.calls.push('init_harness');
                remove();
            };
        }
        if (step === 'set_execution_host') {
            fixture.task.setExecutionHost = async () => {
                fixture.calls.push('set_execution_host');
                remove();
            };
        }
        if (step === 'rebuild_system_prompt') {
            fixture.task.rebuildSystemPrompt = async () => {
                fixture.calls.push('rebuild_system_prompt');
                remove();
            };
        }

        const result = await createHostSessionTask({ workspace: '/work' }, dependencies(fixture));

        assert.deepEqual(result, { status: 'created', taskId: 'task-1', workspace: '/work' });
        const boundary = ['create', 'init_harness', 'set_execution_host', 'rebuild_system_prompt'].indexOf(step);
        assert.deepEqual(
            fixture.calls,
            ['create', 'init_harness', 'set_execution_host', 'rebuild_system_prompt'].slice(0, boundary + 1)
        );
    });
}

test('helper contract ignores failures from the diagnostic sink', async () => {
    const fixture = fakeContract();
    fixture.manager.initHarness = async () => {
        fixture.calls.push('init_harness');
        throw new Error('assembly failed');
    };

    const result = await createHostSessionTask(
        { workspace: '/work' },
        dependencies(fixture, {
            diagnose: () => {
                throw new Error('diagnostic failed');
            }
        })
    );

    assert.equal(result.status, 'created');
    assert.equal(fixture.calls.at(-1), 'publish_task_list');
});
