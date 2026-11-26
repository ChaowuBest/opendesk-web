import assert from 'node:assert/strict';
import test from 'node:test';
import * as acp from '@agentclientprotocol/sdk';
import type { Client } from '@agentclientprotocol/sdk';
import {
    createInteractionDeliveryRuntime,
    type AskUserDeliveryRequest,
    type InteractionDeliveryRuntime
} from '../../../../../main/aikernel/interaction/delivery.js';
import type { HostedAcpConnection } from '../../../../../main/applications/mobileaccess/acp/mobile/acp-endpoint/connection-host.js';
import {
    startMobileHostComposition,
    type MobileHostCapabilities,
    type MobileHostCompositionHandle,
    type MobileHostNetworkHandle,
    type StartMobileNetwork,
    type WrapMobileConnectionService
} from '../../../../../main/applications/mobileaccess/acp/mobile/host-composition.js';
import type {
    HostSessionConfigurableTask,
    HostSessionModelSource
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/host-binding.js';
import {
    createInteractionSessionScopeResolver,
    type RemoteSessionTaskEntry
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/session-projector.js';
import { ASK_USER_METHOD } from '../../../../../main/applications/mobileaccess/acp/mobile/interaction/message-mapper.js';
import {
    AcpConnectionClosedError,
    createAcpMessageStream,
    type AcpMessageChannel
} from '../../../../../main/applications/mobileaccess/acp/mobile/transport/acp-message-stream.js';
import { createTestChannelPair, TestAcpMessageChannel } from './test-channel.js';

interface TestTrustedContext {
    readonly connectionId: string;
}

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}

function settled(promise: Promise<unknown>): Promise<'resolved' | 'rejected' | 'pending'> {
    return Promise.race([
        promise.then(
            () => 'resolved' as const,
            () => 'rejected' as const
        ),
        Promise.resolve().then(() => 'pending' as const)
    ]);
}

async function flush(times = 12): Promise<void> {
    for (let index = 0; index < times; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function isPending(promise: Promise<unknown>): Promise<boolean> {
    let done = false;
    void promise.then(
        () => {
            done = true;
        },
        () => {
            done = true;
        }
    );
    await flush();
    return !done;
}

class NetworkDouble {
    startCalls = 0;
    closeCalls = 0;
    signal?: AbortSignal;
    deliver?: (channel: AcpMessageChannel, trustedContext: TestTrustedContext) => HostedAcpConnection;
    readonly started = deferred<MobileHostNetworkHandle>();
    readonly closeReleased = deferred();
    startThrowsWith?: Error;
    closeFailsWith?: Error;
    closeHangs = false;

    readonly handle: MobileHostNetworkHandle = {
        close: async () => {
            this.closeCalls += 1;
            if (this.closeFailsWith) throw this.closeFailsWith;
            if (this.closeHangs) await this.closeReleased.promise;
        }
    };

    readonly start: StartMobileNetwork<TestTrustedContext> = (input) => {
        this.startCalls += 1;
        this.signal = input.signal;
        this.deliver = input.openConnection;
        if (this.startThrowsWith) throw this.startThrowsWith;
        return this.started.promise;
    };

    resolveStart(): void {
        this.started.resolve(this.handle);
    }
}

function fixtureTask() {
    let stops = 0;
    let persists = 0;
    const task = {
        task_id: 'root-task',
        parent_id: undefined,
        internal: false,
        name_pending: false,
        task_name: 'Root task',
        task_status: 'stopped',
        completion_status: 'success',
        workspace: '/work',
        created_at: '2026-09-01T00:00:00.000Z',
        updated_at: '2026-09-01T00:00:01.000Z',
        chat_context: { messages: [] },
        model: 'alpha',
        reasoningEffort: '' as const,
        getTurnGeneration: () => 1,
        stop() {
            stops += 1;
        },
        async submitUserMessage() {
            return { status: 'ok' as const };
        },
        async waitUntilFinished() {},
        persistLater() {
            persists += 1;
        }
    } satisfies HostSessionConfigurableTask;
    return { task, stops: () => stops, persists: () => persists };
}

const modelSource: HostSessionModelSource = {
    listConfiguredModelAliases: () => ['alpha', 'beta'],
    resolveChatModel: (alias) =>
        alias === 'alpha'
            ? { alias, modelName: 'gpt-5' }
            : alias === 'beta'
              ? { alias, modelName: 'custom-model' }
              : undefined,
    resolveEffectiveDefaultModel: () => ({ kind: 'configured_alias', alias: 'alpha' })
};

/**
 * Capability reads are counted through getters so a test can prove the composition never assembled the
 * binding at all, rather than only proving the network was never started.
 */
function trackedCapabilities(overrides: Partial<MobileHostCapabilities> = {}) {
    const fixture = fixtureTask();
    const reads: string[] = [];
    const created: string[] = [];
    const base: MobileHostCapabilities = {
        getTaskList: () => [fixture.task] as readonly RemoteSessionTaskEntry[],
        getTaskLoadResult: (sessionId) => ({
            task: sessionId === fixture.task.task_id ? fixture.task : undefined,
            corrupted: false
        }),
        getDefaultWorkspace: () => process.cwd(),
        createSessionTask: async (input) => {
            created.push(input.workspace);
            return { status: 'created' as const, taskId: `created-${created.length}`, workspace: input.workspace };
        },
        subscribeTaskUpdates: () => () => undefined,
        subscribeTaskManagerUpdates: () => () => undefined,
        sessionModelSource: modelSource,
        ...overrides
    };
    const capabilities = {} as MobileHostCapabilities;
    for (const key of Object.keys(base) as Array<keyof MobileHostCapabilities>) {
        Object.defineProperty(capabilities, key, {
            enumerable: true,
            get() {
                reads.push(key);
                return base[key];
            }
        });
    }
    return { capabilities, reads, created, fixture };
}

function runtimeFor(capabilities: MobileHostCapabilities): InteractionDeliveryRuntime {
    return createInteractionDeliveryRuntime(createInteractionSessionScopeResolver(() => capabilities.getTaskList()));
}

class RecordingClient implements Client {
    readonly updates: acp.SessionNotification[] = [];
    readonly extRequests: Array<{ method: string; params: Record<string, unknown> }> = [];

    async requestPermission(): Promise<acp.RequestPermissionResponse> {
        return { outcome: { outcome: 'cancelled' } };
    }

    async sessionUpdate(update: acp.SessionNotification): Promise<void> {
        this.updates.push(update);
    }

    async extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
        this.extRequests.push({ method, params });
        if (method === ASK_USER_METHOD) return { answers: { 0: ['A'] } };
        throw acp.RequestError.methodNotFound(method);
    }

    async extNotification(): Promise<void> {}
}

const interactionCapability = {
    schemaVersion: 1,
    askUser: 1,
    exitPlanMode: 1,
    permission: 1,
    closed: 1
} as const;

async function connect(
    network: NetworkDouble,
    connectionId: string,
    clientCapabilities: acp.ClientCapabilities = {}
): Promise<{
    hosted: HostedAcpConnection;
    client: acp.ClientSideConnection;
    handler: RecordingClient;
    serverChannel: TestAcpMessageChannel;
    initialized: acp.InitializeResponse;
}> {
    assert.ok(network.deliver, 'network was never given an openConnection callback');
    const [clientChannel, serverChannel] = createTestChannelPair();
    const hosted = network.deliver(serverChannel, Object.freeze({ connectionId }));
    const handler = new RecordingClient();
    const binding = createAcpMessageStream(clientChannel, new AbortController());
    const client = new acp.ClientSideConnection(() => handler, binding.stream);
    const initialized = await client.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities });
    return { hosted, client, handler, serverChannel, initialized };
}

const askRequest = (): AskUserDeliveryRequest => ({
    type: 'askUser',
    requestId: 'ask-1',
    sourceTaskId: 'root-task',
    taskName: 'Root task',
    request: {
        requestId: 'ask-1',
        taskId: 'root-task',
        taskName: 'Root task',
        workspace: '/work',
        questions: [
            {
                question: 'Choose?',
                header: 'Choice',
                options: [
                    { label: 'A', description: 'First' },
                    { label: 'B', description: 'Second' }
                ]
            }
        ]
    }
});

test('the default path binds host capabilities through one base service and the injected runtime', async () => {
    let configurationNotifications = 0;
    const { capabilities, created, fixture } = trackedCapabilities({
        publishTaskListUpdate: () => {
            configurationNotifications += 1;
        }
    });
    const runtime = runtimeFor(capabilities);
    const network = new NetworkDouble();
    const controller = new AbortController();
    const diagnostics: Array<{ scope: string; event: unknown }> = [];

    const startup = startMobileHostComposition({
        hostCapabilities: capabilities,
        interactionRuntime: runtime,
        startNetwork: network.start,
        signal: controller.signal,
        diagnose: (scope, event) => diagnostics.push({ scope, event })
    });
    network.resolveStart();
    const composition = await startup;

    const { client, handler, initialized, hosted } = await connect(network, 'default-1', {
        _meta: { opendesk: { interaction: interactionCapability } }
    });
    assert.deepEqual(initialized.agentCapabilities?._meta, {
        opendesk: {
            interaction: interactionCapability,
            sessionCreation: { schemaVersion: 1, defaultWorkspace: 1 }
        }
    });

    const listed = await client.listSessions({});
    assert.deepEqual(
        listed.sessions.map((session) => session.sessionId),
        ['root-task']
    );

    const loaded = await client.loadSession({ sessionId: 'root-task', cwd: '/work', mcpServers: [] });
    assert.equal(loaded.configOptions?.[0]?.currentValue, '["alpha",""]');
    const configured = await client.setSessionConfigOption({
        sessionId: 'root-task',
        configId: 'opendesk.model_effort',
        value: '["beta","max"]'
    });
    assert.equal(configured.configOptions[0]?.currentValue, '["beta","max"]');
    assert.equal(fixture.task.model, 'beta');
    assert.equal(fixture.persists(), 1);
    assert.equal(configurationNotifications, 1);

    const workspace = process.cwd();
    const createdSession = await client.newSession({ cwd: workspace, mcpServers: [] });
    assert.deepEqual(created, [workspace]);
    assert.equal(createdSession.sessionId, 'created-1');

    // The remote endpoint must be registered on the very InteractionDeliveryRuntime the host injected.
    await client.loadSession({ sessionId: 'root-task', cwd: '/work', mcpServers: [] });
    const delivery = runtime.deliveryChannel.publishAskUser(askRequest(), () => true);
    assert.ok(delivery?.delivered);
    await flush();
    assert.deepEqual(
        handler.extRequests.map(({ method }) => method),
        [ASK_USER_METHOD]
    );

    await hosted.close();
    await composition.close();
    assert.equal(fixture.stops(), 0);
});

test('no connection service exists before delivery and every delivery shares one base service', async () => {
    const { capabilities } = trackedCapabilities();
    const network = new NetworkDouble();
    const views: Array<{ base: object; context: TestTrustedContext }> = [];
    const wrapConnectionService: WrapMobileConnectionService<TestTrustedContext> = (baseService, trustedContext) => {
        views.push({ base: baseService, context: trustedContext });
        return baseService;
    };
    const composition = await (async () => {
        const startup = startMobileHostComposition({
            hostCapabilities: capabilities,
            interactionRuntime: runtimeFor(capabilities),
            startNetwork: network.start,
            signal: new AbortController().signal,
            diagnose: () => undefined,
            wrapConnectionService
        });
        network.resolveStart();
        return startup;
    })();

    assert.equal(views.length, 0);

    const first = await connect(network, 'connection-a');
    const second = await connect(network, 'connection-b');
    assert.equal(views.length, 2);
    assert.equal(views[0].base, views[1].base);
    assert.notEqual(views[0].context, views[1].context);
    assert.equal(views[0].context.connectionId, 'connection-a');

    await first.hosted.close();
    const reconnected = await connect(network, 'connection-a');
    assert.equal(views.length, 3);
    assert.equal(views[2].base, views[0].base);
    assert.notEqual(views[2].context, views[0].context);
    assert.deepEqual((await second.client.listSessions({})).sessions.length, 1);

    await composition.close();
});

test('a wrapped view drives both the adapter and answer authorization, and one without an authorizer stays silent', async () => {
    const { capabilities } = trackedCapabilities();
    const runtime = runtimeFor(capabilities);
    const network = new NetworkDouble();
    const authorizations: string[] = [];
    let withAuthorizer = true;
    const listCalls: string[] = [];

    const startup = startMobileHostComposition({
        hostCapabilities: capabilities,
        interactionRuntime: runtime,
        startNetwork: network.start,
        signal: new AbortController().signal,
        diagnose: () => undefined,
        wrapConnectionService: (baseService, trustedContext) => {
            const view = {
                ...baseService,
                async listSessions(query: Parameters<typeof baseService.listSessions>[0]) {
                    listCalls.push(trustedContext.connectionId);
                    return baseService.listSessions(query);
                }
            };
            if (withAuthorizer) {
                return {
                    ...view,
                    authorizeInteractionAnswer(sourceTaskId: string, sessionId: string) {
                        authorizations.push(`${trustedContext.connectionId}:${sourceTaskId}:${sessionId}`);
                        baseService.authorizeInteractionAnswer(sourceTaskId, sessionId);
                    }
                };
            }
            return { ...view, authorizeInteractionAnswer: undefined };
        }
    });
    network.resolveStart();
    const composition = await startup;

    const authorized = await connect(network, 'wrapped-1', {
        _meta: { opendesk: { interaction: interactionCapability } }
    });
    assert.deepEqual(
        (authorized.initialized.agentCapabilities?._meta as { opendesk?: { interaction?: unknown } })?.opendesk
            ?.interaction,
        interactionCapability
    );
    await authorized.client.loadSession({ sessionId: 'root-task', cwd: '/work', mcpServers: [] });
    assert.ok(runtime.deliveryChannel.publishAskUser(askRequest(), () => true)?.delivered);
    await flush();
    assert.deepEqual(authorizations, ['wrapped-1:root-task:root-task']);
    await authorized.client.listSessions({});
    assert.deepEqual(listCalls, ['wrapped-1']);

    withAuthorizer = false;
    const silent = await connect(network, 'wrapped-2', {
        _meta: { opendesk: { interaction: interactionCapability } }
    });
    assert.equal(
        (silent.initialized.agentCapabilities?._meta as { opendesk?: { interaction?: unknown } })?.opendesk
            ?.interaction,
        undefined
    );

    await authorized.hosted.close();
    await silent.hosted.close();
    await composition.close();
});

test('a wrapper failure closes the delivered channel and leaves the composition usable', async () => {
    const { capabilities } = trackedCapabilities();
    const network = new NetworkDouble();
    const failure = new Error('connection service wrapper failed');
    let failNext = true;
    const startup = startMobileHostComposition({
        hostCapabilities: capabilities,
        interactionRuntime: runtimeFor(capabilities),
        startNetwork: network.start,
        signal: new AbortController().signal,
        diagnose: () => undefined,
        wrapConnectionService: (baseService) => {
            if (failNext) throw failure;
            return baseService;
        }
    });
    network.resolveStart();
    const composition = await startup;

    const rejected = new TestAcpMessageChannel();
    assert.ok(network.deliver);
    assert.throws(
        () => network.deliver!(rejected, Object.freeze({ connectionId: 'broken' })),
        (error: unknown) => error === failure
    );
    assert.equal(rejected.listenerCount, 0);
    assert.equal(rejected.events.filter((value) => value === 'port-close').length, 1);

    failNext = false;
    const healthy = await connect(network, 'healthy');
    assert.equal((await healthy.client.listSessions({})).sessions.length, 1);
    await composition.close();
});

test('an already cancelled signal rejects before any service, host or network is created', async () => {
    const { capabilities, reads } = trackedCapabilities();
    const network = new NetworkDouble();
    const reason = new Error('cancelled before start');
    const controller = new AbortController();
    controller.abort(reason);

    await assert.rejects(
        startMobileHostComposition({
            hostCapabilities: capabilities,
            interactionRuntime: runtimeFor(capabilities),
            startNetwork: network.start,
            signal: controller.signal,
            diagnose: () => undefined
        }),
        (error: unknown) => error === reason
    );
    assert.equal(network.startCalls, 0);
    assert.deepEqual(reads, []);
});

test('the network receives a forwarded lifetime signal that never aborts the host controller', async () => {
    const { capabilities } = trackedCapabilities();
    const network = new NetworkDouble();
    const controller = new AbortController();
    const startup = startMobileHostComposition({
        hostCapabilities: capabilities,
        interactionRuntime: runtimeFor(capabilities),
        startNetwork: network.start,
        signal: controller.signal,
        diagnose: () => undefined
    });
    network.resolveStart();
    const composition = await startup;

    assert.ok(network.signal);
    assert.notEqual(network.signal, controller.signal);
    assert.equal(network.signal!.aborted, false);
    await composition.close();
    assert.equal(network.signal!.aborted, true);
    assert.equal(controller.signal.aborted, false);
});

test('a synchronous network start failure rejects with the original error after cleanup settles', async () => {
    const { capabilities } = trackedCapabilities();
    const network = new NetworkDouble();
    network.startThrowsWith = new Error('listener bind failed');
    const diagnostics: unknown[] = [];

    await assert.rejects(
        startMobileHostComposition({
            hostCapabilities: capabilities,
            interactionRuntime: runtimeFor(capabilities),
            startNetwork: network.start,
            signal: new AbortController().signal,
            diagnose: (scope, event) => {
                if (scope === 'composition') diagnostics.push(event);
            }
        }),
        (error: unknown) => error === network.startThrowsWith
    );
    assert.equal(network.closeCalls, 0);
    assert.deepEqual(diagnostics, [{ code: 'network_start_failed', error: network.startThrowsWith }]);
});

test('a network that delivers before rejecting has its connections closed and reports the original cause', async () => {
    const { capabilities } = trackedCapabilities();
    const network = new NetworkDouble();
    const failure = new Error('network start rejected after delivery');
    const startup = startMobileHostComposition({
        hostCapabilities: capabilities,
        interactionRuntime: runtimeFor(capabilities),
        startNetwork: network.start,
        signal: new AbortController().signal,
        diagnose: () => undefined
    });
    await flush();
    const early = await connect(network, 'early');
    assert.equal((await early.client.listSessions({})).sessions.length, 1);

    network.started.reject(failure);
    await assert.rejects(startup, (error: unknown) => error === failure);
    await early.hosted.closed;
    assert.equal(early.serverChannel.events.filter((value) => value === 'port-close').length, 1);
    assert.equal(network.closeCalls, 0);
});

test('cancelling a pending start refuses late delivery, closes a late handle, then rejects', async () => {
    const { capabilities } = trackedCapabilities();
    const network = new NetworkDouble();
    const controller = new AbortController();
    const reason = new Error('host quit while starting');
    const startup = startMobileHostComposition({
        hostCapabilities: capabilities,
        interactionRuntime: runtimeFor(capabilities),
        startNetwork: network.start,
        signal: controller.signal,
        diagnose: () => undefined
    });
    await flush();
    const live = await connect(network, 'live');

    controller.abort(reason);
    await flush();
    assert.equal(network.signal?.aborted, true);
    await live.hosted.closed;
    assert.equal(live.serverChannel.events.filter((value) => value === 'port-close').length, 1);

    const late = new TestAcpMessageChannel();
    assert.throws(
        () => network.deliver!(late, Object.freeze({ connectionId: 'late' })),
        (error: unknown) => error instanceof AcpConnectionClosedError
    );
    assert.equal(late.events.filter((value) => value === 'port-close').length, 1);
    assert.equal(late.listenerCount, 0);

    network.closeHangs = true;
    network.resolveStart();
    assert.equal(await isPending(startup), true, 'start settled before the late handle finished closing');
    assert.equal(network.closeCalls, 1);
    network.closeReleased.resolve();
    await assert.rejects(startup, (error: unknown) => error === reason);
});

test('a returned handle stops once for repeated close and for a later host abort', async () => {
    const { capabilities, fixture } = trackedCapabilities();
    const network = new NetworkDouble();
    const controller = new AbortController();
    const startup = startMobileHostComposition({
        hostCapabilities: capabilities,
        interactionRuntime: runtimeFor(capabilities),
        startNetwork: network.start,
        signal: controller.signal,
        diagnose: () => undefined
    });
    network.resolveStart();
    const composition = await startup;
    const live = await connect(network, 'live');

    const first = composition.close();
    const second = composition.close();
    assert.equal(first, second);
    await first;
    controller.abort(new Error('host quit after close'));
    await composition.close();
    await flush();

    assert.equal(network.closeCalls, 1);
    assert.equal(fixture.stops(), 0);
    await live.hosted.closed;
    assert.equal(capabilities.getTaskList().length, 1);
});

test('an abort after the handle was returned runs the same stop without an unobserved rejection', async () => {
    const { capabilities } = trackedCapabilities();
    const network = new NetworkDouble();
    network.closeFailsWith = new Error('network close failed');
    const controller = new AbortController();
    const diagnostics: unknown[] = [];
    const startup = startMobileHostComposition({
        hostCapabilities: capabilities,
        interactionRuntime: runtimeFor(capabilities),
        startNetwork: network.start,
        signal: controller.signal,
        diagnose: (scope, event) => {
            if (scope === 'composition') diagnostics.push(event);
        }
    });
    network.resolveStart();
    const composition = await startup;

    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
        controller.abort(new Error('host quit'));
        await flush();
        await assert.rejects(composition.close(), (error: unknown) => error === network.closeFailsWith);
        await flush();
    } finally {
        process.off('unhandledRejection', onRejection);
    }
    assert.deepEqual(rejections, []);
    assert.equal(network.closeCalls, 1);
    assert.ok(
        diagnostics.some(
            (event) =>
                (event as { code?: string; target?: string }).code === 'composition_cleanup_failed' &&
                (event as { target?: string }).target === 'network'
        )
    );
});

test('closing one connection stops neither the composition nor the network', async () => {
    const { capabilities } = trackedCapabilities();
    const network = new NetworkDouble();
    const startup = startMobileHostComposition({
        hostCapabilities: capabilities,
        interactionRuntime: runtimeFor(capabilities),
        startNetwork: network.start,
        signal: new AbortController().signal,
        diagnose: () => undefined
    });
    network.resolveStart();
    const composition = await startup;

    const first = await connect(network, 'first');
    const second = await connect(network, 'second');
    await first.hosted.close();

    assert.equal(network.closeCalls, 0);
    assert.equal(network.signal?.aborted, false);
    assert.equal((await second.client.listSessions({})).sessions.length, 1);
    await composition.close();
});

test('host cleanup runs to completion while a hanging network close keeps the stop pending', async () => {
    const { capabilities } = trackedCapabilities();
    const network = new NetworkDouble();
    network.closeHangs = true;
    const startup = startMobileHostComposition({
        hostCapabilities: capabilities,
        interactionRuntime: runtimeFor(capabilities),
        startNetwork: network.start,
        signal: new AbortController().signal,
        diagnose: () => undefined
    });
    network.resolveStart();
    const composition = await startup;
    const live = await connect(network, 'live');

    const closing = composition.close();
    await live.hosted.closed;
    assert.equal(live.serverChannel.events.filter((value) => value === 'port-close').length, 1);
    assert.equal(await settled(closing), 'pending');
    assert.equal(network.closeCalls, 1);

    network.closeReleased.resolve();
    await closing;
});

test('a failing host cleanup still starts the network cleanup and reports both sides', async () => {
    const { capabilities } = trackedCapabilities();
    const network = new NetworkDouble();
    const diagnostics: unknown[] = [];
    const startup = startMobileHostComposition({
        hostCapabilities: capabilities,
        interactionRuntime: runtimeFor(capabilities),
        startNetwork: network.start,
        signal: new AbortController().signal,
        diagnose: (scope, event) => {
            if (scope === 'composition') diagnostics.push(event);
        }
    });
    network.resolveStart();
    const composition = await startup;

    const channelFailure = new Error('channel close failed');
    const hostile: AcpMessageChannel = {
        send() {},
        onMessage: () => () => undefined,
        onClose: () => () => undefined,
        close() {
            throw channelFailure;
        }
    };
    network.deliver!(hostile, Object.freeze({ connectionId: 'hostile' }));

    await assert.rejects(composition.close(), (error: unknown) => error === channelFailure);
    assert.equal(network.closeCalls, 1);
    assert.ok(
        diagnostics.some(
            (event) =>
                (event as { code?: string }).code === 'composition_cleanup_failed' &&
                (event as { target?: string }).target === 'host'
        )
    );
});

test('a throwing diagnose never blocks required cleanup', async () => {
    const { capabilities } = trackedCapabilities();
    const network = new NetworkDouble();
    const startup = startMobileHostComposition({
        hostCapabilities: capabilities,
        interactionRuntime: runtimeFor(capabilities),
        startNetwork: network.start,
        signal: new AbortController().signal,
        diagnose: () => {
            throw new Error('diagnostic sink failed');
        }
    });
    network.resolveStart();
    const composition: MobileHostCompositionHandle = await startup;
    const live = await connect(network, 'live');

    await composition.close();
    assert.equal(network.closeCalls, 1);
    await live.hosted.closed;
    assert.equal(live.serverChannel.events.filter((value) => value === 'port-close').length, 1);
});
