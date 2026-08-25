import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClientWorkspaceRuntime } from '../../../../main/applications/acpmgr/runtime/client-workspace.js';

test('Client workspace runtime reads and writes text only inside its root', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-acp-workspace-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-acp-outside-'));
    try {
        const runtime = new ClientWorkspaceRuntime({ root, authorize: async () => true });
        const file = path.join(root, 'notes.txt');
        await runtime.writeTextFile({ sessionId: 'session-1', path: file, content: 'one\ntwo\nthree\n' });

        assert.deepEqual(await runtime.readTextFile({ sessionId: 'session-1', path: file, line: 2, limit: 1 }), {
            content: 'two'
        });
        await assert.rejects(
            runtime.readTextFile({ sessionId: 'session-1', path: path.join(outside, 'secret.txt') }),
            /workspace|工作区|outside/i
        );
        await runtime.close();
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    }
});

test('Client workspace runtime executes commands with a bounded cwd and captures output', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-acp-terminal-'));
    try {
        const runtime = new ClientWorkspaceRuntime({ root, authorize: async () => true });
        const created = await runtime.createTerminal({
            sessionId: 'session-1',
            command: process.execPath,
            args: ['-e', 'process.stdout.write(process.cwd())'],
            cwd: root,
            outputByteLimit: 4096
        });
        const exit = await runtime.waitForTerminalExit({
            sessionId: 'session-1',
            terminalId: created.terminalId
        });
        const output = await runtime.terminalOutput({
            sessionId: 'session-1',
            terminalId: created.terminalId
        });

        assert.equal(exit.exitCode, 0);
        assert.equal(output.output, root);
        assert.equal(output.truncated, false);
        await runtime.releaseTerminal({ sessionId: 'session-1', terminalId: created.terminalId });
        await runtime.close();
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('Client workspace runtime asks for authorization before writes and process creation', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-acp-authorize-'));
    const operations: string[] = [];
    try {
        const runtime = new ClientWorkspaceRuntime({
            root,
            authorize: async (operation) => {
                operations.push(operation.kind);
                return false;
            }
        });

        await assert.rejects(
            runtime.writeTextFile({ sessionId: 'session-1', path: path.join(root, 'blocked.txt'), content: 'no' }),
            /denied|拒绝/i
        );
        await assert.rejects(
            runtime.createTerminal({ sessionId: 'session-1', command: process.execPath, args: ['--version'] }),
            /denied|拒绝/i
        );
        assert.deepEqual(operations, ['write', 'execute']);
        await runtime.close();
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('Client workspace runtime keeps truncated terminal output valid UTF-8', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-acp-terminal-utf8-'));
    try {
        const runtime = new ClientWorkspaceRuntime({ root, authorize: async () => true });
        const created = await runtime.createTerminal({
            sessionId: 'session-1',
            command: process.execPath,
            args: ['-e', 'process.stdout.write("🙂".repeat(100))'],
            cwd: root,
            outputByteLimit: 17
        });
        await runtime.waitForTerminalExit({ sessionId: 'session-1', terminalId: created.terminalId });
        const output = await runtime.terminalOutput({ sessionId: 'session-1', terminalId: created.terminalId });

        assert.equal(output.truncated, true);
        assert.equal(output.output.includes('�'), false);
        assert.ok(Buffer.byteLength(output.output, 'utf8') <= 17);
        await runtime.close();
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('Client workspace runtime rejects a directory link that escapes its root', async (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-acp-symlink-root-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-acp-symlink-outside-'));
    try {
        fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
        const link = path.join(root, 'outside-link');
        try {
            fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
        } catch {
            context.skip('Creating directory links is not permitted in this environment');
            return;
        }
        const runtime = new ClientWorkspaceRuntime({ root, authorize: async () => true });
        await assert.rejects(
            runtime.readTextFile({ sessionId: 'session-1', path: path.join(link, 'secret.txt') }),
            /workspace|工作区|outside/i
        );
        await runtime.close();
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    }
});
