import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BaseStorage, type ColumnSchema } from '../../../../../main/services/storage/abstract-storage.js';
import { BM25IndexDB } from '../../../../../main/services/storage/bm25-index-db.js';
import { setCustomOpendeskDirectory } from '../../../../../main/utils/setting.js';

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bm25-lifecycle-'));
setCustomOpendeskDirectory(profile);
after(() => fs.rmSync(profile, { recursive: true, force: true }));
const schema: ColumnSchema = {
    columns: {
        item_id: { type: 'TEXT', nullable: false },
        item_type: { type: 'TEXT', nullable: false },
        text: { type: 'TEXT' }
    },
    needIndexers: { text: [{ indexer: 'BM25Indexer' }] }
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((yes) => {
        resolve = yes;
    });
    return { promise, resolve };
}
async function fixture(run: (owner: BaseStorage, db: any, index: any, directory: string) => Promise<void>) {
    const directory = fs.mkdtempSync(path.join(profile, 'case-'));
    const owner = new BaseStorage('generic-fixture', schema, directory);
    await owner.initialize();
    const db = (owner as any).bm25Indexer.db;
    const index = db.si.text;
    try {
        await run(owner, db, index, directory);
    } finally {
        await owner.close();
    }
}

test('BaseStorage close awaits a real BM25 release and rejects new operations', async (t) => {
    await fixture(async (owner, db, index) => {
        const gate = deferred();
        const store = index.INDEX.STORE;
        const close = store.close.bind(store);
        let entered = false,
            closed = false;
        t.mock.method(store, 'close', async () => {
            entered = true;
            await gate.promise;
            await close();
        });
        const release = owner.close().then(() => {
            closed = true;
        });
        try {
            await tick();
            assert.equal(entered, true);
            assert.equal(closed, false);
            assert.equal((owner as any).bm25Indexer.db, db);
            await assert.rejects(owner.search([]), /closing or closed/);
        } finally {
            gate.resolve();
            await release;
        }
        assert.equal(store.status, 'closed');
        assert.equal((owner as any).bm25Indexer.db, null);
    });
});

test('BM25 close drains an accepted write without clearing committed records', async (t) => {
    await fixture(async (owner, db, index, directory) => {
        const gate = deferred();
        const put = index.PUT.bind(index);
        let entered = false;
        t.mock.method(index, 'PUT', async (...args: any[]) => {
            entered = true;
            await gate.promise;
            return put(...args);
        });
        t.mock.method(index, 'FLUSH', () => {
            throw new Error('FLUSH must never run during persistence/release');
        });
        const write = owner.upsert([
            {
                item_id: 'persisted',
                item_type: 'document',
                text: 'persistent text',
                indexer_columns: { BM25Indexer: [{ column: 'text', content: 'persistent text' }] }
            }
        ]);
        while (!entered) await tick();
        let closed = false;
        const release = owner.close().then(() => {
            closed = true;
        });
        try {
            await tick();
            assert.equal(closed, false);
        } finally {
            gate.resolve();
            await write;
            await release;
        }
        assert.equal(index.INDEX.STORE.status, 'closed');
        const reopened: any = new BM25IndexDB(schema, path.join(directory, 'bm25-index.db'));
        try {
            await reopened.initialize();
            assert.equal(await reopened.si.text.DOCUMENT_COUNT(), 1);
            assert.equal((await reopened.search('persistent', { columnName: 'text' }))[0].text, 'persistent text');
        } finally {
            await reopened.close();
        }
    });
});

test('BM25 release failure propagates through BaseStorage and retains the retryable holder', async (t) => {
    await fixture(async (owner, db, index) => {
        const failure = new Error('isolated LevelDB release failure');
        const store = index.INDEX.STORE;
        const close = store.close.bind(store);
        let attempts = 0;
        t.mock.method(store, 'close', async () => {
            if (++attempts === 1) throw failure;
            await close();
        });
        await assert.rejects(owner.close(), (error) => error === failure);
        assert.equal((owner as any).bm25Indexer.db, db);
        assert.equal(store.status, 'open');
        await owner.close();
        assert.equal(attempts, 2);
        assert.equal(store.status, 'closed');
        await owner.close();
        assert.equal(attempts, 2);
    });
});

test('BM25 drop preserves files after failed close and deletes only after successful retry', async (t) => {
    const directory = fs.mkdtempSync(path.join(profile, 'drop-'));
    const file = path.join(directory, 'bm25.db');
    const db: any = new BM25IndexDB(schema, file);
    await db.initialize();
    const store = db.si.text.INDEX.STORE;
    const close = store.close.bind(store);
    let attempts = 0;
    t.mock.method(store, 'close', async () => {
        if (++attempts === 1) throw new Error('isolated drop close failure');
        await close();
    });
    try {
        await assert.rejects(db.dropStorage(), /isolated drop close failure/);
        assert.equal(fs.existsSync(file + '-text'), true);
        await db.dropStorage();
        assert.equal(store.status, 'closed');
        assert.equal(fs.existsSync(file + '-text'), false);
    } finally {
        await db.close();
    }
});

test('BM25 partial close releases other columns and retries only failed connections', async (t) => {
    const columns = { ...schema.columns, other: { type: 'TEXT' as const } };
    const multi = { columns, needIndexers: { ...schema.needIndexers, other: [{ indexer: 'BM25Indexer' }] } };
    const db: any = new BM25IndexDB(multi, path.join(profile, 'multi.db'));
    await db.initialize();
    const first = db.si.text.INDEX.STORE,
        second = db.si.other.INDEX.STORE;
    const close = first.close.bind(first);
    let attempts = 0;
    t.mock.method(first, 'close', async () => {
        if (++attempts === 1) throw new Error('isolated first-column failure');
        await close();
    });
    try {
        await assert.rejects(db.close(), /first-column failure/);
        assert.equal(second.status, 'closed');
        assert.deepEqual(Object.keys(db.si), ['text']);
        await db.close();
        assert.equal(first.status, 'closed');
        assert.equal(db.si, null);
    } finally {
        await db.close();
    }
});

test('BM25 initialization cancelled by close never acquires a later column', async (t) => {
    const db: any = new BM25IndexDB(schema, path.join(profile, 'cancel.db'));
    const gate = deferred();
    const initialize = db.initializeStores.bind(db);
    t.mock.method(db, 'initializeStores', async () => {
        await gate.promise;
        await initialize();
    });
    const started = db.initialize();
    const rejected = assert.rejects(started, /closing or closed/);
    const closed = db.close();
    gate.resolve();
    await Promise.all([rejected, closed]);
    assert.equal(db.si, null);
    assert.equal(fs.existsSync(path.join(profile, 'cancel.db-text')), false);
});
