import assert from 'node:assert/strict';
import { after, beforeEach, test, type TestContext } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FSStorage, makeSchema, WARNINGS } from '../../../../main/applications/filemgr/storage.js';
import FileManagerWorker from '../../../../main/applications/filemgr/worker.js';
import { BaseStorage } from '../../../../main/services/storage/abstract-storage.js';
import { BaseIndexDB } from '../../../../main/services/storage/base-index-db.js';
import { VectorIndexDB } from '../../../../main/services/storage/vector-index-db.js';
import { ChunkIndexDB } from '../../../../main/services/storage/chunk-index-db.js';
import { VectorIndexer } from '../../../../main/services/storage/vector-indexer.js';
import { ChunkIndexer } from '../../../../main/services/storage/chunk-indexer.js';
import { BM25Indexer } from '../../../../main/services/storage/bm25-indexer.js';
import { recordStorageInitializationFailure } from '../../../../main/services/storage/platform.js';
import { toWasmDbPath } from '../../../../main/services/storage/wasm-path.js';
import { VectorIndexDBWasm } from '../../../../main/services/storage/vector-index-db-wasm.js';
import { LLM } from '../../../../main/aikernel/llm.js';
import { Setting, setCustomOpendeskDirectory } from '../../../../main/utils/setting.js';
import { deferred, flush } from './recovery-fixture.js';

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wf1-recovery-'));
setCustomOpendeskDirectory(profile);
after(() => fs.rmSync(profile, { recursive: true, force: true }));
let modelConfigured = true;

beforeEach((t) => {
    modelConfigured = true;
    t.mock.method(Setting, 'getInstance', () => ({
        getData: () => ({}),
        getDefaultEmbeddingModelInstance: () =>
            modelConfigured ? { model_name: 'wf1-fixture', getTimeoutMs: () => 1000 } : null
    }));
    t.mock.method(LLM, 'embed', async () => [1, 0]);
    t.mock.method(LLM, 'batchEmbed', async (texts: string[]) => texts.map(() => [1, 0]));
    t.mock.method(LLM, 'rerank', async (_query: string, rows: any[]) => rows);
});

async function owner(t: TestContext, { fullText = true } = {}) {
    const directory = fs.mkdtempSync(path.join(profile, 'case-'));
    const fss = new FSStorage(directory);
    t.after(() => fss.close());
    if (!fullText) {
        const create = fss._newStorageHolder.bind(fss);
        t.mock.method(fss, '_newStorageHolder', (options) => create({ ...options, fullText: 'off' }));
    }
    await fss.initialize({ syncEmbedding: false });
    const file = path.join(directory, 'retained.md');
    fs.writeFileSync(file, 'retained isolated base record');
    const stat = fs.statSync(file);
    await fss.saveFiles(
        [
            {
                path: file,
                filename: 'retained.md',
                type: 'file',
                size: stat.size,
                modified: Math.floor(stat.mtimeMs),
                created: Math.floor(stat.birthtimeMs),
                accessed: Math.floor(stat.atimeMs)
            }
        ],
        directory
    );
    return { fss, file };
}

function spyDrops(t: TestContext) {
    const drops: string[][] = [];
    const original = BaseStorage.prototype.dropIndexers;
    t.mock.method(BaseStorage.prototype, 'dropIndexers', async function (indexers) {
        drops.push([...indexers]);
        return original.call(this, indexers);
    });
    return drops;
}

function constructorFault(t: TestContext, Database: any, failure: Error, once = false) {
    const initializeTable = Database.prototype.initializeTable;
    let injected = false;
    t.mock.method(Database.prototype, 'initializeTable', function (...args: any[]) {
        if (!once || !injected) {
            injected = true;
            throw failure;
        }
        return initializeTable.apply(this, args);
    });
}

test('WF2 readonly selection exceptions close both probes and preserve the original failure', async (t) => {
    const { fss } = await owner(t);
    Object.assign(fss.scannerState, { embedding_model: 'wf1-fixture', vec_dim: 2 });
    await fss.saveScannerState();
    await fss.close();
    const reader = new FSStorage(fss._appDataDirectory);
    t.after(() => reader.close());
    const primary = new Error('readonly semantic selection failed');
    const created: BaseStorage[] = [];
    const closed: BaseStorage[] = [];
    const create = reader._newStorageHolder.bind(reader);
    t.mock.method(reader, '_newStorageHolder', async (options) => {
        const result = await create(options);
        created.push(result.holder);
        return result;
    });
    const close = BaseStorage.prototype.close;
    t.mock.method(BaseStorage.prototype, 'close', async function () {
        closed.push(this);
        return close.call(this);
    });
    t.mock.method(BaseStorage.prototype, 'probeIndexers', async () => {
        throw primary;
    });
    await assert.rejects(reader.initializeReadonly(), (error: unknown) => error === primary);
    assert.equal(created.length, 2, 'base and full selection probes were both constructed');
    assert.deepEqual(closed, created, 'every selection probe is closed before rejecting');
    assert.equal(reader.storage, null);
    assert.equal(reader.deferredReason, null);
});

const ordinaryCodes = ['EACCES', 'SQLITE_BUSY', 'EIO', 'SQLITE_NOTADB', undefined];
for (const phase of ['initialize', 'replace', 'reset', 'readonly', 'rebuild'] as const) {
    test(`WF2 optional BM25 failure preserves ${phase} publication and mode`, async (t) => {
        const { fss, file } = await owner(t);
        await fss.close();
        const database = path.join(fss._storageDir, 'bm25-index.db');
        if (phase !== 'rebuild') {
            fs.rmSync(database);
            fs.mkdirSync(database);
        }
        let injected = 0;
        if (phase === 'rebuild') {
            t.mock.method(BM25Indexer.prototype, 'initialize', async () => {
                injected++;
                const error = new Error('WF2 isolated BM25 dependency failure');
                recordStorageInitializationFailure(error, { indexer: 'BM25Indexer' });
                throw error;
            });
        }
        if (phase === 'readonly') {
            await fss.initializeReadonly();
        } else {
            await fss.initialize({ syncEmbedding: false });
            if (phase === 'replace') await fss.retrieval.prepare({ context: {}, reason: 'WF2 replace', role: 'write' });
            if (phase === 'reset') {
                await fss.retrieval.rebuildProducts({
                    kind: 'semantic-reset',
                    reason: 'WF2 reset',
                    dim: 2,
                    mode: 'full'
                });
            }
            if (phase === 'rebuild') {
                modelConfigured = false;
                await fss.rebuildAll('WF2 optional failure');
                assert.ok(injected > 0);
                assert.equal(fss.scannerState.bm25_reset_pending, true);
            }
        }
        assert.deepEqual(fss.getFullTextState(), { available: false, reason: 'open_failed' });
        assert.equal(fss.mode, ['replace', 'reset'].includes(phase) ? 'full' : 'base-only');
        assert.equal(fss.deferredReason, null);
        assert.equal((await fss.searchFilesByKeyword('retained')).length, phase === 'rebuild' ? 0 : 1);
        if (phase !== 'rebuild')
            assert.equal(fs.statSync(database).isDirectory(), true, 'ordinary errors do not delete the failed store');
        assert.equal(fss._pendingStorageClosures.size, 0);
        assert.ok(file);
    });
}

for (const bind of [false, true]) {
    for (const indexer of ['BaseIndexer', 'VectorIndexer', 'ChunkIndexer'] as const) {
        test(`WF2 non-BM25 ${indexer} recovery retains its policy with binding=${bind}`, async (t) => {
            const { fss } = await owner(t);
            await fss.close();
            const construct = fss._newStorageHolder.bind(fss);
            t.mock.method(fss, '_newStorageHolder', (request) =>
                construct({ ...request, fullText: bind ? 'optional' : 'off' })
            );
            const Database = { BaseIndexer: BaseIndexDB, VectorIndexer: VectorIndexDB, ChunkIndexer: ChunkIndexDB }[
                indexer
            ];
            const failure = Object.assign(new Error(`isolated ${indexer} corrupt`), { code: 'SQLITE_CORRUPT' });
            constructorFault(t, Database, failure, true);
            await fss.initialize();
            assert.equal(fss.mode, 'full');
            assert.equal(fss.scannerState.semantic_reset_pending, false);
            assert.equal(fss.scannerState.last_rebuild_event.type, indexer === 'BaseIndexer' ? 'full' : 'vector');
            assert.equal(fss._pendingStorageClosures.size, 0);
        });
    }
}

for (const code of ordinaryCodes) {
    test(`P3a ordinary base initialization ${code ?? 'unknown'} preserves generation and original failure`, async (t) => {
        modelConfigured = false;
        const { fss } = await owner(t);
        await fss.close();
        const failure = Object.assign(new Error('isolated ordinary base initialization failure'), { code });
        constructorFault(t, BaseIndexDB, failure, true);
        const drops = spyDrops(t);
        let received: unknown;
        try {
            await fss.initialize({ syncEmbedding: false });
        } catch (error) {
            received = error;
        }
        assert.equal(fss.scannerState.embedding_generation, 0, 'ordinary failure must not invalidate products');
        assert.equal(received, failure, 'the original opening error must reach the caller');
        assert.equal(drops.length, 0);
    });
}

for (const metadata of ['consistent', 'missing']) {
    for (const code of ordinaryCodes) {
        for (const fullText of [false, true]) {
            test(`P3a ordinary semantic opening ${metadata}/${code ?? 'unknown'}/bm25=${fullText} never drops products`, async (t) => {
                const { fss } = await owner(t, { fullText });
                assert.equal(Boolean(fss.storage.schema.needIndexers.full_text), fullText);
                if (metadata === 'consistent') {
                    Object.assign(fss.scannerState, {
                        vec_dim: 2,
                        embedding_model: 'wf1-fixture',
                        chunk_level: 'structured',
                        vector_backend: 'native',
                        chunk_backend: 'native',
                        embedded_migrated: true
                    });
                    await fss.saveScannerState();
                }
                const previous = fss.storage;
                const failure = Object.assign(new Error('isolated ordinary vector opening failure'), { code });
                constructorFault(t, VectorIndexDB, failure);
                const drops = spyDrops(t);
                await assert.rejects(
                    fss.retrieval.prepare({ context: {}, reason: 'P3a ordinary error', role: 'write' }),
                    (error: unknown) => error === failure
                );
                assert.equal(drops.length, 0, 'ordinary or NOTADB errors never authorize a semantic reset');
                assert.equal(fss.scannerState.embedding_generation, 0);
                assert.equal(fss.scannerState.semantic_reset_pending, false);
                assert.equal(fss.storage, previous, 'a healthy pre-swap base remains owned by FSStorage');
                assert.equal(fss._pendingStorageClosures.size, 0);
            });
        }
    }
}

for (const selection of ['full', 'semantic-missing', 'backend-mismatch']) {
    test(`WF2 readonly ${selection} closes every discarded probe and holder`, async (t) => {
        const { fss } = await owner(t);
        await fss.retrieval.prepare({ context: {}, reason: 'readonly fixture', role: 'write' });
        assert.equal(fss.mode, 'full');
        if (selection === 'backend-mismatch') {
            fss.scannerState.vector_backend = 'wasm';
            await fss.saveScannerState();
        }
        await fss.close();
        const reader = new FSStorage(fss._appDataDirectory);
        t.after(() => reader.close());
        const created: BaseStorage[] = [];
        const closed = new Set<BaseStorage>();
        const create = reader._newStorageHolder.bind(reader);
        t.mock.method(reader, '_newStorageHolder', async (options) => {
            const result = await create(options);
            created.push(result.holder);
            const close = result.holder.close.bind(result.holder);
            t.mock.method(result.holder, 'close', async () => {
                await close();
                closed.add(result.holder);
            });
            return result;
        });
        if (selection === 'semantic-missing') {
            const probe = BaseStorage.prototype.probeIndexers;
            t.mock.method(BaseStorage.prototype, 'probeIndexers', function (names) {
                return names.includes('VectorIndexer')
                    ? Promise.resolve({ VectorIndexer: 'missing', ChunkIndexer: 'missing' })
                    : probe.call(this, names);
            });
        }
        await reader.initializeReadonly();
        assert.equal(reader.mode, selection === 'full' ? 'full' : 'base-only');
        assert.equal(created.length, selection === 'backend-mismatch' ? 4 : 3);
        assert.ok(created.filter((holder) => holder !== reader.storage).every((holder) => closed.has(holder)));
        assert.equal(closed.has(reader.storage), false, 'the published holder remains open');
    });
}

test('P3a base CORRUPT discovered while opening full uses full recovery, not a semantic-only reset', async (t) => {
    const { fss } = await owner(t);
    const failure = Object.assign(new Error('isolated base corruption'), { code: 'SQLITE_CORRUPT' });
    constructorFault(t, BaseIndexDB, failure, true);
    await fss.retrieval.prepare({ context: {}, reason: 'P3a base corruption', role: 'write' });
    assert.equal(
        (await fss.storage!.search([])).items.length,
        0,
        'base corruption must not preserve the old base record'
    );
    assert.equal(fss.scannerState.last_rebuild_event?.type, 'full');
    assert.equal(fss.scannerState.semantic_reset_pending, false);
});

for (const Database of [VectorIndexDB, ChunkIndexDB]) {
    test(`P3a ${Database.name} confirmed CORRUPT rebuilds semantic products and preserves base`, async (t) => {
        const { fss, file } = await owner(t);
        const failure = Object.assign(new Error('isolated semantic corruption'), { code: 'SQLITE_CORRUPT_INDEX' });
        constructorFault(t, Database, failure, true);
        await fss.retrieval.prepare({ context: {}, reason: 'P3a semantic corruption', role: 'write' });
        const rows = (await fss.storage!.search([])).items;
        assert.deepEqual(
            rows.map(({ item }: any) => item.item_id),
            [file]
        );
        assert.equal(fss.scannerState.embedding_generation, 1);
        assert.equal(fss.scannerState.semantic_reset_pending, false);
    });
}

test('P3a DimMismatch remains a semantic compatibility reset and preserves base', async (t) => {
    const { fss, file } = await owner(t);
    const old = new BaseStorage('filemgr', makeSchema(3), fss._storageDir);
    await old.initialize();
    await old.upsert(
        [
            {
                item_id: file,
                item_type: 'file',
                indexer_columns: { VectorIndexer: [{ column: 'filename', content: [1, 0, 0] }] }
            }
        ],
        { indexers: ['VectorIndexer'] }
    );
    await old.close();
    await fss.retrieval.prepare({ context: {}, reason: 'P3a stored dimension mismatch', role: 'write' });
    assert.deepEqual(
        (await fss.storage!.search([])).items.map(({ item }: any) => item.item_id),
        [file]
    );
    assert.equal(fss.scannerState.embedding_generation, 1);
});

for (const code of [undefined, 'SQLITE_CORRUPT']) {
    test(`P3a WASM semantic initialization ${code ?? 'unknown'} does not authorize destructive recovery`, async (t) => {
        const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
        const arkdata = process.env.ARKDATA_AVAILABLE;
        Object.defineProperty(process, 'platform', { value: 'openharmony' });
        delete process.env.ARKDATA_AVAILABLE;
        t.after(() => {
            Object.defineProperty(process, 'platform', descriptor);
            if (arkdata === undefined) delete process.env.ARKDATA_AVAILABLE;
            else process.env.ARKDATA_AVAILABLE = arkdata;
        });
        const { fss } = await owner(t, { fullText: false });
        const failure = Object.assign(new Error('isolated WASM initialization failure'), { code });
        t.mock.method(VectorIndexDBWasm.prototype as any, 'initializeInternal', async () => {
            throw failure;
        });
        const drops = spyDrops(t);
        await assert.rejects(
            fss.retrieval.prepare({ context: {}, reason: 'P3a WASM ordinary error', role: 'write' }),
            (error: unknown) => error === failure
        );
        assert.equal(drops.length, 0);
        assert.equal(fss.scannerState.embedding_generation, 0);
    });
}

test('P3a candidate close failure preserves the primary opening error and blocks recovery', async (t) => {
    const { fss } = await owner(t);
    const previous = fss.storage;
    const primary = Object.assign(new Error('isolated native corruption'), { code: 'SQLITE_CORRUPT' });
    const cleanup = new Error('isolated candidate close failure');
    constructorFault(t, VectorIndexDB, primary, true);
    const drops = spyDrops(t);
    let failClose = true;
    const close = BaseStorage.prototype.close;
    t.mock.method(BaseStorage.prototype, 'close', function () {
        return this !== previous && failClose ? Promise.reject(cleanup) : close.call(this);
    });
    try {
        await assert.rejects(
            fss.retrieval.prepare({ context: {}, reason: 'P3a candidate close', role: 'write' }),
            (error: unknown) => error === primary
        );
        assert.equal(drops.length, 0);
        assert.equal(fss.scannerState.embedding_generation, 0);
        assert.equal(fss.storage, previous);
        assert.equal(fss._pendingStorageClosures.size, 1);
    } finally {
        failClose = false;
    }
});

async function workerOwner(t: TestContext) {
    const fixture = await owner(t);
    const root = path.join(fixture.fss._appDataDirectory, 'files');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'not-yet-indexed.txt'), 'isolated newly observed file');
    const entry = { root, include_patterns: ['**/*'], exclude_patterns: [] };
    fixture.fss.scannerState.roots[root] = {
        last_full_scan: 0,
        last_scan_at: null,
        total_files: 0,
        last_file_count: 0,
        paused: false
    };
    await fixture.fss.saveScannerState();
    const worker = new FileManagerWorker('wf1-recovery', fixture.fss._appDataDirectory);
    worker.storage = fixture.fss;
    worker.config = { entries: [entry] };
    worker.callApp = async () => {};
    t.after(() => worker.finalize());
    return { ...fixture, root, entry, worker };
}

test('P3a actual startup continuation reports its ordinary open failure without clearing products', async (t) => {
    const { fss, worker } = await workerOwner(t);
    const primary = Object.assign(new Error('isolated startup permission failure'), { code: 'EACCES' });
    constructorFault(t, VectorIndexDB, primary);
    const drops = spyDrops(t);
    worker.status = 'initializing';
    worker._initializing = true;
    const seq = worker._nextInitSeq();
    await worker.runSequentially(() => worker._continueInitializeAfterProbe(seq, 'P3a startup'));
    assert.equal(worker.status, 'error');
    assert.equal(worker._initError, primary);
    assert.equal(worker._initializing, false);
    assert.equal(worker.scanners.size, 0);
    assert.equal(drops.length, 0);
    assert.equal(fss.scannerState.embedding_generation, 0);
    const status = await worker.getFileSystemStatus();
    assert.equal(status.alerts.find(({ code }: any) => code === 'worker_init_failed')?.data.reason, primary.message);
});

test('P3a actual initial base failure reaches Worker error with the original reason', async (t) => {
    const { fss, worker } = await workerOwner(t);
    await fss.close();
    modelConfigured = false;
    const primary = Object.assign(new Error('isolated base I/O failure'), { code: 'EIO' });
    constructorFault(t, BaseIndexDB, primary);
    const drops = spyDrops(t);
    await worker.initialize();
    await worker.taskQueue.onIdle();
    assert.equal(worker.status, 'error');
    assert.equal(worker._initError, primary);
    assert.equal(worker.storage, null);
    assert.equal(worker.scanners.size, 0);
    assert.equal(drops.length, 0);
    assert.equal(fss.scannerState.embedding_generation, 0);
    const status = await worker.getFileSystemStatus();
    assert.equal(status.alerts.find(({ code }: any) => code === 'worker_init_failed')?.data.reason, primary.message);
});

test('P3a actual scanner and independent config notification preserve their established failure states', async (t) => {
    const { fss, worker, root, entry, file } = await workerOwner(t);
    const primary = Object.assign(new Error('isolated runtime vector I/O failure'), { code: 'EIO' });
    constructorFault(t, VectorIndexDB, primary);
    const drops = spyDrops(t);
    const saves = t.mock.method(fss, 'saveFiles', async () => {
        assert.fail('prepare failure precedes base saving');
    });
    worker.status = 'running';
    worker._lastConfig = worker.config;
    const scanner = await worker._startScanner(entry, [entry]);
    await worker.taskQueue.onIdle();
    assert.equal(saves.mock.callCount(), 0);
    assert.equal(worker.status, 'running');
    assert.equal(worker._initError, null);
    assert.ok(scanner._scheduledTimeout, 'the ordinary interval remains scheduled');
    assert.equal(scanner._counter, 0, 'the first full scan did not complete');
    const timer = scanner._scheduledTimeout;
    const immediate = t.mock.method(scanner, 'requestImmediateScan');
    await assert.rejects(worker.embeddingConfigChanged(), (error: unknown) => error === primary);
    assert.equal(worker.status, 'running');
    assert.equal(worker._pendingEmbeddingConfigChange, false);
    assert.equal(immediate.mock.callCount(), 0);
    assert.equal(scanner._scheduledTimeout, timer);
    assert.equal(worker.scanners.get(root), scanner);
    assert.equal(drops.length, 0);
    assert.equal(fss.scannerState.embedding_generation, 0);
    assert.deepEqual(
        (await fss.storage!.search([])).items.map(({ item }: any) => item.item_id),
        [file]
    );
});

for (const entryPoint of ['scan', 'config']) {
    test(`R1 F1 actual ${entryPoint} keeps a healthy base-only owner after semantic raw deletion fails`, async (t) => {
        const { fss, worker, entry, file } = await workerOwner(t);
        const old = fss.storage;
        constructorFault(
            t,
            VectorIndexDB,
            Object.assign(new Error('isolated semantic corruption'), { code: 'SQLITE_CORRUPT' }),
            true
        );
        const primary = Object.assign(new Error('isolated semantic deletion failure'), { code: 'EIO' });
        let failing = true;
        const remove = fs.rmSync;
        t.mock.method(fs, 'rmSync', (target, options) => {
            if (failing && target === path.join(fss._storageDir, 'chunk-index.db')) throw primary;
            return remove(target, options);
        });
        const saves = t.mock.method(fss, 'saveFiles', async () =>
            assert.fail('Failed prepare still aborts this scan before saveFiles')
        );
        worker.status = 'running';
        worker._lastConfig = worker.config;
        try {
            if (entryPoint === 'scan') {
                await worker._startScanner(entry, [entry]);
                await worker.taskQueue.onIdle();
                assert.ok(worker.scanners.get(entry.root)?._scheduledTimeout);
            } else await assert.rejects(worker.embeddingConfigChanged(), (error) => error === primary);
            assert.equal(worker.status, 'running');
            assert.equal(worker._initError, null);
            assert.equal(fss.storage, old);
            assert.equal(fss.scannerState.semantic_reset_pending, true);
            assert.equal(fss.scannerState.embedding_generation, 1);
            assert.equal(worker._pendingEmbeddingConfigChange, false);
            assert.equal(saves.mock.callCount(), 0);
            assert.deepEqual(
                (await worker.searchFilesByKeyword('retained')).map((row) => row.path),
                [file]
            );
            failing = false;
            saves.mock.restore();
            await worker.embeddingConfigChanged();
            assert.equal(fss.mode, 'full');
            assert.equal(fss.scannerState.embedding_generation, 1);
            assert.equal(fss.scannerState.semantic_reset_pending, false);
            assert.notEqual(fss.storage, old);
        } finally {
            failing = false;
        }
    });
}

for (const mode of ['full', 'base-only', 'unopened']) {
    test(`P3b full reset from ${mode} closes owners and deletes both semantic stores before base`, async (t) => {
        const { fss } = await owner(t);
        await fss.retrieval.prepare({ context: {}, reason: 'P3b seed full stores', role: 'write' });
        if (mode === 'base-only') {
            modelConfigured = false;
            await fss.retrieval.prepare({ context: {}, reason: 'P3b seed base-only', role: 'write' });
            modelConfigured = true;
        } else if (mode === 'unopened') await fss.close();
        const current = fss.storage;
        const events: string[] = [];
        const close = BaseStorage.prototype.close;
        t.mock.method(BaseStorage.prototype, 'close', async function () {
            await close.call(this);
            if (this === current) events.push('closed-current');
        });
        const initialize = BaseStorage.prototype.initialize;
        t.mock.method(BaseStorage.prototype, 'initialize', async function () {
            events.push('initialize');
            return initialize.call(this);
        });
        const remove = fs.rmSync;
        t.mock.method(fs, 'rmSync', (...args) => {
            if (
                ['vector-index.db', 'chunk-index.db', 'base-index.db'].some(
                    (name) => String(args[0]) === path.join(fss._storageDir, name)
                )
            )
                events.push('remove:' + path.basename(String(args[0])));
            return remove(...args);
        });
        await fss.rebuildAll('P3b full reset');
        const beforeOpen = events.slice(0, events.indexOf('initialize'));
        assert.deepEqual(
            beforeOpen.filter((event) => event.startsWith('remove:')),
            ['remove:vector-index.db', 'remove:chunk-index.db', 'remove:base-index.db']
        );
        if (current) assert.equal(beforeOpen[0], 'closed-current');
        assert.equal((await fss.storage!.search([])).items.length, 0);
    });
}

for (const lockedStore of ['vector-index.db', 'chunk-index.db', 'base-index.db']) {
    for (const present of [true, false]) {
        test(`P3b aggregate WASM lock ${lockedStore}, main exists=${present}: zero remove and initialize`, async (t) => {
            const directory = fs.mkdtempSync(path.join(profile, 'locked-'));
            const fss = new FSStorage(directory);
            t.after(() => fss.close());
            const seed = new BaseStorage('filemgr', makeSchema(2), fss._storageDir);
            await seed.initialize();
            await seed.close();
            const targets = ['vector-index.db', 'chunk-index.db', 'base-index.db'].map((name) =>
                path.join(fss._storageDir, name)
            );
            for (const target of targets) fs.writeFileSync(toWasmDbPath(target), 'isolated unopened WASM leftover');
            const locked = path.join(fss._storageDir, lockedStore);
            if (!present) {
                fs.rmSync(locked);
                fs.rmSync(toWasmDbPath(locked));
            }
            const lock = `${toWasmDbPath(locked)}.lock`;
            fs.mkdirSync(lock);
            const snapshot = new Map(
                targets
                    .flatMap((target) => [target, toWasmDbPath(target)])
                    .filter((file) => fs.existsSync(file))
                    .map((file) => [file, fs.readFileSync(file)])
            );
            const removed: string[] = [];
            const remove = fs.rmSync;
            t.mock.method(fs, 'rmSync', (...args) => {
                if (String(args[0]).startsWith(fss._storageDir + path.sep)) removed.push(String(args[0]));
                return remove(...args);
            });
            const initialize = t.mock.method(BaseStorage.prototype, 'initialize');
            let received: any;
            try {
                await fss.rebuildAll('P3b locked target');
            } catch (error) {
                received = error;
            }
            assert.deepEqual(removed, [], 'the entire target set is checked before the first native/WASM removal');
            assert.equal(initialize.mock.callCount(), 0);
            assert.equal(received?.code, 'EBUSY');
            assert.ok(fs.existsSync(lock), 'product code never clears a lock');
            for (const [file, bytes] of snapshot) assert.deepEqual(fs.readFileSync(file), bytes);
            assert.equal(fss.scannerState.semantic_reset_pending, true);
            assert.equal(fss.scannerState.embedding_generation, 1);
        });
    }
}

for (const Indexer of [VectorIndexer, ChunkIndexer]) {
    test(`P3b ${Indexer.name} retries a real partial deletion instead of returning early`, async (t) => {
        const directory = fs.mkdtempSync(path.join(profile, 'partial-'));
        const file = path.join(directory, Indexer === VectorIndexer ? 'vector-index.db' : 'chunk-index.db');
        const indexer = new Indexer(makeSchema(2), file, { dim: 2 });
        t.after(() => indexer.close());
        await indexer.initialize();
        const leftover = `${toWasmDbPath(file)}.hnsw.json`;
        fs.writeFileSync(leftover, '{}');
        const primary = Object.assign(new Error('isolated partial removal'), { code: 'EIO' });
        const remove = fs.rmSync;
        let failing = true;
        t.mock.method(fs, 'rmSync', (...args) => {
            if (failing && String(args[0]) === `${file}-wal`) throw primary;
            return remove(...args);
        });
        await assert.rejects(indexer.dropStorage(), (error: unknown) => error === primary);
        assert.equal(fs.existsSync(file), false, 'the first attempt has already removed the main file');
        assert.equal(fs.existsSync(leftover), true);
        await assert.rejects(indexer.getInfo(), /dropped/i);
        failing = false;
        await indexer.dropStorage();
        assert.equal(fs.existsSync(leftover), false, 'the retry really completes physical deletion');
    });

    for (const dropFails of [true, false]) {
        test(`P3b ${Indexer.name} deletion fails=${dropFails}, close fails: retry preserves error and owner`, async () => {
            const indexer = new Indexer(makeSchema(2), path.join(profile, 'fake-closed.db'), { dim: 2 });
            const primary = new Error('isolated delete failure');
            const cleanup = new Error('isolated final close failure');
            let failing = true;
            let deletes = 0;
            let closes = 0;
            const db = {
                async dropStorage() {
                    deletes++;
                    if (dropFails && failing) throw primary;
                },
                async close() {
                    closes++;
                    if (failing) throw cleanup;
                }
            };
            (indexer as any).db = db;
            try {
                await assert.rejects(
                    indexer.dropStorage(),
                    (error: unknown) => error === (dropFails ? primary : cleanup)
                );
                assert.equal((indexer as any).db, db);
                await assert.rejects(indexer.getInfo(), /dropped/i);
                failing = false;
                await indexer.dropStorage();
                assert.equal(deletes, dropFails ? 2 : 1);
                assert.equal(closes, 2);
                assert.equal((indexer as any).db, null);
            } finally {
                failing = false;
                await indexer.close();
            }
        });
    }

    test(`P3b BaseStorage rejects base queries after its first ${Indexer.name} partially deletes`, async (t) => {
        const directory = fs.mkdtempSync(path.join(profile, 'poisoned-'));
        const storage = new BaseStorage('filemgr', makeSchema(2), directory);
        t.after(() => storage.close());
        await storage.initialize();
        const target = path.join(directory, Indexer === VectorIndexer ? 'vector-index.db' : 'chunk-index.db');
        const primary = new Error('isolated first-indexer partial removal');
        const remove = fs.rmSync;
        t.mock.method(fs, 'rmSync', (...args) => {
            if (String(args[0]) === `${target}-wal`) throw primary;
            return remove(...args);
        });
        await assert.rejects(storage.dropIndexers([Indexer.name] as any), (error: unknown) => error === primary);
        await assert.rejects(storage.search([]), /partially-dropped|closing|closed/i);
    });
}

test('P3b an unreadable last target lock aborts aggregate preflight before deletion or initialization', async (t) => {
    const directory = fs.mkdtempSync(path.join(profile, 'lock-check-error-'));
    const fss = new FSStorage(directory);
    t.after(() => fss.close());
    const seed = new BaseStorage('filemgr', makeSchema(2), fss._storageDir);
    await seed.initialize();
    await seed.close();
    const primary = Object.assign(new Error('isolated lock preflight permission error'), { code: 'EACCES' });
    const lastLock = `${toWasmDbPath(path.join(fss._storageDir, 'base-index.db'))}.lock`;
    const lstat = fs.lstatSync;
    t.mock.method(fs, 'lstatSync', (...args) => {
        if (String(args[0]) === lastLock) throw primary;
        return lstat(...args);
    });
    const remove = t.mock.method(fs, 'rmSync');
    const initialize = t.mock.method(BaseStorage.prototype, 'initialize');
    let received: unknown;
    try {
        await fss.rebuildAll('P3b unreadable lock');
    } catch (error) {
        received = error;
    }
    assert.equal(remove.mock.callCount(), 0);
    assert.equal(initialize.mock.callCount(), 0);
    assert.equal(received, primary);
});

test('P3c reset without FSStorage loads the saved generation and persists current roots before scheduling', async (t) => {
    modelConfigured = false;
    const { fss, worker, root, file } = await workerOwner(t);
    const paused = path.join(fss._appDataDirectory, 'paused');
    const removed = path.join(fss._appDataDirectory, 'removed');
    const added = path.join(fss._appDataDirectory, 'added');
    for (const directory of [paused, removed, added]) fs.mkdirSync(directory);
    for (const directory of [paused, removed])
        fss.scannerState.roots[directory] = {
            last_full_scan: 123,
            last_scan_at: 123,
            total_files: 1,
            last_file_count: 1,
            paused: directory === paused
        };
    fss.scannerState.embedding_generation = 5;
    await fss.saveScannerState();
    await fss.close();
    worker.storage = null;
    worker.status = 'error';
    worker._initError = new Error('previous initialization failure');
    worker.config = {
        entries: [root, paused, added].map((root) => ({ root, include_patterns: ['**/*'], exclude_patterns: [] }))
    };
    const start = worker._startScanner.bind(worker);
    t.mock.method(worker, '_startScanner', async (entry: any, ...args: any[]) => {
        const saved = JSON.parse(fs.readFileSync(fss._scannerStatePath, 'utf8'));
        assert.ok(saved.roots[entry.root], 'configured root exists on disk before any scan is scheduled');
        return start(entry, ...args);
    });
    const result = await worker.resetFileSystemStorage();
    assert.equal(result.status, 'ok');
    await worker.taskQueue.onIdle();
    assert.equal(worker.storage!.scannerState.embedding_generation, 6);
    assert.equal(worker._initError, null);
    assert.ok(worker.scanners.get(root)?.isRunning());
    assert.ok(worker.scanners.get(added)?.isRunning());
    assert.equal(worker.scanners.has(paused), false);
    assert.equal(worker.scanners.has(removed), false);
    const saved = JSON.parse(fs.readFileSync(fss._scannerStatePath, 'utf8'));
    assert.equal(saved.roots[paused].paused, true);
    assert.equal(saved.roots[removed], undefined);
    assert.ok(saved.roots[added]);
    assert.equal(
        (await worker.storage!.storage!.search([])).items.some(({ item }: any) => item.item_id === file),
        false
    );
});

test('P3c no-storage reset obtains the write lock before touching stores and can retry after denial', async (t) => {
    modelConfigured = false;
    const { fss, worker } = await workerOwner(t);
    await fss.close();
    worker.storage = null;
    worker.status = 'error';
    worker._initError = new Error('old failure');
    let allowed = false;
    const acquire = t.mock.method(worker, '_acquireScanLock', async () => {
        if (allowed) worker._releaseScanLock = async () => {};
        return allowed;
    });
    const initialize = t.mock.method(BaseStorage.prototype, 'initialize');
    const bytes = fs.readFileSync(path.join(fss._storageDir, 'base-index.db'));
    const denied = await worker.resetFileSystemStorage();
    assert.equal(acquire.mock.callCount(), 1);
    assert.equal(denied.status, 'error');
    assert.equal(initialize.mock.callCount(), 0);
    assert.deepEqual(fs.readFileSync(path.join(fss._storageDir, 'base-index.db')), bytes);
    const status = await worker.getFileSystemStatus();
    assert.equal(status.alerts.find(({ code }: any) => code === 'worker_init_failed')?.data.reason, denied.message);
    allowed = true;
    assert.equal((await worker.resetFileSystemStorage()).status, 'ok');
    await worker.taskQueue.onIdle();
});

for (const target of ['vector', 'chunk', 'base']) {
    test(`P3c ${target} raw deletion failure enters error and blocks every automatic recovery entry`, async (t) => {
        const { fss, worker, root } = await workerOwner(t);
        await fss.retrieval.prepare({ context: {}, reason: 'P3c full seed', role: 'write' });
        assert.equal(await worker._acquireScanLock(), true);
        worker.status = 'running';
        worker._lastConfig = worker.config;
        worker._initError = new Error('stale earlier failure');
        const primary = Object.assign(new Error(`isolated ${target} removal failure`), { code: 'EIO' });
        const remove = fs.rmSync;
        let failed = false;
        let failing = true;
        let initializedAfterFailure = 0;
        t.mock.method(fs, 'rmSync', (...args) => {
            if (failing && String(args[0]) === path.join(fss._storageDir, `${target}-index.db`)) {
                failed = true;
                throw primary;
            }
            return remove(...args);
        });
        const initialize = BaseStorage.prototype.initialize;
        t.mock.method(BaseStorage.prototype, 'initialize', function () {
            if (failed) initializedAfterFailure++;
            return initialize.call(this);
        });
        try {
            const result = await worker.resetFileSystemStorage();
            await worker.taskQueue.onIdle();
            assert.equal(result.status, 'error');
            assert.equal(result.message, primary.message);
            assert.equal(
                initializedAfterFailure,
                0,
                'a failed reset cannot restart a scanner into deferred initialization'
            );
            assert.equal(worker.status, 'error');
            assert.equal(worker._initError, primary);
            assert.equal(worker.scanners.size, 0);
            const other = path.join(fss._appDataDirectory, 'later-root');
            fs.mkdirSync(other);
            await worker.applicationConfigChanged({
                entries: [{ root: other, include_patterns: ['**/*'], exclude_patterns: [] }]
            });
            await worker.embeddingConfigChanged();
            assert.equal((await worker.setSourcePaused({ root, paused: false })).status, 'error');
            await worker.runSequentially(() => worker._restartScanners());
            worker._scheduleInitializeContinuation(worker._initSeq, 'stale continuation after reset failure');
            await worker.taskQueue.onIdle();
            await assert.rejects(
                worker._rebuildAndRestart('stale automatic rebuild'),
                (error: unknown) => error === primary
            );
            assert.equal(initializedAfterFailure, 0);
            assert.equal(worker.status, 'error');
            assert.equal(worker._initError, primary);
            const status = await worker.getFileSystemStatus();
            assert.equal(
                status.alerts.find(({ code }: any) => code === 'worker_init_failed')?.data.reason,
                primary.message
            );
        } finally {
            failing = false;
        }
    });
}

test('P3c failed invalidation save preserves a healthy old owner and scanner recovery', async (t) => {
    const { fss, worker, root } = await workerOwner(t);
    await fss.retrieval.prepare({ context: {}, reason: 'P3c healthy full control', role: 'write' });
    assert.equal(await worker._acquireScanLock(), true);
    worker.status = 'running';
    worker._lastConfig = worker.config;
    const previous = fss.storage;
    const primary = Object.assign(new Error('isolated invalidation save failure'), { code: 'ENOSPC' });
    const snapshot = fss._writeScannerStateSnapshot.bind(fss);
    t.mock.method(fss, '_writeScannerStateSnapshot', async (state: any, commit: any) => {
        if (state.semantic_reset_pending) throw primary;
        return snapshot(state, commit);
    });
    const result = await worker.resetFileSystemStorage();
    assert.equal(result.status, 'error');
    assert.equal(result.message, primary.message);
    await worker.taskQueue.onIdle();
    assert.equal(fss.storage, previous);
    assert.notEqual(worker.status, 'error');
    assert.ok(worker.scanners.get(root)?.isRunning());
    assert.equal(fss.scannerState.embedding_generation, 0);
    assert.equal(fss.scannerState.semantic_reset_pending, false);
});

test('P3c controls queued before a reset failure cannot reopen its closed resources', async (t) => {
    const { fss, worker, root } = await workerOwner(t);
    await fss.retrieval.prepare({ context: {}, reason: 'P3c queued controls', role: 'write' });
    assert.equal(await worker._acquireScanLock(), true);
    worker.status = 'running';
    worker._lastConfig = worker.config;
    const target = path.join(fss._appDataDirectory, 'storage', 'vector-index.db');
    const primary = Object.assign(new Error('P3c queued deletion failed'), { code: 'EIO' });
    const remove = fs.rmSync;
    t.mock.method(fs, 'rmSync', (candidate, options) => {
        if (candidate === target) throw primary;
        return remove(candidate, options);
    });
    const initialize = t.mock.method(BaseStorage.prototype, 'initialize', BaseStorage.prototype.initialize);
    worker.taskQueue.pause();
    const reset = worker.resetFileSystemStorage();
    const source = worker.setSourcePaused({ root, paused: false });
    const config = worker.applicationConfigChanged({ entries: [] });
    const embedding = worker.embeddingConfigChanged();
    await flush();
    worker.taskQueue.start();
    assert.equal((await reset).message, primary.message);
    assert.equal((await source).status, 'error');
    await Promise.all([config, embedding]);
    await worker.taskQueue.onIdle();
    assert.equal(initialize.mock.callCount(), 0);
    assert.equal(worker.status, 'error');
    assert.equal(worker._initError, primary);
    assert.equal(worker._pendingEmbeddingConfigChange, false);
    assert.equal(worker._pendingConfigChange, null);
    assert.equal(worker.scanners.size, 0);
});

test('P3c a deferred scanner base failure enters error once and cannot retry each scan', async (t) => {
    const { fss, worker, root } = await workerOwner(t);
    await fss.close();
    worker.status = 'running';
    const primary = Object.assign(new Error('P3c persistent base open failure'), { code: 'EACCES' });
    const initialize = t.mock.method(BaseStorage.prototype, 'initialize', async () => {
        throw primary;
    });
    await worker._startScanners(worker.config.entries);
    await worker.taskQueue.onIdle();
    assert.equal(initialize.mock.callCount(), 1);
    assert.equal(worker.status, 'error');
    assert.equal(worker._initError, primary);
    assert.equal(worker.scanners.size, 0);
    await worker._startScanners(worker.config.entries);
    await worker.taskQueue.onIdle();
    assert.equal(initialize.mock.callCount(), 1);
    assert.equal(worker.scanners.has(root), false);
    assert.equal(
        (await worker.getFileSystemStatus()).alerts.find((alert) => alert.code === 'worker_init_failed')?.data.reason,
        primary.message
    );
});

for (const hasStorage of [true, false]) {
    test(`P3c finalize invalidates a queued ${hasStorage ? 'existing-owner' : 'no-owner'} reset`, async (t) => {
        modelConfigured = false;
        const { fss, worker } = await workerOwner(t);
        if (!hasStorage) {
            await fss.close();
            worker.storage = null;
        }
        const initialize = t.mock.method(BaseStorage.prototype, 'initialize', BaseStorage.prototype.initialize);
        worker.taskQueue.pause();
        const finalize = worker.finalize();
        const reset = worker.resetFileSystemStorage();
        worker.taskQueue.start();
        await finalize;
        assert.equal((await reset).status, 'error');
        await worker.taskQueue.onIdle();
        assert.equal(initialize.mock.callCount(), 0);
        assert.equal(worker.storage, null);
        assert.equal(worker.status, 'idle');
        assert.equal(worker._initError, null);
        assert.equal(worker._rebuildQueued, false);
        assert.equal(worker._currentRebuildPromise, null);
    });
}

test('P3c missing-root persistence failure after recreation is a final reset failure', async (t) => {
    modelConfigured = false;
    const { fss, worker } = await workerOwner(t);
    const added = path.join(fss._appDataDirectory, 'new-root');
    fs.mkdirSync(added);
    worker.config = worker._normalizeConfig({ entries: [{ root: added }] });
    const primary = Object.assign(new Error('P3c new root could not be persisted'), { code: 'ENOSPC' });
    const snapshot = fss._writeScannerStateSnapshot.bind(fss);
    t.mock.method(fss, '_writeScannerStateSnapshot', async (state, ...args) => {
        if (state.roots[added]) throw primary;
        return snapshot(state, ...args);
    });
    const start = t.mock.method(worker, '_startScanner', worker._startScanner);
    assert.equal((await worker.resetFileSystemStorage()).message, primary.message);
    await worker.taskQueue.onIdle();
    assert.equal(start.mock.callCount(), 0);
    assert.equal(worker.status, 'error');
    assert.equal(worker._initError, primary);
    assert.equal(JSON.parse(fs.readFileSync(fss._scannerStatePath, 'utf8')).roots[added], undefined);
});

for (const nextMode of ['full', 'base-only']) {
    for (const boundary of ['detach', 'root-state', 'prune', 'restart']) {
        test(`R3-N1 published ${nextMode} survives a later config ${boundary} failure and remains retryable`, async (t) => {
            modelConfigured = nextMode === 'base-only';
            const { fss, worker, root } = await workerOwner(t);
            worker.config = worker._normalizeConfig(worker.config);
            worker._lastConfig = worker.config;
            worker.status = 'running';
            assert.equal(await worker._acquireScanLock(), true);
            t.mock.method(worker, '_enqueueEmbeddingQueue', () => {});
            await worker._startScanners(worker.config.entries);
            await worker.taskQueue.onIdle();
            assert.equal(fss.mode, nextMode === 'full' ? 'base-only' : 'full');
            const previousConnection = fss.storage;
            const added = path.join(fss._appDataDirectory, 'config-added');
            fs.mkdirSync(added);
            fs.writeFileSync(path.join(added, 'new.txt'), 'new configuration root');
            const config = { entries: [...worker.config.entries, { root: added }] };
            const primary = Object.assign(new Error(`R3-N1 isolated config ${boundary} failure`), {
                code: boundary === 'root-state' ? 'ENOSPC' : 'EIO'
            });
            let failing = true;
            if (boundary === 'root-state') {
                const rename = fs.promises.rename.bind(fs.promises);
                t.mock.method(fs.promises, 'rename', async (from, to) => {
                    if (
                        failing &&
                        to === fss._scannerStatePath &&
                        JSON.parse(fs.readFileSync(from, 'utf8')).roots[added]
                    )
                        throw primary;
                    return rename(from, to);
                });
            } else {
                const target = boundary === 'prune' ? fss : worker;
                const method =
                    boundary === 'detach'
                        ? '_detachRemovedRoots'
                        : boundary === 'prune'
                          ? 'pruneUnownedUnavailableRoots'
                          : '_startScanners';
                const original = (target as any)[method].bind(target);
                t.mock.method(target as any, method, async (...args: any[]) => {
                    if (failing) throw primary;
                    return original(...args);
                });
            }
            modelConfigured = nextMode === 'full';
            await assert.rejects(worker.applicationConfigChanged(config), (error) => error === primary);
            await worker.taskQueue.onIdle();
            assert.notEqual(fss.storage, previousConnection, 'the real prepare published a different connection');
            assert.equal(fss.mode, nextMode);
            assert.equal(fss.isDeferred(), false);
            assert.equal(worker.status, 'running', 'a published healthy connection does not imply resource loss');
            assert.equal(worker._initError, null);
            assert.ok(worker.scanners.get(root)?.isRunning());
            assert.ok(worker.scanners.get(root)?._scheduledTimeout);
            assert.equal(worker.scanners.has(added), false, 'failed configuration is not reported as applied');
            assert.equal(worker._lastConfig, null);
            assert.equal(worker._pendingConfigChange, null);
            const disk = JSON.parse(fs.readFileSync(fss._scannerStatePath, 'utf8'));
            if (boundary === 'root-state' || boundary === 'detach') {
                assert.equal(fss.scannerState.roots[added], undefined);
                assert.equal(disk.roots[added], undefined);
            }
            assert.ok(
                (await fss.storage!.search([])).items.some(
                    ({ item }: any) => item.item_id === path.join(root, 'not-yet-indexed.txt')
                ),
                'healthy root data remains queryable through the published connection'
            );
            failing = false;
            assert.equal((await worker.reconcileConfig(config)).reconciled, true);
            await worker.taskQueue.onIdle();
            assert.equal(worker.status, 'running');
            assert.ok(worker._lastConfig);
            assert.ok(worker.scanners.get(root)?.isRunning());
            assert.ok(worker.scanners.get(added)?.isRunning());
            assert.ok(JSON.parse(fs.readFileSync(fss._scannerStatePath, 'utf8')).roots[added]);
        });
    }
}

test('P3c a superseded config failure still gates the closed current owner', async (t) => {
    const { fss, worker, root } = await workerOwner(t);
    await fss.retrieval.prepare({ context: {}, reason: 'P3c config failure', role: 'write' });
    assert.equal(await worker._acquireScanLock(), true);
    worker.status = 'running';
    worker._lastConfig = worker.config;
    const entered = deferred(t),
        gate = deferred(t);
    const snapshot = fss._writeScannerStateSnapshot.bind(fss);
    let once = true;
    t.mock.method(fss, '_writeScannerStateSnapshot', async (state, ...args) => {
        if (once && state.semantic_reset_pending) {
            once = false;
            entered.resolve();
            await gate.promise;
        }
        return snapshot(state, ...args);
    });
    const primary = Object.assign(new Error('P3c superseded semantic deletion failed'), { code: 'EIO' });
    const target = path.join(fss._appDataDirectory, 'storage', 'vector-index.db');
    const remove = fs.rmSync;
    t.mock.method(fs, 'rmSync', (candidate, options) => {
        if (candidate === target) throw primary;
        return remove(candidate, options);
    });
    // A real model dimension change enters the semantic reset while this config attempt owns the queue.
    t.mock.method(Setting, 'getInstance', () => ({
        getData: () => ({}),
        getDefaultEmbeddingModelInstance: () => ({ model_name: 'wf1-changed-model', getTimeoutMs: () => 1000 })
    }));
    t.mock.method(LLM, 'embed', async () => [1, 0, 0]);
    const first = worker.applicationConfigChanged({ entries: [{ root, exclude_patterns: ['first'] }] });
    const failed = assert.rejects(first, (error) => error === primary);
    await entered.promise;
    const latest = worker.applicationConfigChanged({ entries: [] });
    await flush();
    const initialize = t.mock.method(BaseStorage.prototype, 'initialize', BaseStorage.prototype.initialize);
    gate.resolve();
    await failed;
    await latest;
    await worker.taskQueue.onIdle();
    assert.equal(initialize.mock.callCount(), 0);
    assert.equal(worker.status, 'error');
    assert.equal(worker._initError, primary);
    assert.equal(worker.scanners.size, 0);
});

for (const target of ['vector', 'chunk', 'base']) {
    for (const mainPresent of [true, false]) {
        test(`P3c worker reset with ${target} lock and WASM main present=${mainPresent} cannot reopen through scanners`, async (t) => {
            modelConfigured = false;
            const { fss, worker } = await workerOwner(t);
            await fss.close();
            worker.status = 'running';
            const files = new Map<string, Buffer>();
            for (const name of ['vector', 'chunk', 'base']) {
                const native = path.join(fss._appDataDirectory, 'storage', `${name}-index.db`);
                const wasm = toWasmDbPath(native);
                for (const file of [native, `${native}-wal`, `${wasm}-shm`]) {
                    fs.writeFileSync(file, `P3c preserved ${name}`);
                    files.set(file, fs.readFileSync(file));
                }
                if (mainPresent) {
                    fs.writeFileSync(wasm, `P3c WASM ${name}`);
                    files.set(wasm, fs.readFileSync(wasm));
                }
            }
            const lock = `${toWasmDbPath(path.join(fss._appDataDirectory, 'storage', `${target}-index.db`))}.lock`;
            fs.mkdirSync(lock);
            const initialize = t.mock.method(BaseStorage.prototype, 'initialize', BaseStorage.prototype.initialize);
            const remove = t.mock.method(fs, 'rmSync', fs.rmSync);
            const result = await worker.resetFileSystemStorage();
            await worker.taskQueue.onIdle();
            assert.equal(result.status, 'error');
            assert.match(result.message, /EBUSY/);
            assert.equal(worker.status, 'error');
            assert.equal(initialize.mock.callCount(), 0);
            assert.equal(remove.mock.callCount(), 0);
            assert.equal(fs.existsSync(lock), true);
            for (const [file, bytes] of files) assert.deepEqual(fs.readFileSync(file), bytes);
            // Only this test's profile teardown removes the synthetic lock directory.
        });
    }
}

test('P3c current full close failure retains its owner and cannot masquerade as healthy pre-swap recovery', async (t) => {
    const { fss, worker } = await workerOwner(t);
    await fss.retrieval.prepare({ context: {}, reason: 'P3c close failure', role: 'write' });
    worker.status = 'running';
    const previous = fss.storage;
    const primary = Object.freeze(Object.assign(new Error('P3c current close failed'), { code: 'EIO' }));
    const close = previous.vectorIndexer.close.bind(previous.vectorIndexer);
    let failing = true;
    t.mock.method(previous.vectorIndexer, 'close', async () => {
        if (failing) throw primary;
        return close();
    });
    const drop = t.mock.method(fss, '_dropFilemgrStores', fss._dropFilemgrStores);
    const initialize = t.mock.method(BaseStorage.prototype, 'initialize', BaseStorage.prototype.initialize);
    try {
        assert.equal((await worker.resetFileSystemStorage()).message, primary.message);
        await worker.taskQueue.onIdle();
        assert.equal(worker.status, 'error');
        assert.equal(worker._initError, primary);
        assert.equal(worker.scanners.size, 0);
        assert.equal(fss.storage, null);
        assert.ok(fss._pendingStorageClosures.has(previous));
        assert.equal(drop.mock.callCount(), 0);
        assert.equal(initialize.mock.callCount(), 0);
    } finally {
        failing = false;
    }
});

test('P3c reset waits until the latest changed roots are durable and scheduled without awaiting its own queue', async (t) => {
    modelConfigured = false;
    const { fss, worker } = await workerOwner(t);
    const firstRoot = path.join(fss._appDataDirectory, 'first-root');
    const latestRoot = path.join(fss._appDataDirectory, 'latest-root');
    const pausedRoot = path.join(fss._appDataDirectory, 'paused-root');
    for (const root of [firstRoot, latestRoot, pausedRoot]) fs.mkdirSync(root);
    fss.scannerState.roots[pausedRoot] = { last_full_scan: 0, paused: true };
    await fss.saveScannerState();
    const resetEntered = deferred(t),
        resetGate = deferred(t);
    const rootEntered = deferred(t),
        rootGate = deferred(t);
    const snapshot = fss._writeScannerStateSnapshot.bind(fss);
    let resetOnce = true,
        rootOnce = true;
    t.mock.method(fss, '_writeScannerStateSnapshot', async (state, ...args) => {
        if (resetOnce && state.semantic_reset_pending) {
            resetOnce = false;
            resetEntered.resolve();
            await resetGate.promise;
        }
        if (rootOnce && state.roots[firstRoot]) {
            rootOnce = false;
            rootEntered.resolve();
            await rootGate.promise;
        }
        return snapshot(state, ...args);
    });
    const starts = [];
    const start = worker._startScanner.bind(worker);
    t.mock.method(worker, '_startScanner', async (entry, ...args) => {
        starts.push(entry.root);
        if (entry.root === latestRoot)
            assert.ok(JSON.parse(fs.readFileSync(fss._scannerStatePath, 'utf8')).roots[latestRoot]);
        return start(entry, ...args);
    });
    let settled = false;
    const reset = worker.resetFileSystemStorage().finally(() => {
        settled = true;
    });
    await resetEntered.promise;
    const first = worker.applicationConfigChanged({ entries: [{ root: firstRoot }, { root: pausedRoot }] });
    await flush();
    resetGate.resolve();
    await rootEntered.promise;
    const latest = worker.applicationConfigChanged({ entries: [{ root: latestRoot }, { root: pausedRoot }] });
    await flush();
    assert.equal(settled, false);
    rootGate.resolve();
    assert.equal((await reset).status, 'ok');
    await Promise.all([first, latest]);
    await worker.taskQueue.onIdle();
    assert.equal(fss.scannerState.embedding_generation, 1);
    assert.equal(worker.scanners.get(latestRoot)?.isRunning(), true);
    assert.equal(worker.scanners.has(firstRoot), false);
    assert.equal(worker.scanners.has(pausedRoot), false);
    assert.equal(starts.includes(firstRoot), false);
    const disk = JSON.parse(fs.readFileSync(fss._scannerStatePath, 'utf8'));
    assert.equal(disk.roots[firstRoot], undefined);
    assert.equal(disk.roots[pausedRoot].paused, true);
});

async function failedWorker(t: TestContext) {
    const result = await workerOwner(t);
    await result.fss.close();
    result.worker.storage = null;
    result.worker.status = 'error';
    result.worker._initError = new Error('P3d previous failure');
    t.mock.method(result.worker, '_acquireScanLock', async () => {
        result.worker._releaseScanLock = async () => {};
        return true;
    });
    return result;
}

test('P3d concurrent error refresh waits for base initialization, root persistence and scanner scheduling', async (t) => {
    modelConfigured = false;
    const { fss, worker } = await failedWorker(t);
    const added = path.join(fss._appDataDirectory, 'refresh-root');
    fs.mkdirSync(added);
    worker.config = worker._normalizeConfig({ entries: [{ root: added }] });
    const baseGate = deferred(t),
        rootGate = deferred(t),
        rootEntered = deferred(t);
    const initialize = BaseStorage.prototype.initialize;
    let opens = 0;
    t.mock.method(BaseStorage.prototype, 'initialize', async function (...args) {
        opens++;
        await baseGate.promise;
        return initialize.apply(this, args);
    });
    const snapshot = FSStorage.prototype._writeScannerStateSnapshot;
    let once = true;
    t.mock.method(FSStorage.prototype, '_writeScannerStateSnapshot', async function (state, ...args) {
        if (once && state.roots[added]) {
            once = false;
            rootEntered.resolve();
            await rootGate.promise;
        }
        return snapshot.call(this, state, ...args);
    });
    let firstSettled = false,
        secondSettled = false;
    const first = worker.forceRefreshScan().finally(() => {
        firstSettled = true;
    });
    await flush();
    assert.equal(firstSettled, false);
    assert.equal(opens, 1);
    assert.equal(worker.status, 'initializing');
    const second = worker.forceRefreshScan().finally(() => {
        secondSettled = true;
    });
    await flush();
    assert.equal(secondSettled, false);
    baseGate.resolve();
    await rootEntered.promise;
    assert.equal(firstSettled, false);
    assert.equal(secondSettled, false);
    rootGate.resolve();
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(a, b);
    assert.equal(a.status, 'ok');
    assert.equal(opens, 1);
    assert.ok(JSON.parse(fs.readFileSync(fss._scannerStatePath, 'utf8')).roots[added]);
    assert.equal(worker.scanners.get(added)?.isRunning(), true);
    await worker.taskQueue.onIdle();
});

test('P3d base first-stage failure reaches every refresh caller and stays error without automatic retry', async (t) => {
    const { worker } = await failedWorker(t);
    const primary = Object.freeze(Object.assign(new Error('P3d base initialization denied'), { code: 'EACCES' }));
    const initialize = t.mock.method(BaseStorage.prototype, 'initialize', async () => {
        throw primary;
    });
    const [a, b] = await Promise.all([worker.forceRefreshScan(), worker.forceRefreshScan()]);
    await worker.taskQueue.onIdle();
    assert.equal(a.status, 'error');
    assert.equal(a.message, primary.message);
    assert.deepEqual(a, b);
    assert.equal(initialize.mock.callCount(), 1);
    assert.equal(worker.status, 'error');
    assert.equal(worker._initError, primary);
    assert.equal(
        (await worker.getFileSystemStatus()).alerts.find((alert) => alert.code === 'worker_init_failed')?.data.reason,
        primary.message
    );
});

test('P3d ordinary semantic continuation failure is the shared refresh failure and never clears stores', async (t) => {
    const { worker } = await failedWorker(t);
    const primary = Object.assign(new Error('P3d continuation vector denied'), { code: 'EACCES' });
    constructorFault(t, VectorIndexDB, primary);
    const drops = spyDrops(t);
    const [a, b] = await Promise.all([worker.forceRefreshScan(), worker.forceRefreshScan()]);
    await worker.taskQueue.onIdle();
    assert.equal(a.message, primary.message);
    assert.deepEqual(a, b);
    assert.equal(worker.status, 'error');
    assert.equal(worker._initError, primary);
    assert.equal(worker.scanners.size, 0);
    assert.deepEqual(drops, []);
});

test('P3d losing the write lock returns readonly honestly and an original readonly owner never competes', async (t) => {
    modelConfigured = false;
    const { worker } = await failedWorker(t);
    const acquire = t.mock.method(worker, '_acquireScanLock', async () => false);
    const result = await worker.forceRefreshScan();
    await worker.taskQueue.onIdle();
    assert.equal(acquire.mock.callCount(), 1);
    assert.equal(result.status, 'error');
    assert.equal(result.warning, WARNINGS.READONLY_MODE);
    assert.equal(worker.status, 'readonly');
    assert.equal(worker.scanners.size, 0);
    assert.equal((await worker.forceRefreshScan()).warning, WARNINGS.READONLY_MODE);
    assert.equal(acquire.mock.callCount(), 1);
});

test('P3d refresh preserves base after deletion failed before its main file and a later reset really clears it', async (t) => {
    const { fss, worker, root } = await workerOwner(t);
    const kept = path.join(root, 'kept-from-failed-reset.md');
    fs.writeFileSync(kept, 'kept base record');
    const stat = fs.statSync(kept);
    await fss.saveFiles(
        [
            {
                path: kept,
                filename: path.basename(kept),
                type: 'file',
                size: stat.size,
                modified: Math.floor(stat.mtimeMs),
                created: Math.floor(stat.birthtimeMs),
                accessed: Math.floor(stat.atimeMs)
            }
        ],
        root
    );
    await fss.retrieval.prepare({ context: {}, reason: 'P3d retained base', role: 'write' });
    worker.status = 'running';
    worker._lastConfig = worker.config;
    const base = path.join(fss._appDataDirectory, 'storage', 'base-index.db');
    const primary = Object.assign(new Error('P3d base delete denied before main removal'), { code: 'EACCES' });
    const remove = fs.rmSync;
    let failing = true,
        baseDeletes = 0;
    t.mock.method(fs, 'rmSync', (candidate, options) => {
        if (candidate === base) {
            baseDeletes++;
            if (failing) throw primary;
        }
        return remove(candidate, options);
    });
    const resetResult = await worker.resetFileSystemStorage();
    assert.equal(resetResult.message, primary.message);
    assert.equal(worker.status, 'error');
    assert.equal(fs.existsSync(path.join(fss._appDataDirectory, 'storage', 'vector-index.db')), false);
    assert.equal(fs.existsSync(path.join(fss._appDataDirectory, 'storage', 'chunk-index.db')), false);
    failing = false;
    const entered = deferred(t),
        gate = deferred(t);
    const initialize = BaseStorage.prototype.initialize;
    let once = true;
    t.mock.method(BaseStorage.prototype, 'initialize', async function (...args) {
        if (once && this.schema.needIndexers.filename?.some((binding) => binding.indexer === 'VectorIndexer')) {
            once = false;
            entered.resolve();
            await gate.promise;
        }
        return initialize.apply(this, args);
    });
    const refresh = worker.forceRefreshScan();
    await entered.promise;
    try {
        assert.equal(worker.storage.scannerState.semantic_reset_pending, true);
        assert.equal(JSON.parse(fs.readFileSync(fss._scannerStatePath, 'utf8')).semantic_reset_pending, true);
        assert.equal(fs.existsSync(base), true);
    } finally {
        gate.resolve();
    }
    assert.equal((await refresh).status, 'ok');
    assert.equal(baseDeletes, 1, 'refresh never retries base deletion');
    assert.equal(worker.storage.scannerState.semantic_reset_pending, false);
    assert.equal((await worker.storage.searchFilesByKeyword('kept-from-failed-reset')).length, 1);
    assert.equal(resetResult.status, 'error', 'later semantic recovery does not change the original reset result');
    await worker.taskQueue.onIdle();
    // Avoid a scheduled scan repopulating the file while checking the explicit clear itself.
    worker.config = worker._normalizeConfig({ entries: [] });
    assert.equal((await worker.resetFileSystemStorage()).status, 'ok');
    assert.equal(baseDeletes, 2);
    assert.equal((await worker.storage.searchFilesByKeyword('kept-from-failed-reset')).length, 0);
});

test('P3d refresh follows successive configuration continuations and keeps removed and paused roots stopped', async (t) => {
    modelConfigured = false;
    const { fss, worker, root } = await failedWorker(t);
    const added = path.join(fss._appDataDirectory, 'latest-refresh-root');
    const paused = path.join(fss._appDataDirectory, 'paused-refresh-root');
    fs.mkdirSync(added);
    fs.mkdirSync(paused);
    const state = JSON.parse(fs.readFileSync(fss._scannerStatePath, 'utf8'));
    state.roots[paused] = { paused: true, last_full_scan: 0, total_files: 0 };
    fs.writeFileSync(fss._scannerStatePath, JSON.stringify(state));
    const entered = deferred(t),
        gate = deferred(t);
    const initialize = BaseStorage.prototype.initialize;
    let once = true;
    t.mock.method(BaseStorage.prototype, 'initialize', async function (...args) {
        if (once) {
            once = false;
            entered.resolve();
            await gate.promise;
        }
        return initialize.apply(this, args);
    });
    const refresh = worker.forceRefreshScan();
    await entered.promise;
    await worker.applicationConfigChanged({ entries: [{ root }, { root: paused }] });
    await worker.applicationConfigChanged({ entries: [{ root: added }, { root: paused }] });
    await worker.embeddingConfigChanged();
    await worker.embeddingConfigChanged();
    gate.resolve();
    assert.equal((await refresh).status, 'ok');
    await worker.taskQueue.onIdle();
    assert.equal(worker.scanners.has(root), false);
    assert.equal(worker.scanners.has(paused), false);
    assert.equal(worker.scanners.get(added)?.isRunning(), true);
    const disk = JSON.parse(fs.readFileSync(fss._scannerStatePath, 'utf8'));
    assert.ok(disk.roots[added]);
    assert.equal(disk.roots[paused].paused, true);
    assert.equal(disk.roots[root], undefined);
    assert.equal(worker._pendingEmbeddingConfigChange, false);
});

test('P3d finalize invalidates refresh while its initialization is still queued', async (t) => {
    const { worker } = await failedWorker(t);
    const initialize = t.mock.method(BaseStorage.prototype, 'initialize', BaseStorage.prototype.initialize);
    worker.taskQueue.pause();
    const finalize = worker.finalize();
    const refresh = worker.forceRefreshScan();
    await flush();
    worker.taskQueue.start();
    await finalize;
    assert.equal((await refresh).status, 'error');
    await worker.taskQueue.onIdle();
    assert.equal(initialize.mock.callCount(), 0);
    assert.equal(worker.storage, null);
    assert.equal(worker.status, 'idle');
    assert.equal(worker._initError, null);
});

test('P3d finalize between the first phase and continuation prevents late publication', async (t) => {
    modelConfigured = false;
    const { worker } = await failedWorker(t);
    const entered = deferred(t),
        gate = deferred(t);
    const initialize = BaseStorage.prototype.initialize;
    const open = t.mock.method(BaseStorage.prototype, 'initialize', async function (...args) {
        entered.resolve();
        await gate.promise;
        return initialize.apply(this, args);
    });
    const refresh = worker.forceRefreshScan();
    await entered.promise;
    const finalize = worker.finalize();
    gate.resolve();
    await finalize;
    assert.equal((await refresh).status, 'error');
    await worker.taskQueue.onIdle();
    assert.equal(open.mock.callCount(), 1);
    assert.equal(worker.status, 'idle');
    assert.equal(worker.storage, null);
    assert.equal(worker._initError, null);
});

test('P3d refresh joins an already queued no-owner reset without starting another initialization', async (t) => {
    modelConfigured = false;
    const { worker } = await failedWorker(t);
    const initialize = t.mock.method(BaseStorage.prototype, 'initialize', BaseStorage.prototype.initialize);
    worker.taskQueue.pause();
    const reset = worker.resetFileSystemStorage();
    const refresh = worker.forceRefreshScan();
    await flush();
    worker.taskQueue.start();
    assert.equal((await reset).status, 'ok');
    assert.equal((await refresh).status, 'ok');
    await worker.taskQueue.onIdle();
    assert.equal(initialize.mock.callCount(), 1);
    assert.equal(worker.storage.scannerState.embedding_generation, 1);
});

test('P3d refresh joining a successful reset with no configured roots returns the healthy idle snapshot', async (t) => {
    modelConfigured = false;
    const { worker } = await failedWorker(t);
    worker.config = worker._normalizeConfig({ entries: [] });
    worker.taskQueue.pause();
    const reset = worker.resetFileSystemStorage();
    const refresh = worker.forceRefreshScan();
    await flush();
    worker.taskQueue.start();
    assert.equal((await reset).status, 'ok');
    const result = await refresh;
    await worker.taskQueue.onIdle();
    assert.equal(result.status, 'ok');
    assert.equal(result.data.status, 'idle');
    assert.deepEqual(result.data.sources, []);
    assert.equal(worker.status, 'idle');
    assert.equal(worker._initError, null);
    assert.equal(worker.scanners.size, 0);
    assert.equal(worker.storage.scannerState.embedding_generation, 1);
});

for (const successor of ['finalize', 'config-success', 'config-failure'])
    test(`P3d refresh joined to reset rechecks its late snapshot after ${successor}`, async (t) => {
        modelConfigured = false;
        const { worker, fss } = await failedWorker(t);
        t.mock.method(worker, '_emitStatusChanged', async () => {});
        const entered = deferred(t),
            resume = deferred(t);
        const status = worker.getFileSystemStatus;
        let once = true;
        t.mock.method(worker, 'getFileSystemStatus', async function (...args) {
            const snapshot = await status.apply(this, args);
            if (once && !this._currentRebuildPromise) {
                once = false;
                entered.resolve();
                await resume.promise;
            }
            return snapshot;
        });
        worker.taskQueue.pause();
        const reset = worker.resetFileSystemStorage();
        const refresh = worker.forceRefreshScan();
        await flush();
        worker.taskQueue.start();
        assert.equal((await reset).status, 'ok');
        await entered.promise;
        const nextRoot = path.join(fss._appDataDirectory, 'after-reset-source');
        const primary = new Error('P3d late reset successor persistence failure');
        try {
            if (successor === 'finalize') await worker.finalize();
            else {
                fs.mkdirSync(nextRoot);
                if (successor === 'config-failure') {
                    const write = worker.storage._writeScannerStateSnapshot;
                    t.mock.method(worker.storage, '_writeScannerStateSnapshot', async function (state, ...args) {
                        if (state.roots[nextRoot]) throw primary;
                        return write.call(this, state, ...args);
                    });
                    await assert.rejects(
                        worker.applicationConfigChanged({ entries: [{ root: nextRoot }] }),
                        (error) => error === primary
                    );
                } else await worker.applicationConfigChanged({ entries: [{ root: nextRoot }] });
            }
        } finally {
            resume.resolve();
        }
        const result = await refresh;
        await worker.taskQueue.onIdle();
        if (successor === 'config-success') {
            assert.equal(result.status, 'ok');
            assert.deepEqual(
                result.data.sources.map((source) => source.root),
                [nextRoot]
            );
        } else {
            assert.equal(result.status, 'error');
            if (successor === 'config-failure') assert.equal(result.message, primary.message);
            else {
                assert.equal(worker.storage, null);
                assert.equal(worker.status, 'idle');
            }
        }
    });

test('P3d a manual reset taking over refresh cannot have its success overwritten by the old attempt', async (t) => {
    modelConfigured = false;
    const { worker } = await failedWorker(t);
    const entered = deferred(t),
        gate = deferred(t);
    const initialize = BaseStorage.prototype.initialize;
    let once = true;
    t.mock.method(BaseStorage.prototype, 'initialize', async function (...args) {
        if (once) {
            once = false;
            entered.resolve();
            await gate.promise;
        }
        return initialize.apply(this, args);
    });
    const refresh = worker.forceRefreshScan();
    await entered.promise;
    const reset = worker.resetFileSystemStorage();
    gate.resolve();
    assert.equal((await reset).status, 'ok');
    assert.equal((await refresh).status, 'error');
    await worker.taskQueue.onIdle();
    assert.equal(worker.status, 'running');
    assert.equal(worker._initError, null);
    assert.equal(worker.storage.scannerState.embedding_generation, 1);
});

test('P3d late model and pause controls are included before the shared refresh snapshot settles', async (t) => {
    modelConfigured = false;
    const { worker, root } = await failedWorker(t);
    t.mock.method(worker, '_emitStatusChanged', async () => {});
    const entered = deferred(t),
        snapshotGate = deferred(t),
        modelGate = deferred(t);
    const status = worker.getFileSystemStatus.bind(worker);
    let once = true;
    t.mock.method(worker, 'getFileSystemStatus', async () => {
        if (once && worker.status === 'running' && !worker._initializing) {
            once = false;
            entered.resolve();
            await snapshotGate.promise;
        }
        return status();
    });
    let settled = false;
    const refresh = worker.forceRefreshScan().finally(() => {
        settled = true;
    });
    await entered.promise;
    const sync = worker.storage.retrieval._syncMode.bind(worker.storage.retrieval);
    t.mock.method(worker.storage.retrieval, '_syncMode', async (reason, ...args) => {
        if (reason === 'embedding config changed') await modelGate.promise;
        return sync(reason, ...args);
    });
    const model = worker.embeddingConfigChanged();
    const pause = worker.setSourcePaused({ root, paused: true });
    snapshotGate.resolve();
    await flush();
    try {
        assert.equal(settled, false);
    } finally {
        modelGate.resolve();
    }
    await model;
    assert.equal((await pause).status, 'ok');
    const result = await refresh;
    assert.equal(result.status, 'ok');
    assert.equal(result.data.sources.find((source) => source.root === root)?.paused, true);
    await worker.taskQueue.onIdle();
});

test('P3d normal refresh only schedules existing scanners and does not initialize or compete for the lock', async (t) => {
    modelConfigured = false;
    const { worker, root } = await workerOwner(t);
    assert.equal(await worker._acquireScanLock(), true);
    worker.status = 'running';
    worker._lastConfig = worker.config;
    await worker._startScanners(worker.config.entries);
    await worker.taskQueue.onIdle();
    const scanner = worker.scanners.get(root);
    const request = t.mock.method(scanner, 'requestImmediateScan', scanner.requestImmediateScan);
    const acquire = t.mock.method(worker, '_acquireScanLock', worker._acquireScanLock);
    const initialize = t.mock.method(BaseStorage.prototype, 'initialize', BaseStorage.prototype.initialize);
    assert.equal((await worker.forceRefreshScan()).status, 'ok');
    await worker.taskQueue.onIdle();
    assert.equal(request.mock.callCount(), 1);
    assert.equal(acquire.mock.callCount(), 0);
    assert.equal(initialize.mock.callCount(), 0);
});

test('P3d a first-phase configuration validation rejection replaces the previous failure reason', async (t) => {
    const { worker } = await failedWorker(t);
    worker.config = { entries: [{ root: 42 }] };
    const normalize = worker._normalizeConfig.bind(worker);
    let primary;
    t.mock.method(worker, '_normalizeConfig', (...args) => {
        try {
            return normalize(...args);
        } catch (error) {
            primary = error;
            throw error;
        }
    });
    const initialize = t.mock.method(BaseStorage.prototype, 'initialize', BaseStorage.prototype.initialize);
    const result = await worker.forceRefreshScan();
    assert.ok(primary);
    assert.equal(result.status, 'error');
    assert.equal(result.message, primary.message);
    assert.equal(worker._initError, primary);
    assert.equal(initialize.mock.callCount(), 0);
    assert.equal(worker.status, 'error');
});

for (const control of ['embedding', 'refresh', 'readonly-refresh', 'recovery-refresh', 'reset-refresh', 'workspace']) {
    test(`filemgr control ${control} keeps successful action separate from failed attached statistics`, async (t) => {
        modelConfigured = false;
        const { worker, fss, root } = ['recovery-refresh', 'reset-refresh'].includes(control)
            ? await failedWorker(t)
            : await workerOwner(t);
        if (!['recovery-refresh', 'reset-refresh'].includes(control)) worker.status = 'running';
        if (control === 'readonly-refresh') worker._readonlyMode = true;
        const snapshot = t.mock.method(worker, 'getFileSystemStatus', async () => {
            throw new Error('isolated attached statistics failure');
        });
        const fail = t.mock.method(worker, '_failRuntime', async () => {
            assert.fail('statistics must not fail runtime');
        });
        let result: any;
        if (control === 'embedding') result = await worker.embeddingConfigChanged();
        if (control === 'refresh' || control === 'readonly-refresh' || control === 'recovery-refresh')
            result = await worker.forceRefreshScan();
        if (control === 'reset-refresh') {
            worker.taskQueue.pause();
            const reset = worker.resetFileSystemStorage();
            const refresh = worker.forceRefreshScan();
            worker.taskQueue.start();
            assert.equal((await reset).status, 'ok');
            result = await refresh;
        }
        if (control === 'workspace') result = await worker.workspaceChanged(root);
        await worker.taskQueue.onIdle();
        assert.ok(snapshot.mock.callCount() > 0);
        assert.equal(fail.mock.callCount(), 0);
        assert.equal(result.status, control === 'readonly-refresh' ? 'error' : 'ok');
        if (control === 'readonly-refresh') assert.equal(result.warning, WARNINGS.READONLY_MODE);
        assert.equal(result.data.mode, null);
        assert.equal(result.data.totals, null);
        assert.equal(result.data.storage_stats, null);
        assert.ok(result.data.sources.every((source: any) => source.full_text === undefined));
        if (!['recovery-refresh', 'reset-refresh'].includes(control)) assert.equal(worker.storage, fss);
    });
}

for (const state of ['readonly', 'initializing', 'error', 'no-storage']) {
    test(`filemgr embedding control ${state} retains its lifecycle when attached statistics fail`, async (t) => {
        modelConfigured = false;
        const { worker, fss } = await workerOwner(t);
        worker.status = 'running';
        worker._lastConfig = worker.config;
        const primary = new Error('retained runtime failure');
        if (state === 'readonly') worker._readonlyMode = true;
        if (state === 'error') {
            worker.status = 'error';
            worker._initError = primary;
        }
        if (state === 'no-storage') {
            await fss.close();
            worker.storage = null;
            worker.status = 'idle';
        }
        if (state === 'initializing') {
            worker.status = 'initializing';
            worker._initializing = true;
            worker.taskQueue.pause();
        }
        const snapshot = t.mock.method(worker, 'getFileSystemStatus', async () => {
            throw new Error('isolated attached statistics failure');
        });
        const fail = t.mock.method(worker, '_failRuntime', async () => assert.fail('statistics must not fail runtime'));
        const prepare = t.mock.method(fss.retrieval, 'prepare', fss.retrieval.prepare);
        const continuation = t.mock.method(
            worker,
            '_continueInitializeAfterProbe',
            worker._continueInitializeAfterProbe
        );
        const seq = worker._initSeq;
        try {
            const result = await worker.embeddingConfigChanged();
            assert.equal(result.status, 'ok');
            assert.equal(snapshot.mock.callCount(), 1);
            assert.equal(prepare.mock.callCount(), 0);
            assert.equal(fail.mock.callCount(), 0);
            assert.equal(result.data.mode, null);
            assert.equal(result.data.totals, null);
            assert.equal(result.data.storage_stats, null);
            assert.ok(result.data.sources.every((source: any) => source.full_text === undefined));
            assert.equal(worker.storage, state === 'no-storage' ? null : fss);
            assert.equal(worker._initSeq, state === 'initializing' ? seq + 1 : seq);
            assert.equal(continuation.mock.callCount(), 0);
            if (state === 'error') assert.equal(worker._initError, primary);
            if (state === 'initializing') {
                assert.equal(worker._initializing, true);
                assert.equal(worker._pendingEmbeddingConfigChange, true);
            }
        } finally {
            worker.taskQueue.start();
            await worker.taskQueue.onIdle();
        }
        if (state === 'initializing') {
            assert.equal(continuation.mock.callCount(), 1);
            assert.equal(worker._initializing, false);
            assert.equal(worker._pendingEmbeddingConfigChange, false);
            assert.equal(worker.status, 'running');
            assert.equal(fail.mock.callCount(), 0);
        }
    });
}
