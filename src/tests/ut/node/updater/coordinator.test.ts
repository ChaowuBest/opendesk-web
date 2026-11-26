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
        stopActiveTasks: async () => {
            calls.push('stop');
        },
        flushState: async () => {
            calls.push('flush');
        },
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

// macOS 一期手动安装模式：下载校验完成后停在 ready，等用户自己挂载 DMG 安装
const darwinRelease = {
    version: '0.3.7',
    installerUrl: 'https://updates.example.test/opendesk-darwin-arm64-0.3.7.dmg',
    installerName: 'opendesk-darwin-arm64-0.3.7.dmg',
    sha256: 'a'.repeat(64)
};

function createManualInstallCoordinator(overrides: Record<string, unknown> = {}) {
    return createCoordinator({
        manualInstall: true,
        installerExtension: '.dmg',
        fetchRelease: async () => darwinRelease,
        ...overrides
    });
}

test('manual install mode keeps a verified dmg package ready without contacting the service', async (t) => {
    const { coordinator, calls, root } = createManualInstallCoordinator();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const installerPath = path.join(root, darwinRelease.installerName);

    const state = await coordinator.checkForUpdates();

    assert.equal(state.status, 'ready');
    assert.equal(state.version, '0.3.7');
    // 不能碰 Windows 系统服务链路（含 stop/flush/prepare/relaunch/quit）
    assert.deepEqual(calls, []);
    // 安装包与 ready.json 都必须保留，交给用户手动挂载 DMG
    assert.equal(fs.existsSync(installerPath), true);
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'ready.json'), 'utf8'));
    assert.equal(saved.installerPath, installerPath);
    assert.equal(saved.sha256, 'a'.repeat(64));
});

test('manual install mode rejects a release whose installer is not a dmg', async (t) => {
    const { coordinator, calls, root } = createManualInstallCoordinator({
        // 保留默认工厂里的 Windows 安装包，macOS 配置必须拦下它
        fetchRelease: async () => ({
            version: '0.3.7',
            installerUrl: 'https://updates.example.test/OpenDesk-0.3.7-Setup.exe',
            installerName: 'OpenDesk-0.3.7-Setup.exe'
        })
    });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const state = await coordinator.checkForUpdates();

    assert.equal(state.status, 'error');
    assert.equal(state.code, 'update_check_failed');
    assert.equal(state.message, 'Release contains an invalid installer filename');
    assert.deepEqual(calls, []);
});

test('manual install mode rechecks without resubmitting or redownloading while the package is pending', async (t) => {
    let fetchCount = 0;
    const { coordinator, calls, root } = createManualInstallCoordinator({
        fetchRelease: async () => {
            fetchCount += 1;
            return darwinRelease;
        }
    });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    await coordinator.checkForUpdates();
    const state = await coordinator.checkForUpdates();

    assert.equal(state.status, 'ready');
    assert.equal(fetchCount, 1);
    assert.deepEqual(calls, []);
});

test('manual install mode restores a pending dmg package and never submits it to the service', async (t) => {
    const first = createManualInstallCoordinator();
    t.after(() => fs.rmSync(first.root, { recursive: true, force: true }));
    await first.coordinator.checkForUpdates();

    const restored = new UpdateCoordinator({
        ...(first.coordinator.dependenciesForTesting as any),
        stateDirectory: first.root
    });
    const state = await restored.restore();

    assert.equal(state.status, 'ready');
    assert.equal(state.version, '0.3.7');
    // 手动安装模式下协调器不可能经系统服务走到 installed
    assert.equal(await restored.submitPendingUpdate(), false);
    assert.equal(restored.getState().status, 'ready');
    assert.equal(fs.existsSync(path.join(first.root, darwinRelease.installerName)), true);
});

test('restore discards a pending record whose installer extension does not match the platform', async (t) => {
    const { coordinator, root } = createManualInstallCoordinator();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const installerPath = path.join(root, 'OpenDesk-0.3.7-Setup.exe');
    fs.writeFileSync(installerPath, 'installer');
    fs.writeFileSync(
        path.join(root, 'ready.json'),
        JSON.stringify({
            requestId: '00000000-0000-4000-8000-000000000003',
            version: '0.3.7',
            // Windows 的 exe 记录在 macOS 配置下必须被拦下，避免恢复出错误平台的包
            installerPath,
            sha256: 'b'.repeat(64)
        })
    );

    const state = await coordinator.restore();

    assert.equal(state.status, 'idle');
    assert.equal(fs.existsSync(path.join(root, 'ready.json')), false);
    assert.equal(fs.existsSync(installerPath), false);
});

// macOS 二期自动安装：ready 后由用户触发的本地安装（挂载 DMG 替换 .app），
// 成功后与 Windows 一样进入 installed，再由 restartToApplyUpdate 完成重启
test('manual install mode applies the pending dmg on demand and completes the restart flow', async (t) => {
    const installedRecords: unknown[] = [];
    const { coordinator, calls, root } = createManualInstallCoordinator({
        installManually: async (record) => {
            calls.push('install');
            installedRecords.push(record);
        }
    });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    await coordinator.checkForUpdates();
    assert.equal(await coordinator.applyManualUpdate(), true);

    assert.equal(coordinator.getState().status, 'installed');
    assert.equal(coordinator.getState().version, '0.3.7');
    assert.equal(
        (installedRecords[0] as { installerPath: string }).installerPath,
        path.join(root, darwinRelease.installerName)
    );
    // 安装成功后安装包与 ready 记录清理，与 Windows 服务安装成功后的行为一致
    assert.equal(fs.existsSync(path.join(root, darwinRelease.installerName)), false);
    assert.equal(fs.existsSync(path.join(root, 'ready.json')), false);

    assert.equal(await coordinator.restartToApplyUpdate(), true);
    assert.deepEqual(calls, ['install', 'stop', 'flush', 'prepare', 'relaunch', 'quit']);
});

test('manual install keeps the dmg for a retry when the local installation fails', async (t) => {
    const { coordinator, calls, root } = createManualInstallCoordinator({
        installManually: async () => {
            calls.push('install');
            throw new Error('ditto exited with failure');
        }
    });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    await coordinator.checkForUpdates();

    assert.equal(await coordinator.applyManualUpdate(), false);
    const state = coordinator.getState();
    assert.equal(state.status, 'error');
    assert.equal(state.code, 'update_install_failed');
    // 安装包与 ready 记录保留，重试不需要重新下载
    assert.equal(fs.existsSync(path.join(root, darwinRelease.installerName)), true);
    assert.equal(fs.existsSync(path.join(root, 'ready.json')), true);

    // 安装失败后的重试回到 ready，等用户再次触发安装
    assert.equal((await coordinator.checkForUpdates()).status, 'ready');
    assert.equal(await coordinator.applyManualUpdate(), false);
    assert.equal(coordinator.getState().status, 'error');
});

test('manual apply is rejected outside the ready state or the manual install mode', async (t) => {
    const { coordinator, root } = createCoordinator();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    // Windows 自动安装模式没有本地安装入口
    assert.equal(await coordinator.applyManualUpdate(), false);

    // ready 之前（idle/checking）不允许触发安装
    const manual = createManualInstallCoordinator({
        installManually: async () => undefined
    });
    t.after(() => fs.rmSync(manual.root, { recursive: true, force: true }));
    assert.equal(await manual.coordinator.applyManualUpdate(), false);
    assert.equal(manual.coordinator.getState().status, 'idle');
});
