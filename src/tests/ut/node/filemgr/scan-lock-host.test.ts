import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import FileManagerWorker from '../../../../main/applications/filemgr/worker.js';
import { configureHostRuntime } from '../../../../platforms/runtime.js';

test('a configured host never removes another scanner lock and can acquire it after release', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'host-scan-lock-'));
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const restore = configureHostRuntime({ fileScanLock: { retries: 0, staleMs: 5000, updateMs: 2500 } });
    const owner = new FileManagerWorker('filemgr', directory) as any;
    const contender = new FileManagerWorker('filemgr', directory) as any;
    try {
        Object.defineProperty(process, 'platform', { value: 'openharmony', configurable: true });
        assert.equal(await owner._acquireScanLock(), true);
        const lockPath = path.join(directory, 'scan.lock.lock');
        const before = fs.statSync(lockPath);
        assert.equal(await contender._acquireScanLock(), false);
        assert.equal(contender._releaseScanLock, null);
        assert.equal(fs.statSync(lockPath).ino, before.ino);
        await owner._releaseScanLock();
        owner._releaseScanLock = null;
        assert.equal(await contender._acquireScanLock(), true);
    } finally {
        Object.defineProperty(process, 'platform', originalPlatform);
        await owner._releaseScanLock?.().catch(() => {});
        await contender._releaseScanLock?.().catch(() => {});
        restore();
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
