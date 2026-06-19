import test from 'node:test';
import assert from 'node:assert/strict';
import { createAcpProtocolOutput, installAcpStdoutGuard } from '../../../../main/server/acp/stdio.js';

function getWriteCallback(
    encodingOrCallback?: BufferEncoding | ((err?: Error | null) => void),
    callback?: (err?: Error | null) => void
): ((err?: Error | null) => void) | undefined {
    return typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
}

function chunkToString(chunk: unknown, encodingOrCallback?: BufferEncoding | ((err?: Error | null) => void)): string {
    const encoding = typeof encodingOrCallback === 'string' ? encodingOrCallback : 'utf8';
    if (typeof chunk === 'string') return chunk;
    if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString(encoding);
    return String(chunk);
}

test('ACP stdout guard redirects non-protocol stdout without affecting protocol output', async () => {
    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;
    let protocolOutput = '';
    let redirectedOutput = '';

    try {
        (process.stdout as any).write = (
            chunk: unknown,
            encodingOrCallback?: BufferEncoding | ((err?: Error | null) => void),
            callback?: (err?: Error | null) => void
        ) => {
            protocolOutput += chunkToString(chunk, encodingOrCallback);
            getWriteCallback(encodingOrCallback, callback)?.();
            return true;
        };
        (process.stderr as any).write = (
            chunk: unknown,
            encodingOrCallback?: BufferEncoding | ((err?: Error | null) => void),
            callback?: (err?: Error | null) => void
        ) => {
            redirectedOutput += chunkToString(chunk, encodingOrCallback);
            getWriteCallback(encodingOrCallback, callback)?.();
            return true;
        };

        installAcpStdoutGuard();
        process.stdout.write('polluting stdout\n');

        const writer = createAcpProtocolOutput().getWriter();
        await writer.write(new TextEncoder().encode('{"jsonrpc":"2.0","id":1}\n'));
        writer.releaseLock();
    } finally {
        (process.stdout as any).write = originalStdoutWrite;
        (process.stderr as any).write = originalStderrWrite;
    }

    assert.equal(protocolOutput, '{"jsonrpc":"2.0","id":1}\n');
    assert.match(redirectedOutput, /polluting stdout/);
    assert.match(redirectedOutput, /\[acp stdout redirected\]/);
});
