import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bm25Contribution, rankBM25Hits } from '../../../../../main/services/storage/bm25-scoring.js';
import {
    BM25_SEGMENT_LENGTH,
    createBM25Tokenizer,
    makeBM25Tokenizer,
    segmentBM25Text
} from '../../../../../main/services/storage/bm25-tokenizer.js';
import { storeFixture, rows, snapshot, record, driver } from './fixtures/bm25-fixture.js';
import { BM25StatsStore } from '../../../../../main/services/storage/bm25-stats-store.js';
import fs from 'node:fs';
import path from 'node:path';

test('B1 independent BM25 reference, saturation, boundaries and invalid statistics', () => {
    assert.ok(Math.abs(bm25Contribution(3, 2, 6, 3, 2) - 0.5665797174469142) < 1e-12);
    assert.ok(Math.abs(bm25Contribution(3, 2, 6, 1, 1) - 0.5908617053374962) < 1e-12);
    assert.ok(bm25Contribution(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 1, 1) > 0);
    assert.equal(bm25Contribution(3, 0, 6, 1, 1), 0);
    assert.ok(bm25Contribution(3, 2, 100, 30, 20) < 2 * bm25Contribution(3, 2, 100, 30, 10));
    for (const bad of [NaN, Infinity, 1.5, '3', 3n, -1, Number.MAX_SAFE_INTEGER + 1]) {
        for (const index of [0, 1, 2, 3, 4]) {
            const args: any[] = [3, 2, 6, 3, 2];
            args[index] = bad;
            assert.throws(() => bm25Contribution(...(args as [number, number, number, number, number])));
        }
    }
    for (const args of [
        [2, 3, 6, 3, 2],
        [3, 2, 2, 3, 2],
        [3, 2, 6, 1, 2],
        [0, 0, 0, 1, 1],
        [3, 2, 6, 0, 1],
        [3, 2, 6, 1, 0]
    ]) {
        assert.throws(() => bm25Contribution(...(args as [number, number, number, number, number])));
    }
    for (const [k, b] of [
        [-1, 0.75],
        [Infinity, 0.75],
        [1.2, -1],
        [1.2, 1.1],
        [1.2, NaN]
    ]) {
        assert.throws(() => bm25Contribution(3, 2, 6, 3, 2, k, b));
    }
    assert.equal(bm25Contribution(3, 2, 6, 3, 2, 0, 0), Math.log1p(1.5 / 2.5));
});

test('B1 record total order uses UTF-16 identity and exact scores', () => {
    const hits = ['\uE000', '\u{10000}', 'a'].flatMap((item_id) =>
        ['z', 'a'].map((subKey) => ({ item_id, subKey, field: 'text', score: 1 }))
    );
    assert.deepEqual(
        rankBM25Hits(hits, 4).map(({ item_id, subKey }) => [item_id, subKey]),
        [
            ['a', 'a'],
            ['a', 'z'],
            ['\u{10000}', 'a'],
            ['\u{10000}', 'z']
        ]
    );
    const close = [
        { item_id: 'a', field: 'text', subKey: '', score: 1 },
        { item_id: 'z', field: 'text', subKey: '', score: 1 + Number.EPSILON }
    ];
    assert.equal(rankBM25Hits(close, 1)[0].item_id, 'z');
});

test('B2 normalized filtered token frequencies use explicit HMM and preserve mixed/long tokens', () => {
    const calls: string[] = [];
    const tokenizer = makeBM25Tokenizer(
        {
            cut(text, hmm) {
                assert.equal(hmm, true);
                calls.push(text);
                return text.split(' ');
            }
        },
        'native'
    );
    const stats = tokenizer.tokenize('ＯＰＥＮＤＥＳＫ ① ﬃ ㎏ e\u0301 C++ 😀 ! alpha alpha');
    assert.deepEqual(calls, ['opendesk 1 ffi kg é c++ 😀 ! alpha alpha']);
    assert.equal(stats.len, 8);
    assert.equal(stats.terms.get('alpha'), 2);
    assert.equal(stats.terms.has('😀'), false);
    const long = 'x'.repeat(4096);
    assert.equal(tokenizer.tokenize(long).terms.get(long), 1);
    for (const output of [null, 'abc', [1], new Array(2)]) {
        assert.throws(() => makeBM25Tokenizer({ cut: () => output }, 'native').tokenize('x'));
    }
});

test('B2 real segment boundary covers LF ownership, surrogate pairs and all input', () => {
    const n = BM25_SEGMENT_LENGTH;
    for (const input of [
        'a'.repeat(n + 1),
        'a'.repeat(n - 1) + '😀tail',
        'a'.repeat(n - 5) + '\nlast tail',
        'ﬃ'.repeat(n) + 'tail'
    ]) {
        const chunks = [...segmentBM25Text(input)];
        assert.equal(chunks.join(''), input);
        assert.ok(chunks.every((chunk) => chunk.length <= n));
        assert.ok(chunks.length > 1);
        assert.ok(chunks.every((chunk) => !/[\uD800-\uDBFF]$/.test(chunk)));
    }
    const chunks = [...segmentBM25Text('a'.repeat(n - 5) + '\nlast tail')];
    assert.ok(chunks[0].endsWith('\n'));
    const tokenizer = makeBM25Tokenizer({ cut: (text) => text.split(/\s+/) }, 'wasm');
    assert.equal(tokenizer.tokenize('x '.repeat(n / 2) + 'tail').terms.get('tail'), 1);
});

test('B2 actual native/WASM providers agree on fixed corpus, HMM, normalization and tail', async () => {
    const native = await createBM25Tokenizer({ forceWasm: false });
    const wasm = await createBM25Tokenizer({ forceWasm: true });
    assert.equal(native.backend, 'native');
    assert.equal(wasm.backend, 'wasm');
    for (const text of [
        '杭研 小明 存算 曹云金 南京市长江大桥',
        'ＯＰＥＮＤＥＳＫ ① ﬃ ㎏ e\u0301 C++ Node.js foo_bar',
        '😀…，！',
        'x'.repeat(4096),
        'x '.repeat(BM25_SEGMENT_LENGTH / 2) + '尾部可检索 tail'
    ]) {
        assert.deepEqual(native.tokenize(text), wasm.tokenize(text));
    }
    assert.ok(native.tokenize('杭研').terms.has('杭研'));
});

test('B2 tokenizer fallback is independent and limited to native module availability', async () => {
    const unavailable = Object.assign(new Error("Cannot find module '@node-rs/jieba'"), { code: 'MODULE_NOT_FOUND' });
    const fallback = await createBM25Tokenizer({
        forceWasm: false,
        loadNative: () => {
            throw unavailable;
        }
    });
    assert.equal(fallback.backend, 'wasm');
    let wasmCalls = 0;
    const loadWasm = () => {
        wasmCalls++;
        return { cut: () => ['x'] };
    };
    const failure = new Error('dictionary corrupted');
    await assert.rejects(
        createBM25Tokenizer({
            forceWasm: false,
            loadNative: () => ({
                Jieba: {
                    withDict: () => {
                        throw failure;
                    }
                }
            }),
            loadDictionary: () => 'dict',
            loadWasm
        }),
        (e) => e === failure
    );
    await assert.rejects(
        createBM25Tokenizer({
            forceWasm: false,
            loadNative: () => {
                throw failure;
            },
            loadWasm
        }),
        (e) => e === failure
    );
    assert.equal(wasmCalls, 0);
    await assert.rejects(
        createBM25Tokenizer({
            forceWasm: false,
            loadNative: () => {
                throw unavailable;
            },
            loadWasm: () => {
                throw failure;
            }
        }),
        (e) => e === failure
    );
});

for (const backend of ['native', 'wasm'] as const) {
    test(`R4-F1 ${backend} empty writes validate a read snapshot without changing data`, async () => {
        await storeFixture(backend, (store) => {
            store.upsert([record('kept', 'alpha alpha')]);
            const before = snapshot(store);
            const exec = store.driver.exec.bind(store.driver);
            const transactions: string[] = [];
            store.driver.exec = (sql) => {
                transactions.push(sql);
                exec(sql);
            };
            for (const operation of ['insert', 'update', 'upsert', 'delete'] as const) {
                transactions.length = 0;
                store[operation]([]);
                assert.deepEqual(transactions, ['BEGIN', 'COMMIT'], operation);
                assert.deepEqual(snapshot(store), before);
            }
            store.driver.exec('PRAGMA user_version=2');
            for (const operation of ['insert', 'update', 'upsert', 'delete'] as const) {
                assert.throws(() => store[operation]([]), /version/, operation);
            }
            store.close();
            for (const operation of ['insert', 'update', 'upsert', 'delete'] as const) {
                assert.throws(() => store[operation]([]), /closing or closed/, operation);
            }
        });
    });
    test(`B3 ${backend} four constrained tables, foreign keys and configured journal/timeout`, async () => {
        await storeFixture(backend, (store) => {
            assert.deepEqual(
                rows(store, "SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").map((r) => r.name),
                ['field_stats', 'postings', 'records', 'terms']
            );
            assert.equal(rows(store, 'PRAGMA user_version')[0].user_version, 1);
            assert.equal(rows(store, 'PRAGMA foreign_keys')[0].foreign_keys, 1);
            assert.equal(rows(store, 'PRAGMA busy_timeout')[0].timeout, 5000);
            assert.equal(rows(store, 'PRAGMA journal_mode')[0].journal_mode, backend === 'native' ? 'wal' : 'delete');
            for (const sql of [
                "INSERT INTO terms(term) VALUES ('')",
                "INSERT INTO records(item_id,field,sub_key,len) VALUES ('a','text','',0)",
                "INSERT INTO records(item_id,field,sub_key,len) VALUES ('a','text','',1.5)",
                'INSERT INTO postings VALUES (1,1,1)',
                "INSERT INTO field_stats VALUES ('x',1,0)"
            ])
                assert.throws(() => store.driver.exec(sql));
        });
    });
    test(`B4 ${backend} compatible reopen and readonly never creates or upgrades`, async () => {
        await storeFixture(backend, (store, directory) => {
            store.close();
            const file = path.join(directory, 'bm25.db');
            const readonly = new BM25StatsStore(driver(backend, file, true), file, 'readonly');
            try {
                readonly.initialize();
                assert.equal(readonly.count(), 0);
                assert.throws(() => readonly.clear(), /readonly/);
                for (const operation of ['insert', 'update', 'upsert', 'delete'] as const) {
                    assert.throws(() => readonly[operation]([]), /readonly/, operation);
                }
            } finally {
                readonly.close();
            }
            const reopened = new BM25StatsStore(driver(backend, file), file);
            try {
                reopened.driver.exec('PRAGMA user_version=2');
                assert.throws(() => reopened.initialize(), /version/);
                assert.equal(rows(reopened, 'PRAGMA user_version')[0].user_version, 2);
            } finally {
                reopened.close();
            }
            assert.throws(() => driver(backend, path.join(directory, 'missing.db'), true));
            assert.equal(fs.existsSync(path.join(directory, 'missing.db')), false);
        });
    });
}

for (const backend of ['native', 'wasm'] as const) {
    test(`B5 ${backend} record CRUD duplicates, initial update eligibility and orphan term cleanup`, async () => {
        await storeFixture(backend, (store) => {
            store.insert([
                record('a', ''),
                record('a', 'first shared'),
                record('a', 'ignored'),
                record('a', 'sibling', 'text', 'b'),
                record('a', 'title', 'title')
            ]);
            assert.equal(store.count(), 3);
            assert.equal(rows(store, "SELECT COUNT(*) n FROM terms WHERE term='ignored'")[0].n, 0);
            store.update([record('a', ''), record('a', 'restored shared'), record('missing', 'skipped')]);
            assert.equal(store.count(), 3);
            assert.equal(rows(store, "SELECT COUNT(*) n FROM terms WHERE term='first'")[0].n, 0);
            assert.equal(rows(store, "SELECT COUNT(*) n FROM terms WHERE term='restored'")[0].n, 1);
            store.update([record('a', '')]);
            store.update([record('a', 'not recreated')]);
            assert.equal(store.count(), 2);
            store.upsert([
                record('a', 'new shared'),
                record('b', 'shared'),
                record('a', ''),
                record('a', 'last shared')
            ]);
            assert.equal(store.count(), 4);
            const before = snapshot(store);
            assert.throws(() => store.upsert([record('a', 'changed'), { ...record('c', 'bad'), len: 4 }]));
            assert.deepEqual(snapshot(store), before);
            store.delete(['a', 'a', 'unknown']);
            assert.equal(store.count(), 1);
            assert.deepEqual(rows(store, 'SELECT term FROM terms'), [{ term: 'shared' }]);
            store.clear();
            for (const table of ['records', 'terms', 'postings', 'field_stats'])
                assert.deepEqual(rows(store, `SELECT * FROM ${table}`), []);
            assert.equal(rows(store, 'PRAGMA user_version')[0].user_version, 1);
            store.upsert([record('again', 'shared')]);
            assert.equal(store.count(), 1);
        });
    });
    test(`B5 ${backend} mutation and dictionary-cleanup failures rollback whole batch`, async () => {
        await storeFixture(backend, (store) => {
            store.upsert([record('a', 'old shared'), record('b', 'shared')]);
            const before = snapshot(store);
            const prepare = store.driver.prepare.bind(store.driver);
            const originalStatements = (store as any).statements;
            for (const statement of originalStatements.values()) statement.finalize();
            originalStatements.clear();
            let inject = true;
            store.driver.prepare = (sql) => {
                const statement = prepare(sql);
                if (/DELETE FROM terms/.test(sql)) {
                    const run = statement.run.bind(statement);
                    statement.run = (params) => {
                        if (inject) throw new Error('fixture orphan cleanup');
                        run(params);
                    };
                }
                return statement;
            };
            assert.throws(
                () => store.upsert([record('a', 'replacement'), record('c', 'new')]),
                /fixture orphan cleanup/
            );
            assert.deepEqual(snapshot(store), before);
            assert.throws(() => store.delete(['a']), /fixture orphan cleanup/);
            assert.deepEqual(snapshot(store), before);
            inject = false;
            store.delete(['a']);
            assert.equal(store.count(), 1);
        });
    });
}

for (const backend of ['native', 'wasm'] as const) {
    test(`B3 ${backend} damaged persisted numeric values and driver type anomalies are rejected`, async () => {
        await storeFixture(backend, (store) => {
            store.upsert([record('a', 'alpha')]);
            for (const sql of [
                'UPDATE records SET len=1.5',
                'UPDATE postings SET tf=9007199254740992',
                'UPDATE field_stats SET sum_len=9007199254740992'
            ]) {
                store.driver.exec('PRAGMA ignore_check_constraints=ON');
                store.driver.exec(sql);
                store.driver.exec('PRAGMA ignore_check_constraints=OFF');
                assert.throws(() => store.search(['alpha'], { field: 'text' }), /Invalid BM25/);
                store.driver.exec('PRAGMA ignore_check_constraints=ON');
                store.driver.exec(
                    'UPDATE records SET len=1; UPDATE postings SET tf=1; UPDATE field_stats SET sum_len=1'
                );
                store.driver.exec('PRAGMA ignore_check_constraints=OFF');
            }
            const prepare = store.driver.prepare.bind(store.driver);
            for (const statement of (store as any).statements.values()) statement.finalize();
            (store as any).statements.clear();
            let invalid: unknown = '1';
            store.driver.prepare = (sql) => {
                const statement = prepare(sql);
                if (sql === 'SELECT n,sum_len FROM field_stats WHERE field=?') {
                    const get = statement.get.bind(statement);
                    statement.get = (params) => ({ ...get(params), n: invalid });
                }
                return statement;
            };
            for (const value of ['1', 1n, NaN, Infinity, 0.5]) {
                invalid = value;
                assert.throws(() => store.search(['alpha'], { field: 'text' }), /Invalid BM25/);
                assert.throws(() => store.getInfo(), /Invalid BM25/);
            }
        });
    });
    test(`B4 ${backend} creation faults rollback schema/version and retry; partial or incompatible schemas stay untouched`, async () => {
        await storeFixture(backend, (store, directory) => {
            for (const stage of ['CREATE TABLE postings', 'PRAGMA user_version=1', 'COMMIT']) {
                const file = path.join(directory, `create-${stage.replaceAll(' ', '-').replaceAll('=', '-')}.db`);
                const db = driver(backend, file);
                const exec = db.exec.bind(db);
                let fail = true;
                db.exec = (sql) => {
                    exec(sql);
                    if (fail && sql === stage) {
                        throw new Error('fixture creation');
                    }
                    if (fail && sql.startsWith(stage) && stage !== 'COMMIT') throw new Error('fixture creation');
                };
                // COMMIT failure must occur before committing; after-COMMIT faults cannot promise rollback.
                if (stage === 'COMMIT')
                    db.exec = (sql) => {
                        if (fail && sql === 'COMMIT') throw new Error('fixture creation');
                        exec(sql);
                    };
                const failed = new BM25StatsStore(db, file);
                try {
                    assert.throws(() => failed.initialize(), /fixture creation/);
                    assert.equal(rows(failed, 'PRAGMA user_version')[0].user_version, 0);
                    assert.deepEqual(rows(failed, "SELECT name FROM sqlite_schema WHERE type='table'"), []);
                } finally {
                    fail = false;
                    failed.close();
                }
                const retry = new BM25StatsStore(driver(backend, file), file);
                try {
                    retry.initialize();
                    assert.equal(retry.count(), 0);
                } finally {
                    retry.close();
                }
            }
            const file = path.join(directory, 'partial.db');
            const partial = new BM25StatsStore(driver(backend, file), file);
            try {
                partial.driver.exec('CREATE VIEW stray AS SELECT 1');
                const before = rows(partial, 'PRAGMA journal_mode');
                assert.throws(() => partial.initialize());
                assert.deepEqual(rows(partial, 'PRAGMA journal_mode'), before);
                assert.equal(rows(partial, "SELECT COUNT(*) n FROM sqlite_schema WHERE name='stray'")[0].n, 1);
            } finally {
                partial.close();
            }
        });
    });
    test(`B5 ${backend} rollback failure poisons data operations but remains closeable`, async () => {
        await storeFixture(backend, (store) => {
            store.upsert([record('a', 'old')]);
            const exec = store.driver.exec.bind(store.driver);
            const primary = new Error('fixture commit');
            store.driver.exec = (sql) => {
                if (sql === 'COMMIT') throw primary;
                if (sql === 'ROLLBACK') throw new Error('fixture rollback');
                exec(sql);
            };
            assert.throws(
                () => store.upsert([record('a', 'new')]),
                (e) => e === primary
            );
            assert.throws(() => store.count(), /cleanup/);
            for (const operation of ['insert', 'update', 'upsert', 'delete'] as const) {
                assert.throws(() => store[operation]([]), /cleanup/, operation);
            }
            store.driver.exec = exec;
        });
    });
}

test('B1 finite extreme k1 retains the finite limiting contribution', () => {
    assert.ok(Math.abs(bm25Contribution(3, 2, 6, 3, 2, Number.MAX_VALUE, 0.75) - (Math.log(1.6) * 2) / 1.375) < 1e-12);
});

for (const backend of ['native', 'wasm'] as const) {
    test(`B4 ${backend} safe-empty detection does not hide user objects resembling SQLite names`, async () => {
        await storeFixture(backend, (store, directory) => {
            const file = path.join(directory, 'not-empty.db');
            const raw = driver(backend, file);
            raw.exec('CREATE VIEW sqlitexuser AS SELECT 1');
            const candidate = new BM25StatsStore(raw, file);
            try {
                assert.throws(() => candidate.initialize(), /version|schema/);
                assert.deepEqual(rows(candidate, "SELECT name FROM sqlite_schema WHERE type='view'"), [
                    { name: 'sqlitexuser' }
                ]);
                assert.equal(rows(candidate, 'PRAGMA user_version')[0].user_version, 0);
            } finally {
                candidate.close();
            }
        });
    });
}

for (const backend of ['native', 'wasm'] as const) {
    test(`D2 ${backend} invalid identity and term strings reject the batch without changing four tables`, async () => {
        await storeFixture(backend, (store) => {
            store.upsert([record('existing', 'alpha')]);
            const before = snapshot(store);
            for (const invalid of ['a\0b', '\ud800', '\udfff', 'a\ud800z']) {
                for (const part of ['item_id', 'field', 'subKey', 'term']) {
                    const bad = record('bad', 'beta');
                    if (part === 'term') bad.terms = new Map([[invalid, 1]]);
                    else bad[part as 'item_id' | 'field' | 'subKey'] = invalid;
                    assert.throws(() => store.upsert([record('transient', 'new'), bad]), /Invalid BM25/);
                    assert.deepEqual(snapshot(store), before);
                }
                assert.throws(() => store.search([], { field: 'text', allowedItemIds: [invalid] }), /Invalid BM25/);
                assert.throws(() => store.search([invalid], { field: 'text' }), /Invalid BM25/);
                assert.throws(() => store.delete(['existing', invalid]), /Invalid BM25/);
                assert.deepEqual(snapshot(store), before);
            }
            store.upsert([record('合法𐀀', 'alpha', '字段𐀀', '子键𐀀')]);
            assert.equal(store.search(['alpha'], { field: '字段𐀀' })[0].subKey, '子键𐀀');
        });
    });
}
test('D2 tokenizer rejects invalid retained terms without restricting raw input text', () => {
    for (const term of ['a\0b', 'a\ud800', 'a\udfff'])
        assert.throws(() => makeBM25Tokenizer({ cut: () => [term] }, 'native').tokenize('input'), /Invalid BM25/);
    assert.equal(makeBM25Tokenizer({ cut: () => ['valid'] }, 'native').tokenize('raw\0\ud800').len, 1);
});

for (const backend of ['native', 'wasm'] as const) {
    test(`B4 ${backend} version alone cannot hide missing subKey default`, async () => {
        await storeFixture(backend, (store, directory) => {
            const file = path.join(directory, 'missing-default.db');
            const raw = driver(backend, file);
            const ddl = rows(
                store,
                "SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' ORDER BY type DESC"
            );
            for (const row of ddl) raw.exec((row.sql as string).replace(" DEFAULT ''", ''));
            raw.exec('PRAGMA user_version=1');
            const candidate = new BM25StatsStore(raw, file);
            try {
                assert.throws(() => candidate.initialize(), /schema/);
            } finally {
                candidate.close();
            }
        });
    });
}
