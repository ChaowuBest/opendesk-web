import assert from 'node:assert/strict';
import { test } from 'node:test';
import fastGlob from 'fast-glob';
import fs from 'node:fs';
import { parseHTML } from 'linkedom';
import { FileTreeChecks } from '../../../../main/applications/filemgr/renderer/tree/fileTreeChecks.js';
import { Readable } from 'node:stream';
import FileManagerWorker from '../../../../main/applications/filemgr/worker.js';
import {
    FSStorage,
    NORMAL_SCAN_INTERVAL_MS,
    WORKSPACE_SCAN_INTERVAL_MS
} from '../../../../main/applications/filemgr/storage.js';
import {
    resolveFilemgrSearchScopeForEntries,
    normalizeFilemgrSearchScope
} from '../../../../main/applications/filemgr/search/indexed.js';
import { applyClick } from '../../../../main/applications/filemgr/renderer/tree/checkbox.js';
import { listDirectory } from '../../../../main/applications/filemgr/renderer/adapter.js';
import { setPlatform, __resetForTesting } from '../../../../main/applications/filemgr/renderer/state.js';
import { withMemoryStateWriter } from './recovery-fixture.js';

async function withPlatform(platform, run) {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: platform });
    try {
        await run();
    } finally {
        Object.defineProperty(process, 'platform', descriptor);
    }
}

const entry = (root) => ({ root, include_patterns: ['**/*'], exclude_patterns: [] });
function workerFor(roots) {
    const worker = Object.create(FileManagerWorker.prototype);
    worker.config = worker._lastConfig = { entries: roots.map(entry) };
    worker.scanners = new Map();
    worker._pendingConfigChange = worker._pendingWorkspaceChange = null;
    worker._pendingSourceControls = new Set();
    worker._pendingEmbeddingConfigChange = false;
    worker._embeddingQueueActive = worker._embeddingQueueScheduled = false;
    worker.taskQueue = { add: () => Promise.resolve() };
    worker.storage = withMemoryStateWriter({
        mode: 'base-only',
        scannerState: {
            roots: Object.fromEntries(roots.map((root) => [root, { last_full_scan: 0 }])),
            unavailable_roots: {}
        },
        isDeferred: () => false,
        syncEmbeddingMode: async () => {},
        saveScannerState: async () => {},
        saveFiles: async () => ({ saved: 1, failed: 0 }),
        removeDeletedFiles: async () => {}
    });
    return worker;
}

test('scanner resolves only Windows drive roots and keeps source/state/storage identity', async () => {
    const originalStream = fastGlob.stream;
    const originalLstat = fs.lstat;
    fs.lstat = (_path, callback) =>
        callback(null, {
            size: 1,
            mtimeMs: 1,
            birthtimeMs: 1,
            atimeMs: 1,
            isDirectory: () => false,
            isFile: () => true
        });
    try {
        for (const platform of ['win32', 'darwin']) {
            await withPlatform(platform, async () => {
                for (const root of ['D:', 'D:/', 'D:\\', '/ordinary', 'D:/docs']) {
                    const worker = workerFor([root]);
                    let cwd;
                    const identities = [];
                    fastGlob.stream = (_patterns, options) => {
                        cwd = options.cwd;
                        return Readable.from([
                            {
                                path: 'D:/docs/a.txt',
                                name: 'a.txt',
                                stats: {
                                    size: 1,
                                    mtimeMs: 1,
                                    birthtimeMs: 1,
                                    atimeMs: 1,
                                    isDirectory: () => false
                                }
                            }
                        ]);
                    };
                    worker.storage.saveFiles = async (_files, id) => {
                        identities.push(id);
                        return { saved: 1, failed: 0 };
                    };
                    worker.storage.removeDeletedFiles = async (id) => identities.push(id);
                    await worker._startScanners(worker.config.entries);
                    const scanner = worker.scanners.get(root);
                    await scanner.scan();
                    assert.equal(cwd, platform === 'win32' && /^D:[/\\]?$/.test(root) ? 'D:/' : root);
                    assert.equal(scanner.root, root);
                    assert.equal(scanner.entry.root, root);
                    assert.equal(scanner.state, worker.storage.scannerState.roots[root]);
                    assert.deepEqual(identities, [root, root]);
                    await scanner.stop();
                }
            });
        }
    } finally {
        fastGlob.stream = originalStream;
        fs.lstat = originalLstat;
    }
});

test('configured and unavailable drive roots are interpreted without weakening request validation', async () => {
    await withPlatform('win32', async () => {
        for (const root of ['D:', 'D:/', 'D:\\']) {
            const entries = [entry(root)];
            assert.equal(
                resolveFilemgrSearchScopeForEntries({ type: 'path', path: 'D:/docs' }, { entries }).effectiveScope.path,
                'D:/docs'
            );
            assert.throws(() =>
                resolveFilemgrSearchScopeForEntries(
                    { type: 'path', path: 'D:/docs' },
                    { entries, unavailableRoots: { 'D:': {} } }
                )
            );
            assert.throws(() => resolveFilemgrSearchScopeForEntries({ type: 'path', path: 'E:/docs' }, { entries }));
            assert.equal(entries[0].root, root);
        }
    });
    await withPlatform('darwin', async () => {
        assert.throws(() =>
            resolveFilemgrSearchScopeForEntries({ type: 'path', path: 'D:/docs' }, { entries: [entry('D:')] })
        );
        assert.equal(
            resolveFilemgrSearchScopeForEntries(
                { type: 'path', path: '/ordinary/docs' },
                { entries: [entry('/ordinary')] }
            ).effectiveScope.path,
            '/ordinary/docs'
        );
    });
    for (const path of ['D:', 'D:relative', 'D://docs', 'D:/../docs', './docs', '/ordinary/./docs']) {
        assert.throws(() => normalizeFilemgrSearchScope({ type: 'path', path }));
    }
});

test('directory adapter waits for platform, converts Windows roots and preserves ordinary/macOS paths', async () => {
    const previousWindow = globalThis.window;
    const requests = [];
    globalThis.window = {
        workspaceAPI: {
            listDirectory: async (path) => {
                requests.push(path);
                return [];
            }
        }
    };
    try {
        __resetForTesting();
        for (const root of ['D:', 'D:/', 'D:\\']) await assert.rejects(listDirectory(root));
        assert.deepEqual(requests, []);
        setPlatform('win32');
        for (const root of ['D:', 'D:/', 'D:\\', 'D:/docs']) await listDirectory(root);
        setPlatform('darwin');
        for (const root of ['D:', 'D:/', 'D:\\', '/ordinary']) await listDirectory(root);
        assert.deepEqual(requests, ['D:/', 'D:/', 'D:/', 'D:/docs', 'D:', 'D:/', 'D:\\', '/ordinary']);
    } finally {
        globalThis.window = previousWindow;
        __resetForTesting();
    }
});

test('checkbox edits preserve independent existing root identities and do not detach unrelated sources', async () => {
    for (const root of ['D:', 'D:/', 'D:\\', '/docs/']) {
        const before = [entry(root), entry('D:/nested')];
        const after = applyClick('E:/docs', before, {}).nextEntries;
        assert.deepEqual(
            after.slice(0, 2).map((it) => it.root),
            before.map((it) => it.root)
        );
        const worker = workerFor([]);
        worker.storage.detachRootForConfigChange = async () => assert.fail('unexpected detach');
        await worker._detachRemovedRoots({ entries: before }, { entries: after });
        if (root.startsWith('D:')) {
            const excluded = applyClick('D:/child', [entry(root)], {}).nextEntries;
            assert.equal(excluded[0].root, root);
            assert.ok(excluded[0].exclude_patterns.includes('child/**'));
            const restored = applyClick('D:/child', excluded, {}).nextEntries;
            assert.equal(restored[0].root, root);
        }
    }
});

test('storage prefix queries resolve drive roots while multi-source refs remain distinct', async () => {
    await withPlatform('win32', async () => {
        const storage = Object.create(FSStorage.prototype);
        storage.scannerState = { roots: {}, embedding_generation: 0 };
        let bounds;
        storage.storage = {
            search: async (conditions) => {
                bounds = conditions;
                return { items: [] };
            },
            countGrouped: async (_fields, conditions) => {
                bounds = conditions;
                return [];
            }
        };
        for (const root of ['D:', 'D:/', 'D:\\']) {
            await storage._searchItemsUnderRoot(root);
            assert.equal(bounds[1].value, 'D:/');
            await storage._aggregatePerRootCounts(root);
            assert.equal(bounds[1].value, 'D:/');
        }
        const row = {
            item_id: 'D:/nested/a.txt',
            root_refs: JSON.stringify(['D:', 'D:/', 'D:\\', 'D:/nested']),
            ref_count: 4
        };
        storage.storage.search = async () => ({ items: [{ item: row }] });
        storage.storage.update = async (items) => Object.assign(row, items[0]);
        storage.storage.delete = async () => assert.fail('other refs must protect record');
        await storage.removeDeletedFiles('D:', new Set());
        assert.deepEqual(JSON.parse(row.root_refs), ['D:/', 'D:\\', 'D:/nested']);
        assert.equal(row.ref_count, 3);
    });
});

test('workspace matching prefers exact source identity and uses effective/runnable/visible roots', async () => {
    await withPlatform('win32', async () => {
        const worker = workerFor(['D:', 'D:/', 'D:\\']);
        worker._currentWorkspace = 'D:\\';
        assert.equal(worker._getScanIntervalForRoot('D:\\'), WORKSPACE_SCAN_INTERVAL_MS);
        assert.equal(worker._getScanIntervalForRoot('D:'), NORMAL_SCAN_INTERVAL_MS);
        worker._lastConfig.entries = [entry('D:')];
        assert.equal(worker._getScanIntervalForRoot('D:'), WORKSPACE_SCAN_INTERVAL_MS);
        worker._getDefaultWorkspace = () => 'D:\\';
        const light = worker._buildLightweightStatusSnapshot({ platform: 'win32' });
        assert.equal(light.sources[0].is_workspace, true);
        worker.status = 'readonly';
        worker._readonlyMode = true;
        worker._buildAlerts = () => [];
        worker.storage.getStatus = async () => ({});
        worker.storage.getPerRootCounts = async () => new Map();
        assert.equal((await worker.getFileSystemStatus()).sources[0].is_workspace, true);
        const originalState = worker.storage.scannerState.roots['D:'];
        worker.storage.scannerState.roots = { 'D:': originalState };
        originalState.paused = true;
        worker.runSequentially = async (fn) => fn();
        worker._emitStatusChanged = async () => {};
        worker.getFileSystemStatus = async () => ({});
        let requested = 0;
        worker.scanners.set('D:', { requestImmediateScan: () => requested++ });
        await worker.workspaceChanged('D:\\');
        assert.equal(worker.storage.scannerState.roots['D:'], originalState);
        assert.equal(originalState.paused, true);
        assert.deepEqual(Object.keys(worker.storage.scannerState.roots), ['D:']);
        assert.equal(requested, 0, 'readonly workspace matching must not schedule a write scan');
        worker.storage.mode = 'full';
        let priority;
        worker.storage.processEmbeddingQueue = async (_yield, opts) => {
            priority = opts.currentWorkspace;
        };
        worker.taskQueue.add = (fn) => Promise.resolve().then(fn);
        worker._enqueueEmbeddingQueue();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(priority, undefined, 'all effective roots paused: no embedding work');
        originalState.paused = false;
        worker._enqueueEmbeddingQueue();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(priority, 'D:');
    });
});

test('tree root, source navigation and expansion all reach the drive-aware adapter', async () => {
    const names = ['window', 'document', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame'];
    const previous = names.map((name) => globalThis[name]);
    const { window, document } = parseHTML('<html><body></body></html>');
    Object.assign(globalThis, {
        window,
        document,
        ResizeObserver: class {
            observe() {}
            disconnect() {}
        },
        requestAnimationFrame: (callback) => {
            callback();
            return 1;
        },
        cancelAnimationFrame: () => {}
    });
    const requests = [];
    window.workspaceAPI = {
        listDirectory: async (path) => {
            requests.push(path);
            return path === 'D:/' ? [{ path: 'D:/docs', name: 'docs', isDirectory: true }] : [];
        }
    };
    setPlatform('win32');
    const tree = new FileTreeChecks({ listDirectory, listDrives: async () => [], onSelect: () => {} });
    try {
        await tree.setRootEntry({ path: 'D:\\', name: 'D:', isDirectory: true });
        await tree.setRoot('D:/');
        await tree.setRootEntryAndExpandTo({ path: 'D:', name: 'D:', isDirectory: true }, 'D:/docs');
        assert.ok(requests.length >= 3);
        assert.ok(requests.every((path) => path === 'D:/' || path === 'D:/docs'));
        assert.ok(requests.includes('D:/'));
    } finally {
        tree.destroy();
        names.forEach((name, index) => {
            globalThis[name] = previous[index];
        });
        __resetForTesting();
    }
});
