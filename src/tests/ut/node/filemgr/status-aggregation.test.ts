import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FSStorage, makeSchema } from '../../../../main/applications/filemgr/storage.js';
import { BaseIndexDBWasm } from '../../../../main/services/storage/base-index-db-wasm.js';
import { BaseStorage } from '../../../../main/services/storage/abstract-storage.js';
import { BaseIndexer } from '../../../../main/services/storage/base-indexer.js';

import { BaseIndexDBHm } from '../../../../main/services/storage/base-index-db-hm.js';
import FileManagerWorker from '../../../../main/applications/filemgr/worker.js';
import { parseHTML } from 'linkedom';
import { createSources } from '../../../../main/applications/filemgr/renderer/sources.js';
import { __resetForTesting, setEntries, setSnapshot } from '../../../../main/applications/filemgr/renderer/state.js';
import { FULL_TEXT_RULE_VERSION } from '../../../../main/applications/filemgr/document-retrieval/common/full-text-state.js';
import { BaseIndexDBArkdata } from '../../../../main/services/storage/base-index-db-arkdata.js';
import { logger } from '../../../../main/utils/logger.js';

// Real SQLite, isolated files, no model, app initialization or user profile access.
async function fixture(run: (fss: any, db: BaseIndexDBWasm) => Promise<void>) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'filemgr-status-counts-'));
    const db = new BaseIndexDBWasm(path.join(dir, 'base.db'), makeSchema());
    const indexer = new BaseIndexer(makeSchema(), path.join(dir, 'unused.db'));
    (indexer as any).db = db;
    const storage = Object.create(BaseStorage.prototype);
    storage.baseIndexer = indexer;
    storage.getStatus = async () => ({});
    storage.search = async () => {
        throw new Error('Status must not materialize search results');
    };
    const fss = Object.create(FSStorage.prototype);
    Object.assign(fss, {
        storage,
        mode: 'base-only',
        _pendingStorageClosures: new Set(),
        _fullTextByHolder: new WeakMap([[storage, { bound: true }]]),
        _fullTextPlatformSupported: true,
        scannerState: {
            roots: {},
            unavailable_roots: {},
            bm25_generation: 4,
            bm25_rule_version: FULL_TEXT_RULE_VERSION,
            bm25_reset_pending: false
        }
    });
    fss.retrieval._getSemanticWriteState = async () => null;
    try {
        await run(fss, db);
    } finally {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function row(id: string, refs: unknown, embedded = 0, refCount = 1, type = 'file') {
    return {
        item_id: id,
        item_type: 'file',
        type,
        filename: id,
        ext: 'txt',
        size: 0,
        timestamp: 1,
        root_refs: typeof refs === 'string' ? refs : JSON.stringify(refs),
        ref_count: refCount,
        embedded
    };
}

function canonical(value: string) {
    const normalized = value.replace(/\\/g, '/').replace(/\/+/g, '/');
    return normalized === '/' ? normalized : normalized.replace(/\/+$/, '');
}
function refs(raw: string): string[] {
    try {
        const value = JSON.parse(raw);
        return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];
    } catch {
        return [];
    }
}

function oldCounts(value: any) {
    const { full_text: _ignored, ...counts } = value;
    return counts;
}
function oldMap(value: Map<any, any>) {
    return new Map([...value].map(([root, counts]) => [root, oldCounts(counts)]));
}

async function compare(fss: any, db: BaseIndexDBWasm, roots: string[]) {
    // Independent row-by-row oracle for the existing visibility and counting rules.
    const rows = await db.findAll();
    const visible = rows.filter((r) => r.type === 'file' && r.ref_count > 0);
    const global = await fss.getGlobalFileCounts();
    assert.equal(global.total_files, visible.length);
    assert.equal(global.embedded_count, visible.filter((r) => r.embedded === 1).length);
    assert.equal(global.pending_count, global.total_files - global.embedded_count);
    fss._clearPerRootCountsCache();
    const counts = await fss.getPerRootCounts(roots);
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    try {
        Object.defineProperty(process, 'platform', { value: 'openharmony' });
        fss._clearPerRootCountsCache();
        assert.deepEqual(await fss.getPerRootCounts(roots), counts);
        assert.deepEqual(
            oldMap(await fss.getPerRootCounts(roots)),
            oldMap(counts),
            'Harmony cold refresh must match direct counts'
        );
        assert.deepEqual(
            oldMap(await fss.getPerRootCounts(roots)),
            oldMap(counts),
            'Harmony cache must match direct counts'
        );
    } finally {
        Object.defineProperty(process, 'platform', descriptor);
    }
    assert.deepEqual([...counts.keys()], roots);
    for (const root of roots) {
        const unavailable = fss.scannerState.unavailable_roots[root];
        const prefix = root === '/' ? '/' : root.replace(/\/+$/, '') + '/';
        const members = rows.filter(
            (r) =>
                r.type === 'file' &&
                r.item_id.startsWith(prefix) &&
                refs(r.root_refs).some((ref) => canonical(ref) === canonical(root))
        );
        const total = unavailable ? (unavailable.last_count ?? 0) : members.length;
        const completed = unavailable || fss.mode === 'base-only' ? 0 : members.filter((r) => r.embedded === 1).length;
        const failed = unavailable || fss.mode === 'base-only' ? 0 : members.filter((r) => r.embedded === -2).length;
        assert.deepEqual(
            oldCounts(counts.get(root)),
            {
                total_files: total,
                embedded_count: completed,
                failed_count: failed,
                pending_count: unavailable ? 0 : Math.max(0, total - completed - failed),
                last_scan_at: fss.scannerState.roots[root]?.last_scan_at ?? null
            },
            root
        );
    }
}

test('status aggregates preserve row-by-row semantics across overlap, malformed refs, modes and mutations', async () => {
    await fixture(async (fss, db) => {
        const roots = ['/Docs', '/Docs/sub', '/Docs-other', '/', 'C:/Docs', '/empty', '/missing'];
        fss.scannerState.roots['/Docs'] = { last_scan_at: 123 };
        fss.scannerState.unavailable_roots['/missing'] = { last_count: 42 };
        await db.insertMany([
            row('/Docs/a', ['/Docs', '/Docs/sub'], 1),
            row('/Docs/sub/b', ['/Docs', '/Docs/sub', '/Docs'], -2),
            row('/Docs/sub/c', ['/Docs/sub'], 0),
            row('/Docs/normalized', ['/Docs///', '/Docs'], 1),
            row('/Docs/mixed', [null, 1, '/Docs'], -2),
            row('/Docs/invalid', '{broken', 1),
            row('/Docs/object', '{"root":"/Docs"}', 0),
            row('/Docs/orphan', [], 1, 0),
            row('/Docs/zero-ref', ['/Docs'], 0, 0),
            row('/Docs/other-type', ['/Docs'], 1, 1, 'directory'),
            row('/Docs-other/a', ['/Docs-other']),
            row('/Docs', ['/Docs']),
            row('/root-file', ['/']),
            row('C:/Docs/a', ['C:\\Docs\\'], 1)
        ]);
        for (const mode of ['base-only', 'full']) {
            fss.mode = mode;
            await compare(fss, db, roots);
        }
        await db.delete('/Docs/a');
        await db.update('/Docs/sub/b', { root_refs: JSON.stringify(['/Docs/sub']), ref_count: 1, embedded: 1 });
        await db.update('/Docs/sub/c', { root_refs: '[]', ref_count: 0 });
        await compare(fss, db, roots);
    });
});

test('group counts return compact results and validate fields without a full-record search', async () => {
    await fixture(async (fss, db) => {
        await db.insertMany(Array.from({ length: 2000 }, (_, i) => row('/Docs/' + i, ['/Docs'], i % 2)));
        const groups = await db.countGrouped(
            ['root_refs', 'embedded'],
            [{ field: 'type', operator: '=', value: 'file' }]
        );
        assert.equal(groups.length, 2);
        assert.equal(
            groups.reduce((n, group) => n + group.count, 0),
            2000
        );
        await assert.rejects(db.countGrouped(['unknown']), /field/i);
        await assert.rejects(db.countGrouped(['embedded); DROP TABLE base_index; --']), /field/i);
        await assert.rejects(db.countGrouped([]), /field/i);
        await compare(fss, db, ['/Docs', '/empty']);
    });
});

test('bridge aggregate SQL agrees with WASM, including more than one bridge page', async () => {
    await fixture(async (_fss, db) => {
        await db.insertMany(Array.from({ length: 5001 }, (_, i) => row('/Docs/' + i, ['/Docs'], i % 2)));
        const fields = ['item_id', 'embedded'];
        const conditions = [{ field: 'type', operator: '=' as const, value: 'file' }];
        const expected = await db.countGrouped(fields, conditions);
        const rawSqlite = (db as any).db;
        for (const Backend of [BaseIndexDBHm, BaseIndexDBArkdata]) {
            // Execute each adapter's real SQL against SQLite; no device or native addon required.
            let queries = 0;
            const query = (sql: string, params: any[]) => {
                queries++;
                return rawSqlite.all(sql, params);
            };
            const backend = Object.assign(Object.create(Backend.prototype), {
                tableName: 'base_index',
                validFields: db.getValidFields(),
                ensureInitialized: async () => {},
                queryAllSql: async (sql: string, params: any[]) => query(sql, params)
            });
            const actual = await backend.countGrouped(fields, conditions);
            assert.deepEqual(actual, expected, Backend.name);
            assert.equal(queries, Backend === BaseIndexDBArkdata ? 2 : 1);
        }
    });
});

test('ArkData groups in SQL without the device-incompatible quoted field aliases', async () => {
    await fixture(async (_fss, db) => {
        await db.insertMany([
            ...Array.from({ length: 5001 }, (_, i) => row('/Docs/' + i, ['/Docs'], (i % 3) - 2)),
            row('/Docs/null', null, 1),
            row('/Docs/filtered', ['/Docs'], 1, 0)
        ]);
        const fields = ['root_refs', 'embedded'];
        const conditions = [{ field: 'ref_count', operator: '>' as const, value: 0 }];
        const expected = await db.countGrouped(fields, conditions);
        const queries: string[] = [];
        const backend = Object.assign(Object.create(BaseIndexDBArkdata.prototype), {
            tableName: 'base_index',
            validFields: db.getValidFields(),
            ensureInitialized: async () => {},
            queryAllSql: async (sql: string, params: any[]) => {
                queries.push(sql);
                assert.match(sql, /^SELECT root_refs, embedded, COUNT\(\*\) AS group_count FROM/);
                assert.match(sql, /GROUP BY root_refs, embedded ORDER BY root_refs, embedded LIMIT 5000 OFFSET 0$/);
                return (db as any).db.all(sql, params);
            }
        });
        assert.deepEqual(await backend.countGrouped(fields, conditions), expected);
        assert.equal(queries.length, 1, 'thousands of records should return only the compact groups');
        await assert.rejects(backend.countGrouped([]), /field/i);
        await assert.rejects(backend.countGrouped(['embedded', 'embedded']), /field/i);
        await assert.rejects(backend.countGrouped(['unknown']), /field/i);
        backend.queryAllSql = async () => [];
        assert.deepEqual(await backend.countGrouped(fields), []);
        backend.queryAllSql = async () => [{ root_refs: '[]', embedded: 0, group_count: undefined }];
        await assert.rejects(backend.countGrouped(fields), /count/i);
        backend.queryAllSql = async () => {
            throw new Error('query failed');
        };
        await assert.rejects(backend.countGrouped(fields), /query failed/);
    });
});

test('ArkData handles a full group page, yields, and avoids aggregate-name collisions', async () => {
    let calls = 0;
    let yielded = false;
    let pending: ReturnType<typeof setImmediate>;
    const backend = Object.assign(Object.create(BaseIndexDBArkdata.prototype), {
        tableName: 'base_index',
        validFields: ['category', 'group_count'],
        ensureInitialized: async () => {},
        queryAllSql: async (sql: string) => {
            assert.match(sql, /COUNT\(\*\) AS group_count_1/);
            if (calls++ === 0) {
                assert.match(sql, /OFFSET 0$/);
                pending = setImmediate(() => {
                    yielded = true;
                });
                return Array.from({ length: 5000 }, (_, i) => ({ category: i, group_count: null, group_count_1: 2 }));
            }
            assert.equal(yielded, true);
            assert.match(sql, /OFFSET 5000$/);
            return [];
        }
    });
    try {
        const groups = await backend.countGrouped(['category', 'group_count']);
        assert.equal(groups.length, 5000);
        assert.equal(
            groups.reduce((n, g) => n + g.count, 0),
            10000
        );
        assert.deepEqual(groups[0], { values: { category: 0, group_count: null }, count: 2 });
        assert.equal(calls, 2);
        backend.validFields.push('bad;name');
        await assert.rejects(backend.countGrouped(['bad;name']), /field/i);
        for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 'bad', null]) {
            backend.queryAllSql = async () => [{ category: 1, group_count: value }];
            await assert.rejects(backend.countGrouped(['category']), /count/i);
        }
    } finally {
        clearImmediate(pending!);
    }
});

test('Harmony aggregate refresh coalesces requests and invalidation rejects late cache writes', async () => {
    await fixture(async (fss, db) => {
        await db.insertMany([row('/Docs/a', ['/Docs'], 1)]);
        const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
        const original = fss.storage.countGrouped.bind(fss.storage);
        let release!: () => void;
        const blocker = new Promise<void>((resolve) => {
            release = resolve;
        });
        let calls = 0;
        fss.storage.countGrouped = async (...args: any[]) => {
            calls++;
            await blocker;
            return original(...args);
        };
        try {
            Object.defineProperty(process, 'platform', { value: 'openharmony' });
            const first = fss.getPerRootCounts(['/Docs']);
            const second = fss.getPerRootCounts(['/Docs']);
            assert.equal(calls, 1);
            fss._clearPerRootCountsCache('/Docs');
            release();
            for (const result of await Promise.allSettled([first, second])) {
                assert.equal(result.status, 'rejected');
                assert.equal((result as PromiseRejectedResult).reason.code, 'filemgr_counts_invalidated');
            }
            assert.equal(fss._getAnyCachedPerRootCount('/Docs'), null);
            fss.storage.countGrouped = original;
            fss.mode = 'full';
            await compare(fss, db, ['/Docs']);
        } finally {
            release();
            Object.defineProperty(process, 'platform', descriptor);
        }
    });
});

test('normal status preserves store metadata without reading global file counts', async () => {
    await fixture(async (fss) => {
        fss.storage.getStatus = async () => ({ BaseIndexer: { size: 7 }, ChunkIndexer: { size: 9 } });
        fss.storage.countGrouped = async () => {
            throw new Error('Redundant global count');
        };
        const status = await fss.getStatus();
        assert.equal(status.db_size, 7);
        assert.equal(status.chunk_size, 9);
        assert.equal('total_files' in status, false);
        assert.equal('embedded_count' in status, false);
    });
});

test('WF2 full-text counts are separate from unchanged file and embedding aggregates', async () => {
    await fixture(async (fss, db) => {
        const root = '/mixed';
        fss.mode = 'full';
        const files = [
            ['a.txt', 1, 4],
            ['b.md', -1, 4],
            ['c.docx', -2, 4],
            ['d.txt', 1, 3],
            ['e.json', 1, 4],
            ['f.png', 0, 4],
            ['noext', 0, 4]
        ];
        await db.insertMany(
            files.map(([name, bm25, g], i) => ({
                ...row(root + '/' + name, [root], i % 3 === 0 ? 1 : 0),
                ext: path.extname(String(name)),
                bm25,
                bm25_generation: g,
                modified: 100,
                bm25_modified: 99
            }))
        );
        const baseline = await fss._aggregatePerRootCounts(root);
        assert.equal(baseline.total_files, 7);
        const counts = (await fss.getPerRootCounts([root])).get(root);
        assert.deepEqual(oldCounts(counts), { ...baseline, last_scan_at: null });
        assert.deepEqual(counts.full_text, { indexable: 4, done: 1, pending: 2, failed: 1 });
        fss.scannerState.bm25_reset_pending = true;
        assert.deepEqual((await fss.getPerRootCounts([root])).get(root).full_text, {
            indexable: 4,
            done: 0,
            pending: 4,
            failed: 0
        });
        fss.scannerState.bm25_reset_pending = false;
        fss.scannerState.bm25_rule_version = 0;
        assert.deepEqual((await fss.getPerRootCounts([root])).get(root).full_text, {
            indexable: 4,
            done: 0,
            pending: 4,
            failed: 0
        });
        fss._fullTextByHolder.set(fss.storage, { failure: true });
        const grouped = fss.storage.countGrouped.bind(fss.storage);
        fss.storage.countGrouped = async (fields, conditions) => {
            assert.ok(!fields.includes('bm25'));
            return grouped(fields, conditions);
        };
        assert.equal((await fss.getPerRootCounts([root])).get(root).full_text, undefined);
    });
});

test('WF2 obsolete readonly rule and failed reset persistence stay visibly pending through the real snapshot and DOM', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf2-status-rule-'));
    const docs = path.join(dir, 'docs');
    fs.mkdirSync(docs);
    const entry = { root: docs, include_patterns: ['**/*'], exclude_patterns: [] };
    let owner: any = new FSStorage(path.join(dir, 'app'));
    try {
        await owner.initialize({ syncEmbedding: false });
        const file = path.join(docs, 'one.txt');
        fs.writeFileSync(file, 'hello');
        const stat = fs.statSync(file);
        await owner.saveFiles(
            [{ path: file, filename: 'one.txt', type: 'file', size: stat.size, modified: Math.floor(stat.mtimeMs) }],
            docs
        );
        await owner.storage.update([{ item_id: file, item_type: 'file', bm25: 1, bm25_generation: 4 }], {
            indexers: ['BaseIndexer']
        });
        Object.assign(owner.scannerState, { bm25_generation: 4, bm25_rule_version: 0, bm25_reset_pending: false });
        owner.scannerState.roots[docs] = { last_scan_at: 1 };
        await owner.saveScannerState();
        await owner.close();
        for (const readonly of [true, false]) {
            owner = new FSStorage(path.join(dir, 'app'));
            if (readonly) await owner.initializeReadonly();
            else {
                owner._writeScannerStateSnapshot = async () => {
                    throw new Error('snapshot denied');
                };
                await owner.initialize({ syncEmbedding: false });
            }
            const worker = new FileManagerWorker('test.wf2', path.join(dir, 'worker'));
            worker.storage = owner;
            worker.status = readonly ? 'readonly' : 'running';
            worker._readonlyMode = readonly;
            worker.config = { entries: [entry] };
            worker._lastConfig = worker.config;
            const snapshot = await worker.getFileSystemStatus();
            await withHarmony(async () => {
                const cached = await worker.getFileSystemStatus();
                assert.deepEqual(cached.full_text, snapshot.full_text);
                assert.deepEqual(cached.sources[0].full_text, snapshot.sources[0].full_text);
                assert.equal(cached.sources[0].state, 'scanning');
            });
            assert.equal(snapshot.full_text?.reason, 'resetting');
            assert.deepEqual(snapshot.sources[0].full_text, { total: 1, done: 0, pending: 1, failed: 0, excluded: 0 });
            assert.equal(snapshot.sources[0].state, 'scanning');
            __resetForTesting();
            setEntries([entry]);
            setSnapshot(snapshot);
            const { document } = parseHTML('<html><head></head><body></body></html>');
            const sources = createSources({ document });
            document.body.append(sources.element);
            assert.equal(document.querySelector('.status-text')?.textContent, '关键词索引 · 0/1');
            assert.equal(document.querySelector('.fs-source-card')?.getAttribute('data-progress'), '0');
            assert.equal(document.querySelectorAll('.fill.full-text').length, 1);
            sources.destroy();
            __resetForTesting();
            await owner.close();
        }
    } finally {
        await owner?.close();
        __resetForTesting();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

async function withHarmony(run: () => Promise<void>) {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'openharmony' });
    try {
        await run();
    } finally {
        Object.defineProperty(process, 'platform', descriptor);
    }
}
function statusWorker(fss: any) {
    const worker = new FileManagerWorker('status.contract', '/unused');
    worker.storage = fss;
    worker.status = 'running';
    worker.config = { entries: [{ root: '/Docs', include_patterns: ['**/*'], exclude_patterns: [] }] };
    worker._lastConfig = worker.config;
    return worker;
}

for (const platform of ['native', 'openharmony']) {
    test(`status lifetime: ${platform} finalize drains task-completion SQL and serves lightweight status`, async () => {
        const run = () =>
            fixture(async (fss) => {
                const holder = fss.storage,
                    entered = countGate(),
                    gate = countGate();
                const worker = statusWorker(fss);
                let reading = false,
                    calls = 0,
                    closes = 0;
                holder.getStatus = async () => {
                    calls++;
                    reading = true;
                    entered.resolve();
                    await gate.promise;
                    reading = false;
                    return { BaseIndexer: { size: 0 } };
                };
                holder.close = async () => {
                    closes++;
                    if (reading)
                        throw Object.assign(new Error('SQL still running'), { code: 'store_busy_with_pending_ops' });
                };
                worker._ensureStatusPushHooks();
                await worker.runSequentially(async () => {});
                await entered.promise;
                await worker.taskQueue.onIdle();
                const closing = worker.finalize().then(
                    () => null,
                    (error) => error
                );
                try {
                    await new Promise((resolve) => setImmediate(resolve));
                    assert.equal(closes, 0, 'Close must wait for status SQL outside the task queue');
                    const during = await worker.getStatus();
                    assert.equal(during.data.storage, null);
                    assert.equal(calls, 1, 'Closing must not start another status query');
                } finally {
                    gate.resolve();
                    assert.equal(await closing, null);
                }
                assert.equal(closes, 1);
                assert.equal(worker.storage, null);
            });
        await (platform === 'openharmony' ? withHarmony(run) : run());
    });
}

test('status lifetime: closing waits for cached background refresh even after cache invalidation', async (t) => {
    await fixture(async (fss) =>
        withHarmony(async () => {
            let now = 100_000;
            t.mock.method(Date, 'now', () => now);
            const cached = await fss.getPerRootCounts(['/Docs']);
            now += 10_001;
            const holder = fss.storage,
                entered = countGate(),
                gate = countGate();
            const aggregate = fss._aggregatePerRootCounts.bind(fss);
            fss._aggregatePerRootCounts = async (...args: any[]) => {
                entered.resolve();
                await gate.promise;
                return aggregate(...args);
            };
            let closes = 0;
            holder.close = async () => {
                closes++;
            };
            assert.deepEqual(await fss.getPerRootCounts(['/Docs']), cached);
            await entered.promise;
            const refresh = fss._perRootCountsCache.get('/Docs').inFlight;
            const refreshResult = refresh.then(
                () => null,
                (error: any) => error
            );
            fss._clearPerRootCountsCache();
            const closing = fss._closeBaseStorage(holder);
            try {
                await new Promise((resolve) => setImmediate(resolve));
                assert.equal(closes, 0, 'Deleting the cache entry must not discard the active SQL owner');
            } finally {
                gate.resolve();
                await refreshResult;
                await closing;
            }
            assert.equal(closes, 1);
            assert.equal(fss._pendingStorageClosures.size, 0);
        })
    );
});

test('status lifetime: late old-holder drain cannot suspend or clear its replacement', async () => {
    await fixture(async (fss) => {
        const old = fss.storage,
            gate = countGate(),
            entered = countGate();
        old.getStatus = async () => {
            entered.resolve();
            await gate.promise;
            return { BaseIndexer: { size: 1 } };
        };
        old.close = async () => {};
        const reading = fss.getStatus();
        await entered.promise;
        const closing = fss._closeBaseStorage(old);
        const replacement = { getStatus: async () => ({ BaseIndexer: { size: 9 } }) };
        fss.storage = replacement;
        try {
            assert.equal((await fss.getStatus()).db_size, 9);
        } finally {
            gate.resolve();
            await reading;
            await closing;
        }
        assert.equal(fss.storage, replacement);
        assert.equal((await fss.getStatus()).db_size, 9);
    });
});

test('status lifetime: failed close retains ownership and ordinary retry releases it', async () => {
    await fixture(async (fss) => {
        const holder = fss.storage;
        const failure = new Error('isolated close failure');
        let closes = 0,
            reads = 0;
        holder.close = async () => {
            if (++closes <= 2) throw failure;
        };
        holder.getStatus = async () => {
            reads++;
            return {};
        };
        await assert.rejects(fss._closeBaseStorage(holder), (error) => error === failure);
        assert.ok(fss._pendingStorageClosures.has(holder));
        assert.equal(await fss.getStatus(), null);
        assert.equal(reads, 0);
        await fss.close();
        assert.equal(closes, 3);
        assert.equal(fss._pendingStorageClosures.size, 0);
    });
});

test('status lifetime: mode replacement drains old statistics before publishing the candidate', async () => {
    await fixture(async (fss) => {
        const holder = fss.storage,
            gate = countGate(),
            entered = countGate();
        let closes = 0;
        holder.getStatus = async () => {
            entered.resolve();
            await gate.promise;
            return { BaseIndexer: { size: 1 } };
        };
        holder.close = async () => {
            closes++;
        };
        const candidate = { getStatus: async () => ({ BaseIndexer: { size: 9 } }), countGrouped: async () => [] };
        fss._newStorageHolder = async () => ({ holder: candidate });
        fss._openStorageHolder = async (created: any) => created.holder;
        const worker = statusWorker(fss);
        const reading = worker.getStatus().then(
            (snapshot) => ({ snapshot }),
            (error) => ({ error })
        );
        await entered.promise;
        const replacing = fss._replaceRetrievalStorage({ dim: 1024, mode: 'base-only' }, async () => ({}));
        try {
            await new Promise((resolve) => setImmediate(resolve));
            assert.equal(closes, 0);
            assert.notEqual(fss.storage, candidate);
            assert.equal((await worker.getStatus()).data.storage, null);
        } finally {
            gate.resolve();
            const result = await reading;
            if ('error' in result) assert.equal(result.error.code, 'filemgr_counts_invalidated');
            else assert.ok(result.snapshot.data.storage === null || result.snapshot.data.storage_stats.db_size === 9);
            await replacing;
        }
        assert.equal(closes, 1);
        assert.equal(fss.storage, candidate);
        assert.equal((await worker.getStatus()).data.storage_stats.db_size, 9);
    });
});

test('status lifetime: status awaited inside a queue task does not wait behind itself', { timeout: 2000 }, async () => {
    await fixture(async (fss) => {
        const worker = statusWorker(fss);
        await worker.runSequentially(async () => {
            assert.equal((await worker.getStatus()).status, 'ok');
        });
    });
});

test('status lifetime: parallel getInfo failure waits for siblings and preserves the first error', async () => {
    const holder: any = Object.create(BaseStorage.prototype);
    const gate = countGate(),
        first = new Error('first status failure'),
        later = new Error('later failure');
    let settled = false;
    holder.baseIndexer = {
        getInfo: async () => {
            await gate.promise;
            throw later;
        }
    };
    holder.bm25Indexer = {
        getInfo: async () => {
            throw first;
        }
    };
    const reading = holder.getStatus().then(
        () => {
            settled = true;
            return null;
        },
        (error: any) => {
            settled = true;
            return error;
        }
    );
    try {
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(settled, false, 'One rejected statistic must not hide another active query');
    } finally {
        gate.resolve();
        assert.equal(await reading, first);
    }
});

test('status lifetime: parallel status retains successful metadata for every indexer', async () => {
    const holder: any = Object.create(BaseStorage.prototype);
    const fields = ['baseIndexer', 'bm25Indexer', 'vectorIndexer', 'tagIndexer', 'chunkIndexer'];
    const names = ['BaseIndexer', 'BM25Indexer', 'VectorIndexer', 'TagIndexer', 'ChunkIndexer'];
    for (const [index, field] of fields.entries()) {
        holder[field] = { getInfo: async () => ({ size: index + 1 }) };
    }
    const status = await holder.getStatus();
    assert.deepEqual(status, Object.fromEntries(names.map((name, index) => [name, { size: index + 1 }])));
});

test('status lifetime: native snapshots retain uncached count semantics', async () => {
    await fixture(async (fss) => {
        const worker = statusWorker(fss),
            original = fss.getStatus.bind(fss);
        let calls = 0;
        fss.getStatus = async () => {
            calls++;
            const result = await original();
            fss._clearPerRootCountsCache();
            return result;
        };
        assert.equal((await worker.getStatus()).status, 'ok');
        assert.equal(calls, 1);
    });
});
for (const change of [
    'mode',
    'vector-generation',
    'semantic-reset',
    'bm25-generation',
    'bm25-reset',
    'terminal',
    'unsupported',
    'source'
]) {
    test(`Harmony completed cache rejects changed ${change} without explicit clear`, async () => {
        await fixture(async (fss, db) =>
            withHarmony(async () => {
                fss.scannerState.roots['/Docs'] = {};
                await db.insert({ ...row('/Docs/a.txt', ['/Docs']), ext: '.txt', bm25: 1, bm25_generation: 4 });
                assert.equal((await fss.getPerRootCounts(['/Docs'])).get('/Docs').full_text.done, 1);
                let calls = 0;
                const original = fss.storage.countGrouped.bind(fss.storage);
                fss.storage.countGrouped = async (...args: any[]) => {
                    calls++;
                    return original(...args);
                };
                if (change === 'mode') fss.mode = 'full';
                if (change === 'vector-generation') fss.scannerState.embedding_generation = 5;
                if (change === 'semantic-reset') fss.scannerState.semantic_reset_pending = true;
                if (change === 'bm25-generation') fss.scannerState.bm25_generation++;
                if (change === 'bm25-reset') fss.scannerState.bm25_reset_pending = true;
                if (change === 'source') {
                    await db.update('/Docs/a.txt', { bm25: 0 });
                    delete fss.scannerState.roots['/Docs'];
                }
                if (change === 'terminal' || change === 'unsupported')
                    fss._recordFullTextFailure(
                        Object.assign(new Error('isolated tokenizer'), {
                            code: 'bm25_tokenizer_unavailable',
                            details: { availability: change }
                        }),
                        fss.storage,
                        4
                    );
                const counts = (await fss.getPerRootCounts(['/Docs'])).get('/Docs');
                assert.ok(calls > 0);
                if (change === 'source') assert.equal(counts.full_text.done, 0);
                if (change === 'terminal' || change === 'unsupported') assert.equal(counts.full_text, undefined);
                if (change === 'bm25-generation' || change === 'bm25-reset') assert.equal(counts.full_text.done, 0);
            })
        );
    });
}

test('Harmony root invalidation preserves completed counts for other roots', async () => {
    await fixture(async (fss) =>
        withHarmony(async () => {
            await fss.getPerRootCounts(['/Docs', '/Other']);
            fss._clearPerRootCountsCache('/Docs');
            fss.storage.countGrouped = async () => {
                throw new Error('Other must remain cached');
            };
            assert.equal((await fss.getPerRootCounts(['/Other'])).get('/Other').total_files, 0);
        })
    );
});

for (const rounds of [1, 2]) {
    test(`Harmony full status retries at most once after ${rounds} invalidations`, async () => {
        await fixture(async (fss) =>
            withHarmony(async () => {
                const worker = statusWorker(fss);
                const count = fss.storage.countGrouped.bind(fss.storage);
                let attempts = 0;
                fss.storage.countGrouped = async (...args: any[]) => {
                    const result = await count(...args);
                    if (!args[0].includes('bm25') && ++attempts <= rounds) fss._clearPerRootCountsCache();
                    return result;
                };
                if (rounds === 1) assert.equal((await worker.getFileSystemStatus()).sources.length, 1);
                else await assert.rejects(worker.getFileSystemStatus(), { code: 'filemgr_counts_invalidated' });
                assert.equal(attempts, 2);
            })
        );
    });
}

test('native statistics do not inherit Harmony cache invalidation semantics', async () => {
    await fixture(async (fss) => {
        const worker = statusWorker(fss);
        const original = fss.storage.countGrouped.bind(fss.storage);
        let calls = 0;
        fss.storage.countGrouped = async (...args: any[]) => {
            calls++;
            fss._clearPerRootCountsCache();
            return original(...args);
        };
        assert.equal((await worker.getFileSystemStatus()).sources.length, 1);
        assert.equal(calls, 2);
    });
});

test('Harmony failed visible full-text aggregate cannot publish guessed or partial counts', async () => {
    await fixture(async (fss) =>
        withHarmony(async () => {
            const worker = statusWorker(fss);
            const count = fss.storage.countGrouped.bind(fss.storage);
            fss.storage.countGrouped = async (...args: any[]) => {
                if (args[0].includes('bm25')) throw new Error('isolated full-text count failure');
                return count(...args);
            };
            await assert.rejects(worker.getFileSystemStatus(), /isolated full-text count failure/);
            const data = await worker._getSourceControlSnapshot();
            assert.equal(data.mode, null);
            assert.equal(data.totals, null);
            assert.equal(data.sources[0].full_text, undefined);
            assert.equal(data.sources[0].state, 'pending');
        })
    );
});

function countGate() {
    let resolve!: () => void;
    const promise = new Promise<void>((yes) => {
        resolve = yes;
    });
    return { promise, resolve };
}

test('Harmony invalidated request cannot clear a newer shared refresh or leak rejection', async () => {
    await fixture(async (fss) =>
        withHarmony(async () => {
            const oldGate = countGate(),
                newGate = countGate();
            let baseCalls = 0;
            fss.storage.countGrouped = async (fields: string[]) => {
                if (!fields.includes('bm25')) await (++baseCalls === 1 ? oldGate.promise : newGate.promise);
                return [];
            };
            const old = fss.getPerRootCounts(['/Docs']);
            const oldResult = assert.rejects(old, { code: 'filemgr_counts_invalidated' });
            fss._clearPerRootCountsCache('/Docs');
            const fresh = fss.getPerRootCounts(['/Docs']);
            const shared = fss.getPerRootCounts(['/Docs']);
            const inFlight = fss._perRootCountsCache.get('/Docs').inFlight;
            oldGate.resolve();
            await oldResult;
            assert.equal(fss._perRootCountsCache.get('/Docs').inFlight, inFlight);
            newGate.resolve();
            assert.deepEqual(await fresh, await shared);
            assert.equal(baseCalls, 2);
            assert.equal(fss._perRootCountsCache.get('/Docs').inFlight, null);
        })
    );
});

test('Harmony full status recaptures removed sources and current storage after awaited metadata', async () => {
    await fixture(async (fss) =>
        withHarmony(async () => {
            const worker = statusWorker(fss);
            const original = fss.getStatus.bind(fss);
            let calls = 0;
            fss.getStatus = async () => {
                const result = await original();
                if (++calls === 1) {
                    worker.config = { entries: [{ root: '/Other', include_patterns: ['**/*'], exclude_patterns: [] }] };
                    worker._lastConfig = worker.config;
                }
                return result;
            };
            const snapshot = await worker.getFileSystemStatus();
            assert.deepEqual(
                snapshot.sources.map((source: any) => source.root),
                ['/Other']
            );
            assert.equal(calls, 2);
        })
    );
});

test('Harmony worker checks applicability again before publishing a completed snapshot', async () => {
    await fixture(async (fss) =>
        withHarmony(async () => {
            const worker = statusWorker(fss);
            const read = worker.getFileSystemStatus.bind(worker);
            worker.getFileSystemStatus = async () => {
                const result = await read();
                fss._clearPerRootCountsCache();
                return result;
            };
            let publishes = 0;
            worker.callApp = () => {
                publishes++;
            };
            await worker._emitStatusChanged('test');
            assert.equal(publishes, 0);
        })
    );
});

test('Harmony TTL returns applicable old full groups then refreshes without extra pushes', async (t) => {
    await fixture(async (fss, db) =>
        withHarmony(async () => {
            let now = 100_000;
            t.mock.method(Date, 'now', () => now);
            await db.insert({ ...row('/Docs/a.txt', ['/Docs']), ext: '.txt', bm25: 1, bm25_generation: 4 });
            const worker = statusWorker(fss);
            const first = await worker.getFileSystemStatus();
            assert.equal(first.sources[0].full_text.done, 1);
            await db.update('/Docs/a.txt', { bm25: 0 });
            now += 10_001;
            let pushes = 0;
            worker.callApp = () => {
                pushes++;
            };
            const stale = await worker.getFileSystemStatus();
            assert.equal(stale.sources[0].full_text.done, 1);
            await fss._perRootCountsCache.get('/Docs').inFlight;
            assert.equal(pushes, 0);
            const fresh = await worker.getFileSystemStatus();
            assert.equal(fresh.sources[0].full_text.done, 0);
        })
    );
});

for (const outcome of ['query-error', 'invalidated']) {
    test(`Harmony shared background refresh ${outcome} reports only actionable failures once`, async (t) => {
        await fixture(async (fss) =>
            withHarmony(async () => {
                let now = 100_000;
                t.mock.method(Date, 'now', () => now);
                const warnings = t.mock.method(logger, 'warn', () => {});
                const cached = await fss.getPerRootCounts(['/Docs']);
                now += 10_001;
                const gate = countGate();
                const failure = new Error('isolated background query failure');
                const aggregate = fss._aggregateRootCounts.bind(fss);
                const refreshCalls = t.mock.method(fss, '_aggregateRootCounts', async (...args: any[]) => {
                    await gate.promise;
                    if (outcome === 'query-error') throw failure;
                    return aggregate(...args);
                });
                const results = await Promise.all(Array.from({ length: 6 }, () => fss.getPerRootCounts(['/Docs'])));
                for (const result of results) assert.deepEqual(result, cached);
                assert.equal(refreshCalls.mock.callCount(), 1);
                const refresh = fss._perRootCountsCache.get('/Docs').inFlight;
                assert.ok(refresh);
                if (outcome === 'invalidated') fss._clearPerRootCountsCache('/Docs');
                const rejected = assert.rejects(refresh, (error: any) =>
                    outcome === 'invalidated' ? error.code === 'filemgr_counts_invalidated' : error === failure
                );
                gate.resolve();
                await rejected;
                assert.equal(warnings.mock.callCount(), outcome === 'query-error' ? 1 : 0);
                if (outcome === 'query-error')
                    assert.match(String(warnings.mock.calls[0].arguments[0]), /isolated background query failure/);
            })
        );
    });
}

test('Harmony metadata failure from a replaced connection retries the current complete context', async () => {
    await fixture(async (fss) =>
        withHarmony(async () => {
            const worker = statusWorker(fss);
            const status = fss.getStatus.bind(fss);
            let calls = 0;
            fss.getStatus = async () => {
                if (++calls === 1) {
                    fss.storage = Object.create(fss.storage);
                    fss._fullTextByHolder.set(fss.storage, { bound: true });
                    throw new Error('old connection stopped during metadata read');
                }
                return status();
            };
            assert.equal((await worker.getFileSystemStatus()).sources.length, 1);
            assert.equal(calls, 2);
        })
    );
});

test('Harmony multi-source partial success retains complete roots without publishing unknown roots as zero', async () => {
    await fixture(async (fss) =>
        withHarmony(async () => {
            const original = fss._aggregateRootCounts.bind(fss);
            let failedReads = 0;
            fss._aggregateRootCounts = async (root: string, holder: any) => {
                if (root === '/Broken') {
                    failedReads++;
                    throw new Error('isolated source count failure');
                }
                return original(root, holder);
            };
            await assert.rejects(fss.getPerRootCounts(['/Docs', '/Broken']), /isolated source count failure/);
            assert.equal(failedReads, 1);
            assert.ok(fss._getAnyCachedPerRootCount('/Docs'));
            assert.equal(fss._getAnyCachedPerRootCount('/Broken'), null);
            fss.storage.countGrouped = async () => {
                throw new Error('completed root must remain cached');
            };
            assert.equal((await fss.getPerRootCounts(['/Docs'])).get('/Docs').total_files, 0);
        })
    );
});
