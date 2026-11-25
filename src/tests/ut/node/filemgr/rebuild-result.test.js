import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { fixture, deferred, flush } from './recovery-fixture.js';
import { BaseStorage } from '../../../../main/services/storage/abstract-storage.js';
import { RebuildRequiredError } from '../../../../main/applications/filemgr/storage.js';

function failFirstWrite(t, f, error, gate = null, entered = null) {
    const rename = fs.promises.rename.bind(fs.promises);
    let once = true;
    t.mock.method(fs.promises, 'rename', async (from, to) => {
        if (once && to === f.storage._scannerStatePath) {
            once = false;
            entered?.resolve();
            if (gate) await gate.promise;
            throw error;
        }
        return rename(from, to);
    });
}

for (const phase of ['pre-swap', 'post-swap'])
    test(`C201 actual ${phase} storage rebuild failure survives scanner recovery and reaches reset caller`, async (t) => {
        const f = await fixture(t);
        const primary = Error('fixture: rebuild ' + phase);
        if (phase === 'pre-swap') failFirstWrite(t, f, primary);
        else
            t.mock.method(BaseStorage.prototype, 'initialize', async () => {
                throw primary;
            });
        const result = await f.worker.resetFileSystemStorage();
        await f.worker.taskQueue.onIdle();
        assert.equal(result.status, 'error');
        assert.equal(result.message, primary.message);
        assert.equal(f.worker._rebuildQueued, false);
        assert.equal(f.worker._currentRebuildPromise, null);
        assert.equal(f.storage.scannerState.last_rebuild_event.status, 'failed');
        if (phase === 'pre-swap') assert.ok(f.worker.scanners.get(f.roots[0])?.isRunning());
        else {
            assert.equal(f.worker.status, 'error');
            assert.equal(f.worker._initError, primary);
            assert.equal(f.worker.scanners.size, 0);
        }
    });

for (const dual of [false, true])
    test(`C202 ${dual ? 'double failure keeps rebuild cause' : 'successful rebuild with restart failure rejects'} and releases shared slot`, async (t) => {
        const f = await fixture(t);
        const primary = Error('fixture: rebuild primary'),
            secondary = Error('fixture: restart secondary');
        if (dual) failFirstWrite(t, f, primary);
        t.mock.method(f.worker, '_startScanner', async () => {
            throw secondary;
        });
        await assert.rejects(f.worker._rebuildAndRestart('test'), (error) => error === (dual ? primary : secondary));
        await f.worker.taskQueue.onIdle();
        assert.equal(f.worker._rebuildQueued, false);
        assert.equal(f.worker._currentRebuildPromise, null);
    });

test('C203 shared rebuild waiters receive one actual failure and a later request can succeed', async (t) => {
    const f = await fixture(t);
    const primary = Error('fixture: shared rebuild');
    const gate = deferred(t),
        entered = deferred(t);
    failFirstWrite(t, f, primary, gate, entered);
    const first = f.worker._rebuildAndRestart('first');
    const firstResult = first.catch((error) => error);
    await entered.promise;
    const second = f.worker._rebuildAndRestart('second');
    assert.equal(first, second);
    const secondResult = second.catch((error) => error);
    const reset = f.worker.resetFileSystemStorage();
    gate.resolve();
    assert.equal(await firstResult, primary);
    assert.equal(await secondResult, primary);
    assert.equal((await reset).status, 'error');
    await f.worker.taskQueue.onIdle();
    assert.equal(f.worker._rebuildQueued, false);
    assert.equal((await f.worker.resetFileSystemStorage()).status, 'ok');
    await f.worker.taskQueue.onIdle();
});

test('C203 automatic rebuild consumes rejection without waiting on its own queue and shares manual failure', async (t) => {
    const f = await fixture(t);
    const primary = Error('fixture: auto failure'),
        gate = deferred(t),
        entered = deferred(t);
    failFirstWrite(t, f, primary, gate, entered);
    const sync = f.storage.retrieval._syncMode.bind(f.storage.retrieval);
    let once = true;
    t.mock.method(f.storage.retrieval, '_syncMode', async (reason, ...args) => {
        if (once && reason === 'scan') {
            once = false;
            throw new RebuildRequiredError('fixture: auto');
        }
        return sync(reason, ...args);
    });
    const unhandled = [];
    const listener = (error) => unhandled.push(error);
    process.on('unhandledRejection', listener);
    t.after(() => process.off('unhandledRejection', listener));
    f.worker.scanners.get(f.roots[0]).requestImmediateScan();
    await entered.promise;
    const reset = f.worker.resetFileSystemStorage();
    gate.resolve();
    assert.equal((await reset).status, 'error');
    await f.worker.taskQueue.onIdle();
    await flush();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
});

test('C204 rebuild failure followed by config supersession cannot restore removed or paused roots; readonly refuses rebuild', async (t) => {
    const f = await fixture(t, ['A', 'B'], { paused: ['B'] });
    const [A, B] = f.roots;
    const gate = deferred(t),
        entered = deferred(t);
    failFirstWrite(t, f, Error('fixture: superseded failure'), gate, entered);
    const reset = f.worker.resetFileSystemStorage();
    await entered.promise;
    const config = f.worker.applicationConfigChanged(f.config([B]));
    await flush();
    gate.resolve();
    assert.equal((await reset).status, 'error');
    await config;
    await f.worker.taskQueue.onIdle();
    assert.equal(f.worker.scanners.has(A), false);
    assert.equal(f.worker.scanners.has(B), false);
    assert.equal(f.storage.scannerState.roots[B].paused, true);
    f.worker._readonlyMode = true;
    assert.equal((await f.worker.resetFileSystemStorage()).status, 'error');
});
