import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BaseStorage, ScopedSearchValidationError } from '../../../../../main/services/storage/abstract-storage.js';
import { classifyBM25Failure } from '../../../../../main/services/storage/bm25-indexer.js';
import { createBM25IndexDB, probeBM25IndexStore } from '../../../../../main/services/storage/bm25-index-db-factory.js';
import { configureOwner, holderFixture, item, schema } from './fixtures/bm25-fixture.js';
import { openBM25NativeDriver } from '../../../../../main/services/storage/bm25-index-db.js';
import { openBM25WasmDriver } from '../../../../../main/services/storage/bm25-index-db-wasm.js';
import { getStorageInitializationFailure } from '../../../../../main/services/storage/platform.js';

const readonlySchema = {
    ...schema,
    needIndexers: Object.fromEntries(
        Object.keys(schema.needIndexers).map((field) => [
            field,
            [{ indexer: 'BM25Indexer', options: { access: 'readonly' } }]
        ])
    )
};

for (const backend of ['native', 'wasm'] as const) {
    for (const state of ['uninitialized', 'indexer-closed', 'incompatible'] as const) {
        test(`R2-F1 ${backend} generic empty results still reject ${state} stores`, async () => {
            const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bm25-empty-lifecycle-'));
            const owner = new BaseStorage('empty-lifecycle', schema, directory);
            const indexer = configureOwner(owner, backend);
            try {
                if (state !== 'uninitialized') await owner.initialize();
                if (state === 'indexer-closed') await indexer.close();
                if (state === 'incompatible') indexer.db.driver.exec('PRAGMA user_version=2');
                const condition = (topK: number | undefined) => ({
                    indexer: 'BM25Indexer',
                    field: 'text',
                    operator: 'bm25_match' as const,
                    value: { query: 'alpha', topK }
                });
                const expected =
                    state === 'incompatible'
                        ? (error: any) => error.code === 'bm25_index_version_mismatch'
                        : /not initialized/;
                for (const topK of [1, 0, 0.25, -0.25, NaN, -Infinity]) {
                    await assert.rejects(owner.search([condition(topK)]), expected);
                }
                await assert.rejects(owner.search([condition(undefined)], { limit: 0 }), expected);
            } finally {
                await owner.close();
                fs.rmSync(directory, { recursive: true, force: true });
            }
        });
    }

    test(`R1-F1 ${backend} drop retains the selected store across failed probe cleanup`, async () => {
        await holderFixture(backend, async (owner, indexer) => {
            const file = indexer.db.dbPath;
            let fail = true;
            indexer.dependencies.probe = (file: string, retain: any) =>
                probeBM25IndexStore(file, retain, {
                    forceWasm: backend === 'wasm',
                    wrapDriver(driver) {
                        const close = driver.close.bind(driver);
                        driver.close = () => {
                            if (fail) throw new Error('probe close failed');
                            close();
                        };
                        return driver;
                    }
                });
            assert.equal((await owner.probeIndexers(['BM25Indexer'])).BM25Indexer?.status, 'open_failed');
            await assert.rejects(indexer.dropStorage(), /probe close failed/);
            assert.ok(fs.existsSync(file));
            fail = false;
            await indexer.dropStorage();
            assert.equal(fs.existsSync(file), false);
            await assert.rejects(indexer.initialize(), /dropped/);
        });
    });

    test(`R1-F2 ${backend} absent and empty payloads do not validate unrelated BM25 identities`, async () => {
        await holderFixture(backend, async (owner, indexer) => {
            for (const payload of [undefined, null, []]) {
                await owner.upsert([
                    { item_id: 'bad\ud800', item_type: 'memory', indexer_columns: { BM25Indexer: payload as any } }
                ]);
                assert.equal((await indexer.getInfo()).size, 0);
            }
            await owner.upsert([item('kept', 'alpha')]);
            await owner.delete(['', 'absent', '']);
            assert.equal((await owner.searchBM25('alpha', { field: 'text' }))[0].item_id, 'kept');
            await assert.rejects(indexer.upsert([item('bad\ud800', 'alpha')]), /Invalid BM25 item_id/);
        });
    });

    test(`R1-F3 ${backend} generic search preserves legacy numeric K boundaries`, async () => {
        await holderFixture(backend, async (owner) => {
            await owner.upsert(['a', 'b', 'c', 'd'].map((id) => item(id, 'alpha')));
            const condition = (topK: number) => [
                {
                    indexer: 'BM25Indexer',
                    field: 'text',
                    operator: 'bm25_match' as const,
                    value: { query: 'alpha', topK }
                }
            ];
            for (const [k, count] of [
                [0, 0],
                [0.5, 1],
                [1.5, 2],
                [-1, 1],
                [NaN, 0],
                [Infinity, 4],
                [-Infinity, 0]
            ]) {
                assert.equal((await owner.search(condition(k))).items.length, count, `K=${k}`);
            }
            assert.deepEqual(
                (await owner.search([{ ...condition(1)[0], value: { query: 'alpha' } }], { limit: 0 })).items,
                []
            );
            await assert.rejects(owner.searchBM25('alpha', { field: 'text', topK: 0 }));
        });
    });

    test(`R1-F4 ${backend} readonly holder distinguishes missing and uninitialized without creating`, async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bm25-readonly-'));
        const owner = new BaseStorage('readonly', readonlySchema, directory);
        const indexer = configureOwner(owner, backend);
        const file = path.join(directory, backend === 'native' ? 'bm25-index.db' : 'bm25-index.wasm.db');
        try {
            await assert.rejects(owner.initialize(), (error) => classifyBM25Failure(error).reason === 'missing');
            assert.equal(fs.existsSync(file), false);
            fs.writeFileSync(file, '');
            await assert.rejects(owner.initialize(), (error) => classifyBM25Failure(error).reason === 'uninitialized');
            assert.equal(fs.statSync(file).size, 0);
            assert.equal(indexer.db, null);
        } finally {
            await owner.close();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    test(`R1-F5 ${backend} scope validation consistently uses the public validation error`, async () => {
        await holderFixture(backend, async (owner) => {
            for (const [field, topK] of [
                ['text', 0],
                ['text', 1.5],
                ['unbound', 1]
            ] as const) {
                await assert.rejects(
                    owner.searchScope({
                        preconditions: [{ indexer: 'BaseIndexer', field: 'category', operator: '=', value: 'kept' }],
                        targetCondition: {
                            indexer: 'BM25Indexer',
                            field,
                            operator: 'bm25_match',
                            value: { query: '', topK }
                        }
                    }),
                    ScopedSearchValidationError
                );
            }
        });
    });

    test(`R1-F7 ${backend} real readonly holder permits scope but rejects writes and drop`, async () => {
        await holderFixture(backend, async (writer, indexer, directory) => {
            await writer.upsert([item('kept', 'alpha')]);
            const file = indexer.db.dbPath;
            await writer.close();
            const before = fs.readFileSync(file);
            const reader = new BaseStorage('reader', readonlySchema, directory);
            const readonlyIndexer = configureOwner(reader, backend);
            try {
                await reader.initialize();
                assert.equal(
                    (
                        await reader.searchScope({
                            preconditions: [
                                { indexer: 'BaseIndexer', field: 'category', operator: '=', value: 'kept' }
                            ],
                            targetCondition: {
                                indexer: 'BM25Indexer',
                                field: 'text',
                                operator: 'bm25_match',
                                value: { query: 'alpha' }
                            }
                        })
                    ).items.length,
                    1
                );
                for (const operation of ['insert', 'update', 'upsert'] as const) {
                    const writing =
                        operation === 'insert'
                            ? reader.insert([item('new', 'beta')])
                            : reader[operation]([item('kept', 'beta')], { indexers: ['BM25Indexer'] });
                    await assert.rejects(writing, /readonly/);
                }
                await assert.rejects(readonlyIndexer.delete(['kept']), /readonly/);
                await assert.rejects(readonlyIndexer.clear(), /readonly/);
                await assert.rejects(reader.dropIndexers(['BM25Indexer']), /readonly/);
            } finally {
                await reader.close();
            }
            assert.deepEqual(fs.readFileSync(file), before);
        });
    });

    test(`R1-F7 ${backend} initialization cleanup failure retains ownership and prevents fallback`, async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bm25-init-cleanup-'));
        const owner = new BaseStorage('cleanup', schema, directory);
        const indexer = configureOwner(owner, backend);
        let failClose = true,
            closes = 0,
            opens = 0;
        indexer.dependencies.database = (s: any, file: string, access: any, retain: any) =>
            createBM25IndexDB(s, file, access, retain, {
                forceWasm: backend === 'wasm',
                wrapDriver(driver) {
                    opens++;
                    const exec = driver.exec.bind(driver),
                        close = driver.close.bind(driver);
                    driver.exec = (sql) => {
                        if (sql.startsWith('CREATE TABLE'))
                            throw Object.assign(new Error('better_sqlite3.node delayed fixture'), {
                                code: 'MODULE_NOT_FOUND'
                            });
                        exec(sql);
                    };
                    driver.close = () => {
                        if (failClose) throw new Error('init cleanup failed');
                        close();
                        closes++;
                    };
                    return driver;
                }
            });
        try {
            await assert.rejects(owner.initialize(), (error) => {
                assert.ok(getStorageInitializationFailure(error)?.cleanupFailures.length);
                return true;
            });
            assert.equal(opens, 1);
            assert.equal(indexer.initializationCleanup.length, 1);
            await assert.rejects(owner.close(), /cleanup failed/);
            failClose = false;
            await owner.close();
            assert.equal(closes, 1);
            assert.equal(indexer.initializationCleanup.length, 0);
        } finally {
            failClose = false;
            await owner.close();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    test(`R1-F7 ${backend} partial physical deletion preserves backend and retries`, async (t) => {
        await holderFixture(backend, async (_owner, indexer) => {
            const db = indexer.db,
                file = db.dbPath,
                rm = fs.rmSync;
            let fail = true;
            t.mock.method(fs, 'rmSync', ((target: fs.PathLike, options: any) => {
                if (String(target) === `${file}-journal` && fail) throw new Error('journal deletion failed');
                return rm(target, options);
            }) as typeof fs.rmSync);
            await assert.rejects(indexer.dropStorage(), /journal deletion failed/);
            assert.equal(fs.existsSync(file), false);
            assert.equal(indexer.dropPending, db);
            await assert.rejects(indexer.initialize(), /partially dropped/);
            fail = false;
            await indexer.dropStorage();
            assert.equal(indexer.dropPending, null);
            await assert.rejects(indexer.initialize(), /dropped/);
        });
    });

    test(`R1-F7 ${backend} concurrent initialize opens once and rechecks after probe`, async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bm25-concurrent-'));
        const owner = new BaseStorage('concurrent', schema, directory);
        const indexer = configureOwner(owner, backend),
            open = indexer.dependencies.database;
        let release!: () => void,
            opens = 0;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        indexer.dependencies.database = async (...args: any[]) => {
            opens++;
            await gate;
            return open(...args);
        };
        try {
            const first = indexer.initialize(),
                second = indexer.initialize();
            release();
            await Promise.all([first, second]);
            assert.equal(opens, 1);
            await indexer.close();
            assert.equal((await indexer.probeBM25Store()).status, 'exists');
            const file = path.join(directory, backend === 'native' ? 'bm25-index.db' : 'bm25-index.wasm.db');
            const edit =
                backend === 'native' ? openBM25NativeDriver(file, 'readwrite') : openBM25WasmDriver(file, 'readwrite');
            edit.exec('PRAGMA user_version=2');
            edit.close();
            await assert.rejects(indexer.initialize(), (error: any) => error.code === 'bm25_index_version_mismatch');
        } finally {
            release();
            await owner.close();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    test(`R1-F7 ${backend} valid empty SQLite file stays uninitialized readonly then creates on retry`, async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bm25-valid-empty-'));
        const owner = new BaseStorage('empty', readonlySchema, directory);
        const indexer = configureOwner(owner, backend);
        const file = path.join(directory, backend === 'native' ? 'bm25-index.db' : 'bm25-index.wasm.db');
        const empty =
            backend === 'native' ? openBM25NativeDriver(file, 'readwrite') : openBM25WasmDriver(file, 'readwrite');
        empty.exec('VACUUM');
        empty.close();
        const before = fs.readFileSync(file);
        assert.ok(before.length > 0);
        try {
            assert.equal((await indexer.probeBM25Store()).status, 'uninitialized');
            await assert.rejects(owner.initialize(), (error) => classifyBM25Failure(error).reason === 'uninitialized');
            assert.deepEqual(fs.readFileSync(file), before);
            const write = await createBM25IndexDB(
                schema,
                path.join(directory, 'bm25-index.db'),
                'readwrite',
                () => assert.fail('cleanup'),
                { forceWasm: backend === 'wasm' }
            );
            write.close();
            await owner.initialize();
            assert.equal((await indexer.getInfo()).size, 0);
        } finally {
            await owner.close();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    test(`R1-O1 ${backend} opening compatible DB avoids a write transaction`, async () => {
        await holderFixture(backend, async (_owner, indexer, directory) => {
            const retained: Array<{ close: () => void | Promise<void> }> = [];
            // Native WAL permits the simultaneous reader; the WASM VFS only promises serial holders.
            if (backend === 'native') indexer.db.driver.exec('BEGIN IMMEDIATE');
            try {
                const other = await createBM25IndexDB(
                    schema,
                    path.join(directory, 'bm25-index.db'),
                    'readwrite',
                    (cleanup) => retained.push(cleanup),
                    {
                        forceWasm: backend === 'wasm',
                        wrapDriver(driver) {
                            const exec = driver.exec.bind(driver);
                            driver.exec = (sql) => {
                                assert.notEqual(sql, 'BEGIN IMMEDIATE');
                                exec(sql);
                            };
                            return driver;
                        }
                    }
                );
                other.close();
            } finally {
                if (backend === 'native') indexer.db.driver.exec('ROLLBACK');
                for (const cleanup of retained) await cleanup.close();
            }
        });
    });
}

test('R1-F7 native creation rechecks inside write transaction after gated competing creator', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bm25-create-gate-'));
    let gated = false;
    try {
        const db = await createBM25IndexDB(
            schema,
            path.join(directory, 'bm25.db'),
            'readwrite',
            () => assert.fail('cleanup'),
            {
                forceWasm: false,
                wrapDriver(driver) {
                    const exec = driver.exec.bind(driver);
                    driver.exec = (sql) => {
                        if (!gated && sql === 'BEGIN IMMEDIATE') {
                            gated = true;
                            const result = spawnSync(
                                process.execPath,
                                [
                                    '--import',
                                    'tsx',
                                    '--import',
                                    './src/tests/test-env.ts',
                                    'src/tests/ut/node/services/storage/fixtures/bm25-process.ts',
                                    'create-populate',
                                    directory
                                ],
                                { encoding: 'utf8', timeout: 20000 }
                            );
                            assert.equal(result.status, 0, result.stderr);
                        }
                        exec(sql);
                    };
                    return driver;
                }
            }
        );
        try {
            assert.equal(gated, true);
            assert.equal(db.count(), 1);
        } finally {
            db.close();
        }
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('R1-O2 extended busy and locked codes stay distinct from unknown', () => {
    for (const code of ['SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_LOCKED_SHAREDCACHE'])
        assert.equal(classifyBM25Failure(Object.assign(new Error('fixture'), { code })).reason, 'busy');
});
