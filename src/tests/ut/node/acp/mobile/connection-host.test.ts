import assert from 'node:assert/strict';
import test from 'node:test';
import * as acp from '@agentclientprotocol/sdk';
import type { Client } from '@agentclientprotocol/sdk';
import { MobileAcpAgentAdapter } from '../../../../../main/applications/mobileaccess/acp/mobile/acp-endpoint/agent-adapter.js';
import {
    MobileAcpConnectionHost,
    type MobileAcpAdapterFactoryArgs
} from '../../../../../main/applications/mobileaccess/acp/mobile/acp-endpoint/connection-host.js';
import { PublicSessionProjectionError } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/public-session.js';
import type { RemoteSessionService } from '../../../../../main/applications/mobileaccess/acp/mobile/remote-session-service/service.js';
import {
    createAcpMessageStream,
    type AcpMessageChannel
} from '../../../../../main/applications/mobileaccess/acp/mobile/transport/acp-message-stream.js';
import { createTestChannelPair, TestAcpMessageChannel } from './test-channel.js';

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
    async startPrompt() {
        throw new Error('fixture has no Prompt target');
    },
    beginSessionLoad() {
        throw new PublicSessionProjectionError('session_unavailable', 'no fixture session');
    }
};

async function openObservedHost() {
    const [clientPort, serverPort] = createTestChannelPair();
    let failClosed!: () => void;
    let cleanupCalls = 0;
    let registerCleanup!: (callback: () => void) => void;
    const host = new MobileAcpConnectionHost({
        remoteSessionService: service,
        diagnose: () => undefined,
        adapterFactory(args) {
            failClosed = args.failClosed;
            registerCleanup = args.registerCleanup;
            args.registerCleanup(() => {
                cleanupCalls += 1;
                serverPort.events.push('cleanup');
            });
            return new MobileAcpAgentAdapter(
                args.connection,
                args.signal,
                service,
                () => undefined,
                args.failClosed,
                args.registerCleanup,
                'test'
            );
        }
    });
    const hosted = host.open(serverPort, {});
    const binding = createAcpMessageStream(clientPort, new AbortController());
    const client = new acp.ClientSideConnection(
        (): Client => ({
            async requestPermission() {
                return { outcome: { outcome: 'cancelled' } };
            },
            async sessionUpdate() {}
        }),
        binding.stream
    );
    await client.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    return { host, hosted, client, serverPort, failClosed, registerCleanup, cleanupCalls: () => cleanupCalls };
}

test('failClosed runs cleanup before closing the port and is idempotent', async () => {
    const pair = await openObservedHost();
    pair.failClosed();
    pair.failClosed();
    await pair.hosted.closed;
    assert.equal(pair.cleanupCalls(), 1);
    assert.equal(pair.serverPort.events.filter((value) => value === 'port-close').length, 1);
    assert.ok(pair.serverPort.events.indexOf('cleanup') < pair.serverPort.events.indexOf('port-close'));
});

test('explicit and repeated host close run registered cleanup and physical close once', async () => {
    const pair = await openObservedHost();
    const first = pair.hosted.close();
    const second = pair.hosted.close();
    assert.equal(first, second);
    await first;
    await pair.host.close();
    assert.equal(pair.cleanupCalls(), 1);
    assert.equal(pair.serverPort.events.filter((value) => value === 'port-close').length, 1);
    assert.ok(pair.serverPort.events.indexOf('cleanup') < pair.serverPort.events.indexOf('port-close'));
});

test('cleanup registered after close runs immediately and cannot retain connection resources', async () => {
    const pair = await openObservedHost();
    await pair.hosted.close();
    let lateCleanupCalls = 0;
    pair.registerCleanup(() => {
        lateCleanupCalls += 1;
    });
    assert.equal(lateCleanupCalls, 1);
    assert.equal(pair.serverPort.listenerCount, 0);
    assert.equal(pair.serverPort.events.filter((value) => value === 'port-close').length, 1);
});

test('a clean pre-response load failure leaves the ACP connection usable', async () => {
    const pair = await openObservedHost();
    await assert.rejects(
        pair.client.loadSession({ sessionId: 'missing', cwd: '/work', mcpServers: [] }),
        (error: unknown) => {
            assert.deepEqual((error as acp.RequestError).data, {
                opendesk: { schemaVersion: 1, code: 'session_unavailable' }
            });
            return true;
        }
    );
    assert.deepEqual(await pair.client.listSessions({}), { sessions: [] });
    assert.equal(pair.serverPort.events.includes('port-close'), false);
    await pair.hosted.close();
});

class SilentCloseChannel implements AcpMessageChannel {
    readonly released: string[] = [];
    closeCalls = 0;

    send(): void {}

    onMessage(): () => void {
        return () => {
            this.released.push('message');
        };
    }

    onClose(): () => void {
        return () => {
            this.released.push('close');
        };
    }

    // A transport whose close does not notify its own listeners: the Host must unbind explicitly.
    close(): void {
        this.closeCalls += 1;
    }
}

function hostWithFailingAdapter(
    failure: Error,
    beforeThrow?: (args: MobileAcpAdapterFactoryArgs<object>) => void
): { host: MobileAcpConnectionHost; signal: () => AbortSignal } {
    let captured: AbortSignal | undefined;
    const host = new MobileAcpConnectionHost({
        remoteSessionService: service,
        diagnose: () => undefined,
        adapterFactory(args) {
            captured = args.signal;
            beforeThrow?.(args);
            throw failure;
        }
    });
    return {
        host,
        signal: () => {
            assert.ok(captured);
            return captured;
        }
    };
}

test('a failed adapter construction releases cleanup, scope, listeners and the channel', async () => {
    const channel = new TestAcpMessageChannel();
    const failure = new Error('adapter construction failed');
    let cleanupCalls = 0;
    const { host, signal } = hostWithFailingAdapter(failure, (args) =>
        args.registerCleanup(() => {
            cleanupCalls += 1;
            channel.events.push('cleanup');
        })
    );

    assert.throws(
        () => host.open(channel, {}),
        (error: unknown) => error === failure
    );
    assert.equal(cleanupCalls, 1);
    assert.equal(signal().aborted, true);
    assert.equal(channel.listenerCount, 0);
    assert.equal(channel.events.filter((value) => value === 'port-close').length, 1);
    assert.ok(channel.events.indexOf('cleanup') < channel.events.indexOf('port-close'));
    await host.close();
    assert.equal(channel.events.filter((value) => value === 'port-close').length, 1);
});

test('construction failure unbinds listeners without relying on a channel close broadcast', async () => {
    const channel = new SilentCloseChannel();
    const failure = new Error('adapter construction failed');
    const { host } = hostWithFailingAdapter(failure);

    assert.throws(
        () => host.open(channel, {}),
        (error: unknown) => error === failure
    );
    assert.deepEqual(channel.released, ['message', 'close']);
    assert.equal(channel.closeCalls, 1);
    await host.close();
});

test('a throwing cleanup during construction failure does not skip the remaining release', async () => {
    const channel = new SilentCloseChannel();
    const failure = new Error('adapter construction failed');
    let secondCleanupCalls = 0;
    const { host, signal } = hostWithFailingAdapter(failure, (args) => {
        args.registerCleanup(() => {
            throw new Error('cleanup failed');
        });
        args.registerCleanup(() => {
            secondCleanupCalls += 1;
        });
    });

    assert.throws(
        () => host.open(channel, {}),
        (error: unknown) => error === failure
    );
    assert.equal(secondCleanupCalls, 1);
    assert.equal(signal().aborted, true);
    assert.deepEqual(channel.released, ['message', 'close']);
    assert.equal(channel.closeCalls, 1);
    await host.close();
});
