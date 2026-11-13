import assert from 'node:assert/strict';
import { test } from 'node:test';
import { driver, record, rows, storeFixture, holderFixture, item, schema, snapshot } from './fixtures/bm25-fixture.js';
import { BM25StatsStore } from '../../../../../main/services/storage/bm25-stats-store.js';
import { BaseStorage } from '../../../../../main/services/storage/abstract-storage.js';

for (const backend of ['native', 'wasm'] as const) {
    test(`R08 ${backend} original query has no estimate or forced order and preserves sparse-scope scores`, async () => {
        await storeFixture(backend, (store) => {
            const records = [
                ...Array.from({ length: 850 }, (_, i) => record('r' + i, i % 11 ? 'common' : 'common sparse')),
                record('r0', 'common sparse', 'text', '子'),
                record('r0', 'other', 'title')
            ];
            store.upsert(records);
            const executed: string[] = [];
            const driver = (store as any).driver;
            const prepare = driver.prepare.bind(driver);
            driver.prepare = (sql: string) => {
                executed.push(sql);
                return prepare(sql);
            };
            const lists = [0, 1, 127, 128, 129, 800, 5001].map((size) => {
                const ids = Array.from({ length: size }, (_, i) => 'r' + i);
                return ids.concat(ids.slice(0, 2), 'missing', '');
            });
            lists.push(
                Array.from({ length: 20 }, (_, i) => 'r' + i).concat(
                    Array.from({ length: 10000 }, (_, i) => 'absent' + i)
                )
            );
            for (const ids of lists) {
                const allowed = new Set(ids);
                const corpus = records.filter((row) => row.field === 'text' && allowed.has(row.item_id));
                const n = corpus.length;
                const sum = corpus.reduce((value, row) => value + row.len, 0);
                for (const terms of [['common'], ['sparse'], ['common', 'sparse'], ['missing']]) {
                    const df = new Map(terms.map((term) => [term, corpus.filter((row) => row.terms.has(term)).length]));
                    const expected = corpus
                        .map((row) => {
                            let score = 0;
                            for (const term of terms) {
                                const tf = row.terms.get(term) ?? 0;
                                if (tf)
                                    score +=
                                        (Math.log(1 + (n - df.get(term)! + 0.5) / (df.get(term)! + 0.5)) * tf * 2.2) /
                                        (tf + 1.2 * (0.25 + (0.75 * row.len) / (sum / n)));
                            }
                            return { item_id: row.item_id, subKey: row.subKey, score };
                        })
                        .filter((hit) => hit.score > 0)
                        .sort(
                            (a, b) =>
                                b.score - a.score ||
                                (a.item_id < b.item_id ? -1 : a.item_id > b.item_id ? 1 : 0) ||
                                (a.subKey < b.subKey ? -1 : a.subKey > b.subKey ? 1 : 0)
                        );
                    const actual = store.search(terms, { field: 'text', allowedItemIds: ids, topK: 1000 });
                    assert.deepEqual(
                        actual.map((hit) => [hit.item_id, hit.subKey]),
                        expected.map((hit) => [hit.item_id, hit.subKey])
                    );
                    actual.forEach((hit, index) => assert.ok(Math.abs(hit.score - expected[index].score) < 1e-12));
                }
            }
            assert.ok(executed.some((sql) => sql.includes('SUM(r.len)')));
            assert.ok(
                executed.every((sql) => !/term_matches|CROSS\s+JOIN|INDEXED\s+BY/i.test(sql)),
                'the withdrawn estimate and forced query orders must not execute'
            );
            assert.deepEqual(rows(store, "SELECT name FROM sqlite_temp_schema WHERE type='table'"), []);
        });
    });
    test(`B6 ${backend} raw records retain identity and use complete local corpus statistics`, async () => {
        await storeFixture(backend, (store) => {
            store.upsert([
                record('a', 't', 'text', 'one'),
                record('a', 't', 'text', 'two'),
                record('b', 't u'),
                record('c', 'u '.repeat(10)),
                record('a', 't', 'title')
            ]);
            const hits = store.search(['t'], { field: 'text', topK: 10 });
            assert.deepEqual(
                hits.map((hit) => [hit.item_id, hit.subKey]),
                [
                    ['a', 'one'],
                    ['a', 'two'],
                    ['b', '']
                ]
            );
            const scoped = store.search(['t'], { field: 'text', allowedItemIds: ['b', 'c', 'c', 'unknown'] });
            assert.equal(scoped.length, 1);
            assert.ok(Math.abs(scoped[0].score - (Math.log(2) * 2.2) / (1 + 1.2 * (0.25 + (0.75 * 2) / 6))) < 1e-12);
            assert.deepEqual(store.search(['t'], { field: 'text', allowedItemIds: [] }), []);
            assert.deepEqual(store.search([], { field: 'text' }), []);
            assert.deepEqual(
                store.search(['t', 'u', 't'], { field: 'text' }),
                store.search(['u', 't'], { field: 'text' })
            );
            for (const query of [[], ['t']]) {
                for (const ids of [null, 1, 'b', [1], ['b', null], new Array(1)])
                    assert.throws(() => store.search(query, { field: 'text', allowedItemIds: ids as any }));
            }
            assert.deepEqual(rows(store, "SELECT name FROM sqlite_temp_schema WHERE type='table'"), []);
        });
    });
    test(`B7 ${backend} large allowlist and many terms keep tail contribution`, async () => {
        await storeFixture(backend, (store) => {
            const terms = Array.from({ length: 70 }, (_, i) => `term${i}`);
            store.upsert([record('last', terms.join(' ')), record('other', 'term0')]);
            const ids = Array.from({ length: 32770 }, (_, i) => `absent${i}`).concat('last');
            const hits = store.search(terms, { field: 'text', allowedItemIds: ids });
            assert.equal(hits.length, 1);
            assert.equal(hits[0].item_id, 'last');
            assert.ok(Math.abs(hits[0].score - 70 * Math.log(4 / 3)) < 1e-12);
        });
    });
    test(`B7 ${backend} readonly TEMP leaves persistent contents unchanged`, async () => {
        await storeFixture(backend, (store) => {
            store.upsert([record('a', 't')]);
            const reader = new BM25StatsStore(driver(backend, store.dbPath, true), store.dbPath, 'readonly');
            try {
                reader.initialize();
                assert.equal(reader.search(['t'], { field: 'text', allowedItemIds: ['a'] }).length, 1);
                assert.throws(() => reader.upsert([]), /readonly/);
                assert.deepEqual(rows(reader, "SELECT name FROM sqlite_temp_schema WHERE type='table'"), []);
                assert.equal(store.count(), 1);
            } finally {
                reader.close();
            }
        });
    });
}

for (const backend of ['native', 'wasm'] as const) {
    test(`B8 ${backend} real holder raw and scope preserve records, metadata and diagnostics`, async () => {
        await holderFixture(backend, async (owner, indexer) => {
            await owner.upsert([item('a', 'alpha', 'one'), item('a', 'alpha', 'two'), item('b', 'beta')]);
            await owner.upsert([item('orphan', 'alpha')], { indexers: ['BM25Indexer'] });
            const base = (owner as any).baseIndexer;
            const search = base.search.bind(base);
            base.search = () => {
                throw new Error('raw must not use Base');
            };
            try {
                assert.equal((await owner.searchBM25('alpha', { field: 'text' })).length, 3);
            } finally {
                base.search = search;
            }
            const result = await owner.searchScope(
                {
                    preconditions: [{ indexer: 'BaseIndexer', field: 'category', operator: '=', value: 'kept' }],
                    targetCondition: {
                        indexer: 'BM25Indexer',
                        field: 'text',
                        operator: 'bm25_match',
                        value: { query: 'alpha' }
                    }
                },
                { collectDiagnostics: true }
            );
            assert.equal(result.totalCount, 2);
            assert.deepEqual(
                result.items.map((hit) => [hit.item.item_id, hit.item.item_type, (hit as any).bm25Record.subKey]),
                [
                    ['a', 'memory', 'one'],
                    ['a', 'memory', 'two']
                ]
            );
            assert.equal(result.items[0].item.text, 'Base a');
            assert.equal(result.diagnostics?.target, 'bm25');
            assert.equal(result.diagnostics?.exactCandidateCount, 2);
            assert.equal(result.diagnostics?.totalTargetRows, 4);
            assert.equal(result.diagnostics?.exactBatchCount, 1);
            assert.equal(result.diagnostics?.strategy, 'exact_temp');
            await assert.rejects(indexer.search([]), /BaseStorage/);
            await assert.rejects(
                owner.search([
                    {
                        indexer: 'BM25Indexer',
                        field: 'text',
                        operator: 'bm25_match',
                        value: { query: 'alpha', topK: 1 }
                    }
                ]),
                /record|searchBM25/
            );
        });
    });
    test(`B8 ${backend} invalid targets are rejected before Base prefilter; empty candidates still validate version`, async () => {
        await holderFixture(backend, async (owner, indexer) => {
            const base = (owner as any).baseIndexer;
            const search = base.search.bind(base);
            let calls = 0;
            base.search = (...args: any[]) => {
                calls++;
                return search(...args);
            };
            const target = {
                indexer: 'BM25Indexer',
                field: 'text',
                operator: 'bm25_match' as const,
                value: { query: 'alpha' }
            };
            const preconditions = [
                { indexer: 'BaseIndexer', field: 'category', operator: '=' as const, value: 'absent' }
            ];
            for (const invalid of [
                { ...target, field: 'missing' },
                { ...target, operator: 'vector_near' },
                { ...target, value: { query: 1 } },
                { ...target, value: { query: '', topK: 0 } }
            ])
                await assert.rejects(owner.searchScope({ preconditions, targetCondition: invalid }));
            assert.equal(calls, 0);
            assert.equal((await owner.searchScope({ preconditions, targetCondition: target })).totalCount, 0);
            indexer.db.driver.exec('PRAGMA user_version=2');
            await assert.rejects(owner.searchScope({ preconditions, targetCondition: target }), /version/);
        });
    });
}

for (const backend of ['native', 'wasm'] as const) {
    test(`B7 ${backend} query faults clean TEMP and cleanup failure poisons connection`, async () => {
        await storeFixture(backend, (store) => {
            store.upsert([record('a', 'alpha beta')]);
            const prepare = store.driver.prepare.bind(store.driver);
            let fail = true;
            store.driver.prepare = (sql) => {
                const statement = prepare(sql);
                if (sql.startsWith('SELECT r.id')) {
                    const all = statement.all.bind(statement);
                    statement.all = (params) => {
                        if (fail) throw new Error('fixture postings read');
                        return all(params);
                    };
                }
                return statement;
            };
            assert.throws(() => store.search(['alpha'], { field: 'text', allowedItemIds: ['a'] }), /fixture postings/);
            assert.deepEqual(rows(store, "SELECT name FROM sqlite_temp_schema WHERE type='table'"), []);
            fail = false;
            assert.equal(store.search(['beta'], { field: 'text', allowedItemIds: ['a'] }).length, 1);
            const exec = store.driver.exec.bind(store.driver);
            store.driver.exec = (sql) => {
                if (sql === 'DROP TABLE temp.bm25_allowlist') throw new Error('fixture TEMP cleanup');
                exec(sql);
            };
            assert.throws(() => store.search(['alpha'], { field: 'text', allowedItemIds: ['a'] }), /fixture TEMP/);
            assert.throws(() => store.search(['alpha'], { field: 'text' }), /cleanup/);
            store.driver.exec = exec;
        });
    });
    test(`B9 ${backend} generic search preserves first condition, pagination and final Base type without dropping orphan before Vector`, async () => {
        await holderFixture(backend, async (owner) => {
            await owner.upsert([{ ...item('a', 'alpha'), item_type: 'mail' }, item('b', 'alpha')]);
            await owner.upsert([item('orphan', 'alpha')], { indexers: ['BM25Indexer'] });
            const condition = {
                indexer: 'BM25Indexer',
                field: 'text',
                operator: 'bm25_match' as const,
                value: { query: 'alpha' }
            };
            const simple = await owner.search([condition, { ...condition, field: 'invalid' }]);
            assert.equal(simple.items.length, 2);
            assert.equal(simple.items[0].item.item_type, 'mail');
            assert.equal((await owner.search([condition], { limit: 1, offset: 1 })).items.length, 0);
            let observed: string[] = [];
            (owner as any).vectorIndexer = {
                search: async (_conditions: unknown, options: any) => {
                    observed = options.existingResults.map((i: any) => i.item_id);
                    return { items: options.existingResults, scores: new Map(observed.map((id) => [id, 0.5])) };
                },
                close: async () => {}
            };
            const mixed = await owner.search([
                condition,
                { indexer: 'VectorIndexer', field: 'text', operator: 'vector_near', value: [1] }
            ]);
            assert.ok(observed.includes('orphan'));
            assert.equal(mixed.items.length, 2);
            assert.equal(mixed.items[0].item.item_type, 'mail');
            assert.equal(mixed.items[0].VecScore, 0.5);
            assert.ok(mixed.items[0].BM25Score! > 0);
        });
    });
    test(`B9 ${backend} duplicate check precedes previous ID intersection and K truncation`, async () => {
        await holderFixture(backend, async (owner) => {
            await owner.upsert([item('a', 'alpha', '1'), item('a', 'alpha', '2'), item('b', 'alpha')]);
            (owner as any).tagIndexer = {
                search: async () => ({ items: [{ item_id: 'b', item_type: 'tag' }] }),
                close: async () => {}
            };
            await assert.rejects(
                owner.search([
                    { indexer: 'TagIndexer', field: 'tag', operator: '=', value: 'b' },
                    {
                        indexer: 'BM25Indexer',
                        field: 'text',
                        operator: 'bm25_match',
                        value: { query: 'alpha', topK: 1 }
                    }
                ]),
                /Multiple BM25/
            );
        });
    });
}

for (const backend of ['native', 'wasm'] as const) {
    test(`B10 ${backend} selected dispatch, record identities and all three object deletion paths`, async () => {
        await holderFixture(backend, async (owner, indexer) => {
            await owner.insert([item('existing', 'original')]);
            await owner.insert([item('existing', 'ignored', 'new')]);
            assert.equal((await owner.searchBM25('ignored', { field: 'text' })).length, 0);
            const base = (owner as any).baseIndexer;
            const upsert = base.upsert;
            base.upsert = () => assert.fail('BM25-only must not use Base');
            try {
                await owner.upsert([item('orphan', 'isolated')], { indexers: ['BM25Indexer'] });
            } finally {
                base.upsert = upsert;
            }
            await owner.update([item('existing', 'ignored')], { indexers: ['BaseIndexer'] });
            await owner.upsert([item('existing', 'ignored')], { indexers: ['BaseIndexer'] });
            assert.equal((await owner.searchBM25('original', { field: 'text' })).length, 1);
            const compound = item('compound', 'first', 'a');
            compound.indexer_columns!.BM25Indexer!.push(
                { column: 'text', content: 'second', id: 'b' },
                { column: 'title', content: 'third', id: 'a' }
            );
            await owner.upsert([compound]);
            assert.equal((await owner.searchBM25('second', { field: 'text' }))[0].subKey, 'b');
            const before = snapshot(indexer.db);
            for (const bad of [null, 1, [], {}]) {
                const invalid = item('bad', 'valid');
                invalid.indexer_columns!.BM25Indexer![0].id = bad as any;
                await assert.rejects(owner.upsert([item('transient', 'new'), invalid], { indexers: ['BM25Indexer'] }));
                assert.deepEqual(snapshot(indexer.db), before);
            }
            await indexer.delete(['orphan']);
            await owner.clearIndexerForItem('compound', 'BM25Indexer');
            await owner.delete(['existing']);
            assert.equal(indexer.db.count(), 0);
            assert.deepEqual(rows(indexer.db, 'SELECT * FROM terms'), []);
        });
    });
    test(`B10 ${backend} 1201-ID deletion keeps first group, rolls back second and waits siblings`, async () => {
        await holderFixture(backend, async (owner, indexer) => {
            const ids = Array.from({ length: 1201 }, (_, i) => String(i));
            await owner.upsert(ids.map((id) => item(id, `token${id}`)));
            const prepare = indexer.db.driver.prepare.bind(indexer.db.driver);
            const failure = new Error('second group');
            let failed = false;
            indexer.db.driver.prepare = (sql: string) => {
                const statement = prepare(sql);
                const run = statement.run.bind(statement);
                statement.run = (params: any[]) => {
                    if (!failed && sql === 'DELETE FROM records WHERE id=?' && params[0] === 601) {
                        failed = true;
                        throw failure;
                    }
                    return run(params);
                };
                return statement;
            };
            let release!: () => void;
            const gate = new Promise<void>((r) => {
                release = r;
            });
            let groups = 0,
                waiting = false,
                settled = false;
            (owner as any).tagIndexer = {
                delete: async () => {
                    groups++;
                    if (groups === 2) {
                        waiting = true;
                        await gate;
                        throw new Error('later sibling');
                    }
                },
                close: async () => {}
            };
            const deleting = owner.delete(ids);
            const rejection = assert
                .rejects(deleting, (error) => error === failure)
                .then(() => {
                    settled = true;
                });
            try {
                while (!waiting) await new Promise((r) => setImmediate(r));
                assert.equal(settled, false);
            } finally {
                release();
                await rejection;
            }
            assert.equal(groups, 2);
            assert.equal(indexer.db.count(), 701);
            assert.equal((await owner.searchBM25('token500', { field: 'text' })).length, 1);
            assert.equal((await owner.searchBM25('token0', { field: 'text' })).length, 0);
            assert.equal((await owner.searchBM25('token1200', { field: 'text' })).length, 1);
        });
    });
    test(`B8 ${backend} direct empty operations require initialized writable compatible storage`, async () => {
        await holderFixture(backend, async (owner, indexer, directory) => {
            await indexer.close();
            await assert.rejects(indexer.upsert([]), /not initialized/);
            await assert.rejects(indexer.dropStorage(), /not initialized/);
            await indexer.initialize();
            indexer.db.driver.exec('PRAGMA user_version=2');
            await assert.rejects(indexer.upsert([]), /version/);
            await owner.close();
            await assert.rejects(owner.upsert([]), /closing or closed/);
            const empty = new BaseStorage('empty', schema, directory + '/uninitialized');
            try {
                await empty.upsert([]);
                await empty.delete([]);
                await assert.rejects(empty.searchBM25('', { field: 'text', allowedItemIds: [] }));
            } finally {
                await empty.close();
            }
        });
    });
}
test('B8 access merges explicit bindings and rejects unknown/conflicting options before opening resources', () => {
    const config = structuredClone(schema);
    config.needIndexers.text[0].options = { access: 'readonly' };
    const holder = new BaseStorage('config', config, '/never-opened/bm25');
    assert.equal((holder as any).bm25Indexer.access, 'readonly');
    for (const options of [{ access: 'readwrite' }, { backend: 'native' }, { access: null }, [], null]) {
        const bad = structuredClone(config);
        bad.needIndexers.title[0].options = options as any;
        assert.throws(() => new BaseStorage('invalid', bad, '/never-opened/bm25'));
    }
});
