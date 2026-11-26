import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BaseIndexDB } from '../../../../../main/services/storage/base-index-db.js';
import { BaseIndexDBWasm } from '../../../../../main/services/storage/base-index-db-wasm.js';
import { BaseIndexDBArkdata } from '../../../../../main/services/storage/base-index-db-arkdata.js';
import { setArkdataDatabaseKit } from '../../../../../main/services/storage/arkdata-bridge.js';
import { pathDescendantOrSelfSqlValues } from '../../../../../main/services/storage/path-scope.js';
import { arkDataFixture } from './fixtures/arkdata-fixture.js';

const schema: any = {
    columns: {
        item_id: { type: 'TEXT', nullable: false },
        item_type: { type: 'TEXT', nullable: false },
        category: { type: 'TEXT' }
    },
    needIndexers: {}
};
for (const backend of ['native', 'wasm', 'arkdata'] as const) {
    if (backend === 'arkdata' && !process.env.OPENDESK_ARKDATA_ADAPTER_DIR) {
        test.skip('R07 ArkData requires production ArkTS sources', () => {});
        continue;
    }
    test(`R07 ${backend}: complete path lists and counts match original equality/LIKE semantics`, async (t) => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'base-scope-'));
        const f = backend === 'arkdata' ? arkDataFixture() : null;
        const previous = f ? setArkdataDatabaseKit(f.kit) : null;
        const db: any =
            backend === 'native'
                ? new BaseIndexDB(path.join(directory, 'base.db'), schema)
                : backend === 'wasm'
                  ? new BaseIndexDBWasm(path.join(directory, 'base.db'), schema)
                  : new BaseIndexDBArkdata(path.join(directory, 'base.db'), schema);
        t.after(async () => {
            await db.close();
            if (f) {
                setArkdataDatabaseKit(previous);
                f.cleanup();
            }
            fs.rmSync(directory, { recursive: true, force: true });
        });
        if (backend === 'arkdata') await db.initialize();
        const ids = [
            '/',
            '/Docs',
            '/docs',
            '/DOCS/child',
            '/docs/a',
            '/docs2/a',
            '/docs/sub/a',
            '/资料/文档/a',
            '/资料/文档2/a',
            'C:/',
            'C:/Docs/a',
            'c:/docs/b',
            '/百分%/a',
            '/下划_/a',
            '/反斜\\/a',
            '/nul\0suffix/a',
            '/emoji😀/a'
        ];
        for (let i = 0; i < 120; i++) ids.push(`/docs/source-${i % 10}/${i % 2 ? '子目录' : 'A'}/file-${i}`);
        for (const [i, id] of ids.entries())
            await db.insert({ item_id: id, item_type: 'file', category: i % 3 ? 'kept' : 'other' });
        const raw = (sql: string, params: any[]) =>
            backend === 'native'
                ? db.db.prepare(sql).all(...params)
                : backend === 'wasm'
                  ? db.db.all(sql, params)
                  : db.runSelect(sql, params);
        for (const roots of [
            ['/Docs'],
            ['/docs/'],
            ['/资料/文档'],
            ['/'],
            ['C:/'],
            ['/百分%'],
            ['/下划_'],
            ['/反斜\\'],
            ['/nul\0suffix'],
            ['/emoji😀'],
            ['/docs', '/docs/sub', '/docs']
        ]) {
            const values = roots.flatMap((root) => pathDescendantOrSelfSqlValues(root));
            const legacy = roots.map(() => "(item_id = ? OR item_id LIKE ? ESCAPE '\\')").join(' OR ');
            const expected = await raw(
                `SELECT item_id FROM base_index WHERE (${legacy}) AND category=? ORDER BY item_id`,
                [...values, 'kept']
            );
            const conditions = [
                { field: 'item_id', operator: 'path_descendant_or_self', value: roots },
                { field: 'category', operator: '=', value: 'kept' }
            ];
            const actual = await db.search(conditions, { orderBy: { field: 'item_id', direction: 'ASC' } });
            assert.deepEqual(
                actual.map((r: any) => r.item_id),
                expected.map((r: any) => r.item_id),
                JSON.stringify(roots)
            );
            assert.equal(await db.count(conditions), expected.length);
        }
        const compiled = db.buildWhereClause([
            { field: 'item_id', operator: 'path_descendant_or_self', value: '/docs/source-3' }
        ]);
        assert.equal(compiled.params.length, 2, 'R07 rollback retains only the original equality/LIKE parameters');
        assert.doesNotMatch(compiled.whereClause, />=|item_id\s*</, 'no coarse path bounds remain');
        const fallback = db.buildWhereClause([
            { field: 'item_id', operator: 'path_descendant_or_self', value: '/百分%' }
        ]);
        assert.equal(
            fallback.params.length,
            backend === 'arkdata' ? 1 : 2,
            'ArkData quotes only escaped LIKE patterns'
        );
    });
}

if (process.env.OPENDESK_ARKDATA_ADAPTER_DIR) {
    test('R13 ArkData escaped directory scopes retain self, descendants, boundaries and counts', async (t) => {
        const f = arkDataFixture();
        const query = f.kit.queryPrepared.bind(f.kit);
        f.kit.queryPrepared = (id: string, sql: string, ...args: any[]) =>
            query(id, sql.replaceAll(" LIKE ? ESCAPE '\\'", ' LIKE ?'), ...args);
        const previous = setArkdataDatabaseKit(f.kit);
        const db = new BaseIndexDBArkdata(path.join(f.directory, 'scope.db'), schema);
        t.after(async () => {
            await db.close();
            setArkdataDatabaseKit(previous);
            f.cleanup();
        });
        await db.initialize();
        for (const root of ['/percent%', '/under_', '/back\\slash', "/quote'_% OR 1=1 --"]) {
            for (const id of [root, `${root}/child`, `${root}/nested/a`, `${root}2/child`]) {
                await db.insert({ item_id: id, item_type: 'file', category: 'kept' });
            }
            const conditions: any = [
                {
                    or: [
                        { field: 'item_id', operator: 'path_descendant_or_self', value: root },
                        { field: 'item_id', operator: '=', value: '/absent' }
                    ]
                },
                { field: 'category', operator: '=', value: 'kept' }
            ];
            const actual = await db.search(conditions);
            assert.deepEqual(
                actual.map((row) => row.item_id).sort(),
                [root, `${root}/child`, `${root}/nested/a`].sort()
            );
            assert.equal(await db.count(conditions), 3);
        }
    });
}
