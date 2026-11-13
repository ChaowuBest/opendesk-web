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
import { BaseIndexDBArkdata } from '../../../../main/services/storage/base-index-db-arkdata.js';

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
    Object.assign(fss, { storage, mode: 'base-only', scannerState: { roots: {}, unavailable_roots: {} } });
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
        assert.deepEqual(await fss.getPerRootCounts(roots), counts, 'Harmony cold refresh must match direct counts');
        assert.deepEqual(await fss.getPerRootCounts(roots), counts, 'Harmony cache must match direct counts');
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
            counts.get(root),
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
            assert.deepEqual(await first, await second);
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
