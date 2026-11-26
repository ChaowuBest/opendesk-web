import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import FileManagerWorker from '../../../../main/applications/filemgr/worker.js';
import { FSStorage } from '../../../../main/applications/filemgr/storage.js';
import { scanPath } from './fixture-paths.js';
import { fixture as recoveryFixture, clone, deferred } from './recovery-fixture.js';
import { resolveFilemgrSearchScopeForEntries } from '../../../../main/applications/filemgr/search/indexed.js';

test('fixture paths match Windows scanner separators without rewriting POSIX backslash filenames', () => {
    assert.equal(scanPath('C:\\fixture\\bad/file.txt', 'win32'), 'C:/fixture/bad/file.txt');
    assert.equal(scanPath('\\\\server\\share\\file.txt', 'win32'), '//server/share/file.txt');
    assert.equal(scanPath('/tmp/a\\b/file.txt', 'darwin'), '/tmp/a\\b/file.txt');
    assert.equal(scanPath('/tmp/a\\b/file.txt', 'linux'), '/tmp/a\\b/file.txt');
    assert.equal(scanPath('C:/fixture/bad', 'win32'), scanPath('C:\\fixture\\bad', 'win32'));
});

test('Windows fixture IDs reach the real storage cleanup query while source references keep their identity', async () => {
    const root = 'C:\\fixture\\parent';
    const otherRoot = 'C:\\fixture';
    const id = scanPath(path.win32.join(root, 'shared.txt'), 'win32');
    const rows = new Map([
        [id, { item_id: id, type: 'file', root_refs: JSON.stringify([root, otherRoot]), ref_count: 2 }]
    ]);
    const storage = Object.create(FSStorage.prototype);
    storage.storage = {
        search: async (conditions) => ({
            items: [...rows.values()]
                .filter((row) =>
                    conditions.every(({ field, operator, value }) => {
                        if (operator === '=') return row[field] === value;
                        if (operator === '>=') return row[field] >= value;
                        if (operator === '<') return row[field] < value;
                        throw Error('unexpected fixture query operator');
                    })
                )
                .map((item) => ({ item }))
        }),
        update: async (items) => items.forEach((item) => Object.assign(rows.get(item.item_id), item)),
        delete: async () => assert.fail('shared files must survive source removal')
    };
    assert.deepEqual(await storage._removeRootFromItems(root), { deleted: 0, detached: 1 });
    assert.deepEqual(JSON.parse(rows.get(id).root_refs), [otherRoot]);
});

async function fixture(t, files = ['bad/old.txt', 'good/live.txt', 'bad-backup/live.txt']) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'filemgr-errors-'));
    const root = path.join(directory, 'files');
    const stateDirectory = path.join(directory, 'state');
    fs.mkdirSync(root);
    fs.mkdirSync(stateDirectory);
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    for (const file of files) {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), file);
    }
    const state = { last_full_scan: 0, last_scan_at: null, total_files: 81, last_file_count: 81 };
    const rows = new Map();
    const storage = new FSStorage(stateDirectory);
    storage.retrieval.prepare = async () => {};
    Object.assign(storage, {
        mode: 'base-only',
        scannerState: { roots: { [root]: state }, unavailable_roots: {} },
        isDeferred: () => false,
        saveFiles: async (files, source) => {
            for (const file of files)
                rows.set(file.path, {
                    item_id: file.path,
                    modified: file.modified,
                    root_refs: JSON.stringify([source]),
                    ref_count: 1
                });
            return { saved: files.length, failed: 0, failures: [] };
        },
        storage: {
            search: async (conditions) => ({
                items: [...rows.values()]
                    .filter((item) =>
                        conditions.every(
                            (c) =>
                                c.field !== 'item_id' ||
                                (c.operator === '>=' ? item.item_id >= c.value : item.item_id < c.value)
                        )
                    )
                    .map((item) => ({ item }))
            }),
            delete: async (ids) => ids.forEach((id) => rows.delete(id)),
            update: async (items) => items.forEach((item) => Object.assign(rows.get(item.item_id), item))
        }
    });
    const worker = Object.create(FileManagerWorker.prototype);
    Object.assign(worker, {
        config: { entries: [{ root, include_patterns: ['**/*'], exclude_patterns: [] }] },
        storage,
        scanners: new Map(),
        _pendingConfigChange: null,
        _pendingWorkspaceChange: null,
        _pendingSourceControls: new Set(),
        taskQueue: { add: () => Promise.resolve() }
    });
    await worker._startScanners(worker.config.entries);
    const scanner = worker.scanners.get(root);
    t.after(() => scanner.stop());
    const addRow = (file, refs = [root]) => {
        const id = scanPath(path.join(root, file));
        rows.set(id, { item_id: id, root_refs: JSON.stringify(refs), ref_count: refs.length });
        return id;
    };
    return { root, state, storage, scanner, rows, addRow, worker };
}

function inject(t, target, name, replacement) {
    if (target === fs.promises && name === 'lstat') {
        const read = replacement(fs.promises.lstat.bind(fs.promises));
        inject(t, fs, 'lstat', () => (file, callback) => {
            void Promise.resolve()
                .then(() => read(file))
                .then(
                    (stats) => callback(null, stats),
                    (error) => callback(error)
                );
        });
        return;
    }
    const original = target[name];
    target[name] = replacement(original);
    t.after(() => {
        target[name] = original;
    });
}
function ioError(code, target) {
    return Object.assign(new Error(`injected ${code}`), { code, path: target });
}

test('failed subtree and its source refs survive; healthy sibling and overlapping-source cleanup proceed', async (t) => {
    const { root, state, scanner, rows, addRow } = await fixture(t);
    const bad = addRow('bad/deleted.txt', [root, path.join(root, 'bad')]);
    const healthy = addRow('good/deleted.txt');
    const sibling = addRow('bad-backup/deleted.txt', [root, path.join(root, 'bad-backup')]);
    const unknown = addRow('bad/unknown.txt');
    // Simulates Node's unknown-Dirent internal stat failure: error.path points at a child,
    // while the protective range must be the actual readdir argument.
    let readFailures = 0;
    inject(t, fs, 'readdir', (original) => (dir, options, callback) => {
        if (scanPath(dir) === scanPath(path.join(root, 'bad'))) {
            readFailures++;
            callback(ioError('EACCES', path.join(dir, 'unknown.txt')));
        } else original(dir, options, callback);
    });
    await scanner.scan();
    assert.equal(readFailures, 1);
    assert.ok(rows.has(bad) && rows.has(unknown));
    assert.deepEqual(JSON.parse(rows.get(bad).root_refs), [root, path.join(root, 'bad')]);
    assert.equal(rows.has(healthy), false);
    assert.deepEqual(JSON.parse(rows.get(sibling).root_refs), [path.join(root, 'bad-backup')]);
    assert.ok(rows.has(scanPath(path.join(root, 'good/live.txt'))));
    assert.ok(state.last_full_scan > 0);
    assert.equal(state.total_files, 81);
    assert.equal(state.last_file_count, 81);
});

test('single attribute errors and files replaced by links/directories retain observed paths without updates', async (t) => {
    const { root, scanner, rows, addRow } = await fixture(t, [
        'denied.txt',
        'directory.txt',
        'link.txt',
        'healthy.txt'
    ]);
    const names = ['denied.txt', 'directory.txt', 'link.txt'];
    for (const name of names) addRow(name, [root, '/other']);
    let attributeFailures = 0;
    inject(t, fs.promises, 'lstat', (original) => async (file) => {
        if (scanPath(file) === scanPath(path.join(root, 'denied.txt'))) {
            attributeFailures++;
            throw ioError('EPERM', file);
        }
        if (names.slice(1).includes(path.basename(file))) return { isFile: () => false };
        return original(file);
    });
    await scanner.scan();
    assert.equal(attributeFailures, 1);
    for (const name of names) {
        const row = rows.get(scanPath(path.join(root, name)));
        assert.deepEqual(JSON.parse(row.root_refs), [root, '/other']);
        assert.equal(row.modified, undefined);
    }
    assert.ok(rows.get(scanPath(path.join(root, 'healthy.txt'))).modified > 0);
});

test('partial full advances the baseline; recovered old files retry in later full despite incremental skipping', async (t) => {
    const { root, scanner, state, rows, addRow } = await fixture(t);
    const old = path.join(root, 'bad/old.txt');
    const oldId = scanPath(old);
    const obsolete = addRow('bad/deleted.txt');
    fs.utimesSync(old, new Date(1000), new Date(1000));
    let broken = true;
    let readFailures = 0;
    inject(t, fs, 'readdir', (original) => (dir, options, callback) => {
        if (broken && scanPath(dir) === scanPath(path.join(root, 'bad'))) {
            readFailures++;
            callback(ioError('EIO', dir));
        } else original(dir, options, callback);
    });
    await scanner.scan();
    assert.equal(readFailures, 1);
    assert.ok(state.last_full_scan > 0);
    assert.equal(rows.has(oldId), false);
    broken = false;
    scanner._counter = 1;
    assert.equal(scanner._getScanDepth(), 4);
    await scanner.scan();
    assert.equal(rows.has(oldId), false);
    assert.ok(rows.has(obsolete));
    scanner._counter = 32;
    await scanner.scan();
    assert.ok(rows.has(oldId));
    assert.equal(rows.has(obsolete), false);
    assert.equal(readFailures, 1);
});

for (const stage of ['before', 'metadata', 'batch', 'cleanup']) {
    for (const control of ['stop', 'yield']) {
        test(`${control} at ${stage} does not commit checkpoint or a late batch`, async (t) => {
            const files = Array.from({ length: 501 }, (_, i) => `dir/f${i}.txt`);
            const { scanner, state, storage } = await fixture(t, files);
            let yielding = false;
            scanner._shouldYield = () => yielding;
            const controlNow = () => {
                if (control === 'stop') void scanner.stop();
                else yielding = true;
            };
            let writes = 0;
            let stateSaves = 0;
            let cleaned = 0;
            const saveFiles = storage.saveFiles;
            storage.saveFiles = async (...args) => {
                writes++;
                const result = await saveFiles(...args);
                if (stage === 'batch') controlNow();
                return result;
            };
            storage.saveScannerState = async () => {
                stateSaves++;
            };
            storage.removeDeletedFiles = async () => {
                cleaned++;
                if (stage === 'cleanup') controlNow();
            };
            if (stage === 'before') controlNow();
            if (stage === 'metadata')
                inject(t, fs.promises, 'lstat', (original) => async (...args) => {
                    const result = await original(...args);
                    controlNow();
                    return result;
                });
            await scanner.scan();
            assert.equal(state.last_full_scan, 0);
            assert.equal(state.last_scan_at, null);
            assert.equal(stateSaves, 0);
            assert.equal(writes, stage === 'batch' ? 1 : stage === 'cleanup' ? 2 : 0);
            assert.equal(cleaned, stage === 'cleanup' ? 1 : 0);
            await new Promise((resolve) => setTimeout(resolve, 10));
            assert.equal(stateSaves, 0);
        });
    }
}

for (const stage of ['readdir', 'lstat', 'save', 'delete']) {
    test(`unknown ${stage} error aborts without committing a checkpoint`, async (t) => {
        const { root, scanner, state, storage, rows, addRow } = await fixture(t);
        const keep = addRow('good/deleted.txt');
        const error = ioError('BUG', root);
        if (stage === 'readdir') inject(t, fs, 'readdir', () => (_dir, _opts, cb) => cb(error));
        if (stage === 'lstat')
            inject(t, fs.promises, 'lstat', () => async () => {
                throw error;
            });
        if (stage === 'save')
            storage.saveFiles = async () => {
                throw error;
            };
        if (stage === 'delete')
            storage.storage.delete = async () => {
                throw error;
            };
        await assert.rejects(scanner.scan(), (err) => err === error);
        assert.equal(state.last_full_scan, 0);
        assert.equal(state.last_scan_at, null);
        assert.ok(rows.has(keep));
    });
}

test('root read failure preserves unavailable identity, prior references and checkpoints', async (t) => {
    const { root, scanner, state, storage, rows, addRow } = await fixture(t, []);
    const keep = addRow('old.txt', [root, '/other']);
    storage.scannerState.unavailable_roots[root] = { last_count: 81 };
    inject(t, fs, 'readdir', () => (_dir, _opts, cb) => cb(ioError('ENOENT', root)));
    await scanner.scan();
    assert.deepEqual(JSON.parse(rows.get(keep).root_refs), [root, '/other']);
    assert.equal(state.last_full_scan, 0);
    assert.equal(state.total_files, 81);
    assert.deepEqual(storage.scannerState.unavailable_roots[root], { last_count: 81 });
    const disk = JSON.parse(fs.readFileSync(storage._scannerStatePath, 'utf8'));
    assert.deepEqual(disk.unavailable_roots[root], { last_count: 81 });
});

for (const marked of [false, true])
    test(`offline root ${marked ? 'keeps its existing marker' : 'becomes unavailable'} until a readable full scan`, async (t) => {
        const files = Array.from({ length: 60 }, (_, i) => `f${i}.txt`);
        const f = await recoveryFixture(t, ['A'], { files });
        const [root] = f.roots;
        f.add(root, 'f0.txt', [root, '/other']);
        const before = clone(f.storage.scannerState.roots[root]);
        const rows = clone([...f.rows]);
        if (marked) {
            f.storage.scannerState.unavailable_roots[root] = { since: 123, last_count: 60 };
            await f.storage.saveScannerState();
        }
        fs.rmSync(root, { recursive: true });
        const scanner = f.worker.scanners.get(root);
        scanner.requestImmediateScan();
        await f.worker.taskQueue.onIdle();
        const marker = f.storage.scannerState.unavailable_roots[root];
        assert.ok(marker);
        if (marked) assert.deepEqual(marker, { since: 123, last_count: 60 });
        assert.deepEqual(f.disk().unavailable_roots[root], marker);
        assert.deepEqual(f.storage.scannerState.roots[root], before);
        assert.deepEqual([...f.rows], rows);
        assert.equal((await f.worker.getFileSystemStatus()).sources[0].state, 'unavailable');
        const scope = () =>
            resolveFilemgrSearchScopeForEntries(
                { type: 'path', path: root },
                {
                    entries: f.worker.config.entries,
                    unavailableRoots: f.storage.scannerState.unavailable_roots
                }
            );
        assert.throws(scope);
        scanner.requestImmediateScan();
        await f.worker.taskQueue.onIdle();
        assert.deepEqual(f.disk().unavailable_roots[root], marker);
        fs.mkdirSync(root);
        for (const file of files) fs.writeFileSync(path.join(root, file), 'recovered');
        scanner.requestImmediateScan();
        await f.worker.taskQueue.onIdle();
        assert.equal(f.storage.scannerState.unavailable_roots[root], undefined);
        assert.equal(f.disk().unavailable_roots[root], undefined);
        assert.equal((await f.worker.getFileSystemStatus()).sources[0].state, 'completed');
        assert.doesNotThrow(scope);
        assert.equal(f.rows.size, 60);
    });

test('root permission failure marks a small source unavailable without changing the empty-scan threshold', async (t) => {
    const f = await recoveryFixture(t, ['A']);
    const [root] = f.roots;
    inject(t, fs, 'readdir', () => (_dir, _opts, cb) => cb(ioError('EACCES', root)));
    f.worker.scanners.get(root).requestImmediateScan();
    await f.worker.taskQueue.onIdle();
    assert.equal(f.disk().unavailable_roots[root].last_count, 1);
    assert.equal((await f.worker.getFileSystemStatus()).sources[0].state, 'unavailable');
    assert.equal(f.rows.size, 1);
});

test('a missing root is unavailable even when glob tasks start below it', async (t) => {
    const f = await recoveryFixture(t, ['A'], { files: ['sub/file.txt'] });
    const [root] = f.roots;
    const config = f.config([root]);
    config.entries[0].include_patterns = ['sub/*'];
    await f.worker.applicationConfigChanged(config);
    await f.worker.taskQueue.onIdle();
    fs.rmSync(root, { recursive: true });
    f.worker.scanners.get(root).requestImmediateScan();
    await f.worker.taskQueue.onIdle();
    assert.ok(f.disk().unavailable_roots[root]);
    assert.equal((await f.worker.getFileSystemStatus()).sources[0].state, 'unavailable');
    assert.equal(f.rows.size, 1);
});

test('a missing glob base alone preserves its records without marking a readable root unavailable', async (t) => {
    const { root, scanner, storage, rows, addRow, state } = await fixture(t, ['sub/file.txt']);
    scanner.entry.include_patterns = ['sub/*'];
    const id = addRow('sub/file.txt', [root, '/other']);
    fs.rmSync(path.join(root, 'sub'), { recursive: true });
    await scanner.scan();
    assert.equal(storage.scannerState.unavailable_roots[root], undefined);
    assert.deepEqual(JSON.parse(rows.get(id).root_refs), [root, '/other']);
    assert.ok(state.last_full_scan > 0);
});

test('a readable recovered root clears unavailable even while one child remains unreadable', async (t) => {
    const { root, scanner, storage, state, rows, addRow } = await fixture(t);
    const protectedId = addRow('bad/deleted.txt', [root, '/other']);
    storage.scannerState.unavailable_roots[root] = { since: 123, last_count: 81 };
    await storage.saveScannerState();
    inject(t, fs, 'readdir', (original) => (directory, options, callback) => {
        if (scanPath(directory) === scanPath(path.join(root, 'bad'))) callback(ioError('EACCES', directory));
        else original(directory, options, callback);
    });
    await scanner.scan();
    assert.deepEqual(JSON.parse(rows.get(protectedId).root_refs), [root, '/other']);
    assert.ok(rows.has(scanPath(path.join(root, 'good/live.txt'))));
    assert.equal(storage.scannerState.unavailable_roots[root], undefined);
    assert.equal(JSON.parse(fs.readFileSync(storage._scannerStatePath, 'utf8')).unavailable_roots[root], undefined);
    assert.ok(state.last_full_scan > 0);
    scanner._counter = 1;
    assert.equal(scanner._getScanDepth(), 4);
});

test('stop during the fallback root read leaves markers and checkpoints untouched', async (t) => {
    const { root, scanner, storage, state } = await fixture(t, []);
    scanner.entry.include_patterns = ['missing/*'];
    const entered = deferred(t),
        gate = deferred(t);
    t.mock.method(fs.promises, 'readdir', async () => {
        entered.resolve();
        await gate.promise;
        throw ioError('ENOENT', root);
    });
    const scanning = scanner.scan();
    await entered.promise;
    await scanner.stop();
    gate.resolve();
    await scanning;
    assert.equal(state.last_full_scan, 0);
    assert.equal(state.last_scan_at, null);
    assert.equal(storage.scannerState.unavailable_roots[root], undefined);
});

test('normal empty source still uses the existing >50 protection; small empty sources clean normally', async (t) => {
    const { root, scanner, state, rows, addRow, storage } = await fixture(t, []);
    const id = addRow('deleted.txt');
    await scanner.scan();
    assert.equal(state.last_full_scan, 0);
    assert.ok(rows.has(id));
    assert.ok(storage.scannerState.unavailable_roots[root]);
    state.last_file_count = 2;
    await scanner.scan();
    assert.ok(state.last_full_scan > 0);
    assert.equal(rows.has(id), false);
});

test('error log sample limits never truncate failure protection; successful later full removes stale refs', async (t) => {
    const names = Array.from({ length: 45 }, (_, i) => `restricted${i}/live.txt`);
    const { root, scanner, rows, addRow } = await fixture(t, [...names, 'healthy/live.txt']);
    const protectedPaths = names.map((name) => addRow(name.replace('live', 'deleted'), [root, '/other']));
    const gone = addRow('healthy/deleted.txt');
    let broken = true;
    let readFailures = 0;
    inject(t, fs, 'readdir', (original) => (dir, opts, cb) => {
        if (broken && path.basename(dir).startsWith('restricted')) {
            readFailures++;
            cb(ioError('EACCES', dir));
        } else original(dir, opts, cb);
    });
    await scanner.scan();
    assert.equal(readFailures, 45);
    for (const id of protectedPaths) assert.deepEqual(JSON.parse(rows.get(id).root_refs), [root, '/other']);
    assert.equal(rows.has(gone), false);
    broken = false;
    scanner._counter = 32;
    await scanner.scan();
    for (const id of protectedPaths) assert.deepEqual(JSON.parse(rows.get(id).root_refs), ['/other']);
    assert.equal(readFailures, 45);
});

test('failed-range matching handles Windows separators/root/trailing slash and preserves POSIX backslash names', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    const storage = Object.create(FSStorage.prototype);
    try {
        for (const [platform, failed, ids, expected] of [
            ['win32', ['D:/blocked/'], ['D:/blocked/a', 'D:/blocked-backup/a', 'D:/healthy/a'], ['D:/blocked/a']],
            ['win32', ['D:\\'], ['D:/blocked/a', 'D:/healthy/a'], ['D:/blocked/a', 'D:/healthy/a']],
            ['darwin', ['/tmp/a\\b/'], ['/tmp/a\\b/x', '/tmp/a/b/x', '/tmp/a\\b-backup/x'], ['/tmp/a\\b/x']]
        ]) {
            Object.defineProperty(process, 'platform', { value: platform });
            const protectedIds = [];
            storage._removeRootFromItems = async (_root, shouldRemove) => {
                for (const id of ids) if (!shouldRemove(id)) protectedIds.push(id);
                return { deleted: 0, detached: 0 };
            };
            await storage.removeDeletedFiles('source', new Set(), { failedDirectories: new Set(failed) });
            assert.deepEqual(protectedIds, expected);
        }
    } finally {
        Object.defineProperty(process, 'platform', descriptor);
    }
});

test('workspace filename completion continues to use its existing fast-glob entry point', async (t) => {
    const { root, worker } = await fixture(t, ['nested/needle.txt', 'other.txt', 'node_modules/needle.txt']);
    const result = await worker.searchFilesByKeywordInPath('needle', root);
    assert.deepEqual(
        result.map((row) => row.path),
        [path.join(root, 'nested/needle.txt')]
    );
});
