import test from 'node:test';
import assert from 'node:assert/strict';
import { getOpenHarmonyTerminalBashPath } from '../../../main/applications/terminal/app.js';
import { getMcpServerLocalRuntimeAvailability } from '../../../main/applications/mcpmgr/worker.js';
import type { HarmonyLocalRuntimeState } from '../../../platforms/bridges/harmonyos/local-runtime.js';

const TABLET_STATE: HarmonyLocalRuntimeState = {
    variant: 'tablet',
    capabilities: { bash: false, node: false, python: false, uv: false },
    commands: {},
    missing: ['bash', 'node', 'python', 'uv'],
    status: 'tablet-disabled'
};

const INCOMPLETE_PC_STATE: HarmonyLocalRuntimeState = {
    variant: 'pc',
    capabilities: { bash: true, node: true, python: false, uv: false },
    commands: {
        bash: '/data/service/hnp/bin/bash',
        node: '/data/service/hnp/bin/node'
    },
    missing: ['python', 'uv'],
    status: 'incomplete'
};

test('Terminal registers only the verified HNP bash on Harmony PC', () => {
    assert.equal(getOpenHarmonyTerminalBashPath(TABLET_STATE), null);
    assert.equal(getOpenHarmonyTerminalBashPath(INCOMPLETE_PC_STATE), '/data/service/hnp/bin/bash');
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
