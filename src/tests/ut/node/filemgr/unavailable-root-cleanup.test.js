import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixture, entry, clone, failRename } from './recovery-fixture.js';
import { filterIndexedResultsByPolicy } from '../../../../main/applications/filemgr/search/indexed.js';
import { CODES } from '../../../../main/applications/filemgr/storage.js';
import { setRuntimeLocale } from '../../../../locale/index.js';

test('B201 B202 detach removes only exact-root unavailability and preserves healthy parent/shared search results', async (t) => {
    const f = await fixture(t, ['P', 'P/child', 'B', 'P/child-backup']);
    const [P, C, B, S] = f.roots;
    const id = f.add(C, 'shared.txt', [C, P, B]);
    f.storage.scannerState.unavailable_roots = { [C]: { since: 1, last_count: 2 }, [S]: { since: 1, last_count: 2 } };
    await f.storage.saveScannerState();
    await f.storage.detachRootForConfigChange(C, [entry(P), entry(B), entry(S)]);
    assert.equal(f.storage.scannerState.unavailable_roots[C], undefined);
    assert.ok(f.storage.scannerState.unavailable_roots[S]);
    assert.deepEqual(JSON.parse(f.rows.get(id).root_refs), [P, B]);
    const results = filterIndexedResultsByPolicy([{ path: id, ...f.rows.get(id) }], {
        entries: [entry(P), entry(B), entry(S)],
        unavailableRoots: f.storage.scannerState.unavailable_roots
    });
    assert.equal(results.length, 1);
});

test('B203 writable continuation prunes only markers with neither configuration nor actual root ownership', async (t) => {
    const f = await fixture(t, ['A'], { start: false });
    const [A] = f.roots;
    const ghost = A + '/old';
    const configured = A + '/new';
    f.storage.scannerState.unavailable_roots = {
        [ghost]: { since: 1, last_count: 1 },
        [configured]: { since: 1, last_count: 1 }
    };
    await f.storage.saveScannerState();
    f.worker.config = f.worker._normalizeConfig(f.config([A, configured]));
    f.worker._lastConfig = null;
    const prune = f.storage.pruneUnownedUnavailableRoots.bind(f.storage);
    let protectedDuringCleanup = false;
    t.mock.method(f.storage, 'pruneUnownedUnavailableRoots', async (...args) => {
        await prune(...args);
        protectedDuringCleanup = Boolean(f.storage.scannerState.unavailable_roots[configured]);
    });
    const seq = f.worker._nextInitSeq();
    await f.worker.runSequentially(() => f.worker._continueInitializeAfterProbe(seq, 'fixture'));
    await f.worker.taskQueue.onIdle();
    assert.equal(f.storage.scannerState.unavailable_roots[ghost], undefined);
    assert.equal(f.disk().unavailable_roots[ghost], undefined);
    assert.ok(f.storage.scannerState.roots[configured]);
    assert.equal(protectedDuringCleanup, true);
});

test('B204 rename failure preserves both memory and disk marker until retry succeeds', async (t) => {
    const f = await fixture(t, ['P', 'P/child']);
    const [P, C] = f.roots;
    f.storage.scannerState.unavailable_roots[C] = { since: 1, last_count: 1 };
    await f.storage.saveScannerState();
    const restore = failRename(t, f.storage);
    await assert.rejects(f.storage.detachRootForConfigChange(C, [entry(P)]));
    assert.ok(f.storage.scannerState.roots[C]);
    assert.ok(f.storage.scannerState.unavailable_roots[C]);
    assert.ok(f.disk().roots[C]);
    assert.ok(f.disk().unavailable_roots[C]);
    restore();
    await f.storage.detachRootForConfigChange(C, [entry(P)]);
    assert.equal(f.disk().unavailable_roots[C], undefined);
});

test('B203 B204 readonly derives a consistent effective view without writing and protects configured or failed-state roots', async (t) => {
    const f = await fixture(t, ['A'], { start: false });
    const [A] = f.roots;
    const ghost = A + '/ghost',
        configured = A + '/configured',
        retained = A + '/retained';
    f.storage.scannerState.roots[retained] = { last_full_scan: 1, last_scan_at: 1, total_files: 1, paused: true };
    f.storage.scannerState.unavailable_roots = Object.fromEntries(
        [ghost, configured, retained].map((root) => [root, { since: 1, last_count: 1 }])
    );
    f.worker.config = f.worker._normalizeConfig(f.config([A, configured]));
    f.worker._lastConfig = f.worker.config;
    f.worker._readonlyMode = true;
    let writes = 0;
    t.mock.method(f.storage, 'saveScannerState', async () => {
        writes++;
    });
    const status = await f.worker.getFileSystemStatus();
    assert.equal(status.unavailable_roots[ghost], undefined);
    assert.ok(status.unavailable_roots[configured]);
    assert.ok(status.unavailable_roots[retained]);
    assert.ok(f.storage.scannerState.unavailable_roots[ghost]);
    assert.equal(writes, 0);
    const light = f.worker._buildLightweightStatusSnapshot({
        status: 'readonly',
        platform: 'darwin',
        isOpenHarmony: false,
        homePath: '/test'
    });
    assert.deepEqual(light.unavailable_roots, status.unavailable_roots);
});

test('B203 B204 R2 readonly config notifications update sources, scopes and final search policy without writes or scanning', async (t) => {
    setRuntimeLocale('en-US');
    t.after(() => setRuntimeLocale(null));
    const f = await fixture(t, ['P'], { start: false });
    const [P] = f.roots;
    const child = path.join(P, 'child'),
        retained = path.join(P, 'retained');
    fs.mkdirSync(child);
    fs.writeFileSync(path.join(child, 'one.txt'), 'isolated readonly search');
    const id = f.add(child, 'one.txt', [P]);
    f.rows.get(id).filename = 'one.txt';
    f.storage.scannerState.roots[retained] = { last_full_scan: 1, last_scan_at: 1, total_files: 1, paused: true };
    f.storage.scannerState.unavailable_roots = {
        [child]: { since: 1, last_count: 1 },
        [retained]: { since: 1, last_count: 1 }
    };
    await f.storage.saveScannerState();
    const disk = f.disk();
    const state = clone(f.storage.scannerState);
    const oldBaseline = f.worker._lastConfig;
    f.worker._readonlyMode = true;
    f.worker.status = 'readonly';
    for (const method of ['upsert', 'update', 'delete'])
        t.mock.method(f.db, method, async () => assert.fail('readonly database write: ' + method));
    t.mock.method(f.storage, '_writeScannerStateSnapshot', async () => assert.fail('readonly state write'));
    t.mock.method(f.worker, '_startScanner', async () => assert.fail('readonly scanner start'));
    const search = f.db.search;
    t.mock.method(f.db, 'search', async (conditions) => {
        const filenameCondition = conditions.find((condition) =>
            (condition.or ?? [condition]).every(
                (child) => child.field === 'filename' && child.operator === 'contains_literal'
            )
        );
        const result = await search(conditions.filter((condition) => condition !== filenameCondition));
        if (filenameCondition) {
            const alternatives = filenameCondition.or ?? [filenameCondition];
            result.items = result.items.filter((row) =>
                alternatives.some((condition) => row.item.filename?.includes(condition.value))
            );
        }
        return result;
    });
    const keywordSearch = () => f.worker.searchIndexedFiles('one', { routes: ['keyword'] });
    const scopedSearch = (root) =>
        f.worker.searchIndexedFiles('one', { routes: [], scope: { type: 'path', path: root } });
    const light = () =>
        f.worker._buildLightweightStatusSnapshot({
            status: 'readonly',
            platform: 'darwin',
            isOpenHarmony: false,
            homePath: '/test'
        });
    assert.equal(f.worker._getEffectiveUnavailableRoots()[child], undefined);
    assert.deepEqual(
        (await keywordSearch()).results.map((result) => result.path),
        [id]
    );
    await f.worker.applicationConfigChanged({ entries: [entry(P), entry(child), entry(retained)] });
    const added = await f.worker.getFileSystemStatus();
    assert.deepEqual(
        added.sources.map((source) => source.root),
        [P, child, retained]
    );
    assert.ok(added.unavailable_roots[child]);
    assert.ok(added.unavailable_roots[retained]);
    assert.deepEqual(light().unavailable_roots, added.unavailable_roots);
    assert.equal((await keywordSearch()).results.length, 0);
    assert.equal((await scopedSearch(child)).code, CODES.INVALID_SCOPE);
    await f.worker.applicationConfigChanged(f.config([P]));
    const removed = await f.worker.getFileSystemStatus();
    assert.deepEqual(
        removed.sources.map((source) => source.root),
        [P]
    );
    assert.equal(removed.unavailable_roots[child], undefined);
    assert.ok(removed.unavailable_roots[retained]);
    assert.deepEqual(light().unavailable_roots, removed.unavailable_roots);
    assert.deepEqual(
        (await keywordSearch()).results.map((result) => result.path),
        [id]
    );
    assert.equal((await scopedSearch(child)).code, undefined);
    await f.worker.applicationConfigChanged({ entries: [entry(P, ['child/**'])] });
    assert.deepEqual((await f.worker.getFileSystemStatus()).sources[0].entry.exclude_patterns, ['child/**']);
    assert.deepEqual(light().sources[0].entry.exclude_patterns, ['child/**']);
    assert.equal((await keywordSearch()).results.length, 0);
    assert.equal((await scopedSearch(retained)).code, CODES.INVALID_SCOPE);
    assert.equal(f.worker._lastConfig, oldBaseline);
    assert.deepEqual(f.storage.scannerState, state);
    assert.deepEqual(f.disk(), disk);
    assert.equal(f.worker.scanners.size, 0);
    assert.equal(f.worker._pendingConfigChange, null);
});
