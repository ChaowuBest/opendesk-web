import assert from 'node:assert/strict';
import test from 'node:test';
import * as acp from '@agentclientprotocol/sdk';
import type { AgentSideConnection, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import {
    InteractionDeliveryChannel as DeliveryChannel,
    type InteractionDeliveryChannel,
    type AskUserDeliveryRequest,
    type ExitPlanModeDeliveryRequest,
    type PermissionDeliveryRequest
} from '../../../../../main/aikernel/interaction/delivery.js';
import { MobileAcpAgentAdapter } from '../../../../../main/applications/mobileaccess/acp/mobile/acp-endpoint/agent-adapter.js';
import {
    MobileInteractionDeliveryEndpoint,
    type MobileInteractionFailureBoundary
} from '../../../../../main/applications/mobileaccess/acp/mobile/interaction/delivery-endpoint.js';
import { MAX_INTERACTION_BYTES } from '../../../../../main/applications/mobileaccess/acp/mobile/interaction/message-mapper.js';
import type {
    RemoteInteractionAnswerAuthorizer,
    RemoteSessionService
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/service.js';
import { RemoteInteractionAuthorizationError } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/service.js';
import type { PublicSessionSyncHandle } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session-sync.js';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}

const askRequest = (): AskUserDeliveryRequest => ({
    type: 'askUser',
    requestId: 'ask-1',
    sourceTaskId: 'child-1',
    taskName: 'Task',
    request: {
        requestId: 'ask-1',
        taskId: 'child-1',
        taskName: 'Task',
        workspace: '/private/workspace',
        questions: [
            {
                question: 'Choose?',
                header: 'Choice',
                options: [
                    { label: 'A', description: 'A' },
                    { label: 'B', description: 'B' }
                ]
            }
        ]
    }
});

const permissionRequest = (): PermissionDeliveryRequest => ({
    type: 'permission',
    requestId: 'permission-1',
    sourceTaskId: 'child-1',
    taskName: 'Task',
    toolName: 'shell',
    resources: ['/workspace/file.txt'],
    options: [
        {
            optionId: 'allow-once',
            kind: 'allowOnce',
            label: 'Allow once',
            response: { decision: 'allow', rememberScope: 'none' }
        },
        {
            optionId: 'allow-prefix',
            kind: 'allowAlwaysPrefix',
            label: 'Always allow /workspace',
            prefix: '/workspace',
            response: {
                decision: 'allow',
                rememberScope: 'prefix',
                selectedPrefixPattern: '/workspace'
            }
        },
        {
            optionId: 'allow-type',
            kind: 'allowAlwaysType',
            label: 'Always allow shell',
            response: { decision: 'allow', rememberScope: 'type' }
        },
        {
            optionId: 'reject-once',
            kind: 'rejectOnce',
            label: 'Reject once',
            response: { decision: 'deny', rememberScope: 'none', denyReason: 'user_denied' }
        }
    ]
});

const exitRequest = (): ExitPlanModeDeliveryRequest => ({
    type: 'exitPlanMode',
    requestId: 'exit-1',
    sourceTaskId: 'child-1',
    taskName: 'Task',
    planContent: '# Plan',
    planRelativePath: '.plan/plan.md'
});

const inertBoundary: MobileInteractionFailureBoundary = {
    async sendFailed(send) {
        await send();
    },
    async invalidateLoadedSession(_sessionId, _endpoint, sendFailed) {
        await sendFailed();
    },
    failConnection() {}
};

test('oversized Ask/Exit delivery stays unavailable and Permission keeps the ACP size boundary', async () => {
    const extMethods: unknown[] = [];
    const permissionRequests: unknown[] = [];
    const endpoint = new MobileInteractionDeliveryEndpoint(
        'root-1',
        {
            extMethod: async (_method: string, params: unknown) => {
                extMethods.push(params);
                return {};
            },
            requestPermission: async (params: unknown) => {
                permissionRequests.push(params);
                return { outcome: { outcome: 'selected', optionId: 'allow-once' } };
            },
            extNotification: async () => undefined
        } as unknown as AgentSideConnection,
        new AbortController().signal,
        { authorizeInteractionAnswer() {} },
        inertBoundary,
        () => undefined
    );
    const oversized = 'x'.repeat(MAX_INTERACTION_BYTES + 1);

    assert.equal(
        endpoint.tryDeliverAskUser(
            {
                ...askRequest(),
                request: {
                    ...askRequest().request,
                    questions: [{ ...askRequest().request.questions[0], question: oversized }]
                }
            },
            () => true
        ),
        undefined
    );
    assert.equal(
        endpoint.tryDeliverExitPlanMode({ ...exitRequest(), planContent: oversized }, () => true),
        undefined
    );
    assert.deepEqual(extMethods, []);

    const delivered = endpoint.tryDeliverPermission(
        { ...permissionRequest(), resources: [`/workspace/${oversized}`] },
        () => true
    );
    assert.equal(delivered?.delivered, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(permissionRequests.length, 1);
});

test('endpoint owns one active request and closes accepted or superseded outcomes', async () => {
    const answer = deferred<Record<string, unknown>>();
    const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
    const authorizations: string[] = [];
    const connection = {
        extMethod: async () => answer.promise,
        extNotification: async (method: string, params: Record<string, unknown>) => {
            notifications.push({ method, params });
        }
    } as unknown as AgentSideConnection;
    const authorizer: RemoteInteractionAnswerAuthorizer = {
        authorizeInteractionAnswer(sourceTaskId, sessionId) {
            authorizations.push(`${sourceTaskId}:${sessionId}`);
        }
    };
    const endpoint = new MobileInteractionDeliveryEndpoint(
        'root-1',
        connection,
        new AbortController().signal,
        authorizer,
        inertBoundary,
        () => undefined
    );
    const received: unknown[] = [];

    assert.equal(endpoint.tryDeliverAskUser(askRequest(), (value) => (received.push(value), true))?.delivered, true);
    assert.equal(
        endpoint.tryDeliverPermission(permissionRequest(), () => true),
        undefined
    );
    answer.resolve({ answers: { 0: ['A'] } });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(received, [{ answers: { 0: ['A'] } }]);
    assert.deepEqual(authorizations, ['child-1:root-1']);
    assert.deepEqual(notifications[0], {
        method: '_opendesk/interaction/closed',
        params: {
            schemaVersion: 1,
            requestId: 'ask-1',
            sessionId: 'root-1',
            interactionType: 'askUser',
            status: 'accepted'
        }
    });
});

test('handle close and dispose withdraw late answers without business callbacks', async () => {
    const answer = deferred<Record<string, unknown>>();
    const notifications: Record<string, unknown>[] = [];
    let callbacks = 0;
    const endpoint = new MobileInteractionDeliveryEndpoint(
        'root-1',
        {
            extMethod: async () => answer.promise,
            extNotification: async (_method: string, params: Record<string, unknown>) => {
                notifications.push(params);
            }
        } as unknown as AgentSideConnection,
        new AbortController().signal,
        { authorizeInteractionAnswer() {} },
        inertBoundary,
        () => undefined
    );
    const handle = endpoint.tryDeliverAskUser(askRequest(), () => ((callbacks += 1), true));
    assert.ok(handle);
    handle.close('timeout');
    handle.close('cancelled');
    answer.resolve({ answers: { 0: ['A'] } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(callbacks, 0);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].status, 'timeout');

    const second = deferred<Record<string, unknown>>();
    const endpoint2 = new MobileInteractionDeliveryEndpoint(
        'root-1',
        {
            extMethod: async () => second.promise,
            extNotification: async () => undefined
        } as unknown as AgentSideConnection,
        new AbortController().signal,
        { authorizeInteractionAnswer() {} },
        inertBoundary,
        () => undefined
    );
    endpoint2.tryDeliverAskUser(askRequest(), () => ((callbacks += 1), true));
    endpoint2.dispose();
    second.resolve({ answers: { 0: ['A'] } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(callbacks, 0);
});

test('abort withdraws a pending delivery before authorization, callback or closed notification', async () => {
    const rpc = deferred<Record<string, unknown>>();
    const abort = new AbortController();
    let callbacks = 0;
    let authorizations = 0;
    let closed = 0;
    const endpoint = new MobileInteractionDeliveryEndpoint(
        'root-1',
        {
            extMethod: async () => rpc.promise,
            extNotification: async () => {
                closed += 1;
            }
        } as unknown as AgentSideConnection,
        abort.signal,
        { authorizeInteractionAnswer: () => void (authorizations += 1) },
        inertBoundary,
        () => undefined
    );
    assert.ok(endpoint.tryDeliverAskUser(askRequest(), () => ((callbacks += 1), true)));
    abort.abort();
    rpc.resolve({ answers: { 0: ['A'] } });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(callbacks, 0);
    assert.equal(authorizations, 0);
    assert.equal(closed, 0);
    assert.equal(
        endpoint.tryDeliverAskUser(askRequest(), () => true),
        undefined
    );
});

test('dispose is idempotent and a late rejection is silent', async () => {
    const rpc = deferred<Record<string, unknown>>();
    let callbacks = 0;
    let diagnostics = 0;
    const endpoint = new MobileInteractionDeliveryEndpoint(
        'root-1',
        {
            extMethod: async () => rpc.promise,
            extNotification: async () => undefined
        } as unknown as AgentSideConnection,
        new AbortController().signal,
        { authorizeInteractionAnswer() {} },
        inertBoundary,
        () => {
            diagnostics += 1;
        }
    );
    assert.ok(endpoint.tryDeliverAskUser(askRequest(), () => ((callbacks += 1), true)));
    endpoint.dispose();
    endpoint.dispose();
    rpc.reject(new Error('late'));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(callbacks, 0);
    assert.equal(diagnostics, 0);
});

test('permission maps selected and cancelled SDK outcomes to typed provider responses', async () => {
    for (const [outcome, expected] of [
        [{ outcome: { outcome: 'selected', optionId: 'allow-once' } }, { decision: 'allow', rememberScope: 'none' }],
        [
            { outcome: { outcome: 'selected', optionId: 'allow-prefix' } },
            { decision: 'allow', rememberScope: 'prefix', selectedPrefixPattern: '/workspace' }
        ],
        [{ outcome: { outcome: 'selected', optionId: 'allow-type' } }, { decision: 'allow', rememberScope: 'type' }],
        [
            { outcome: { outcome: 'selected', optionId: 'reject-once' } },
            { decision: 'deny', rememberScope: 'none', denyReason: 'user_denied' }
        ],
        [{ outcome: { outcome: 'cancelled' } }, { decision: 'deny', rememberScope: 'none', denyReason: 'user_denied' }]
    ] as const) {
        let received: unknown;
        const endpoint = new MobileInteractionDeliveryEndpoint(
            'root-1',
            {
                requestPermission: async () => outcome as RequestPermissionResponse,
                extNotification: async () => undefined
            } as unknown as AgentSideConnection,
            new AbortController().signal,
            { authorizeInteractionAnswer() {} },
            inertBoundary,
            () => undefined
        );
        assert.ok(endpoint.tryDeliverPermission(permissionRequest(), (value) => ((received = value), true)));
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(received, expected);
    }
});

test('permission profile failures never reach the Provider callback', async () => {
    for (const [request, outcome] of [
        [permissionRequest(), { outcome: { outcome: 'selected', optionId: 'unknown' } }],
        [
            {
                ...permissionRequest(),
                options: permissionRequest().options.filter((option) => option.kind !== 'rejectOnce')
            },
            { outcome: { outcome: 'cancelled' } }
        ]
    ] as const) {
        let callbacks = 0;
        const diagnostics: string[] = [];
        const endpoint = new MobileInteractionDeliveryEndpoint(
            'root-1',
            {
                requestPermission: async () => outcome as RequestPermissionResponse,
                extNotification: async () => undefined
            } as unknown as AgentSideConnection,
            new AbortController().signal,
            { authorizeInteractionAnswer() {} },
            inertBoundary,
            (event) => diagnostics.push(event.errorName)
        );
        endpoint.tryDeliverPermission(request, () => ((callbacks += 1), true));
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(callbacks, 0);
        assert.deepEqual(diagnostics, []);
    }
});

test('authorization failure never reaches the provider callback', async () => {
    let callbacks = 0;
    const diagnosed: string[] = [];
    const endpoint = new MobileInteractionDeliveryEndpoint(
        'root-1',
        {
            extMethod: async () => ({ answers: { 0: ['A'] } }),
            extNotification: async () => undefined
        } as unknown as AgentSideConnection,
        new AbortController().signal,
        {
            authorizeInteractionAnswer() {
                throw new Error('not live');
            }
        },
        inertBoundary,
        (event) => diagnosed.push(event.errorName)
    );
    endpoint.tryDeliverAskUser(askRequest(), () => ((callbacks += 1), true));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(callbacks, 0);
    assert.deepEqual(diagnosed, []);
});

function classifiedEndpoint(options: {
    result?: Record<string, unknown>;
    invokeError?: unknown;
    authorization?: 'ok' | 'interaction_invalid' | 'loaded_session_invalidated' | 'unexpected';
    provider?: 'true' | 'false' | 'throws';
    terminalRejects?: boolean;
    diagnoseThrows?: boolean;
}) {
    const terminals: string[] = [];
    let providerCalls = 0;
    let failedCalls = 0;
    let invalidateCalls = 0;
    let failConnectionCalls = 0;
    const boundary: MobileInteractionFailureBoundary = {
        async sendFailed(send) {
            failedCalls += 1;
            await send();
        },
        async invalidateLoadedSession(_sessionId, _endpoint, sendFailed) {
            invalidateCalls += 1;
            await sendFailed();
        },
        failConnection() {
            failConnectionCalls += 1;
        }
    };
    const endpoint = new MobileInteractionDeliveryEndpoint(
        'root-1',
        {
            async extMethod() {
                if (options.invokeError !== undefined) throw options.invokeError;
                return options.result ?? { answers: { 0: ['A'] } };
            },
            async extNotification(_method: string, params: Record<string, unknown>) {
                if (options.terminalRejects) throw new Error('terminal rejected');
                terminals.push(String(params.status));
            }
        } as unknown as AgentSideConnection,
        new AbortController().signal,
        {
            authorizeInteractionAnswer() {
                if (options.authorization === 'interaction_invalid') {
                    throw new RemoteInteractionAuthorizationError('interaction_invalid');
                }
                if (options.authorization === 'loaded_session_invalidated') {
                    throw new RemoteInteractionAuthorizationError('loaded_session_invalidated');
                }
                if (options.authorization === 'unexpected') throw new Error('authorizer failed');
            }
        },
        boundary,
        () => {
            if (options.diagnoseThrows) throw new Error('diagnostic failed');
        }
    );
    const start = () =>
        endpoint.tryDeliverAskUser(askRequest(), () => {
            providerCalls += 1;
            if (options.provider === 'throws') throw new Error('provider failed');
            return options.provider !== 'false';
        });
    return {
        endpoint,
        start,
        snapshot: () => ({
            terminals,
            providerCalls,
            failedCalls,
            invalidateCalls,
            failConnectionCalls
        })
    };
}

async function flushEndpoint(): Promise<void> {
    await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
}

test('profile, authorizer and Provider exits have exact classifications', async () => {
    const cases = [
        {
            name: 'profile',
            options: { result: { answers: {} } },
            expected: {
                terminals: ['failed'],
                providerCalls: 0,
                failedCalls: 1,
                invalidateCalls: 0,
                failConnectionCalls: 0
            }
        },
        {
            name: 'interaction-invalid',
            options: { authorization: 'interaction_invalid' as const },
            expected: {
                terminals: ['failed'],
                providerCalls: 0,
                failedCalls: 1,
                invalidateCalls: 0,
                failConnectionCalls: 0
            }
        },
        {
            name: 'root-invalid',
            options: { authorization: 'loaded_session_invalidated' as const },
            expected: {
                terminals: ['failed'],
                providerCalls: 0,
                failedCalls: 0,
                invalidateCalls: 1,
                failConnectionCalls: 0
            }
        },
        {
            name: 'auth-unexpected',
            options: { authorization: 'unexpected' as const },
            expected: { terminals: [], providerCalls: 0, failedCalls: 0, invalidateCalls: 0, failConnectionCalls: 1 }
        },
        {
            name: 'provider-false',
            options: { provider: 'false' as const },
            expected: {
                terminals: ['superseded'],
                providerCalls: 1,
                failedCalls: 0,
                invalidateCalls: 0,
                failConnectionCalls: 0
            }
        },
        {
            name: 'provider-throws',
            options: { provider: 'throws' as const },
            expected: { terminals: [], providerCalls: 1, failedCalls: 0, invalidateCalls: 0, failConnectionCalls: 1 }
        }
    ];
    for (const value of cases) {
        const fixture = classifiedEndpoint(value.options);
        fixture.start();
        await flushEndpoint();
        assert.deepEqual(fixture.snapshot(), value.expected, value.name);
    }
});

test('client RequestError is request-local while an unexpected invoke rejection closes', async () => {
    for (const [error, expectedClose] of [
        [acp.RequestError.internalError(undefined, 'withdrawn'), 0],
        [new Error('broken client handler'), 1]
    ] as const) {
        const fixture = classifiedEndpoint({ invokeError: error });
        fixture.start();
        await flushEndpoint();
        assert.equal(fixture.snapshot().providerCalls, 0);
        assert.equal(fixture.snapshot().failedCalls, 0);
        assert.equal(fixture.snapshot().failConnectionCalls, expectedClose);
    }
});

test('every necessary terminal send rejection explicitly invokes Connection failure', async () => {
    for (const value of [
        { status: 'accepted', options: {} },
        { status: 'superseded', options: { provider: 'false' as const } },
        { status: 'failed', options: { result: { answers: {} } } }
    ]) {
        const fixture = classifiedEndpoint({ ...value.options, terminalRejects: true });
        fixture.start();
        await flushEndpoint();
        assert.ok(fixture.snapshot().failConnectionCalls >= 1, value.status);
    }
    for (const status of ['timeout', 'cancelled', 'resolved'] as const) {
        const fixture = classifiedEndpoint({ terminalRejects: true });
        fixture.start()!.close(status);
        await flushEndpoint();
        assert.ok(fixture.snapshot().failConnectionCalls >= 1, status);
    }
});

test('diagnostic sink failures preserve the preselected interaction classification', async () => {
    const local = classifiedEndpoint({
        authorization: 'interaction_invalid',
        diagnoseThrows: true
    });
    local.start();
    await flushEndpoint();
    assert.deepEqual(local.snapshot(), {
        terminals: ['failed'],
        providerCalls: 0,
        failedCalls: 1,
        invalidateCalls: 0,
        failConnectionCalls: 0
    });

    const fatal = classifiedEndpoint({ provider: 'throws', diagnoseThrows: true });
    fatal.start();
    await flushEndpoint();
    assert.equal(fatal.snapshot().failedCalls, 0);
    assert.equal(fatal.snapshot().failConnectionCalls, 1);
});

function createLiveAdapter(capable: boolean) {
    const channel: InteractionDeliveryChannel = new DeliveryChannel(() => 'root-1');
    let cleanup: () => void = () => undefined;
    const rpc = deferred<Record<string, unknown>>();
    let feedPhase: PublicSessionSyncHandle['phase'] = 'buffering';
    const sync: PublicSessionSyncHandle = {
        sessionId: 'root-1',
        get phase() {
            return feedPhase;
        },
        installFatalSink() {},
        async activate() {
            feedPhase = 'live';
        },
        stop() {
            feedPhase = 'stopped';
        }
    };
    const service: RemoteSessionService = {
        setSessionModelConfiguration() {
            throw new Error('fixture has no configuration target');
        },
        stopCurrentRun() {
            throw new Error('fixture has no stop target');
        },
        async listSessions() {
            return [];
        },
        beginSessionLoad() {
            return {
                snapshot: {
                    sessionId: 'root-1',
                    title: 'Root',
                    cwd: '/workspace',
                    updatedAt: '2026-08-25T00:00:00.000Z',
                    taskStatus: 'stopped',
                    completionStatus: null,
                    runToken: null,
                    history: { messages: [] }
                },
                sync
            };
        },
        async startPrompt() {
            throw new Error('not used');
        }
    };
    const endpointConnection = {
        sessionUpdate: async () => undefined,
        extMethod: async () => rpc.promise,
        extNotification: async () => undefined,
        requestPermission: async () => ({ outcome: { outcome: 'cancelled' as const } })
    } as unknown as AgentSideConnection;
    const adapter = new MobileAcpAgentAdapter(
        endpointConnection,
        new AbortController().signal,
        service,
        () => undefined,
        () => undefined,
        (callback) => {
            cleanup = callback;
        },
        'test',
        30_000,
        {
            deliveryChannel: channel,
            answerAuthorizer: { authorizeInteractionAnswer() {} }
        }
    );
    return { adapter, channel, cleanup: () => cleanup(), rpc, capable };
}

test('agent only echoes negotiated capability and registers after a live load', async () => {
    for (const capable of [false, true]) {
        const fixture = createLiveAdapter(capable);
        const capability = {
            schemaVersion: 1,
            askUser: 1,
            exitPlanMode: 1,
            permission: 1,
            closed: 1
        } as const;
        const initialized = await fixture.adapter.initialize({
            protocolVersion: 1,
            clientCapabilities: capable ? { _meta: { opendesk: { interaction: capability } } } : {}
        });
        assert.deepEqual(
            initialized.agentCapabilities?._meta,
            capable ? { opendesk: { interaction: capability } } : undefined
        );
        assert.equal(
            fixture.channel.publishAskUser(askRequest(), () => true),
            undefined
        );
        await fixture.adapter.loadSession({ sessionId: 'root-1', cwd: '/workspace', mcpServers: [] });
        const calls: unknown[] = [];
        const handle = fixture.channel.publishAskUser(askRequest(), (answer) => (calls.push(answer), true));
        assert.equal(handle?.delivered, capable ? true : undefined);
        await fixture.adapter.extNotification('_opendesk/session/unsubscribe', { sessionId: 'root-1' });
        assert.equal(
            fixture.channel.publishAskUser(askRequest(), () => true),
            undefined
        );
        fixture.rpc.resolve({ answers: { 0: ['A'] } });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(calls.length, 0);
        fixture.cleanup();
    }
});

test('agent independently negotiates the two recovery sibling capabilities', async () => {
    const interaction = {
        schemaVersion: 1,
        askUser: 1,
        exitPlanMode: 1,
        permission: 1,
        closed: 1
    } as const;
    for (const value of [
        { failed: true, invalidation: true },
        { failed: true, invalidation: false },
        { failed: false, invalidation: true },
        { failed: false, invalidation: false }
    ]) {
        const fixture = createLiveAdapter(true);
        const initialized = await fixture.adapter.initialize({
            protocolVersion: 1,
            clientCapabilities: {
                _meta: {
                    opendesk: {
                        interaction,
                        ...(value.failed ? { interactionFailedTerminal: { schemaVersion: 1 } } : {}),
                        ...(value.invalidation ? { sessionInvalidation: { schemaVersion: 1 } } : {})
                    }
                }
            }
        });
        assert.deepEqual(initialized.agentCapabilities?._meta, {
            opendesk: {
                interaction,
                ...(value.failed ? { interactionFailedTerminal: { schemaVersion: 1 } } : {}),
                ...(value.invalidation ? { sessionInvalidation: { schemaVersion: 1 } } : {})
            }
        });
        fixture.cleanup();
    }
});

async function rootInvalidationAdapter(capabilities: { failed: boolean; invalidation: boolean }) {
    const events: string[] = [];
    const channel = new DeliveryChannel(() => 'root-1');
    const originalRegister = channel.registerEndpoint.bind(channel);
    channel.registerEndpoint = (endpoint) => {
        const disposable = endpoint as typeof endpoint & { dispose(): void };
        const originalDispose = disposable.dispose.bind(disposable);
        disposable.dispose = () => {
            events.push('endpoint-dispose');
            originalDispose();
        };
        const unregister = originalRegister(endpoint);
        return () => {
            events.push('unregister-endpoint');
            unregister();
        };
    };
    let feedPhase: PublicSessionSyncHandle['phase'] = 'buffering';
    const sync: PublicSessionSyncHandle = {
        sessionId: 'root-1',
        get phase() {
            return feedPhase;
        },
        installFatalSink() {},
        async activate() {
            feedPhase = 'live';
        },
        stop() {
            if (feedPhase === 'stopped') return;
            feedPhase = 'stopped';
            events.push('sync-stop');
        }
    };
    const service = {
        stopCurrentRun() {},
        async listSessions() {
            return [];
        },
        beginSessionLoad() {
            return {
                snapshot: {
                    sessionId: 'root-1',
                    title: 'Root',
                    cwd: '/workspace',
                    updatedAt: '2026-09-03T00:00:00.000Z',
                    taskStatus: 'stopped',
                    completionStatus: null,
                    runToken: null,
                    history: { messages: [] }
                },
                sync
            };
        },
        async startPrompt() {
            throw new Error('not used');
        }
    } as unknown as RemoteSessionService;
    const abort = new AbortController();
    let cleanup: () => void = () => undefined;
    let failClosedCalls = 0;
    const failClosed = () => {
        if (abort.signal.aborted) return;
        failClosedCalls += 1;
        cleanup();
        abort.abort(new Error('connection failed'));
    };
    const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
    const adapter = new MobileAcpAgentAdapter(
        {
            async sessionUpdate() {},
            async extMethod() {
                return { answers: { 0: ['A'] } };
            },
            async extNotification(method: string, params: Record<string, unknown>) {
                notifications.push({ method, params });
                events.push(
                    method === '_opendesk/interaction/closed'
                        ? `closed:${String(params.status)}`
                        : 'session-invalidated'
                );
            }
        } as unknown as AgentSideConnection,
        abort.signal,
        service,
        () => undefined,
        failClosed,
        (registered) => {
            cleanup = registered;
        },
        'test',
        30_000,
        {
            deliveryChannel: channel,
            answerAuthorizer: {
                authorizeInteractionAnswer() {
                    throw new RemoteInteractionAuthorizationError('loaded_session_invalidated');
                }
            }
        }
    );
    const interaction = {
        schemaVersion: 1,
        askUser: 1,
        exitPlanMode: 1,
        permission: 1,
        closed: 1
    } as const;
    await adapter.initialize({
        protocolVersion: 1,
        clientCapabilities: {
            _meta: {
                opendesk: {
                    interaction,
                    ...(capabilities.failed ? { interactionFailedTerminal: { schemaVersion: 1 } } : {}),
                    ...(capabilities.invalidation ? { sessionInvalidation: { schemaVersion: 1 } } : {})
                }
            }
        }
    });
    await adapter.loadSession({ sessionId: 'root-1', cwd: '/workspace', mcpServers: [] });
    channel.publishAskUser(askRequest(), () => true);
    await flushEndpoint();
    return { events, notifications, failClosedCalls, feedPhase };
}

test('root invalidation honors all capability combinations and wire ordering', async () => {
    for (const value of [
        { failed: true, invalidation: true, terminals: ['failed'], invalidations: 1, closes: 0 },
        { failed: true, invalidation: false, terminals: ['failed'], invalidations: 0, closes: 1 },
        { failed: false, invalidation: true, terminals: [], invalidations: 0, closes: 1 },
        { failed: false, invalidation: false, terminals: [], invalidations: 0, closes: 1 }
    ]) {
        const result = await rootInvalidationAdapter(value);
        assert.deepEqual(
            result.notifications
                .filter((notification) => notification.method === '_opendesk/interaction/closed')
                .map((notification) => notification.params.status),
            value.terminals
        );
        assert.equal(
            result.notifications.filter((notification) => notification.method === '_opendesk/session/invalidated')
                .length,
            value.invalidations
        );
        assert.equal(result.failClosedCalls, value.closes);
        assert.equal(result.feedPhase, 'stopped');
        if (value.failed && value.invalidation) {
            assert.deepEqual(result.events, [
                'unregister-endpoint',
                'sync-stop',
                'closed:failed',
                'endpoint-dispose',
                'session-invalidated'
            ]);
        }
    }
});

test('deferred Provider work runs after the terminal was sent and the exit released', async () => {
    const order: string[] = [];
    const answered = deferred<RequestPermissionResponse>();
    const endpoint = new MobileInteractionDeliveryEndpoint(
        'root-1',
        {
            requestPermission: async () => {
                order.push('request');
                // Only the first request is answered; the re-published one just has to be accepted.
                return order.filter((entry) => entry === 'request').length === 1
                    ? answered.promise
                    : new Promise<RequestPermissionResponse>(() => {});
            },
            extNotification: async (_method: string, payload: unknown) => {
                order.push(`closed:${(payload as { status: string }).status}`);
            }
        } as unknown as AgentSideConnection,
        new AbortController().signal,
        { authorizeInteractionAnswer() {} },
        inertBoundary,
        () => {}
    );
    let redelivered: unknown;
    const handle = endpoint.tryDeliverPermission(permissionRequest(), (_answer, settlement) => {
        order.push('answer');
        assert.ok(settlement);
        settlement.afterRemoteClose(() => {
            order.push('advance');
            // The exit must already be free, so the next queued request can actually be published.
            redelivered = endpoint.tryDeliverPermission(permissionRequest(), () => true);
        });
        return true;
    });
    assert.equal(handle?.delivered, true);
    answered.resolve({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
    for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(order, ['request', 'answer', 'closed:accepted', 'advance', 'request']);
    assert.equal((redelivered as { delivered?: boolean } | undefined)?.delivered, true);
    endpoint.dispose();
});

test('deferred Provider work still runs when the terminal send fails or the delivery is withdrawn', async () => {
    for (const failure of ['terminal', 'dispose'] as const) {
        const resumed: string[] = [];
        const answered = deferred<RequestPermissionResponse>();
        const endpoint = new MobileInteractionDeliveryEndpoint(
            'root-1',
            {
                requestPermission: async () => answered.promise,
                extNotification: async () => {
                    if (failure === 'terminal') throw new Error('wire down');
                }
            } as unknown as AgentSideConnection,
            new AbortController().signal,
            { authorizeInteractionAnswer() {} },
            inertBoundary,
            () => {}
        );
        endpoint.tryDeliverPermission(permissionRequest(), (_answer, settlement) => {
            settlement?.afterRemoteClose(() => resumed.push('advance'));
            return true;
        });
        if (failure === 'dispose') {
            endpoint.dispose();
            answered.resolve({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
        } else {
            answered.resolve({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
        }
        for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setImmediate(resolve));
        // A dead wire must never leave the Provider queue waiting for a signal that cannot arrive.
        assert.deepEqual(resumed, failure === 'dispose' ? [] : ['advance']);
        endpoint.dispose();
    }
});

test('disposal and abort release deferred Provider work that a pending terminal send still blocks', async () => {
    for (const end of ['dispose', 'abort'] as const) {
        const resumed: string[] = [];
        const answered = deferred<RequestPermissionResponse>();
        const terminal = deferred<void>();
        const controller = new AbortController();
        const endpoint = new MobileInteractionDeliveryEndpoint(
            'root-1',
            {
                requestPermission: async () => answered.promise,
                // The close notification is still in flight when the endpoint goes away.
                extNotification: async () => terminal.promise
            } as unknown as AgentSideConnection,
            controller.signal,
            { authorizeInteractionAnswer() {} },
            inertBoundary,
            () => {}
        );
        endpoint.tryDeliverPermission(permissionRequest(), (_answer, settlement) => {
            settlement?.afterRemoteClose(() => resumed.push('advance'));
            return true;
        });
        answered.resolve({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
        for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setImmediate(resolve));
        // The answer was accepted, so the Provider is already waiting on this delivery.
        assert.deepEqual(resumed, []);

        if (end === 'dispose') endpoint.dispose();
        else controller.abort(new Error('connection lost'));
        for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setImmediate(resolve));
        // Losing the endpoint must end that wait, not leave the Provider queue depending on a send
        // that can no longer finish.
        assert.deepEqual(resumed, ['advance']);

        terminal.resolve();
        for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setImmediate(resolve));
        // Still exactly once after the late send settles.
        assert.deepEqual(resumed, ['advance']);
        endpoint.dispose();
    }
});

test('Provider work registered after the exit already freed runs at once and still only once', async () => {
    const resumed: string[] = [];
    const answered = deferred<RequestPermissionResponse>();
    let lateSettlement: { afterRemoteClose(resume: () => void): void } | undefined;
    const endpoint = new MobileInteractionDeliveryEndpoint(
        'root-1',
        {
            requestPermission: async () => answered.promise,
            extNotification: async () => undefined
        } as unknown as AgentSideConnection,
        new AbortController().signal,
        { authorizeInteractionAnswer() {} },
        inertBoundary,
        () => {}
    );
    endpoint.tryDeliverPermission(permissionRequest(), (_answer, settlement) => {
        // A Provider that only registers after an await (TUI mode switching) must not be dropped.
        lateSettlement = settlement;
        return true;
    });
    answered.resolve({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
    for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.ok(lateSettlement);
    lateSettlement.afterRemoteClose(() => resumed.push('advance'));
    assert.deepEqual(resumed, ['advance']);
    lateSettlement.afterRemoteClose(() => resumed.push('second'));
    assert.deepEqual(resumed, ['advance', 'second']);
    endpoint.dispose();
});
