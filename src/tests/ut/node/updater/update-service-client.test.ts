import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { reportUpdateHealthToService, submitUpdateToService } from '../../../../main/updater/update-service-client.js';

test('submits the fixed update-service protocol and parses an installed response', async (t) => {
    const pipePath =
        process.platform === 'win32'
            ? `\\\\.\\pipe\\OpenDesk.UpdateService.test.${crypto.randomUUID()}`
            : path.join(os.tmpdir(), `opendesk-update-service-${crypto.randomUUID()}.sock`);
    const received: unknown[] = [];
    const server = net.createServer((socket) => {
        socket.setEncoding('utf8');
        let buffer = '';
        socket.on('data', (chunk) => {
            buffer += chunk;
            const newline = buffer.indexOf('\n');
            if (newline < 0) return;
            const request = JSON.parse(buffer.slice(0, newline));
            received.push(request);
            socket.end(
                `${JSON.stringify({
                    protocolVersion: 1,
                    requestId: request.requestId,
                    status: 'installed',
                    code: 'installed',
                    targetVersion: request.targetVersion,
                    installerExitCode: 0,
                    updatedAtUtc: new Date().toISOString()
                })}\n`
            );
        });
    });
    t.after(() => {
        server.close();
        if (process.platform !== 'win32') fs.rmSync(pipePath, { force: true });
    });
    await new Promise<void>((resolve, reject) => server.listen(pipePath, resolve).once('error', reject));

    const response = await submitUpdateToService(
        {
            requestId: '00000000-0000-4000-8000-000000000001',
            version: '0.3.7',
            installerPath: 'C:\\Users\\tester\\AppData\\Roaming\\opendesk\\Cache\\OpenDesk-0.3.7.exe',
            sha256: 'a'.repeat(64)
        },
        { pipePath, timeoutMs: 5_000 }
    );

    assert.equal(response.status, 'installed');
    assert.deepEqual(received, [
        {
            protocolVersion: 1,
            requestId: '00000000-0000-4000-8000-000000000001',
            action: 'submitUpdate',
            targetVersion: '0.3.7',
            sourcePath: 'C:\\Users\\tester\\AppData\\Roaming\\opendesk\\Cache\\OpenDesk-0.3.7.exe',
            sha256: 'a'.repeat(64)
        }
    ]);
});

test('rejects malformed update-service responses', async (t) => {
    const pipePath =
        process.platform === 'win32'
            ? `\\\\.\\pipe\\OpenDesk.UpdateService.test.${crypto.randomUUID()}`
            : path.join(os.tmpdir(), `opendesk-update-service-${crypto.randomUUID()}.sock`);
    const server = net.createServer((socket) => socket.end('{"status":"installed"}\n'));
    t.after(() => {
        server.close();
        if (process.platform !== 'win32') fs.rmSync(pipePath, { force: true });
    });
    await new Promise<void>((resolve, reject) => server.listen(pipePath, resolve).once('error', reject));

    await assert.rejects(
        submitUpdateToService(
            {
                requestId: '00000000-0000-4000-8000-000000000001',
                version: '0.3.7',
                installerPath: 'C:\\update.exe',
                sha256: 'a'.repeat(64)
            },
            { pipePath, timeoutMs: 5_000 }
        ),
        /invalid response/i
    );
});

test('reports the running packaged version and process id as healthy', async (t) => {
    const pipePath =
        process.platform === 'win32'
            ? `\\\\.\\pipe\\OpenDesk.UpdateService.test.${crypto.randomUUID()}`
            : path.join(os.tmpdir(), `opendesk-update-service-${crypto.randomUUID()}.sock`);
    let received: Record<string, unknown> | undefined;
    const server = net.createServer((socket) => {
        socket.setEncoding('utf8');
        let buffer = '';
        socket.on('data', (chunk) => {
            buffer += chunk;
            const newline = buffer.indexOf('\n');
            if (newline < 0) return;
            received = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
            socket.end(
                `${JSON.stringify({
                    protocolVersion: 1,
                    requestId: received.requestId,
                    status: 'cleanup_pending',
                    code: 'health_recorded',
                    targetVersion: received.targetVersion,
                    updatedAtUtc: new Date().toISOString()
                })}\n`
            );
        });
    });
    t.after(() => {
        server.close();
        if (process.platform !== 'win32') fs.rmSync(pipePath, { force: true });
    });
    await new Promise<void>((resolve, reject) => server.listen(pipePath, resolve).once('error', reject));

    const response = await reportUpdateHealthToService('0.3.7', 4321, { pipePath, timeoutMs: 5_000 });

    assert.equal(response.code, 'health_recorded');
    assert.equal(received?.action, 'reportHealthy');
    assert.equal(received?.targetVersion, '0.3.7');
    assert.equal(received?.processId, 4321);
    assert.match(String(received?.requestId), /^[0-9a-f-]{36}$/i);
});
