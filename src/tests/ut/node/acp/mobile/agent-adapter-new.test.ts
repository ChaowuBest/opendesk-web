import assert from 'node:assert/strict';
import test from 'node:test';
import * as acp from '@agentclientprotocol/sdk';
import type { Client } from '@agentclientprotocol/sdk';
import { InteractionDeliveryChannel } from '../../../../../main/aikernel/interaction/delivery.js';
import {
    MobileAcpAgentAdapter,
    type MobileAcpDiagnosticEvent
} from '../../../../../main/applications/mobileaccess/acp/mobile/acp-endpoint/agent-adapter.js';
import { MobileAcpConnectionHost } from '../../../../../main/applications/mobileaccess/acp/mobile/acp-endpoint/connection-host.js';
import type {
    PublicSessionState,
    PublicSessionUpdate
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session.js';
import {
    RemoteSessionCreateError,
    type RemotePromptCompletion,
    type RemoteSessionCreated,
    type RemoteSessionCreationService,
    type RemoteSessionService
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/service.js';
import type {
    PublicSessionSyncHandle,
    PublicSessionSyncPhase
} from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session-sync.js';
import { createAcpMessageStream } from '../../../../../main/applications/mobileaccess/acp/mobile/transport/acp-message-stream.js';
import { createTestChannelPair, type TestAcpMessageChannel } from './test-channel.js';

const CREATION_CAPABILITY = {
    schemaVersion: 1,
    defaultWorkspace: 1
} as const;

const INTERACTION_CAPABILITY = {
    schemaVersion: 1,
    askUser: 1,
    exitPlanMode: 1,
    permission: 1,
    closed: 1
} as const;

type CreationService = RemoteSessionService & RemoteSessionCreationService;

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}

function snapshot(sessionId: string): PublicSessionState {
    return {
        sessionId,
        title: sessionId,
        cwd: '/work',
        updatedAt: '2026-09-02T00:00:00.000Z',
        taskStatus: 'stopped',
        completionStatus: null,
        runToken: null,
        history: { messages: [] }
    };
}

class LiveFeed implements PublicSessionSyncHandle {
    phase: PublicSessionSyncPhase = 'buffering';
    private consumer?: (update: PublicSessionUpdate) => Promise<void>;

    constructor(readonly sessionId: string) {}

    installFatalSink(): void {}

    async activate(consumer: (update: PublicSessionUpdate) => Promise<void>): Promise<void> {
        this.phase = 'live';
        this.consumer = consumer;
    }

    async publish(update: PublicSessionUpdate): Promise<void> {
        await this.consumer?.(update);
    }

    stop(): void {
        this.phase = 'stopped';
        this.consumer = undefined;
    }
}

function baseCreationService(overrides: Partial<CreationService> = {}): CreationService {
    return {
        async listSessions() {
            return [];
        },
        beginSessionLoad(sessionId) {
            return { snapshot: snapshot(sessionId), sync: new LiveFeed(sessionId) };
        },
        stopCurrentRun() {
            throw new Error('fixture has no running task');
        },
        async startPrompt() {
            throw new Error('fixture has no Prompt target');
        },
        async resolveDefaultWorkspace() {
            return { workspace: '/work' };
        },
        async createSession({ workspace }) {
            return { kind: 'created', sessionId: 'task-created', workspace };
        },
        setSessionModelConfiguration() {
            throw new Error('fixture has no configuration target');
        },
        ...overrides
    };
}

function quietClient(): Client {
    return {
        async requestPermission() {
            return { outcome: { outcome: 'cancelled' } };
        },
        async sessionUpdate() {}
    };
}

function connectClient(port: TestAcpMessageChannel) {
    const binding = createAcpMessageStream(port, new AbortController());
    return new acp.ClientSideConnection(() => quietClient(), binding.stream);
}

async function openHarness(
    options: {
        service?: CreationService;
        interaction?: boolean;
        clientCapabilities?: acp.ClientCapabilities;
    } = {}
) {
    const service = options.service ?? baseCreationService();
    const diagnostics: MobileAcpDiagnosticEvent[] = [];
    const [clientPort, serverPort] = createTestChannelPair();
    const host = new MobileAcpConnectionHost({
        remoteSessionService: service,
        diagnose: (event) => diagnostics.push(event),
        ...(options.interaction
            ? {
                  mobileInteractions: {
                      deliveryChannel: new InteractionDeliveryChannel(() => undefined),
                      answerAuthorizer: { authorizeInteractionAnswer() {} }
                  }
              }
            : {})
    });
    const hosted = host.open(serverPort, Object.freeze({ connectionId: 'session-creation' }));
    const client = connectClient(clientPort);
    const initialized = await client.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: options.clientCapabilities ?? {}
    });
    return { client, clientPort, diagnostics, host, hosted, initialized, service };
}

test('advertises creation and maps default workspace and standard new over the real SDK', async () => {
    const calls: unknown[] = [];
    const pair = await openHarness({
        service: baseCreationService({
            async resolveDefaultWorkspace() {
                calls.push('default');
                return { workspace: '/authority' };
            },
            async createSession(input) {
                calls.push(input);
                return { kind: 'created', sessionId: 'task-1', workspace: '/authority' };
            }
        }),
        clientCapabilities: {
            _meta: { opendesk: { clientOnly: { schemaVersion: 99 } } }
        }
    });

    assert.deepEqual(pair.initialized.agentCapabilities?._meta, {
        opendesk: { sessionCreation: CREATION_CAPABILITY }
    });
    assert.deepEqual(await pair.client.extMethod('_opendesk/session/default-workspace', {}), {
        workspace: '/authority'
    });
    assert.deepEqual(await pair.client.newSession({ cwd: ' /raw ', mcpServers: [] }), {
        sessionId: 'task-1',
        _meta: {
            opendesk: {
                sessionCreation: { schemaVersion: 1, workspace: '/authority' }
            }
        }
    });
    assert.deepEqual(calls, ['default', { workspace: ' /raw ' }]);
    await pair.hosted.close();
});

test('merges interaction and creation capabilities without echoing unknown client metadata', async () => {
    const pair = await openHarness({
        interaction: true,
        clientCapabilities: {
            _meta: {
                opendesk: {
                    interaction: INTERACTION_CAPABILITY,
                    clientOnly: { secret: true }
                }
            }
        }
    });

    assert.deepEqual(pair.initialized.agentCapabilities?._meta, {
        opendesk: {
            interaction: INTERACTION_CAPABILITY,
            sessionCreation: CREATION_CAPABILITY
        }
    });
    await pair.hosted.close();
});

for (const code of ['workspace_unavailable', 'session_not_created'] as const) {
    test(`maps ${code} as a strict session/new not-created proof`, async () => {
        let calls = 0;
        const pair = await openHarness({
            service: baseCreationService({
                async createSession() {
                    calls += 1;
                    throw new RemoteSessionCreateError(code);
                }
            })
        });

        await assert.rejects(
            () => pair.client.newSession({ cwd: '/work', mcpServers: [] }),
            (error: unknown) => {
                assert.ok(error instanceof acp.RequestError);
                assert.equal(error.code, -32603);
                assert.deepEqual(error.data, {
                    opendesk: {
                        sessionCreation: {
                            schemaVersion: 1,
                            code,
                            creationState: 'not_created'
                        }
                    }
                });
                return true;
            }
        );
        assert.equal(calls, 1);
        await pair.hosted.close();
    });
}

test('maps default workspace refusal with the same strict profile', async () => {
    const pair = await openHarness({
        service: baseCreationService({
            async resolveDefaultWorkspace() {
                throw new RemoteSessionCreateError('default_workspace_unavailable');
            }
        })
    });

    await assert.rejects(
        () => pair.client.extMethod('_opendesk/session/default-workspace', {}),
        (error: unknown) => {
            assert.ok(error instanceof acp.RequestError);
            assert.equal(error.code, -32603);
            assert.deepEqual(error.data, {
                opendesk: {
                    sessionCreation: {
                        schemaVersion: 1,
                        code: 'default_workspace_unavailable',
                        creationState: 'not_created'
                    }
                }
            });
            return true;
        }
    );
    await pair.hosted.close();
});

test('does not invent a not-created proof for an unknown create failure', async () => {
    const pair = await openHarness({
        service: baseCreationService({
            async createSession() {
                throw new Error('secret path=/Users/stella/private');
            }
        })
    });

    await assert.rejects(
        () => pair.client.newSession({ cwd: '/work', mcpServers: [] }),
        (error: unknown) => {
            assert.ok(error instanceof acp.RequestError);
            assert.equal(error.code, -32603);
            assert.equal(error.data, undefined);
            assert.equal(error.message.includes('secret'), false);
            return true;
        }
    );
    assert.equal(pair.diagnostics.at(-1)?.code, 'session_creation_failed');
    await pair.hosted.close();
});

test('passes blank and relative cwd unchanged to the RSS policy owner', async () => {
    const seen: string[] = [];
    const pair = await openHarness({
        service: baseCreationService({
            async createSession({ workspace }) {
                seen.push(workspace);
                throw new RemoteSessionCreateError('workspace_unavailable');
            }
        })
    });

    for (const cwd of ['   ', 'relative/path']) {
        await assert.rejects(
            () => pair.client.newSession({ cwd, mcpServers: [] }),
            (error: unknown) => error instanceof acp.RequestError && error.code === -32603
        );
    }
    assert.deepEqual(seen, ['   ', 'relative/path']);
    await pair.hosted.close();
});

test('rejects unsupported new wire fields before calling RSS', async () => {
    let calls = 0;
    const pair = await openHarness({
        service: baseCreationService({
            async createSession({ workspace }) {
                calls += 1;
                return { kind: 'created', sessionId: 'unexpected', workspace };
            }
        })
    });

    for (const params of [
        {
            cwd: '/work',
            mcpServers: [{ name: 'unsupported', command: 'noop', args: [], env: [] }]
        },
        { cwd: '/work', mcpServers: [], additionalDirectories: ['/extra'] }
    ]) {
        await assert.rejects(
            () => pair.client.newSession(params as never),
            (error: unknown) => error instanceof acp.RequestError && error.code === -32602
        );
    }
    assert.equal(calls, 0);
    await pair.hosted.close();
});

test('new leaves loaded A active until the client explicitly loads another session', async () => {
    const feeds = new Map<string, LiveFeed>();
    const promptCalls: string[] = [];
    const userMessageId = '550e8400-e29b-41d4-a716-446655440777';
    const service = baseCreationService({
        beginSessionLoad(sessionId) {
            const feed = new LiveFeed(sessionId);
            feeds.set(sessionId, feed);
            return { snapshot: snapshot(sessionId), sync: feed };
        },
        async startPrompt(sessionId, text) {
            promptCalls.push(sessionId);
            const feed = feeds.get(sessionId);
            assert.ok(feed);
            await feed.publish({
                type: 'session_info_replace',
                info: {
                    title: sessionId,
                    cwd: '/work',
                    updatedAt: '2026-09-02T00:00:01.000Z',
                    taskStatus: 'running',
                    completionStatus: null,
                    runToken: null
                }
            });
            await feed.publish({
                type: 'part_state',
                role: 'user',
                messageId: userMessageId,
                partIndex: 0,
                part: { type: 'text', text },
                messageTimestamp: 1
            });
            const completion: RemotePromptCompletion = { stoppedByUser: false };
            return { kind: 'started', userMessageId, completion: Promise.resolve(completion) };
        }
    });
    const pair = await openHarness({ service });

    await pair.client.loadSession({ sessionId: 'A', cwd: '/work', mcpServers: [] });
    await pair.client.newSession({ cwd: '/work', mcpServers: [] });
    await pair.client.prompt({ sessionId: 'A', prompt: [{ type: 'text', text: 'still A' }] });
    assert.deepEqual(promptCalls, ['A']);
    await pair.hosted.close();
});

test('drops a late created result after the hosted connection closes', async () => {
    const created = deferred<RemoteSessionCreated>();
    const started = deferred<void>();
    const pair = await openHarness({
        service: baseCreationService({
            createSession() {
                started.resolve();
                return created.promise;
            }
        })
    });
    const pending = pair.client.newSession({ cwd: '/work', mcpServers: [] });
    await started.promise;
    const closing = pair.hosted.close();
    created.resolve({ kind: 'created', sessionId: 'late-task', workspace: '/work' });

    await assert.rejects(pending);
    await closing;
});

test('a read-only RSS keeps capability and both creation methods unavailable', async () => {
    const readOnly: RemoteSessionService = {
        ...baseCreationService(),
        resolveDefaultWorkspace: undefined,
        createSession: undefined
    } as unknown as RemoteSessionService;
    const [clientPort, serverPort] = createTestChannelPair();
    const host = new MobileAcpConnectionHost({
        remoteSessionService: readOnly,
        diagnose: () => undefined
    });
    const hosted = host.open(serverPort, {});
    const client = connectClient(clientPort);
    const initialized = await client.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {}
    });

    assert.equal(initialized.agentCapabilities?._meta, undefined);
    await assert.rejects(
        () => client.extMethod('_opendesk/session/default-workspace', {}),
        (error: unknown) => error instanceof acp.RequestError && error.code === -32601
    );
    await assert.rejects(
        () => client.newSession({ cwd: '/work', mcpServers: [] }),
        (error: unknown) => error instanceof acp.RequestError && error.code === -32601
    );
    await hosted.close();
});

test('closed adapter rejects before calling the creation service', async () => {
    const scope = new AbortController();
    scope.abort();
    let calls = 0;
    const adapter = new MobileAcpAgentAdapter(
        {} as acp.AgentSideConnection,
        scope.signal,
        baseCreationService({
            async createSession({ workspace }) {
                calls += 1;
                return { kind: 'created', sessionId: 'unexpected', workspace };
            }
        }),
        () => undefined,
        () => undefined,
        () => undefined
    );

    await assert.rejects(
        () => adapter.newSession({ cwd: '/work', mcpServers: [] }),
        (error: unknown) => error instanceof acp.RequestError && error.code === -32000
    );
    assert.equal(calls, 0);
});
