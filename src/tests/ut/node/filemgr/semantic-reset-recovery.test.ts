import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Setting, setCustomOpendeskDirectory } from '../../../../main/utils/setting.js';
import { BaseStorage } from '../../../../main/services/storage/abstract-storage.js';
import { BaseIndexer } from '../../../../main/services/storage/base-indexer.js';
import { VectorIndexer } from '../../../../main/services/storage/vector-indexer.js';
import { ChunkIndexer } from '../../../../main/services/storage/chunk-indexer.js';
import { FSStorage, makeSchema } from '../../../../main/applications/filemgr/storage.js';
import { LLM } from '../../../../main/aikernel/llm.js';

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'filemgr-reset-recovery-'));
setCustomOpendeskDirectory(profile);
after(() => fs.rmSync(profile, { recursive: true, force: true }));
// Resolve the host binding before any case simulates the WASM platform.
const SQLite = createRequire(import.meta.url)('better-sqlite3');
new SQLite(':memory:').close();

const phases = [
    'initial-write',
    'vector-close',
    'chunk-drop',
    'candidate-init',
    'base-write',
    'complete-write',
    'event-write',
    'repeat-failure',
    'disable-model',
    'supersede-model',
    'change-dimension',
    'aba-model',
    'backend-switch',
    'full-reset'
] as const;
for (const backend of ['native', 'wasm'] as const) {
    for (const recovery of ['sync', 'restart'] as const) {
        for (const phase of phases) {
            test(`${backend}: ${phase} failure recovers via ${recovery} without reusing old semantic data`, async (t) => {
                const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
                const available = process.env.ARKDATA_AVAILABLE;
                if (backend === 'wasm') {
                    Object.defineProperty(process, 'platform', { value: 'openharmony' });
                    process.env.ARKDATA_AVAILABLE = '0';
                }
                let model: string | null = phase === 'full-reset' ? 'model-a' : 'model-b';
                let dimension = 2;
                t.mock.method(Setting, 'getInstance', () => ({
                    getDefaultEmbeddingModelInstance: () => {
                        if (!model) throw new Error('fixture: no model');
                        return { model_name: model };
                    },
                    getData: () => ({})
                }));
                t.mock.method(LLM, 'embed', async () => Array.from({ length: dimension }, (_, i) => (i === 0 ? 1 : 0)));
                t.mock.method(LLM, 'batchEmbed', async (texts: string[]) =>
                    texts.map(() => Array.from({ length: dimension }, (_, i) => (i === 0 ? 1 : 0)))
                );
                t.mock.method(LLM, 'rerank', async (_query: string, items: any[]) => items);
                const directory = fs.mkdtempSync(path.join(profile, `${backend}-${phase}-`));
                const root = path.join(directory, 'files');
                fs.mkdirSync(root);
                const files = [path.join(root, 'old.md'), path.join(root, 'other.md')];
                for (const file of files) fs.writeFileSync(file, '');
                let fss = new FSStorage(directory);
                const old = new BaseStorage('filemgr', makeSchema(2), fss._storageDir);
                fss.storage = old;
                fss.mode = 'full';
                Object.assign(fss.scannerState, {
                    embedding_model: 'model-a',
                    vec_dim: 2,
                    chunk_level: 'structured',
                    vector_backend: backend,
                    embedding_generation: 0,
                    embedded_migrated: true,
                    _migratedRefCount: true
                });
                fss.scannerState.roots[root] = {
                    last_full_scan: 123,
                    total_files: 2,
                    last_scan_at: 123,
                    paused: false
                };
                const probe = async () => ({ ok: true, model_name: model, dim: dimension, requestDim: undefined });
                fss._probeEmbedding = probe;
                let failing = true;
                const failure = new Error(`fixture: ${phase}`);
                try {
                    await old.initialize();
                    await old.upsert(
                        files.map((file, i) => ({
                            item_id: file,
                            item_type: 'file',
                            type: 'file',
                            filename: path.basename(file),
                            root_refs: JSON.stringify([root]),
                            ref_count: 1,
                            embedded: 1,
                            embedding_generation: 0,
                            indexer_columns: {
                                VectorIndexer: [{ column: 'filename', content: [0, 1] }],
                                ChunkIndexer: [
                                    {
                                        column: 'chunk_text',
                                        id: `obsolete-${i}`,
                                        text: 'Old model content',
                                        content: [0, 1]
                                    }
                                ]
                            }
                        }))
                    );
                    await fss.saveScannerState();
                    const writeSnapshot = (fss as any)._writeScannerStateSnapshot.bind(fss);
                    t.mock.method(fss as any, '_writeScannerStateSnapshot', async (state: any, commit: any) => {
                        if (
                            failing &&
                            ((phase === 'initial-write' && state.semantic_reset_pending) ||
                                (phase === 'complete-write' && state.semantic_reset_pending === false))
                        )
                            throw failure;
                        return writeSnapshot(state, commit);
                    });
                    const vectorDrop = VectorIndexer.prototype.dropStorage;
                    t.mock.method(VectorIndexer.prototype, 'dropStorage', async function () {
                        await vectorDrop.call(this);
                        if (
                            failing &&
                            [
                                'vector-close',
                                'repeat-failure',
                                'disable-model',
                                'supersede-model',
                                'change-dimension',
                                'aba-model',
                                'backend-switch',
                                'full-reset'
                            ].includes(phase)
                        )
                            throw failure;
                    });
                    const baseDrop = BaseIndexer.prototype.dropStorage;
                    t.mock.method(BaseIndexer.prototype, 'dropStorage', async function () {
                        await baseDrop.call(this);
                        if (failing && phase === 'full-reset') throw failure;
                    });
                    const chunkDrop = ChunkIndexer.prototype.dropStorage;
                    t.mock.method(ChunkIndexer.prototype, 'dropStorage', async function () {
                        if (failing && phase === 'chunk-drop') throw failure;
                        return chunkDrop.call(this);
                    });
                    const initialize = BaseStorage.prototype.initialize;
                    t.mock.method(BaseStorage.prototype, 'initialize', async function () {
                        await initialize.call(this);
                        if (failing && phase === 'candidate-init' && this.chunkIndexer) throw failure;
                    });
                    const upsert = BaseStorage.prototype.upsert;
                    t.mock.method(BaseStorage.prototype, 'upsert', async function (items: any[], options?: any) {
                        if (
                            failing &&
                            phase === 'base-write' &&
                            items.some((item) => item.embedding_generation === 1)
                        ) {
                            // Commit one base row before failing to exercise partial reconciliation.
                            await upsert.call(this, items.slice(0, 1), options);
                            throw failure;
                        }
                        return upsert.call(this, items, options);
                    });
                    const save = fss.saveScannerState.bind(fss);
                    t.mock.method(fss, 'saveScannerState', async () => {
                        if (
                            failing &&
                            phase === 'event-write' &&
                            fss.scannerState.last_rebuild_event?.status === 'completed'
                        )
                            throw failure;
                        return save();
                    });
                    await assert.rejects(
                        phase === 'full-reset' ? fss.rebuildAll('full-reset') : fss.syncEmbeddingMode('model-change'),
                        (error) => error === failure
                    );
                    const state = JSON.parse(fs.readFileSync((fss as any)._scannerStatePath, 'utf8'));
                    const pending = phase !== 'initial-write' && phase !== 'event-write';
                    assert.equal(state.semantic_reset_pending, pending);
                    assert.equal(state.embedding_generation, phase === 'initial-write' ? 0 : 1);
                    if (phase === 'initial-write') {
                        assert.equal(state.embedding_model, 'model-a');
                        assert.equal((await old.getStatus()).ChunkIndexer.size, 2);
                    }
                    if (pending) {
                        assert.equal((await fss.searchIndexedChunks('old', { topK: 10 })).results.length, 0);
                        assert.equal(await fss.processEmbeddingQueue(() => false, { activeRoots: [root] }), 0);
                        const reader = new FSStorage(directory);
                        await reader.initializeReadonly();
                        try {
                            assert.equal(reader.mode, 'base-only');
                            assert.equal((await reader.searchIndexedChunks('old', { topK: 10 })).results.length, 0);
                            if (phase === 'full-reset') assert.equal(reader.isDeferred(), true);
                            else assert.equal((await reader.storage!.search([])).items.length, 2);
                        } finally {
                            await reader.close();
                        }
                    }
                    let expectedGeneration = 1;
                    if (phase === 'repeat-failure') {
                        await assert.rejects(fss.syncEmbeddingMode('still-failing'), (error) => error === failure);
                        assert.equal(fss.scannerState.embedding_generation, 1, 'Retries must not advance generation');
                        assert.equal(fss.scannerState.semantic_reset_pending, true);
                    }
                    if (phase === 'disable-model') {
                        model = null;
                        await fss.syncEmbeddingMode('model-removed');
                        assert.equal(fss.mode, 'base-only');
                        assert.equal(fss.scannerState.semantic_reset_pending, true);
                        assert.equal((await fss.searchIndexedChunks('old', { topK: 10 })).results.length, 0);
                        model = 'model-b';
                    }
                    if (['supersede-model', 'change-dimension', 'aba-model'].includes(phase)) {
                        model = phase === 'aba-model' ? 'model-a' : 'model-c';
                        if (phase === 'change-dimension') dimension = 3;
                        expectedGeneration = 2;
                    }
                    if (phase === 'backend-switch') {
                        if (backend === 'native') {
                            Object.defineProperty(process, 'platform', { value: 'openharmony' });
                            process.env.ARKDATA_AVAILABLE = '0';
                        } else {
                            Object.defineProperty(process, 'platform', platform);
                        }
                        // Both semantic stores are still pending: finish the same
                        // generation using the factories' actual selected backend.
                        expectedGeneration = 1;
                    }
                    failing = false;
                    if (recovery === 'restart') {
                        await fss.close();
                        fss = new FSStorage(directory);
                        fss._probeEmbedding = probe;
                        await fss.initialize();
                    } else {
                        await fss.syncEmbeddingMode('recovery');
                    }
                    assert.equal(fss.scannerState.embedding_generation, expectedGeneration);
                    assert.equal(fss.scannerState.semantic_reset_pending, false);
                    assert.equal(fss.mode, 'full');
                    const before = (await fss.storage!.search([])).items;
                    assert.equal(before.length, ['full-reset', 'backend-switch'].includes(phase) ? 0 : 2);
                    if (before.length === 0) {
                        await fss.saveFiles(
                            files.map((file) => {
                                const stat = fs.statSync(file);
                                return {
                                    path: file,
                                    filename: path.basename(file),
                                    type: 'file',
                                    size: stat.size,
                                    modified: Math.floor(stat.mtimeMs),
                                    created: Math.floor(stat.birthtimeMs),
                                    accessed: Math.floor(stat.atimeMs)
                                };
                            }),
                            root
                        );
                    }
                    assert.ok(
                        before.every(
                            ({ item }) => item.embedded === 0 && item.embedding_generation === expectedGeneration
                        )
                    );
                    assert.equal((await fss.storage!.getStatus()).ChunkIndexer.size, 0);
                    assert.equal(await fss.processEmbeddingQueue(() => false, { activeRoots: [root] }), 2);
                    assert.equal((await fss.searchIndexedChunks('Old model content', { topK: 10 })).results.length, 0);
                    assert.equal((await fss.searchFileByName('filename')).results.length, 2);
                    const final = JSON.parse(fs.readFileSync((fss as any)._scannerStatePath, 'utf8'));
                    assert.equal(final.embedding_generation, expectedGeneration);
                    assert.equal(final.semantic_reset_pending, false);
                    await fss.syncEmbeddingMode('already-healthy');
                    assert.equal(fss.scannerState.embedding_generation, expectedGeneration);
                    if (phase === 'backend-switch') {
                        if (backend === 'native') Object.defineProperty(process, 'platform', platform);
                        else Object.defineProperty(process, 'platform', { value: 'openharmony' });
                        await fss.close();
                        fss = new FSStorage(directory);
                        fss._probeEmbedding = probe;
                        await fss.initialize();
                        assert.equal(fss.scannerState.embedding_generation, 2);
                        assert.equal(fss.scannerState.semantic_reset_pending, false);
                        assert.equal((await fss.storage!.search([])).items.length, 2);
                        assert.equal((await fss.storage!.getStatus()).ChunkIndexer.size, 0);
                        assert.equal(await fss.processEmbeddingQueue(() => false, { activeRoots: [root] }), 2);
                        assert.equal((await fss.searchIndexedChunks('old', { topK: 10 })).results.length, 0);
                    }
                } finally {
                    failing = false;
                    try {
                        await fss.close();
                    } finally {
                        Object.defineProperty(process, 'platform', platform);
                        if (available === undefined) delete process.env.ARKDATA_AVAILABLE;
                        else process.env.ARKDATA_AVAILABLE = available;
                    }
                }
            });
        }
    }
}
