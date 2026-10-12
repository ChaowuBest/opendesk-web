import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setCustomOpendeskDirectory } from '../../../../../main/utils/setting.js';
import type { ColumnSchema } from '../../../../../main/services/storage/abstract-storage.js';

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'base-index-wasm-'));
setCustomOpendeskDirectory(profile);
after(() => fs.rmSync(profile, { recursive: true, force: true }));

const require = createRequire(import.meta.url);
const sqliteWasm = require('node-sqlite3-wasm');
const RealWasmDatabase = sqliteWasm.Database;
const NativeDatabase = require('better-sqlite3');
const { BaseIndexDBWasm, probeBaseIndexStoreWasm } =
    await import('../../../../../main/services/storage/base-index-db-wasm.js');
const schema: ColumnSchema = {
    columns: {
        item_id: { type: 'TEXT', nullable: false },
        item_type: { type: 'TEXT', nullable: false }
    },
    needIndexers: {}
};

for (const failureStage of ['journal', 'timeout', 'table', 'columns']) {
    for (const closeFails of [false, true]) {
        test(`WASM ${failureStage} failure closes connection and preserves error; close fails=${closeFails}`, () => {
            let closeCalls = 0;
            const originalError = new Error('synthetic initialization failure');
            sqliteWasm.Database = class {
                run(sql: string) {
                    if (
                        (failureStage === 'journal' && sql.includes('journal_mode')) ||
                        (failureStage === 'timeout' && sql.includes('busy_timeout')) ||
                        (failureStage === 'table' && sql.includes('CREATE TABLE'))
                    )
                        throw originalError;
                }
                all() {
                    if (failureStage === 'columns') throw originalError;
                    return Object.keys(schema.columns).map((name) => ({ name }));
                }
                close() {
                    closeCalls++;
                    if (closeFails) throw new Error('synthetic close failure');
                }
            };
            try {
                assert.throws(
                    () => new BaseIndexDBWasm(path.join(profile, 'failure.db'), schema),
                    (error: unknown) => error === originalError
                );
                assert.equal(closeCalls, 1);
            } finally {
                sqliteWasm.Database = RealWasmDatabase;
            }
        });
    }
}

test('WASM create, probe, reopen and drop leave the native WAL database untouched', async () => {
    const dbPath = path.join(profile, '隔离 space', 'base-index.db');
    const wasmPath = path.join(path.dirname(dbPath), 'base-index.wasm.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const native = new NativeDatabase(dbPath);
    native.pragma('journal_mode = WAL');
    native.exec('CREATE TABLE base_index (item_id TEXT PRIMARY KEY, item_type TEXT NOT NULL)');
    native.prepare('INSERT INTO base_index VALUES (?, ?)').run('native-only', 'file');
    native.close();
    const original = fs.readFileSync(dbPath);
    assert.equal(original[18], 2);
    assert.equal(original[19], 2);
    assert.equal(probeBaseIndexStoreWasm(dbPath), 'missing');
    assert.equal(fs.existsSync(wasmPath), false, 'probing must not create a file');

    let wasm: InstanceType<typeof BaseIndexDBWasm> | null = new BaseIndexDBWasm(dbPath, schema);
    try {
        assert.equal(fs.existsSync(wasmPath), true);
        assert.equal(await wasm.findById('native-only'), undefined);
        await wasm.insert({ item_id: 'wasm-only', item_type: 'file' });
        wasm.close();
        wasm = null;
        assert.equal(probeBaseIndexStoreWasm(dbPath), 'exists');
        assert.equal(probeBaseIndexStoreWasm(wasmPath), 'exists');
        wasm = new BaseIndexDBWasm(wasmPath, schema);
        assert.equal((await wasm.findById('wasm-only'))?.item_type, 'file');
        assert.equal(fs.existsSync(wasmPath.replace('.wasm.db', '.wasm.wasm.db')), false);
        await wasm.dropStorage();
        wasm = null;
        assert.equal(probeBaseIndexStoreWasm(dbPath), 'missing');
        assert.equal(fs.existsSync(wasmPath), false);
        assert.deepEqual(fs.readFileSync(dbPath), original);
    } finally {
        wasm?.close();
    }
});

test('WASM WAL compatibility probes and opens only its own file, preserving the native WAL header', async () => {
    const dbPath = path.join(profile, 'wal-compat', 'base-index.db');
    const wasmPath = path.join(path.dirname(dbPath), 'base-index.wasm.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    for (const [file, id] of [
        [dbPath, 'native-only'],
        [wasmPath, 'wasm-only']
    ]) {
        const db = new NativeDatabase(file);
        try {
            db.pragma('journal_mode = WAL');
            db.exec('CREATE TABLE base_index (item_id TEXT PRIMARY KEY, item_type TEXT NOT NULL)');
            db.prepare('INSERT INTO base_index VALUES (?, ?)').run(id, 'file');
        } finally {
            db.close();
        }
    }
    const nativeBefore = fs.readFileSync(dbPath);
    assert.deepEqual([...nativeBefore.subarray(18, 20)], [2, 2]);
    assert.deepEqual([...fs.readFileSync(wasmPath).subarray(18, 20)], [2, 2]);
    assert.equal(probeBaseIndexStoreWasm(dbPath), 'exists');
    assert.deepEqual([...fs.readFileSync(wasmPath).subarray(18, 20)], [1, 1]);
    assert.deepEqual(fs.readFileSync(dbPath), nativeBefore);

    const fixture = new NativeDatabase(wasmPath);
    try {
        fixture.pragma('journal_mode = WAL');
    } finally {
        fixture.close();
    }
    assert.deepEqual([...fs.readFileSync(wasmPath).subarray(18, 20)], [2, 2]);
    const wasm = new BaseIndexDBWasm(dbPath, schema);
    try {
        assert.equal((await wasm.findById('wasm-only'))?.item_type, 'file');
        assert.equal(await wasm.findById('native-only'), undefined);
        assert.deepEqual([...fs.readFileSync(wasmPath).subarray(18, 20)], [1, 1]);
        assert.deepEqual(fs.readFileSync(dbPath), nativeBefore);
    } finally {
        wasm.close();
    }
});

test('successful WASM initialization keeps its connection open for queries', async () => {
    const db = new BaseIndexDBWasm(path.join(profile, 'success.db'), schema);
    try {
        await db.insert({ item_id: 'ok', item_type: 'file' });
        assert.equal((await db.findById('ok'))?.item_type, 'file');
    } finally {
        db.close();
    }
});

for (const kind of ['base', 'vector', 'chunk']) {
    test(`${kind}: failed WASM close remains retryable and successful close is idempotent`, async () => {
        const { VectorIndexDBWasm } = await import('../../../../../main/services/storage/vector-index-db-wasm.js');
        const { ChunkIndexDBWasm } = await import('../../../../../main/services/storage/chunk-index-db-wasm.js');
        const db =
            kind === 'base'
                ? new BaseIndexDBWasm(path.join(profile, `${kind}-close.db`), schema)
                : kind === 'vector'
                  ? new VectorIndexDBWasm(path.join(profile, `${kind}-close.db`), 2)
                  : new ChunkIndexDBWasm(path.join(profile, `${kind}-close.db`), 2);
        await db.count();
        const raw = (db as any).db;
        const close = raw.close.bind(raw);
        const failure = new Error('fixture: transient physical close failure');
        let calls = 0;
        raw.close = () => {
            calls++;
            if (calls === 1) throw failure;
            close();
        };
        try {
            assert.throws(
                () => db.close(),
                (error) => error === failure
            );
            db.close();
            db.close();
            assert.equal(calls, 2, 'Failure must retry; success must not close a second time');
            assert.throws(() => raw.run('SELECT 1'), /closed/i, 'Retry must really close the physical connection');
        } finally {
            raw.close = close;
            db.close();
        }
    });
}

test('WASM BaseStorage can drop every indexer then close without retaining a closed base holder', async () => {
    const { BaseStorage } = await import('../../../../../main/services/storage/abstract-storage.js');
    const genericSchema: ColumnSchema = {
        columns: { ...schema.columns, caption: { type: 'TEXT' }, content: { type: 'TEXT' } },
        needIndexers: {
            caption: [{ indexer: 'VectorIndexer', options: { dim: 2 } }],
            content: [{ indexer: 'ChunkIndexer', options: { dim: 2 } }]
        }
    };
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const available = process.env.ARKDATA_AVAILABLE;
    Object.defineProperty(process, 'platform', { value: 'openharmony' });
    process.env.ARKDATA_AVAILABLE = '0';
    const storage = new BaseStorage('fixture', genericSchema, path.join(profile, 'drop-all'));
    try {
        await storage.initialize();
        await storage.dropIndexers(['BaseIndexer', 'VectorIndexer', 'ChunkIndexer']);
        await storage.close();
        await storage.close();
        assert.equal((storage.baseIndexer as any).db, null);
        assert.equal((storage.vectorIndexer as any).db, null);
        assert.equal((storage.chunkIndexer as any).db, null);
    } finally {
        try {
            await storage.close();
        } finally {
            Object.defineProperty(process, 'platform', platform);
            if (available === undefined) delete process.env.ARKDATA_AVAILABLE;
            else process.env.ARKDATA_AVAILABLE = available;
        }
    }
});
