import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Setting, setCustomOpendeskDirectory } from '../../../../main/utils/setting.js';
import { BaseStorage } from '../../../../main/services/storage/abstract-storage.js';
import { VectorIndexer } from '../../../../main/services/storage/vector-indexer.js';
import { toWasmDbPath } from '../../../../main/services/storage/wasm-path.js';
import { FSStorage, makeSchema } from '../../../../main/applications/filemgr/storage.js';
import { LLM } from '../../../../main/aikernel/llm.js';

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'filemgr-reset-recovery-'));
setCustomOpendeskDirectory(profile);
after(() => fs.rmSync(profile, { recursive: true, force: true }));
// Resolve the host binding before any case simulates the WASM platform.
const SQLite = createRequire(import.meta.url)('better-sqlite3');
new SQLite(':memory:').close();

const baseOnlyResetPhases = [
    'lock',
    'chunk-drop',
    'candidate-init',
    'reconcile',
    'candidate-close',
    'old-close',
    'complete-write',
    'success'
] as const;

for (const backend of ['native', 'wasm'] as const) {
    for (const phase of baseOnlyResetPhases) {
        test(`R1 F1 ${backend}: base-only semantic reset ${phase} preserves the approved publication boundary`, async (t) => {
            const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
            const available = process.env.ARKDATA_AVAILABLE;
            if (backend === 'wasm') {
                Object.defineProperty(process, 'platform', { value: 'openharmony' });
                process.env.ARKDATA_AVAILABLE = '0';
            }
            t.mock.method(Setting, 'getInstance', () => ({
                getDefaultEmbeddingModelInstance: () => ({ model_name: 'model-b' }),
                getData: () => ({})
            }));
            const embed = t.mock.method(LLM, 'embed', async () => [1, 0]);
            const batch = t.mock.method(LLM, 'batchEmbed', async (texts: string[]) => texts.map(() => [1, 0]));
            const directory = fs.mkdtempSync(path.join(profile, `base-only-${backend}-${phase}-`));
            const fss = new FSStorage(directory);
            const old = new BaseStorage('filemgr', makeSchema(2, { mode: 'base-only' }), fss._storageDir);
            fss.storage = old;
            fss.mode = 'base-only';
            const file = path.join(directory, 'old.md');
            const primary = new Error(`isolated base-only ${phase}`);
            const cleanup = new Error('isolated candidate cleanup failure');
            const lock = `${toWasmDbPath(path.join(fss._storageDir, 'chunk-index.db'))}.lock`;
            let failing = true;
            let oldCloses = 0;
            let candidateInitializations = 0;
            try {
                await old.initialize();
                await old.upsert([
                    { item_id: file, item_type: 'file', type: 'file', filename: 'old.md', ref_count: 1, embedded: 1 }
                ]);
                await fss.saveScannerState();
                if (phase === 'lock') fs.mkdirSync(lock);
                const initialize = BaseStorage.prototype.initialize;
                t.mock.method(BaseStorage.prototype, 'initialize', async function () {
                    candidateInitializations++;
                    await initialize.call(this);
                    if (failing && phase === 'candidate-init') throw primary;
                });
                const upsert = BaseStorage.prototype.upsert;
                t.mock.method(BaseStorage.prototype, 'upsert', async function (items: any[], options?: any) {
                    if (failing) {
                        assert.equal(fss.storage, old, 'Reconciliation must not publish or release the old base early');
                        assert.equal(oldCloses, 0);
                    }
                    const result = await upsert.call(this, items, options);
                    if (failing && ['reconcile', 'candidate-close'].includes(phase)) throw primary;
                    return result;
                });
                const close = BaseStorage.prototype.close;
                t.mock.method(BaseStorage.prototype, 'close', async function () {
                    if (this === old) {
                        oldCloses++;
                        if (failing && phase === 'old-close') throw primary;
                    } else if (failing && phase === 'candidate-close') throw cleanup;
                    return close.call(this);
                });
                const remove = fs.rmSync;
                t.mock.method(fs, 'rmSync', (target, options) => {
                    if (failing && phase === 'chunk-drop' && target === path.join(fss._storageDir, 'chunk-index.db'))
                        throw primary;
                    return remove(target, options);
                });
                const snapshot = fss._writeScannerStateSnapshot.bind(fss);
                t.mock.method(fss, '_writeScannerStateSnapshot', async (state, commit) => {
                    if (state.embedding_generation === 1 && !state.semantic_reset_pending) {
                        assert.ok(oldCloses > 0, 'Completion follows old-holder release');
                        assert.equal(fss.storage, null, 'Completion precedes candidate publication');
                        if (failing && phase === 'complete-write') throw primary;
                    }
                    return snapshot(state, commit);
                });
                const reset = () =>
                    fss.retrieval.rebuildProducts({
                        kind: 'semantic-reset',
                        reason: 'R1 F1',
                        dim: 2,
                        mode: 'full',
                        embeddingState: { embedding_model: 'model-b', vec_dim: 2 },
                        resume: !failing
                    });
                if (phase === 'success') await reset();
                else
                    await assert.rejects(reset(), (error: any) =>
                        phase === 'lock' ? /lock/i.test(error.message) : error === primary
                    );
                assert.equal(fss.scannerState.embedding_generation, 1);
                assert.equal(fss.scannerState.semantic_reset_pending, phase !== 'success');
                const saved = JSON.parse(fs.readFileSync(fss._scannerStatePath, 'utf8'));
                assert.equal(saved.semantic_reset_pending, phase !== 'success');
                if (!['old-close', 'complete-write', 'success'].includes(phase)) {
                    assert.equal(
                        fss.storage,
                        old,
                        'An untouched healthy base-only owner remains available after failure'
                    );
                    assert.equal(oldCloses, 0);
                    assert.deepEqual(
                        (await fss.searchFilesByKeyword('old')).map((row) => row.path),
                        [file]
                    );
                    assert.equal((await fss.retrieval.searchContent('old', { topK: 10 })).results.length, 0);
                    assert.equal(candidateInitializations, ['lock', 'chunk-drop'].includes(phase) ? 0 : 1);
                } else if (phase !== 'success') {
                    assert.equal(fss.storage, null);
                    assert.equal(
                        candidateInitializations,
                        1,
                        'Old-holder release follows candidate initialization and reconciliation'
                    );
                }
                assert.equal(
                    fss._pendingStorageClosures.size,
                    ['old-close', 'candidate-close'].includes(phase) ? 1 : 0
                );
                assert.equal(embed.mock.callCount(), 0);
                assert.equal(batch.mock.callCount(), 0);
                failing = false;
                if (phase === 'lock') fs.rmSync(lock, { recursive: true });
                if (phase !== 'success') {
                    // The retry uses the persisted pending generation and must release
                    // retained failures before deleting or creating another candidate.
                    await fss._retryStorageClosures();
                    await reset();
                }
                assert.equal(fss.mode, 'full');
                assert.notEqual(fss.storage, old);
                assert.equal(fss.scannerState.embedding_generation, 1);
                assert.equal(fss.scannerState.semantic_reset_pending, false);
                assert.equal(fss._pendingStorageClosures.size, 0);
                assert.deepEqual(
                    (await fss.searchFilesByKeyword('old')).map((row) => row.path),
                    [file]
                );
            } finally {
                failing = false;
                fs.rmSync(lock, { recursive: true, force: true });
                await fss.close();
                Object.defineProperty(process, 'platform', platform);
                if (available === undefined) delete process.env.ARKDATA_AVAILABLE;
                else process.env.ARKDATA_AVAILABLE = available;
            }
        });
    }
}

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
                fss.retrieval._probeEmbedding = probe;
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
                    const vectorClose = VectorIndexer.prototype.close;
                    t.mock.method(VectorIndexer.prototype, 'close', async function () {
                        if (failing && phase === 'vector-close') throw failure;
                        return vectorClose.call(this);
                    });
                    const storeFile = (name: string) => {
                        const file = path.join(fss._storageDir, `${name}-index.db`);
                        return backend === 'wasm' ? toWasmDbPath(file) : file;
                    };
                    const remove = fs.rmSync;
                    t.mock.method(fs, 'rmSync', (...args) => {
                        const target = String(args[0]);
                        if (
                            failing &&
                            ((phase === 'chunk-drop' && target === storeFile('chunk')) ||
                                (phase === 'full-reset' && target === `${storeFile('base')}-wal`) ||
                                ([
                                    'repeat-failure',
                                    'disable-model',
                                    'supersede-model',
                                    'change-dimension',
                                    'aba-model',
                                    'backend-switch'
                                ].includes(phase) &&
                                    target === `${storeFile('vector')}-wal`))
                        )
                            throw failure;
                        return remove(...args);
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
                        phase === 'full-reset' ? fss.rebuildAll('full-reset') : fss.retrieval._syncMode('model-change'),
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
                        assert.equal((await fss.retrieval.searchContent('old', { topK: 10 })).results.length, 0);
                        assert.equal(await fss.processEmbeddingQueue(() => false, { activeRoots: [root] }), 0);
                        const reader = new FSStorage(directory);
                        await reader.initializeReadonly();
                        try {
                            assert.equal(reader.mode, 'base-only');
                            assert.equal((await reader.retrieval.searchContent('old', { topK: 10 })).results.length, 0);
                            if (phase === 'full-reset') assert.equal(reader.isDeferred(), true);
                            else assert.equal((await reader.storage!.search([])).items.length, 2);
                        } finally {
                            await reader.close();
                        }
                    }
                    let expectedGeneration = 1;
                    if (phase === 'repeat-failure') {
                        await assert.rejects(fss.retrieval._syncMode('still-failing'), (error) => error === failure);
                        assert.equal(fss.scannerState.embedding_generation, 1, 'Retries must not advance generation');
                        assert.equal(fss.scannerState.semantic_reset_pending, true);
                    }
                    if (phase === 'disable-model') {
                        model = null;
                        await fss.retrieval._syncMode('model-removed');
                        assert.equal(fss.mode, 'base-only');
                        assert.equal(fss.scannerState.semantic_reset_pending, true);
                        assert.equal((await fss.retrieval.searchContent('old', { topK: 10 })).results.length, 0);
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
                        fss.retrieval._probeEmbedding = probe;
                        await fss.initialize();
                    } else {
                        await fss.retrieval._syncMode('recovery');
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
                    assert.equal(
                        (await fss.retrieval.searchContent('Old model content', { topK: 10 })).results.length,
                        0
                    );
                    assert.equal((await fss.retrieval.searchNames('filename')).results.length, 2);
                    const final = JSON.parse(fs.readFileSync((fss as any)._scannerStatePath, 'utf8'));
                    assert.equal(final.embedding_generation, expectedGeneration);
                    assert.equal(final.semantic_reset_pending, false);
                    await fss.retrieval._syncMode('already-healthy');
                    assert.equal(fss.scannerState.embedding_generation, expectedGeneration);
                    if (phase === 'backend-switch') {
                        if (backend === 'native') Object.defineProperty(process, 'platform', platform);
                        else Object.defineProperty(process, 'platform', { value: 'openharmony' });
                        await fss.close();
                        fss = new FSStorage(directory);
                        fss.retrieval._probeEmbedding = probe;
                        await fss.initialize();
                        assert.equal(fss.scannerState.embedding_generation, 2);
                        assert.equal(fss.scannerState.semantic_reset_pending, false);
                        assert.equal((await fss.storage!.search([])).items.length, 2);
                        assert.equal((await fss.storage!.getStatus()).ChunkIndexer.size, 0);
                        assert.equal(await fss.processEmbeddingQueue(() => false, { activeRoots: [root] }), 2);
                        assert.equal((await fss.retrieval.searchContent('old', { topK: 10 })).results.length, 0);
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
