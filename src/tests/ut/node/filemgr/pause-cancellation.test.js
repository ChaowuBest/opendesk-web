import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { fixture, deferred } from './recovery-fixture.js';
import { scanPath } from './fixture-paths.js';

async function scanningBacklog(t, { existing = null, rootIndex = 0 } = {}) {
    const f = existing ?? (await fixture(t, ['A'], { start: false }));
    const root = f.roots[rootIndex];
    const stats = fs.statSync(path.join(root, 'one.txt'));
    const realReaddir = fs.readdir.bind(fs);
    const realLstat = fs.lstat.bind(fs);
    let synthetic = true;
    let reads = 0;
    const dirent = (name, directory) => ({
        name,
        isDirectory: () => directory,
        isFile: () => !directory,
        isSymbolicLink: () => false
    });
    t.mock.method(fs, 'readdir', (directory, options, callback) => {
        if (!synthetic) return realReaddir(directory, options, callback);
        reads++;
        setImmediate(() =>
            callback(
                null,
                scanPath(String(directory)) === scanPath(root)
                    ? [
                          ...Array.from({ length: 1000 }, (_, i) => dirent(`f${i}.txt`, false)),
                          ...Array.from({ length: 20000 }, (_, i) => dirent(`d${i}`, true))
                      ]
                    : []
            )
        );
    });
    t.mock.method(fs, 'lstat', (file, callback) => {
        if (!synthetic) return realLstat(file, callback);
        setImmediate(() => callback(null, stats));
    });
    const entered = deferred(t);
    const release = deferred(t);
    const save = f.storage.saveFiles.bind(f.storage);
    let first = true;
    t.mock.method(f.storage, 'saveFiles', async (...args) => {
        const result = await save(...args);
        if (first) {
            first = false;
            entered.resolve();
            await release.promise;
        }
        return result;
    });
    if (existing) await f.worker.applicationConfigChanged(f.config([root]));
    else await f.worker._startScanners(f.worker.config.entries);
    await entered.promise;
    assert.equal(reads, 1, 'directory readers must be blocked by pre-read pressure');
    return {
        ...f,
        root,
        release,
        useRealFiles: () => {
            synthetic = false;
        },
        reads: () => reads
    };
}

test('remove D, interrupt C removal, re-add D and pause/resume on the same worker', { timeout: 10000 }, async (t) => {
    const f = await fixture(t, ['D', 'C'], { start: false });
    const [dRoot] = f.roots;
    await f.worker.applicationConfigChanged(f.config([dRoot]));
    await f.worker.taskQueue.onIdle();
    assert.equal(f.rows.size, 1);
    await f.worker.applicationConfigChanged(f.config([]));
    assert.equal(f.rows.size, 0);

    const c = await scanningBacklog(t, { existing: f, rootIndex: 1 });
    const oldScanner = f.worker.scanners.get(c.root);
    const checkpoint = oldScanner.state.last_full_scan;
    const removal = f.worker.applicationConfigChanged(f.config([]));
    c.release.resolve();
    await removal;
    await f.worker.taskQueue.onIdle();
    assert.equal(oldScanner._scanReader, null);
    assert.equal(oldScanner.state.last_full_scan, checkpoint);
    assert.equal(f.rows.size, 0);
    c.useRealFiles();

    const d = await scanningBacklog(t, { existing: f });
    const pause = f.worker.setSourcePaused({ root: dRoot, paused: true });
    d.release.resolve();
    assert.equal((await pause).status, 'ok');
    await f.worker.taskQueue.onIdle();
    assert.equal(f.disk().roots[dRoot].paused, true);
    assert.equal(f.worker.scanners.size, 0);
    d.useRealFiles();
    assert.equal((await f.worker.setSourcePaused({ root: dRoot, paused: false })).status, 'ok');
    await f.worker.taskQueue.onIdle();
    assert.deepEqual([...f.rows.keys()], [scanPath(path.join(dRoot, 'one.txt'))]);
    assert.equal(f.worker._pendingSourceControls.size, 0);
    assert.equal(f.disk().roots[dRoot].paused, false);
});

for (const action of ['pause-resume', 'remove-readd', 'queued-pause-resume']) {
    test(
        `base-only ${action} completes with a large directory backlog and retains checkpoint safety`,
        { timeout: 10000 },
        async (t) => {
            const f = await scanningBacklog(t);
            const checkpoint = f.storage.scannerState.roots[f.root].last_full_scan;
            const scanner = f.worker.scanners.get(f.root);
            const pause =
                action === 'remove-readd'
                    ? f.worker.applicationConfigChanged(f.config([]))
                    : f.worker.setSourcePaused({ root: f.root, paused: true });
            const resume =
                action === 'queued-pause-resume' ? f.worker.setSourcePaused({ root: f.root, paused: false }) : null;
            f.release.resolve();
            const result = await pause;
            if (action !== 'remove-readd') assert.equal(result.status, 'ok');
            if (action === 'queued-pause-resume') {
                // Pause only the task queue so the already-enqueued resume scan cannot
                // replace the interrupted checkpoint before it is inspected below.
                f.worker.taskQueue.pause();
            } else await f.worker.taskQueue.onIdle();
            assert.equal(scanner._scanReader, null);
            assert.equal(scanner.state.last_full_scan, checkpoint);
            assert.equal(scanner.state.last_scan_at, 100);
            const writes = f.writes.length;
            const reads = f.reads();
            await nextTurn();
            assert.equal(f.writes.length, writes, 'no writes may outlive source cleanup');
            assert.equal(f.reads(), reads, 'no new reads may start after interruption');
            if (action === 'remove-readd') {
                assert.equal(f.rows.size, 0);
                assert.equal(f.worker.scanners.has(f.root), false);
            } else if (action === 'pause-resume') {
                assert.equal(f.disk().roots[f.root].paused, true);
                assert.equal(f.worker.scanners.has(f.root), false);
            }
            f.useRealFiles();
            f.worker.taskQueue.start();
            if (resume) assert.equal((await resume).status, 'ok');
            else if (action === 'remove-readd') await f.worker.applicationConfigChanged(f.config([f.root]));
            else assert.equal((await f.worker.setSourcePaused({ root: f.root, paused: false })).status, 'ok');
            await f.worker.taskQueue.onIdle();
            assert.equal(f.worker.scanners.get(f.root)?.isRunning(), true);
            assert.equal(f.disk().roots[f.root].paused, false);
            assert.ok(f.disk().roots[f.root].last_full_scan > checkpoint);
            assert.deepEqual([...f.rows.keys()], [scanPath(path.join(f.root, 'one.txt'))]);
            assert.equal(f.worker._pendingSourceControls.size, 0);
        }
    );
}
