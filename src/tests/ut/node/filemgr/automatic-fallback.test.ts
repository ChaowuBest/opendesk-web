import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Setting, setCustomOpendeskDirectory } from '../../../../main/utils/setting.js';
import { BaseStorage } from '../../../../main/services/storage/abstract-storage.js';
import { LLM } from '../../../../main/aikernel/llm.js';
const { FSStorage, makeSchema } = await import('../../../../main/applications/filemgr/storage.js');
const SQLite = createRequire(import.meta.url)('better-sqlite3');
new SQLite(':memory:').close();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'filemgr-auto-fallback-'));
setCustomOpendeskDirectory(profile);
after(() => fs.rmSync(profile, { recursive: true, force: true }));
const close = async (owner: any) => {
    await owner.close();
};
for (const scenario of ['control', 'fallback-missing', 'fallback-return', 'chunk-fallback-return'])
    test(scenario, async (t) => {
        let model = 'model-a';
        t.mock.method(Setting, 'getInstance', () => ({
            getDefaultEmbeddingModelInstance: () => ({ model_name: model }),
            getData: () => ({})
        }));
        t.mock.method(LLM, 'embed', async () => [1, 0]);
        t.mock.method(LLM, 'batchEmbed', async (texts: string[]) => texts.map(() => [1, 0]));
        t.mock.method(LLM, 'rerank', async (_q: string, items: any[]) => items);
        const directory = fs.mkdtempSync(path.join(profile, scenario + '-'));
        // 对齐产品路径约定：item_id 来自 fast-glob、root 经 renderer normalizePath，Windows 上均为正斜杠
        const root = path.join(directory, 'files').replace(/\\/g, '/');
        fs.mkdirSync(root);
        const file = `${root}/document.md`;
        fs.writeFileSync(file, '# Current B\n\nCurrent text from model B.');
        const owners: any[] = [];
        const probe = async () => ({ ok: true, model_name: model, dim: 2, requestDim: undefined });
        const loadExtension = SQLite.prototype.loadExtension;
        try {
            const initial = new FSStorage(directory);
            owners.push(initial);
            initial.storage = new BaseStorage('filemgr', makeSchema(2), initial._storageDir);
            initial.mode = 'full';
            Object.assign(initial.scannerState, {
                embedding_model: model,
                vec_dim: 2,
                chunk_level: 'structured',
                vector_backend: 'native',
                embedding_generation: 0,
                embedded_migrated: true,
                _migratedRefCount: true
            });
            initial.scannerState.roots[root] = {
                last_full_scan: 123,
                total_files: 1,
                last_scan_at: 123,
                paused: false
            };
            await initial.storage.initialize();
            await initial.storage.upsert([
                {
                    item_id: file,
                    item_type: 'file',
                    type: 'file',
                    filename: 'document.md',
                    root_refs: JSON.stringify([root]),
                    ref_count: 1,
                    embedded: 1,
                    embedding_generation: 0,
                    indexer_columns: {
                        VectorIndexer: [{ column: 'filename', content: [0, 1] }],
                        ChunkIndexer: [
                            { column: 'chunk_text', id: 'obsolete-a', text: 'Old model A text', content: [0, 1] }
                        ]
                    }
                }
            ]);
            await initial.saveScannerState();
            await close(initial);
            if (scenario !== 'control') {
                let loads = 0;
                SQLite.prototype.loadExtension = function (...args: any[]) {
                    loads++;
                    if (scenario !== 'chunk-fallback-return' || this.name.includes('chunk-index'))
                        throw new Error('fixture unavailable sqlite-vec extension');
                    return loadExtension.apply(this, args);
                };
            }
            const running = new FSStorage(directory);
            owners.push(running);
            running._probeEmbedding = probe;
            await running.initialize();
            const actual = {
                base: running.storage.baseIndexer.db.backend,
                vector: running.storage.vectorIndexer.db.backend,
                chunk: running.storage.chunkIndexer.db.backend
            };
            if (scenario === 'chunk-fallback-return') {
                assert.equal(actual.vector, 'native');
                assert.equal(actual.chunk, 'wasm');
                assert.equal(running.scannerState.vector_backend, 'native');
                assert.equal(running.scannerState.chunk_backend, 'wasm');
            }
            const initialHits = await running.searchIndexedChunks('model', { topK: 10 });
            const before = await running.getPerRootCounts([root]);
            console.log(
                JSON.stringify({
                    scenario,
                    stage: 'initial-fallback',
                    recordedBackend: running.scannerState.vector_backend,
                    actual,
                    counts: before.get(root),
                    chunks: initialHits.results
                })
            );
            if (scenario === 'fallback-missing') {
                assert.equal(actual.vector, 'wasm');
                assert.equal(running.scannerState.vector_backend, 'wasm');
                assert.equal(running.scannerState.chunk_backend, 'wasm');
                assert.equal(
                    before.get(root).pending_count,
                    1,
                    'The unchanged native base must queue missing semantic data'
                );
                assert.equal(initialHits.results.length, 0, 'Old backend chunks must not be reported as current');
                await running.processEmbeddingQueue(() => false, { activeRoots: [root] });
                const recovered = await running.searchIndexedChunks('model', { topK: 10 });
                assert.ok(recovered.results.some((hit: any) => hit.chunk.text.includes('Current')));
                assert.equal((await running.getPerRootCounts([root])).get(root).pending_count, 0);
                return;
            }
            model = 'model-b';
            await running.syncEmbeddingMode('changed model while running');
            await running.processEmbeddingQueue(() => false, { activeRoots: [root] });
            const wasmHits = await running.searchIndexedChunks('model', { topK: 10 });
            console.log(
                JSON.stringify({
                    scenario,
                    stage: 'new-model',
                    recordedBackend: running.scannerState.vector_backend,
                    chunks: wasmHits.results
                })
            );
            assert.ok(wasmHits.results.some((hit: any) => hit.chunk.text.includes('Current')));
            await close(running);
            SQLite.prototype.loadExtension = loadExtension;
            const restarted = new FSStorage(directory);
            owners.push(restarted);
            restarted._probeEmbedding = probe;
            await restarted.initialize();
            const hits = await restarted.searchIndexedChunks('model', { topK: 10 });
            console.log(
                JSON.stringify({
                    scenario,
                    stage: 'native-restored',
                    recordedBackend: restarted.scannerState.vector_backend,
                    generation: restarted.scannerState.embedding_generation,
                    chunks: hits.results
                })
            );
            assert.equal(
                hits.results.some((hit: any) => hit.chunk.id === 'obsolete-a'),
                false,
                'Returning to native must not reuse old-model native chunks marked current by the shared base DB'
            );
            assert.equal(restarted.scannerState.vector_backend, 'native');
            assert.equal(restarted.scannerState.chunk_backend, 'native');
            await restarted.processEmbeddingQueue(() => false, { activeRoots: [root] });
            assert.ok(
                (await restarted.searchIndexedChunks('model', { topK: 10 })).results.some((hit: any) =>
                    hit.chunk.text.includes('Current')
                )
            );
            assert.equal((await restarted.getPerRootCounts([root])).get(root).pending_count, 0);
            assert.ok(
                (await restarted.searchFileByName('document')).results.some(
                    (hit: any) => hit.source?.path === file || hit.path === file
                )
            );
        } finally {
            SQLite.prototype.loadExtension = loadExtension;
            await Promise.allSettled(owners.map(close));
        }
    });
