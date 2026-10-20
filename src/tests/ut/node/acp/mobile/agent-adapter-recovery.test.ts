import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import type {
    InteractionDeliveryChannel,
    InteractionDeliveryEndpoint
} from '../../../../../main/aikernel/interaction/delivery.js';
import { MobileAcpAgentAdapter } from '../../../../../main/applications/mobileaccess/acp/mobile/acp-endpoint/agent-adapter.js';
import type { PublicSessionState } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session.js';
import type { RemoteSessionService } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/service.js';
import type {
    PublicSessionSyncHandle,
    PublicSessionSyncPhase
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session-sync.js';

const SNAPSHOT: PublicSessionState = {
    sessionId: 's1',
    title: 'Session',
    cwd: '/work',
    updatedAt: '2026-09-03T00:00:00.000Z',
    taskStatus: 'stopped',
    completionStatus: null,
    runToken: null,
    history: { messages: [] }
};

class RecoveryFeed implements PublicSessionSyncHandle {
    phase: PublicSessionSyncPhase = 'buffering';
    stopCalls = 0;
    private fatalSink?: (error: Error) => void;

    constructor(readonly sessionId: string) {}

    installFatalSink(sink: (error: Error) => void): void {
        this.fatalSink = sink;
    }

    async activate(): Promise<void> {
        this.phase = 'live';
    }

    stop(): void {
        if (this.phase === 'stopped') return;
        this.phase = 'stopped';
        this.stopCalls += 1;
    }

    raiseFatal(error: Error): void {
        this.fatalSink?.(error);
    }
}

async function fixture(variant: 'cleanup-throws' | 'cleanup-reenters') {
    const feed = new RecoveryFeed('s1');
    const abort = new AbortController();
    const invalidations: Array<{ method: string; params: Record<string, unknown> }> = [];
    let registeredCleanup: (() => void) | undefined;
    let hostCleanupDone = false;
    let hostCleanupCalls = 0;
    let failClosedCalls = 0;
    let unregisterCalls = 0;
    let endpointDisposeCalls = 0;

    const runHostCleanup = (): void => {
        if (hostCleanupDone) return;
        hostCleanupDone = true;
        hostCleanupCalls += 1;
        abort.abort(new Error('host cleanup reentry'));
        registeredCleanup?.();
    };

    const deliveryChannel = {
        notifyEndpointReady() {},
        registerEndpoint(endpoint: InteractionDeliveryEndpoint) {
            const disposable = endpoint as InteractionDeliveryEndpoint & { dispose(): void };
            const originalDispose = disposable.dispose.bind(disposable);
            disposable.dispose = () => {
                endpointDisposeCalls += 1;
                originalDispose();
            };
            return () => {
                unregisterCalls += 1;
                if (variant === 'cleanup-reenters') runHostCleanup();
                if (variant === 'cleanup-throws') throw new Error('unregister failed');
            };
        }
    } as unknown as InteractionDeliveryChannel;
    const connection = {
        async sessionUpdate() {},
        async extNotification(method: string, params: Record<string, unknown>) {
            invalidations.push({ method, params });
        }
    } as unknown as AgentSideConnection;
    const service = {
        async listSessions() {
            return [];
        },
        stopCurrentRun() {},
        async startPrompt() {
            throw new Error('not used');
        },
        beginSessionLoad() {
            return { snapshot: SNAPSHOT, sync: feed };
        }
    } as unknown as RemoteSessionService;
    const failClosed = (): void => {
        failClosedCalls += 1;
        runHostCleanup();
    };
    const adapter = new MobileAcpAgentAdapter(
        connection,
        abort.signal,
        service,
        () => undefined,
        failClosed,
        (cleanup) => {
            registeredCleanup = cleanup;
        },
        'test',
        30_000,
        {
            deliveryChannel,
            answerAuthorizer: { authorizeInteractionAnswer() {} }
        }
    );
    await adapter.initialize({
        protocolVersion: 1,
        clientCapabilities: {
            _meta: {
                opendesk: {
                    interaction: {
                        schemaVersion: 1,
                        askUser: 1,
                        exitPlanMode: 1,
                        permission: 1,
                        closed: 1
                    },
                    sessionInvalidation: { schemaVersion: 1 }
                }
            }
        }
    });
    await adapter.loadSession({ sessionId: 's1', cwd: '/work', mcpServers: [] });
    return {
        adapter,
        feed,
        invalidations,
        raiseFatal: () => feed.raiseFatal(new Error('committed continuity failure')),
        counts: () => ({
            failClosedCalls,
            hostCleanupCalls,
            unregisterCalls,
            endpointDisposeCalls,
            feedStopCalls: feed.stopCalls
        })
    };
}

async function flush(): Promise<void> {
    await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
}

test('cleanup failure attempts every remaining resource before fail-closing once', async () => {
    const value = await fixture('cleanup-throws');
    value.raiseFatal();
    await flush();
    assert.deepEqual(value.counts(), {
        failClosedCalls: 1,
        hostCleanupCalls: 1,
        unregisterCalls: 1,
        endpointDisposeCalls: 1,
        feedStopCalls: 1
    });
    assert.deepEqual(value.invalidations, []);
});

test('cleanup reentry sees the detached guard and every observable resource is cleaned once', async () => {
    const value = await fixture('cleanup-reenters');
    value.raiseFatal();
    await flush();
    assert.deepEqual(value.counts(), {
        failClosedCalls: 1,
        hostCleanupCalls: 1,
        unregisterCalls: 1,
        endpointDisposeCalls: 1,
        feedStopCalls: 1
    });
    assert.deepEqual(value.invalidations, []);
});
