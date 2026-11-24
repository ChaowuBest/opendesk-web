import test from 'node:test';
import assert from 'node:assert/strict';
import type { AnyMessage } from '@agentclientprotocol/sdk';
import {
    AcpConnectionClosedError,
    AcpProtocolMessageError,
    createAcpMessageStream,
    type AcpMessageChannel
} from '../../../../../main/applications/mobileaccess/acp/mobile/transport/acp-message-stream.js';
import { TestAcpMessageChannel } from './test-channel.js';

const response = (id: number): AnyMessage => ({ jsonrpc: '2.0', id, result: { id } });

test('message channel replays frames received before the ACP listener in order', async () => {
    const port = new TestAcpMessageChannel();
    port.emitMessage(JSON.stringify(response(1)));
    port.emitMessage(JSON.stringify(response(2)));
    const scope = new AbortController();
    const binding = createAcpMessageStream(port, scope);
    const reader = binding.stream.readable.getReader();

    assert.deepEqual((await reader.read()).value, response(1));
    assert.deepEqual((await reader.read()).value, response(2));
    binding.disconnect(new AcpConnectionClosedError());
    reader.releaseLock();
});

test('stream serializes one complete ACP message per port send', async () => {
    const port = new TestAcpMessageChannel();
    const binding = createAcpMessageStream(port, new AbortController());
    const writer = binding.stream.writable.getWriter();

    await writer.write(response(7));
    assert.deepEqual(
        port.sent.map((message) => JSON.parse(message)),
        [response(7)]
    );
    writer.releaseLock();
});

test('normal port close drains enqueued messages before EOF and aborts the scope', async () => {
    const port = new TestAcpMessageChannel();
    const scope = new AbortController();
    const binding = createAcpMessageStream(port, scope);
    port.emitMessage(JSON.stringify(response(1)));
    port.emitMessage(JSON.stringify(response(2)));
    port.emitClose();
    const reader = binding.stream.readable.getReader();

    assert.deepEqual((await reader.read()).value, response(1));
    assert.deepEqual((await reader.read()).value, response(2));
    assert.equal((await reader.read()).done, true);
    assert.equal(scope.signal.aborted, true);
    assert.equal(port.listenerCount, 0);
});

test('port error errors the stream and drops messages not delivered to a reader', async () => {
    const port = new TestAcpMessageChannel();
    const failure = new Error('transport read failed');
    const binding = createAcpMessageStream(port, new AbortController());
    port.emitMessage(JSON.stringify(response(1)));
    port.emitClose(failure);
    const reader = binding.stream.readable.getReader();

    await assert.rejects(reader.read(), failure);
    assert.equal(port.listenerCount, 0);
});

test('malformed JSON and a non-ACP envelope close only the current port', async () => {
    for (const text of ['{', '[]', '{}', '{"jsonrpc":"1.0","id":1}']) {
        const port = new TestAcpMessageChannel();
        const scope = new AbortController();
        createAcpMessageStream(port, scope);
        port.emitMessage(text);

        assert.equal(scope.signal.aborted, true, text);
        assert.ok(scope.signal.reason instanceof AcpProtocolMessageError, text);
        assert.equal(port.listenerCount, 0, text);
        assert.deepEqual(port.events, ['unbind-message', 'unbind-close', 'port-close', 'notify-close'], text);
    }
});

test('write failure aborts the scope and subsequent writes fail', async () => {
    const port = new TestAcpMessageChannel();
    const failure = new Error('transport write failed');
    port.failSendWith = failure;
    const scope = new AbortController();
    const binding = createAcpMessageStream(port, scope);
    const writer = binding.stream.writable.getWriter();

    await assert.rejects(writer.write(response(1)), failure);
    assert.equal(scope.signal.reason, failure);
    await assert.rejects(writer.write(response(2)));
    writer.releaseLock();
});

test('a targeted writable rejection aborts the scope without sending the rejected frame', async () => {
    const port = new TestAcpMessageChannel();
    const failure = new Error('target frame failed');
    port.rejectNextSend((frame) => 'method' in frame && frame.method === '_opendesk/test-target', failure);
    const scope = new AbortController();
    const binding = createAcpMessageStream(port, scope);
    const writer = binding.stream.writable.getWriter();

    await writer.write(response(1));
    await assert.rejects(writer.write({ jsonrpc: '2.0', method: '_opendesk/test-target', params: {} }), failure);

    assert.equal(scope.signal.reason, failure);
    assert.equal(port.sent.length, 1);
    assert.deepEqual(JSON.parse(port.sent[0] ?? ''), response(1));
    writer.releaseLock();
});

test('active disconnect unbinds listeners before aborting and closing the port', () => {
    const port = new TestAcpMessageChannel();
    const scope = new AbortController();
    scope.signal.addEventListener('abort', () => port.events.push('scope-abort'));
    const binding = createAcpMessageStream(port, scope);
    const failure = new AcpConnectionClosedError('local disconnect');

    binding.disconnect(failure);
    port.close();
    binding.disconnect(failure);
    port.close();

    assert.deepEqual(port.events, [
        'unbind-message',
        'unbind-close',
        'scope-abort',
        'port-close',
        'notify-close',
        'port-close'
    ]);
});

class ListenerTrackingChannel implements AcpMessageChannel {
    readonly released: string[] = [];
    closeCalls = 0;
    failOnCloseRegistrationWith?: Error;
    failMessageReleaseWith?: Error;

    send(): void {}

    onMessage(): () => void {
        return () => {
            if (this.failMessageReleaseWith) throw this.failMessageReleaseWith;
            this.released.push('message');
        };
    }

    onClose(): () => void {
        if (this.failOnCloseRegistrationWith) throw this.failOnCloseRegistrationWith;
        return () => {
            this.released.push('close');
        };
    }

    close(): void {
        this.closeCalls += 1;
    }
}

function writableStreamFailingWith(error: Error): typeof WritableStream {
    return class {
        constructor() {
            throw error;
        }
    } as unknown as typeof WritableStream;
}

test('a close-listener registration failure releases the message listener already bound', () => {
    const channel = new ListenerTrackingChannel();
    const failure = new Error('close listener registration failed');
    channel.failOnCloseRegistrationWith = failure;
    const scope = new AbortController();

    assert.throws(
        () => createAcpMessageStream(channel, scope),
        (error: unknown) => error === failure
    );
    assert.deepEqual(channel.released, ['message']);
    assert.equal(channel.closeCalls, 0);
    assert.equal(scope.signal.aborted, false);
});

test('a writable construction failure releases both listeners the factory already bound', () => {
    const channel = new ListenerTrackingChannel();
    const failure = new Error('writable construction failed');
    const scope = new AbortController();

    assert.throws(
        () =>
            createAcpMessageStream(channel, scope, {
                ReadableStream,
                WritableStream: writableStreamFailingWith(failure)
            }),
        (error: unknown) => error === failure
    );
    assert.deepEqual(channel.released, ['message', 'close']);
    assert.equal(channel.closeCalls, 0);
    assert.equal(scope.signal.aborted, false);
});

test('one throwing unsubscribe does not skip the remaining factory release or replace the construction error', () => {
    const channel = new ListenerTrackingChannel();
    const failure = new Error('writable construction failed');
    channel.failMessageReleaseWith = new Error('message unsubscribe failed');
    const scope = new AbortController();

    assert.throws(
        () =>
            createAcpMessageStream(channel, scope, {
                ReadableStream,
                WritableStream: writableStreamFailingWith(failure)
            }),
        (error: unknown) => error === failure
    );
    assert.deepEqual(channel.released, ['close']);
});
