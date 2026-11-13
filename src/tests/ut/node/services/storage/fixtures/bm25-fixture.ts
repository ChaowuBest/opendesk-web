import fs from 'node:fs';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {
    BM25StatsStore,
    type BM25DriverBackend,
    type BM25Driver,
    type BM25IndexBackend,
    type BM25PreparedRecord
} from '../../../../../../main/services/storage/bm25-stats-store.js';
import { BaseStorage, type ColumnSchema, type Item } from '../../../../../../main/services/storage/abstract-storage.js';
import {
    createBM25IndexDB,
    probeBM25IndexStore
} from '../../../../../../main/services/storage/bm25-index-db-factory.js';
import { createBM25Tokenizer } from '../../../../../../main/services/storage/bm25-tokenizer.js';
import { openBM25NativeDriver } from '../../../../../../main/services/storage/bm25-index-db.js';
import { openBM25WasmDriver } from '../../../../../../main/services/storage/bm25-index-db-wasm.js';

export function driver(backend: BM25DriverBackend, filename: string, readonly = false): BM25Driver {
    const access = readonly ? 'readonly' : 'readwrite';
    return backend === 'native' ? openBM25NativeDriver(filename, access) : openBM25WasmDriver(filename, access);
}
export async function storeFixture(
    backend: BM25DriverBackend,
    run: (store: BM25StatsStore, directory: string) => void | Promise<void>
) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bm25-stats-'));
    const store = new BM25StatsStore(driver(backend, path.join(directory, 'bm25.db')), path.join(directory, 'bm25.db'));
    try {
        store.initialize();
        await run(store, directory);
    } finally {
        store.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
}
export function record(item_id: string, text: string, field = 'text', subKey = ''): BM25PreparedRecord {
    const terms = new Map<string, number>();
    const tokens = text.split(/\s+/).filter(Boolean);
    for (const token of tokens) terms.set(token, (terms.get(token) ?? 0) + 1);
    return { item_id, field, subKey, terms, len: tokens.length };
}
export function rows(store: BM25StatsStore, sql: string) {
    const stmt = store.driver.prepare(sql);
    try {
        return stmt.all([]);
    } finally {
        stmt.finalize();
    }
}
export function snapshot(store: BM25StatsStore) {
    return Object.fromEntries(
        ['terms', 'records', 'postings', 'field_stats'].map((table) => [
            table,
            rows(store, `SELECT * FROM ${table} ORDER BY 1,2`)
        ])
    );
}

export const schema: ColumnSchema = {
    columns: {
        item_id: { type: 'TEXT', nullable: false },
        item_type: { type: 'TEXT', nullable: false },
        text: { type: 'TEXT', nullable: true },
        title: { type: 'TEXT', nullable: true },
        category: { type: 'TEXT', nullable: true },
        tag: { type: 'TEXT', nullable: true }
    },
    needIndexers: { text: [{ indexer: 'BM25Indexer' }], title: [{ indexer: 'BM25Indexer' }] }
};
export function item(id: string, text: string, subKey = '', field = 'text'): Item {
    return {
        item_id: id,
        item_type: 'memory',
        text: `Base ${id}`,
        category: 'kept',
        indexer_columns: { BM25Indexer: [{ column: field, content: text, id: subKey }] }
    };
}
export function configureOwner(owner: BaseStorage, backend: BM25DriverBackend) {
    const indexer = (owner as any).bm25Indexer;
    indexer.dependencies.database = (schema: any, file: string, access: any, retain: any) =>
        createBM25IndexDB(schema, file, access, retain, { forceWasm: backend === 'wasm' });
    indexer.dependencies.probe = (file: string, retain: any) =>
        probeBM25IndexStore(file, retain, { forceWasm: backend === 'wasm' });
    indexer.dependencies.tokenizer = () => createBM25Tokenizer({ forceWasm: backend === 'wasm' });
    return indexer;
}
export async function holderFixture(
    backend: BM25DriverBackend,
    run: (owner: BaseStorage, indexer: any, directory: string) => Promise<void>,
    config = schema
) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bm25-holder-'));
    const owner = new BaseStorage('bm25-fixture', config, directory);
    const indexer = configureOwner(owner, backend);
    try {
        await owner.initialize();
        await run(owner, indexer, directory);
    } finally {
        await owner.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

/** The same prepared-data contract runs against every backend; it does not model production SQL. */
export async function assertBM25BackendContract(
    store: BM25IndexBackend,
    readTerms: () => Promise<string[]>,
    version: number
) {
    await store.insert([record('a', 'shared one'), record('b', 'shared shared two'), record('a', 'ignored')]);
    assert.deepEqual(await readTerms(), ['one', 'shared', 'two']);
    await store.update([record('a', ''), record('a', 'shared final'), record('missing', 'discarded')]);
    assert.deepEqual(await readTerms(), ['final', 'shared', 'two']);
    await store.upsert([
        record('c', 'shared'),
        record('c', ''),
        record('c', 'three'),
        record('a', 'title', 'title', 'sub')
    ]);
    const info = await store.getInfo();
    assert.equal(info.indexVersion, version);
    assert.equal(info.size, 4);
    assert.deepEqual(info.fields.text, { n: 3, sum_len: 6 });
    assert.deepEqual(info.fields.title, { n: 1, sum_len: 1 });
    const hits = await store.search(['shared', 'shared'], {
        field: 'text',
        allowedItemIds: ['a', 'b', 'c', 'a'],
        topK: 5
    });
    assert.deepEqual(
        hits.map((hit) => hit.item_id),
        ['b', 'a']
    );
    const expectedIdf = Math.log(1 + (3 - 2 + 0.5) / (2 + 0.5));
    assert.ok(Math.abs(hits[0].score - (expectedIdf * (2 * 2.2)) / (2 + 1.2 * (0.25 + (0.75 * 3) / 2))) < 1e-12);
    await store.delete(['b', 'b']);
    assert.deepEqual(await readTerms(), ['final', 'shared', 'three', 'title']);
    await store.insert([]);
    await store.update([]);
    await store.upsert([]);
    await store.delete([]);
    assert.equal((await store.getInfo()).size, 3);
    await store.clear();
    assert.equal((await store.getInfo()).size, 0);
    assert.equal((await store.getInfo()).indexVersion, version);
    assert.deepEqual(await readTerms(), []);
}
