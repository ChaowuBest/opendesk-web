import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { configureHostRuntime } from '../../../../platforms/runtime.js';
import { Setting, getTempWorkspaceDirectory, setCustomOpendeskDirectory } from '../../../../main/utils/setting.js';

function isolate(t: TestContext) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-host-workspace-'));
    const config = path.join(root, 'config');
    fs.mkdirSync(config);
    setCustomOpendeskDirectory(config);
    t.after(() => {
        setCustomOpendeskDirectory(undefined);
        fs.rmSync(root, { recursive: true, force: true });
    });
    return { root, config, setting: new Setting() };
}

test('without a host workspace port the desktop default remains in the existing configuration directory', (t) => {
    const { config, setting } = isolate(t);
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const restore = configureHostRuntime();
    t.after(() => {
        restore();
        Object.defineProperty(process, 'platform', originalPlatform);
    });
    assert.equal(setting.getEffectiveWorkspace(), path.join(config, 'workspace'));
    assert.ok(fs.statSync(path.join(config, 'workspace')).isDirectory());
});

test('an injected host default is created and used without persisting a user-selected workspace', (t) => {
    const { root, config, setting } = isolate(t);
    const workspace = path.join(root, 'external', 'Documents', 'OpenDesk');
    const restore = configureHostRuntime({ defaultWorkspace: () => workspace });
    t.after(restore);
    assert.equal(setting.getEffectiveWorkspace(), workspace);
    assert.ok(fs.statSync(workspace).isDirectory());
    assert.equal(setting.getData().default_workspace, '');
    assert.equal(fs.existsSync(path.join(config, 'workspace')), false);
});

test('a valid user-selected workspace takes priority without evaluating the host default', (t) => {
    const { root, setting } = isolate(t);
    const selected = path.join(root, 'selected');
    fs.mkdirSync(selected);
    setting.data.default_workspace = selected;
    const restore = configureHostRuntime({
        defaultWorkspace: () => {
            assert.fail('Host default must not override a valid explicit workspace');
        }
    });
    t.after(restore);
    assert.equal(setting.getEffectiveWorkspace(), selected);
});

for (const invalid of ['missing', 'regular-file'] as const) {
    test(`an invalid ${invalid} user workspace falls back to the host default`, (t) => {
        const { root, config, setting } = isolate(t);
        const selected = path.join(root, invalid),
            workspace = path.join(root, 'external', 'OpenDesk');
        if (invalid === 'regular-file') fs.writeFileSync(selected, 'not a directory');
        setting.data.default_workspace = selected;
        const restore = configureHostRuntime({ defaultWorkspace: () => workspace });
        t.after(restore);
        assert.equal(setting.getEffectiveWorkspace(), workspace);
        assert.ok(fs.statSync(workspace).isDirectory());
        assert.equal(setting.getData().default_workspace, selected);
        assert.equal(fs.existsSync(path.join(config, 'workspace')), false);
    });
}

test('a host getter returning undefined preserves the platform default', (t) => {
    const { config, setting } = isolate(t);
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const restore = configureHostRuntime({ defaultWorkspace: () => undefined });
    t.after(() => {
        restore();
        Object.defineProperty(process, 'platform', originalPlatform);
    });
    assert.equal(setting.getEffectiveWorkspace(), path.join(config, 'workspace'));
});

test('a host directory creation failure propagates rather than silently creating a private fallback', (t) => {
    const { root, config, setting } = isolate(t);
    const blockingFile = path.join(root, 'external-volume');
    fs.writeFileSync(blockingFile, 'this path cannot hold a workspace directory');
    const workspace = path.join(blockingFile, 'OpenDesk');
    const restore = configureHostRuntime({ defaultWorkspace: () => workspace });
    t.after(restore);
    assert.throws(
        () => setting.getEffectiveWorkspace(),
        (error: NodeJS.ErrnoException) => {
            assert.ok(error.code === 'ENOTDIR' || error.code === 'EEXIST');
            assert.equal(error.path, workspace);
            return true;
        }
    );
    assert.equal(fs.existsSync(path.join(config, 'workspace')), false);
});

test('host workspace resolution failures propagate and the getter is read from the current runtime', (t) => {
    const { root, config } = isolate(t);
    const unavailable = new Error('External storage permission is unavailable');
    const restore = configureHostRuntime({
        defaultWorkspace: () => {
            throw unavailable;
        }
    });
    try {
        assert.throws(
            () => getTempWorkspaceDirectory(),
            (error) => error === unavailable
        );
        assert.equal(fs.existsSync(path.join(config, 'workspace')), false);
    } finally {
        restore();
    }
    const workspace = path.join(root, 'external', 'ready');
    const release = configureHostRuntime({ defaultWorkspace: () => workspace });
    t.after(release);
    assert.equal(getTempWorkspaceDirectory(), workspace);
    assert.ok(fs.statSync(workspace).isDirectory());
});
