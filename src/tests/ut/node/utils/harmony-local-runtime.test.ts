import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHarmonyRuntimeEnvironment } from '../../../../platforms/bridges/harmonyos/runtime-environment.js';

// ── openharmony 运行时注入（文件级，必须先于 local-runtime 的动态 import） ───
//
// local-runtime 的依赖链（logger → setting → runtime）在模块加载期就会触发
// getHarmonyRuntimeEnvironment() 的进程内单例初始化，且单例一经固化不可重置；
// 因此必须先注入平台与构建元数据，再动态 import 被测模块，单例才会固化为 PC。
// appDataDir 指向临时目录：加载期 mkdir、日志文件等都落在这里，结束后统一清理。
const runtimeSandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-harmony-runtime-'));
Object.defineProperty(process, 'platform', { value: 'openharmony', configurable: true });
process.argv = [
    ...process.argv,
    '--opendesk-build-variant=pc',
    '--opendesk-device-type=2in1',
    `--opendesk-app-data-dir=${runtimeSandboxDir}`,
    `--opendesk-temp-dir=${runtimeSandboxDir}`,
    `--opendesk-cache-dir=${runtimeSandboxDir}`,
    '--opendesk-user-home-dir=/storage/Users/currentUser'
];

const {
    createHarmonyLocalRuntimeState,
    getHarmonyLocalRuntimeFeatureAvailability,
    getHarmonyLocalRuntimeState,
    getHarmonyStdioCommandRequirement,
    serializeHarmonyLocalRuntimeState
} = await import('../../../../platforms/bridges/harmonyos/local-runtime.js');

after(() => {
    fs.rmSync(runtimeSandboxDir, { recursive: true, force: true });
});

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
            zsh: false,
            bash: false,
            node: false,
            python: false,
            uv: false
        },
        commands: {},
        missing: ['zsh', 'bash', 'node', 'python', 'uv'],
        status: 'tablet-disabled'
    });
    assert.deepEqual(getHarmonyLocalRuntimeFeatureAvailability('terminal', state), {
        available: false,
        reason: 'tablet-local-runtime-disabled',
        missing: ['zsh', 'bash']
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
        zsh: '/usr/bin/zsh',
        bash: '/data/service/hnp/bin/bash',
        node: '/data/service/hnp/bin/node'
    };
    const state = createHarmonyLocalRuntimeState(PC_RUNTIME, (command) => commands[command] ?? null);

    assert.deepEqual(state, {
        variant: 'pc',
        capabilities: {
            zsh: true,
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

test('PC reports a complete runtime when only zsh is missing and bash is installed', () => {
    const commands: Record<string, string> = {
        bash: '/data/service/hnp/bin/bash',
        node: '/data/service/hnp/bin/node',
        python: '/data/service/hnp/bin/python3',
        uv: '/data/service/hnp/bin/uv'
    };
    const state = createHarmonyLocalRuntimeState(PC_RUNTIME, (command) => commands[command] ?? null);

    assert.deepEqual(state.missing, []);
    assert.equal(state.status, 'available');
    assert.equal(getHarmonyLocalRuntimeFeatureAvailability('terminal', state).available, true);
});

test('PC reports both shells missing only when zsh and bash are both absent', () => {
    const state = createHarmonyLocalRuntimeState(PC_RUNTIME, (command) =>
        command === 'node' ? '/data/service/hnp/bin/node' : null
    );

    assert.deepEqual(state.missing, ['zsh', 'bash', 'python', 'uv']);
    assert.equal(state.status, 'incomplete');
    assert.deepEqual(getHarmonyLocalRuntimeFeatureAvailability('terminal', state), {
        available: false,
        reason: 'pc-local-runtime-missing',
        missing: ['zsh', 'bash']
    });
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

function restoreHarmonyRuntimeEnvironment(
    originalRevision: string | undefined,
    originalState: string | undefined
): void {
    if (originalRevision === undefined) {
        delete process.env.OPENDESK_HARMONY_DEV_ENV_REVISION;
    } else {
        process.env.OPENDESK_HARMONY_DEV_ENV_REVISION = originalRevision;
    }
    if (originalState === undefined) {
        delete process.env.OPENDESK_HARMONY_LOCAL_RUNTIME_STATE;
    } else {
        process.env.OPENDESK_HARMONY_LOCAL_RUNTIME_STATE = originalState;
    }
}

test('same revision reuses cached state', () => {
    const originalRevision = process.env.OPENDESK_HARMONY_DEV_ENV_REVISION;
    const originalState = process.env.OPENDESK_HARMONY_LOCAL_RUNTIME_STATE;
    try {
        delete process.env.OPENDESK_HARMONY_DEV_ENV_REVISION;
        delete process.env.OPENDESK_HARMONY_LOCAL_RUNTIME_STATE;

        const first = getHarmonyLocalRuntimeState();
        assert.ok(first);
        assert.equal(first.variant, 'pc');
        assert.equal(getHarmonyLocalRuntimeState(), first);
    } finally {
        restoreHarmonyRuntimeEnvironment(originalRevision, originalState);
    }
});

test('revision bump rebuilds cached state', () => {
    const originalRevision = process.env.OPENDESK_HARMONY_DEV_ENV_REVISION;
    const originalState = process.env.OPENDESK_HARMONY_LOCAL_RUNTIME_STATE;
    try {
        delete process.env.OPENDESK_HARMONY_DEV_ENV_REVISION;
        delete process.env.OPENDESK_HARMONY_LOCAL_RUNTIME_STATE;

        const first = getHarmonyLocalRuntimeState();
        assert.ok(first);

        process.env.OPENDESK_HARMONY_DEV_ENV_REVISION = '1';
        const rebuilt = getHarmonyLocalRuntimeState();

        assert.notEqual(rebuilt, first);
        assert.deepEqual(rebuilt, first);
    } finally {
        restoreHarmonyRuntimeEnvironment(originalRevision, originalState);
    }
});
