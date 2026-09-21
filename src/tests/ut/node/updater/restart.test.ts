import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveUpdateRelaunchCommand, resolveUpdateRelaunchPath } from '../../../../main/updater/restart.js';

test('resolveUpdateRelaunchPath prefers the stable launcher above an app-version directory', () => {
    const stableLauncher = 'C:\\Program Files\\opendesk\\opendesk.exe';
    const versionedExecutable = 'C:\\Program Files\\opendesk\\app-0.3.6\\opendesk.exe';

    assert.equal(
        resolveUpdateRelaunchPath(versionedExecutable, (candidate) => candidate === stableLauncher),
        stableLauncher
    );
    assert.equal(
        resolveUpdateRelaunchPath(versionedExecutable, () => false),
        versionedExecutable
    );
});

test('resolveUpdateRelaunchCommand waits for the old process without forwarding stale Electron arguments', () => {
    const stableLauncher = 'C:\\Program Files\\opendesk\\opendesk.exe';
    const versionedExecutable = 'C:\\Program Files\\opendesk\\app-0.3.7\\opendesk.exe';

    assert.deepEqual(
        resolveUpdateRelaunchCommand(versionedExecutable, 4321, (candidate) => candidate === stableLauncher),
        {
            executablePath: stableLauncher,
            arguments: ['--wait-for-pid', '4321'],
            usesStableLauncher: true
        }
    );
});
