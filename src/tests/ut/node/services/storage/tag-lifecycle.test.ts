import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TagIndexer } from '../../../../../main/services/storage/tag-indexer.js';
import { TagIndexDBWasm } from '../../../../../main/services/storage/tag-index-db-wasm.js';
import { BM25IndexDBWasm } from '../../../../../main/services/storage/bm25-index-db-wasm.js';

// This drop/cleanup gap exists in the fixed baseline too. The shared lifecycle
// contract requires preserving the holder; there is no FileMgr/Tag business change.
test('Tag drop preserves its original error and a failed release holder for retry', async () => {
    const owner: any = new TagIndexer(
        { columns: {}, needIndexers: { tag: [{ indexer: 'TagIndexer' }] } },
        '/isolated-tag.db'
    );
    const failure = new Error('isolated drop failure');
    let closes = 0;
    const db = {
        dropStorage: async () => {
            throw failure;
        },
        close: async () => {
            if (++closes === 1) throw new Error('isolated release failure');
        }
    };
    owner.db = db;
    await assert.rejects(owner.dropStorage(), (error) => error === failure);
    assert.equal(owner.db, db);
    await owner.close();
    assert.equal(owner.db, null);
    assert.equal(closes, 2);
    await owner.close();
    assert.equal(closes, 2);
});

for (const [name, Class] of [
    ['Tag', TagIndexDBWasm],
    ['BM25', BM25IndexDBWasm]
] as const) {
    test(`${name} WASM closes retry failure and do not close a released connection twice`, () => {
        let attempts = 0;
        const db: any = Object.assign(Object.create(Class.prototype), {
            db: {
                close() {
                    if (++attempts === 1) throw new Error('isolated close failure');
                }
            }
        });
        assert.throws(() => db.close(), /isolated close failure/);
        db.close();
        db.close();
        assert.equal(attempts, 2);
    });
}
