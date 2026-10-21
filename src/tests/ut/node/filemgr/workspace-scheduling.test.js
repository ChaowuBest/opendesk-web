import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, deferred, flush, failRename, setFileMtimeAfterCheckpoint } from './recovery-fixture.js';
import { scanPath } from './fixture-paths.js';

test('B101 workspace control actually queues a scan and retains the normal periodic timer', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = await fixture(t);
    const [A] = f.roots;
    fs.writeFileSync(path.join(A, 'workspace.txt'), 'new');
    await f.worker.workspaceChanged(A);
    await f.worker.taskQueue.onIdle();
    assert.ok(f.rows.has(scanPath(path.join(A, 'workspace.txt'))));
    assert.ok(f.worker.scanners.get(A)._scheduledTimeout);
    fs.writeFileSync(path.join(A, 'next.txt'), 'next');
    const checkpoint = f.storage.scannerState.roots[A].last_full_scan;
    assert.ok(setFileMtimeAfterCheckpoint(path.join(A, 'next.txt'), checkpoint) > checkpoint);
    t.mock.timers.tick(60000);
    await f.worker.taskQueue.onIdle();
    assert.ok(f.rows.has(scanPath(path.join(A, 'next.txt'))));
    assert.ok(f.worker.scanners.get(A)._scheduledTimeout);
});

test('B102 paused workspace does not scan and real resume retains full-scan opportunity', async (t) => {
    const f = await fixture(t, ['A'], { paused: ['A'] });
    const [A] = f.roots;
    await f.worker.workspaceChanged(A);
    await f.worker.taskQueue.onIdle();
    assert.equal(f.worker.scanners.size, 0);
    assert.equal(f.rows.size, 0);
    assert.equal(f.storage.scannerState.roots[A].paused, true);
    assert.equal((await f.worker.setSourcePaused({ root: A, paused: false })).status, 'ok');
    await f.worker.taskQueue.onIdle();
    assert.ok(f.rows.has(scanPath(path.join(A, 'one.txt'))));
    assert.equal(f.worker.scanners.get(A)._counter, 1);
});

test('B103 workspace A B A supersession retains unique ownership across a real state write', async (t) => {
    const f = await fixture(t);
    const [A, B] = f.roots;
    const entered = deferred(t),
        gate = deferred(t);
    const save = f.storage.saveScannerState.bind(f.storage);
    let count = 0;
    t.mock.method(f.storage, 'saveScannerState', async () => {
        count++;
        if (count === 1) {
            entered.resolve();
            await gate.promise;
        }
        return save();
    });
    const first = f.worker.workspaceChanged(A);
    await entered.promise;
    const second = f.worker.workspaceChanged(B);
    const third = f.worker.workspaceChanged(A);
    await flush();
    gate.resolve();
    await Promise.all([first, second, third]);
    await f.worker.taskQueue.onIdle();
    assert.ok(count >= 2);
    assert.equal(f.worker._currentWorkspace, A);
    assert.equal(f.worker._pendingWorkspaceChange, null);
    assert.ok(f.worker.scanners.get(A)._scheduledTimeout);
});

test('B104 another control permits queueing but still yields I/O and keeps the next periodic opportunity', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = await fixture(t);
    const [A] = f.roots;
    const token = f.worker._registerSourceControlIntent();
    fs.writeFileSync(path.join(A, 'later.txt'), 'later');
    const checkpoint = f.storage.scannerState.roots[A].last_full_scan;
    assert.ok(setFileMtimeAfterCheckpoint(path.join(A, 'later.txt'), checkpoint) > checkpoint);
    await f.worker.workspaceChanged(A);
    await f.worker.taskQueue.onIdle();
    assert.equal(f.rows.has(scanPath(path.join(A, 'later.txt'))), false);
    assert.ok(f.worker.scanners.get(A)._scheduledTimeout);
    f.worker._consumeSourceControlIntent(token);
    t.mock.timers.tick(60000);
    await f.worker.taskQueue.onIdle();
    assert.ok(f.rows.has(scanPath(path.join(A, 'later.txt'))));
    assert.equal(f.worker._scanPending, false);
});

test('B104 workspace persistence failure preserves existing timer and readonly never writes or scans', async (t) => {
    const f = await fixture(t);
    const [A] = f.roots;
    const scanner = f.worker.scanners.get(A);
    const timer = scanner._scheduledTimeout;
    const restore = failRename(t, f.storage);
    await assert.rejects(f.worker.workspaceChanged(A), /rename failed/);
    assert.equal(scanner._scheduledTimeout, timer);
    assert.equal(f.worker._pendingWorkspaceChange, null);
    restore();
    f.worker._readonlyMode = true;
    let saves = 0;
    t.mock.method(f.storage, 'saveScannerState', async () => {
        saves++;
    });
    await f.worker.workspaceChanged(A);
    await f.worker.taskQueue.onIdle();
    assert.equal(saves, 0);
    assert.equal(scanner._scheduledTimeout, timer);
});

test('B104 a request queued during a running scan leaves exactly one normal timer', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const active = new Set();
    const schedule = globalThis.setTimeout,
        cancel = globalThis.clearTimeout;
    t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => {
        const handle = schedule(fn, ms, ...args);
        if (ms === 300000) active.add(handle);
        return handle;
    });
    t.mock.method(globalThis, 'clearTimeout', (handle) => {
        active.delete(handle);
        return cancel(handle);
    });
    t.after(() => {
        for (const handle of active) cancel(handle);
    });
    const f = await fixture(t, ['A'], { start: false });
    const gate = deferred(t),
        entered = deferred(t);
    const upsert = f.db.upsert;
    let once = true;
    t.mock.method(f.db, 'upsert', async (items) => {
        if (once) {
            once = false;
            entered.resolve();
            await gate.promise;
        }
        return upsert(items);
    });
    await f.worker._startScanners(f.worker.config.entries);
    await entered.promise;
    f.worker.scanners.get(f.roots[0]).requestImmediateScan();
    gate.resolve();
    await f.worker.taskQueue.onIdle();
    assert.equal(active.size, 1);
    await f.worker._stopScanners();
    assert.equal(active.size, 0);
});
