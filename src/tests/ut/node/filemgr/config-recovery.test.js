import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, entry, clone, deferred, flush, failRename, setFileMtimeAfterCheckpoint } from './recovery-fixture.js';
import { FSStorage } from '../../../../main/applications/filemgr/storage.js';
import FileManagerWorker from '../../../../main/applications/filemgr/worker.js';
import { saveEntries } from '../../../../main/applications/filemgr/renderer/adapter.js';
import * as selection from '../../../../main/applications/filemgr/renderer/state.js';
import { scanPath } from './fixture-paths.js';

test('A03 reconcile readd matching the old baseline supersedes a conflicting removal still waiting for the slot', async (t) => {
    const f = await fixture(t);
    const [A, B] = f.roots;
    const gate = deferred(t),
        entered = deferred(t);
    const blocker = f.worker.runSequentially(async () => {
        entered.resolve();
        await gate.promise;
    });
    await entered.promise;
    const removal = f.worker.applicationConfigChanged(f.config([B]));
    await flush();
    const readd = f.worker.reconcileConfig(f.config([A, B]));
    await flush();
    gate.resolve();
    const [, , result] = await Promise.all([blocker, removal, readd]);
    await f.worker.taskQueue.onIdle();
    assert.equal(result.reconciled, true);
    assert.deepEqual(
        f.worker.config.entries.map((e) => e.root),
        [A, B]
    );
    assert.ok(f.storage.scannerState.roots[A]);
    assert.ok(f.worker.scanners.get(A)?.isRunning());
    assert.equal(f.worker._pendingConfigChange, null);
});

test('A01 failed state rename stops removed scanners and preserves durable retry state and healthy work', async (t) => {
    const f = await fixture(t);
    const [A, B] = f.roots;
    const old = f.worker.scanners.get(A);
    const restore = failRename(t, f.storage);
    await assert.rejects(f.worker.applicationConfigChanged(f.config([B])), /rename failed/);
    assert.equal(old.isRunning(), false);
    assert.ok(f.storage.scannerState.roots[A]);
    assert.ok(f.disk().roots[A]);
    assert.equal(f.worker._lastConfig, null);
    assert.equal(f.worker._pendingConfigChange, null);
    assert.equal(old.requestImmediateScan(), false);
    restore();
    fs.writeFileSync(path.join(B, 'healthy.txt'), 'healthy');
    const checkpoint = f.storage.scannerState.roots[B].last_full_scan;
    assert.ok(setFileMtimeAfterCheckpoint(path.join(B, 'healthy.txt'), checkpoint) > checkpoint);
    f.worker.scanners.get(B).requestImmediateScan();
    await f.worker.taskQueue.onIdle();
    assert.ok(f.rows.has(scanPath(path.join(B, 'healthy.txt'))));
    assert.equal((await f.worker.reconcileConfig(f.config([B]))).reconciled, true);
    await f.worker.taskQueue.onIdle();
    assert.equal(f.storage.scannerState.roots[A], undefined);
    assert.equal(f.worker.scanners.has(A), false);
});

test('A01 reader close failure does not skip stopping other removed roots before cleanup can fail', async (t) => {
    const f = await fixture(t, ['A', 'B', 'C']);
    const [A, B, C] = f.roots;
    const a = f.worker.scanners.get(A),
        c = f.worker.scanners.get(C);
    a._scanReader = {
        close() {
            throw Error('fixture: reader close');
        }
    };
    t.mock.method(f.db, 'search', async () => {
        throw Error('fixture: query failed');
    });
    await assert.rejects(f.worker.applicationConfigChanged(f.config([B])), /query failed/);
    assert.equal(a.isRunning(), false);
    assert.equal(c.isRunning(), false);
    assert.equal(a._scheduledTimeout, null);
    assert.equal(c._scheduledTimeout, null);
});

test('A02 partial delete/update failures invalidate counts, preserve shared refs and retry only unfinished roots', async (t) => {
    const f = await fixture(t, ['A', 'B', 'C']);
    const [A, B, C] = f.roots;
    const shared = f.add(C, 'shared.txt', [C, B]);
    const unique = scanPath(path.join(C, 'one.txt'));
    const update = f.db.update;
    let failing = true;
    const generation = f.storage._perRootCountsCacheGeneration;
    t.mock.method(f.db, 'update', async (items) => {
        if (failing && items.some((i) => i.item_id === shared)) throw Error('fixture: ref update');
        return update(items);
    });
    await assert.rejects(f.worker.applicationConfigChanged(f.config([B])), /ref update/);
    assert.equal(f.rows.has(unique), false);
    assert.equal(f.storage.scannerState.roots[A], undefined);
    assert.ok(f.disk().roots[C]);
    assert.deepEqual(JSON.parse(f.rows.get(shared).root_refs), [C, B]);
    assert.ok(f.storage._perRootCountsCacheGeneration >= generation + 2);
    failing = false;
    await f.worker.reconcileConfig(f.config([B]));
    await f.worker.taskQueue.onIdle();
    assert.deepEqual(JSON.parse(f.rows.get(shared).root_refs), [B]);
    assert.equal(f.worker.scanners.has(A), false);
    assert.equal(f.storage.scannerState.roots[C], undefined);
});

for (const boundary of ['search', 'delete', 'rename'])
    test(`A03 remove/readd supersedes at real ${boundary} boundary and rebuilds from actual roots`, async (t) => {
        const f = await fixture(t);
        const [A, B] = f.roots;
        const gate = deferred(t),
            entered = deferred(t);
        if (boundary === 'rename') {
            const original = fs.promises.rename.bind(fs.promises);
            let once = true;
            t.mock.method(fs.promises, 'rename', async (from, to) => {
                if (once && to === f.storage._scannerStatePath) {
                    once = false;
                    entered.resolve();
                    await gate.promise;
                }
                return original(from, to);
            });
        } else {
            const original = f.db[boundary];
            let once = true;
            t.mock.method(f.db, boundary, async (...args) => {
                if (once) {
                    once = false;
                    entered.resolve();
                    await gate.promise;
                }
                return original(...args);
            });
        }
        const removal = f.worker.applicationConfigChanged(f.config([B]));
        await entered.promise;
        const readd = f.worker.applicationConfigChanged(f.config([A, B]));
        await flush();
        gate.resolve();
        await Promise.all([removal, readd]);
        await f.worker.taskQueue.onIdle();
        assert.ok(f.storage.scannerState.roots[A]);
        assert.ok(f.disk().roots[A]);
        assert.ok(f.worker.scanners.get(A)?.isRunning());
        assert.ok(JSON.parse(f.rows.get(scanPath(path.join(A, 'one.txt'))).root_refs).includes(A));
        assert.equal(f.worker._pendingConfigChange, null);
    });

test('A04 empty-config orphan failure remains retryable and does not stay initializing', async (t) => {
    const f = await fixture(t, ['A']);
    const orphan = f.add(f.roots[0], 'orphan.txt', []);
    const search = f.db.search;
    let failing = true;
    t.mock.method(f.db, 'search', async (conditions) => {
        if (failing && conditions.length === 1 && conditions[0].field === 'type') throw Error('fixture: orphan query');
        return search(conditions);
    });
    await assert.rejects(f.worker.applicationConfigChanged(f.config([])), /orphan query/);
    assert.equal(f.worker._lastConfig, null);
    assert.equal(f.worker._pendingConfigChange, null);
    assert.notEqual(f.worker.status, 'initializing');
    failing = false;
    assert.equal((await f.worker.reconcileConfig(f.config([]))).reconciled, true);
    assert.equal(f.rows.has(orphan), false);
    assert.equal((await f.worker.reconcileConfig(f.config([]))).reconciled, false);
});

test('A05 restart completes failed durable cleanup without reviving removed roots or healthy paused state', async (t) => {
    const f = await fixture(t, ['A', 'B'], { paused: ['B'] });
    const [A, B] = f.roots;
    const b = clone(f.storage.scannerState.roots[B]);
    const restore = failRename(t, f.storage);
    await assert.rejects(f.worker.applicationConfigChanged(f.config([B])));
    restore();
    const storage = new FSStorage(f.stateDirectory);
    storage.storage = f.db;
    storage._loadScannerState();
    const worker = new FileManagerWorker('filemgr', f.stateDirectory);
    worker.storage = storage;
    worker.config = worker._normalizeConfig(f.config([B]));
    worker._initializing = true;
    t.after(() => worker._stopScanners());
    const seq = worker._nextInitSeq();
    await worker.runSequentially(() => worker._continueInitializeAfterProbe(seq, 'fixture restart'));
    await worker.taskQueue.onIdle();
    assert.equal(storage.scannerState.roots[A], undefined);
    assert.equal(worker.scanners.has(A), false);
    assert.deepEqual(storage.scannerState.roots[B], b);
    assert.equal(worker.scanners.has(B), false);
    assert.equal(f.disk().roots[A], undefined);
});

for (const paused of [false, true])
    test(`A05 R1 startup stale-root cleanup failure preserves ${paused ? 'paused state' : 'actual scanning for a healthy persisted root'}`, async (t) => {
        const f = await fixture(t, ['A', 'B'], { start: false, paused: paused ? ['B'] : [] });
        const [A, B] = f.roots;
        const b = clone(f.storage.scannerState.roots[B]);
        const stale = f.add(A, 'stale.txt');
        f.worker.config = f.worker._normalizeConfig(f.config([B]));
        f.worker._lastConfig = null;
        f.worker._initializing = true;
        f.worker.status = 'initializing';
        const deletionError = Error('fixture: stale root deletion');
        const remove = f.db.delete;
        t.mock.method(f.db, 'delete', async (ids) => {
            if (ids.includes(stale)) throw deletionError;
            return remove(ids);
        });
        const seq = f.worker._nextInitSeq();
        await f.worker.runSequentially(() => f.worker._continueInitializeAfterProbe(seq, 'fixture startup'));
        await f.worker.taskQueue.onIdle();
        assert.equal(f.worker.scanners.has(A), false);
        assert.ok(f.storage.scannerState.roots[A]);
        assert.ok(f.disk().roots[A]);
        assert.ok(f.rows.has(stale));
        assert.equal(f.worker._lastConfig, null);
        assert.equal(f.worker._pendingConfigChange, null);
        assert.equal(f.worker._initializing, false);
        if (paused) {
            assert.equal(f.worker.scanners.has(B), false);
            assert.deepEqual(f.storage.scannerState.roots[B], b);
            assert.equal(f.rows.has(scanPath(path.join(B, 'one.txt'))), false);
            assert.equal(f.worker.status, 'idle');
        } else {
            assert.ok(f.worker.scanners.get(B)?.isRunning());
            assert.ok(f.worker.scanners.get(B)?._scheduledTimeout);
            assert.ok(f.rows.has(scanPath(path.join(B, 'one.txt'))));
            assert.equal(f.worker.status, 'running');
        }
    });

test('A05 R1 superseded startup cleanup cannot recover a root removed by the current configuration', async (t) => {
    const f = await fixture(t, ['A', 'B', 'C'], { start: false });
    const [A, B, C] = f.roots;
    const stale = f.add(A, 'stale.txt');
    f.worker.config = f.worker._normalizeConfig(f.config([B]));
    f.worker._lastConfig = null;
    f.worker._initializing = true;
    f.worker.status = 'initializing';
    const entered = deferred(t),
        gate = deferred(t);
    const remove = f.db.delete;
    let once = true;
    t.mock.method(f.db, 'delete', async (ids) => {
        if (once && ids.includes(stale)) {
            once = false;
            entered.resolve();
            await gate.promise;
            throw Error('fixture: superseded stale root deletion');
        }
        return remove(ids);
    });
    const starts = [];
    const start = f.worker._startScanner.bind(f.worker);
    t.mock.method(f.worker, '_startScanner', async (...args) => {
        starts.push(args[0].root);
        return start(...args);
    });
    const seq = f.worker._nextInitSeq();
    const startup = f.worker.runSequentially(() => f.worker._continueInitializeAfterProbe(seq, 'fixture startup'));
    await entered.promise;
    await f.worker.applicationConfigChanged(f.config([C]));
    let reconciled = false;
    const reconcile = f.worker.reconcileConfig(f.config([C])).then((result) => {
        reconciled = true;
        return result;
    });
    await flush();
    const completedEarly = reconciled;
    gate.resolve();
    await startup;
    assert.equal(completedEarly, false);
    assert.equal((await reconcile).status, 'ok');
    await f.worker.taskQueue.onIdle();
    assert.equal(starts.includes(A), false);
    assert.equal(starts.includes(B), false);
    assert.ok(f.worker.scanners.get(C)?.isRunning());
    assert.ok(f.rows.has(scanPath(path.join(C, 'one.txt'))));
    assert.equal(f.rows.has(scanPath(path.join(B, 'one.txt'))), false);
    assert.deepEqual(
        f.worker._lastConfig.entries.map((e) => e.root),
        [C]
    );
    assert.equal(f.worker._initializing, false);
    assert.equal(f.worker._pendingConfigChange, null);
});

test('A05 R1 a global startup mode failure does not start persisted roots or become healthy recovery', async (t) => {
    const f = await fixture(t, ['A', 'B'], { start: false });
    const [, B] = f.roots;
    f.worker.config = f.worker._normalizeConfig(f.config([B]));
    f.worker._lastConfig = null;
    f.worker._initializing = true;
    f.worker.status = 'initializing';
    const modeError = Error('fixture: global mode failure');
    t.mock.method(f.storage, 'syncEmbeddingModeForStartup', async () => {
        throw modeError;
    });
    const seq = f.worker._nextInitSeq();
    await f.worker.runSequentially(() => f.worker._continueInitializeAfterProbe(seq, 'fixture startup'));
    await f.worker.taskQueue.onIdle();
    assert.equal(f.worker.scanners.size, 0);
    assert.equal(f.rows.size, 0);
    assert.equal(f.worker.status, 'error');
    assert.equal(f.worker._initError, modeError);
    assert.equal(f.worker._lastConfig, null);
    assert.equal(f.worker._initializing, false);
});

for (const boundary of ['queued', 'detach'])
    test(`A07 embedding successor consumes pending config ${boundary} without a same-queue await`, async (t) => {
        const f = await fixture(t);
        const [A, B] = f.roots;
        const gate = deferred(t),
            entered = deferred(t);
        let blocked;
        if (boundary === 'queued')
            blocked = f.worker.runSequentially(async () => {
                entered.resolve();
                await gate.promise;
            });
        else {
            const search = f.db.search;
            let once = true;
            t.mock.method(f.db, 'search', async (...args) => {
                if (once) {
                    once = false;
                    entered.resolve();
                    await gate.promise;
                }
                return search(...args);
            });
        }
        const config = f.worker.applicationConfigChanged(f.config([B]));
        await entered.promise;
        await flush();
        let reconciled = false;
        const reconcile = f.worker.reconcileConfig(f.config([B])).then((result) => {
            reconciled = true;
            return result;
        });
        const mode = f.worker.embeddingConfigChanged();
        await flush();
        const completedEarly = reconciled;
        gate.resolve();
        await Promise.all([config, mode, blocked]);
        assert.equal(completedEarly, false);
        assert.equal((await reconcile).status, 'ok');
        await f.worker.taskQueue.onIdle();
        assert.equal(f.storage.scannerState.roots[A], undefined);
        assert.equal(f.worker.scanners.has(A), false);
        assert.equal(f.worker._pendingConfigChange, null);
        assert.equal(f.worker._pendingEmbeddingConfigChange, false);
        assert.ok(f.worker.scanners.get(B)?._scheduledTimeout);
        assert.equal((await f.worker.reconcileConfig(f.config([B]))).reconciled, false);
    });

test('A09 a config-added source obtains real scan opportunity while workspace control overlaps restart', async (t) => {
    const f = await fixture(t, ['B']);
    const [B] = f.roots;
    const A = path.join(f.directory, 'files', 'A');
    fs.mkdirSync(A);
    fs.writeFileSync(path.join(A, 'new.txt'), 'A');
    const start = f.worker._startScanner.bind(f.worker);
    let workspace;
    let once = true;
    t.mock.method(f.worker, '_startScanner', async (...args) => {
        if (once && args[0].root === A) {
            once = false;
            workspace = f.worker.workspaceChanged(B);
            await flush();
        }
        return start(...args);
    });
    await f.worker.applicationConfigChanged(f.config([A, B]));
    await workspace;
    await f.worker.taskQueue.onIdle();
    assert.ok(f.rows.has(scanPath(path.join(A, 'new.txt'))));
    assert.ok(f.worker.scanners.get(A)._scheduledTimeout);
    assert.ok(f.worker.scanners.get(B)._scheduledTimeout);
    assert.equal(f.worker._hasPendingControlChange(), false);
});

test('A10 a first full yielded before I/O retains counter zero and restores deep old refs on the normal timer', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const deep = 'd1/d2/d3/d4/d5/old.txt';
    const f = await fixture(t, ['A'], { start: false, files: [deep] });
    const [A] = f.roots;
    const target = f.add(A, deep, []);
    f.rows.get(target).modified = Math.floor(fs.statSync(target).mtimeMs);
    f.storage.scannerState.roots[A].last_full_scan = Date.now() + 10000;
    f.worker._pendingWorkspaceChange = { workspace: A };
    await f.worker._startScanners(f.worker.config.entries);
    await f.worker.taskQueue.onIdle();
    const scanner = f.worker.scanners.get(A);
    assert.equal(scanner._counter, 0);
    assert.ok(scanner._scheduledTimeout);
    f.worker._pendingWorkspaceChange = null;
    t.mock.timers.tick(300000);
    await f.worker.taskQueue.onIdle();
    assert.deepEqual(JSON.parse(f.rows.get(target).root_refs), [A]);
    assert.equal(scanner._counter, 1);
    assert.equal(scanner._getScanDepth(), 4);
});

test('A01 changed-rule scanner stops before a failing mode sync while unchanged healthy roots remain recoverable', async (t) => {
    const f = await fixture(t);
    const [A, B] = f.roots;
    const old = f.worker.scanners.get(A);
    t.mock.method(f.storage, 'syncEmbeddingModeForStartup', async () => {
        throw Error('fixture: mode failed');
    });
    await assert.rejects(
        f.worker.applicationConfigChanged({ entries: [entry(A, ['**/*.txt']), entry(B)] }),
        /mode failed/
    );
    assert.equal(old.isRunning(), false);
    assert.equal(f.worker.scanners.get(B).isRunning(), true);
    assert.equal(f.worker._pendingConfigChange, null);
    assert.equal(f.worker._lastConfig, null);
});

test('A03 a failed removal followed by readd preserves retained paused state instead of reviving historical defaults', async (t) => {
    const f = await fixture(t, ['A', 'B'], { paused: ['A'] });
    const [A, B] = f.roots;
    const state = f.storage.scannerState.roots[A];
    const entered = deferred(t),
        gate = deferred(t);
    const rename = fs.promises.rename.bind(fs.promises);
    let once = true;
    t.mock.method(fs.promises, 'rename', async (from, to) => {
        if (once && to === f.storage._scannerStatePath) {
            once = false;
            entered.resolve();
            await gate.promise;
            throw Error('fixture: retained removal');
        }
        return rename(from, to);
    });
    const removal = f.worker.applicationConfigChanged(f.config([B])).catch((error) => error);
    await entered.promise;
    const readd = f.worker.applicationConfigChanged(f.config([A, B]));
    await flush();
    gate.resolve();
    assert.match((await removal).message, /retained removal/);
    await readd;
    await f.worker.taskQueue.onIdle();
    assert.equal(f.storage.scannerState.roots[A], state);
    assert.equal(state.paused, true);
    assert.equal(f.worker.scanners.has(A), false);
    assert.equal(f.disk().roots[A].last_full_scan, 100);
});

test('A03 a persisted removal followed by readd creates a fresh unpaused source without resetting healthy paused sibling', async (t) => {
    const f = await fixture(t, ['A', 'B'], { paused: ['A', 'B'] });
    const [A, B] = f.roots;
    const b = clone(f.storage.scannerState.roots[B]);
    const entered = deferred(t),
        gate = deferred(t);
    const rename = fs.promises.rename.bind(fs.promises);
    let once = true;
    t.mock.method(fs.promises, 'rename', async (from, to) => {
        if (once && to === f.storage._scannerStatePath) {
            once = false;
            entered.resolve();
            await gate.promise;
        }
        return rename(from, to);
    });
    const removal = f.worker.applicationConfigChanged(f.config([B]));
    await entered.promise;
    const readd = f.worker.applicationConfigChanged(f.config([A, B]));
    await flush();
    gate.resolve();
    await Promise.all([removal, readd]);
    await f.worker.taskQueue.onIdle();
    assert.equal(f.storage.scannerState.roots[A].paused, false);
    assert.ok(f.worker.scanners.get(A)?.isRunning());
    assert.deepEqual(f.storage.scannerState.roots[B], b);
});

test('A04 empty startup performs orphan cleanup even without any roots or old configuration', async (t) => {
    const f = await fixture(t, [], { start: false });
    const id = f.add(f.directory, 'orphan.txt', []);
    f.worker.config = f.worker._normalizeConfig(f.config([]));
    f.worker._lastConfig = null;
    const seq = f.worker._nextInitSeq();
    await f.worker.runSequentially(() => f.worker._continueInitializeAfterProbe(seq, 'empty startup'));
    assert.equal(f.rows.has(id), false);
    assert.equal(f.worker.status, 'idle');
    assert.ok(f.worker._lastConfig);
});

test('A06 startup and protective recovery failure retain the primary error and allow explicit same-config retry', async (t) => {
    const f = await fixture(t);
    const [A, B] = f.roots;
    const primary = Error('fixture: first start'),
        secondary = Error('fixture: recovery');
    const start = f.worker._startScanner.bind(f.worker);
    let count = 0;
    t.mock.method(f.worker, '_startScanner', async (...args) => {
        if (args[0].root === B && count++ < 2) throw count === 1 ? primary : secondary;
        return start(...args);
    });
    await assert.rejects(f.worker.applicationConfigChanged(f.config([B])), (error) => error === primary);
    assert.equal(f.worker._lastConfig, null);
    assert.equal(f.worker._pendingConfigChange, null);
    assert.notEqual(f.worker.status, 'initializing');
    assert.equal(f.worker.scanners.has(A), false);
    assert.equal((await f.worker.reconcileConfig(f.config([B]))).reconciled, true);
    await f.worker.taskQueue.onIdle();
    assert.ok(f.worker.scanners.get(B)?._scheduledTimeout);
});

test('A07 mode successor failure clears inherited config/embedding intents and remains explicitly retryable', async (t) => {
    const f = await fixture(t);
    const [A, B] = f.roots;
    const entered = deferred(t),
        gate = deferred(t);
    const blocked = f.worker.runSequentially(async () => {
        entered.resolve();
        await gate.promise;
    });
    await entered.promise;
    const config = f.worker.applicationConfigChanged(f.config([B]));
    await flush();
    const sync = f.storage.syncEmbeddingModeForStartup.bind(f.storage);
    let fail = true;
    t.mock.method(f.storage, 'syncEmbeddingModeForStartup', async (...args) => {
        if (fail) throw Error('fixture: inherited mode');
        return sync(...args);
    });
    const mode = f.worker.embeddingConfigChanged().catch((error) => error);
    const reconcile = f.worker.reconcileConfig(f.config([B])).catch((error) => error);
    await flush();
    gate.resolve();
    await Promise.all([blocked, config]);
    assert.match((await mode).message, /inherited mode/);
    assert.match((await reconcile).message, /inherited mode/);
    assert.equal(f.worker._pendingConfigChange, null);
    assert.equal(f.worker._pendingEmbeddingConfigChange, false);
    assert.equal(f.worker._lastConfig, null);
    assert.equal(f.worker.scanners.has(A), false);
    fail = false;
    await f.worker.reconcileConfig(f.config([B]));
    await f.worker.taskQueue.onIdle();
    assert.ok(f.worker.scanners.get(B)?._scheduledTimeout);
});

test('A10 a first full yielded after its batch retains depth-full opportunity and restores deep refs on the normal timer', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const deep = 'd1/d2/d3/d4/d5/';
    const files = Array.from({ length: 501 }, (_, i) => deep + `f${i}.txt`);
    const f = await fixture(t, ['A'], { start: false, files });
    const [A] = f.roots;
    f.storage.scannerState.roots[A].last_full_scan = Date.now() + 10000;
    const upsert = f.db.upsert;
    let once = true;
    t.mock.method(f.db, 'upsert', async (items) => {
        await upsert(items);
        if (once) {
            once = false;
            f.worker._pendingWorkspaceChange = { workspace: A };
        }
    });
    await f.worker._startScanners(f.worker.config.entries);
    await f.worker.taskQueue.onIdle();
    const scanner = f.worker.scanners.get(A);
    assert.equal(scanner._counter, 0);
    assert.equal(f.rows.size, 500);
    assert.ok(scanner._scheduledTimeout);
    f.worker._pendingWorkspaceChange = null;
    t.mock.timers.tick(300000);
    await f.worker.taskQueue.onIdle();
    assert.equal(f.rows.size, 501);
    assert.equal(scanner._counter, 1);
});

test('reconcile follows a replacement startup continuation for the same configuration', async (t) => {
    const f = await fixture(t);
    const [, B] = f.roots;
    const entered = deferred(t),
        gate = deferred(t);
    const blocker = f.worker.runSequentially(async () => {
        entered.resolve();
        await gate.promise;
    });
    await entered.promise;
    f.worker._initializing = true;
    await f.worker.applicationConfigChanged(f.config([B]));
    const reconcile = f.worker.reconcileConfig(f.config([B]));
    // initialize() can advance the sequence and replace a previously queued continuation.
    f.worker._scheduleInitializeContinuation(f.worker._nextInitSeq(), 'fixture startup successor');
    gate.resolve();
    await blocker;
    const result = await reconcile;
    await f.worker.taskQueue.onIdle();
    assert.equal(result.status, 'ok');
    assert.ok(f.worker.scanners.get(B)?.isRunning());
    assert.equal(f.worker._configChangeOperation, null);
});

test('an older reconcile cannot confirm an equal configuration after queued ABA replacement', async (t) => {
    const f = await fixture(t);
    const [A, B] = f.roots;
    const entered = deferred(t),
        gate = deferred(t);
    const blocker = f.worker.runSequentially(async () => {
        entered.resolve();
        await gate.promise;
    });
    await entered.promise;
    const first = f.worker.applicationConfigChanged(f.config([B]));
    await flush();
    const oldReconcile = f.worker.reconcileConfig(f.config([B]));
    const second = f.worker.applicationConfigChanged(f.config([A]));
    await flush();
    const third = f.worker.applicationConfigChanged(f.config([B]));
    await flush();
    const latestReconcile = f.worker.reconcileConfig(f.config([B]));
    gate.resolve();
    await Promise.all([blocker, first, second, third]);
    assert.equal((await oldReconcile).status, 'error');
    assert.equal((await latestReconcile).status, 'ok');
    await f.worker.taskQueue.onIdle();
    assert.ok(f.worker.scanners.get(B)?.isRunning());
    assert.equal(f.worker.scanners.has(A), false);
    assert.equal(f.worker._configChangeOperation, null);
});

for (const boundary of ['queued', 'rename', 'initializing'])
    for (const fail of [false, true])
        test(`settings notification then explicit reconcile waits for ${boundary} config ${fail ? 'failure' : 'success'}`, async (t) => {
            const f = await fixture(t, ['A']);
            const [A] = f.roots;
            const B = path.join(f.directory, 'files', 'B');
            fs.mkdirSync(B);
            fs.writeFileSync(path.join(B, 'new.txt'), 'isolated');
            if (boundary === 'initializing') f.worker._initializing = true;
            const entered = deferred(t),
                gate = deferred(t),
                called = deferred(t);
            const blocker =
                boundary === 'queued'
                    ? f.worker.runSequentially(async () => {
                          entered.resolve();
                          await gate.promise;
                      })
                    : null;
            const rename = fs.promises.rename.bind(fs.promises);
            let once = true;
            const failure = Object.assign(Error('fixture: config rename failed'), { code: 'ENOSPC' });
            t.mock.method(fs.promises, 'rename', async (from, to) => {
                if (once && to === f.storage._scannerStatePath) {
                    once = false;
                    if (boundary !== 'queued') {
                        entered.resolve();
                        await gate.promise;
                    }
                    if (fail) throw failure;
                }
                return rename(from, to);
            });
            let restarts = 0;
            const restart = f.worker._restartScanners.bind(f.worker);
            t.mock.method(f.worker, '_restartScanners', async (...args) => {
                restarts++;
                return restart(...args);
            });
            let settings = { default_workspace: '', applications: { filemgr: f.worker.config } };
            let notification,
                writes = 0,
                saving;
            const previous = globalThis.window;
            globalThis.window = {
                settingAPI: {
                    loadSettingObject: async () => clone(settings),
                    saveSettingObject: async (next) => {
                        writes++;
                        settings = clone(next);
                        // Setting.setData notifies the worker before the adapter's explicit reconcile.
                        notification = f.worker
                            .applicationConfigChanged(settings.applications.filemgr)
                            .catch((error) => error);
                        await entered.promise;
                        return clone(settings);
                    }
                },
                applicationAPI: {
                    call: (method, config) => {
                        assert.equal(method, 'reconcileConfig');
                        const result = f.worker.reconcileConfig(config);
                        called.resolve();
                        return result;
                    }
                }
            };
            t.after(() => {
                if (previous === undefined) delete globalThis.window;
                else globalThis.window = previous;
                selection.__resetForTesting();
            });
            const feedback = [];
            const owner = selection.beginSelectionSession({
                load: () => window.settingAPI.loadSettingObject(),
                save: saveEntries,
                onFeedback: (kind) => feedback.push(kind)
            });
            try {
                await selection.initializeSelectionSession(owner);
                saving = selection.commitEntriesNow([entry(A), entry(B)]);
                await called.promise;
                await flush();
                assert.deepEqual(feedback, []);
                assert.equal(selection.getSelectionStatus().submitting, true);
                assert.deepEqual(selection.getSavedEntries(), [entry(A), entry(B)]);
                gate.resolve();
                await saving;
                const result = await notification;
                await f.worker.taskQueue.onIdle();
                assert.equal(result, fail && boundary !== 'initializing' ? failure : undefined);
                assert.deepEqual(feedback, [fail ? 'reconcileFailed' : 'saved']);
                assert.deepEqual(selection.getSavedEntries(), [entry(A), entry(B)]);
                assert.equal(selection.getSelectionStatus().submitting, false);
                assert.equal(selection.getSelectionStatus().unsaved, false);
                assert.equal(f.worker._pendingConfigChange, null);
                assert.equal(f.worker._configChangeOperation, null);
                assert.equal(f.worker.scanners.has(B), !fail);
                assert.equal(restarts, fail ? 0 : 1);
                assert.equal(writes, 1);
            } finally {
                gate.resolve();
                await Promise.allSettled([blocker, notification, saving]);
            }
        });

test('X1 X4 X6 actual adapter reconciliation failure keeps effective selection and cannot update a closed page', async (t) => {
    const f = await fixture(t);
    const [A, B] = f.roots;
    const previous = globalThis.window;
    let settings = { default_workspace: B, applications: { filemgr: f.worker.config } };
    globalThis.window = {
        settingAPI: {
            loadSettingObject: async () => clone(settings),
            saveSettingObject: async (next) => {
                settings = clone(next);
                // Mirror the automatic notification as well as the adapter's explicit request.
                void f.worker.applicationConfigChanged(settings.applications.filemgr).catch(() => {});
                return clone(settings);
            }
        },
        applicationAPI: {
            call: (method, config) => {
                assert.equal(method, 'reconcileConfig');
                return f.worker.reconcileConfig(config);
            }
        }
    };
    t.after(() => {
        if (previous === undefined) delete globalThis.window;
        else globalThis.window = previous;
        selection.__resetForTesting();
    });
    const entered = deferred(t),
        gate = deferred(t);
    const rename = fs.promises.rename.bind(fs.promises);
    let once = true;
    t.mock.method(fs.promises, 'rename', async (from, to) => {
        if (once && to === f.storage._scannerStatePath) {
            once = false;
            entered.resolve();
            await gate.promise;
            throw Error('fixture: late backend failure');
        }
        return rename(from, to);
    });
    const feedback = [];
    const owner = selection.beginSelectionSession({
        load: () => window.settingAPI.loadSettingObject(),
        save: saveEntries,
        onFeedback: (kind) => feedback.push(kind)
    });
    await selection.initializeSelectionSession(owner);
    const saving = selection.commitEntriesNow([entry(B)]);
    await entered.promise;
    assert.deepEqual(
        selection.getSavedEntries().map((e) => e.root),
        [B]
    );
    selection.closeSelectionSession(owner);
    const reopened = selection.beginSelectionSession({
        load: () => window.settingAPI.loadSettingObject(),
        save: saveEntries
    });
    const ready = selection.initializeSelectionSession(reopened);
    gate.resolve();
    await saving;
    await ready;
    assert.deepEqual(
        selection.getEntries().map((e) => e.root),
        [B]
    );
    assert.deepEqual(feedback, []);
    assert.equal(f.worker.scanners.has(A), false);
    await f.worker.reconcileConfig(f.config([B]));
    await f.worker.taskQueue.onIdle();
    assert.equal(f.storage.scannerState.roots[A], undefined);
});
