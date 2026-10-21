import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, entry, failRename } from './recovery-fixture.js';
import { FSStorage } from '../../../../main/applications/filemgr/storage.js';
import { scanPath } from './fixture-paths.js';

async function manual(t, options = {}) {
    const f = await fixture(t, ['A'], { ...options, start: false });
    f.worker.taskQueue.pause();
    await f.worker._startScanners(f.worker.config.entries);
    return {
        ...f,
        A: f.roots[0],
        scanner: f.worker.scanners.get(f.roots[0]),
        state: f.storage.scannerState.roots[f.roots[0]]
    };
}

test('C101 real saveFiles failed result keeps the old full baseline and persists a pending diagnostic instead of empty success', async (t) => {
    const f = await manual(t);
    t.mock.method(f.db, 'upsert', async () => {
        throw Error('fixture: base write');
    });
    assert.equal(await f.scanner.scan(), true);
    assert.equal(f.state.last_full_scan, 100);
    assert.equal(f.state.metadata_write_pending, true);
    assert.equal(f.disk().roots[f.A].metadata_write_pending, true);
    assert.ok(f.state.last_scan_at > 100);
    const status = await f.worker.getFileSystemStatus();
    assert.equal(status.sources[0].metadata_write_pending, true);
    assert.equal(status.sources[0].state, 'pending');
    assert.equal(status.sources[0].total_files, 0);
});

test('C102 partial DB commits and over-20 failure samples do not lose retry coverage or reset successful unchanged embeddings', async (t) => {
    const files = Array.from({ length: 601 }, (_, i) => `f${i}.txt`);
    const f = await manual(t, { files });
    const upsert = f.db.upsert;
    let failing = true;
    t.mock.method(f.db, 'upsert', async (items) => {
        if (failing && items.length === 500) {
            await upsert(items.slice(0, 10));
            throw Error('fixture: partial batch');
        }
        return upsert(items);
    });
    await f.scanner.scan();
    assert.equal(f.state.metadata_write_pending, true);
    assert.equal(f.scanner._recentFailures.length, 20);
    assert.equal(f.state.last_full_scan, 100);
    const kept = [...f.rows.values()][0];
    kept.embedded = 1;
    failing = false;
    await f.scanner.scan();
    assert.equal(f.rows.size, 601);
    assert.equal(f.state.metadata_write_pending, false);
    assert.equal(f.rows.get(kept.item_id).embedded, 1);
    for (const row of f.rows.values()) assert.deepEqual(JSON.parse(row.root_refs), [f.A]);
});

test('C103 old deep file waits for the existing periodic full; marker itself never forces incremental scans to full', async (t) => {
    const deep = 'd1/d2/d3/d4/d5/old.txt';
    const f = await manual(t, { files: [deep] });
    f.state.last_full_scan = Date.now() + 10000;
    const upsert = f.db.upsert;
    let failing = true;
    t.mock.method(f.db, 'upsert', async (items) => {
        if (failing) throw Error('fixture: old deep');
        return upsert(items);
    });
    await f.scanner.scan();
    const baseline = f.state.last_full_scan;
    failing = false;
    f.scanner._counter = 1;
    assert.equal(f.scanner._getScanDepth(), 4);
    await f.scanner.scan();
    assert.equal(f.rows.size, 0);
    assert.equal(f.state.metadata_write_pending, true);
    assert.equal(f.state.last_full_scan, baseline);
    f.scanner._counter = 32;
    await f.scanner.scan();
    assert.ok(f.rows.has(scanPath(path.join(f.A, deep))));
    assert.equal(f.state.metadata_write_pending, false);
});

test('C104 zero baseline retries full only on its normal timer and normal failed-result attempts consume the counter', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = await fixture(t, ['A'], { start: false });
    const [A] = f.roots;
    const state = f.storage.scannerState.roots[A];
    state.last_full_scan = 0;
    const upsert = f.db.upsert;
    let failing = true;
    t.mock.method(f.db, 'upsert', async (items) => {
        if (failing) throw Error('fixture: continuous failure');
        return upsert(items);
    });
    await f.worker._startScanners(f.worker.config.entries);
    await f.worker.taskQueue.onIdle();
    const scanner = f.worker.scanners.get(A);
    assert.equal(scanner._counter, 1);
    assert.equal(scanner._getScanDepth(), undefined);
    assert.ok(scanner._scheduledTimeout);
    assert.equal(f.worker.taskQueue.size, 0);
    t.mock.timers.tick(300000);
    await f.worker.taskQueue.onIdle();
    assert.equal(scanner._counter, 2);
    assert.equal(state.last_full_scan, 0);
    failing = false;
    t.mock.timers.tick(300000);
    await f.worker.taskQueue.onIdle();
    assert.equal(scanner._counter, 3);
    assert.equal(state.metadata_write_pending, false);
    assert.equal(scanner._getScanDepth(), 4);
});

for (const previous of [false, true])
    test(`C105 located read errors preserve failed subtree and advance full without ${previous ? 'clearing an old metadata marker' : 'inventing a metadata marker'}`, async (t) => {
        const f = await manual(t, { files: ['bad/old.txt', 'good/live.txt'] });
        f.state.metadata_write_pending = previous;
        const bad = f.add(f.A, 'bad/deleted.txt', [f.A, '/shared']);
        const healthy = f.add(f.A, 'good/deleted.txt');
        const read = fs.readdir;
        let readFailures = 0;
        t.mock.method(fs, 'readdir', (dir, options, callback) => {
            if (scanPath(dir) === scanPath(path.join(f.A, 'bad'))) {
                readFailures++;
                callback(Object.assign(Error('fixture: read denied'), { code: 'EACCES', path: dir }));
            } else read(dir, options, callback);
        });
        await f.scanner.scan();
        assert.equal(readFailures, 1);
        assert.ok(f.state.last_full_scan > 100);
        assert.equal(f.state.metadata_write_pending, previous);
        assert.ok(f.rows.has(bad));
        assert.equal(f.rows.has(healthy), false);
        assert.deepEqual(JSON.parse(f.rows.get(bad).root_refs), [f.A, '/shared']);
    });

for (const phase of ['metadata-search', 'delete', 'stream'])
    test(`C106 ${phase} error preserves checkpoints and attributes only actual metadata errors to the marker`, async (t) => {
        const f = await manual(t);
        const primary = Error('fixture: ' + phase);
        f.add(f.A, 'deleted.txt');
        if (phase === 'metadata-search') {
            const search = f.db.search;
            t.mock.method(f.db, 'search', async (conditions) => {
                if (conditions.some((c) => c.operator === 'in')) throw primary;
                return search(conditions);
            });
        }
        if (phase === 'delete')
            t.mock.method(f.db, 'delete', async () => {
                throw primary;
            });
        if (phase === 'stream') {
            const read = fs.readdir;
            t.mock.method(fs, 'readdir', (dir, options, callback) => {
                if (scanPath(dir) === scanPath(f.A)) callback(primary);
                else read(dir, options, callback);
            });
        }
        await assert.rejects(f.scanner.scan(), (error) => error === primary);
        assert.equal(f.state.last_full_scan, 100);
        assert.equal(f.state.last_scan_at, 100);
        assert.equal(f.state.metadata_write_pending === true, phase === 'metadata-search');
        assert.equal(f.scanner._scanReader, null);
        if (phase === 'metadata-search') assert.equal(f.disk().roots[f.A].metadata_write_pending, true);
    });

for (const control of ['yield', 'stop'])
    test(`C106 ${control} after a failed batch preserves diagnosis but does not checkpoint or write the next batch`, async (t) => {
        const f = await manual(t, { files: Array.from({ length: 501 }, (_, i) => `f${i}.txt`) });
        let batches = 0;
        t.mock.method(f.db, 'upsert', async () => {
            batches++;
            if (control === 'yield') f.worker._pendingWorkspaceChange = { workspace: f.A };
            else await f.scanner.stop();
            throw Error('fixture: failed before ' + control);
        });
        await f.scanner.scan();
        assert.equal(batches, 1);
        assert.equal(f.state.last_full_scan, 100);
        assert.equal(f.state.last_scan_at, 100);
        assert.equal(f.disk().roots[f.A].metadata_write_pending, true);
        assert.equal(f.scanner._scanReader, null);
    });

test('C107 pause/restart/readonly preserve the diagnosis; new-rule full may confirm recovery without excluded files', async (t) => {
    const f = await fixture(t, ['A'], { start: false });
    const [A] = f.roots;
    const state = f.storage.scannerState.roots[A];
    state.metadata_write_pending = true;
    state.paused = true;
    await f.storage.saveScannerState();
    const restored = new FSStorage(f.stateDirectory);
    restored._loadScannerState();
    assert.equal(restored.scannerState.roots[A].metadata_write_pending, true);
    f.worker._readonlyMode = true;
    const status = await f.worker.getFileSystemStatus();
    assert.equal(status.sources[0].state, 'paused');
    assert.equal(status.sources[0].metadata_write_pending, true);
    f.worker._readonlyMode = false;
    await f.storage.setRootPaused(A, false);
    await f.worker.applicationConfigChanged({ entries: [entry(A, ['**/*.txt'])] });
    await f.worker.taskQueue.onIdle();
    assert.equal(state.metadata_write_pending, false);
});

test('C108 marker clearing and checkpoint commit remain atomic when rename fails', async (t) => {
    const f = await manual(t);
    f.state.metadata_write_pending = true;
    await f.storage.saveScannerState();
    const restore = failRename(t, f.storage);
    await assert.rejects(f.scanner.scan(), /rename failed/);
    assert.equal(f.state.metadata_write_pending, true);
    assert.equal(f.state.last_full_scan, 100);
    assert.equal(f.disk().roots[f.A].metadata_write_pending, true);
    assert.equal(f.disk().roots[f.A].last_full_scan, 100);
    restore();
    await f.scanner.scan();
    assert.equal(f.state.metadata_write_pending, false);
    assert.ok(f.state.last_full_scan > 100);
});

test('C108 failed diagnostic persistence attempts once and cannot mask the original metadata exception', async (t) => {
    const f = await manual(t);
    const primary = Error('fixture: original DB error');
    const search = f.db.search;
    let attempts = 0;
    t.mock.method(f.db, 'search', async (conditions) => {
        if (conditions.some((c) => c.operator === 'in')) throw primary;
        return search(conditions);
    });
    const rename = fs.promises.rename.bind(fs.promises);
    t.mock.method(fs.promises, 'rename', async (from, to) => {
        if (to === f.storage._scannerStatePath) {
            attempts++;
            throw Error('fixture: diagnostic rename');
        }
        return rename(from, to);
    });
    await assert.rejects(f.scanner.scan(), (error) => error === primary);
    assert.equal(attempts, 1);
    assert.equal(f.state.metadata_write_pending, true);
    assert.equal(f.state.last_scan_at, 100);
});

test('C106 a real queued pause waits for failed-batch reader drain and diagnostic persistence', async (t) => {
    const f = await fixture(t, ['A'], { start: false, files: Array.from({ length: 501 }, (_, i) => `f${i}.txt`) });
    const [A] = f.roots;
    let pausing,
        batches = 0;
    t.mock.method(f.db, 'upsert', async () => {
        batches++;
        pausing = f.worker.setSourcePaused({ root: A, paused: true });
        throw Error('fixture: write before queued pause');
    });
    await f.worker._startScanners(f.worker.config.entries);
    await f.worker.taskQueue.onIdle();
    assert.equal((await pausing).status, 'ok');
    assert.equal(batches, 1);
    assert.equal(f.worker.scanners.has(A), false);
    const state = f.storage.scannerState.roots[A];
    assert.equal(state.paused, true);
    assert.equal(state.metadata_write_pending, true);
    assert.equal(state.last_full_scan, 100);
    assert.equal(state.last_scan_at, 100);
    assert.equal(f.disk().roots[A].metadata_write_pending, true);
    assert.equal(f.disk().roots[A].paused, true);
});

test('C107 optional malformed diagnostic does not turn otherwise valid old state into a rebuild', async (t) => {
    const f = await manual(t);
    f.state.metadata_write_pending = 'bad';
    await f.storage.saveScannerState();
    const restored = new FSStorage(f.stateDirectory);
    restored._loadScannerState();
    assert.equal(restored._stateCorrupt, false);
    assert.equal(restored.scannerState.roots[f.A].metadata_write_pending, false);
});

test('C110 incremental repair followed by an unrelated read failure keeps historical pending until a complete full confirms it', async (t) => {
    const f = await manual(t, { files: ['one.txt', 'other/two.txt'] });
    const upsert = f.db.upsert;
    let failing = true;
    t.mock.method(f.db, 'upsert', async (items) => {
        if (failing) throw Error('fixture: initial write');
        return upsert(items);
    });
    await f.scanner.scan();
    failing = false;
    f.scanner._counter = 1;
    await f.scanner.scan();
    assert.equal(f.rows.size, 2);
    assert.equal(f.state.metadata_write_pending, true);
    const read = fs.readdir;
    let denied = true;
    let readFailures = 0;
    t.mock.method(fs, 'readdir', (dir, options, callback) => {
        if (denied && scanPath(dir) === scanPath(path.join(f.A, 'other'))) {
            readFailures++;
            callback(Object.assign(Error('fixture: read'), { code: 'EACCES', path: dir }));
        } else read(dir, options, callback);
    });
    f.scanner._counter = 32;
    await f.scanner.scan();
    assert.equal(readFailures, 1);
    assert.equal(f.state.metadata_write_pending, true);
    assert.equal(f.rows.size, 2);
    denied = false;
    await f.scanner.scan();
    assert.equal(f.state.metadata_write_pending, false);
    assert.equal(readFailures, 1);
});
