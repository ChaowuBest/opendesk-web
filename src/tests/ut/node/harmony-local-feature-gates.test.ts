import test from 'node:test';
import assert from 'node:assert/strict';
import { scanSupportedShells } from '../../../main/applications/terminal/scan.js';
import { getMcpServerLocalRuntimeAvailability } from '../../../main/applications/mcpmgr/worker.js';
import type { HarmonyLocalRuntimeState } from '../../../platforms/bridges/harmonyos/local-runtime.js';

const TABLET_STATE: HarmonyLocalRuntimeState = {
    variant: 'tablet',
    capabilities: { zsh: false, bash: false, node: false, python: false, uv: false },
    commands: {},
    missing: ['zsh', 'bash', 'node', 'python', 'uv'],
    status: 'tablet-disabled'
};

const INCOMPLETE_PC_STATE: HarmonyLocalRuntimeState = {
    variant: 'pc',
    capabilities: { zsh: false, bash: true, node: true, python: false, uv: false },
    commands: {
        bash: '/data/service/hnp/bin/bash',
        node: '/data/service/hnp/bin/node'
    },
    missing: ['python', 'uv'],
    status: 'incomplete'
};

const SHELL_MISSING_PC_STATE: HarmonyLocalRuntimeState = {
    variant: 'pc',
    capabilities: { zsh: false, bash: false, node: true, python: false, uv: false },
    commands: { node: '/data/service/hnp/bin/node' },
    missing: ['zsh', 'bash', 'python', 'uv'],
    status: 'incomplete'
};

const ZSH_PC_STATE: HarmonyLocalRuntimeState = {
    variant: 'pc',
    capabilities: { zsh: true, bash: true, node: false, python: false, uv: false },
    commands: {
        zsh: '/usr/bin/zsh',
        bash: '/data/service/hnp/bin/bash'
    },
    missing: ['node', 'python', 'uv'],
    status: 'incomplete'
};

test('terminal inventory includes verified Harmony PC shells and keeps the tablet gate', () => {
    assert.deepEqual(scanSupportedShells('openharmony', TABLET_STATE), []);
    assert.deepEqual(scanSupportedShells('openharmony', SHELL_MISSING_PC_STATE), []);
    assert.deepEqual(scanSupportedShells('openharmony', INCOMPLETE_PC_STATE), [
        {
            kind: 'bash',
            path: '/data/service/hnp/bin/bash',
            sandboxed: false
        }
    ]);
    assert.deepEqual(scanSupportedShells('openharmony', ZSH_PC_STATE), [
        {
            kind: 'zsh',
            path: '/usr/bin/zsh',
            sandboxed: false
        },
        { kind: 'bash', path: '/data/service/hnp/bin/bash', sandboxed: false }
    ]);
});

test('tablet rejects stdio MCP before transport creation while remote MCP remains available', () => {
    assert.deepEqual(
        getMcpServerLocalRuntimeAvailability(
            {
                id: 'local',
                name: 'local',
                transport: 'stdio',
                enabled: true,
                command: 'npx'
            },
            TABLET_STATE
        ),
        {
            available: false,
            reason: 'tablet-local-runtime-disabled',
            missing: []
        }
    );
    assert.equal(
        getMcpServerLocalRuntimeAvailability(
            {
                id: 'remote',
                name: 'remote',
                transport: 'streamableHttp',
                enabled: true,
                url: 'https://example.com/mcp'
            },
            TABLET_STATE
        ).available,
        true
    );
});

test('MCP worker exposes tablet stdio as unavailable without starting a transport', async () => {
    const worker = new (await import('../../../main/applications/mcpmgr/worker.js')).default(
        'mcpmgr',
        '/tmp/opendesk-mcpmgr-tablet-test',
        TABLET_STATE
    );

    await worker.applicationConfigChanged({
        servers: [
            {
                id: 'local',
                name: 'local',
                transport: 'stdio',
                enabled: true,
                command: 'definitely-not-a-command'
            }
        ]
    });

    const servers = (await worker.getServers()) as Array<{ status: string; error?: string }>;
    assert.equal(servers[0].status, 'error');
    assert.match(servers[0].error || '', /tablet version|平板版本/i);
});

test('PC rejects a known HNP launcher only when its capability is missing', () => {
    assert.equal(
        getMcpServerLocalRuntimeAvailability(
            {
                id: 'node',
                name: 'node',
                transport: 'stdio',
                enabled: true,
                command: 'npx'
            },
            INCOMPLETE_PC_STATE
        ).available,
        true
    );
    assert.deepEqual(
        getMcpServerLocalRuntimeAvailability(
            {
                id: 'python',
                name: 'python',
                transport: 'stdio',
                enabled: true,
                command: 'python3'
            },
            INCOMPLETE_PC_STATE
        ),
        {
            available: false,
            reason: 'pc-local-runtime-missing',
            missing: ['python']
        }
    );
});
