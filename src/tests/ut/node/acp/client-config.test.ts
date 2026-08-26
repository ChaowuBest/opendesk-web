import test from 'node:test';
import assert from 'node:assert/strict';
import {
    AcpAgentProfileSchema,
    AcpMgrConfigSchema,
    createSafeAcpProfileSnapshot,
    resolveAcpTemplateRecord
} from '../../../../main/applications/acpmgr/common.js';

const profileId = '11111111-1111-4111-8111-111111111111';

test('ACP agent profile schema supports stdio and Streamable HTTP transports', () => {
    const stdio = AcpAgentProfileSchema.parse({
        id: profileId,
        name: 'Codex',
        transport: {
            type: 'stdio',
            command: 'codex',
            args: ['acp'],
            env: { API_KEY: '${env:CODEX_API_KEY}' }
        }
    });
    const http = AcpAgentProfileSchema.parse({
        id: '22222222-2222-4222-8222-222222222222',
        name: 'Remote Agent',
        transport: {
            type: 'streamableHttp',
            url: 'https://agents.example.com/acp',
            headers: { Authorization: 'Bearer ${env:REMOTE_TOKEN}' }
        }
    });

    assert.equal(stdio.enabled, true);
    assert.equal(stdio.protocolVersion, 1);
    assert.equal(stdio.dispatchable, false);
    assert.equal(stdio.transport.cwd, 'workspace');
    assert.deepEqual(stdio.execution, {
        location: 'client',
        workspace: { strategy: 'task' },
        compatibility: 'preferred'
    });
    assert.deepEqual(stdio.reconnect, {
        enabled: true,
        maxAttempts: 3,
        initialDelayMs: 500,
        maxDelayMs: 5000
    });
    assert.deepEqual(stdio.timeouts, { connectMs: 30_000, promptMs: 1_800_000 });
    assert.equal(http.transport.type, 'streamableHttp');
    assert.equal(http.transport.cookies, 'include');
    assert.deepEqual(http.execution, {
        location: 'agent',
        workspace: { strategy: 'legacy' }
    });
});

test('ACP agent profiles accept an explicit experimental v2 protocol version', () => {
    const parsed = AcpAgentProfileSchema.parse({
        id: profileId,
        name: 'ACP v2 Agent',
        protocolVersion: 2,
        transport: { type: 'stdio', command: 'agent' },
        execution: {
            location: 'client',
            workspace: { strategy: 'task' },
            compatibility: 'required'
        }
    });

    assert.equal(parsed.protocolVersion, 2);
    assert.equal(parsed.transport.type, 'stdio');
    assert.equal(parsed.execution.location, 'client');
    assert.equal('agentSessionCwd' in parsed.execution, false);
});

test('ACP profiles persist protocol authentication and bounded timeouts', () => {
    const parsed = AcpAgentProfileSchema.parse({
        id: profileId,
        name: 'Authenticated Agent',
        transport: { type: 'stdio', command: 'agent' },
        session: { authMethodId: 'agent-login' },
        timeouts: { connectMs: 12_000, promptMs: 240_000 }
    });

    assert.equal(parsed.session.authMethodId, 'agent-login');
    assert.deepEqual(parsed.timeouts, { connectMs: 12_000, promptMs: 240_000 });
    assert.throws(
        () =>
            AcpAgentProfileSchema.parse({
                id: profileId,
                name: 'Invalid timeout',
                transport: { type: 'stdio', command: 'agent' },
                timeouts: { connectMs: 0, promptMs: 240_000 }
            }),
        /greater than|connectMs|timeout/i
    );
});

test('ACP v2 HTTP Client-hosted profiles require an Agent-side session cwd', () => {
    assert.throws(
        () =>
            AcpAgentProfileSchema.parse({
                id: profileId,
                name: 'Broken v2 Client host',
                protocolVersion: 2,
                transport: { type: 'streamableHttp', url: 'https://agents.example.com/acp' },
                execution: { location: 'client', workspace: { strategy: 'task' }, compatibility: 'required' }
            }),
        /session cwd|会话|agentSessionCwd/i
    );
});

test('ACP HTTP profiles model fixed and mapped Agent workspaces explicitly', () => {
    const fixed = AcpAgentProfileSchema.parse({
        id: profileId,
        name: 'Remote Linux Agent',
        transport: { type: 'streamableHttp', url: 'https://agents.example.com/acp' },
        execution: {
            location: 'agent',
            workspace: { strategy: 'fixed', path: '/workspace/project', platform: 'posix' }
        }
    });
    const mapped = AcpAgentProfileSchema.parse({
        id: '22222222-2222-4222-8222-222222222222',
        name: 'Mapped Agent',
        transport: { type: 'streamableHttp', url: 'https://agents.example.com/acp' },
        execution: {
            location: 'agent',
            workspace: {
                strategy: 'mapped',
                localRoot: process.cwd(),
                remoteRoot: '/workspaces',
                platform: 'posix'
            }
        }
    });

    assert.equal(fixed.execution.workspace.strategy, 'fixed');
    assert.equal(mapped.execution.workspace.strategy, 'mapped');
});

test('ACP profile schema migrates legacy MCP ids into Agent-side bindings', () => {
    const parsed = AcpAgentProfileSchema.parse({
        id: profileId,
        name: 'Legacy MCP profile',
        transport: { type: 'stdio', command: 'agent' },
        session: { mcpServerIds: ['filesystem', 'browser'] }
    });

    assert.deepEqual(parsed.session.mcpBindings, [
        { serverId: 'filesystem', location: 'agent' },
        { serverId: 'browser', location: 'agent' }
    ]);
    assert.equal('mcpServerIds' in parsed.session, false);
});

test('ACP settings reject incomplete and unsafe transport configuration', () => {
    assert.throws(
        () =>
            AcpAgentProfileSchema.parse({
                id: profileId,
                name: 'Broken stdio',
                transport: { type: 'stdio', command: '' }
            }),
        /command/
    );
    assert.throws(
        () =>
            AcpAgentProfileSchema.parse({
                id: profileId,
                name: 'Broken HTTP',
                transport: { type: 'streamableHttp', url: 'file:///tmp/agent' }
            }),
        /HTTP/
    );
    assert.throws(
        () =>
            AcpAgentProfileSchema.parse({
                id: profileId,
                name: 'Broken cwd',
                transport: { type: 'stdio', command: 'agent', cwd: 'fixed' }
            }),
        /fixedCwd/
    );
});

test('ACP manager schema keeps an empty profile list as a compatible default', () => {
    assert.deepEqual(AcpMgrConfigSchema.parse({}), { agents: [] });
});

test('ACP transport templates resolve environment values without persisting them in snapshots', () => {
    const profile = AcpAgentProfileSchema.parse({
        id: profileId,
        name: 'Remote Agent',
        transport: {
            type: 'streamableHttp',
            url: 'https://agents.example.com/acp',
            headers: {
                Authorization: 'Bearer ${env:REMOTE_TOKEN}',
                'X-Workspace': '${env:WORKSPACE_ID}'
            }
        }
    });

    assert.deepEqual(
        resolveAcpTemplateRecord(profile.transport.headers, {
            REMOTE_TOKEN: 'secret-token',
            WORKSPACE_ID: 'workspace-1'
        }),
        {
            Authorization: 'Bearer secret-token',
            'X-Workspace': 'workspace-1'
        }
    );
    assert.deepEqual(createSafeAcpProfileSnapshot(profile), {
        id: profileId,
        name: 'Remote Agent',
        protocolVersion: 1,
        execution: {
            location: 'agent',
            workspace: { strategy: 'legacy' }
        },
        transport: {
            type: 'streamableHttp',
            url: 'https://agents.example.com/acp',
            headerNames: ['Authorization', 'X-Workspace'],
            cookies: 'include'
        }
    });
});
