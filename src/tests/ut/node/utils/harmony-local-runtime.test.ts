import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createHarmonyLocalRuntimeState,
    getHarmonyLocalRuntimeFeatureAvailability,
    getHarmonyStdioCommandRequirement,
    serializeHarmonyLocalRuntimeState
} from '../../../../main/utils/harmonyLocalRuntime.js';
import { createHarmonyRuntimeEnvironment } from '../../../../main/utils/harmonyRuntime.js';

const PC_RUNTIME = createHarmonyRuntimeEnvironment({
    platform: 'openharmony',
    argv: [
        '--opendesk-build-variant=pc',
        '--opendesk-device-type=2in1',
        '--opendesk-app-data-dir=/data/storage/el2/base/files',
        '--opendesk-temp-dir=/data/storage/el2/base/temp',
        '--opendesk-cache-dir=/data/storage/el2/base/cache',
        '--opendesk-user-home-dir=/storage/Users/currentUser'
    ],
    environment: {}
});

const TABLET_RUNTIME = createHarmonyRuntimeEnvironment({
    platform: 'openharmony',
    argv: [
        '--opendesk-build-variant=tablet',
        '--opendesk-device-type=tablet',
        '--opendesk-app-data-dir=/data/storage/el2/base/files',
        '--opendesk-temp-dir=/data/storage/el2/base/temp',
        '--opendesk-cache-dir=/data/storage/el2/base/cache'
    ],
    environment: {}
});

test('tablet disables all HNP-backed runtimes without probing executables', () => {
    let probeCount = 0;
    const state = createHarmonyLocalRuntimeState(TABLET_RUNTIME, () => {
        probeCount++;
        return '/should/not/be/probed';
    });

    assert.equal(probeCount, 0);
    assert.deepEqual(state, {
        variant: 'tablet',
        capabilities: {
            bash: false,
            node: false,
            python: false,
            uv: false
        },
        commands: {},
        missing: ['bash', 'node', 'python', 'uv'],
        status: 'tablet-disabled'
    });
    assert.deepEqual(getHarmonyLocalRuntimeFeatureAvailability('terminal', state), {
        available: false,
        reason: 'tablet-local-runtime-disabled',
        missing: ['bash']
    });
    assert.deepEqual(getHarmonyLocalRuntimeFeatureAvailability('agentgate', state), {
        available: false,
        reason: 'tablet-local-runtime-disabled',
        missing: ['node']
    });
    assert.deepEqual(getHarmonyLocalRuntimeFeatureAvailability('stdio-mcp', state), {
        available: false,
        reason: 'tablet-local-runtime-disabled',
        missing: []
    });
});

test('PC records verified HNP commands and reports an incomplete installation', () => {
    const commands: Record<string, string> = {
        bash: '/data/service/hnp/bin/bash',
        node: '/data/service/hnp/bin/node'
    };
    const state = createHarmonyLocalRuntimeState(PC_RUNTIME, (command) => commands[command] ?? null);

    assert.deepEqual(state, {
        variant: 'pc',
        capabilities: {
            bash: true,
            node: true,
            python: false,
            uv: false
        },
        commands,
        missing: ['python', 'uv'],
        status: 'incomplete'
    });
    assert.equal(getHarmonyLocalRuntimeFeatureAvailability('terminal', state).available, true);
    assert.equal(getHarmonyLocalRuntimeFeatureAvailability('agentgate', state).available, true);
    assert.deepEqual(getHarmonyLocalRuntimeFeatureAvailability('python', state), {
        available: false,
        reason: 'pc-local-runtime-missing',
        missing: ['python']
    });
    assert.equal(getHarmonyLocalRuntimeFeatureAvailability('stdio-mcp', state).available, true);
});

test('serialized capability snapshot is reconstructed by workers without probing again', () => {
    const state = createHarmonyLocalRuntimeState(PC_RUNTIME, (command) => `/hnp/bin/${command}`);
    const environment = serializeHarmonyLocalRuntimeState(state);
    let probeCount = 0;

    assert.deepEqual(
        createHarmonyLocalRuntimeState(
            PC_RUNTIME,
            () => {
                probeCount++;
                return null;
            },
            environment
        ),
        state
    );
    assert.equal(probeCount, 0);
});

test('stdio command requirements recognize HNP-provided launchers', () => {
    assert.equal(getHarmonyStdioCommandRequirement('node'), 'node');
    assert.equal(getHarmonyStdioCommandRequirement('/data/service/hnp/bin/npx'), 'node');
    assert.equal(getHarmonyStdioCommandRequirement('python3'), 'python');
    assert.equal(getHarmonyStdioCommandRequirement('uvx'), 'uv');
    assert.equal(getHarmonyStdioCommandRequirement('/vendor/bin/custom-mcp'), null);
});

test('non-Harmony runtimes keep local process features unchanged', () => {
    assert.equal(
        createHarmonyLocalRuntimeState(null, () => null),
        null
    );
    assert.deepEqual(getHarmonyLocalRuntimeFeatureAvailability('terminal', null), {
        available: true,
        reason: null,
        missing: []
    });
});
