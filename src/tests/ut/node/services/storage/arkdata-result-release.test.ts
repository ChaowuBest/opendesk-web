import assert from 'node:assert/strict';
import { test } from 'node:test';
import { arkDataFixture, tick, deferred } from './fixtures/arkdata-fixture.js';
import { setArkdataDatabaseKit } from '../../../../../main/services/storage/arkdata-bridge.js';
import { BaseIndexDBArkdata } from '../../../../../main/services/storage/base-index-db-arkdata.js';
import { VectorIndexDBArkdata } from '../../../../../main/services/storage/vector-index-db-arkdata.js';
import { ChunkIndexDBArkdata } from '../../../../../main/services/storage/chunk-index-db-arkdata.js';

const parameter = (value: string) => [{ t: 'scalar' as const, v: value }];
const rowsInHost = (f: ReturnType<typeof arkDataFixture>) =>
    [...f.adapter.operations.values()].reduce((n, op) => n + (op.result?.rows?.length ?? 0), 0);

if (!process.env.OPENDESK_ARKDATA_ADAPTER_DIR) {
    test.skip('R11 requires actual ArkTS sources via OPENDESK_ARKDATA_ADAPTER_DIR', () => {});
} else {
    for (const [name, create] of [
        [
            'Base',
            (file: string) =>
                new BaseIndexDBArkdata(file, {
                    columns: {
                        item_id: { type: 'TEXT', nullable: false },
                        item_type: { type: 'TEXT', nullable: false }
                    },
                    needIndexers: {}
                } as any)
        ],
        ['Vector', (file: string) => new VectorIndexDBArkdata(file, 2)],
        ['Chunk', (file: string) => new ChunkIndexDBArkdata(file, 2)]
    ] as const) {
        test(`R11 ${name} actual runSelect releases legacy rows on ClosePrepared`, async (t) => {
            const f = arkDataFixture();
            t.after(() => {
                setArkdataDatabaseKit(null);
                f.cleanup();
            });
            setArkdataDatabaseKit(f.kit);
            const db = create(f.directory + '/' + name + '.db');
            await (db as any).ensureInitialized();
            const rows = await (db as any).runSelect('SELECT 12 AS value');
            assert.deepEqual(rows, [{ value: 12 }]);
            assert.equal(rowsInHost(f), 0, 'legacy cached rows must be released before TTL');
            const op = [...f.adapter.operations.values()].filter((op) => op.type === 'executePrepared').at(-1);
            const replay = JSON.parse(f.adapter.executePreparedReady(op.opId));
            assert.equal(replay.ok, false, 'released Ready must never look like successful empty rows');
            assert.equal(replay.error.code, 'sql_result_released');
            const gate = deferred();
            f.control.before = async (operation) => {
                if (operation === 'legacy-query') await gate.promise;
            };
            let now = Date.now();
            f.control.clock.now = () => now;
            const ready = f.bindings.get('ArkData.ExecutePreparedReady')!;
            f.bindings.set('ArkData.ExecutePreparedReady', (...args) => {
                const response = ready(...args);
                if (JSON.parse(response).state === 'pending') now += 31_001;
                return response;
            });
            await assert.rejects((db as any).runSelect('SELECT 13 AS value'), { code: 'operation_timeout' });
            const pending = [...f.adapter.operations.values()].filter((op) => op.type === 'executePrepared').at(-1);
            assert.equal(pending.state, 'pending');
            assert.equal(pending.closeRequested, true, 'production timeout finally must request deferred close');
            assert.notEqual(pending.resultReleased, true);
            gate.resolve();
            await tick();
            assert.equal(pending.resultReleased, true);
            assert.equal(rowsInHost(f), 0);
            await db.close();
        });
    }

    test('R11 legacy ClosePrepared while SDK pending defers release until execution and cleanup settle', async (t) => {
        const f = arkDataFixture();
        t.after(() => f.cleanup());
        await f.kit.openStore('pending', { path: f.directory + '/pending.db', vector: true });
        const gate = deferred();
        f.control.before = async (operation) => {
            if (operation === 'legacy-query') await gate.promise;
        };
        const begin = JSON.parse(f.adapter.beginPrepared('pending', 'SELECT 9 AS value'));
        f.adapter.bindParams(begin.statementId, '[]');
        const start = JSON.parse(f.adapter.executePreparedStart('pending', begin.statementId));
        assert.equal(JSON.parse(f.adapter.closePrepared(begin.statementId)).ok, true);
        const op = f.adapter.operations.get(start.opId);
        assert.equal(op.state, 'pending');
        assert.notEqual(op.resultReleased, true);
        gate.resolve();
        await tick();
        assert.equal(op.state, 'success');
        assert.equal(op.resultReleased, true);
        assert.equal(rowsInHost(f), 0);
        await f.kit.closeStore('pending');
    });

    test('R11 legacy failed ResultSet cleanup retains rows until a successful close retry', async (t) => {
        const f = arkDataFixture();
        t.after(() => f.cleanup());
        await f.kit.openStore('cleanup', { path: f.directory + '/cleanup.db', vector: true });
        f.control.closeResultSet = () => {
            throw new Error('SDK ResultSet close failed');
        };
        const begin = JSON.parse(f.adapter.beginPrepared('cleanup', 'SELECT 10 AS value'));
        f.adapter.bindParams(begin.statementId, '[]');
        const start = JSON.parse(f.adapter.executePreparedStart('cleanup', begin.statementId));
        await tick();
        assert.equal(JSON.parse(f.adapter.closePrepared(begin.statementId)).ok, false);
        const op = f.adapter.operations.get(start.opId);
        assert.equal(op.resultReleased, undefined);
        assert.equal(rowsInHost(f), 1);
        f.adapter.gcTerminalOperations(Date.now() + 6 * 60_000);
        assert.ok(f.adapter.operations.has(op.opId), 'cleanup failure must survive TTL');
        f.control.closeResultSet = () => {};
        assert.equal(JSON.parse(f.adapter.closePrepared(begin.statementId)).ok, true);
        assert.equal(rowsInHost(f), 0);
        await f.kit.closeStore('cleanup');
    });

    test('R11 legacy force close cannot release an SDK call merely retired from public polling', async (t) => {
        const f = arkDataFixture();
        t.after(() => f.cleanup());
        await f.kit.openStore('force-pending', { path: f.directory + '/force.db', vector: true });
        const gate = deferred();
        f.control.before = async (operation) => {
            if (operation === 'legacy-query') await gate.promise;
        };
        const begin = JSON.parse(f.adapter.beginPrepared('force-pending', 'SELECT 11 AS value'));
        f.adapter.bindParams(begin.statementId, '[]');
        const start = JSON.parse(f.adapter.executePreparedStart('force-pending', begin.statementId));
        await f.kit.closeStore('force-pending', { force: true });
        const op = f.adapter.operations.get(start.opId);
        assert.equal(op.state, 'error');
        assert.equal(op.sdkPending, true);
        assert.notEqual(op.resultReleased, true);
        f.adapter.gcTerminalOperations(Date.now() + 6 * 60_000);
        assert.ok(f.adapter.operations.has(op.opId));
        gate.resolve();
        await tick();
        assert.equal(op.sdkPending, false);
        assert.equal(op.resultReleased, true);
        assert.equal(JSON.parse(f.adapter.executePreparedReady(op.opId)).error.code, 'store_force_closed');
    });

    test('R11 legacy session close retries failed ResultSet cleanup and preserves SDK error facts', async (t) => {
        const f = arkDataFixture();
        t.after(() => f.cleanup());
        await f.kit.openStore('close-retry', { path: f.directory + '/close-retry.db', vector: true });
        f.control.closeResultSet = () => {
            throw Object.assign(new Error('SDK close failure'), { code: 14800012 });
        };
        await assert.rejects(f.kit.queryPrepared('close-retry', 'SELECT 14 AS value', []), (error: any) => {
            assert.equal(error.code, 'result_set_close_failed');
            assert.equal(error.details.sdkErrorCode, 14800012);
            return true;
        });
        await assert.rejects(f.kit.closeStore('close-retry'), { code: 'result_set_close_failed' });
        assert.equal(rowsInHost(f), 1);
        f.control.closeResultSet = () => {};
        await f.kit.closeStore('close-retry');
        assert.equal(rowsInHost(f), 0);
        assert.equal(f.adapter.preparedOperations.size, 0);
    });
    test('R11 legacy force close retains physical ownership across failures and repeated statement close', async (t) => {
        const f = arkDataFixture();
        t.after(() => f.cleanup());
        await f.kit.openStore('force-retries', { path: f.directory + '/force-retries.db', vector: true });
        const tx = await f.kit.beginTransaction('force-retries');
        await f.kit.executePrepared('force-retries', 'CREATE TABLE old_data(value TEXT)', [], { txId: tx.id });
        const op = [...f.adapter.operations.values()].filter((op) => op.type === 'executePrepared').at(-1)!;
        assert.equal(op.resultReleased, undefined);
        const gate = deferred();
        let attempts = 0;
        f.control.before = async (operation) => {
            if (operation !== 'close') return;
            if (++attempts < 3) throw new Error('isolated force-close failure');
            await gate.promise;
        };
        for (let n = 0; n < 2; n++) {
            await assert.rejects(f.kit.closeStore('force-retries', { force: true }), { code: 'store_close_failed' });
            f.adapter.closePrepared(op.statementId!);
            assert.notEqual(op.resultReleased, true, 'cleared transaction maps do not prove physical close');
            assert.equal(f.adapter.preparedOperations.get(op.statementId!), op);
        }
        const closing = f.kit.closeStore('force-retries', { force: true });
        await tick();
        assert.equal(attempts, 3);
        f.adapter.closePrepared(op.statementId!);
        assert.notEqual(op.resultReleased, true, 'second-generation retry still protects the first physical instance');
        f.adapter.gcTerminalOperations(Date.now() + 6 * 60_000);
        assert.ok(f.adapter.operations.has(op.opId));
        gate.resolve();
        await closing;
        assert.equal(op.resultReleased, true);
        assert.equal(f.adapter.preparedOperations.has(op.statementId!), false);
        f.adapter.gcTerminalOperations(Date.now() + 12 * 60_000);
        assert.equal(f.adapter.operations.has(op.opId), false);
    });

    test('R11 legacy force close releases the old SDK callback without touching a reopened store', async (t) => {
        const f = arkDataFixture();
        t.after(() => f.cleanup());
        const store = 'force-reopen';
        await f.kit.openStore(store, { path: f.directory + '/force-reopen.db', vector: true });
        const gate = deferred();
        let delayFirst = true;
        f.control.before = async (operation) => {
            if (operation === 'legacy-query' && delayFirst) {
                delayFirst = false;
                await gate.promise;
            }
        };
        const begin = JSON.parse(f.adapter.beginPrepared(store, 'SELECT 11 AS value'));
        f.adapter.bindParams(begin.statementId, '[]');
        const start = JSON.parse(f.adapter.executePreparedStart(store, begin.statementId));
        await f.kit.closeStore(store, { force: true });
        const old = f.adapter.operations.get(start.opId)!;
        assert.equal(old.sdkPending, true);
        await f.kit.openStore(store, { path: f.directory + '/force-reopen.db', vector: true });
        const next = JSON.parse(f.adapter.beginPrepared(store, 'SELECT 12 AS value'));
        f.adapter.bindParams(next.statementId, '[]');
        const query = JSON.parse(f.adapter.executePreparedStart(store, next.statementId));
        await tick();
        const current = f.adapter.operations.get(query.opId)!;
        assert.deepEqual(current.result.rows, [{ value: 12 }]);
        assert.notEqual(current.resultReleased, true);
        gate.resolve();
        await tick();
        assert.equal(old.resultReleased, true);
        assert.notEqual(current.resultReleased, true);
        assert.equal(f.adapter.preparedOperations.get(next.statementId), current);
        f.adapter.closePrepared(next.statementId);
        await f.kit.closeStore(store);
    });

    test('R11 legacy force close preserves a failed ResultSet cleanup for explicit retry', async (t) => {
        const f = arkDataFixture();
        t.after(() => f.cleanup());
        await f.kit.openStore('force-rs', { path: f.directory + '/force-rs.db', vector: true });
        f.control.closeResultSet = () => {
            throw new Error('isolated ResultSet close failure');
        };
        const begin = JSON.parse(f.adapter.beginPrepared('force-rs', 'SELECT 17 AS value'));
        f.adapter.bindParams(begin.statementId, '[]');
        const start = JSON.parse(f.adapter.executePreparedStart('force-rs', begin.statementId));
        await tick();
        const op = f.adapter.operations.get(start.opId)!;
        await f.kit.closeStore('force-rs', { force: true });
        assert.notEqual(op.resultReleased, true);
        assert.equal(f.adapter.preparedOperations.get(begin.statementId), op);
        f.control.closeResultSet = () => {};
        assert.equal(JSON.parse(f.adapter.closePrepared(begin.statementId)).ok, true);
        assert.equal(op.resultReleased, true);
        assert.equal(f.adapter.preparedOperations.has(begin.statementId), false);
        f.adapter.gcTerminalOperations(Date.now() + 6 * 60_000);
        assert.equal(f.adapter.operations.has(op.opId), false);
    });

    test('R11 legacy force close releases already-completed active-transaction operations without another callback', async (t) => {
        const f = arkDataFixture();
        t.after(() => f.cleanup());
        await f.kit.openStore('force-complete', { path: f.directory + '/force-complete.db', vector: true });
        const tx = await f.kit.beginTransaction('force-complete');
        await f.kit.executePrepared('force-complete', 'CREATE TABLE retained(value TEXT)', [], { txId: tx.id });
        const op = [...f.adapter.operations.values()].filter((op) => op.type === 'executePrepared').at(-1)!;
        const terminalAt = op.terminalAt;
        assert.notEqual(op.resultReleased, true);
        await f.kit.closeStore('force-complete', { force: true });
        assert.equal(op.resultReleased, true);
        assert.equal(op.terminalAt, terminalAt, 'force close does not restart the terminal TTL');
        assert.equal(f.adapter.preparedOperations.has(op.statementId!), false);
        f.adapter.gcTerminalOperations(Date.now() + 6 * 60_000);
        assert.equal(f.adapter.operations.has(op.opId), false);
    });
}
