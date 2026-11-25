import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getStorageInitializationFailure } from '../../../../../main/services/storage/platform.js';
import { storeFixture, snapshot, record, driver } from './fixtures/bm25-fixture.js';

for (const operation of ['search', 'getInfo', 'empty-upsert'] as const) {
    test(`R5-F1 WASM ${operation} recovers on the first call after a competing writer releases`, async () => {
        await storeFixture('wasm', (store) => {
            store.upsert([record('kept', 'alpha')]);
            const before = snapshot(store);
            store.driver.exec('PRAGMA busy_timeout=25');
            const writer = driver('wasm', store.dbPath);
            try {
                writer.exec('BEGIN IMMEDIATE');
                assert.throws(() => {
                    if (operation === 'search') store.search(['alpha'], { field: 'text' });
                    else if (operation === 'getInfo') store.getInfo();
                    else store.upsert([]);
                }, /locked|busy/i);
            } finally {
                writer.exec('ROLLBACK');
                writer.close();
            }

            if (operation === 'getInfo') {
                store.upsert([record('new', 'beta')]);
                assert.equal(store.count(), 2);
                assert.equal(store.search(['beta'], { field: 'text' })[0].item_id, 'new');
            } else {
                if (operation === 'empty-upsert') store.upsert([]);
                assert.equal(store.search(['alpha'], { field: 'text' })[0].item_id, 'kept');
                assert.deepEqual(snapshot(store), before);
            }
        });
    });
}

for (const backend of ['native', 'wasm'] as const) {
    for (const method of ['get', 'all'] as const) {
        test(`R5-F1 ${backend} cached ${method} recovers from a real SQLite expression error`, async () => {
            await storeFixture(backend, (store) => {
                const query = (value: string) => (store as any)[method]('SELECT abs(CAST(? AS INTEGER)) AS n', [value]);
                assert.throws(() => query('-9223372036854775808'), /overflow/i);
                assert.deepEqual(query('2'), method === 'get' ? { n: 2 } : [{ n: 2 }]);
                assert.equal(store.count(), 0);
            });
        });
    }
}

for (const failRelease of [false, true]) {
    test(`R5-F1 WASM failed run preserves its primary error and cleanup ownership; release failure=${failRelease}`, async () => {
        await storeFixture('wasm', (store) => {
            const before = snapshot(store);
            const prepare = store.driver.prepare.bind(store.driver);
            const cleanupError = new Error('fixture statement release failure');
            let injectBadValue = true;
            let releaseBlocked = failRelease;
            let releaseAttempts = 0;
            let primary: unknown;
            store.driver.prepare = (sql) => {
                const statement = prepare(sql);
                if (!sql.startsWith('INSERT INTO records(')) return statement;
                const run = statement.run.bind(statement);
                const finalize = statement.finalize.bind(statement);
                statement.run = (params) => {
                    const values = injectBadValue ? [...params.slice(0, 3), -1] : params;
                    injectBadValue = false;
                    try {
                        run(values);
                    } catch (error) {
                        primary = error;
                        throw error;
                    }
                };
                statement.finalize = () => {
                    releaseAttempts++;
                    if (releaseBlocked) {
                        releaseBlocked = false;
                        throw cleanupError;
                    }
                    finalize();
                };
                return statement;
            };

            try {
                assert.throws(
                    () => store.upsert([record('bad', 'alpha')]),
                    (error) => {
                        assert.match((error as Error).message, /CHECK/);
                        return error === primary;
                    }
                );
                assert.deepEqual(snapshot(store), before);
                if (failRelease) {
                    assert.equal(getStorageInitializationFailure(primary)?.cleanupFailures[0].error, cleanupError);
                    assert.throws(() => store.count(), /cleanup/);
                    // The retry releases the handle but reports its previous CHECK error once.
                    assert.throws(() => store.close(), /CHECK/);
                    store.close();
                    assert.equal(releaseAttempts, 3);
                } else {
                    assert.equal(getStorageInitializationFailure(primary)?.cleanupFailures.length ?? 0, 0);
                    store.upsert([record('recovered', 'beta')]);
                    assert.equal(store.count(), 1);
                    assert.equal(store.search(['beta'], { field: 'text' })[0].item_id, 'recovered');
                }
            } finally {
                releaseBlocked = false;
                try {
                    store.close();
                } catch {
                    store.close();
                }
            }
        });
    });
}
