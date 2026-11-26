import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Setting, ModelInstance, setCustomOpendeskDirectory } from '../../../../main/utils/setting.js';

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'filemgr-probe-timeout-'));
setCustomOpendeskDirectory(profile);
after(() => fs.rmSync(profile, { recursive: true, force: true }));
const { FSStorage } = await import('../../../../main/applications/filemgr/storage.js');
const { default: FileManagerWorker } = await import('../../../../main/applications/filemgr/worker.js');

function setModel(context, timeout) {
    const model = Object.assign(Object.create(ModelInstance.prototype), { timeout, model_name: 'test-model' });
    context.mock.method(Setting, 'getInstance', () => ({ getDefaultEmbeddingModelInstance: () => model }));
}

for (const [configured, expected] of [
    [120, 120000],
    [undefined, 300000]
]) {
    test(`probe inherits model timeout: ${configured ?? 'default'}`, async (context) => {
        setModel(context, configured);
        const storage = Object.create(FSStorage.prototype);
        storage.retrieval._probeCallOnce = async () => 2;
        storage.retrieval._withProbeTimeout = async (promise, timeout) => {
            assert.equal(timeout, expected);
            return promise;
        };
        assert.equal(await storage.retrieval._probeDim(undefined), 2);
    });
}

test('explicit probe budget is still honored', async (context) => {
    setModel(context, 120);
    const storage = Object.create(FSStorage.prototype);
    storage.retrieval._probeCallOnce = async () => 2;
    storage.retrieval._withProbeTimeout = async (promise, timeout) => {
        assert.equal(timeout, 50);
        return promise;
    };
    await storage.retrieval._probeDim(undefined, { probeTimeoutMs: 50 });
});

test('startup does not override configured timeout and preserves retry options', async () => {
    const storage = Object.create(FSStorage.prototype);
    storage.retrieval._syncMode = async (reason, options) => {
        assert.equal(reason, 'initialize');
        assert.equal(options.probeTimeoutMs, undefined);
        assert.equal(options.probeRetries, 1);
        assert.equal(options.rateLimitMaxRetries, 1);
    };
    await storage.retrieval._syncModeForStartup('initialize');
});

test('a probe lasting over ten seconds can complete within the configured budget', async (context) => {
    setModel(context, 120);
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const storage = Object.create(FSStorage.prototype);
    storage.retrieval._probeCallOnce = () => new Promise((resolve) => setTimeout(() => resolve(2), 20000));
    const probe = storage.retrieval._probeDim(undefined, { probeRetries: 0 });
    context.mock.timers.tick(20000);
    assert.equal(await probe, 2);
});

test('configured timeout still terminates probe waiting', async (context) => {
    setModel(context, 120);
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const storage = Object.create(FSStorage.prototype);
    storage.retrieval._probeCallOnce = () => new Promise(() => {});
    const rejected = assert.rejects(storage.retrieval._probeDim(undefined, { probeRetries: 0 }), /120000ms/);
    context.mock.timers.tick(120000);
    await rejected;
});

test('initialization and platform snapshot remain available while probe is pending', async (context) => {
    let release;
    const pending = new Promise((resolve) => {
        release = resolve;
    });
    context.mock.method(FSStorage.prototype, 'initialize', async function (options) {
        assert.deepEqual(options, { syncEmbedding: false });
        this.mode = 'base-only';
        this.scannerState = { roots: {} };
        this.storage = { close() {} };
        this.saveScannerState = async () => {};
        this.retrieval._syncModeForStartup = async () => pending;
    });
    const worker = new FileManagerWorker('probe-test', path.join(profile, 'worker'));
    worker.config = { entries: [] };
    worker._acquireScanLock = async () => true;
    worker._emitStatusChanged = async () => {};
    try {
        await worker.initialize();
        assert.equal(worker.status, 'initializing');
        const snapshot = await worker.getFileSystemStatus();
        assert.equal(snapshot.status, 'initializing');
        assert.equal(snapshot.platform, process.platform);
        assert.equal(typeof snapshot.is_openharmony, 'boolean');
    } finally {
        release();
        await worker.taskQueue.onIdle();
        await worker.finalize();
    }
});

test('probe timeout still resolves into base-only mode', async (context) => {
    setModel(context, 120);
    context.mock.timers.enable({ apis: ['setTimeout'] });
    let resolveProbeStarted;
    const probeStarted = new Promise((resolve) => {
        resolveProbeStarted = resolve;
    });
    const storage = Object.assign(new FSStorage(profile), {
        storage: { close() {} },
        mode: 'base-only',
        scannerState: {},
        refreshLatestSetting() {}
    });
    Object.assign(storage.retrieval, {
        _probeCallOnce() {
            resolveProbeStarted();
            return new Promise(() => {});
        },
        async _setProbeError(code) {
            this.scannerState.probe_error = { code };
        },
        async _openFull() {
            assert.fail('timed-out probe must not open vector indexes');
        }
    });
    const result = storage.retrieval._syncMode('test', { probeRetries: 0 });
    await probeStarted;
    context.mock.timers.tick(120000);
    await result;
    assert.equal(storage.mode, 'base-only');
    assert.equal(storage.scannerState.probe_error.code, 'embedding_config_error');
});
