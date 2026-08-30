import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as acpV2 from '@agentclientprotocol/sdk/experimental/v2';
import { AcpAgentProfileSchema } from '../../../../main/applications/acpmgr/common.js';
import { createDefaultAcpConnectionFactory } from '../../../../main/applications/acpmgr/runtime/connection.js';
import { createV2ConnectionHandle } from '../../../../main/applications/acpmgr/runtime/connection-v2.js';
import { setPlatform, type AbstractPlatform } from '../../../../platforms/base.js';

setPlatform({
    getInjectedEnviron: () => new Map()
} as AbstractPlatform);

const profile = AcpAgentProfileSchema.parse({
    id: '11111111-1111-4111-8111-111111111111',
    name: 'V2 Agent',
    protocolVersion: 2,
    transport: { type: 'streamableHttp', url: 'https://agent.example.com/acp' },
    execution: {
        location: 'client',
        workspace: { strategy: 'task' },
        compatibility: 'required',
        agentSessionCwd: { path: '/workspace', platform: 'posix' }
    }
});

test('ACP v2 connection injects Client-hosted MCP and waits for idle state', async () => {
    let newSessionRequest: acpV2.NewSessionRequest | undefined;
    const agent = acpV2
        .agent({ name: 'fake-v2-agent' })
        .onRequest(acpV2.methods.agent.initialize, () => ({
            protocolVersion: 2,
            info: { name: 'fake-v2-agent', version: '1.0.0' },
            capabilities: { session: { mcp: { acp: {} } } }
        }))
        .onRequest(acpV2.methods.agent.session.new, (context) => {
            newSessionRequest = context.params;
            return {
                sessionId: 'session-1',
                configOptions: [
                    {
                        type: 'select',
                        configId: 'model',
                        name: 'Model',
                        currentValue: 'model-a',
                        options: [{ value: 'model-a', name: 'Model A' }]
                    }
                ]
            };
        })
        .onRequest(acpV2.methods.agent.session.prompt, async (context) => {
            await context.client.notify(acpV2.methods.client.session.update, {
                sessionId: context.params.sessionId,
                update: {
                    sessionUpdate: 'agent_message_chunk',
                    messageId: 'message-1',
                    content: { type: 'text', text: 'v2 answer' }
                }
            });
            await context.client.notify(acpV2.methods.client.session.update, {
                sessionId: context.params.sessionId,
                update: { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' }
            });
            return {};
        })
        .onRequest(acpV2.methods.agent.session.setConfigOption, () => ({ configOptions: [] }))
        .onRequest(acpV2.methods.agent.session.resume, () => ({ configOptions: [] }))
        .onRequest(acpV2.methods.agent.session.close, () => ({}))
        .onNotification(acpV2.methods.agent.session.cancel, () => undefined);
    const updates: unknown[] = [];
    const handle = createV2ConnectionHandle(
        profile,
        {
            sessionUpdate: async (params) => updates.push(params),
            requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
            clientMcpServer: { name: 'OpenDesk workspace', serverId: 'workspace-server' }
        },
        agent
    );

    const initialized = await handle.connection.initialize({
        protocolVersion: 2,
        clientCapabilities: {},
        clientInfo: { name: 'OpenDesk', version: '0.3.4' }
    });
    assert.equal(initialized.protocolVersion, 2);
    const session = await handle.connection.newSession({ cwd: '/workspace', mcpServers: [] });
    assert.equal(session.configOptions?.[0].id, 'model');
    assert.deepEqual(newSessionRequest?.mcpServers, [
        { type: 'acp', name: 'OpenDesk workspace', serverId: 'workspace-server' }
    ]);
    const result = await handle.connection.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'hello' }]
    });
    assert.equal(result.stopReason, 'end_turn');
    assert.equal((updates[0] as any).update.content.text, 'v2 answer');
    await handle.close();
});

test('ACP v2 connection rejects Client-hosted MCP when the Agent lacks mcp.acp', async () => {
    const agent = acpV2.agent({ name: 'no-mcp-agent' }).onRequest(acpV2.methods.agent.initialize, () => ({
        protocolVersion: 2,
        info: { name: 'no-mcp-agent', version: '1.0.0' },
        capabilities: { session: {} }
    }));
    const handle = createV2ConnectionHandle(
        profile,
        {
            sessionUpdate: async () => undefined,
            requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
            clientMcpServer: { name: 'OpenDesk workspace', serverId: 'workspace-server' }
        },
        agent
    );
    await handle.connection.initialize({ protocolVersion: 2, clientCapabilities: {} });

    await assert.rejects(
        handle.connection.newSession({ cwd: '/workspace', mcpServers: [] }),
        /mcp\.acp|Client-hosted MCP/i
    );
    await handle.close();
});

test('ACP v2 connection supports protocol-driven authentication', async () => {
    let loginMethodId = '';
    const agent = acpV2
        .agent({ name: 'auth-agent' })
        .onRequest(acpV2.methods.agent.initialize, () => ({
            protocolVersion: 2,
            info: { name: 'auth-agent', version: '1.0.0' },
            capabilities: { session: {} },
            authMethods: [{ type: 'agent', methodId: 'agent-login', name: 'Agent login' }]
        }))
        .onRequest(acpV2.methods.agent.auth.login, (context) => {
            loginMethodId = context.params.methodId;
            return {};
        });
    const handle = createV2ConnectionHandle(
        profile,
        {
            sessionUpdate: async () => undefined,
            requestPermission: async () => ({ outcome: { outcome: 'cancelled' } })
        },
        agent
    );

    await handle.connection.initialize({ protocolVersion: 2, clientCapabilities: {} });
    await handle.connection.authenticate({ methodId: 'agent-login' });

    assert.equal(loginMethodId, 'agent-login');
    await handle.close();
});

test('ACP v2 message metadata patches preserve existing content and plan cancellation', async () => {
    const updates: any[] = [];
    const agent = acpV2
        .agent({ name: 'patch-agent' })
        .onRequest(acpV2.methods.agent.initialize, () => ({
            protocolVersion: 2,
            info: { name: 'patch-agent', version: '1.0.0' },
            capabilities: { session: {} }
        }))
        .onRequest(acpV2.methods.agent.session.new, () => ({ sessionId: 'patch-session' }))
        .onRequest(acpV2.methods.agent.session.prompt, async (context) => {
            await context.client.notify(acpV2.methods.client.session.update, {
                sessionId: 'patch-session',
                update: {
                    sessionUpdate: 'agent_message_chunk',
                    messageId: 'message-1',
                    content: { type: 'text', text: 'keep me' }
                }
            });
            await context.client.notify(acpV2.methods.client.session.update, {
                sessionId: 'patch-session',
                update: { sessionUpdate: 'agent_message', messageId: 'message-1', _meta: { final: true } }
            });
            await context.client.notify(acpV2.methods.client.session.update, {
                sessionId: 'patch-session',
                update: {
                    sessionUpdate: 'plan_update',
                    plan: {
                        type: 'items',
                        planId: 'plan-1',
                        entries: [{ content: 'Stopped', priority: 'low', status: 'cancelled' }]
                    }
                }
            });
            await context.client.notify(acpV2.methods.client.session.update, {
                sessionId: 'patch-session',
                update: { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' }
            });
            return {};
        })
        .onNotification(acpV2.methods.agent.session.cancel, () => undefined);
    const handle = createV2ConnectionHandle(
        profile,
        {
            sessionUpdate: async (params) => updates.push(params),
            requestPermission: async () => ({ outcome: { outcome: 'cancelled' } })
        },
        agent
    );

    await handle.connection.initialize({ protocolVersion: 2, clientCapabilities: {} });
    await handle.connection.newSession({ cwd: '/workspace', mcpServers: [] });
    await handle.connection.prompt({ sessionId: 'patch-session', prompt: [{ type: 'text', text: 'go' }] });

    assert.equal(updates.length, 2);
    assert.equal(updates[0].update.content.text, 'keep me');
    assert.equal(updates[1].update.entries[0].status, 'cancelled');
    await handle.close();
});

test('ACP v2 connection maps tool content, terminal output, and plan removal', async () => {
    const updates: any[] = [];
    const agent = acpV2
        .agent({ name: 'update-agent' })
        .onRequest(acpV2.methods.agent.initialize, () => ({
            protocolVersion: 2,
            info: { name: 'update-agent', version: '1.0.0' },
            capabilities: { session: {} }
        }))
        .onRequest(acpV2.methods.agent.session.new, () => ({ sessionId: 'update-session' }))
        .onRequest(acpV2.methods.agent.session.prompt, async (context) => {
            await context.client.notify(acpV2.methods.client.session.update, {
                sessionId: 'update-session',
                update: {
                    sessionUpdate: 'tool_call_content_chunk',
                    toolCallId: 'tool-1',
                    content: { type: 'content', content: { type: 'text', text: 'tool output' } }
                }
            });
            await context.client.notify(acpV2.methods.client.session.update, {
                sessionId: 'update-session',
                update: {
                    sessionUpdate: 'terminal_update',
                    terminalId: 'terminal-1',
                    command: 'npm test',
                    cwd: '/workspace'
                }
            });
            await context.client.notify(acpV2.methods.client.session.update, {
                sessionId: 'update-session',
                update: {
                    sessionUpdate: 'terminal_output_chunk',
                    terminalId: 'terminal-1',
                    data: Buffer.from('passed').toString('base64')
                }
            });
            await context.client.notify(acpV2.methods.client.session.update, {
                sessionId: 'update-session',
                update: { sessionUpdate: 'plan_removed', planId: 'plan-1' }
            });
            await context.client.notify(acpV2.methods.client.session.update, {
                sessionId: 'update-session',
                update: { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' }
            });
            return {};
        })
        .onNotification(acpV2.methods.agent.session.cancel, () => undefined);
    const handle = createV2ConnectionHandle(
        profile,
        {
            sessionUpdate: async (params) => updates.push(params),
            requestPermission: async () => ({ outcome: { outcome: 'cancelled' } })
        },
        agent
    );

    await handle.connection.initialize({ protocolVersion: 2, clientCapabilities: {} });
    await handle.connection.newSession({ cwd: '/workspace', mcpServers: [] });
    await handle.connection.prompt({ sessionId: 'update-session', prompt: [{ type: 'text', text: 'go' }] });

    assert.equal(updates[0].update.toolCallId, 'tool-1');
    assert.equal(updates[0].update.rawOutput[0].content.text, 'tool output');
    assert.equal(updates[2].update.toolCallId, 'terminal:terminal-1');
    assert.equal(updates[2].update.rawOutput, 'passed');
    assert.deepEqual(updates[3].update.entries, []);
    await handle.close();
});

test('default connection factory runs ACP v2 over stdio', async () => {
    const stdioProfile = AcpAgentProfileSchema.parse({
        id: '22222222-2222-4222-8222-222222222222',
        name: 'V2 stdio Agent',
        protocolVersion: 2,
        transport: {
            type: 'stdio',
            command: process.execPath,
            args: [path.resolve('node_modules/@agentclientprotocol/sdk/dist/examples/dual-version-agent.js')]
        },
        execution: {
            location: 'agent',
            workspace: {
                strategy: 'fixed',
                path: process.cwd(),
                platform: process.platform === 'win32' ? 'windows' : 'posix'
            }
        }
    });
    const updates: unknown[] = [];
    const handle = await createDefaultAcpConnectionFactory()(
        stdioProfile,
        {
            sessionUpdate: async (params) => updates.push(params),
            requestPermission: async () => ({ outcome: { outcome: 'cancelled' } })
        },
        process.cwd()
    );

    try {
        const initialized = await handle.connection.initialize({
            protocolVersion: 2,
            clientCapabilities: {},
            clientInfo: { name: 'OpenDesk', version: '0.3.4' }
        });
        const session = await handle.connection.newSession({ cwd: process.cwd(), mcpServers: [] });
        const result = await handle.connection.prompt({
            sessionId: session.sessionId,
            prompt: [{ type: 'text', text: 'hello' }]
        });

        assert.equal(initialized.protocolVersion, 2);
        assert.equal(result.stopReason, 'end_turn');
        assert.equal((updates.at(-1) as any).update._meta['opendesk/replace'], true);
    } finally {
        await handle.close();
    }
});
