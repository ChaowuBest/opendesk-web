import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { BaseStorage } from '../../../../../main/services/storage/abstract-storage.js';
import { configureOwner, holderFixture, item, schema, record, driver, snapshot } from './fixtures/bm25-fixture.js';
import {
    createBM25IndexDB,
    probeBM25IndexStore,
    dropBM25IndexStore
} from '../../../../../main/services/storage/bm25-index-db-factory.js';
import { createBM25Tokenizer } from '../../../../../main/services/storage/bm25-tokenizer.js';
import { getStorageInitializationFailure } from '../../../../../main/services/storage/platform.js';
import { classifyBM25Failure } from '../../../../../main/services/storage/bm25-indexer.js';
import { BM25StatsStore } from '../../../../../main/services/storage/bm25-stats-store.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((yes) => {
        resolve = yes;
    });
    return { promise, resolve };
}

test('A1 Indexer awaits asynchronous tokenize/write/info and retains failed drop for retry', async () => {
    await holderFixture('native', async (_owner, indexer) => {
        const db = indexer.db;
        const gate = deferred();
        const failure = new Error('asynchronous write rejected');
        let settled = false;
        const delayedWrite = gate.promise.then(() => {
            throw failure;
        });
        void delayedWrite.catch(() => {});
        db.upsert = () => delayedWrite;
        const writing = indexer.upsert([item('a', 'alpha')]);
        void writing.then(
            () => {
                settled = true;
            },
            () => {
                settled = true;
            }
        );
        // Attach before releasing to keep the expected rejection observed.
        const rejected = assert.rejects(writing, (error) => error === failure);
        await tick();
        const early = settled;
        gate.resolve();
        await rejected;
        assert.equal(early, false, 'write must not resolve before the backend settles');

        const getInfo = db.getInfo.bind(db);
        db.getInfo = async () => getInfo();
        assert.equal((await indexer.getInfo()).size, 0);
        const tokenize = indexer.tokenizer.tokenize.bind(indexer.tokenizer);
        indexer.tokenizer.tokenize = async (text: string) => tokenize(text);
        assert.deepEqual(await indexer.searchHits('alpha', { field: 'text' }), []);

        const drop = db.dropStorage.bind(db);
        let attempts = 0;
        db.dropStorage = async () => {
            if (++attempts === 1) throw failure;
            drop();
        };
        await assert.rejects(indexer.dropStorage(), (error) => error === failure);
        assert.equal(indexer.dropPending, db, 'failed deletion must retain its owner');
        assert.equal(indexer.isDropped, false);
        await indexer.dropStorage();
        assert.equal(attempts, 2);
        assert.equal(indexer.dropPending, null);
    });
});
for (const backend of ['native', 'wasm'] as const) {
    test(`B12 ${backend} holder close awaits real release and rejects new operations`, async () => {
        await holderFixture(backend, async (owner, indexer) => {
            const db = indexer.db;
            const close = db.close.bind(db);
            const gate = deferred();
            let entered = false,
                closed = false;
            db.close = async () => {
                entered = true;
                await gate.promise;
                close();
            };
            const closing = owner.close().then(() => {
                closed = true;
            });
            try {
                await tick();
                assert.equal(entered, true);
                assert.equal(closed, false);
                assert.equal(indexer.db, db);
                await assert.rejects(owner.search([]), /closing or closed/);
            } finally {
                gate.resolve();
                await closing;
            }
            assert.equal(indexer.db, null);
        });
    });
    test(`B12 ${backend} close drains accepted write preparation and preserves committed records`, async () => {
        await holderFixture(backend, async (owner, indexer, directory) => {
            const prepare = indexer.dependencies.prepare;
            const gate = deferred();
            let entered = false,
                closed = false;
            indexer.dependencies.prepare = async (...args: any[]) => {
                entered = true;
                await gate.promise;
                return prepare(...args);
            };
            const writing = owner.upsert([item('persisted', 'persistent text')]);
            while (!entered) await tick();
            const closing = owner.close().then(() => {
                closed = true;
            });
            try {
                await tick();
                assert.equal(closed, false);
            } finally {
                gate.resolve();
                await writing;
                await closing;
            }
            const reopened = new BaseStorage('again', schema, directory);
            configureOwner(reopened, backend);
            try {
                await reopened.initialize();
                assert.equal((await reopened.searchBM25('persistent', { field: 'text' }))[0].item_id, 'persisted');
            } finally {
                await reopened.close();
            }
        });
    });
    test(`B12 ${backend} release failure retains retryable holder and does not double release`, async () => {
        await holderFixture(backend, async (owner, indexer) => {
            const db = indexer.db;
            const close = db.driver.close.bind(db.driver);
            const failure = new Error('fixture release');
            let attempts = 0;
            db.driver.close = () => {
                if (++attempts === 1) throw failure;
                close();
            };
            await assert.rejects(owner.close(), (error) => error === failure);
            assert.equal(indexer.db, db);
            await owner.close();
            assert.equal(attempts, 2);
            assert.equal(indexer.db, null);
            await owner.close();
            assert.equal(attempts, 2);
        });
    });
    test(`B13 ${backend} drop keeps files after failed close and deletes only on successful retry`, async () => {
        await holderFixture(backend, async (_owner, indexer) => {
            const db = indexer.db;
            const file = db.dbPath;
            const close = db.driver.close.bind(db.driver);
            let attempts = 0;
            db.driver.close = () => {
                if (++attempts === 1) throw new Error('fixture drop close');
                close();
            };
            await assert.rejects(indexer.dropStorage(), /fixture drop close/);
            assert.ok(fs.existsSync(file));
            await indexer.dropStorage();
            assert.equal(fs.existsSync(file), false);
            await assert.rejects(indexer.initialize(), /dropped/);
        });
    });
    test(`B12 ${backend} partial statement release retains only failed statements before closing DB`, async () => {
        await holderFixture(backend, async (owner, indexer) => {
            const db = indexer.db;
            const statements = [...db.statements.values()] as any[];
            assert.ok(statements.length > 2);
            const first = statements[0],
                second = statements[1];
            const finalize = first.finalize.bind(first),
                finishSecond = second.finalize.bind(second);
            let attempts = 0,
                secondCalls = 0,
                closes = 0;
            first.finalize = () => {
                if (++attempts === 1) throw new Error('fixture statement');
                finalize();
            };
            second.finalize = () => {
                secondCalls++;
                finishSecond();
            };
            const close = db.driver.close.bind(db.driver);
            db.driver.close = () => {
                closes++;
                close();
            };
            await assert.rejects(owner.close(), /fixture statement/);
            assert.equal(closes, 0);
            assert.equal(secondCalls, 1);
            assert.equal(db.statements.size, 1);
            await owner.close();
            assert.equal(attempts, 2);
            assert.equal(secondCalls, 1);
            assert.equal(closes, 1);
        });
    });
    test(`B12 ${backend} close during initialization prevents late publication and waits for ownership`, async () => {
        await holderFixture(backend, async (owner, _indexer, directory) => {
            await owner.close();
            const later = new BaseStorage('late', schema, path.join(directory, 'late'));
            const indexer = configureOwner(later, backend);
            const database = indexer.dependencies.database;
            const gate = deferred();
            let entered = false,
                closed = false;
            indexer.dependencies.database = async (...args: any[]) => {
                entered = true;
                await gate.promise;
                return database(...args);
            };
            const starting = later.initialize();
            const rejected = assert.rejects(starting, /closing or closed/);
            while (!entered) await tick();
            // Direct internal close exercises the acquisition barrier; outer close also waits its initialization chain.
            const closing = indexer.close().then(() => {
                closed = true;
            });
            await tick();
            assert.equal(closed, false);
            gate.resolve();
            await Promise.all([rejected, closing]);
            assert.equal(indexer.db, null);
            await later.close();
        });
    });
}

for (const backend of ['native', 'wasm'] as const) {
    test(`B11 ${backend} physical probe, uninitialized, incompatible, missing and no tokenizer load`, async () => {
        await holderFixture(backend, async (owner, indexer, directory) => {
            indexer.dependencies.tokenizer = () => {
                throw new Error('probe must not load tokenizer');
            };
            assert.equal((await owner.probeIndexers(['BM25Indexer'])).BM25Indexer?.status, 'exists');
            indexer.db.driver.exec('PRAGMA user_version=2');
            assert.equal((await owner.probeIndexers(['BM25Indexer'])).BM25Indexer?.status, 'incompatible');
            await assert.rejects(owner.searchBM25('', { field: 'text', allowedItemIds: [] }), /version/);
            const missing = path.join(directory, 'missing', 'bm25.db');
            assert.deepEqual(
                await probeBM25IndexStore(missing, () => assert.fail('unexpected cleanup'), {
                    forceWasm: backend === 'wasm'
                }),
                { status: 'missing', backend }
            );
            assert.equal(fs.existsSync(path.dirname(missing)), false);
            const empty = path.join(directory, backend === 'wasm' ? 'empty.wasm.db' : 'empty.db');
            fs.writeFileSync(empty, '');
            assert.deepEqual(
                await probeBM25IndexStore(path.join(directory, 'empty.db'), () => assert.fail('unexpected cleanup'), {
                    forceWasm: backend === 'wasm'
                }),
                { status: 'uninitialized', backend }
            );
        });
    });
    test(`B12 ${backend} accepted paused probe participates in owner close and retains failed resources`, async () => {
        await holderFixture(backend, async (owner, indexer) => {
            const original = indexer.dependencies.probe;
            const gate = deferred();
            let entered = false,
                closed = false;
            indexer.dependencies.probe = async (...args: any[]) => {
                entered = true;
                await gate.promise;
                return original(...args);
            };
            const probe = owner.probeIndexers(['BM25Indexer']);
            while (!entered) await tick();
            const closing = owner.close().then(() => {
                closed = true;
            });
            try {
                await tick();
                assert.equal(closed, false);
                await assert.rejects(owner.probeIndexers(['BM25Indexer']), /closing or closed/);
            } finally {
                gate.resolve();
                assert.equal((await probe).BM25Indexer?.status, 'exists');
                await closing;
            }
        });
    });
    test(`B12 ${backend} probe cleanup failures stay owned until a successful explicit close retry`, async () => {
        await holderFixture(backend, async (owner, indexer) => {
            let fail = true,
                acquired = 0,
                released = 0;
            indexer.dependencies.probe = (file: string, retain: any) =>
                probeBM25IndexStore(file, retain, {
                    forceWasm: backend === 'wasm',
                    wrapDriver(db) {
                        acquired++;
                        const close = db.close.bind(db);
                        db.close = () => {
                            if (fail) throw new Error('fixture probe close');
                            close();
                            released++;
                        };
                        return db;
                    }
                });
            const result = (await owner.probeIndexers(['BM25Indexer'])).BM25Indexer!;
            assert.equal(result.status, 'open_failed');
            assert.equal(acquired, 1);
            assert.equal(released, 0);
            await assert.rejects(owner.close(), /fixture probe close/);
            assert.equal(indexer.initializationCleanup.length, 1);
            fail = false;
            await owner.close();
            assert.equal(released, 1);
            assert.equal(indexer.initializationCleanup.length, 0);
        });
    });
    test(`B12 ${backend} tokenizer and later sibling initialization failures preserve same-holder retry`, async () => {
        await holderFixture(backend, async (owner, _indexer, directory) => {
            await owner.close();
            for (const stage of ['tokenizer', 'sibling']) {
                const later = new BaseStorage(stage, schema, path.join(directory, stage));
                const indexer = configureOwner(later, backend);
                const tokenizer = indexer.dependencies.tokenizer;
                let fail = true;
                if (stage === 'tokenizer')
                    indexer.dependencies.tokenizer = () => {
                        if (fail) throw new Error('fixture tokenizer');
                        return tokenizer();
                    };
                else
                    (later as any).tagIndexer = {
                        initialize: async () => {
                            if (fail) throw new Error('fixture sibling');
                        },
                        close: async () => {}
                    };
                try {
                    await assert.rejects(later.initialize());
                    assert.equal(indexer.db, null);
                    fail = false;
                    await later.initialize();
                    await later.upsert([item('retry', 'hello')], { indexers: ['BaseIndexer', 'BM25Indexer'] });
                    assert.equal((await later.searchBM25('hello', { field: 'text' })).length, 1);
                } finally {
                    await later.close();
                }
            }
        });
    });
    test(`B12 ${backend} real same-process holders alternate writes, survive peer close and reopen`, async () => {
        await holderFixture(backend, async (a, _indexer, directory) => {
            const b = new BaseStorage('b', schema, directory);
            configureOwner(b, backend);
            try {
                await b.initialize();
                await a.upsert([item('a', 'alpha')]);
                assert.equal((await b.searchBM25('alpha', { field: 'text' })).length, 1);
                await b.upsert([item('b', 'beta')]);
                assert.equal((await a.searchBM25('beta', { field: 'text' })).length, 1);
                await a.close();
                await b.upsert([item('c', 'gamma')]);
            } finally {
                await b.close();
            }
            const c = new BaseStorage('c', schema, directory);
            configureOwner(c, backend);
            try {
                await c.initialize();
                assert.equal((await c.getStatus()).BM25Indexer.size, 3);
            } finally {
                await c.close();
            }
        });
    });
    test(`B13 ${backend} instance drop is precise, raw drop covers both files and refuses unknown locks`, async () => {
        await holderFixture(backend, async (owner, indexer, directory) => {
            const chosen = indexer.db.dbPath;
            const alternate = path.join(directory, backend === 'native' ? 'bm25-index.wasm.db' : 'bm25-index.db');
            fs.writeFileSync(alternate, 'alternate sentinel');
            fs.writeFileSync(`${alternate}-journal`, 'sidecar');
            const neighbor = path.join(directory, 'neighbor.db');
            fs.writeFileSync(neighbor, 'neighbor');
            await indexer.dropStorage();
            assert.equal(fs.existsSync(chosen), false);
            assert.equal(fs.readFileSync(alternate, 'utf8'), 'alternate sentinel');
            await owner.close();
            const lock = path.join(directory, 'bm25-index.wasm.db.lock');
            fs.writeFileSync(lock, 'unknown');
            await assert.rejects(dropBM25IndexStore(path.join(directory, 'bm25-index.db')), /EBUSY/);
            assert.ok(fs.existsSync(alternate));
            fs.unlinkSync(lock);
            await dropBM25IndexStore(path.join(directory, 'bm25-index.db'));
            assert.equal(fs.existsSync(alternate), false);
            assert.equal(fs.existsSync(`${alternate}-journal`), false);
            assert.equal(fs.readFileSync(neighbor, 'utf8'), 'neighbor');
        });
    });
}

test('B11 real BM25 factory falls back for missing and delayed native addon only, with target present or absent', async () => {
    await holderFixture('native', async (_owner, _indexer, directory) => {
        for (const exists of [false, true])
            for (const delayed of [false, true]) {
                const file = path.join(directory, `${exists}-${delayed}.db`);
                if (exists) fs.writeFileSync(file, 'unopened sentinel');
                const failure = Object.assign(new Error('Could not locate the bindings file better_sqlite3.node'), {
                    code: 'MODULE_NOT_FOUND'
                });
                const nativeLoader: any = () => {
                    if (!delayed) throw failure;
                    return class {
                        constructor() {
                            throw failure;
                        }
                    };
                };
                const dependencies = { forceWasm: false, nativeLoader };
                assert.deepEqual(await probeBM25IndexStore(file, () => assert.fail('cleanup'), dependencies), {
                    status: 'missing',
                    backend: 'wasm'
                });
                const db = await createBM25IndexDB(
                    schema,
                    file,
                    'readwrite',
                    () => assert.fail('cleanup'),
                    dependencies
                );
                try {
                    assert.equal(db.backend, 'wasm');
                } finally {
                    db.close();
                }
                assert.equal(
                    (await probeBM25IndexStore(file, () => assert.fail('cleanup'), dependencies)).status,
                    'exists'
                );
                if (exists) assert.equal(fs.readFileSync(file, 'utf8'), 'unopened sentinel');
            }
        for (const code of [
            'SQLITE_BUSY',
            'SQLITE_READONLY',
            'SQLITE_CORRUPT',
            'SQLITE_CORRUPT_INDEX',
            'SQLITE_NOTADB'
        ]) {
            const failure = Object.assign(new Error('fixture native error'), { code });
            let wasmCalls = 0;
            const deps = {
                forceWasm: false,
                nativeLoader: () => {
                    throw failure;
                },
                wasmLoader: () => {
                    wasmCalls++;
                    throw new Error('must not fallback');
                }
            };
            const result = await probeBM25IndexStore(
                path.join(directory, 'never.db'),
                () => assert.fail('cleanup'),
                deps
            );
            assert.equal(result.status, 'open_failed');
            assert.equal(wasmCalls, 0);
            assert.equal(classifyBM25Failure(failure).kind, code.startsWith('SQLITE_CORRUPT') ? 'corrupt' : 'other');
        }
    });
});

test('B11 DB and tokenizer fallback are independent; native missing file does not choose existing WASM', async () => {
    await holderFixture('native', async (_owner, _indexer, directory) => {
        const file = path.join(directory, 'independent.db');
        const wasm = await createBM25IndexDB(schema, file, 'readwrite', () => assert.fail('cleanup'), {
            forceWasm: true
        });
        wasm.close();
        assert.deepEqual(await probeBM25IndexStore(file, () => assert.fail('cleanup'), { forceWasm: false }), {
            status: 'missing',
            backend: 'native'
        });
        const db = await createBM25IndexDB(schema, file, 'readwrite', () => assert.fail('cleanup'), {
            forceWasm: false
        });
        try {
            const tokenizer = await createBM25Tokenizer({
                forceWasm: false,
                loadNative: () => {
                    throw Object.assign(new Error("Cannot find module '@node-rs/jieba'"), { code: 'MODULE_NOT_FOUND' });
                }
            });
            assert.equal(db.backend, 'native');
            assert.equal(tokenizer.backend, 'wasm');
            db.upsert([{ item_id: 'a', field: 'text', subKey: '', ...tokenizer.tokenize('中文 hello') }]);
            assert.equal(db.search(['hello'], { field: 'text' }).length, 1);
        } finally {
            db.close();
        }
    });
});

test('B11 public classifier preserves BM25 wrapper codes and original diagnostic cause', async () => {
    await holderFixture('native', async (_owner, _indexer, directory) => {
        const later = new BaseStorage('failure', schema, path.join(directory, 'classify'));
        const indexer = configureOwner(later, 'native');
        const cause = new Error('dictionary unavailable');
        indexer.dependencies.tokenizer = () => {
            throw cause;
        };
        try {
            await assert.rejects(later.initialize(), (error) => {
                const result = classifyBM25Failure(error);
                assert.equal(result.reason, 'tokenizer_unavailable');
                assert.equal(result.cause, cause);
                return true;
            });
        } finally {
            await later.close();
        }
        _indexer.db.driver.exec('PRAGMA user_version=2');
        await assert.rejects(_owner.searchBM25('', { field: 'text' }), (error) => {
            assert.equal(classifyBM25Failure(error).reason, 'incompatible');
            return true;
        });
    });
});

test('B11 transient probe close error never triggers fallback and retains close operation', async () => {
    await holderFixture('native', async (_owner, _indexer, directory) => {
        let wasmCalls = 0;
        const result = await probeBM25IndexStore(
            path.join(directory, 'missing.db'),
            () => assert.fail('already released'),
            {
                forceWasm: false,
                wasmLoader: () => {
                    wasmCalls++;
                    throw new Error('unexpected fallback');
                },
                wrapDriver(driver) {
                    const close = driver.close.bind(driver);
                    let first = true;
                    driver.close = () => {
                        if (first) {
                            first = false;
                            throw new Error('better-sqlite3 close failed');
                        }
                        close();
                    };
                    return driver;
                }
            }
        );
        assert.equal(wasmCalls, 0);
        assert.equal(result.status, 'open_failed');
        if (result.status === 'open_failed') assert.equal(result.failure.operation, 'close');
    });
});

const processFixture = fileURLToPath(new URL('./fixtures/bm25-process.ts', import.meta.url));
function child(mode: string, directory: string) {
    const proc = spawn(
        process.execPath,
        ['--import', 'tsx', '--import', './src/tests/test-env.ts', processFixture, mode, directory],
        { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let output = '';
    proc.stdout.on('data', (data) => {
        output += data;
    });
    proc.stderr.on('data', (data) => {
        output += data;
    });
    const done = new Promise<void>((resolve, reject) => {
        proc.once('error', reject);
        proc.once('exit', (code, signal) =>
            code === 0 ? resolve() : reject(new Error(`BM25 ${mode} child ${code}/${signal}: ${output}`))
        );
    });
    void done.catch(() => {});
    return { proc, done };
}
async function waitFile(file: string) {
    const deadline = Date.now() + 20000;
    while (!fs.existsSync(file)) {
        if (Date.now() > deadline) throw new Error(`BM25 timeout: ${file}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}
test('B7 native reader holds one snapshot while a separate writer commits', async () => {
    await holderFixture('native', async (_owner, _indexer, directory) => {
        const db = await createBM25IndexDB(
            schema,
            path.join(directory, 'bm25.db'),
            'readwrite',
            () => assert.fail('cleanup'),
            { forceWasm: false }
        );
        db.upsert([record('old', 'alpha'), record('other', 'beta')]);
        const expected = db.search(['alpha'], { field: 'text' });
        const writer = child('snapshot', directory);
        try {
            await waitFile(path.join(directory, 'snapshot-started'));
            const prepare = db.driver.prepare.bind(db.driver);
            let gated = false;
            // A new SQL shape ensures this wrapper observes a real read after the version snapshot.
            db.driver.prepare = (sql) => {
                const statement = prepare(sql);
                const get = statement.get.bind(statement);
                statement.get = (params) => {
                    const result = get(params);
                    if (!gated && sql.includes('COALESCE(SUM(r.len)')) {
                        gated = true;
                        fs.writeFileSync(path.join(directory, 'ready'), '');
                        const deadline = Date.now() + 20000;
                        const pause = new Int32Array(new SharedArrayBuffer(4));
                        while (!fs.existsSync(path.join(directory, 'released'))) {
                            if (Date.now() > deadline) throw new Error('snapshot writer timeout');
                            Atomics.wait(pause, 0, 0, 10);
                        }
                    }
                    return result;
                };
                return statement;
            };
            assert.deepEqual(
                db.search(['alpha'], { field: 'text', allowedItemIds: ['old', 'other', 'new'] }),
                expected
            );
            assert.equal(gated, true);
            await writer.done;
            assert.equal(db.search(['alpha'], { field: 'text' }).length, 2);
        } finally {
            if (writer.proc.exitCode === null) writer.proc.kill();
            await writer.done.catch(() => {});
            db.close();
        }
    });
});
test('R4-F1 Base-only writes tolerate another native BM25 writer and preserve its records', async () => {
    await holderFixture('native', async (owner, indexer) => {
        await owner.upsert([item('kept', 'alpha'), item('update-absent', 'alpha'), item('update-empty', 'alpha')]);
        const db = indexer.db;
        const before = snapshot(db);
        const writer = driver('native', db.dbPath);
        db.driver.exec('PRAGMA busy_timeout=25');
        writer.exec('BEGIN IMMEDIATE');
        try {
            for (const operation of ['insert', 'update', 'upsert'] as const) {
                for (const payload of ['absent', 'empty'] as const) {
                    const id = `${operation}-${payload}`;
                    await owner[operation]([
                        {
                            item_id: id,
                            item_type: 'memory',
                            text: 'Base-only replacement',
                            ...(payload === 'empty' ? { indexer_columns: { BM25Indexer: [] } } : {})
                        }
                    ]);
                    const result = await owner.search([
                        { indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: id }
                    ]);
                    assert.equal(result.items[0].item.text, 'Base-only replacement');
                }
            }
            await indexer.delete([]);
            assert.equal(db.backend, 'native');
            assert.deepEqual(snapshot(db), before);
        } finally {
            writer.exec('ROLLBACK');
            writer.close();
        }
    });
});

test('B14 native competing writer reports busy without switching backend or losing data', async () => {
    await holderFixture('native', async (_owner, _indexer, directory) => {
        const db = await createBM25IndexDB(
            schema,
            path.join(directory, 'bm25.db'),
            'readwrite',
            () => assert.fail('cleanup'),
            { forceWasm: false }
        );
        db.upsert([record('old', 'alpha')]);
        const writer = child('busy', directory);
        try {
            await waitFile(path.join(directory, 'locked'));
            const started = Date.now();
            assert.throws(
                () => db.upsert([record('lost', 'beta')]),
                (error) => {
                    assert.equal((error as any).code, 'SQLITE_BUSY');
                    assert.equal(classifyBM25Failure(error).kind, 'other');
                    return true;
                }
            );
            assert.ok(Date.now() - started >= 1000);
            assert.equal(db.backend, 'native');
            fs.writeFileSync(path.join(directory, 'unlock'), '');
            await writer.done;
            assert.equal(db.count(), 1);
            db.upsert([record('retry', 'beta')]);
            assert.equal(db.count(), 2);
        } finally {
            fs.writeFileSync(path.join(directory, 'unlock'), '');
            if (writer.proc.exitCode === null) writer.proc.kill();
            await writer.done.catch(() => {});
            db.close();
        }
    });
});
test('B4 native initialization tolerates a creator committing after the first version read', async () => {
    await holderFixture('native', async (_owner, _indexer, directory) => {
        const filename = path.join(directory, 'creation-race.db');
        const readerDriver = driver('native', filename);
        const reader = new BM25StatsStore(readerDriver, filename);
        const creator = new BM25StatsStore(driver('native', filename), filename);
        const prepare = readerDriver.prepare.bind(readerDriver);
        let committed = false;
        readerDriver.prepare = (sql) => {
            const statement = prepare(sql);
            const get = statement.get.bind(statement);
            statement.get = (params) => {
                const result = get(params);
                if (!committed && sql === 'PRAGMA user_version' && result?.user_version === 0) {
                    committed = true;
                    creator.initialize();
                }
                return result;
            };
            return statement;
        };
        try {
            reader.initialize();
            assert.equal(committed, true, 'the competing connection must initialize between version and schema reads');
            assert.equal(reader.inspect(), 'compatible');
            assert.equal(reader.getInfo().indexVersion, 1);
        } finally {
            reader.close();
            creator.close();
        }
    });
});

test('B11 default holder route and B4 two-process creation race use real factory', async () => {
    await holderFixture('native', async (_owner, _indexer, directory) => {
        const target = path.join(directory, 'default');
        fs.mkdirSync(target);
        await child('default', target).done;
        const status = JSON.parse(fs.readFileSync(path.join(target, 'default-result.json'), 'utf8'));
        assert.equal(status.backend, 'native');
        assert.equal(status.tokenizer, 'native');
        const racers = [child('create', directory), child('create', directory)];
        try {
            fs.writeFileSync(path.join(directory, 'go'), '');
            await Promise.all(racers.map((r) => r.done));
        } finally {
            for (const racer of racers) {
                if (racer.proc.exitCode === null) racer.proc.kill();
                await racer.done.catch(() => {});
            }
        }
        const db = await createBM25IndexDB(
            schema,
            path.join(directory, 'bm25.db'),
            'readwrite',
            () => assert.fail('cleanup'),
            { forceWasm: false }
        );
        try {
            assert.equal(db.getInfo().indexVersion, 1);
        } finally {
            db.close();
        }
    });
});

test('B11 default routing handles missing module, delayed addon and independent tokenizer fallback in child processes', async () => {
    await holderFixture('native', async (_owner, _indexer, directory) => {
        for (const mode of ['default-db-missing', 'default-db-delayed', 'default-tokenizer-missing']) {
            const target = path.join(directory, mode);
            fs.mkdirSync(target);
            await child(mode, target).done;
            const status = JSON.parse(fs.readFileSync(path.join(target, 'default-result.json'), 'utf8'));
            assert.equal(status.backend, mode === 'default-tokenizer-missing' ? 'native' : 'wasm');
            assert.equal(status.tokenizer, mode === 'default-tokenizer-missing' ? 'wasm' : 'native');
        }
    });
});

test('B12 WASM real failed SQL finalization can be retried without re-finalizing a freed statement', async () => {
    await holderFixture('wasm', async (owner, indexer) => {
        const prepare = indexer.db.driver.prepare.bind(indexer.db.driver);
        indexer.db.driver.prepare = (sql: string) => {
            const statement = prepare(sql);
            const run = statement.run.bind(statement);
            if (sql.startsWith('INSERT INTO records('))
                statement.run = (params: any[]) => run([...params.slice(0, 3), -1]);
            return statement;
        };
        await assert.rejects(owner.upsert([item('invalid', 'alpha')], { indexers: ['BM25Indexer'] }), /CHECK/);
        // sqlite3_finalize may report the prior step error after it has released the statement.
        try {
            await owner.close();
        } catch {
            await owner.close();
        }
        assert.equal(indexer.db, null);
    });
});
