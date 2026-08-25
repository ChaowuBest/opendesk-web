import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { AcpAgentProfileSchema } from '../../../../main/applications/acpmgr/common.js';
import {
    createAcpExecutionFingerprint,
    resolveAcpWorkspace
} from '../../../../main/applications/acpmgr/runtime/workspace.js';

const profileId = '11111111-1111-4111-8111-111111111111';

function httpProfile(execution: unknown) {
    return AcpAgentProfileSchema.parse({
        id: profileId,
        name: 'Remote Agent',
        transport: { type: 'streamableHttp', url: 'https://agent.example.com/acp' },
        execution
    });
}

test('ACP workspace resolver uses a fixed Agent-host path without leaking the local task path', () => {
    const profile = httpProfile({
        location: 'agent',
        workspace: { strategy: 'fixed', path: '/workspace/project', platform: 'posix' }
    });

    assert.deepEqual(resolveAcpWorkspace(profile, 'D:\\private\\project'), {
        executionLocation: 'agent',
        sessionCwd: '/workspace/project',
        localWorkspace: 'D:\\private\\project',
        remoteWorkspace: '/workspace/project',
        legacy: false
    });
});

test('ACP workspace resolver maps a task path below the configured local root', () => {
    const localRoot = path.resolve('fixtures', 'repos');
    const taskWorkspace = path.join(localRoot, 'team', 'project');
    const profile = httpProfile({
        location: 'agent',
        workspace: { strategy: 'mapped', localRoot, remoteRoot: '/workspaces', platform: 'posix' }
    });

    assert.equal(resolveAcpWorkspace(profile, taskWorkspace).sessionCwd, '/workspaces/team/project');
    assert.throws(() => resolveAcpWorkspace(profile, path.resolve('outside')), /outside|映射|mapping/i);
});

test('ACP workspace resolver keeps Client-hosted execution in the local task workspace', () => {
    const localWorkspace = path.resolve('fixtures', 'project');
    const profile = httpProfile({
        location: 'client',
        workspace: { strategy: 'task' },
        compatibility: 'required'
    });
    const resolved = resolveAcpWorkspace(profile, localWorkspace);

    assert.equal(resolved.executionLocation, 'client');
    assert.equal(resolved.sessionCwd, localWorkspace);
    assert.equal(resolved.remoteWorkspace, undefined);
});

test('ACP v2 Client-hosted execution separates Agent cwd from the local MCP workspace', () => {
    const localWorkspace = path.resolve('fixtures', 'project');
    const profile = httpProfile({
        location: 'client',
        workspace: { strategy: 'task' },
        compatibility: 'required',
        agentSessionCwd: { path: '/srv/agent-session', platform: 'posix' }
    });
    const resolved = resolveAcpWorkspace(
        AcpAgentProfileSchema.parse({ ...profile, protocolVersion: 2 }),
        localWorkspace
    );

    assert.equal(resolved.sessionCwd, '/srv/agent-session');
    assert.equal(resolved.clientWorkspace, localWorkspace);
});

test('ACP execution fingerprints change with workspace placement and MCP bindings', () => {
    const profile = httpProfile({
        location: 'agent',
        workspace: { strategy: 'fixed', path: '/workspace/project', platform: 'posix' }
    });
    const workspace = resolveAcpWorkspace(profile, path.resolve('project'));
    const first = createAcpExecutionFingerprint(profile, workspace);
    const nextProfile = AcpAgentProfileSchema.parse({
        ...profile,
        session: { ...profile.session, mcpBindings: [{ serverId: 'github', location: 'agent' }] }
    });

    assert.notEqual(first, createAcpExecutionFingerprint(nextProfile, workspace));
});
