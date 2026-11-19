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

test('OpenHarmony keeps the single-instance scan lock when no host policy is installed', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'host-scan-lock-ohos-'));
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    // 主仓的 OpenHarmony 运行时没有 configureHostRuntime 调用，这里复现"宿主未注入策略"
    const restore = configureHostRuntime();
    const owner = new FileManagerWorker('filemgr', directory) as any;
    const contender = new FileManagerWorker('filemgr', directory) as any;
    try {
        Object.defineProperty(process, 'platform', { value: 'openharmony', configurable: true });
        assert.equal(await owner._acquireScanLock(), true);
        const started = Date.now();
        assert.equal(await contender._acquireScanLock(), false);
        const elapsed = Date.now() - started;
        // 桌面默认策略是 10 次 × 1500ms；OH 必须一次失败就进入 query mode
        assert.ok(elapsed < 2000, `OpenHarmony must not wait for the desktop retry policy: ${elapsed}ms`);
        assert.equal(contender._releaseScanLock, null);
    } finally {
        Object.defineProperty(process, 'platform', originalPlatform);
        await owner._releaseScanLock?.().catch(() => {});
        await contender._releaseScanLock?.().catch(() => {});
        restore();
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
