import assert from 'node:assert/strict';
import { after, beforeEach, test, type TestContext } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import iconv from 'iconv-lite';
import { FileMgrApplication } from '../../../../main/applications/filemgr/app.js';
import { setPlatform } from '../../../../platforms/base.js';
import { FSStorage } from '../../../../main/applications/filemgr/storage.js';
import FileManagerWorker from '../../../../main/applications/filemgr/worker.js';
import { BaseStorage } from '../../../../main/services/storage/abstract-storage.js';
import { LLM } from '../../../../main/aikernel/llm.js';
import {
    getLogDirectory,
    getOpendeskDirectory,
    Setting,
    setCustomOpendeskDirectory
} from '../../../../main/utils/setting.js';
import { deferred, flush } from './recovery-fixture.js';

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wf1-contract-'));
const realBatchEmbed = LLM.batchEmbed;
setCustomOpendeskDirectory(profile);
after(() => fs.rmSync(profile, { recursive: true, force: true }));

beforeEach((t) => {
    t.mock.method(Setting, 'getInstance', () => ({
        getDefaultEmbeddingModelInstance: () => ({ model_name: 'fixture-model', getTimeoutMs: () => 1000 }),
        data: { locale: 'en-US' },
        getData: () => ({})
    }));
    t.mock.method(LLM, 'embed', async () => [1, 0]);
    t.mock.method(LLM, 'batchEmbed', async (texts: string[]) => texts.map(() => [1, 0]));
    t.mock.method(LLM, 'rerank', async (_query: string, items: any[]) => items);
});

async function owner(t: TestContext, full = false) {
    const directory = fs.mkdtempSync(path.join(profile, 'case-'));
    const fss = new FSStorage(directory);
    t.after(() => fss.close());
    await fss.initialize({ syncEmbedding: false });
    if (full) {
        Object.assign(fss.scannerState, {
            embedding_model: 'fixture-model',
            vec_dim: 2,
            chunk_level: 'structured',
            vector_backend: null,
            chunk_backend: null,
            embedded_migrated: true
        });
        await fss.saveScannerState();
        await fss.retrieval._openFull(2);
    }
    return fss;
}

function row(file: string, generation = 0, embedded = 1, roots = [path.dirname(file)]) {
    return {
        item_id: file,
        item_type: 'file',
        type: 'file',
        filename: path.basename(file),
        root_refs: JSON.stringify(roots),
        ref_count: roots.length,
        embedded,
        embedding_generation: generation
    };
}

test('actual setting, log and database roots stay in the isolated profile', async (t) => {
    const fss = await owner(t);
    assert.equal(getOpendeskDirectory(), profile);
    assert.equal(getLogDirectory(), path.join(profile, 'logs'));
    assert.ok(fss._storageDir.startsWith(profile + path.sep));
    console.log(
        JSON.stringify({ profile: getOpendeskDirectory(), logs: getLogDirectory(), database: fss._storageDir })
    );
});

for (const encoding of ['utf8', 'utf16le', 'gbk'])
    for (const route of ['worker', 'fallback'])
        test(`B23: actual app toolset ${route} and build consume decoded ${encoding}`, async (t) => {
            const fss = await owner(t, true);
            const text = 'ASCII header\n' + '中文编码检测，文件索引和工具提取应保留相同内容。'.repeat(20) + '\n末行';
            const file = path.join(fss._appDataDirectory, `${encoding}.txt`);
            fs.writeFileSync(file, iconv.encode(text, encoding, { addBOM: encoding === 'utf16le' }));
            const worker = new FileManagerWorker('filemgr', fss._appDataDirectory);
            const app = new FileMgrApplication();
            const boundary = t.mock.method(app, 'callWorker', async (method: string, target: string) => {
                assert.equal(method, 'extractFileText');
                assert.equal(target, file);
                if (route === 'fallback') throw new Error('fixture unavailable worker');
                return { status: 'ok', data: await worker.extractFileText(target) };
            });
            const [toolset] = await app.getToolsets();
            const tool = toolset.getTool('extractText')!;
            const result = JSON.parse(
                await tool.executeCommand({ file_path: file }, { getWorkspace: () => profile } as any)
            );
            assert.equal(boundary.mock.callCount(), 1);
            assert.equal(result.type, 'text');
            assert.equal(result.file.numLines, 3);
            assert.equal(
                result.file.content,
                text
                    .split('\n')
                    .map((line, i) => `${String(i + 1).padStart(6, ' ')}\t${line}`)
                    .join('\n')
            );
            const input = row(file, 0, 0);
            await fss.storage!.upsert([input], { indexers: ['BaseIndexer'] });
            const model = t.mock.method(LLM, 'batchEmbed', async (texts: string[]) => {
                const body = texts.slice(1).join('');
                assert.ok(body.includes('中文编码检测'));
                assert.doesNotMatch(body, /\uFFFD|\u0000/);
                return texts.map(() => [1, 0]);
            });
            assert.equal((await fss.retrieval.buildStep(input)).kind, 'completed');
            assert.equal(model.mock.callCount(), 1);
        });

test('current base initialization reconciles generation even with syncEmbedding:false', async (t) => {
    const fss = await owner(t);
    const file = path.join(fss._appDataDirectory, 'old.md');
    await fss.storage!.upsert([row(file)], { indexers: ['BaseIndexer'] });
    fss.scannerState.embedding_generation = 1;
    await fss.saveScannerState();
    await fss.close();
    const entered = deferred(t),
        resume = deferred(t);
    const update = BaseStorage.prototype.update;
    let target: BaseStorage | undefined;
    t.mock.method(BaseStorage.prototype, 'update', async function (items: any[], options: any) {
        if (items.some((item) => item.embedding_generation === 1)) {
            target = this;
            entered.resolve();
            await resume.promise;
        }
        return update.call(this, items, options);
    });
    const result = fss.initialize({ syncEmbedding: false });
    await entered.promise;
    assert.equal(target, fss.storage, 'initialization operates on its current base holder');
    resume.resolve();
    await result;
    const stored = (await fss.storage!.search([])).items[0].item;
    assert.equal(stored.embedded, 0);
    assert.equal(stored.embedding_generation, 1);
});

for (const action of ['open-full', 'reset-base-only', 'reset-full'] as const) {
    test(`${action}: resource release and candidate reconciliation obey the publication barriers`, async (t) => {
        const fss = await owner(t, action === 'reset-full');
        const reset = action !== 'open-full';
        const closeFirst = action === 'reset-full';
        const old = fss.storage!;
        await old.upsert([row(path.join(fss._appDataDirectory, 'old.md'))], { indexers: ['BaseIndexer'] });
        fss.scannerState.embedding_generation = 1;
        const entered = deferred(t),
            resume = deferred(t),
            closing = deferred(t),
            release = deferred(t);
        const method = reset ? 'upsert' : 'update';
        const original = BaseStorage.prototype[method];
        let candidate: BaseStorage | undefined;
        t.mock.method(BaseStorage.prototype, method, async function (items: any[], options: any) {
            if (this !== old && items.some((item) => item.embedding_generation > 0)) {
                candidate = this;
                entered.resolve();
                await resume.promise;
            }
            return original.call(this, items, options);
        });
        const close = old.close.bind(old);
        t.mock.method(old, 'close', async () => {
            closing.resolve();
            await release.promise;
            return close();
        });
        const result = reset
            ? fss.retrieval._resetVectorChunk('fixture', { dim: 2, mode: 'full' })
            : fss.retrieval._openFull(2);
        try {
            if (closeFirst) {
                await closing.promise;
                assert.equal(candidate, undefined, 'reset closes its old owner before constructing the target');
                assert.equal(fss.storage, null);
                assert.ok(fss._pendingStorageClosures.has(old));
                release.resolve();
            }
            await entered.promise;
            assert.ok(candidate);
            assert.equal(fss.storage, closeFirst ? null : old);
            if (reset) {
                const disk = JSON.parse(fs.readFileSync(fss._scannerStatePath, 'utf8'));
                assert.equal(disk.semantic_reset_pending, true);
                assert.equal(disk.embedding_generation, 2);
            }
            resume.resolve();
            if (!closeFirst) {
                await closing.promise;
                assert.notEqual(fss.storage, candidate);
                assert.ok(fss._pendingStorageClosures.has(old));
                release.resolve();
            }
            await result;
        } finally {
            resume.resolve();
            release.resolve();
            await result.catch(() => {});
        }
        assert.equal(fss.storage, candidate);
        assert.equal(fss._pendingStorageClosures.size, 0);
        assert.equal(fss.scannerState.semantic_reset_pending, false);
    });
}

for (const mode of ['base-only', 'full']) {
    for (const phase of ['reconcile', 'complete-write', 'old-close'] as const) {
        test(`reset ${mode} ${phase} failure preserves primary error, pending and failed-close ownership`, async (t) => {
            const fss = await owner(t, mode === 'full');
            const old = fss.storage!;
            await old.upsert([row(path.join(fss._appDataDirectory, 'old.md'))], { indexers: ['BaseIndexer'] });
            const primary = new Error(`fixture ${phase}`);
            const cleanup = new Error('fixture candidate close');
            let failing = true;
            const close = BaseStorage.prototype.close;
            let candidate: BaseStorage | undefined;
            const initialize = BaseStorage.prototype.initialize;
            t.mock.method(BaseStorage.prototype, 'initialize', async function () {
                if (this !== old) candidate = this;
                return initialize.call(this);
            });
            const upsert = BaseStorage.prototype.upsert;
            t.mock.method(BaseStorage.prototype, 'upsert', async function (items: any[], options: any) {
                if (failing && phase === 'reconcile' && this !== old) throw primary;
                return upsert.call(this, items, options);
            });
            const write = fss._writeScannerStateSnapshot.bind(fss);
            t.mock.method(fss, '_writeScannerStateSnapshot', async (snapshot: any, commit: any) => {
                if (failing && phase === 'complete-write' && snapshot.semantic_reset_pending === false) throw primary;
                return write(snapshot, commit);
            });
            t.mock.method(BaseStorage.prototype, 'close', async function () {
                if (failing && this === old && phase === 'old-close') throw primary;
                if (failing && this === candidate) throw cleanup;
                return close.call(this);
            });
            try {
                await assert.rejects(
                    fss.retrieval._resetVectorChunk('fixture', { dim: 2, mode: 'full' }),
                    (error) => error === primary
                );
                assert.notEqual(fss.storage, candidate);
                assert.equal(fss.scannerState.semantic_reset_pending, true);
                assert.equal(fss.scannerState.embedding_generation, 1);
                if (phase === 'old-close') assert.ok(fss._pendingStorageClosures.has(old));
                if (mode === 'full' && phase === 'old-close') {
                    assert.equal(candidate, undefined, 'failed old full-owner release prevents target construction');
                } else assert.ok(candidate && fss._pendingStorageClosures.has(candidate));
                assert.equal(fss.storage, mode === 'base-only' && phase === 'reconcile' ? old : null);
            } finally {
                failing = false;
                await fss.close();
            }
            assert.equal(fss._pendingStorageClosures.size, 0);
        });
    }
}
test('B03: non-runnable fresh rows cannot hide runnable retry rows', async (t) => {
    const fss = await owner(t, true);
    const active = path.join(fss._appDataDirectory, 'A');
    const paused = path.join(fss._appDataDirectory, 'B');
    const retry = path.join(active, 'retry.md');
    await fss.storage!.upsert([row(retry, 0, -1, [active]), row(path.join(paused, 'fresh.md'), 0, 0, [paused])], {
        indexers: ['BaseIndexer']
    });
    let calls = 0;
    t.mock.method(fss.retrieval, '_buildWholeFile', async (item: any) => {
        calls++;
        await fss.storage!.update([{ ...item, embedded: 1 }], { indexers: ['BaseIndexer'] });
    });
    assert.equal(await fss.processEmbeddingQueue(() => false, { activeRoots: [active] }), 1);
    assert.equal(calls, 1);
    assert.equal((await fss.storage!.search([])).items.find(({ item }) => item.item_id === retry)!.item.embedded, 1);
});

test('B03: runnable fresh wins over retry while paused and removed fresh remain untouched', async (t) => {
    const fss = await owner(t, true);
    const active = path.join(fss._appDataDirectory, 'A');
    const child = path.join(active, 'child');
    const paused = path.join(fss._appDataDirectory, 'B');
    const removed = path.join(fss._appDataDirectory, 'removed');
    const fresh = path.join(child, 'fresh.md');
    const retry = path.join(active, 'retry.md');
    await fss.storage!.upsert(
        [
            row(retry, 0, -1, [active]),
            row(fresh, 0, 0, [active, child]),
            row(path.join(paused, 'paused.md'), 0, 0, [paused]),
            row(path.join(removed, 'removed.md'), 0, 0, [removed])
        ],
        { indexers: ['BaseIndexer'] }
    );
    const seen: string[] = [];
    t.mock.method(fss.retrieval, '_buildWholeFile', async (item: any) => {
        seen.push(item.item_id);
        await fss.storage!.update([{ ...item, embedded: 1 }], { indexers: ['BaseIndexer'] });
    });
    assert.equal(
        await fss.processEmbeddingQueue(() => false, {
            activeRoots: [active, child],
            currentWorkspace: active,
            limit: 1
        }),
        2
    );
    assert.deepEqual(seen, [fresh, retry]);
    const remaining = (await fss.storage!.search([])).items.filter(({ item }) => item.embedded === 0);
    assert.equal(remaining.length, 2);
});

test('B03: actual Worker does not enqueue a build with no runnable source', async (t) => {
    const fss = await owner(t, true);
    const root = path.join(fss._appDataDirectory, 'paused');
    const worker = new FileManagerWorker('filemgr', fss._appDataDirectory);
    worker.storage = fss;
    worker.status = 'running';
    worker.config = { entries: [{ root }] };
    fss.scannerState.roots[root] = { paused: true };
    const queue = t.mock.method(fss, 'processEmbeddingQueue');
    worker._enqueueEmbeddingQueue();
    await worker.taskQueue.onIdle();
    assert.equal(queue.mock.callCount(), 0);
    assert.equal(worker._embeddingQueueScheduled, false);
});

for (const phase of ['before', 'after'] as const)
    for (const code of ['ENOENT', 'EACCES', 'EIO'])
        test(`B02: ${phase} stat ${code} skips once without deleting or publishing`, async (t) => {
            const fss = await owner(t, true);
            const file = path.join(fss._appDataDirectory, 'input.md');
            fs.writeFileSync(file, '# Original body\n\nKeep existing products.');
            const input = row(file, 0, code === 'EACCES' ? -1 : 0);
            await fss.storage!.upsert([
                {
                    ...input,
                    indexer_columns: {
                        VectorIndexer: [{ column: 'filename', content: [1, 0] }],
                        ChunkIndexer: [{ column: 'chunk_text', id: 'old', text: 'old body', content: [1, 0] }]
                    }
                }
            ]);
            const before = await fss.storage!.getStatus();
            const stat = fs.promises.stat;
            let modelReturned = false;
            t.mock.method(fs.promises, 'stat', async (target: any, ...args: any[]) => {
                if (target === file && (phase === 'before' || modelReturned)) {
                    throw Object.assign(new Error(`fixture ${phase} ${code}`), { code });
                }
                return (stat as any)(target, ...args);
            });
            const model = t.mock.method(LLM, 'batchEmbed', async (texts: string[]) => {
                modelReturned = true;
                return texts.map(() => [1, 0]);
            });
            const build = fss.retrieval.buildStep.bind(fss.retrieval);
            let calls = 0;
            t.mock.method(fss.retrieval, 'buildStep', async (item: any) => {
                calls++;
                const result = await build(item);
                assert.deepEqual(result, { kind: 'skipped', reason: 'input_changed' });
                return result;
            });
            const clear = t.mock.method(fss.storage!, 'clearIndexerForItem');
            const remove = t.mock.method(fss.storage!, 'delete');
            const write = t.mock.method(fss.storage!, 'upsert');
            assert.equal(await fss.processEmbeddingQueue(() => false, { activeRoots: [path.dirname(file)] }), 0);
            assert.equal(calls, 1);
            assert.equal(model.mock.callCount(), phase === 'before' ? 0 : 1);
            assert.equal(clear.mock.callCount(), 0);
            assert.equal(remove.mock.callCount(), 0);
            assert.equal(write.mock.callCount(), 0);
            const stored = (await fss.storage!.search([])).items[0].item;
            assert.equal(stored.embedded, input.embedded);
            const after = await fss.storage!.getStatus();
            assert.equal(after.VectorIndexer.size, before.VectorIndexer.size);
            assert.equal(after.ChunkIndexer.size, before.ChunkIndexer.size);
        });

for (const change of ['delete', 'mtime', 'size'] as const)
    test(`B02: ${change} during the real model wait does not publish`, async (t) => {
        const fss = await owner(t, true);
        const file = path.join(fss._appDataDirectory, 'changing.md');
        fs.writeFileSync(file, '# Original body\n\nKeep this old body.');
        const input = row(file, 0, 0);
        await fss.storage!.upsert([input], { indexers: ['BaseIndexer'] });
        const entered = deferred(t),
            resume = deferred(t);
        const model = t.mock.method(LLM, 'batchEmbed', async (texts: string[]) => {
            entered.resolve();
            await resume.promise;
            return texts.map(() => [1, 0]);
        });
        const clear = t.mock.method(fss.storage!, 'clearIndexerForItem');
        const remove = t.mock.method(fss.storage!, 'delete');
        const write = t.mock.method(fss.storage!, 'upsert');
        const result = fss.retrieval.buildStep(input);
        await entered.promise;
        if (change === 'delete') fs.unlinkSync(file);
        else if (change === 'size') fs.appendFileSync(file, ' changed size');
        else {
            const stat = fs.statSync(file);
            fs.utimesSync(file, stat.atime, new Date(stat.mtimeMs + 1000));
        }
        resume.resolve();
        assert.deepEqual(await result, { kind: 'skipped', reason: 'input_changed' });
        assert.equal(model.mock.callCount(), 1);
        assert.equal(clear.mock.callCount(), 0);
        assert.equal(remove.mock.callCount(), 0);
        assert.equal(write.mock.callCount(), 0);
        assert.equal((await fss.storage!.search([])).items[0].item.embedded, 0);
    });

test('B01: nonempty to empty to nonempty removes obsolete body chunks', async (t) => {
    const fss = await owner(t, true);
    const file = path.join(fss._appDataDirectory, 'body.md');
    fs.writeFileSync(file, '# Old body\n\nThis body must have a structured chunk.');
    const input = row(file, 0, 0);
    await fss.storage!.upsert([input], { indexers: ['BaseIndexer'] });
    assert.equal((await fss.retrieval.buildStep(input)).kind, 'completed');
    const before = (await fss.storage!.getStatus()).ChunkIndexer.size;
    assert.ok(before > 0);
    fs.writeFileSync(file, '');
    assert.equal((await fss.retrieval.buildStep(input)).kind, 'completed');
    assert.equal((await fss.storage!.getStatus()).ChunkIndexer.size, 0);
    assert.equal((await fss.retrieval.searchContent('old', { topK: 10 })).results.length, 0);
    assert.equal((await fss.storage!.getStatus()).VectorIndexer.size, 1);
    fs.writeFileSync(file, '# New body\n\nThis replacement must be searchable.');
    assert.equal((await fss.retrieval.buildStep(input)).kind, 'completed');
    const found: any = await fss.retrieval.searchContent('replacement', { topK: 10 });
    assert.ok(found.results.length > 0);
    assert.ok(found.results.every((hit: any) => !hit.chunk.text.includes('Old body')));
    assert.equal((await fss.storage!.search([])).items[0].item.embedded, 1);
});

for (const embedded of [0, -1])
    for (const target of ['vector', 'chunk'])
        test(`B01: ${target} write limit preserves ${embedded}, products and same-round accounting`, async (t) => {
            const fss = await owner(t, true);
            const file = path.join(fss._appDataDirectory, 'limited.md');
            fs.writeFileSync(file, '# Required body\n\nThis content needs a body chunk.');
            const input = row(file, 0, embedded);
            await fss.storage!.upsert([
                {
                    ...input,
                    indexer_columns: {
                        VectorIndexer: [{ column: 'filename', content: [1, 0] }],
                        ChunkIndexer: [{ column: 'chunk_text', id: 'old', text: 'old body', content: [1, 0] }]
                    }
                }
            ]);
            t.mock.method(fss.storage!, 'getSemanticWriteState', async () => ({
                vector: { acceptingWrites: target !== 'vector' },
                chunk: { acceptingWrites: target !== 'chunk' }
            }));
            const read = t.mock.method(fs.promises, 'readFile');
            const model = t.mock.method(LLM, 'batchEmbed');
            const clear = t.mock.method(fss.storage!, 'clearIndexerForItem');
            const write = t.mock.method(fss.storage!, 'upsert');
            const build = fss.retrieval.buildStep.bind(fss.retrieval);
            let calls = 0;
            t.mock.method(fss.retrieval, 'buildStep', async (item: any) => {
                calls++;
                const result = await build(item);
                assert.deepEqual(result, { kind: 'skipped', reason: 'write_limited' });
                return result;
            });
            assert.equal(await fss.processEmbeddingQueue(() => false, { activeRoots: [path.dirname(file)] }), 0);
            assert.equal(calls, 1);
            assert.equal(model.mock.callCount(), 0);
            assert.equal(clear.mock.callCount(), 0);
            assert.equal(write.mock.callCount(), 0);
            const reads = read.mock.calls.filter((call) => call.arguments[0] === file);
            assert.equal(reads.length, target === 'vector' ? 0 : 1);
            assert.equal((await fss.storage!.search([])).items[0].item.embedded, embedded);
            assert.equal((await fss.storage!.getStatus()).ChunkIndexer.size, 1);
            assert.equal((await fss.storage!.getStatus()).VectorIndexer.size, 1);
        });

for (const content of ['empty', 'filename-only'])
    test(`B01: chunk-limited ${content} still publishes the name and clears old body`, async (t) => {
        const fss = await owner(t, true);
        const file = path.join(fss._appDataDirectory, content === 'empty' ? 'empty.md' : 'filename.json');
        fs.writeFileSync(file, content === 'empty' ? '' : '{"key":"value"}');
        const input = row(file, 0, 0);
        await fss.storage!.upsert([
            {
                ...input,
                indexer_columns: {
                    ChunkIndexer: [{ column: 'chunk_text', id: 'old', text: 'old body', content: [1, 0] }]
                }
            }
        ]);
        t.mock.method(fss.storage!, 'getSemanticWriteState', async () => ({
            vector: { acceptingWrites: true },
            chunk: { acceptingWrites: false }
        }));
        const model = t.mock.method(LLM, 'batchEmbed', async (texts: string[]) => {
            assert.deepEqual(texts, [path.basename(file)]);
            return [[1, 0]];
        });
        assert.deepEqual(await fss.retrieval.buildStep(input), { kind: 'completed' });
        assert.equal(model.mock.callCount(), 1);
        assert.equal((await fss.storage!.getStatus()).ChunkIndexer.size, 0);
        assert.equal((await fss.storage!.getStatus()).VectorIndexer.size, 1);
        assert.equal((await fss.storage!.search([])).items[0].item.embedded, 1);
    });

test('B01: empty-body cleanup failure is returned before name publication and completion', async (t) => {
    const fss = await owner(t, true);
    const file = path.join(fss._appDataDirectory, 'empty-failure.md');
    fs.writeFileSync(file, '');
    const input = row(file, 0, 0);
    await fss.storage!.upsert([input], { indexers: ['BaseIndexer'] });
    const primary = new Error('fixture empty cleanup failure');
    t.mock.method(fss.storage!, 'clearIndexerForItem', async () => {
        throw primary;
    });
    const publish = t.mock.method(fss.storage!, 'upsert');
    const result = await fss.retrieval.buildStep(input);
    assert.equal(result.kind, 'failed');
    if (result.kind === 'failed') assert.equal(result.error, primary);
    assert.equal(publish.mock.callCount(), 0);
    assert.notEqual((await fss.storage!.search([])).items[0].item.embedded, 1);
});

for (const phase of ['parse', 'model', 'clear', 'vector', 'chunk', 'complete'])
    test(`B01: ${phase} failure cannot mark the file complete`, async (t) => {
        const fss = await owner(t, true);
        const file = path.join(fss._appDataDirectory, 'failure.md');
        fs.writeFileSync(file, '# Replacement\n\nNew body should only publish after model success.');
        const input = row(file, 0, 0);
        await fss.storage!.upsert([
            {
                ...input,
                indexer_columns: {
                    ChunkIndexer: [{ column: 'chunk_text', id: 'old', text: 'old body', content: [1, 0] }]
                }
            }
        ]);
        const primary = new Error(`fixture ${phase}`);
        const clear = t.mock.method(fss.storage!, 'clearIndexerForItem');
        if (phase === 'parse') {
            const extname = path.extname;
            t.mock.method(path, 'extname', (target) => {
                if (target === file) throw primary;
                return extname(target);
            });
        } else if (phase === 'model')
            t.mock.method(LLM, 'batchEmbed', async () => {
                throw primary;
            });
        else if (phase === 'clear')
            t.mock.method(fss.storage!, 'clearIndexerForItem', async () => {
                throw primary;
            });
        else if (phase === 'complete') {
            const update = fss.storage!.update.bind(fss.storage);
            t.mock.method(fss.storage!, 'update', async (items: any[], options: any) => {
                if (items.some((item) => item.embedded === 1)) throw primary;
                return update(items, options);
            });
        } else
            t.mock.method((fss.storage as any)[`${phase}Indexer`], 'upsert', async () => {
                throw primary;
            });
        const result = await fss.retrieval.buildStep(input);
        assert.equal(result.kind, 'failed');
        if (result.kind === 'failed') assert.equal(result.error, primary);
        assert.notEqual((await fss.storage!.search([])).items[0].item.embedded, 1);
        if (phase === 'parse' || phase === 'model') {
            assert.equal(clear.mock.callCount(), 0);
            assert.equal((await fss.storage!.getStatus()).ChunkIndexer.size, 1);
        }
    });

for (const [name, modelName, dimension, resets] of [
    ['same name, changed endpoint/dimension', 'fixture-model', 3, 1],
    ['same name and dimension', 'fixture-model', 2, 0],
    ['renamed model', 'replacement-model', 2, 1]
] as const)
    test(`B24: explicit prepare reprobes ${name}`, async (t) => {
        const fss = await owner(t, true);
        t.mock.method(Setting, 'getInstance', () => ({
            data: { locale: 'en-US' },
            getData: () => ({}),
            getDefaultEmbeddingModelInstance: () => ({
                model_name: modelName,
                base_url: 'http://127.0.0.1:2/changed',
                provider_name: 'changed-provider',
                custom_headers: { fixture: 'changed' },
                getTimeoutMs: () => 10000
            })
        }));
        const probe = t.mock.method(LLM, 'embed', async () => new Array(dimension).fill(1));
        const reset = t.mock.method(fss.retrieval, '_resetVectorChunk');
        await fss.retrieval.prepare({
            context: {},
            reason: 'embedding config changed',
            role: 'write',
            forceProbe: true
        });
        assert.equal(probe.mock.callCount(), 1);
        assert.equal(reset.mock.callCount(), resets);
        assert.equal(fss.scannerState.vec_dim, dimension);
        assert.equal(fss.scannerState.embedding_model, modelName);
        assert.equal(fss.scannerState.embedding_generation, resets);
        assert.equal(fss.scannerState.semantic_reset_pending, false);
        assert.equal(fss.scannerState.vector_backend, fss.storage!.getSemanticBackends().vector);
    });

test('B24: ordinary unchanged scan retains the no-probe fast path', async (t) => {
    const fss = await owner(t, true);
    const probe = t.mock.method(LLM, 'embed');
    await fss.retrieval.prepare({ context: {}, reason: 'scan', role: 'write' });
    assert.equal(probe.mock.callCount(), 0);
});

for (const successor of ['C', 'A', 'root-config'])
    test(`B24: real Worker carries reprobing across B to ${successor} and discards the stale probe`, async (t) => {
        const fss = await owner(t, true);
        await fss.retrieval._demoteToBaseOnly('fixture initial base-only');
        const worker = new FileManagerWorker('filemgr', fss._appDataDirectory);
        worker.storage = fss;
        worker.config = { entries: [] };
        worker._lastConfig = worker.config;
        worker.status = 'running';
        t.mock.method(worker, '_emitStatusChanged', async () => {});
        let selected = 'B';
        const seen: string[] = [];
        const entered = deferred(t),
            resume = deferred(t);
        t.mock.method(Setting, 'getInstance', () => ({
            data: { locale: 'en-US' },
            getData: () => ({}),
            getDefaultEmbeddingModelInstance: () => ({
                model_name: 'fixture-model',
                base_url: `http://127.0.0.1/${selected}`,
                getTimeoutMs: () => 10000
            })
        }));
        t.mock.method(LLM, 'embed', async () => {
            const current = selected;
            seen.push(current);
            if (seen.length === 1) {
                entered.resolve();
                await resume.promise;
            }
            return new Array(current === 'A' ? 2 : current === 'B' ? 3 : 4).fill(1);
        });
        const reset = t.mock.method(fss.retrieval, '_resetVectorChunk');
        const restart = t.mock.method(worker, '_restartScanners');
        const first = worker.embeddingConfigChanged();
        await entered.promise;
        selected = successor === 'root-config' ? 'B' : successor;
        const next =
            successor === 'root-config'
                ? worker.applicationConfigChanged({ enabled: true, entries: [] })
                : worker.embeddingConfigChanged();
        await flush();
        assert.equal(worker._pendingEmbeddingConfigChange, true);
        resume.resolve();
        await Promise.all([first, next]);
        await worker.taskQueue.onIdle();
        assert.deepEqual(seen, ['B', selected]);
        assert.deepEqual(
            reset.mock.calls.map((call) => (call.arguments[1] as any).dim),
            successor === 'A' ? [] : [selected === 'B' ? 3 : 4]
        );
        assert.equal(fss.scannerState.vec_dim, selected === 'A' ? 2 : selected === 'B' ? 3 : 4);
        assert.equal(fss.scannerState.embedding_generation, successor === 'A' ? 0 : 1);
        assert.equal(fss.scannerState.semantic_reset_pending, false);
        assert.equal(worker._pendingEmbeddingConfigChange, false);
        assert.equal(fss.scannerState.vector_backend, fss.storage!.getSemanticBackends().vector);
        if (successor === 'root-config') {
            assert.equal(worker._lastConfig.enabled, true);
            assert.equal(restart.mock.callCount(), 1);
        }
    });

test('B24: actual initialize first probe cannot consume a newer configuration continuation', async (t) => {
    const directory = fs.mkdtempSync(path.join(profile, 'startup-probe-'));
    const worker = new FileManagerWorker('filemgr', directory);
    worker.config = { entries: [] };
    t.mock.method(worker, '_acquireScanLock', async () => true);
    t.mock.method(worker, '_startStatusTick', () => {});
    t.mock.method(worker, '_emitStatusChanged', async () => {});
    t.after(() => worker.finalize());
    let selected = 'A';
    const seen: string[] = [];
    const entered = deferred(t),
        resume = deferred(t);
    t.mock.method(Setting, 'getInstance', () => ({
        data: { locale: 'en-US' },
        getData: () => ({}),
        getDefaultEmbeddingModelInstance: () => ({
            model_name: 'fixture-model',
            base_url: `http://127.0.0.1/${selected}`,
            getTimeoutMs: () => 10000
        })
    }));
    t.mock.method(LLM, 'embed', async () => {
        const current = selected;
        seen.push(current);
        if (seen.length === 1) {
            entered.resolve();
            await resume.promise;
        }
        return new Array(current === 'A' ? 2 : 3).fill(1);
    });
    await worker.initialize();
    await entered.promise;
    selected = 'B';
    await worker.embeddingConfigChanged();
    assert.equal(worker._pendingEmbeddingConfigChange, true);
    resume.resolve();
    await worker.taskQueue.onIdle();
    assert.deepEqual(seen, ['A', 'B']);
    assert.equal(worker.storage!.scannerState.vec_dim, 3);
    assert.equal(worker.storage!.scannerState.embedding_generation, 0);
    assert.equal(worker._pendingEmbeddingConfigChange, false);
    assert.equal(worker._initializing, false);
    assert.equal(worker.status, 'idle');
});

test('B24: failed configuration successor stays explicitly retryable with a healthy base', async (t) => {
    const fss = await owner(t, true);
    await fss.retrieval._demoteToBaseOnly('fixture base-only');
    const worker = new FileManagerWorker('filemgr', fss._appDataDirectory);
    worker.storage = fss;
    worker.config = { entries: [] };
    worker._lastConfig = null;
    worker.status = 'running';
    t.mock.method(worker, '_emitStatusChanged', async () => {});
    const primary = new Error('fixture candidate open failure');
    const initialize = BaseStorage.prototype.initialize;
    let fail = true;
    t.mock.method(BaseStorage.prototype, 'initialize', async function () {
        if (fail && (this as any).vectorIndexer) throw primary;
        return initialize.call(this);
    });
    const probe = t.mock.method(LLM, 'embed', async () => [1, 0]);
    await assert.rejects(worker.embeddingConfigChanged(), (error) => error === primary);
    assert.equal(worker.status, 'running');
    assert.equal(worker._pendingEmbeddingConfigChange, false);
    fail = false;
    await worker.embeddingConfigChanged();
    assert.equal(probe.mock.callCount(), 2);
    assert.equal(fss.mode, 'full');
    assert.equal(fss.scannerState.vec_dim, 2);
    assert.equal(fss.scannerState.embedding_generation, 0);
    assert.equal(worker._pendingEmbeddingConfigChange, false);
});

for (const scenario of ['unfinished', 'completed', 'corrupt-state'])
    test(`C7: prepare preserves ${scenario} qualification without vector-only promotion`, async (t) => {
        const fss = await owner(t, true);
        const file = path.join(fss._appDataDirectory, 'legacy.md');
        fs.writeFileSync(file, '# Legacy body\n\nBuild this file through the normal model path.');
        const input = row(file, 0, scenario === 'completed' ? 1 : 0);
        await fss.storage!.upsert([
            {
                ...input,
                indexer_columns: {
                    VectorIndexer: [{ column: 'filename', content: [1, 0] }]
                }
            }
        ]);
        fss.scannerState.embedded_migrated = false;
        await fss.saveScannerState();
        await fss.close();
        if (scenario === 'corrupt-state') fs.writeFileSync(fss._scannerStatePath, '{broken');
        await fss.initialize({ syncEmbedding: false });
        await fss.retrieval.prepare({ context: {}, reason: 'startup', role: 'write' });
        assert.equal(fss.scannerState.embedding_generation, 0);
        assert.equal((await fss.storage!.search([])).items[0].item.embedded, input.embedded);
        const model = t.mock.method(LLM, 'batchEmbed', async (texts: string[]) => texts.map(() => [1, 0]));
        assert.equal(
            await fss.processEmbeddingQueue(() => false, { activeRoots: [path.dirname(file)] }),
            scenario === 'completed' ? 0 : 1
        );
        assert.equal(model.mock.callCount(), scenario === 'completed' ? 0 : 1);
        assert.equal((await fss.storage!.search([])).items[0].item.embedded, 1);
    });

test('legacy per-route RPCs and their dedicated FS adapter are absent', () => {
    assert.equal(Object.hasOwn(FileManagerWorker.prototype, 'searchFileByName'), false);
    assert.equal(Object.hasOwn(FileManagerWorker.prototype, 'searchFileByContent'), false);
    assert.equal(Object.hasOwn(FSStorage.prototype, 'searchFileByName'), false);
});

test('whole-file transient retry repeats the complete group and preserves the small API batch', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const fss = new FSStorage(path.join(profile, 'retry'));
    const groups: string[][] = [];
    t.mock.method(LLM, 'batchEmbed', async (texts: string[], batchSize: number) => {
        groups.push([...texts]);
        assert.equal(batchSize, 32);
        if (groups.length < 4) throw Object.assign(new Error('fixture unavailable'), { status: 502 });
        return texts.map(() => [1, 0]);
    });
    const texts = ['filename.md', 'first body', 'second body'];
    const result = fss.retrieval._embedWithRetry(texts);
    for (let i = 0; i < 10; i++) {
        await flush();
        t.mock.timers.tick(120000);
    }
    assert.deepEqual(
        await result,
        texts.map(() => [1, 0])
    );
    assert.deepEqual(groups, [texts, texts, texts, texts]);
});

test('B29: each batch sorts valid indexes, accepts wholly missing indexes and rejects duplicates', async (t) => {
    // Exercise the real public client at the loopback HTTP boundary.
    const responses = [
        [
            { index: 1, embedding: [2] },
            { index: 0, embedding: [1] }
        ],
        [{ embedding: [3] }, { embedding: [4] }],
        [
            { index: 0, embedding: [5] },
            { index: 0, embedding: [6] }
        ]
    ];
    let calls = 0;
    const server = http.createServer((request, response) => {
        request.resume();
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ data: responses[calls++] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    setPlatform({
        fetch: (input: string | URL, init: RequestInit) => {
            assert.equal(new URL(input).origin, `http://127.0.0.1:${address.port}`);
            return fetch(input, init);
        }
    } as any);
    t.mock.method(Setting, 'getInstance', () => ({
        getDefaultEmbeddingModelInstance: () => ({
            model_name: 'fixture-model',
            base_url: `http://127.0.0.1:${address.port}/v1`,
            api_key: '',
            no_proxy: true,
            getProviderName: () => 'loopback'
        }),
        data: { locale: 'en-US' },
        getData: () => ({})
    }));
    try {
        assert.deepEqual(await realBatchEmbed.call(LLM, ['a', 'b', 'c', 'd'], 2), [[1], [2], [3], [4]]);
        await assert.rejects(realBatchEmbed.call(LLM, ['e', 'f'], 2), { status: 502 });
        assert.equal(calls, 3);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});
