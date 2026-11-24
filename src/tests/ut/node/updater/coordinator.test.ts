import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { UpdateCoordinator } from '../../../../main/updater/coordinator.js';
import { createMobileQuitBarrier } from '../../../../main/applications/mobileaccess/acp/mobile/hosts/electron-lifecycle.js';

function createCoordinator(overrides: Record<string, unknown> = {}) {
    const calls: string[] = [];
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-updater-coordinator-'));
    const installerPath = path.join(root, 'OpenDesk-0.3.7-Setup.exe');
    const coordinator = new UpdateCoordinator({
        currentVersion: '0.3.6',
        stateDirectory: root,
        fetchRelease: async () => ({
            version: '0.3.7',
            installerUrl: 'https://updates.example.test/OpenDesk-0.3.7-Setup.exe',
            installerName: 'OpenDesk-0.3.7-Setup.exe',
            sha256: 'a'.repeat(64)
        }),
        download: async (_release, destination, onProgress) => {
            onProgress(5, 10);
            fs.writeFileSync(destination, 'installer');
        },
        verify: async () => 'a'.repeat(64),
        submitToService: async () => {
            calls.push('service');
            return {
                protocolVersion: 1,
                requestId: '00000000-0000-4000-8000-000000000001',
                status: 'installed',
                code: 'installed',
                targetVersion: '0.3.7',
                installerExitCode: 0,
                updatedAtUtc: new Date().toISOString()
            };
        },
        getActiveTasks: () => [],
        stopActiveTasks: async () => calls.push('stop'),
        flushState: async () => calls.push('flush'),
        prepareWindowsForQuit: async () => {
            calls.push('prepare');
            return true;
        },
        relaunch: () => calls.push('relaunch'),
        quit: () => calls.push('quit'),
        ...overrides
    });
    return { coordinator, calls, root, installerPath };
}

test('check downloads, verifies and automatically submits a newer installer to the service', async (t) => {
    const { coordinator, root, installerPath } = createCoordinator();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const state = await coordinator.checkForUpdates();

    assert.equal(state.status, 'installed');
    assert.equal(state.version, '0.3.7');
    assert.equal(fs.existsSync(installerPath), false);
    assert.equal(fs.existsSync(path.join(root, 'ready.json')), false);
});

test('check does not download again after the update is installed for the next launch', async (t) => {
    let fetchCount = 0;
    const { coordinator, root } = createCoordinator({
        fetchRelease: async () => {
            fetchCount += 1;
            return {
                version: '0.3.7',
                installerUrl: 'https://updates.example.test/OpenDesk-0.3.7-Setup.exe',
                installerName: 'OpenDesk-0.3.7-Setup.exe'
            };
        }
    });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    await coordinator.checkForUpdates();
    const state = await coordinator.checkForUpdates();

    assert.equal(state.status, 'installed');
    assert.equal(fetchCount, 1);
});

test('automatic installation leaves active tasks and the running application untouched', async (t) => {
    const { coordinator, calls, root } = createCoordinator({ getActiveTasks: () => ['task-1'] });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const state = await coordinator.checkForUpdates();

    assert.equal(state.status, 'installed');
    assert.deepEqual(calls, ['service']);
});

test('check treats a prerelease local build as older than the same stable release', async (t) => {
    // 设置界面「检查更新」：本地是 0.3.7-beta.1 这类预发布/开发构建时，
    // 远端 0.3.7 应当算作有新版本，而不是因为本地版本不是正式版就报错
    const { coordinator, calls, root } = createCoordinator({ currentVersion: '0.3.7-beta.1' });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const state = await coordinator.checkForUpdates();

    assert.equal(state.status, 'installed');
    assert.deepEqual(calls, ['service']);
});

test('check reports up to date when the release is not newer than the local version', async (t) => {
    for (const currentVersion of ['0.3.7', '0.3.8']) {
        const { coordinator, calls, root } = createCoordinator({ currentVersion });
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));

        const state = await coordinator.checkForUpdates();

        // 远端落后于本地时不能把降级当成更新
        assert.equal(state.status, 'upToDate', `currentVersion=${currentVersion}`);
        assert.deepEqual(calls, []);
    }
});

test('a service busy response is shown as an error without falling back to the legacy helper', async (t) => {
    const { coordinator, calls, root } = createCoordinator({
        submitToService: async () => ({
            protocolVersion: 1,
            requestId: '00000000-0000-4000-8000-000000000001',
            status: 'busy',
            code: 'install_in_progress',
            updatedAtUtc: new Date().toISOString()
        })
    });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const state = await coordinator.checkForUpdates();

    assert.deepEqual(state, {
        status: 'error',
        code: 'update_service_busy',
        message: 'install_in_progress'
    });
    assert.deepEqual(calls, []);
    assert.equal(fs.existsSync(path.join(root, 'ready.json')), true);
});

test('a package rejection is reported and the rejected pending package is discarded', async (t) => {
    const { coordinator, root, installerPath } = createCoordinator({
        submitToService: async () => ({
            protocolVersion: 1,
            requestId: '00000000-0000-4000-8000-000000000001',
            status: 'rejected',
            code: 'package_not_trusted',
            updatedAtUtc: new Date().toISOString()
        })
    });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const state = await coordinator.checkForUpdates();

    assert.equal(state.status, 'error');
    assert.equal(state.code, 'update_package_rejected');
    assert.equal(fs.existsSync(installerPath), false);
    assert.equal(fs.existsSync(path.join(root, 'ready.json')), false);
});

test('restore makes a pending package available for automatic resubmission', async (t) => {
    const first = createCoordinator({
        submitToService: async () => ({
            protocolVersion: 1,
            requestId: '00000000-0000-4000-8000-000000000001',
            status: 'busy',
            code: 'install_in_progress',
            updatedAtUtc: new Date().toISOString()
        })
    });
    t.after(() => fs.rmSync(first.root, { recursive: true, force: true }));
    await first.coordinator.checkForUpdates();

    const restored = new UpdateCoordinator({
        ...(first.coordinator.dependenciesForTesting as any),
        stateDirectory: first.root,
        submitToService: async () => ({
            protocolVersion: 1,
            requestId: '00000000-0000-4000-8000-000000000001',
            status: 'installed',
            code: 'installed',
            targetVersion: '0.3.7',
            installerExitCode: 0,
            updatedAtUtc: new Date().toISOString()
        })
    });
    const state = await restored.restore();

    assert.equal(state.status, 'ready');
    assert.equal(state.version, '0.3.7');
    assert.equal(await restored.submitPendingUpdate(), true);
    assert.equal(restored.getState().status, 'installed');
});

test('restore discards a ready record whose version is not a valid SemVer', async (t) => {
    const { coordinator, root } = createCoordinator();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const installerPath = path.join(root, 'OpenDesk-0.3.7-Setup.exe');
    fs.writeFileSync(installerPath, 'installer');
    fs.writeFileSync(
        path.join(root, 'ready.json'),
        JSON.stringify({
            requestId: '00000000-0000-4000-8000-000000000002',
            // 版本号写坏：isNewerVersion 对解析不了的版本会退化成「字符串不相等」，
            // 这条记录必须在这里被拦住，否则一个坏版本号就能绕过「必须比本地新」
            version: 'latest',
            installerPath,
            sha256: 'b'.repeat(64)
        })
    );

    const state = await coordinator.restore();

    assert.equal(state.status, 'idle');
    assert.equal(fs.existsSync(path.join(root, 'ready.json')), false);
    assert.equal(fs.existsSync(installerPath), false);
});

test('manual restart stops active work only after installation has completed', async (t) => {
    const { coordinator, calls, root } = createCoordinator({ getActiveTasks: () => ['task-1'] });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    await coordinator.checkForUpdates();

    const result = await coordinator.restartToApplyUpdate();

    assert.equal(result, true);
    assert.deepEqual(calls, ['service', 'stop', 'flush', 'prepare', 'relaunch', 'quit']);
});

test('manual restart stays on the installed state when an editor refuses to close', async (t) => {
    const { coordinator, calls, root } = createCoordinator({
        prepareWindowsForQuit: async () => {
            calls.push('prepare');
            return false;
        }
    });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    await coordinator.checkForUpdates();

    const result = await coordinator.restartToApplyUpdate();

    assert.equal(result, false);
    assert.deepEqual(calls, ['service', 'stop', 'flush', 'prepare']);
    assert.equal(coordinator.getState().status, 'installed');
});

for (const approved of [true, false]) {
    test(`update restart preserves the remote lifecycle when Office approval is ${approved}`, async (t) => {
        const events: string[] = [];
        let releaseClose!: () => void;
        const closed = new Promise<void>((resolve) => {
            releaseClose = resolve;
        });
        t.after(releaseClose);
        const deferQuit = createMobileQuitBarrier(
            async () => {
                events.push('close-remote');
                await closed;
            },
            () => {
                assert.equal(deferQuit(), false);
                events.push('quit');
            }
        );

        const { coordinator, root } = createCoordinator({
            stopActiveTasks: async () => {
                events.push('stop');
            },
            flushState: async () => {
                events.push('flush');
            },
            prepareWindowsForQuit: async () => {
                events.push('confirm');
                return approved;
            },
            relaunch: () => {
                events.push('relaunch');
            },
            quit: () => {
                assert.equal(deferQuit(), true);
            }
        });
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        await coordinator.checkForUpdates();

        assert.equal(await coordinator.restartToApplyUpdate(), approved);
        assert.equal(coordinator.getState().status, approved ? 'restarting' : 'installed');
        assert.deepEqual(
            events,
            approved ? ['stop', 'flush', 'confirm', 'relaunch', 'close-remote'] : ['stop', 'flush', 'confirm']
        );
        releaseClose();
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(
            events,
            approved ? ['stop', 'flush', 'confirm', 'relaunch', 'close-remote', 'quit'] : ['stop', 'flush', 'confirm']
        );
    });
}
