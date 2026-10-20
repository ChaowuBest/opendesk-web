import assert from 'node:assert/strict';
import test from 'node:test';
import * as acp from '@agentclientprotocol/sdk';
import type { Client, RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import { InteractionDeliveryChannel } from '../../../../../main/aikernel/interaction/delivery.js';
import type {
    AskUserDeliveryRequest,
    ExitPlanModeDeliveryRequest,
    PermissionDeliveryRequest
} from '../../../../../main/aikernel/interaction/delivery.js';
import { MobileAcpConnectionHost } from '../../../../../main/applications/mobileaccess/acp/mobile/acp-endpoint/connection-host.js';
import {
    ASK_USER_METHOD,
    EXIT_PLAN_MODE_METHOD,
    INTERACTION_CLOSED_METHOD
} from '../../../../../main/applications/mobileaccess/acp/mobile/interaction/message-mapper.js';
import type { RemoteSessionService } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/service.js';
import type { PublicSessionSyncHandle } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session-sync.js';
import { createAcpMessageStream } from '../../../../../main/applications/mobileaccess/acp/mobile/transport/acp-message-stream.js';
import { createTestChannelPair } from './test-channel.js';

const capability = {
    schemaVersion: 1,
    askUser: 1,
    exitPlanMode: 1,
    permission: 1,
    closed: 1
} as const;

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

async function eventually(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
        if (predicate()) return;
        await new Promise((resolve) => setImmediate(resolve));
    }
    assert.fail('condition did not become true');
}

function createLiveService(): RemoteSessionService {
    let phase: PublicSessionSyncHandle['phase'] = 'buffering';
    const feed: PublicSessionSyncHandle = {
        sessionId: 'root-1',
        get phase() {
            return phase;
        },
        installFatalSink() {},
        async activate() {
            phase = 'live';
        },
        stop() {
            phase = 'stopped';
        }
    };
    return {
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
                    title: 'Root task',
                    cwd: '/workspace',
                    updatedAt: '2026-08-25T00:00:00.000Z',
                    taskStatus: 'stopped',
                    completionStatus: null,
                    runToken: null,
                    history: { messages: [] }
                },
                sync: feed
            };
        },
        async startPrompt() {
            throw new Error('not used by interaction integration');
        }
    };
}

class InteractionClient implements Client {
    readonly requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    readonly closed: Record<string, unknown>[] = [];
    askResponse: Promise<Record<string, unknown>> = Promise.resolve({ answers: { 0: ['A'] } });
    exitResponse: Promise<Record<string, unknown>> = Promise.resolve({
        schemaVersion: 1,
        requestId: 'exit-1',
        action: 'execute-standard'
    });
    permissionResponse: RequestPermissionResponse = {
        outcome: { outcome: 'selected', optionId: 'allow-once' }
    };
    permissionRequests: RequestPermissionRequest[] = [];

    async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
        this.permissionRequests.push(params);
        return this.permissionResponse;
    }

    async sessionUpdate(): Promise<void> {}

    async extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
        this.requests.push({ method, params });
        if (method === ASK_USER_METHOD) return this.askResponse;
        if (method === EXIT_PLAN_MODE_METHOD) return this.exitResponse;
        throw acp.RequestError.methodNotFound(method);
    }

    async extNotification(method: string, params: Record<string, unknown>): Promise<void> {
        if (method === INTERACTION_CLOSED_METHOD) this.closed.push(params);
    }
}

async function openHarness() {
    const [clientPort, serverPort] = createTestChannelPair();
    const channel = new InteractionDeliveryChannel((sourceTaskId) =>
        sourceTaskId === 'child-1' ? 'root-1' : undefined
    );
    const authorizations: string[] = [];
    const host = new MobileAcpConnectionHost({
        remoteSessionService: createLiveService(),
        diagnose: () => undefined,
        mobileInteractions: {
            deliveryChannel: channel,
            answerAuthorizer: {
                authorizeInteractionAnswer(sourceTaskId, sessionId) {
                    authorizations.push(`${sourceTaskId}:${sessionId}`);
                }
            }
        }
    });
    const hosted = host.open(serverPort, Object.freeze({ connectionId: 'mobile-1' }));
    const handler = new InteractionClient();
    const binding = createAcpMessageStream(clientPort, new AbortController());
    const client = new acp.ClientSideConnection(() => handler, binding.stream);
    await client.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { _meta: { opendesk: { interaction: capability } } }
    });
    await client.loadSession({ sessionId: 'root-1', cwd: '/workspace', mcpServers: [] });
    return { channel, clientPort, serverPort, host, hosted, handler, authorizations };
}

const askRequest = (): AskUserDeliveryRequest => ({
    type: 'askUser',
    requestId: 'ask-1',
    sourceTaskId: 'child-1',
    taskName: 'Child task',
    request: {
        requestId: 'ask-1',
        taskId: 'child-1',
        taskName: 'Child task',
        workspace: '/private/workspace',
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

const exitRequest = (requestId: string): ExitPlanModeDeliveryRequest => ({
    type: 'exitPlanMode',
    requestId,
    sourceTaskId: 'child-1',
    taskName: 'Child task',
    planContent: '# Complete plan\n\nAll steps remain visible.',
    planRelativePath: 'plans/feature.md'
});

const permissionRequest = (requestId: string): PermissionDeliveryRequest => ({
    type: 'permission',
    requestId,
    sourceTaskId: 'child-1',
    taskName: 'Child task',
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
            optionId: 'allow-prefix-/workspace',
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

test('real SDK host delivers AskUser and reports accepted without exposing private workspace', async () => {
    const harness = await openHarness();
    try {
        const received: unknown[] = [];
        assert.equal(
            harness.channel.publishAskUser(askRequest(), (answer) => (received.push(answer), true))?.delivered,
            true
        );
        await eventually(() => harness.handler.closed.length === 1);
        assert.deepEqual(received, [{ answers: { 0: ['A'] } }]);
        assert.deepEqual(harness.authorizations, ['child-1:root-1']);
        assert.equal(JSON.stringify(harness.handler.requests).includes('/private/workspace'), false);
        assert.deepEqual(harness.handler.closed[0], {
            schemaVersion: 1,
            requestId: 'ask-1',
            sessionId: 'root-1',
            interactionType: 'askUser',
            status: 'accepted'
        });
    } finally {
        await harness.hosted.close();
        assert.equal(harness.serverPort.listenerCount, 0);
    }
});

test('a local AskUser winner makes the real SDK mobile answer superseded', async () => {
    const harness = await openHarness();
    const remote = deferred<Record<string, unknown>>();
    harness.handler.askResponse = remote.promise;
    try {
        let winner: 'pc' | 'mobile' = 'pc';
        let callbacks = 0;
        assert.ok(
            harness.channel.publishAskUser(askRequest(), () => {
                callbacks += 1;
                if (winner) return false;
                winner = 'mobile';
                return true;
            })
        );
        remote.resolve({ answers: { 0: ['B'] } });
        await eventually(() => harness.handler.closed.length === 1);
        assert.equal(callbacks, 1);
        assert.equal(winner, 'pc');
        assert.equal(harness.handler.closed[0].status, 'superseded');
    } finally {
        await harness.hosted.close();
    }
});

test('real SDK preserves every ExitPlanMode action and the safe relative path', async () => {
    for (const action of ['execute-standard', 'execute-solo', 'continue-editing'] as const) {
        const harness = await openHarness();
        const requestId = `exit-${action}`;
        harness.handler.exitResponse = Promise.resolve({ schemaVersion: 1, requestId, action });
        try {
            let received: unknown;
            assert.ok(
                harness.channel.publishExitPlanMode(exitRequest(requestId), (answer) => ((received = answer), true))
            );
            await eventually(() => harness.handler.closed.length === 1);
            assert.deepEqual(received, { action });
            const wire = harness.handler.requests[0]?.params;
            assert.equal(wire.planRelativePath, 'plans/feature.md');
            assert.equal(String(wire.planContent).includes('All steps remain visible.'), true);
        } finally {
            await harness.hosted.close();
        }
    }
});

test('real SDK preserves all formal Permission outcomes and request-scoped toolCall IDs', async () => {
    const cases = [
        ['allow-once', { decision: 'allow', rememberScope: 'none' }],
        [
            'allow-prefix-/workspace',
            { decision: 'allow', rememberScope: 'prefix', selectedPrefixPattern: '/workspace' }
        ],
        ['allow-type', { decision: 'allow', rememberScope: 'type' }],
        ['reject-once', { decision: 'deny', rememberScope: 'none', denyReason: 'user_denied' }]
    ] as const;
    for (const [optionId, expected] of cases) {
        const harness = await openHarness();
        const requestId = `permission-${optionId}`;
        harness.handler.permissionResponse = { outcome: { outcome: 'selected', optionId } };
        try {
            let received: unknown;
            assert.ok(
                harness.channel.publishPermission(permissionRequest(requestId), (answer) => ((received = answer), true))
            );
            await eventually(() => harness.handler.closed.length === 1);
            assert.deepEqual(received, expected);
            const toolCallId = harness.handler.permissionRequests[0]?.toolCall.toolCallId;
            assert.equal(typeof toolCallId, 'string');
            assert.notEqual(toolCallId, requestId);
            assert.equal(JSON.stringify(harness.handler.permissionRequests).includes('rawInput'), false);
        } finally {
            await harness.hosted.close();
        }
    }
});

test('session unsubscribe and connection close unregister the endpoint and withdraw pending work', async () => {
    const harness = await openHarness();
    const remote = deferred<Record<string, unknown>>();
    harness.handler.askResponse = remote.promise;
    let callbacks = 0;
    const handle = harness.channel.publishAskUser(askRequest(), () => ((callbacks += 1), true));
    assert.ok(handle);
    await harness.hosted.close();
    remote.resolve({ answers: { 0: ['A'] } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(callbacks, 0);
    assert.equal(
        harness.channel.publishAskUser(askRequest(), () => true),
        undefined
    );
    assert.equal(harness.serverPort.listenerCount, 0);
    assert.equal(harness.clientPort.listenerCount, 0);
});
