import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MessageMcpNotification } from '@agentclientprotocol/sdk/experimental/v2';
import { ClientWorkspaceRuntime } from '../../../../main/applications/acpmgr/runtime/client-workspace.js';
import {
    ClientHostedWorkspaceMcp,
    type AcpMcpPeer
} from '../../../../main/applications/acpmgr/runtime/client-hosted-mcp.js';

class FakePeer implements AcpMcpPeer {
    notifications: MessageMcpNotification[] = [];

    async request(): Promise<unknown> {
        throw new Error('Unexpected server-to-Agent MCP request');
    }

    async notify(params: MessageMcpNotification): Promise<void> {
        this.notifications.push(params);
    }
}

async function request(
    host: ClientHostedWorkspaceMcp,
    connectionId: string,
    method: string,
    params?: Record<string, unknown>
): Promise<any> {
    return host.message({ connectionId, method, params });
}

test('Client-hosted workspace MCP exposes bounded file and command tools over ACP', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-acp-mcp-'));
    try {
        const runtime = new ClientWorkspaceRuntime({ root, authorize: async () => true });
        runtime.setSessionId('session-1');
        const host = new ClientHostedWorkspaceMcp({
            serverId: 'workspace-server',
            workspace: runtime,
            sessionId: 'session-1'
        });
        const peer = new FakePeer();
        const { connectionId } = await host.connect({ serverId: 'workspace-server' }, peer);

        const initialized = await request(host, connectionId, 'initialize', {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'fake-agent', version: '1.0.0' }
        });
        assert.equal(initialized.serverInfo.name, 'opendesk-workspace');
        await host.notify({ connectionId, method: 'notifications/initialized' });

        const listed = await request(host, connectionId, 'tools/list');
        const names = listed.tools.map((tool: any) => tool.name);
        assert.ok(names.includes('read_text_file'));
        assert.ok(names.includes('write_text_file'));
        assert.ok(names.includes('list_directory'));
        assert.ok(names.includes('run_command'));

        const file = path.join(root, 'note.txt');
        const written = await request(host, connectionId, 'tools/call', {
            name: 'write_text_file',
            arguments: { path: file, content: 'hello' }
        });
        assert.equal(written.isError, undefined);
        const read = await request(host, connectionId, 'tools/call', {
            name: 'read_text_file',
            arguments: { path: 'note.txt' }
        });
        assert.equal(read.content[0].text, 'hello');

        const command = await request(host, connectionId, 'tools/call', {
            name: 'run_command',
            arguments: { command: process.execPath, args: ['-e', 'process.stdout.write("ok")'] }
        });
        assert.match(command.content[0].text, /"output":"ok"/);

        await host.disconnect({ connectionId });
        await host.close();
        await runtime.close();
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('Client-hosted workspace MCP rejects unknown server and connection ids', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-acp-mcp-ids-'));
    try {
        const runtime = new ClientWorkspaceRuntime({ root, authorize: async () => true });
        const host = new ClientHostedWorkspaceMcp({
            serverId: 'workspace-server',
            workspace: runtime,
            sessionId: 'session-1'
        });
        await assert.rejects(host.connect({ serverId: 'other' }, new FakePeer()), /server|服务/i);
        await assert.rejects(host.message({ connectionId: 'missing', method: 'tools/list' }), /connection|连接/i);
        await host.close();
        await runtime.close();
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
