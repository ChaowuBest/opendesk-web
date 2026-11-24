import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import type { Client } from '@agentclientprotocol/sdk';
import { AgentRegistry } from '../../../../../main/aikernel/agents/registry.js';
import { TaskManagerState } from '../../../../../main/aikernel/task/manager.js';
import type { TaskState } from '../../../../../main/aikernel/states/tasks.js';
import {
    createInteractionDeliveryRuntime,
    type InteractionDeliveryRuntime
} from '../../../../../main/aikernel/interaction/delivery.js';
import type { HostedAcpConnection } from '../../../../../main/applications/mobileaccess/acp/mobile/acp-endpoint/connection-host.js';
import {
    startMobileHostComposition,
    type MobileHostCompositionHandle
} from '../../../../../main/applications/mobileaccess/acp/mobile/host-composition.js';
import {
    subscribeMobileTaskManagerUpdates,
    subscribeMobileTaskUpdates
} from '../../../../../main/applications/mobileaccess/acp/mobile/hosts/task-subscriptions.js';
import {
    createHostSessionTask,
    type HostSessionConfigurableTask,
    type HostSessionModelSource
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/host-binding.js';
import {
    PUBLIC_SESSION_STATE_MAX_BYTES,
    publicStateBytes
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session.js';
import { createPublicSessionIdentifierPlan } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session-identifiers.js';
import {
    collectPublicSessionIdentifierCandidates,
    createInteractionSessionScopeResolver,
    projectPublicSessionState,
    type LoadedPublicSessionTask,
    type RemoteSessionTaskEntry
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/session-projector.js';
import {
    prepareSessionFixtureComposition,
    type RemoteSessionFixtureContext,
    type SessionFixtureCompositionOptions
} from '../../../../../main/applications/mobileaccess/acp/mobile/testing/session-fixture-composition.js';
import { createIsolatedSessionFixture } from '../../../../../main/applications/mobileaccess/acp/mobile/testing/isolated-session-fixture.js';
import {
    SessionCreationFixtureController,
    hashSessionCreationValue
} from '../../../../../main/applications/mobileaccess/acp/mobile/testing/session-creation-trace.js';
import type { MobileHostCompositionDiagnosticScope } from '../../../../../main/applications/mobileaccess/acp/mobile/host-composition.js';
import { createAcpMessageStream } from '../../../../../main/applications/mobileaccess/acp/mobile/transport/acp-message-stream.js';
import { setCustomOpendeskDirectory } from '../../../../../main/utils/setting.js';
import { AbstractPlatform, setPlatform } from '../../../../../platforms/base.js';
import { createTestChannelPair, TestAcpMessageChannel } from './test-channel.js';

const interactionCapability = {
    schemaVersion: 1,
    askUser: 1,
    exitPlanMode: 1,
    permission: 1,
    closed: 1
} as const;

const sessionCreationCapability = {
    schemaVersion: 1,
    defaultWorkspace: 1
} as const;

const unavailableSessionModelSource: HostSessionModelSource = {
    listConfiguredModelAliases: () => [],
    resolveChatModel: () => undefined,
    resolveEffectiveDefaultModel: () => ({ kind: 'none' })
};

const quietClient = (): Client => ({
    async requestPermission() {
        return { outcome: { outcome: 'cancelled' } };
    },
    async sessionUpdate() {}
});

function connectClient(channel: TestAcpMessageChannel, handler: () => Client = quietClient) {
    const binding = createAcpMessageStream(channel, new AbortController());
    return new acp.ClientSideConnection(handler, binding.stream);
}

function trustedContext(connectionId: string, parts: Partial<RemoteSessionFixtureContext> = {}) {
    return Object.freeze({
        transport: 'in-memory-fixture' as const,
        connectionId,
        isActive: () => true,
        getPromptFaultPlan: () => ({}),
        getOutboundOrdinal: () => 0,
        sessionCreation: new SessionCreationFixtureController(connectionId),
        ...parts
    }) as RemoteSessionFixtureContext;
}

/**
 * The permanent coverage runs through the same public entry point as production, delivering in-memory
 * channels through the composition's own acceptance callback instead of taking a whole Connection Host.
 */
interface InMemoryCompositionOptions extends SessionFixtureCompositionOptions {
    interactionRuntime: InteractionDeliveryRuntime;
    diagnose(scope: MobileHostCompositionDiagnosticScope, event: unknown): void;
}

async function startInMemoryComposition(options: InMemoryCompositionOptions): Promise<{
    composition: MobileHostCompositionHandle;
    deliver(channel: TestAcpMessageChannel, context: RemoteSessionFixtureContext): HostedAcpConnection;
    networkCloses(): number;
}> {
    const input = prepareSessionFixtureComposition(options);
    let openConnection:
        | ((channel: TestAcpMessageChannel, context: RemoteSessionFixtureContext) => HostedAcpConnection)
        | undefined;
    let networkCloses = 0;
    const composition = await startMobileHostComposition<RemoteSessionFixtureContext>({
        hostCapabilities: input.hostCapabilities,
        interactionRuntime: options.interactionRuntime,
        wrapConnectionService: input.wrapConnectionService,
        signal: new AbortController().signal,
        diagnose: options.diagnose,
        startNetwork: async (network) => {
            openConnection = network.openConnection;
            return {
                close: async () => {
                    networkCloses += 1;
                }
            };
        }
    });
    return {
        composition,
        deliver: (channel, context) => {
            assert.ok(openConnection, 'the composition never provided an acceptance callback');
            return openConnection(channel, context);
        },
        networkCloses: () => networkCloses
    };
}

class IsolatedFixturePlatform extends AbstractPlatform {
    constructor(private readonly workspace: string) {
        super();
    }

    override getEffectiveWorkspace(): string {
        return this.workspace;
    }

    override async initPlatformHarness(): Promise<void> {
        throw new Error('isolated session creation provider fixture');
    }

    override fetch(input: string | URL, init?: RequestInit): Promise<Response> {
        return globalThis.fetch(input, init);
    }
}

function completePromptsLocally(task: TaskState, name: string): void {
    task.task_name = name;
    task.name_pending = false;
    task.markCompacted();
    task.buildToolsets = async () => [];
    task.processTaskTurn = async () => {
        task.task_status = 'stopped';
        task.finished_at = new Date();
        await task.sendSubscriptionFeedback();
        task.task_manager_state.publishTaskListUpdate();
    };
}

test('large isolated fixture stays close to but below the frozen state limit', () => {
    const fixture = createIsolatedSessionFixture('large');
    const state = projectPublicSessionState(
        fixture,
        createPublicSessionIdentifierPlan(
            fixture.task_id,
            collectPublicSessionIdentifierCandidates(fixture.chat_context.messages)
        ),
        { getDefaultWorkspace: () => '/unused' }
    );
    const bytes = publicStateBytes(state);
    assert.ok(bytes > 7.5 * 1024 * 1024);
    assert.ok(bytes <= PUBLIC_SESSION_STATE_MAX_BYTES);
});

test('the prepared inputs bind the real callbacks through the public composition', async () => {
    const calls: string[] = [];
    const diagnostics: Array<{ scope: string; event: unknown }> = [];

    const getTaskList = () => {
        calls.push('getTaskList');
        return [
            {
                task_id: 'real-task',
                task_name: 'Real task',
                task_status: 'running',
                completion_status: null,
                workspace: '',
                updated_at: '2026-08-19T01:02:03.000Z'
            }
        ];
    };
    const started = await startInMemoryComposition({
        getTaskList,
        interactionRuntime: createInteractionDeliveryRuntime(createInteractionSessionScopeResolver(getTaskList)),
        getTaskLoadResult() {
            return { task: undefined, corrupted: false };
        },
        sessionModelSource: unavailableSessionModelSource,
        getDefaultWorkspace() {
            calls.push('getDefaultWorkspace');
            return '/Users/stella/OpenDesk';
        },
        async createSessionTask(input) {
            return { status: 'created' as const, taskId: 'created-task', workspace: input.workspace };
        },
        subscribeTaskUpdates: () => () => undefined,
        subscribeTaskManagerUpdates: () => () => undefined,
        diagnose(scope, event) {
            diagnostics.push({ scope, event });
        }
    });

    assert.deepEqual(calls, []);
    const [clientPort, serverPort] = createTestChannelPair();
    const hosted = started.deliver(serverPort, trustedContext('trusted-1'));
    const client = connectClient(clientPort);
    const initialized = await client.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { _meta: { opendesk: { interaction: interactionCapability } } }
    });
    assert.deepEqual(initialized.agentCapabilities?._meta, {
        opendesk: {
            interaction: interactionCapability,
            sessionCreation: sessionCreationCapability
        }
    });
    const response = await client.listSessions({});

    assert.deepEqual(calls, ['getTaskList', 'getDefaultWorkspace']);
    assert.deepEqual(response.sessions, [
        {
            sessionId: 'real-task',
            cwd: '/Users/stella/OpenDesk',
            title: 'Real task',
            updatedAt: '2026-08-19T01:02:03.000Z',
            _meta: {
                opendesk: {
                    schemaVersion: 1,
                    taskStatus: 'running',
                    completionStatus: null
                }
            }
        }
    ]);
    assert.deepEqual(
        diagnostics.map(({ scope }) => scope),
        ['rss']
    );

    await started.composition.close();
    assert.equal(started.networkCloses(), 1);
    await hosted.closed;
    assert.equal(serverPort.events.filter((value) => value === 'port-close').length, 1);
});

test('the composition reads and sets configuration through one RSS and Host binding', async () => {
    let persists = 0;
    const task = {
        task_id: 'config-task',
        parent_id: undefined,
        internal: false,
        task_name: 'Config task',
        task_status: 'running',
        completion_status: null,
        workspace: '/work',
        created_at: '2026-09-03T00:00:00.000Z',
        updated_at: '2026-09-03T00:00:00.000Z',
        chat_context: { messages: [] },
        model: 'alpha',
        reasoningEffort: '' as const,
        getTurnGeneration: () => 1,
        stop() {},
        async submitUserMessage() {
            return { status: 'ok' as const };
        },
        async waitUntilFinished() {},
        persistLater() {
            persists += 1;
        }
    } satisfies HostSessionConfigurableTask;
    const models = new Map([
        ['alpha', { alias: 'alpha', modelName: 'gpt-5' }],
        ['beta', { alias: 'beta', modelName: 'custom-model' }]
    ]);
    const getTaskList = () => [task];
    const started = await startInMemoryComposition({
        getTaskList,
        interactionRuntime: createInteractionDeliveryRuntime(createInteractionSessionScopeResolver(getTaskList)),
        getTaskLoadResult: () => ({ task, corrupted: false }),
        getDefaultWorkspace: () => '/work',
        sessionModelSource: {
            listConfiguredModelAliases: () => ['alpha', 'beta'],
            resolveChatModel: (alias) => models.get(alias),
            resolveEffectiveDefaultModel: () => ({ kind: 'configured_alias', alias: 'alpha' })
        },
        async createSessionTask(input) {
            return { status: 'created' as const, taskId: 'created-task', workspace: input.workspace };
        },
        subscribeTaskUpdates: () => () => undefined,
        subscribeTaskManagerUpdates: () => () => undefined,
        diagnose: () => undefined
    });

    const [clientPort, serverPort] = createTestChannelPair();
    const hosted = started.deliver(serverPort, trustedContext('configuration'));
    const client = connectClient(clientPort);
    await client.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    const loaded = await client.loadSession({ sessionId: task.task_id, cwd: '/work', mcpServers: [] });
    assert.equal(loaded.configOptions?.[0]?.currentValue, '["alpha",""]');
    const configured = await client.setSessionConfigOption({
        sessionId: task.task_id,
        configId: 'opendesk.model_effort',
        value: '["beta","max"]'
    });
    assert.equal(configured.configOptions[0]?.currentValue, '["beta","max"]');
    assert.equal(task.model, 'beta');
    assert.equal(task.reasoningEffort, 'max');
    assert.equal(persists, 1);
    await hosted.close();
    await started.composition.close();
});

test('isolated fixture uses the same Host Adapter and RSS without reading product tasks', async () => {
    const forbidden = () => {
        throw new Error('product task source must not be read for an isolated fixture');
    };
    const started = await startInMemoryComposition({
        fixture: 'mixed',
        getTaskList: forbidden,
        interactionRuntime: createInteractionDeliveryRuntime(forbidden),
        getTaskLoadResult: forbidden,
        sessionModelSource: unavailableSessionModelSource,
        getDefaultWorkspace: () => '/unused',
        createSessionTask: forbidden,
        subscribeTaskUpdates: forbidden,
        subscribeTaskManagerUpdates: forbidden,
        diagnose: () => undefined
    });
    const [clientPort, serverPort] = createTestChannelPair();
    const hosted = started.deliver(serverPort, trustedContext('fixture'));
    const events: acp.SessionNotification[] = [];
    const client = connectClient(clientPort, () => ({
        async requestPermission() {
            return { outcome: { outcome: 'cancelled' } };
        },
        async sessionUpdate(value) {
            events.push(value);
        }
    }));
    const initialized = await client.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { _meta: { opendesk: { interaction: interactionCapability } } }
    });
    assert.equal(initialized.agentCapabilities?._meta, undefined);
    await assert.rejects(
        () => client.newSession({ cwd: '/request-only', mcpServers: [] }),
        (error: unknown) => error instanceof acp.RequestError && error.code === -32601
    );
    const listed = await client.listSessions({});
    assert.equal(listed.sessions.length, 1);
    assert.equal(listed.sessions[0].sessionId, 'isolated-session-fixture-mixed');
    await client.loadSession({
        sessionId: 'isolated-session-fixture-mixed',
        cwd: '/request-only',
        mcpServers: []
    });
    assert.deepEqual(
        events.map((event) => event.update.sessionUpdate),
        [
            'session_info_update',
            'user_message_chunk',
            'user_message_chunk',
            'user_message_chunk',
            'agent_thought_chunk',
            'tool_call',
            'agent_message_chunk',
            'agent_message_chunk',
            'agent_message_chunk',
            'agent_message_chunk'
        ]
    );
    assert.deepEqual(events[0].update._meta?.opendesk, {
        schemaVersion: 1,
        cwd: '/tmp/opendesk-isolated-session-fixture',
        taskStatus: 'stopped',
        completionStatus: 'success',
        runToken: null
    });
    await hosted.close();
    await started.composition.close();
});

test('the composition creates connection-local diagnostic wrappers over one shared base RSS', async () => {
    const task: LoadedPublicSessionTask = {
        task_id: 'real-task',
        task_name: 'Real task',
        task_status: 'stopped',
        completion_status: 'success',
        workspace: '/work',
        created_at: '2026-08-24T00:00:00.000Z',
        updated_at: '2026-08-24T00:00:01.000Z',
        internal: false,
        name_pending: false,
        chat_context: { messages: [] },
        getTurnGeneration: () => 1,
        stop() {},
        async submitUserMessage() {
            throw new Error('recorded fixture must not submit to the product task');
        },
        async waitUntilFinished() {
            throw new Error('recorded fixture must not wait for the product task');
        }
    };
    // The configuration path must stay unavailable without the loaded task ever being persisted.
    const configurableTask: HostSessionConfigurableTask = {
        ...task,
        persistLater() {
            throw new Error('an unavailable configuration must not persist the product task');
        }
    };
    const getTaskList = () => [task];
    const started = await startInMemoryComposition({
        getTaskList,
        interactionRuntime: createInteractionDeliveryRuntime(createInteractionSessionScopeResolver(getTaskList)),
        getTaskLoadResult: () => ({ task: configurableTask, corrupted: false }),
        sessionModelSource: unavailableSessionModelSource,
        getDefaultWorkspace: () => '/work',
        async createSessionTask(input) {
            return { status: 'created' as const, taskId: 'created-task', workspace: input.workspace };
        },
        subscribeTaskUpdates: () => () => undefined,
        subscribeTaskManagerUpdates: () => () => undefined,
        diagnose: () => undefined
    });

    const traces: string[] = [];
    const originalInfo = console.info;
    console.info = (...values: unknown[]) => traces.push(values.join(' '));
    const hosted: HostedAcpConnection[] = [];
    try {
        for (const connectionId of ['recorded-a', 'recorded-b']) {
            const [clientChannel, serverChannel] = createTestChannelPair();
            hosted.push(
                started.deliver(
                    serverChannel,
                    trustedContext(connectionId, {
                        getPromptFaultPlan: () => ({ promptMode: 'recorded_not_started' as const }),
                        getOutboundOrdinal: () => (connectionId === 'recorded-a' ? 4 : 9)
                    })
                )
            );
            const updates: acp.SessionNotification[] = [];
            const client = connectClient(clientChannel, () => ({
                async requestPermission() {
                    return { outcome: { outcome: 'cancelled' } };
                },
                async sessionUpdate(value) {
                    updates.push(value);
                }
            }));
            const initialized = await client.initialize({
                protocolVersion: acp.PROTOCOL_VERSION,
                clientCapabilities: {}
            });
            assert.deepEqual(initialized.agentCapabilities?._meta, {
                opendesk: { sessionCreation: sessionCreationCapability }
            });
            const loaded = await client.loadSession({ sessionId: 'real-task', cwd: '/work', mcpServers: [] });
            assert.equal(loaded.configOptions, undefined);
            updates.length = 0;
            await assert.rejects(
                client.prompt({ sessionId: 'real-task', prompt: [{ type: 'text', text: 'record me' }] }),
                (error: unknown) =>
                    error instanceof acp.RequestError &&
                    JSON.stringify(error.data) ===
                        JSON.stringify({ opendesk: { schemaVersion: 1, code: 'prompt_recorded_not_started' } })
            );
            assert.equal(updates.length, 1);
            const meta = updates[0].update._meta as { opendesk?: { submissionState?: unknown } } | undefined;
            assert.equal(meta?.opendesk?.submissionState, 'recorded_not_started');
            assert.equal(updates[0].update.sessionUpdate, 'user_message_chunk');
        }
    } finally {
        console.info = originalInfo;
        await Promise.all(hosted.map((handle) => handle.close()));
        await started.composition.close();
    }
    const promptTraces = traces.filter((line) => line.includes('[MobileSessionFixture][prompt]'));
    assert.equal(promptTraces.filter((line) => line.includes('"connectionId":"recorded-a"')).length, 3);
    assert.equal(promptTraces.filter((line) => line.includes('"connectionId":"recorded-b"')).length, 3);
    assert.equal(promptTraces.filter((line) => line.includes('"promptOrdinal":1')).length, 6);
});

test('vertical composition creates, loads and prompts one real isolated Task without replacing the loaded session early', async () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-session-creation-profile-'));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-session-creation-workspace-'));
    const previousConfigDirectory = process.env.OPENDESK_CONFIG_DIRECTORY;
    const manager = new TaskManagerState();
    const diagnostics: unknown[] = [];
    const traces: string[] = [];
    const originalInfo = console.info;
    let hosted: HostedAcpConnection | undefined;
    let composition: MobileHostCompositionHandle | undefined;

    process.env.OPENDESK_CONFIG_DIRECTORY = profile;
    setCustomOpendeskDirectory(profile);
    setPlatform(new IsolatedFixturePlatform(workspace));
    AgentRegistry.initBuiltinAgents();
    console.info = (...values: unknown[]) => traces.push(values.join(' '));

    try {
        const createTask = async () => {
            const result = await createHostSessionTask(
                { workspace },
                {
                    taskManager: manager,
                    getDefaultExecutionNodeId: () => '',
                    getExecutionNode: () => null,
                    diagnose: (event) => diagnostics.push(event)
                }
            );
            if (result.status === 'created') {
                const task = manager.getTask(result.taskId);
                assert.ok(task);
                completePromptsLocally(task, `Isolated session ${manager.tasks.length}`);
            }
            return result;
        };

        const existing = await createTask();
        assert.equal(existing.status, 'created');
        if (existing.status !== 'created') return;

        const getTaskList = () => manager.getTaskList() as readonly RemoteSessionTaskEntry[];
        const started = await startInMemoryComposition({
            getTaskList,
            interactionRuntime: createInteractionDeliveryRuntime(() => undefined),
            getTaskLoadResult(sessionId) {
                const result = manager.getTaskLoadResult(sessionId);
                return {
                    task: result.task as HostSessionConfigurableTask | undefined,
                    corrupted: result.corrupted
                };
            },
            sessionModelSource: unavailableSessionModelSource,
            getDefaultWorkspace: () => workspace,
            createSessionTask: () => createTask(),
            subscribeTaskUpdates: (task, subscriber) =>
                subscribeMobileTaskUpdates(task as unknown as TaskState, subscriber),
            subscribeTaskManagerUpdates: (subscriber) => subscribeMobileTaskManagerUpdates(manager, subscriber),
            diagnose: (_scope, event) => diagnostics.push(event)
        });
        composition = started.composition;

        const controller = new SessionCreationFixtureController('vertical-connection');
        const [clientChannel, serverChannel] = createTestChannelPair();
        hosted = started.deliver(
            serverChannel,
            trustedContext(controller.connectionId, {
                getPromptFaultPlan: () => ({ promptMode: 'normal' as const }),
                sessionCreation: controller
            })
        );
        const updates: acp.SessionNotification[] = [];
        const client = connectClient(clientChannel, () => ({
            async requestPermission() {
                return { outcome: { outcome: 'cancelled' } };
            },
            async sessionUpdate(update) {
                updates.push(update);
            }
        }));

        const initialized = await client.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {}
        });
        assert.deepEqual(initialized.agentCapabilities?._meta, {
            opendesk: { sessionCreation: sessionCreationCapability }
        });
        assert.deepEqual(await client.extMethod('_opendesk/session/default-workspace', {}), { workspace });

        await client.loadSession({ sessionId: existing.taskId, cwd: workspace, mcpServers: [] });
        const beforeIds = new Set(manager.tasks.map((task) => task.task_id));
        const created = await client.newSession({ cwd: workspace, mcpServers: [] });
        const afterIds = new Set(manager.tasks.map((task) => task.task_id));
        const addedIds = [...afterIds].filter((taskId) => !beforeIds.has(taskId));
        const removedIds = [...beforeIds].filter((taskId) => !afterIds.has(taskId));
        assert.deepEqual(addedIds, [created.sessionId]);
        assert.deepEqual(removedIds, []);
        assert.equal(manager.getTask(created.sessionId)?.workspace, workspace);

        assert.deepEqual(
            await client.prompt({
                sessionId: existing.taskId,
                prompt: [{ type: 'text', text: 'existing session remains loaded' }]
            }),
            { stopReason: 'end_turn' }
        );
        await client.loadSession({ sessionId: created.sessionId, cwd: workspace, mcpServers: [] });
        await assert.rejects(
            () =>
                client.prompt({
                    sessionId: existing.taskId,
                    prompt: [{ type: 'text', text: 'old session is no longer loaded' }]
                }),
            (error: unknown) => error instanceof acp.RequestError
        );
        assert.deepEqual(
            await client.prompt({
                sessionId: created.sessionId,
                prompt: [{ type: 'text', text: 'first created-session prompt' }]
            }),
            { stopReason: 'end_turn' }
        );

        const sessionIdHash = hashSessionCreationValue(created.sessionId);
        const workspaceHash = hashSessionCreationValue(workspace);
        const creationTrace = controller.snapshot();
        assert.deepEqual(
            creationTrace.map((event) => event.ordinal),
            creationTrace.map((_event, index) => index + 1)
        );
        assert.ok(
            creationTrace.some(
                (event) =>
                    event.operation === 'default' &&
                    event.outcome === 'resolved' &&
                    event.workspaceHash === workspaceHash
            )
        );
        assert.ok(
            creationTrace.some(
                (event) =>
                    event.operation === 'create' &&
                    event.outcome === 'forwarded' &&
                    event.sessionIdHash === sessionIdHash &&
                    event.workspaceHash === workspaceHash
            )
        );
        assert.ok(
            creationTrace.some(
                (event) =>
                    event.operation === 'load' && event.outcome === 'forwarded' && event.sessionIdHash === sessionIdHash
            )
        );
        const promptSnapshots = traces
            .filter((line) => line.includes('[MobileSessionFixture][prompt]'))
            .map((line) => JSON.parse(line.slice(line.indexOf('{'))) as Record<string, unknown>);
        assert.ok(
            promptSnapshots.some(
                (snapshot) =>
                    snapshot.connectionId === controller.connectionId &&
                    snapshot.sessionIdHash === sessionIdHash &&
                    snapshot.stage === 'accepted'
            )
        );
        assert.ok(
            promptSnapshots.some(
                (snapshot) =>
                    snapshot.connectionId === controller.connectionId &&
                    snapshot.sessionIdHash === sessionIdHash &&
                    snapshot.stage === 'completed'
            )
        );
        assert.equal(
            updates.filter((update) => {
                const meta = update.update._meta as { opendesk?: { submissionState?: unknown } } | undefined;
                return meta?.opendesk?.submissionState === 'accepted';
            }).length,
            2
        );
    } finally {
        console.info = originalInfo;
        await hosted?.close();
        await composition?.close();
        await manager.flushAllPendingSaves();
        manager.disposeLazyHarnessInit();
        setCustomOpendeskDirectory(undefined);
        if (previousConfigDirectory === undefined) delete process.env.OPENDESK_CONFIG_DIRECTORY;
        else process.env.OPENDESK_CONFIG_DIRECTORY = previousConfigDirectory;
        fs.rmSync(profile, { recursive: true, force: true });
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});
