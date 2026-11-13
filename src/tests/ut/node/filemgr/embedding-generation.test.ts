import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndexedFilePreconditions } from '../../../../main/applications/filemgr/search/indexed.js';
import { completedFileConditions } from '../../../../main/applications/filemgr/document-retrieval/embedding/state.js';
import { Setting, setCustomOpendeskDirectory } from '../../../../main/utils/setting.js';

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'filemgr-generation-'));
setCustomOpendeskDirectory(profile);
after(() => fs.rmSync(profile, { recursive: true, force: true }));
const { FSStorage, makeSchema } = await import('../../../../main/applications/filemgr/storage.js');
const { BaseStorage } = await import('../../../../main/services/storage/abstract-storage.js');
const { BaseIndexDB } = await import('../../../../main/services/storage/base-index-db.js');
const { BaseIndexDBWasm } = await import('../../../../main/services/storage/base-index-db-wasm.js');

function fixture() {
    const dir = fs.mkdtempSync(path.join(profile, 'case-'));
    return new FSStorage(dir);
}
function row(id: string, generation = 0, embedded = 1) {
    return {
        item_id: id,
        item_type: 'file',
        filename: path.basename(id),
        type: 'file',
        root_refs: '["/docs"]',
        ref_count: 1,
        embedded,
        embedding_generation: generation
    };
}
async function rows(fss: any) {
    return (await fss.storage.search([])).items.map(({ item }: any) => item);
}

test('legacy scanner JSON defaults to generation zero without changing checkpoint or pause state', () => {
    const fss = fixture();
    const legacy = { ...fss.scannerState, roots: { '/docs': { last_full_scan: 123, total_files: 2, paused: true } } };
    delete legacy.embedding_generation;
    delete legacy.semantic_reset_pending;
    fs.writeFileSync(fss._scannerStatePath, JSON.stringify(legacy));
    fss._loadScannerState();
    assert.equal(fss._stateCorrupt, false);
    assert.equal(fss.scannerState.embedding_generation, 0);
    assert.equal(fss.scannerState.semantic_reset_pending, false);
    assert.equal(fss.scannerState.roots['/docs'].last_full_scan, 123);
    assert.equal(fss.scannerState.roots['/docs'].paused, true);
});

for (const Database of [BaseIndexDB, BaseIndexDBWasm]) {
    test(`${Database.name}: adding generation preserves completed legacy rows`, async () => {
        const fss = fixture();
        const dbPath = path.join(fss._storageDir, 'base-index.db');
        const legacySchema = makeSchema(2, { mode: 'base-only' });
        delete legacySchema.columns.embedding_generation;
        const old = new Database(dbPath, legacySchema);
        await old.insert(row('/docs/legacy.md'));
        old.close();
        const upgraded = new Database(dbPath, makeSchema(2, { mode: 'base-only' }));
        try {
            const item = await upgraded.findById('/docs/legacy.md');
            assert.equal(item?.embedding_generation, 0);
            assert.equal(item?.embedded, 1);
            assert.equal(item?.root_refs, '["/docs"]');
        } finally {
            upgraded.close();
        }
    });
}

test('ArkData schema reconciliation adds generation without rebuilding legacy rows (SQLite bridge)', async () => {
    const { BaseIndexDBArkdata } = await import('../../../../main/services/storage/base-index-db-arkdata.js');
    const fss = fixture();
    const dbPath = path.join(fss._storageDir, 'arkdata-compat.db');
    const legacySchema = makeSchema(2, { mode: 'base-only' });
    delete legacySchema.columns.embedding_generation;
    const old = new BaseIndexDB(dbPath, legacySchema);
    await old.insert(row('/docs/legacy.md'));
    // Exercise ArkData's actual migration SQL against SQLite, without requiring an OHOS bridge.
    const db = (old as any).db;
    const values = (params: any[]) => params.map((param) => param.v);
    const kit = {
        execSql: async (_store: string, sql: string) => db.exec(sql),
        queryPrepared: async (_store: string, sql: string, params: any[]) => db.prepare(sql).all(...values(params)),
        executePrepared: async (_store: string, sql: string, params: any[]) => ({
            affectedRows: db.prepare(sql).run(...values(params)).changes
        }),
        transaction: async (_store: string, fn: any) => {
            db.exec('BEGIN');
            try {
                await fn({ id: 'fixture' });
                db.exec('COMMIT');
            } catch (error) {
                db.exec('ROLLBACK');
                throw error;
            }
        }
    };
    const upgraded = new BaseIndexDBArkdata(dbPath, makeSchema(2, { mode: 'base-only' })) as any;
    upgraded.dbKit = kit;
    try {
        await upgraded.initializeTable();
        const item = await old.findById('/docs/legacy.md');
        assert.equal(item?.embedding_generation, 0);
        assert.equal(item?.embedded, 1);
        assert.equal(item?.root_refs, '["/docs"]');
        await upgraded.initializeTable();
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM base_index').get().n, 1);
    } finally {
        old.close();
    }
});

for (const invalid of [-1, 0.5, '1', null, Number.MAX_SAFE_INTEGER + 1]) {
    test(`invalid generation ${JSON.stringify(invalid)} is handled as corrupt state`, () => {
        const fss = fixture();
        fs.writeFileSync(fss._scannerStatePath, JSON.stringify({ ...fss.scannerState, embedding_generation: invalid }));
        fss._loadScannerState();
        assert.equal(fss._stateCorrupt, true);
    });
}

test('reopen resets only stale generations in batches and preserves current completed rows', async () => {
    const fss = fixture();
    await fss.initialize({ syncEmbedding: false });
    try {
        await fss.storage.upsert(
            [
                row('/docs/current', 3),
                ...Array.from({ length: 501 }, (_, i) => row(`/docs/stale-${i}`, 1, i % 2 ? -2 : 1))
            ],
            { indexers: ['BaseIndexer'] }
        );
        fss.scannerState.embedding_generation = 3;
        await fss.saveScannerState();
    } finally {
        await fss.close();
    }
    const reopened = new FSStorage(fss._appDataDirectory);
    await reopened.initialize({ syncEmbedding: false });
    try {
        const result = await rows(reopened);
        assert.equal(result.length, 502);
        assert.equal(result.find((item: any) => item.item_id === '/docs/current').embedded, 1);
        assert.ok(
            result.filter((item: any) => item.item_id !== '/docs/current').every((item: any) => item.embedded === 0)
        );
        assert.ok(result.every((item: any) => item.embedding_generation === 3 && item.ref_count === 1));
    } finally {
        await reopened.close();
    }
});

test('generation and model persist together before deleting semantic stores; interrupted reset recovers', async (t) => {
    const fss = fixture();
    await fss.initialize({ syncEmbedding: false });
    await fss.storage.upsert([row('/docs/interrupted')], { indexers: ['BaseIndexer'] });
    const failure = new Error('interrupted before semantic deletion');
    const drop = t.mock.method(fss, '_dropFilemgrStores', async () => {
        const state = JSON.parse(fs.readFileSync(fss._scannerStatePath, 'utf8'));
        assert.equal(state.embedding_generation, 1);
        assert.equal(state.embedding_model, 'new-model');
        throw failure;
    });
    try {
        await assert.rejects(
            () =>
                fss.retrieval._resetVectorChunk('model-change', {
                    dim: 2,
                    mode: 'full',
                    embeddingState: { embedding_model: 'new-model', vec_dim: 2 }
                }),
            (error) => error === failure
        );
    } finally {
        drop.mock.restore();
        await fss.close();
    }
    const reopened = new FSStorage(fss._appDataDirectory);
    await reopened.initialize({ syncEmbedding: false });
    try {
        assert.equal(reopened.scannerState.embedding_generation, 1);
        assert.equal((await rows(reopened))[0].embedded, 0);
    } finally {
        await reopened.close();
    }
});

test('failed generation persistence neither deletes stores nor commits new model or generation', async (t) => {
    const fss = fixture();
    await fss.initialize({ syncEmbedding: false });
    fss.scannerState.embedding_model = 'old-model';
    await fss.saveScannerState();
    const failure = new Error('synthetic state write failure');
    t.mock.method(fss, '_writeScannerStateSnapshot', async () => {
        throw failure;
    });
    const drop = t.mock.method(BaseStorage.prototype, 'dropIndexers', async () => assert.fail('must not delete'));
    try {
        await assert.rejects(
            () =>
                fss.retrieval._resetVectorChunk('model-change', {
                    dim: 2,
                    mode: 'full',
                    embeddingState: { embedding_model: 'new-model', vec_dim: 2 }
                }),
            (error) => error === failure
        );
        const state = JSON.parse(fs.readFileSync(fss._scannerStatePath, 'utf8'));
        assert.equal(state.embedding_model, 'old-model');
        assert.equal(state.embedding_generation, 0);
        assert.equal(drop.mock.callCount(), 0);
    } finally {
        await fss.close();
    }
});

test('generation reconciliation keeps unfinished rows pending while advancing generation', async () => {
    const fss = fixture();
    await fss.initialize({ syncEmbedding: false });
    try {
        await fss.storage.upsert([row('/docs/unfinished', 0, 0)], { indexers: ['BaseIndexer'] });
        fss.scannerState.embedding_generation = 2;
        await fss.retrieval._reconcileEmbeddingGeneration(fss._createRetrievalDataView());
        const [item] = await rows(fss);
        assert.equal(item.embedded, 0);
        assert.equal(item.embedding_generation, 2);
    } finally {
        await fss.close();
    }
});

test('search preconditions and counts exclude stale completion without rewriting readonly rows', async () => {
    const fss = fixture();
    await fss.initialize({ syncEmbedding: false });
    try {
        fss.scannerState.embedding_generation = 2;
        fss.mode = 'full';
        await fss.storage.upsert([row('/docs/current', 2), row('/docs/stale', 1)], { indexers: ['BaseIndexer'] });
        const conditions = buildIndexedFilePreconditions({
            algorithmConditions: completedFileConditions({ requireEmbedded: true, embeddingGeneration: 2 })
        });
        assert.equal((await fss.storage.search(conditions)).items.length, 1);
        assert.deepEqual(await fss.getGlobalFileCounts(), { total_files: 2, embedded_count: 1, pending_count: 1 });
        const counts = await fss._aggregatePerRootCounts('/docs');
        assert.equal(counts.embedded_count, 1);
        assert.equal(counts.pending_count, 1);
        assert.equal((await rows(fss)).find((item: any) => item.item_id === '/docs/stale').embedded, 1);
    } finally {
        await fss.close();
    }
});

for (const pending of [false, true]) {
    test(`readonly initialization filters semantic hits with reset pending=${pending} without rewriting rows`, async (t) => {
        const fss = fixture();
        fss.scannerState.embedding_generation = 1;
        fss.scannerState.semantic_reset_pending = pending;
        fss.scannerState.embedding_model = 'test-model';
        fss.scannerState.vec_dim = 2;
        fss.scannerState.chunk_level = 'structured';
        fss.scannerState.embedded_migrated = true;
        await fss.saveScannerState();
        const storage = new BaseStorage('filemgr', makeSchema(2), fss._storageDir);
        await storage.initialize();
        try {
            await storage.upsert(
                [row('/docs/current', 1), row('/docs/stale', 0)].map((item) => ({
                    ...item,
                    indexer_columns: {
                        VectorIndexer: [{ column: 'filename', content: [1, 0] }],
                        ChunkIndexer: [
                            { column: 'chunk_text', id: item.item_id, text: 'fixture content', content: [1, 0] }
                        ]
                    }
                }))
            );
        } finally {
            await storage.close();
        }
        const reader = new FSStorage(fss._appDataDirectory);
        const { LLM } = await import('../../../../main/aikernel/llm.js');
        // Readonly semantic queries use the currently configured model.
        t.mock.method(
            Setting,
            'getInstance',
            () =>
                ({
                    getDefaultEmbeddingModelInstance: () => ({ model_name: 'test-model' })
                }) as any
        );
        t.mock.method(LLM, 'embed', async () => [1, 0]);
        t.mock.method(LLM, 'rerank', async (_query, items) => items);
        reader._computeWarning = () => null;
        await reader.initializeReadonly();
        try {
            assert.equal(reader.mode, pending ? 'base-only' : 'full');
            assert.deepEqual(
                (await reader.retrieval.searchNames('fixture')).results.map((item: any) => item.path),
                pending ? [] : ['/docs/current']
            );
            assert.deepEqual(
                (await reader.retrieval.searchContent('fixture', { topK: 10 })).results.map(
                    (item: any) => item.source.path
                ),
                pending ? [] : ['/docs/current']
            );
            assert.equal((await reader.getGlobalFileCounts()).embedded_count, pending ? 0 : 1);
            assert.equal((await rows(reader)).find((item: any) => item.item_id === '/docs/stale').embedded, 1);
        } finally {
            await reader.close();
        }
    });
}

for (const event of [
    null,
    { type: 'vector', status: 'failed' },
    { type: 'full', status: 'failed' },
    { type: 'vector', status: 'completed' }
]) {
    test(`legacy completion marker is inferred conservatively: ${JSON.stringify(event)}`, () => {
        const fss = fixture();
        const state = { ...fss.scannerState, last_rebuild_event: event };
        delete state.semantic_reset_pending;
        fs.writeFileSync(fss._scannerStatePath, JSON.stringify(state));
        fss._loadScannerState();
        assert.equal(fss._stateCorrupt, false);
        assert.equal(fss.scannerState.semantic_reset_pending, event?.status === 'failed');
    });
}
for (const invalid of [null, 0, 'true', {}]) {
    test(`invalid semantic reset marker ${JSON.stringify(invalid)} is rejected`, () => {
        const fss = fixture();
        fs.writeFileSync(
            fss._scannerStatePath,
            JSON.stringify({ ...fss.scannerState, semantic_reset_pending: invalid })
        );
        fss._loadScannerState();
        assert.equal(fss._stateCorrupt, true);
    });
}
