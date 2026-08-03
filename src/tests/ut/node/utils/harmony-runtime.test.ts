import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createHarmonyRuntimeEnvironment,
    getHarmonyBrowseRoots,
    getHarmonyHomeDirectory,
    getHarmonyWorkspaceDirectory,
    serializeHarmonyRuntimeEnvironment
} from '../../../../main/utils/harmonyRuntime.js';

const PC_ARGS = [
    'electron',
    '--opendesk-build-variant=pc',
    '--opendesk-device-type=2in1',
    '--opendesk-app-data-dir=/data/storage/el2/base/files',
    '--opendesk-temp-dir=/data/storage/el2/base/temp',
    '--opendesk-cache-dir=/data/storage/el2/base/cache',
    '--opendesk-user-home-dir=/storage/Users/currentUser'
];

const TABLET_ARGS = [
    'electron',
    '--opendesk-build-variant=tablet',
    '--opendesk-device-type=tablet',
    '--opendesk-app-data-dir=/data/storage/el2/base/files',
    '--opendesk-temp-dir=/data/storage/el2/base/temp',
    '--opendesk-cache-dir=/data/storage/el2/base/cache'
];

test('PC runtime keeps sandbox paths separate from the optional user home', () => {
    const runtime = createHarmonyRuntimeEnvironment({
        platform: 'openharmony',
        argv: PC_ARGS,
        environment: {}
    });

    assert.deepEqual(runtime, {
        variant: 'pc',
        deviceType: '2in1',
        appDataDir: '/data/storage/el2/base/files',
        tempDir: '/data/storage/el2/base/temp',
        cacheDir: '/data/storage/el2/base/cache',
        userHomeDir: '/storage/Users/currentUser'
    });
    assert.equal(getHarmonyHomeDirectory(runtime), '/storage/Users/currentUser');
    assert.equal(getHarmonyWorkspaceDirectory(runtime), '/storage/Users/currentUser/Documents/OpenDesk');
    assert.deepEqual(getHarmonyBrowseRoots(runtime), [
        { kind: 'userHome', path: '/storage/Users/currentUser' },
        { kind: 'appSandbox', path: '/data/storage/el2/base/files' }
    ]);
});

test('tablet runtime exposes only sandbox-backed writable locations', () => {
    const runtime = createHarmonyRuntimeEnvironment({
        platform: 'openharmony',
        argv: TABLET_ARGS,
        environment: {}
    });

    assert.deepEqual(runtime, {
        variant: 'tablet',
        deviceType: 'tablet',
        appDataDir: '/data/storage/el2/base/files',
        tempDir: '/data/storage/el2/base/temp',
        cacheDir: '/data/storage/el2/base/cache'
    });
    assert.equal(getHarmonyHomeDirectory(runtime), '/data/storage/el2/base/files');
    assert.equal(getHarmonyWorkspaceDirectory(runtime), '/data/storage/el2/base/files/workspace');
    assert.deepEqual(getHarmonyBrowseRoots(runtime), [{ kind: 'appSandbox', path: '/data/storage/el2/base/files' }]);
});

test('serialized runtime can be reconstructed by an Electron worker', () => {
    const mainRuntime = createHarmonyRuntimeEnvironment({
        platform: 'openharmony',
        argv: TABLET_ARGS,
        environment: {}
    });
    const workerEnvironment = serializeHarmonyRuntimeEnvironment(mainRuntime);

    assert.equal(workerEnvironment.USER_DATA_PATH, '/data/storage/el2/base/files');
    assert.equal(workerEnvironment.HOME, '/data/storage/el2/base/files');
    assert.equal(workerEnvironment.TMPDIR, '/data/storage/el2/base/temp');
    assert.equal(workerEnvironment.XDG_CACHE_HOME, '/data/storage/el2/base/cache');

    assert.deepEqual(
        createHarmonyRuntimeEnvironment({
            platform: 'openharmony',
            argv: ['worker.js'],
            environment: workerEnvironment
        }),
        mainRuntime
    );
});

test('Harmony runtime rejects incomplete or contradictory path contexts', () => {
    assert.throws(
        () =>
            createHarmonyRuntimeEnvironment({
                platform: 'openharmony',
                argv: PC_ARGS.filter((arg) => !arg.startsWith('--opendesk-cache-dir=')),
                environment: {}
            }),
        /opendesk-cache-dir/
    );
    assert.throws(
        () =>
            createHarmonyRuntimeEnvironment({
                platform: 'openharmony',
                argv: [...TABLET_ARGS, '--opendesk-user-home-dir=/storage/Users/currentUser'],
                environment: {}
            }),
        /tablet.*user home/i
    );
});

test('non-Harmony runtimes do not synthesize a Harmony path context', () => {
    assert.equal(
        createHarmonyRuntimeEnvironment({
            platform: 'linux',
            argv: ['node', 'cli.js'],
            environment: {}
        }),
        null
    );
});
