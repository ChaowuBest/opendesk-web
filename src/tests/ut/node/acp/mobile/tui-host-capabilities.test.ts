import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentRegistry } from '../../../../../main/aikernel/agents/registry.js';
import { BaseTaskManagerUpdateSubscriber, TaskManagerState } from '../../../../../main/aikernel/task/manager.js';
import { createTuiCapabilitySource } from '../../../../../main/applications/mobileaccess/tui.js';
import { OpenDeskTUI } from '../../../../../main/tui/entry.js';
import { createTuiHostCapabilities } from '../../../../../main/applications/mobileaccess/acp/mobile/hosts/tui-capabilities.js';
import { Setting, setCustomOpendeskDirectory } from '../../../../../main/utils/setting.js';
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
    Setting.getInstance().setData(
        Setting.getSettingSchema().parse({
            providers: [{ name: 'synthetic', base_url: 'http://127.0.0.1:1', api_key: 'synthetic' }],
            models: ['B', 'C'].map((alias) => ({ alias, model_name: alias, provider_name: 'synthetic' })),
            default_model: 'C'
        })
    );
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

test('phone create preserves TUI new model and mode without changing its active task', async () => {
    await withIsolatedManager(async ({ manager, workspace }) => {
        const active = manager.createTask('C');
        const terminal = { activeTaskId: active.task_id };
        const mode = AgentRegistry.getMainAgent()
            .supportedModes()
            .find((value) => value.id !== active.getAgentMode().id)!;
        assert.ok(mode);
        const capabilities = createTuiHostCapabilities({
            taskManager: manager,
            getModelOverride: () => 'B',
            getMainMode: () => mode,
            getDefaultWorkspace: () => workspace,
            sessionModelSource: {
                listConfiguredModelAliases: () => ['B', 'C'],
                resolveChatModel: (alias) => ({ alias, modelName: alias }),
                resolveEffectiveDefaultModel: () => ({ kind: 'configured_alias', alias: 'B' })
            },
            getDefaultExecutionNodeId: () => '',
            getExecutionNode: () => null,
            diagnose: () => undefined
        });
        const result = await capabilities.createSessionTask!({ workspace });
        assert.equal(result.status, 'created');
        if (result.status !== 'created') return;
        const created = manager.getTask(result.taskId)!;
        assert.equal(created.model, 'B');
        assert.equal(created.activeModeId, mode.id);
        assert.equal(created.workspace, workspace);
        assert.equal(terminal.activeTaskId, active.task_id);
        assert.equal(active.model, 'C');
        assert.deepEqual(created.getExecutionHost(), { type: 'local' });
        assert.equal(capabilities.getTaskLoadResult(created.task_id).task, created);
    });
});

test('TUI host keeps its model override ahead of environment and active task', async () => {
    await withIsolatedManager(async ({ manager, workspace }) => {
        const current = manager.createTask('C');
        const tui = Object.assign(Object.create(OpenDeskTUI.prototype), {
            taskManagerState: manager,
            model: 'B',
            workspace,
            _activeMode: AgentRegistry.getMainAgent().getDefaultMode(),
            activeTaskId: current.task_id
        }) as OpenDeskTUI;
        const previous = process.env.OPENDESK_MODEL_NAME;
        process.env.OPENDESK_MODEL_NAME = 'synthetic-env-model';
        try {
            const source = createTuiCapabilitySource(tui);
            assert.equal(source.taskManager, manager);
            assert.deepEqual(source.sessionModelSource.resolveEffectiveDefaultModel(), {
                kind: 'configured_alias',
                alias: 'B'
            });
            tui.model = undefined;
            assert.deepEqual(source.sessionModelSource.resolveEffectiveDefaultModel(), {
                kind: 'unrepresentable'
            });
            delete process.env.OPENDESK_MODEL_NAME;
            assert.deepEqual(source.sessionModelSource.resolveEffectiveDefaultModel(), {
                kind: 'configured_alias',
                alias: 'C'
            });
            assert.equal(tui.activeTaskId, current.task_id);
        } finally {
            if (previous === undefined) delete process.env.OPENDESK_MODEL_NAME;
            else process.env.OPENDESK_MODEL_NAME = previous;
        }
    });
});
