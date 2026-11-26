import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ArkDataStoreSession } from '../../../../../main/services/storage/arkdata-bridge.js';
import { BM25IndexDBArkdata } from '../../../../../main/services/storage/bm25-index-db-arkdata.js';
import { classifyBM25Failure } from '../../../../../main/services/storage/bm25-indexer.js';
import { arkDataFixture, deferred } from './fixtures/arkdata-fixture.js';

const options = { skip: !process.env.OPENDESK_ARKDATA_ADAPTER_DIR };

test('normal and session closes pass both arguments to the host binding', options, async (t) => {
    const f = arkDataFixture();
    t.after(() => f.cleanup());
    const name = 'ArkData.CloseStoreStart';
    const closeStart = f.bindings.get(name)!;
    const calls: string[][] = [];
    f.bindings.set(name, (...args: string[]) => {
        calls.push(args);
        return closeStart(...args);
    });
    await f.kit.openStore('ordinary-store');
    await f.kit.closeStore('ordinary-store');
    const sessionId = 'test-session';
    await f.kit.openStore('session-store', { sessionId });
    await f.kit.closeStore('session-store', { sessionId });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], ['ordinary-store', '']);
    assert.equal(calls[1].length, 2);
    assert.equal(calls[1][0], 'session-store');
    const request = JSON.parse(calls[1][1]);
    assert.equal(request.sessionId, sessionId);
    assert.equal(typeof request.requestId, 'string');
    assert.ok(request.requestId.length > 0);
    assert.equal(f.calls.filter((call) => call.operation === 'close').length, 2);
});

test('initialization rethrows the cached open failure before starting a transaction', options, async (t) => {
    const f = arkDataFixture();
    const db = new BM25IndexDBArkdata(f.directory + '/failed-open.db', f.kit);
    t.after(async () => {
        await db.close();
        f.cleanup();
    });
    const begin = t.mock.method(f.kit, 'beginTransaction');
    f.control.before = async (op) => {
        if (op === 'open') throw Object.assign(new Error('failed open'), { code: 14800021 });
    };
    let first: unknown;
    await assert.rejects(db.initialize(), (error: any) => {
        assert.equal(error.details.sdkErrorCode, 14800021);
        first = error;
        return true;
    });
    await assert.rejects(db.initialize(), (error) => error === first);
    assert.equal(f.calls.filter((call) => call.operation === 'open').length, 1);
    assert.equal(begin.mock.callCount(), 0);
});

test('a failed close preserves the busy open error and retries with a new session', options, async (t) => {
    const f = arkDataFixture();
    const db = new BM25IndexDBArkdata(f.directory + '/busy-close.db', f.kit);
    t.after(async () => {
        await db.close();
        f.cleanup();
    });
    const closeError = new Error('failed close');
    t.mock.method(
        ArkDataStoreSession.prototype,
        'close',
        async () => {
            throw closeError;
        },
        { times: 1 }
    );
    const open = t.mock.method(f.kit, 'openStore');
    let attempts = 0;
    f.control.before = async (op) => {
        if (op === 'open' && ++attempts === 1) throw Object.assign(new Error('busy'), { code: 14800024 });
    };
    await db.initialize();
    assert.equal(attempts, 2);
    const [first, second] = open.mock.calls;
    assert.ok(first.arguments[1].sessionId);
    assert.ok(second.arguments[1].sessionId);
    assert.notEqual(first.arguments[1].sessionId, second.arguments[1].sessionId);
    await assert.rejects(first.result, (error: any) => {
        assert.equal(error.code, 'store_open_failed');
        assert.equal(error.details.source, 'sdk');
        assert.equal(error.details.sdkErrorCode, 14800024);
        assert.equal(error.details.closeError, closeError);
        assert.equal(classifyBM25Failure(error).reason, 'busy');
        return true;
    });
    assert.equal((await db.getInfo()).size, 0);
});

test('three readers and one writer share a store and the last close waits for their release', options, async (t) => {
    const f = arkDataFixture();
    t.after(() => f.cleanup());
    const { proxy } = f.proxy();
    const store = 'concurrency';
    await proxy.openStore(store);
    const readers = await Promise.all([1, 2, 3].map(() => proxy.beginTransaction(store, { mode: 'read' })));
    const writer = await proxy.beginTransaction(store, { mode: 'write' });
    await assert.rejects(proxy.closeStore(store), { code: 'store_busy_with_tx' });
    await proxy.executePrepared(store, 'PRAGMA user_version=2', [], { txId: writer.id });
    await proxy.commitTransaction(store, writer);
    for (const tx of readers) await proxy.rollbackTransaction(store, tx);
    await proxy.closeStore(store);
});

for (const finish of ['commitTransaction', 'rollbackTransaction'] as const) {
    test(finish + ' waits for the in-flight SDK query', options, async (t) => {
        const f = arkDataFixture();
        t.after(() => f.cleanup());
        const kit = f.kit;
        await kit.openStore('ordering');
        const tx = await kit.beginTransaction('ordering', { mode: 'read' });
        const started = deferred();
        const gate = deferred();
        const events: string[] = [];
        f.control.before = async (op) => {
            if (op === 'query') {
                started.resolve();
                await gate.promise;
                events.push('query finished');
            } else if (op === 'commit' || op === 'rollback') events.push(op);
        };
        const reading = kit.queryPrepared('ordering', 'SELECT 1', [], { txId: tx.id });
        await started.promise;
        const finishing = kit[finish]('ordering', tx);
        assert.equal(
            f.calls.some((c) => c.operation === 'commit' || c.operation === 'rollback'),
            false
        );
        gate.resolve();
        // Finishing discards any SQL rows the abandoned caller has not polled.
        await Promise.all([
            finishing,
            reading.catch((error: Error & { code?: string }) => {
                assert.equal(error.code, 'sql_result_released');
            })
        ]);
        assert.deepEqual(events, ['query finished', finish === 'commitTransaction' ? 'commit' : 'rollback']);
        await kit.closeStore('ordering');
    });
}

test('idle rollback starts after the last SDK operation ends, without another request', options, async (t) => {
    const f = arkDataFixture();
    t.after(() => f.cleanup());
    f.adapter.objectIdleMs = 100;
    await f.kit.openStore('idle');
    const tx = await f.kit.beginTransaction('idle', { mode: 'write' });
    const gate = deferred();
    const started = deferred();
    const rolledBack = deferred();
    f.control.before = async (op) => {
        if (op === 'execute') {
            started.resolve();
            await gate.promise;
        }
        if (op === 'rollback') rolledBack.resolve();
    };
    const writing = f.kit.executePrepared('idle', 'CREATE TABLE pending (n INTEGER)', [], { txId: tx.id });
    await started.promise;
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(
        f.calls.some((c) => c.operation === 'rollback'),
        false
    );
    // Allow the bridge to poll the completed write before the next idle interval expires.
    f.adapter.objectIdleMs = 750;
    const completedAt = Date.now();
    gate.resolve();
    await writing;
    await rolledBack.promise;
    assert.ok(Date.now() - completedAt >= 740);
    await assert.rejects(f.kit.commitTransaction('idle', tx), { code: 'tx_invalid' });
    assert.deepEqual(await f.kit.queryPrepared('idle', "SELECT name FROM sqlite_schema WHERE name='pending'", []), []);
    await f.kit.closeStore('idle');
});

test('expired queued search opens no fourth reader and another holder can reuse the slots', options, async (t) => {
    const f = arkDataFixture();
    const a = new BM25IndexDBArkdata(f.directory + '/queue.db', f.kit);
    const b = new BM25IndexDBArkdata(f.directory + '/queue.db', f.kit);
    t.after(async () => {
        await a.close();
        await b.close();
        f.cleanup();
    });
    await a.initialize();
    await b.initialize();
    const gate = deferred();
    const started = deferred();
    let readers = 0;
    f.control.before = async (op, mode) => {
        if (op === 'create' && mode === 'DEFERRED') {
            if (++readers === 3) started.resolve();
            await gate.promise;
        }
    };
    const pending = Promise.all([a.getInfo(), b.getInfo(), a.getInfo()]);
    await started.promise;
    try {
        (b as any).searchWaitMs = 25;
        await assert.rejects(b.search(['foo'], { field: 'text' }), { code: 'bm25_search_timeout' });
        assert.equal(readers, 3);
    } finally {
        gate.resolve();
        await pending;
    }
    assert.equal((await b.getInfo()).size, 0);
});

test('bridge polling timeout preserves the cause and rolls the search back', options, async (t) => {
    const f = arkDataFixture();
    const db = new BM25IndexDBArkdata(f.directory + '/poll.db', f.kit);
    t.after(async () => {
        await db.close();
        f.cleanup();
    });
    await db.initialize();
    const polling = f.bindings.get('ArkData.BM25QueryReady')!;
    let now = Date.now();
    f.control.clock.now = () => now;
    f.bindings.set('ArkData.BM25QueryReady', () => {
        now += 31_000;
        return JSON.stringify({ ok: true, state: 'pending' });
    });
    await assert.rejects(db.search(['foo'], { field: 'text' }), (error: any) => {
        assert.equal(error.code, 'bm25_search_timeout');
        assert.equal(error.cause.code, 'operation_timeout');
        return true;
    });
    assert.equal(f.adapter.objectTransactions.size, 0);
    f.bindings.set('ArkData.BM25QueryReady', polling);
});

for (const phase of ['open', 'create', 'execute']) {
    test('initialization retries a fresh SDK call after a transient ' + phase + ' failure', options, async (t) => {
        const f = arkDataFixture();
        const db = new BM25IndexDBArkdata(f.directory + '/retry.db', f.kit);
        t.after(async () => {
            await db.close();
            f.cleanup();
        });
        let attempts = 0;
        f.control.before = async (op) => {
            if (op === phase && attempts++ === 0) throw Object.assign(new Error('busy'), { code: 14800024 });
        };
        await db.initialize();
        assert.ok(attempts >= 2);
        assert.equal((await db.getInfo()).size, 0);
    });
}

test('busy budget exhaustion and real SDK corruption stay distinguishable', options, async (t) => {
    const f = arkDataFixture();
    t.after(() => f.cleanup());
    for (const code of [14800015, 14800047, 14800011]) {
        const db = new BM25IndexDBArkdata(f.directory + '/busy-' + code + '.db', f.kit);
        (db as any).openRetryMs = 600;
        let attempts = 0;
        f.control.before = async (op) => {
            if (op === 'open') {
                attempts++;
                throw Object.assign(new Error('injected'), { code });
            }
        };
        await assert.rejects(db.initialize(), (error: any) => {
            assert.equal(error.details.source, 'sdk');
            assert.equal(error.details.sdkErrorCode, code);
            assert.equal(classifyBM25Failure(error).reason, code === 14800011 ? 'corrupt' : 'busy');
            if (code === 14800011) assert.equal(attempts, 1);
            else assert.ok(attempts >= 2);
            return true;
        });
        await db.close();
    }
});

test('host discards uploaded IDs after scoring and retains the result until Ready', options, async (t) => {
    const f = arkDataFixture();
    const db = new BM25IndexDBArkdata(f.directory + '/delivery.db', f.kit);
    t.after(async () => {
        await db.close();
        f.cleanup();
    });
    await db.initialize();
    const tx = await f.kit.beginTransaction(db.storeId, { mode: 'read' });
    try {
        const deadline = Date.now() + 25_000;
        const upload = {
            kind: 'allowlist',
            searchId: 'scope',
            batchCount: 1,
            batchIndex: 0,
            itemIds: ['file'],
            deadline
        };
        assert.equal((await f.kit.bm25Query(db.storeId, upload, tx.id)).uploaded, true);
        const hostTx = f.adapter.objectTransactions.get(tx.id);
        assert.equal(hostTx.bm25Lists.size, 1);
        const request = {
            kind: 'search',
            deadline,
            searchId: 'scope',
            batchCount: 1,
            field: 'text',
            terms: ['term'],
            topK: 2,
            pageSize: 10
        };
        const start = JSON.parse(f.adapter.bm25QueryStart(db.storeId, JSON.stringify(request), tx.id));
        await hostTx.pending;
        assert.equal(hostTx.bm25Lists.size, 0);
        const op = f.adapter.operations.get(start.opId);
        assert.deepEqual(op.result.bm25.hits, []);
        assert.deepEqual(JSON.parse(f.adapter.bm25QueryReady(start.opId)).bm25.hits, []);
        assert.equal(op.result, null);
    } finally {
        await f.kit.rollbackTransaction(db.storeId, tx);
    }
});

test('host stops after the SDK query crossing the search deadline', options, async (t) => {
    const f = arkDataFixture();
    const db = new BM25IndexDBArkdata(f.directory + '/deadline.db', f.kit);
    t.after(async () => {
        await db.close();
        f.cleanup();
    });
    await db.initialize();
    const tx = await f.kit.beginTransaction(db.storeId, { mode: 'read' });
    let now = Date.now();
    f.control.clock.now = () => now;
    const deadline = now + 25_000;
    let queries = 0;
    f.control.before = async (op) => {
        if (op === 'query') {
            queries++;
            now = deadline + 1;
        }
    };
    try {
        await assert.rejects(
            f.kit.bm25Query(
                db.storeId,
                { kind: 'search', field: 'text', terms: ['q'], topK: 1, pageSize: 8, deadline },
                tx.id
            ),
            { code: 'bm25_search_timeout' }
        );
        assert.equal(queries, 1);
    } finally {
        await f.kit.rollbackTransaction(db.storeId, tx);
    }
});
