import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import * as acp from '@agentclientprotocol/sdk';
import { MobileAcpAgentAdapter } from '../../../../../main/applications/mobileaccess/acp/mobile/acp-endpoint/agent-adapter.js';
import { MobileAcpConnectionHost } from '../../../../../main/applications/mobileaccess/acp/mobile/acp-endpoint/connection-host.js';
import type { PublicSessionState } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session.js';
import type {
    PublicSessionSyncHandle,
    PublicSessionSyncPhase
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session-sync.js';
import type { RemoteSessionService } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/service.js';
import { createTestChannelPair, type TestAcpMessageChannel } from './test-channel.js';

const mobileRepo = process.env.OPENDESK_MOBILE_REPO;
const skipReason = mobileRepo ? false : 'set OPENDESK_MOBILE_REPO to the opendesk_mobile_demo app directory';
const MESSAGE_ID = '550e8400-e29b-41d4-a716-446655440000';

class StaticSync implements PublicSessionSyncHandle {
    phase: PublicSessionSyncPhase = 'buffering';

    constructor(readonly sessionId: string) {}

    installFatalSink(): void {}

    async activate(): Promise<void> {
        this.phase = 'live';
    }

    stop(): void {
        this.phase = 'stopped';
    }
}

function snapshot(text: string): PublicSessionState {
    return {
        sessionId: 's1',
        title: 'Session',
        cwd: '/isolated/workspace',
        updatedAt: '2026-09-03T00:00:00.000Z',
        taskStatus: 'stopped',
        completionStatus: 'success',
        runToken: null,
        history: {
            messages: [
                {
                    role: 'assistant',
                    messageId: MESSAGE_ID,
                    parts: [{ type: 'text', text }]
                }
            ]
        }
    };
}

function serviceFor(connectionName: string): RemoteSessionService {
    return {
        async listSessions() {
            return [
                {
                    sessionId: 's1',
                    cwd: '/isolated/workspace',
                    title: 'Session',
                    updatedAt: '2026-09-03T00:00:00.000Z',
                    taskStatus: 'stopped',
                    completionStatus: 'success'
                }
            ];
        },
        beginSessionLoad() {
            return {
                snapshot: snapshot(`snapshot-${connectionName}`),
                sync: new StaticSync('s1')
            };
        },
        stopCurrentRun() {
            throw new Error('fixture has no running task');
        },
        async startPrompt() {
            throw new Error('fixture has no Prompt target');
        },
        setSessionModelConfiguration() {
            throw new Error('fixture has no configuration target');
        }
    };
}

async function importMobile(relative: string): Promise<Record<string, any>> {
    return import(pathToFileURL(path.join(mobileRepo!, relative)).href);
}

async function waitFor(predicate: () => boolean): Promise<void> {
    for (let index = 0; index < 100 && !predicate(); index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(predicate(), true);
}

test('real PC Host and mobile Facade recover C1 close to C2 with late C1 isolation', { skip: skipReason }, async () => {
    const [clientModule, storeModule, coordinatorModule, remoteClientModule, ownerModule, directoryModule] =
        await Promise.all([
            importMobile('src/features/remote/acp/client.ts'),
            importMobile('src/features/remote/session/current/current-session-store.ts'),
            importMobile('src/features/remote/session/creation/new-session-coordinator.ts'),
            importMobile('src/features/remote/connection/remote-pc-client.ts'),
            // RemotePCRecoveryOwner is an alias export of the connection controller after the refactor.
            importMobile('src/features/remote/connection/remote-connection-controller.ts'),
            importMobile('src/features/remote/session/directory/session-directory-controller.ts')
        ]);
    const { MobileAcpClientFacade } = clientModule;
    const { CurrentSessionStore } = storeModule;
    const { NewSessionCoordinator } = coordinatorModule;
    const { RemotePCClient } = remoteClientModule;
    const { RemotePCRecoveryOwner } = ownerModule;
    const { SessionDirectoryController } = directoryModule;

    const trace: string[] = [];
    const cleanupCounts = new Map<string, number>();
    const host = new MobileAcpConnectionHost<{ connectionName: string }>({
        remoteSessionService: serviceFor('unused'),
        diagnose: () => undefined,
        adapterFactory(args) {
            const name = args.trustedContext.connectionName;
            const service = serviceFor(name);
            class TracingAdapter extends MobileAcpAgentAdapter {
                override async initialize(params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
                    trace.push(`initialize:${name}`);
                    return super.initialize(params);
                }

                override async listSessions(params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
                    trace.push(`list:${name}`);
                    return super.listSessions(params);
                }

                override async loadSession(params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> {
                    trace.push(`load:${name}:${params.sessionId}`);
                    return super.loadSession(params);
                }
            }
            return new TracingAdapter(
                args.connection,
                args.signal,
                service,
                () => undefined,
                args.failClosed,
                (cleanup) =>
                    args.registerCleanup(() => {
                        cleanupCounts.set(name, (cleanupCounts.get(name) ?? 0) + 1);
                        cleanup();
                    }),
                'test'
            );
        }
    });
    const clientChannels: TestAcpMessageChannel[] = [];
    const serverChannels: TestAcpMessageChannel[] = [];
    let connectionOrdinal = 0;
    const provider = {
        async connect() {
            connectionOrdinal += 1;
            const [clientChannel, serverChannel] = createTestChannelPair();
            clientChannels.push(clientChannel);
            serverChannels.push(serverChannel);
            host.open(serverChannel, { connectionName: `c${connectionOrdinal}` });
            return clientChannel;
        }
    };
    const facade = new MobileAcpClientFacade({ clientVersion: 'cross-repo-test' });
    const directory = new SessionDirectoryController('pc-1');
    const store = new CurrentSessionStore(undefined);
    store.select({
        source: { type: 'remotePc', pcId: 'pc-1' },
        sessionId: 's1',
        cwd: '/isolated/workspace',
        title: 'Session'
    });
    const coordinator = new NewSessionCoordinator();
    coordinator.attachCurrentSessionStore(store);
    const owner = new RemotePCRecoveryOwner(
        provider,
        facade,
        (pcId: string, nextFacade: typeof facade) => new RemotePCClient(pcId, nextFacade),
        { directory, currentSession: store, newSession: coordinator }
    );

    try {
        const connected = await owner.connect({ pcId: 'pc-1', opaque: { id: 'pc-1' } });
        assert.equal(connected.kind, 'ready');
        await owner.whenSettled();
        assert.deepEqual(trace, ['initialize:c1', 'list:c1', 'load:c1:s1']);
        assert.equal(store.getSnapshot().status, 'live');

        serverChannels[0].close();
        await waitFor(() => connectionOrdinal === 2);
        await owner.whenSettled();
        assert.deepEqual(trace, ['initialize:c1', 'list:c1', 'load:c1:s1', 'initialize:c2', 'list:c2', 'load:c2:s1']);
        assert.equal(store.getSnapshot().status, 'live');
        const publicState = store.getSnapshot().publicState;
        assert.equal(publicState.history.messages[0].parts[0].text, 'snapshot-c2');

        const before = {
            directory: directory.getSnapshot(),
            store: store.getSnapshot(),
            coordinator: coordinator.getSnapshot(),
            recovery: owner.getSnapshot()
        };
        clientChannels[0].emitMessageAfterCloseForIdentityFence(
            JSON.stringify({ jsonrpc: '2.0', id: 999, result: { stopReason: 'end_turn' } })
        );
        clientChannels[0].emitMessageAfterCloseForIdentityFence(
            JSON.stringify({
                jsonrpc: '2.0',
                method: 'session/update',
                params: {
                    sessionId: 's1',
                    update: {
                        sessionUpdate: 'agent_message_chunk',
                        messageId: MESSAGE_ID,
                        content: { type: 'text', text: 'stale-c1' },
                        _meta: { opendesk: { schemaVersion: 1, partIndex: 0, timestamp: 2 } }
                    }
                }
            })
        );
        clientChannels[0].emitMessageAfterCloseForIdentityFence(
            JSON.stringify({
                jsonrpc: '2.0',
                method: '_opendesk/interaction/closed',
                params: {
                    schemaVersion: 1,
                    requestId: 'old-request',
                    sessionId: 's1',
                    interactionType: 'askUser',
                    status: 'failed'
                }
            })
        );
        clientChannels[0].emitClose(new Error('duplicate old close'));
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(directory.getSnapshot(), before.directory);
        assert.equal(store.getSnapshot(), before.store);
        assert.equal(coordinator.getSnapshot(), before.coordinator);
        assert.equal(owner.getSnapshot(), before.recovery);
        assert.equal(connectionOrdinal, 2);
        assert.equal(cleanupCounts.get('c1'), 1);
    } finally {
        await owner.dispose();
        directory.dispose();
        coordinator.dispose();
        store.dispose();
        await host.close();
    }
});
