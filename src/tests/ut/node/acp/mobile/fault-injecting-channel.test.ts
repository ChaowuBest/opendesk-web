import test from 'node:test';
import assert from 'node:assert/strict';
import { AcpConnectionClosedError } from '../../../../../main/applications/mobileaccess/acp/mobile/transport/acp-message-stream.js';
import {
    FaultInjectingChannel,
    type FaultInjectingChannelDiagnostic
} from '../../../../../main/applications/mobileaccess/acp/mobile/testing/fault-injecting-channel.js';
import { TestAcpMessageChannel } from './test-channel.js';

// 断言迁自原 electron-directory.test.ts：旧 loopback 传输删除后，故障注入本身仍是可复用能力。
test('fault wrapper reports only ordinal and bytes while injecting send failures', async () => {
    const inner = new TestAcpMessageChannel();
    const diagnostics: FaultInjectingChannelDiagnostic[] = [];
    const port = new FaultInjectingChannel(inner, { delaySendMs: 0, rejectSendAtOrdinal: 2 }, (event) =>
        diagnostics.push(event)
    );
    await port.send('first-secret');
    await assert.rejects(port.send('second-secret'), /Injected transport send rejection/);
    assert.deepEqual(diagnostics, [
        { type: 'send', ordinal: 1, bytes: 12, outcome: 'sent' },
        { type: 'send', ordinal: 2, bytes: 13, outcome: 'rejected' }
    ]);
    assert.doesNotMatch(JSON.stringify(diagnostics), /secret/);
});

test('a disconnect ordinal closes the connection and keeps the diagnostic body-free', async () => {
    const inner = new TestAcpMessageChannel();
    const diagnostics: FaultInjectingChannelDiagnostic[] = [];
    const port = new FaultInjectingChannel(inner, { delaySendMs: 0, disconnectAtOrdinal: 1 }, (event) =>
        diagnostics.push(event)
    );
    await assert.rejects(port.send('third-secret'), (error: unknown) => error instanceof AcpConnectionClosedError);
    assert.deepEqual(diagnostics, [{ type: 'send', ordinal: 1, bytes: 12, outcome: 'disconnected' }]);
    assert.doesNotMatch(JSON.stringify(diagnostics), /secret/);
});

test('a configured delay still forwards the exact payload in order', async () => {
    const inner = new TestAcpMessageChannel();
    const port = new FaultInjectingChannel(inner, { delaySendMs: 1 }, () => undefined);
    await port.send('one');
    await port.send('two');
    assert.deepEqual(inner.sent, ['one', 'two']);
});
