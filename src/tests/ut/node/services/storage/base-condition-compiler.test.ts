import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { BaseIndexDB } from '../../../../../main/services/storage/base-index-db.js';
import { BaseIndexDBWasm } from '../../../../../main/services/storage/base-index-db-wasm.js';
import { BaseIndexDBArkdata } from '../../../../../main/services/storage/base-index-db-arkdata.js';
import { BaseIndexDBHm } from '../../../../../main/services/storage/base-index-db-hm.js';

test('BaseIndexer and each backend load independently in a fresh process', () => {
    for (const name of [
        'base-indexer',
        'base-index-db',
        'base-index-db-wasm',
        'base-index-db-arkdata',
        'base-index-db-hm'
    ]) {
        const url = new URL(`../../../../../main/services/storage/${name}.ts`, import.meta.url).href;
        execFileSync(
            process.execPath,
            ['--import', 'tsx', '--input-type=module', '-e', `await import(${JSON.stringify(url)});`],
            {
                timeout: 15_000,
                stdio: 'pipe'
            }
        );
    }
});

for (const DB of [BaseIndexDB, BaseIndexDBWasm, BaseIndexDBArkdata, BaseIndexDBHm]) {
    // Only exercise SQL compilation: no constructors, bridges, device access or databases.
    const compiler = Object.assign(Object.create(DB.prototype), {
        validFields: ['filename', 'ref_count', 'modified']
    });
    test(`${DB.name}: OR compilation retains grouping, binding order and outer AND`, () => {
        const result = compiler.buildWhereClause([
            { field: 'ref_count', operator: '>', value: 0 },
            {
                or: [
                    { field: 'filename', operator: 'like', value: "%x' OR 1=1 --%" },
                    { field: 'modified', operator: 'between', value: [10, 20] }
                ]
            },
            {
                or: [
                    { field: 'filename', operator: '=', value: 'memo' },
                    { field: 'filename', operator: 'in', value: ['a', 'b'] }
                ]
            }
        ]);
        assert.deepEqual(result, {
            whereClause:
                'ref_count > ? AND (filename LIKE ? OR modified BETWEEN ? AND ?) AND (filename = ? OR filename IN (?, ?))',
            params: [0, "%x' OR 1=1 --%", 10, 20, 'memo', 'a', 'b']
        });
        assert.deepEqual(compiler.buildWhereClause([{ or: [{ field: 'filename', operator: '=', value: 'a' }] }]), {
            whereClause: '(filename = ?)',
            params: ['a']
        });
        for (const condition of [
            { or: [] },
            { or: [{ or: [{ field: 'filename', operator: '=', value: 'a' }] }] },
            { or: [{ field: 'unknown', operator: '=', value: 'a' }] }
        ])
            assert.throws(() => compiler.buildWhereClause([condition]));
    });
    test(`${DB.name}: literal contains escapes user characters without changing LIKE`, () => {
        assert.deepEqual(
            compiler.buildWhereClause([
                {
                    or: [
                        { field: 'filename', operator: 'contains_literal', value: String.raw`a\b_100%'` },
                        { field: 'filename', operator: 'contains_literal', value: '报告' }
                    ]
                },
                { field: 'filename', operator: 'like', value: '%_%' }
            ]),
            {
                whereClause:
                    DB === BaseIndexDBArkdata
                        ? String.raw`(filename LIKE '%a\b _100 %''%' ESCAPE ' ' OR filename LIKE ? ESCAPE '\') AND filename LIKE ?`
                        : "(filename LIKE ? ESCAPE '\\' OR filename LIKE ? ESCAPE '\\') AND filename LIKE ?",
                params: DB === BaseIndexDBArkdata ? ['%报告%', '%_%'] : [String.raw`%a\\b\_100\%'%`, '%报告%', '%_%']
            }
        );
        for (const value of [null, 1, [], {}]) {
            assert.throws(
                () => compiler.buildWhereClause([{ field: 'filename', operator: 'contains_literal', value }]),
                /requires a string/
            );
        }
    });
}
