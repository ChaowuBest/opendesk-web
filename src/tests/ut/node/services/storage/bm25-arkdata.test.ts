import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BM25IndexDBArkdata } from '../../../../../main/services/storage/bm25-index-db-arkdata.js';
import { ArkDataBridgeError } from '../../../../../platforms/bridges/common.js';
import { arkDataFixture, deferred } from './fixtures/arkdata-fixture.js';
import { assertBM25BackendContract, record, rows, storeFixture, schema, item } from './fixtures/bm25-fixture.js';
import {
    createBM25IndexDB,
    probeBM25IndexStore,
    dropBM25IndexStore
} from '../../../../../main/services/storage/bm25-index-db-factory.js';
import { BaseStorage } from '../../../../../main/services/storage/abstract-storage.js';
import { BM25Indexer } from '../../../../../main/services/storage/bm25-indexer.js';
import { createBM25Tokenizer } from '../../../../../main/services/storage/bm25-tokenizer.js';

if (!process.env.OPENDESK_ARKDATA_ADAPTER_DIR) {
    test.skip('BM25 ArkData cross-repository tests require OPENDESK_ARKDATA_ADAPTER_DIR', () => {});
} else {
    test('R10 empty allowed IDs preserve the existing missing-ID semantics', async () => {
        const f = arkDataFixture();
        const { proxy } = f.proxy();
        const db = new BM25IndexDBArkdata(f.directory + '/empty-allowed-id.db', proxy);
        try {
            await db.initialize();
            await db.upsert([record('a', 'common')]);
            const options = { field: 'text', allowedItemIds: ['', 'a', '', 'missing'], topK: 10 };
            assert.deepEqual(
                await db.searchWithDiagnostics(['common'], options),
                await db.searchReferenceWithDiagnostics(['common'], options)
            );
        } finally {
            await db.close();
            f.cleanup();
        }
    });
    test('R10 formal host BM25 capability scores the complete scope without App postings transport', async () => {
        const f = arkDataFixture();
        const { proxy } = f.proxy();
        const db = new BM25IndexDBArkdata(f.directory + '/host-score.db', proxy);
        try {
            await db.initialize();
            await db.upsert(
                Array.from({ length: 300 }, (_, i) =>
                    record(String(i).padStart(4, '0'), i % 11 ? 'common' : 'common rare')
                )
            );
            const options = {
                field: 'text',
                topK: 400,
                allowedItemIds: Array.from({ length: 260 }, (_, i) => String(i).padStart(4, '0'))
            };
            const expected = await db.searchReferenceWithDiagnostics(['common', 'rare'], options);
            const query = proxy.queryPrepared.bind(proxy);
            proxy.queryPrepared = (...args) => {
                assert.ok(
                    !args[1].startsWith('SELECT r.id,r.item_id'),
                    'business search must not transport raw postings'
                );
                return query(...args);
            };
            const before = f.calls.length;
            const result = await db.searchWithDiagnostics(['common', 'rare'], options);
            assert.deepEqual(result, expected);
            assert.equal(
                f.calls
                    .slice(before)
                    .filter((call) => call.operation === 'query' && call.sql?.startsWith('SELECT r.id,r.item_id'))
                    .length,
                6
            );
            assert.ok([...f.adapter.operations.values()].some((op: any) => op.type === 'bm25Query'));
            assert.ok([...f.adapter.objectTransactions.values()].every((tx: any) => !tx.bm25Lists?.size));
        } finally {
            await db.close();
            f.cleanup();
        }
    });
    test('R10 only the upload byte budget splits a complete allowlist', async () => {
        const f = arkDataFixture();
        const { proxy } = f.proxy();
        const db = new BM25IndexDBArkdata(f.directory + '/upload-bytes.db', proxy);
        const call = proxy.bm25Query.bind(proxy),
            uploads: number[] = [];
        proxy.bm25Query = (store, request, identity) => {
            if (request.kind === 'allowlist') uploads.push(request.itemIds!.length);
            return call(store, request, identity);
        };
        try {
            await db.initialize();
            const ids = Array.from({ length: 129 }, (_, i) => 'missing-' + i);
            await db.search(['common'], { field: 'text', allowedItemIds: ids });
            assert.deepEqual(uploads, [129], 'SQL batch count must not split the upload');
            uploads.length = 0;
            const large = 'x'.repeat(3200 * 1024);
            const result = await db.searchWithDiagnostics(['common'], {
                field: 'text',
                allowedItemIds: ['a' + large, 'b' + large]
            });
            assert.deepEqual(uploads, [1, 1]);
            assert.equal(result.diagnostics.exactCandidateCount, 2);
            assert.deepEqual(result.hits, []);
        } finally {
            await db.close();
            f.cleanup();
        }
    });
    test('R10 failed ResultSet release is not a page retry and rollback releases the real result', async () => {
        const f = arkDataFixture();
        const { proxy } = f.proxy();
        const db = new BM25IndexDBArkdata(f.directory + '/host-close-failed.db', proxy);
        try {
            await db.initialize();
            await db.upsert([record('a', 'common')]);
            let closes = 0;
            f.control.closeResultSet = () => {
                if (++closes === 1) throw Object.assign(new Error('ResultSet close failed'), { code: 14800099 });
            };
            await assert.rejects(db.search(['common'], { field: 'text' }), (error: any) => {
                assert.equal(error.code, 'result_set_close_failed');
                assert.equal(error.details.resourceState, 'recovering');
                return true;
            });
            assert.equal(closes, 2, 'rollback retries the retained ResultSet release');
            assert.ok([...f.adapter.objectTransactions.values()].every((tx: any) => !tx.resultSets.length));
        } finally {
            await db.close();
            f.cleanup();
        }
    });
    test('A3 V1 formal backend creates four tables, both indexes and version 2 in one object transaction', async () => {
        const f = arkDataFixture();
        const { proxy } = f.proxy();
        const db = new BM25IndexDBArkdata(f.directory + '/bm25.db', proxy);
        try {
            await db.initialize();
            assert.equal(await db.inspect(), 'compatible');
            assert.equal(
                f.calls.filter((call) => call.operation === 'execute' && call.sql?.startsWith('CREATE TABLE')).length,
                4
            );
            assert.equal(
                f.calls.filter((call) => call.operation === 'execute' && call.sql?.startsWith('CREATE INDEX')).length,
                2
            );
            assert.equal(
                f.calls.filter((call) => call.operation === 'execute' && call.sql === 'PRAGMA user_version=2').length,
                1
            );
            await db.close();
            const reopened = new BM25IndexDBArkdata(f.directory + '/bm25.db', proxy);
            try {
                await reopened.initialize();
                assert.equal(await reopened.inspect(), 'compatible');
            } finally {
                await reopened.dropStorage();
            }
        } finally {
            await db.close();
            f.cleanup();
        }
    });
    for (const phase of ['ddl', 'index', 'version', 'commit'])
        test(`A3 V1 ${phase} failure rolls back the entire schema and reopens empty`, async () => {
            const f = arkDataFixture();
            const { proxy } = f.proxy();
            const filename = f.directory + '/rollback.db';
            const db = new BM25IndexDBArkdata(filename, proxy);
            let wroteVersion = false,
                failed = false;
            f.control.before = async (operation, detail) => {
                if (operation === 'execute' && detail === 'PRAGMA user_version=2') wroteVersion = true;
                const match =
                    (operation === 'execute' &&
                        ((phase === 'ddl' && detail.startsWith('CREATE TABLE postings')) ||
                            (phase === 'index' && detail.startsWith('CREATE INDEX postings_rec')) ||
                            (phase === 'version' && wroteVersion))) ||
                    (phase === 'commit' && operation === 'commit' && wroteVersion);
                if (match && !failed) {
                    failed = true;
                    throw Object.assign(new Error('isolated schema failure'), { code: 14800021 });
                }
            };
            try {
                await assert.rejects(db.initialize(), (error: any) => error.details?.sdkErrorCode === 14800021);
                assert.equal(failed, true);
                assert.equal(f.calls.filter((call) => call.operation === 'rollback').length, 1);
                await db.close();
                const reopened = new BM25IndexDBArkdata(filename, proxy);
                try {
                    await (reopened as any).open();
                    assert.equal(await reopened.inspect(), 'uninitialized');
                    await reopened.initialize();
                    assert.equal(await reopened.inspect(), 'compatible');
                } finally {
                    await reopened.dropStorage();
                }
            } finally {
                await db.close();
                f.cleanup();
            }
        });
    for (const backend of ['native', 'wasm'] as const)
        test(`A3 shared prepared-data contract: ${backend}`, async () => {
            await storeFixture(backend, (store) =>
                assertBM25BackendContract(
                    store,
                    async () => rows(store, 'SELECT term FROM terms ORDER BY term').map((row) => row.term as string),
                    1
                )
            );
        });
    test('A3 shared prepared-data contract: arkdata', async () => {
        const f = arkDataFixture();
        const a = f.proxy();
        const db = new BM25IndexDBArkdata(f.directory + '/contract.db', a.proxy);
        try {
            await db.initialize();
            await assertBM25BackendContract(
                db,
                () =>
                    (db as any).transaction('read', async (tx: any) =>
                        (await (db as any).query(tx, 'SELECT term FROM terms ORDER BY term')).map(
                            (row: any) => row.term
                        )
                    ),
                2
            );
        } finally {
            await db.close();
            f.cleanup();
        }
    });

    test('A13/P7 public factory selects ArkData before desktop fallback and probe remains independent of NLP', async () => {
        const f = arkDataFixture();
        const a = f.proxy();
        const logical = f.directory + '/public-factory.db';
        let db: any;
        try {
            db = await createBM25IndexDB(schema, logical, 'readwrite', () => {}, {
                platform: 'openharmony',
                kit: a.proxy
            } as any);
            assert.equal(db.backend, 'arkdata', 'Harmony factory must choose the formal ArkData backend');
            await db.close();
            const probe = await probeBM25IndexStore(logical, () => {}, {
                platform: 'openharmony',
                kit: a.proxy
            } as any);
            assert.equal(probe.status, 'unsupported');
            assert.equal(
                f.calls.some((call) => call.operation === 'nlp-init'),
                false
            );
            await dropBM25IndexStore(logical, { platform: 'openharmony', kit: a.proxy } as any);
            assert.equal(f.calls.filter((call) => call.operation === 'delete').length, 1);
        } finally {
            await db?.close();
            f.cleanup();
        }
    });

    test('public Storage retains database-only operations after tokenizer failure, then cleans the group on initialize', async () => {
        const f = arkDataFixture();
        const a = f.proxy();
        const owner = new BaseStorage('arkdata-public-contract', schema, f.directory);
        const indexer = (owner as any).bm25Indexer as any;
        let unavailable = false;
        let tokenizations = 0;
        const failure = new ArkDataBridgeError('bm25_tokenizer_unavailable', 'required', 'isolated tokenizer failure', {
            source: 'intl',
            availability: 'unsupported',
            outcome: 'not_executed'
        });
        indexer.dependencies.platform = 'openharmony';
        indexer.dependencies.tokenizer = async () => {
            const tokenizer = await createBM25Tokenizer({ platform: 'openharmony' });
            return {
                ...tokenizer,
                assertAvailable() {
                    if (unavailable) throw failure;
                },
                tokenize(text: string) {
                    if (unavailable) throw failure;
                    tokenizations++;
                    return tokenizer.tokenize(text);
                }
            };
        };
        indexer.dependencies.database = (schema: any, filename: string, access: any, retain: any) =>
            createBM25IndexDB(schema, filename, access, retain, { platform: 'openharmony', kit: a.proxy });
        try {
            await owner.initialize();
            await owner.upsert([item('a', 'shared one'), item('b', 'shared two')]);
            const scoped = await owner.searchScope(
                {
                    preconditions: [{ indexer: 'BaseIndexer', field: 'category', operator: '=', value: 'kept' }],
                    targetCondition: {
                        indexer: 'BM25Indexer',
                        field: 'text',
                        operator: 'bm25_match',
                        value: { query: 'shared', topK: 2 }
                    }
                },
                { collectDiagnostics: true }
            );
            assert.equal(scoped.diagnostics!.strategy, 'exact_in');
            assert.equal(scoped.diagnostics!.totalTargetRows, 2);
            unavailable = true;
            await assert.rejects(indexer.searchHits('pending', { field: 'text' }), (error) => error === failure);
            const count = tokenizations;
            await indexer.upsert([{ item_id: 'base-only' }]);
            await indexer.delete([]);
            assert.equal((await indexer.getInfo()).size, 2);
            await assert.rejects(indexer.upsert([item('zero', '!!!')]), { code: 'bm25_tokenizer_unavailable' });
            await assert.rejects(indexer.searchHits('', { field: 'text' }), { code: 'bm25_tokenizer_unavailable' });
            await indexer.delete(['a']);
            assert.equal((await indexer.getInfo()).size, 1);
            assert.equal(tokenizations, count, 'unavailable tokenizer must not invoke its provider');
            await assert.rejects(owner.initialize(), (error) => error === failure);
            assert.equal((owner as any).baseIndexer.db, null, 'initialization failure cleans the existing base owner');
            assert.equal(indexer.db, null);
        } finally {
            await owner.close().catch(() => {});
            f.cleanup();
        }
    });

    test('A4/A5/A8 scoped corpus and all cursor pages use one snapshot; actual host size limits shrink the same cursor', async () => {
        const f = arkDataFixture();
        const a = f.proxy(),
            b = f.proxy();
        const logical = f.directory + '/snapshot-pages.db';
        const db = new BM25IndexDBArkdata(logical, a.proxy),
            writer = new BM25IndexDBArkdata(logical, b.proxy);
        try {
            await db.initialize();
            await writer.initialize();
            const input = Array.from({ length: 150 }, (_, i) =>
                record(String(i).padStart(4, '0'), i === 149 ? 'common rare' : 'common')
            );
            input.push(record('nonmatch', 'noise'));
            await db.upsert(input);
            f.control.resultBudget.rows = 6;
            let changed = false;
            f.control.before = async (operation, sql) => {
                if (operation === 'query' && String(sql).startsWith('SELECT r.id,r.item_id') && !changed) {
                    changed = true;
                    f.control.resultBudget.rows = 5000;
                    await writer.upsert([record('later', 'common rare rare')]);
                    f.control.resultBudget.rows = 6;
                }
            };
            const ids = input.map((row) => row.item_id).concat('nonmatch');
            const result = await db.searchWithDiagnostics(
                ['rare', 'common', 'common'],
                { field: 'text', allowedItemIds: ids, topK: 200 },
                true
            );
            assert.equal(changed, true);
            assert.equal(result.hits.length, 150, 'every hit must survive shrinking and cursor advancement');
            assert.equal(result.hits[0].item_id, '0149');
            assert.equal(result.diagnostics.totalTargetRows, 151, 'diagnostic n is from the old field snapshot');
            assert.equal(result.diagnostics.exactCandidateCount, 151);
            assert.equal(result.diagnostics.exactBatchCount, 2);
            const commonIdf = Math.log(1 + 1.5 / 150.5);
            const rareIdf = Math.log(1 + 150.5 / 1.5);
            const expected = ((commonIdf + rareIdf) * 2.2) / (1 + 1.2 * (0.25 + (0.75 * 2) / (152 / 151)));
            assert.ok(Math.abs(result.hits[0].score - expected) < 1e-12);
            assert.equal(
                result.hits.some((hit) => hit.item_id === 'later'),
                false
            );
            f.control.resultBudget.rows = 5000;
            assert.equal((await db.getInfo()).size, 152);
            assert.equal((await db.search(['rare'], { field: 'text', topK: 10 }))[0].item_id, 'later');
            assert.ok(
                f.calls.some(
                    (call) =>
                        call.operation === 'query' &&
                        call.sql?.startsWith('SELECT r.id,r.item_id') &&
                        Number(call.params?.at(-1)) <= 4
                ),
                'shrinking uses the real mapper failure and reissues a smaller page'
            );
        } finally {
            f.control.resultBudget.rows = 5000;
            f.control.before = async () => {};
            await db.close();
            await writer.close();
            f.cleanup();
        }
    });

    test('R08 ArkData original queries aggregate all ID batches without estimates or forced orders', async (t) => {
        const f = arkDataFixture();
        const a = f.proxy();
        const db = new BM25IndexDBArkdata(f.directory + '/scope-order.db', a.proxy);
        t.after(async () => {
            await db.close();
            f.cleanup();
        });
        await db.initialize();
        await db.upsert(Array.from({ length: 850 }, (_, i) => record('r' + i, i % 11 ? 'common' : 'common sparse')));
        await db.upsert([record('r0', 'common sparse', 'text', '子'), record('r0', 'other', 'title')]);
        const automaticStart = f.calls.length;
        await db.search(['common'], { field: 'text', allowedItemIds: ['r0'], topK: 10 });
        assert.ok(
            f.calls.slice(automaticStart).every((call) => !call.sql?.includes('AS term_matches')),
            'uncalibrated device strategy retains the original query without estimate overhead'
        );
        for (const size of [0, 1, 127, 128, 129, 800, 5001]) {
            const ids = Array.from({ length: size }, (_, i) => 'r' + i);
            ids.push(...ids.slice(0, 2), 'missing');
            for (const terms of [['common'], ['sparse'], ['common', 'sparse'], ['missing']]) {
                const original = (
                    await db.searchReferenceWithDiagnostics(terms, { field: 'text', allowedItemIds: ids, topK: 1000 })
                ).hits;
                assert.deepEqual(await db.search(terms, { field: 'text', allowedItemIds: ids, topK: 1000 }), original);
            }
        }
        assert.ok(
            f.calls
                .slice(automaticStart)
                .every((call) => !/term_matches|CROSS\s+JOIN|INDEXED\s+BY/i.test(call.sql ?? '')),
            'neither the App reference nor host scoring may retain the withdrawn strategy'
        );
    });
    test('R04 ArkData batches record lookup and field statistics while preserving final identities', async (t) => {
        const f = arkDataFixture();
        const a = f.proxy();
        const db = new BM25IndexDBArkdata(f.directory + '/bulk-records.db', a.proxy);
        t.after(async () => {
            await db.close();
            f.cleanup();
        });
        await db.initialize();
        const start = f.calls.length;
        const inputs = Array.from({ length: 24 }, (_, i) => record('batch-' + i, 'shared term' + i));
        await db.upsert(inputs);
        const reads = f.calls.slice(start).filter((call) => call.operation === 'query');
        assert.ok(reads.length < 16, `bulk record write used ${reads.length} SDK queries`);
        assert.deepEqual((await db.getInfo()).fields.text, { n: 24, sum_len: 48 });
        assert.equal((await db.search(['shared'], { field: 'text', topK: 30 })).length, 24);
        await db.upsert([
            record('batch-0', 'ignored'),
            record('batch-0', ''),
            record('batch-1', 'last last'),
            record('batch-1', 'final')
        ]);
        assert.deepEqual((await db.getInfo()).fields.text, { n: 23, sum_len: 45 });
        assert.deepEqual(await db.search(['ignored', 'last'], { field: 'text' }), []);
        assert.deepEqual(
            (await db.search(['final'], { field: 'text' })).map((hit) => hit.item_id),
            ['batch-1']
        );
        await db.upsert([record('transient', 'temporary', 'transient'), record('transient', '', 'transient')]);
        assert.deepEqual((await db.getInfo()).fields.transient, { n: 0, sum_len: 0 });
    });

    test('A3/A5 batched postings failure rolls back all four tables and keeps WAL errors separate from corruption', async () => {
        const f = arkDataFixture();
        const a = f.proxy();
        const db = new BM25IndexDBArkdata(f.directory + '/batch-rollback.db', a.proxy);
        try {
            await db.initialize();
            await db.upsert([record('a', 'old shared'), record('b', 'shared')]);
            const before = await db.getInfo();
            let postings = 0;
            f.control.before = async (operation, sql) => {
                if (operation === 'execute' && String(sql).startsWith('INSERT INTO postings') && ++postings === 501)
                    throw Object.assign(new Error('PRIVATE_BODY_PATH_MARKER'), { code: 14800047 });
            };
            await assert.rejects(
                db.upsert([record('a', Array.from({ length: 600 }, (_, i) => 'new' + i).join(' '))]),
                (error: any) => error.code === 'sql_execute_failed' && error.details.sdkErrorCode === 14800047
            );
            f.control.before = async () => {};
            assert.deepEqual(await db.getInfo(), before);
            assert.equal((await db.search(['old'], { field: 'text' }))[0].item_id, 'a');
            assert.deepEqual(await db.search(['new0'], { field: 'text' }), []);
            assert.equal(f.adapter.stores.size, 1);
            assert.equal(JSON.stringify(f.logs).includes('PRIVATE_BODY_PATH_MARKER'), false);
            await db.upsert([record('a', 'healthy')]);
            assert.equal((await db.search(['shared'], { field: 'text' }))[0].item_id, 'b');
        } finally {
            f.control.before = async () => {};
            await db.close();
            f.cleanup();
        }
    });
    test('A4/A8 complete public backend search returns more than 5000 scored records and retains the highest tail hit', async () => {
        const f = arkDataFixture();
        const a = f.proxy();
        const db = new BM25IndexDBArkdata(f.directory + '/complete-pages.db', a.proxy);
        try {
            await db.initialize();
            const input = Array.from({ length: 5201 }, (_, i) =>
                record(String(i).padStart(5, '0'), i === 5200 ? 'common rare' : 'common')
            );
            await db.upsert(input);
            const hits = await db.search(['common', 'rare'], { field: 'text', topK: 6000 });
            assert.equal(
                hits.length,
                5201,
                'intermediate postings and final hits must not be capped at the bridge row limit'
            );
            assert.equal(hits[0].item_id, '05200');
            assert.equal(new Set(hits.map((hit) => hit.item_id)).size, 5201);
            const idf = Math.log(1 + 0.5 / 5201.5) + Math.log(1 + 5200.5 / 1.5);
            const expected = (idf * 2.2) / (1 + 1.2 * (0.25 + (0.75 * 2) / (5202 / 5201)));
            assert.ok(Math.abs(hits[0].score - expected) < 1e-12);
            const pages = f.calls.filter(
                (call) => call.operation === 'query' && call.sql?.startsWith('SELECT r.id,r.item_id')
            );
            assert.equal(pages.length, 3);
            assert.ok(pages.every((call) => call.params?.at(-1) === 5000));
        } finally {
            await db.close();
            f.cleanup();
        }
    });

    for (const version of [1, 3])
        test(`A3/A11 public Harmony factory rejects existing version ${version} without rebuilding`, async () => {
            const f = arkDataFixture();
            const a = f.proxy();
            const logical = f.directory + '/version.db';
            const seed = new BM25IndexDBArkdata(logical, a.proxy);
            try {
                await seed.initialize();
                await (seed as any).transaction('write', (tx: any) =>
                    (seed as any).execute(tx, `PRAGMA user_version=${version}`)
                );
                await seed.close();
                const probe = await probeBM25IndexStore(logical, () => {}, { platform: 'openharmony', kit: a.proxy });
                assert.equal(probe.status, 'unsupported');
                await assert.rejects(
                    createBM25IndexDB(schema, logical, 'readwrite', () => {}, {
                        platform: 'openharmony',
                        kit: a.proxy
                    }),
                    { code: 'bm25_index_version_mismatch' }
                );
                assert.equal(f.calls.filter((call) => call.operation === 'delete').length, 0);
                assert.equal(f.calls.filter((call) => call.operation === 'nlp-init').length, 0);
            } finally {
                f.cleanup();
            }
        });
    for (const phase of ['readonly', 'open-failure', 'acquire-close'] as const)
        test(`public Indexer preserves tokenizer resource ownership during ${phase}`, async () => {
            const f = arkDataFixture();
            const a = f.proxy();
            const gate = deferred();
            let acquired = 0,
                released = 0;
            const readonlySchema =
                phase === 'readonly'
                    ? {
                          ...schema,
                          needIndexers: {
                              ...schema.needIndexers,
                              text: [{ indexer: 'BM25Indexer', options: { access: 'readonly' } }]
                          }
                      }
                    : schema;
            const indexer = new BM25Indexer(readonlySchema, f.directory + '/public-indexer.db') as any;
            indexer.dependencies.platform = 'openharmony';
            indexer.dependencies.tokenizer = async () => {
                const tokenizer = await createBM25Tokenizer({ platform: 'openharmony' });
                acquired++;
                if (phase === 'acquire-close') await gate.promise;
                let closed = false;
                return {
                    ...tokenizer,
                    close() {
                        if (!closed) {
                            closed = true;
                            released++;
                        }
                    }
                };
            };
            indexer.dependencies.database = (schema: any, file: string, access: any, retain: any) =>
                createBM25IndexDB(schema, file, access, retain, { platform: 'openharmony', kit: a.proxy });
            try {
                f.control.before = async (operation) => {
                    if (phase === 'open-failure' && operation === 'open')
                        throw Object.assign(new Error('isolated DB failure'), { code: 14800000 });
                };
                const pending = indexer.initialize();
                if (phase === 'acquire-close') {
                    for (let i = 0; i < 100 && acquired === 0; i++)
                        await new Promise((resolve) => setTimeout(resolve, 2));
                    assert.equal(acquired, 1, 'tokenizer acquisition must have started');
                    const closing = indexer.close();
                    gate.resolve();
                    await assert.rejects(pending);
                    await closing;
                } else {
                    await assert.rejects(pending, {
                        code: phase === 'readonly' ? 'bm25_access_mode_unsupported' : 'store_open_failed'
                    });
                    if (phase === 'open-failure') assert.equal(acquired - released, 1);
                    await indexer.close();
                }
                assert.equal(acquired - released, 0);
                assert.equal(released, phase === 'readonly' ? 0 : 1);
                if (phase === 'readonly') assert.equal(f.calls.length, 0);
            } finally {
                gate.resolve();
                await indexer.close().catch(() => {});
                f.cleanup();
            }
        });
}
