import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { UpdateCoordinator } from '../../../../main/updater/coordinator.js';

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
