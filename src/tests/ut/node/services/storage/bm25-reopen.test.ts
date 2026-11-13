import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BaseStorage } from '../../../../../main/services/storage/abstract-storage.js';
import { BM25StatsStore } from '../../../../../main/services/storage/bm25-stats-store.js';
import { configureOwner, holderFixture, item, record, rows, schema } from './fixtures/bm25-fixture.js';
import { createBM25Tokenizer } from '../../../../../main/services/storage/bm25-tokenizer.js';

function search(owner: BaseStorage, query: string, field = 'text', topK = 20) {
    return owner.search([{ indexer: 'BM25Indexer', field, operator: 'bm25_match', value: { query, topK } }]);
}
for (const backend of ['native', 'wasm'] as const) {
    test(`BM25 ${backend} reopen preserves hits, original Base fields, metadata, scores and per-column topK`, async () => {
        await holderFixture(backend, async (owner, _indexer, directory) => {
            const first = { ...item('best', 'lifecycle search'), text: 'Mixed CASE，原文  空格!', category: 'first' };
            first.indexer_columns!.BM25Indexer.push({ column: 'title', content: 'column scope' });
            await owner.insert([first, item('second', 'lifecycle only')]);
            const before = await search(owner, 'lifecycle search');
            assert.deepEqual(
                before.items.map((hit) => hit.item.item_id),
                ['best', 'second']
            );
            assert.ok(Math.abs(before.items[0].BM25Score! - Math.log(1.2) - Math.log(2)) < 1e-12);
            assert.ok(Math.abs(before.items[1].BM25Score! - Math.log(1.2)) < 1e-12);
            const titleBefore = await search(owner, 'scope', 'title');
            assert.equal(titleBefore.items[0].item.text, first.text);
            assert.equal(titleBefore.items[0].item.category, 'first');
            await owner.close();
            const reopened = new BaseStorage('reopened', schema, directory);
            configureOwner(reopened, backend);
            try {
                await reopened.initialize();
                assert.deepEqual(await search(reopened, 'lifecycle search'), before);
                assert.deepEqual(await search(reopened, 'scope', 'title'), titleBefore);
                assert.equal((await search(reopened, 'lifecycle search', 'text', 1)).items[0].item.item_id, 'best');
                assert.equal((await search(reopened, 'scope', 'text')).totalCount, 0);
                await assert.rejects(owner.initialize(), /closing or closed/);
            } finally {
                await reopened.close();
            }
        });
    });
    test(`BM25 ${backend} record CRUD persists across multiple reopens without losing sibling columns`, async () => {
        await holderFixture(backend, async (owner, _indexer, directory) => {
            await owner.insert([item('existing', 'old persisted'), item('deleted', 'deleted marker')]);
            await owner.close();
            let reopened = new BaseStorage('reopened', schema, directory);
            configureOwner(reopened, backend);
            try {
                await reopened.initialize();
                await reopened.insert([item('existing', 'ignored duplicate')]);
                assert.equal((await search(reopened, 'old')).totalCount, 1);
                await reopened.update([{ ...item('existing', 'fresh updated'), category: 'updated' }]);
                assert.equal((await search(reopened, 'old')).totalCount, 0);
                assert.equal((await search(reopened, 'fresh')).items[0].item.category, 'updated');
                await reopened.upsert([item('existing', 'heading', '', 'title')]);
                await reopened.delete(['deleted']);
                await reopened.upsert([item('added', 'upsert new')]);
                await reopened.close();
                reopened = new BaseStorage('again', schema, directory);
                configureOwner(reopened, backend);
                await reopened.initialize();
                assert.equal((await search(reopened, 'deleted')).totalCount, 0);
                assert.equal((await search(reopened, 'fresh')).totalCount, 1);
                assert.equal((await search(reopened, 'heading', 'title')).items[0].item.item_id, 'existing');
                assert.equal((await search(reopened, 'upsert')).items[0].item.item_id, 'added');
            } finally {
                await reopened.close();
            }
        });
    });
    test(`BM25 ${backend} statistics and raw results never persist or return source text`, async () => {
        await holderFixture(backend, async (owner, indexer, directory) => {
            const raw = 'Mixed CASE，原文  空格! Lifecycle';
            await owner.upsert([{ ...item('direct', raw), text: raw }]);
            const before = await owner.searchBM25('lifecycle', { field: 'text' });
            assert.deepEqual(Object.keys(before[0]).sort(), ['field', 'item_id', 'score', 'subKey']);
            for (const table of ['terms', 'records', 'postings', 'field_stats']) {
                const columns = rows(indexer.db, `PRAGMA table_info(${table})`).map((row) => row.name);
                assert.ok(
                    !columns.some((column) => ['text', 'raw_text', 'tokens', 'item_type'].includes(column as string))
                );
            }
            await owner.close();
            const reopened = new BaseStorage('reopened', schema, directory);
            configureOwner(reopened, backend);
            try {
                await reopened.initialize();
                assert.deepEqual(await reopened.searchBM25('lifecycle', { field: 'text' }), before);
                assert.equal((await search(reopened, 'lifecycle')).items[0].item.text, raw);
            } finally {
                await reopened.close();
            }
        });
    });
    test(`BM25 ${backend} cold schema-read failure cleans up and the same holder initializes again`, async (t) => {
        await holderFixture(backend, async (owner, _indexer, directory) => {
            await owner.insert([item('retry', 'recoverable persisted')]);
            await owner.close();
            const reopened = new BaseStorage('reopened', schema, directory);
            configureOwner(reopened, backend);
            const inspect = BM25StatsStore.prototype.inspect;
            const failure = new Error('fixture cold schema read failure');
            let once = true;
            t.mock.method(BM25StatsStore.prototype, 'inspect', function (this: BM25StatsStore) {
                if (once) {
                    once = false;
                    throw failure;
                }
                return inspect.call(this);
            });
            try {
                await assert.rejects(reopened.initialize(), (error) => error === failure);
                await reopened.initialize();
                assert.equal((await search(reopened, 'recoverable')).items[0].item.item_id, 'retry');
            } finally {
                await reopened.close();
            }
        });
    });
    test(`BM25 ${backend} deletes all 110 restored records by exact object identity`, async () => {
        await holderFixture(backend, async (owner, indexer, directory) => {
            const id = 'arbitrary / Mixed:ID';
            indexer.db.insert(Array.from({ length: 110 }, (_, i) => record(id, 'searchable', 'text', `multiple-${i}`)));
            await owner.close();
            const reopened = new BaseStorage('reopened', schema, directory);
            configureOwner(reopened, backend);
            try {
                await reopened.initialize();
                assert.equal((await reopened.searchBM25('searchable', { field: 'text', topK: 200 })).length, 110);
                await reopened.delete([id]);
                assert.equal((await reopened.getStatus()).BM25Indexer.size, 0);
                assert.deepEqual(await reopened.searchBM25('searchable', { field: 'text' }), []);
            } finally {
                await reopened.close();
            }
        });
    });
    test(`BM25 ${backend} equal-score topK selection is deterministic across reopening`, async () => {
        await holderFixture(backend, async (owner, _indexer, directory) => {
            await owner.insert([item('z-last', 'matching equal'), item('a-first', 'matching equal')]);
            const before = await search(owner, 'matching', 'text', 1);
            assert.equal(before.items[0].item.item_id, 'a-first');
            await owner.close();
            const reopened = new BaseStorage('reopened', schema, directory);
            configureOwner(reopened, backend);
            try {
                await reopened.initialize();
                assert.deepEqual(await search(reopened, 'matching', 'text', 1), before);
            } finally {
                await reopened.close();
            }
        });
    });
}

for (const backend of ['native', 'wasm'] as const) {
    test(`P1 ${backend} both real tokenizers consume and extend the same compatible store`, async () => {
        await holderFixture(backend, async (owner, _indexer, directory) => {
            await owner.close();
            let expected: unknown;
            for (const tokenizerBackend of ['native', 'wasm', 'native'] as const) {
                const reopened = new BaseStorage('tokenizer-swap', schema, directory);
                const indexer = configureOwner(reopened, backend);
                indexer.dependencies.tokenizer = () => createBM25Tokenizer({ forceWasm: tokenizerBackend === 'wasm' });
                try {
                    await reopened.initialize();
                    if (expected)
                        assert.deepEqual(await reopened.searchBM25('中文 hello', { field: 'text' }), expected);
                    await reopened.upsert([item(tokenizerBackend, '中文 HELLO 全角Ａ')]);
                    expected = await reopened.searchBM25('中文 hello', { field: 'text' });
                    assert.equal((await indexer.getInfo()).tokenizer, tokenizerBackend);
                } finally {
                    await reopened.close();
                }
            }
        });
    });
}
