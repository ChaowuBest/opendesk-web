import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BaseStorage, type ColumnSchema, type Item } from '../../../../../main/services/storage/abstract-storage.js';
import { ClassicLevel } from 'classic-level';
import { BM25IndexDB } from '../../../../../main/services/storage/bm25-index-db.js';
import { setCustomOpendeskDirectory } from '../../../../../main/utils/setting.js';

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bm25-reopen-'));
setCustomOpendeskDirectory(profile);
after(() => fs.rmSync(profile, { recursive: true, force: true }));
const schema: ColumnSchema = {
    columns: {
        item_id: { type: 'TEXT', nullable: false },
        item_type: { type: 'TEXT', nullable: false },
        text: { type: 'TEXT' },
        title: { type: 'TEXT' },
        category: { type: 'TEXT' }
    },
    needIndexers: {
        text: [{ indexer: 'BM25Indexer' }],
        title: [{ indexer: 'BM25Indexer' }]
    }
};
function item(id: string, text: string, title = 'Heading', category = 'kept'): Item {
    return {
        item_id: id,
        item_type: 'document',
        text,
        title,
        category,
        indexer_columns: {
            BM25Indexer: [
                { column: 'text', content: text },
                { column: 'title', content: title }
            ]
        }
    };
}
function search(owner: BaseStorage, query: string, column = 'text', topK = 20) {
    return owner.search([{ indexer: 'BM25Indexer', field: column, operator: 'bm25_match', value: { query, topK } }]);
}
async function fixture(run: (get: () => BaseStorage, reopen: () => Promise<void>, directory: string) => Promise<void>) {
    const directory = fs.mkdtempSync(path.join(profile, 'case-'));
    let owner = new BaseStorage('generic-fixture', schema, directory);
    try {
        await owner.initialize();
        await run(
            () => owner,
            async () => {
                await owner.close();
                owner = new BaseStorage('generic-fixture', schema, directory);
                await owner.initialize();
            },
            directory
        );
    } finally {
        await owner.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

test('BaseStorage BM25 reopen preserves public hits, original fields, metadata, scores and per-column topK', async () => {
    await fixture(async (get, reopen) => {
        const text = 'Lifecycle Search — Mixed CASE，原文  空格!';
        await get().insert([
            item('best', text, 'Column Scope', 'first'),
            item('second', 'Lifecycle only', 'Other Heading')
        ]);
        const before = await search(get(), 'lifecycle search');
        assert.deepEqual(
            before.items.map((hit) => [hit.item.item_id, hit.BM25Score]),
            [
                ['best', 2],
                ['second', 1]
            ]
        );
        const titleBefore = await search(get(), 'scope', 'title');
        assert.equal(titleBefore.items[0].item.text, text);
        assert.equal(titleBefore.items[0].item.category, 'first');
        await reopen();
        assert.deepEqual(await search(get(), 'lifecycle search'), before);
        assert.deepEqual(await search(get(), 'scope', 'title'), titleBefore);
        assert.equal((await search(get(), 'lifecycle search', 'text', 1)).items[0].item.item_id, 'best');
        assert.equal((await search(get(), 'scope', 'text')).totalCount, 0, 'Columns must stay isolated');
    });
});

test('BaseStorage BM25 reopen restores existing IDs for insert/update and persists deletes/upserts across another reopen', async () => {
    await fixture(async (get, reopen) => {
        await get().insert([item('existing', 'Old persisted content', 'Old title'), item('deleted', 'Deleted marker')]);
        await reopen();
        await get().insert([item('existing', 'Ignored duplicate content')]);
        assert.equal((await search(get(), 'old')).items[0].item.text, 'Old persisted content');
        await get().update([item('existing', 'Fresh Updated TEXT!', 'Updated title', 'updated')]);
        assert.equal((await search(get(), 'old')).totalCount, 0);
        assert.equal((await search(get(), 'fresh')).items[0].item.category, 'updated');
        await get().delete(['deleted']);
        assert.equal((await search(get(), 'deleted')).totalCount, 0);
        await get().upsert([item('added', 'Inserted by upsert', 'New column')]);
        await reopen();
        assert.equal((await search(get(), 'deleted')).totalCount, 0);
        assert.equal((await search(get(), 'fresh')).items[0].item.text, 'Fresh Updated TEXT!');
        assert.equal((await search(get(), 'updated', 'title')).items[0].item.item_id, 'existing');
        assert.equal((await search(get(), 'upsert')).items[0].item.item_id, 'added');
    });
});

test('BaseStorage reads legacy tokenized documents without migrating or losing base fields', async () => {
    await fixture(async (get, reopen) => {
        const original = item('legacy / Mixed:ID', 'Historical TEXT — 空格!', 'Original Heading', 'historical');
        await get().upsert([original], { indexers: ['BaseIndexer'] });
        const db = (get() as any).bm25Indexer.db;
        for (const column of ['text', 'title']) {
            await db.si[column].PUT([
                {
                    _id: `${original.item_id}_${column}`,
                    item_id: original.item_id,
                    item_type: column,
                    text: db.tokenize(original[column]).join(' ')
                }
            ]);
        }
        await reopen();
        const hits = await search(get(), 'historical');
        assert.equal(hits.totalCount, 1);
        assert.equal(hits.items[0].item.text, original.text);
        assert.equal(hits.items[0].item.item_type, 'document');
        assert.equal(hits.items[0].item.category, 'historical');
        assert.equal((await search(get(), 'heading', 'title')).totalCount, 1);
        await get().update([item(original.item_id, 'Current recovered text')]);
        assert.equal((await search(get(), 'historical')).totalCount, 0);
        assert.equal((await search(get(), 'current')).totalCount, 1);
        await get().delete([original.item_id]);
        await reopen();
        assert.equal((await search(get(), 'current')).totalCount, 0);
        assert.equal((await get().getStatus()).BM25Indexer.size, 0);
    });
});

test('Node BM25 persists exact indexed source text separately from legacy tokenized text', async () => {
    const directory = fs.mkdtempSync(path.join(profile, 'direct-'));
    const file = path.join(directory, 'bm25.db');
    const raw = 'Mixed CASE，原文  空格! Lifecycle';
    let db = new BM25IndexDB(schema, file);
    try {
        await db.initialize();
        await db.insert([{ bm25_id: 'direct_text', item_id: 'direct', item_type: 'text', text: raw }]);
        const before = await db.search('lifecycle', { columnName: 'text' });
        assert.equal(before[0].text, raw);
        await db.close();
        db = new BM25IndexDB(schema, file);
        await db.initialize();
        assert.deepEqual(await db.search('lifecycle', { columnName: 'text' }), before);
        assert.deepEqual(await db.existingItemIds(['direct', 'absent']), new Set(['direct']));
    } finally {
        await db.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('a cold BM25 document read failure is reported and BaseStorage initialization can retry', async (t) => {
    await fixture(async (get, reopen) => {
        await get().insert([item('retry', 'Recoverable persisted record')]);
        const iterator = ClassicLevel.prototype.iterator;
        const failure = new Error('fixture: cold document read failure');
        let failOnce = true;
        t.mock.method(ClassicLevel.prototype, 'iterator', function (options: any) {
            if (failOnce && options?.gte?.[0] === 'DOC_RAW') {
                failOnce = false;
                throw failure;
            }
            return iterator.call(this, options);
        });
        await assert.rejects(reopen(), (error) => error === failure);
        await get().initialize();
        assert.equal((await search(get(), 'recoverable')).items[0].item.item_id, 'retry');
    });
});

test('BM25 deletes every restored document by exact identity beyond the former 100-hit limit', async () => {
    const directory = fs.mkdtempSync(path.join(profile, 'many-'));
    const file = path.join(directory, 'bm25.db');
    let db = new BM25IndexDB(schema, file);
    const id = 'arbitrary / Mixed:ID';
    try {
        await db.initialize();
        await db.insert(
            Array.from({ length: 110 }, (_, i) => ({
                bm25_id: `multiple-${i}`,
                item_id: id,
                item_type: 'text',
                text: 'Shared searchable record'
            }))
        );
        await db.close();
        db = new BM25IndexDB(schema, file);
        await db.initialize();
        assert.equal((await db.search('searchable', { columnName: 'text', topK: 200 })).length, 110);
        await db.delete([id]);
        assert.equal(await db.count(), 0);
        assert.equal((await db.search('searchable', { columnName: 'text' })).length, 0);
        assert.equal((await db.existingItemIds([id])).size, 0);
    } finally {
        await db.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('BaseStorage BM25 equal-score topK selection is deterministic across reopening', async () => {
    await fixture(async (get, reopen) => {
        await get().insert([item('z-last', 'Matching equal scores'), item('a-first', 'Matching equal scores')]);
        const before = await search(get(), 'matching', 'text', 1);
        assert.equal(before.items[0].item.item_id, 'a-first');
        await reopen();
        assert.deepEqual(await search(get(), 'matching', 'text', 1), before);
    });
});
