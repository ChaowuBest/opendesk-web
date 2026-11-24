import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createRegistrationRuntime } from '../../../../main/applications/mobileaccess/remote-access/registration-runtime.js';
import {
    composeRegistrationConnection,
    createSignalingSocket
} from '../../../../main/applications/mobileaccess/remote-access/connection-runtime.js';

// Opt in with actual sibling checkouts; no production import depends on these tests.
const serverRoot = process.env.REMOTE_NETWORK_CONTRACT_SERVER_ROOT;
const mobileRoot = process.env.REMOTE_NETWORK_CONTRACT_MOBILE_ROOT;
const python = process.env.REMOTE_NETWORK_CONTRACT_PYTHON;
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
async function until(check: () => boolean | Promise<boolean>) {
    for (let i = 0; i < 500; i++) {
        if (await check()) return;
        await tick();
    }
    throw new Error('contract condition timed out');
}
class ContractChannel {
    peer!: ContractChannel;
    ended = false;
    messages = new Set<(raw: string) => void>();
    closes = new Set<() => void>();
    async send(raw: string) {
        if (this.ended || this.peer.ended) throw new Error('contract channel closed');
        queueMicrotask(() => {
            if (!this.peer.ended) for (const listener of this.peer.messages) listener(raw);
        });
    }
    onMessage(listener: (raw: string) => void) {
        this.messages.add(listener);
        return () => {
            this.messages.delete(listener);
        };
    }
    onClose(listener: () => void) {
        if (this.ended) listener();
        else this.closes.add(listener);
        return () => {
            this.closes.delete(listener);
        };
    }
    close() {
        if (this.ended) return;
        this.ended = true;
        for (const listener of [...this.closes]) listener();
        this.messages.clear();
        this.closes.clear();
        this.peer.close();
    }
}

test(
    'real device registration and WS coordination drive both consumers with isolated contract channels',
    {
        skip:
            !serverRoot || !mobileRoot || !python
                ? 'set REMOTE_NETWORK_CONTRACT_SERVER_ROOT, REMOTE_NETWORK_CONTRACT_MOBILE_ROOT and REMOTE_NETWORK_CONTRACT_PYTHON'
                : false,
        timeout: 20000
    },
    async () => {
        const root = await mkdtemp(join(tmpdir(), 'opendesk-remote-network-contract-'));
        const processHandle = spawn(python!, [join(serverRoot!, 'test/remote_network_contract_server.py')], {
            cwd: serverRoot,
            env: {
                ...process.env,
                PYTHONPATH: serverRoot,
                DATABASE_URL: `sqlite:///${root}/test.db`,
                OPENDESK_SECRET_KEY: randomUUID()
            },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        // Do not attach service stdout/stderr to the test reporter: bootstrap contains a JWT.
        processHandle.stderr.resume();
        let network: { close(): Promise<void> } | undefined;
        let registration: ReturnType<typeof createRegistrationRuntime> | undefined;
        let port: { close(): void } | undefined;
        try {
            const boot = await new Promise<{ port: number; token: string; userId: string }>((resolve, reject) => {
                let buffer = '';
                const timeout = setTimeout(() => reject(new Error('isolated service bootstrap timed out')), 5000);
                processHandle.once('error', () => {
                    clearTimeout(timeout);
                    reject(new Error('isolated service failed to start'));
                });
                processHandle.once('exit', () => {
                    clearTimeout(timeout);
                    reject(new Error('isolated service exited'));
                });
                processHandle.stdout.on('data', (chunk) => {
                    buffer += chunk.toString();
                    if (!buffer.includes('\n')) return;
                    try {
                        const value = JSON.parse(buffer.split('\n')[0]);
                        clearTimeout(timeout);
                        resolve(value);
                    } catch {
                        clearTimeout(timeout);
                        reject(new Error('invalid isolated bootstrap'));
                    }
                    buffer = '';
                });
            });
            const baseUrl = `http://127.0.0.1:${boot.port}/api/v1`;
            await until(async () => {
                try {
                    return (await fetch(`${baseUrl}/devices`)).status === 401;
                } catch {
                    return false;
                }
            });
            const mobile = await import(
                pathToFileURL(join(mobileRoot!, 'src/features/remote/connection/server-connection-attempt-provider.ts'))
                    .href
            );
            const fixture = JSON.parse(
                await readFile(new URL('./fixtures/remote-network-v1.json', import.meta.url), 'utf8')
            );
            const sdp = fixture.sdp.valid[0];
            const abort = new AbortController();
            registration = createRegistrationRuntime({
                hostType: 'electron',
                signal: abort.signal,
                getCredential: () => ({
                    backendId: 'opendesk',
                    kind: 'enterprise',
                    tokenType: 'bearer',
                    baseUrl,
                    accessToken: boot.token,
                    user: { id: boot.userId, username: 'remote-network-contract-user' }
                }),
                subscribe: () => () => undefined,
                fetch,
                deviceId: 'contract-pc',
                name: 'Contract PC',
                runId: randomUUID()
            });
            await until(() => registration!.getQualification().role === 'current');
            const listed = await fetch(`${baseUrl}/devices`, { headers: { Authorization: `Bearer ${boot.token}` } });
            const list = (await listed.json()) as { devices: Array<{ device_id: string }> };
            assert.equal(list.devices[0].device_id, 'contract-pc');
            const pairs = new Map<string, { pc: ContractChannel; mobile: ContractChannel }>();
            const owner = { hostInstanceId: 'host-1', generation: 1 };
            const channels: ContractChannel[] = [];
            let pcAuthenticated = false;
            const signalingEvents: string[] = [];
            let hostOpened = 0;
            let rejectReadback = false;
            let holdReadback = false;
            let releaseReadback: (() => void) | undefined;
            const received: string[] = [];
            // G1 激活的全局次序，验证两端都在各自的最终控制帧处被通知。
            let activationOrder = 0;
            const madeTransports: Array<{ desktop: boolean; activations: number[] }> = [];
            const makeTransport = (channel: ContractChannel, desktop: boolean) => {
                const instance = {};
                let resolveClosed!: () => void;
                const closed = new Promise<void>((resolve) => {
                    resolveClosed = resolve;
                });
                channel.onClose(resolveClosed);
                channels.push(channel);
                return {
                    instance,
                    owner,
                    channel,
                    opened: Promise.resolve(),
                    closed,
                    offer: async () => sdp,
                    answer: async () => (desktop ? sdp : undefined),
                    addCandidate: async () => undefined,
                    readback: async () => {
                        if (!desktop && holdReadback)
                            await new Promise<void>((resolve) => {
                                releaseReadback = resolve;
                            });
                        return {
                            instance: !desktop && rejectReadback ? {} : instance,
                            owner,
                            channel,
                            state: 'open',
                            stable: true,
                            localDescription: sdp,
                            remoteDescription: sdp
                        };
                    },
                    close: async () => {
                        channel.close();
                    },
                    // G1 可观察记录：两端各自的激活次数，用于断言跨仓合同下两侧都被通知过。
                    activations: [] as number[],
                    activateTrusted() {
                        this.activations.push(++activationOrder);
                    }
                };
            };
            const track = <T extends { activations: number[] }>(transport: T, desktop: boolean) => {
                madeTransports.push({ desktop, activations: transport.activations });
                return transport;
            };
            network = composeRegistrationConnection({
                registration,
                signal: abort.signal,
                allowLoopback: true,
                diagnose: (event) => signalingEvents.push(event.code),
                createSocket: (url) => {
                    signalingEvents.push('socket_create');
                    const socket = createSignalingSocket(url);
                    socket.opened.then(
                        () => signalingEvents.push('opened'),
                        () => signalingEvents.push('open_failed')
                    );
                    socket.onMessage((raw) => {
                        const frame = JSON.parse(raw);
                        signalingEvents.push(`${frame.type}:${frame.payload.code ?? ''}`);
                        if (frame.type === 'auth_ok') pcAuthenticated = true;
                    });
                    return socket;
                },
                bridge: {
                    owner,
                    create: async ({ attemptId }) => {
                        const pc = new ContractChannel(),
                            phone = new ContractChannel();
                        pc.peer = phone;
                        phone.peer = pc;
                        pairs.set(attemptId, { pc, mobile: phone });
                        return track(makeTransport(pc, true), true) as any;
                    }
                },
                openConnection: (channel) => {
                    hostOpened++;
                    channel.onMessage((raw) => received.push(raw));
                    return {
                        close: async () => {
                            channel.close();
                        },
                        closed: Promise.resolve()
                    };
                }
            });
            try {
                await until(() => pcAuthenticated);
            } catch {
                throw new Error(`PC authentication incomplete: ${signalingEvents.join(',')}`);
            }
            const provider = mobile.createServerConnectionAttemptProvider({
                getCredential: () => ({ scopeKey: 'contract', token: boot.token, version: 0, baseUrl }),
                subscribeCredential: () => () => undefined,
                subscribeInvalidation: () => () => undefined,
                invalidateCredential: async () => {
                    throw new Error('unexpected invalidation');
                },
                createSocket: createSignalingSocket,
                allowLoopback: true,
                uuid: randomUUID,
                bridge: {
                    create: async ({ attemptId }: { attemptId: string }) => {
                        await until(() => pairs.has(attemptId));
                        return track(makeTransport(pairs.get(attemptId)!.mobile, false), false);
                    }
                }
            });
            port = await provider.connect({ pcId: 'contract-pc', opaque: {} });
            assert.equal(hostOpened, 1);
            // G1：跨仓合同下两端都必须在各自的最终控制帧处被通知恰好一次，
            // 且手机侧（先发 ready_ack）排在 PC 侧（后收 ready_ack）之前。
            // 手机在「提交 ready_ack」后即激活并 resolve；PC 要等真正收到 ready_ack，
            // 所以此处必须等待，不能假设 connect 返回时两端都已激活。
            await until(() => madeTransports.some((t) => t.desktop && t.activations.length > 0));
            const activatedPc = madeTransports.filter((t) => t.desktop && t.activations.length > 0);
            const activatedMobile = madeTransports.filter((t) => !t.desktop && t.activations.length > 0);
            assert.equal(activatedPc.length, 1, 'PC 端恰好一个 transport 被激活');
            assert.equal(activatedMobile.length, 1, '手机端恰好一个 transport 被激活');
            assert.equal(activatedPc[0].activations.length, 1, 'PC 端恰好通知一次');
            assert.equal(activatedMobile[0].activations.length, 1, '手机端恰好通知一次');
            assert.ok(
                activatedMobile[0].activations[0] < activatedPc[0].activations[0],
                '手机在提交 ready_ack 后先激活，PC 收到后才激活'
            );
            await (port as any).send('{"jsonrpc":"2.0","id":1,"method":"synthetic-probe"}');
            await until(() => received.length === 1);
            const competing = provider.connect({ pcId: 'contract-pc', opaque: {} });
            await assert.rejects(competing, (error: any) => error.code === 'remote_pc_busy');
            assert.equal(hostOpened, 1);
            port.close();
            await until(() => channels.every((channel) => channel.ended));
            assert.equal(registration.getQualification().role, 'current');
            // Allow the previous close notification to reach the real coordinator before the next case.
            await tick();
            rejectReadback = true;
            await assert.rejects(
                provider.connect({ pcId: 'contract-pc', opaque: {} }),
                (error: any) => error.code === 'peer_binding_failed'
            );
            assert.equal(hostOpened, 1, 'bad native instance cannot open ACP');
            await until(() => channels.every((channel) => channel.ended));
            await tick();
            rejectReadback = false;
            holdReadback = true;
            const cancelling = new AbortController();
            const cancelled = provider.connect({ pcId: 'contract-pc', opaque: {} }, { signal: cancelling.signal });
            const cancellation = assert.rejects(cancelled, (error: any) => error.code === 'cancelled');
            await until(() => !!releaseReadback);
            cancelling.abort();
            releaseReadback!();
            await cancellation;
            await until(() => channels.every((channel) => channel.ended));
            assert.equal(hostOpened, 1, 'late readback after cancel cannot open ACP');
            await tick();
            holdReadback = false;
            port = await provider.connect({ pcId: 'contract-pc', opaque: {} });
            assert.equal(hostOpened, 2, 'a new attempt succeeds after cancellation cleanup');
            registration.suspend();
            await until(() => channels.every((channel) => channel.ended));
            await network.close();
            network = undefined;
            assert.equal(registration.getQualification().role, null);
        } finally {
            port?.close();
            try {
                try {
                    await network?.close();
                } finally {
                    await registration?.close();
                }
            } finally {
                processHandle.kill('SIGTERM');
                await new Promise<void>((resolve) => {
                    if (processHandle.exitCode !== null || processHandle.signalCode !== null) return resolve();
                    const timer = setTimeout(() => processHandle.kill('SIGKILL'), 3000);
                    processHandle.once('exit', () => {
                        clearTimeout(timer);
                        resolve();
                    });
                });
                await rm(root, { recursive: true, force: true });
            }
        }
    }
);
