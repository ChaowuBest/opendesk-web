import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setPlatform } from '../../../../platforms/base.js';
import { Setting, setCustomOpendeskDirectory } from '../../../../main/utils/setting.js';
import { LLM } from '../../../../main/aikernel/llm.js';
import { FSStorage } from '../../../../main/applications/filemgr/storage.js';
import { classifyEmbeddingError } from '../../../../main/applications/filemgr/document-retrieval/embedding/state.js';
import { RecallVectorStorage } from '../../../../main/applications/recall/service/persistence/RecallVectorStorage.js';

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wf1-batch-'));
setCustomOpendeskDirectory(profile);
after(() => fs.rmSync(profile, { recursive: true, force: true }));
let requests: string[][];
let responseFor: (input: string[], call: number) => unknown[];
const valid = (input: string[]) => input.map((_text, index) => ({ index, embedding: [1, 0] }));

beforeEach((t) => {
    requests = [];
    responseFor = valid;
    t.mock.method(Setting, 'getInstance', () => ({
        getDefaultEmbeddingModelInstance: () => ({
            model_name: 'fixture-model',
            base_url: 'http://127.0.0.1:1/v1',
            api_key: '',
            no_proxy: true,
            getProviderName: () => 'fixture',
            getTimeoutMs: () => 1000
        }),
        data: { locale: 'en-US' },
        getData: () => ({})
    }));
    setPlatform({
        fetch: async (url: string, init: RequestInit) => {
            assert.equal(url, 'http://127.0.0.1:1/v1/embeddings');
            const { input } = JSON.parse(String(init.body));
            assert.ok(Array.isArray(input));
            requests.push([...input]);
            return new Response(JSON.stringify({ data: responseFor(input, requests.length) }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        }
    } as any);
});

test('valid indexed batches sort locally; batches with no indexes preserve their returned order', async () => {
    responseFor = (input, call) =>
        call === 2
            ? input.map((text) => ({ embedding: [Number(text), 0] }))
            : input.map((text, index) => ({ index, embedding: [Number(text), 0] })).reverse();
    assert.deepEqual(await LLM.batchEmbed(['1', '2', '3', '4', '5'], 2), [
        [1, 0],
        [2, 0],
        [3, 0],
        [4, 0],
        [5, 0]
    ]);
    assert.deepEqual(requests, [['1', '2'], ['3', '4'], ['5']]);
});

test('unique integer indexes may be negative and nonconsecutive', async () => {
    responseFor = () => [12, -3, 5].map((index) => ({ index, embedding: [index, 1] }));
    assert.deepEqual(await LLM.batchEmbed(['a', 'b', 'c'], 3), [
        [-3, 1],
        [5, 1],
        [12, 1]
    ]);
});

for (const [name, entries] of [
    ['partial', [{ index: 0 }, {}]],
    ['duplicate', [{ index: 0 }, { index: 0 }]],
    ['fractional', [{ index: 0 }, { index: 0.5 }]],
    ['null', [{ index: 0 }, { index: null }]],
    ['string', [{ index: 0 }, { index: '1' }]],
    ['short', [{ index: 0 }]],
    ['long', [{ index: 0 }, { index: 1 }, { index: 2 }]],
    ['short-no-index', [{}]],
    ['long-no-index', [{}, {}, {}]]
] as const)
    test(`invalid ${name} response rejects with localized 502 and retains transient classification`, async () => {
        responseFor = () => entries.map((entry) => ({ ...entry, embedding: [1, 0] }));
        await assert.rejects(LLM.batchEmbed(['a', 'b'], 2), (error: any) => {
            assert.equal(error.status, 502);
            assert.match(error.message, /invalid embedding response/i);
            assert.equal(classifyEmbeddingError(error).kind, 'transient');
            return true;
        });
        assert.equal(requests.length, 1);
    });

test('a bad later batch rejects the whole public result', async () => {
    responseFor = (input, call) => (call === 2 ? valid(input).slice(1) : valid(input));
    await assert.rejects(LLM.batchEmbed(['a', 'b', 'c', 'd'], 2), { status: 502 });
    assert.equal(requests.length, 2);
});

test('filemgr late batch failure retries the complete group nine times and publishes nothing', async (t) => {
    const directory = fs.mkdtempSync(path.join(profile, 'filemgr-'));
    const fss = new FSStorage(directory);
    t.after(() => fss.close());
    await fss.initialize({ syncEmbedding: false });
    Object.assign(fss.scannerState, {
        embedding_model: 'fixture-model',
        vec_dim: 2,
        chunk_level: 'structured',
        vector_backend: null,
        chunk_backend: null
    });
    await fss.saveScannerState();
    await fss.retrieval._openFull(2);
    const file = path.join(directory, 'many.txt');
    fs.writeFileSync(
        file,
        Array.from({ length: 40 }, (_, i) => `Paragraph ${i} ${'content '.repeat(200)}`).join('\n\n')
    );
    const input = {
        item_id: file,
        item_type: 'file',
        type: 'file',
        filename: 'many.txt',
        root_refs: JSON.stringify([directory]),
        ref_count: 1,
        embedded: 0,
        embedding_generation: 0
    };
    await fss.storage!.upsert([input], { indexers: ['BaseIndexer'] });
    const publish = t.mock.method(fss.storage!, 'upsert');
    const clear = t.mock.method(fss.storage!, 'clearIndexerForItem');
    responseFor = (batch, call) => (call % 2 === 0 ? batch.map(() => ({ index: 0, embedding: [1, 0] })) : valid(batch));
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let settled = false;
    const pending = fss.retrieval.buildStep(input).finally(() => {
        settled = true;
    });
    for (let i = 0; i < 2000 && !settled; i++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        t.mock.timers.tick(120000);
    }
    assert.equal(settled, true, 'the deterministic retry must settle without real backoff waits');
    const result = await pending;
    assert.equal(result.kind, 'failed');
    if (result.kind === 'failed') assert.equal(result.failure.kind, 'transient');
    assert.equal(requests.length, 18, 'each of nine whole-group attempts recomputes its first batch');
    assert.equal(requests[0].length, 32);
    assert.ok(requests[1].length > 1);
    for (let i = 2; i < requests.length; i++) assert.deepEqual(requests[i], requests[i % 2]);
    assert.equal(publish.mock.callCount(), 0);
    assert.equal(clear.mock.callCount(), 0);
    assert.notEqual((await fss.storage!.search([])).items[0].item.embedded, 1);
    assert.equal((await fss.storage!.getStatus()).VectorIndexer.size, 0);
    assert.equal((await fss.storage!.getStatus()).ChunkIndexer.size, 0);
});

test('Recall late batch failure does not modify cache, cache file or write queue and does not retry', async (t) => {
    const directory = fs.mkdtempSync(path.join(profile, 'recall-'));
    const recall = new RecallVectorStorage(directory);
    t.mock.method(recall.vecdb, 'beginUpdate', async () => {});
    t.mock.method(recall.vecdb, 'insertItem', async () => {});
    t.mock.method(recall.vecdb, 'endUpdate', async () => {});
    const writes = t.mock.method(recall.writeQueue, 'add');
    responseFor = (input, call) => (call === 2 ? [] : valid(input));
    const memories = Array.from({ length: 65 }, (_, i) => ({ snapshotId: `fixture-${i}`, summary: `summary ${i}` }));
    await assert.rejects(recall.batchSaveMemories(memories), { status: 502 });
    assert.equal(requests.length, 2);
    assert.equal(recall.vecCache.size, 0);
    assert.equal(fs.existsSync(RecallVectorStorage.vectorCachePath), false);
    assert.equal(writes.mock.callCount(), 0);
});
