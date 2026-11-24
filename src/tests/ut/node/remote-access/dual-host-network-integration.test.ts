import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import * as acp from '@agentclientprotocol/sdk';
import { AccountService } from '../../../../main/applications/account/service.js';
import { createRegistrationRuntime } from '../../../../main/applications/mobileaccess/remote-access/registration-runtime.js';
import {
    composeRegistrationConnection,
    createSignalingSocket
} from '../../../../main/applications/mobileaccess/remote-access/connection-runtime.js';
import { createNodeNetworkBridge } from '../../../../main/applications/mobileaccess/remote-access/node-network-bridge.js';
import { startMobileHostComposition } from '../../../../main/applications/mobileaccess/acp/mobile/host-composition.js';
import { createTuiHostCapabilities } from '../../../../main/applications/mobileaccess/acp/mobile/hosts/tui-capabilities.js';
import { createInteractionDeliveryRuntime } from '../../../../main/aikernel/interaction/delivery.js';
import { createInteractionSessionScopeResolver } from '../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/session-projector.js';
import { createAcpMessageStream } from '../../../../main/applications/mobileaccess/acp/mobile/transport/acp-message-stream.js';
import { AgentRegistry } from '../../../../main/aikernel/agents/registry.js';
import { TaskManagerState } from '../../../../main/aikernel/task/manager.js';
import { Setting, setCustomOpendeskDirectory } from '../../../../main/utils/setting.js';
import { AbstractPlatform, setPlatform } from '../../../../platforms/base.js';
import { isolatedServer, until, serverEnvironment } from './fixtures/isolated-server.js';
import { createOfferingPeer } from './fixtures/werift-mobile-peer.js';

const skip =
    !serverEnvironment.root || !serverEnvironment.mobile || !serverEnvironment.python
        ? 'requires isolated Server/Python/Mobile source paths'
        : false;
class Platform extends AbstractPlatform {
    override getEffectiveWorkspace() {
        return os.tmpdir();
    }
    override async initPlatformHarness() {
        throw Error('isolated provider');
    }
    override fetch(url: string | URL, init?: RequestInit) {
        return fetch(url, init);
    }
}
function account(baseUrl: string, auth: { userId: string; token: string }, initiallyLogged = true) {
    let logged = initiallyLogged;
    const session = () => ({
        backendId: 'synthetic',
        kind: 'enterprise',
        baseUrl,
        user: { id: auth.userId, username: 'synthetic' }
    });
    const backend = {
        id: 'synthetic',
        kinds: ['enterprise'],
        initialize() {},
        getSession: () => (logged ? session() : null),
        getCredential: () => (logged ? { ...session(), accessToken: auth.token, tokenType: 'Bearer' } : null),
        getUserInfo: async () => session().user,
        getLoginMethods: async () => [],
        updateDisplayName: async () => session().user,
        createLoginFlow: async () => ({
            getState: () => ({ status: 'ready' }),
            submit: async () => {
                logged = true;
                return { status: 'completed', session: session() };
            },
            cancel: async () => undefined
        }),
        refreshToken: async () => session(),
        logout: async () => {
            logged = false;
        }
    };
    return new AccountService({ getBaseUrl: () => baseUrl, getBackend: () => backend as never });
}
for (const order of [
    ['electron', 'cli'],
    ['cli', 'electron'],
    ['concurrent', 'concurrent']
] as const) {
    test(
        `actual mixed Host registration, trusted ACP and promotion (${order.join('→')})`,
        { skip, timeout: 30000 },
        async () => {
            const server = await isolatedServer();
            const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-dual-profile-'));
            setCustomOpendeskDirectory(profile);
            setPlatform(new Platform());
            AgentRegistry.initBuiltinAgents();
            Setting.getInstance().setData(
                Setting.getSettingSchema().parse({
                    providers: [{ name: 'synthetic', base_url: 'http://127.0.0.1:1' }],
                    models: [{ alias: 'B', provider_name: 'synthetic', model_name: 'B' }]
                })
            );
            const mobile = await import(
                pathToFileURL(
                    path.join(
                        serverEnvironment.mobile!,
                        'src/features/remote/connection/server-connection-attempt-provider.ts'
                    )
                ).href
            );
            const hosts: any[] = [];
            const clients: Array<{ close(): void }> = [];
            const makeHost = async (hostType: 'electron' | 'cli', auth = server, initiallyLogged = true) => {
                const service = account(server.baseUrl, auth, initiallyLogged);
                const controller = new AbortController();
                const timerJobs = new Map<number, () => void>();
                let timerId = 1;
                let registrations = 0,
                    sockets = 0;
                const attempts: string[] = [];
                const manager = new TaskManagerState();
                const active = manager.createTask('B');
                const activeId = active.task_id;
                const runtime = createInteractionDeliveryRuntime(
                    createInteractionSessionScopeResolver(() => manager.getTaskList())
                );
                const registration = createRegistrationRuntime({
                    hostType,
                    signal: controller.signal,
                    deviceId: 'shared-synthetic-pc',
                    name: 'Synthetic Host',
                    getCredential: () => service.getCredential(),
                    subscribe: (listener) => service.subscribe(listener),
                    fetch: (url, init) => {
                        if (url.endsWith('/register')) registrations++;
                        return fetch(url, init);
                    },
                    setTimeout: (fn, ms) => {
                        if (ms !== 30000) return setTimeout(fn, ms);
                        const id = timerId++;
                        timerJobs.set(id, fn);
                        return id;
                    },
                    clearTimeout: (id) => {
                        if (typeof id === 'number') timerJobs.delete(id);
                        else clearTimeout(id as ReturnType<typeof setTimeout>);
                    }
                });
                const opened: string[] = [];
                const capabilitySource = {
                    taskManager: manager,
                    getModelOverride: () => 'B',
                    getMainMode: () => AgentRegistry.getMainAgent().getDefaultMode(),
                    getDefaultWorkspace: () => profile,
                    sessionModelSource: {
                        listConfiguredModelAliases: () => ['B'],
                        resolveChatModel: (alias: string) => ({ alias, modelName: 'B' }),
                        resolveEffectiveDefaultModel: () => ({ kind: 'configured_alias' as const, alias: 'B' })
                    },
                    getDefaultExecutionNodeId: () => '',
                    getExecutionNode: () => null,
                    diagnose: () => undefined
                };
                const handle = await startMobileHostComposition({
                    hostCapabilities: createTuiHostCapabilities(capabilitySource),
                    interactionRuntime: runtime,
                    signal: controller.signal,
                    diagnose: () => undefined,
                    startNetwork: async ({ signal, openConnection }) =>
                        composeRegistrationConnection({
                            registration,
                            signal,
                            allowLoopback: true,
                            bridge: createNodeNetworkBridge({ owner: { hostInstanceId: randomUUID(), generation: 1 } }),
                            createSocket: (url) => {
                                sockets++;
                                return createSignalingSocket(url);
                            },
                            openConnection: (channel, context) => {
                                attempts.push(context.attemptId);
                                opened.push(context.attemptId);
                                return openConnection(channel, context);
                            }
                        })
                });
                const host = {
                    hostType,
                    service,
                    registration,
                    manager,
                    activeId,
                    opened,
                    attempts,
                    handle,
                    counts: () => ({ registrations, sockets }),
                    heartbeat: () => {
                        const job = timerJobs.entries().next().value;
                        assert.ok(job);
                        const [id, fn] = job;
                        timerJobs.delete(id);
                        fn();
                    },
                    heartbeatPending: () => timerJobs.size > 0,
                    async close() {
                        controller.abort();
                        await handle.close();
                        await manager.flushAllPendingSaves();
                        manager.disposeLazyHarnessInit();
                    }
                };
                hosts.push(host);
                return host;
            };
            const connect = async (auth = server) => {
                const provider = mobile.createServerConnectionAttemptProvider({
                    getCredential: () => ({
                        scopeKey: 'isolated',
                        token: auth.token,
                        version: 0,
                        baseUrl: server.baseUrl
                    }),
                    subscribeCredential: () => () => undefined,
                    subscribeInvalidation: () => () => undefined,
                    invalidateCredential: async () => {
                        throw Error('unexpected invalidation');
                    },
                    createSocket: createSignalingSocket,
                    allowLoopback: true,
                    uuid: randomUUID,
                    bridge: { create: createOfferingPeer }
                });
                const port = await provider.connect({ pcId: 'shared-synthetic-pc', opaque: {} });
                clients.push(port);
                const binding = createAcpMessageStream(port, new AbortController());
                const client = new acp.ClientSideConnection(
                    () => ({
                        sessionUpdate: async () => undefined,
                        requestPermission: async () => ({ outcome: { outcome: 'cancelled' } })
                    }),
                    binding.stream
                );
                await client.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
                return { client, port };
            };
            try {
                let first, second;
                if (order[0] === 'concurrent')
                    [first, second] = await Promise.all([makeHost('electron'), makeHost('cli')]);
                else {
                    first = await makeHost(order[0]);
                    await until(() => first.registration.getQualification().role === 'current');
                    second = await makeHost(order[1]);
                }
                await until(() => hosts.every((host) => host.registration.getQualification().role !== null));
                const current = hosts.find((host) => host.registration.getQualification().role === 'current')!;
                const standby = hosts.find((host) => host !== current)!;
                assert.equal(standby.registration.getQualification().role, 'standby');
                assert.equal(standby.counts().sockets, 0);
                const original = standby.registration.getQualification();
                const connection = await connect();
                const listed = await connection.client.listSessions({});
                assert.deepEqual(
                    listed.sessions.map((value) => value.sessionId),
                    [current.activeId]
                );
                const created = await connection.client.newSession({ cwd: profile, mcpServers: [] });
                assert.equal(current.manager.getTask(created.sessionId).model, 'B');
                assert.equal(current.activeId, listed.sessions[0].sessionId);
                connection.port.close();
                await current.close();
                assert.equal(
                    standby.registration.getQualification().role,
                    'standby',
                    'Server promotion alone is not Host confirmation'
                );
                assert.equal(standby.counts().sockets, 0);
                standby.heartbeat();
                await until(() => standby.registration.getQualification().role === 'current');
                const promoted = standby.registration.getQualification();
                assert.equal(promoted.runId, original.runId);
                assert.equal(promoted.deviceId, original.deviceId);
                assert.ok(promoted.generation > original.generation);
                assert.equal(standby.counts().registrations, 1);
                const replacement = await connect();
                const after = await replacement.client.listSessions({});
                assert.deepEqual(
                    after.sessions.map((value) => value.sessionId),
                    [standby.activeId]
                );
                assert.notEqual(standby.attempts[0], current.attempts[0]);
                assert.equal(current.opened.length, 1);
                const other = await makeHost('cli', { ...server, ...server.secondAccount }, false);
                assert.equal(other.counts().registrations, 0);
                const flow = await other.service.startLogin('enterprise', 'synthetic');
                await other.service.submitLogin(flow.flowId, {});
                await until(() => other.registration.getQualification().role === 'current');
                assert.notEqual(other.registration.getQualification().accountScope, promoted.accountScope);
                const otherConnection = await connect({ ...server, ...server.secondAccount });
                const otherList = await otherConnection.client.listSessions({});
                assert.deepEqual(
                    otherList.sessions.map((value) => value.sessionId),
                    [other.activeId]
                );
                const otherRun = other.registration.getQualification().runId;
                await other.service.logout();
                await until(() => other.registration.getQualification().role === null);
                const relogin = await other.service.startLogin('enterprise', 'synthetic');
                await other.service.submitLogin(relogin.flowId, {});
                await until(() => {
                    const role = other.registration.getQualification().role;
                    if (role === 'current') return true;
                    // Relogin can race the old run's asynchronous unregister. A standby
                    // must await a subsequent authoritative heartbeat rather than self-promote.
                    if (role === 'standby' && other.heartbeatPending()) other.heartbeat();
                    return false;
                });
                assert.notEqual(other.registration.getQualification().runId, otherRun);
                assert.equal(standby.registration.getQualification().runId, original.runId);
            } finally {
                for (const port of clients) port.close();
                for (const host of hosts) await host.close();
                await server.close();
                setCustomOpendeskDirectory(undefined);
                fs.rmSync(profile, { recursive: true, force: true });
            }
        }
    );
}
