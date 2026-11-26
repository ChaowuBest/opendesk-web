import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BaseStorage, type ColumnSchema } from '../../../../../main/services/storage/abstract-storage.js';
import { BaseIndexDBArkdata } from '../../../../../main/services/storage/base-index-db-arkdata.js';
import { setArkdataDatabaseKit } from '../../../../../main/services/storage/arkdata-bridge.js';
import { arkDataFixture } from './fixtures/arkdata-fixture.js';
import { BaseIndexDBWasm } from '../../../../../main/services/storage/base-index-db-wasm.js';

const schema: ColumnSchema = {
    columns: {
        item_id: { type: 'TEXT', nullable: false },
        item_type: { type: 'TEXT', nullable: false },
        filename: { type: 'TEXT', nullable: true }
    },
    needIndexers: {}
};
for (const backend of ['native', 'wasm', 'arkdata']) {
    if (backend === 'arkdata' && !process.env.OPENDESK_ARKDATA_ADAPTER_DIR) {
        test.skip('R13 ArkData requires production ArkTS sources', () => {});
        continue;
    }
    test(`${backend}: public BaseIndexer literal matching preserves wildcards, escapes and LIKE compatibility`, async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'literal-contains-'));
        const fixture = backend === 'arkdata' ? arkDataFixture() : null;
        if (fixture) {
            const query = fixture.kit.queryPrepared.bind(fixture.kit);
            // Model the observed bound-pattern and doubled-escape SDK defects.
            fixture.kit.queryPrepared = (id: string, sql: string, ...args: any[]) =>
                query(
                    id,
                    sql
                        .replaceAll(" LIKE ? ESCAPE '\\'", ' LIKE ?')
                        .replace(
                            /LIKE '((?:[^']|'')*)' ESCAPE '\\'/g,
                            (_clause, pattern: string) => `LIKE '${pattern.replaceAll('\\\\', '')}' ESCAPE '\\'`
                        ),
                    ...args
                );
        }
        const previousKit = fixture ? setArkdataDatabaseKit(fixture.kit) : null;
        const storage = new BaseStorage('literal', schema, directory);
        try {
            await storage.initialize();
            if (backend === 'wasm') {
                const base = (storage as any).baseIndexer;
                await base.db.close();
                base.db = new BaseIndexDBWasm(path.join(directory, 'wasm.db'), schema);
            }
            if (fixture) {
                const base = (storage as any).baseIndexer;
                await base.db.close();
                base.db = new BaseIndexDBArkdata(path.join(directory, 'arkdata.db'), schema);
                await base.db.initialize();
            }
            const names = [
                '100%.txt',
                '100A.txt',
                'invoice_2026.txt',
                'invoiceX2026.txt',
                String.raw`literal\name.txt`,
                '报告.txt',
                "x' OR 1=1 --.txt",
                'A1.txt',
                null,
                '报告_%.txt',
                "O'Reilly%_\\name.txt",
                "x' OR 1=1 --%.txt"
            ];
            await storage.insert(names.map((filename, i) => ({ item_id: String(i), item_type: 'file', filename })));
            const cases: [string, string[]][] = [
                ['%', ['100%.txt', '报告_%.txt', "O'Reilly%_\\name.txt", "x' OR 1=1 --%.txt"]],
                ['_', ['invoice_2026.txt', '报告_%.txt', "O'Reilly%_\\name.txt"]],
                ['\\', [String.raw`literal\name.txt`, "O'Reilly%_\\name.txt"]],
                ['100%', ['100%.txt']],
                ['invoice_', ['invoice_2026.txt']],
                ['a1', ['A1.txt']],
                ["x' OR 1=1 --", ["x' OR 1=1 --.txt", "x' OR 1=1 --%.txt"]],
                ["x' OR 1=1 --%", ["x' OR 1=1 --%.txt"]],
                ["O'Reilly%_\\", ["O'Reilly%_\\name.txt"]],
                ['_%', ['报告_%.txt']],
                ['absent', []]
            ];
            for (const [value, expected] of cases) {
                const result = await storage.search([
                    { indexer: 'BaseIndexer', field: 'filename', operator: 'contains_literal', value }
                ]);
                assert.deepEqual(result.items.map((row) => row.item.filename).sort(), expected.sort(), value);
            }
            if (fixture) {
                const db = (storage as any).baseIndexer.db;
                const mixed = [
                    {
                        or: [
                            { field: 'filename', operator: 'contains_literal', value: '100%' },
                            { field: 'filename', operator: 'contains_literal', value: 'a1' }
                        ]
                    }
                ];
                assert.deepEqual((await db.search(mixed)).map((row: any) => row.filename).sort(), [
                    '100%.txt',
                    'A1.txt'
                ]);
                assert.equal(await db.count(mixed), 2);
                const ordinary = db.buildWhereClause([
                    { field: 'filename', operator: 'contains_literal', value: "a'b" }
                ]);
                assert.deepEqual(ordinary, { whereClause: "filename LIKE ? ESCAPE '\\'", params: ["%a'b%"] });
                const nul = db.buildWhereClause([{ field: 'filename', operator: 'contains_literal', value: '%\0' }]);
                assert.equal(nul.params.length, 1, 'NUL remains bound, never embedded into SQL text');
                assert.ok(!nul.whereClause.includes('\0'));
            }
            const legacy = await storage.search([
                { indexer: 'BaseIndexer', field: 'filename', operator: 'like', value: '%_%' }
            ]);
            assert.equal(legacy.items.length, names.length - 1);
            for (const value of [null, 1, [], {}]) {
                await assert.rejects(
                    () =>
                        storage.search([
                            { indexer: 'BaseIndexer', field: 'filename', operator: 'contains_literal', value }
                        ]),
                    /requires a string/
                );
            }
            if (fixture) {
                const value = "sp ace!^#%_\\\n?quote'";
                await storage.insert([{ item_id: 'mixed-ascii', item_type: 'file', filename: value + '.txt' }]);
                const actual = await storage.search([
                    { indexer: 'BaseIndexer', field: 'filename', operator: 'contains_literal', value }
                ]);
                assert.deepEqual(
                    actual.items.map((row) => row.item.item_id),
                    ['mixed-ascii']
                );
                const db = (storage as any).baseIndexer.db;
                const allAscii = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('');
                const fallback = db.buildWhereClause([
                    { field: 'filename', operator: 'contains_literal', value: allAscii }
                ]);
                assert.equal(fallback.params.length, 1, 'No available ASCII escape retains the legacy binding');
            }
        } finally {
            await storage.close();
            if (fixture) {
                setArkdataDatabaseKit(previousKit);
                fixture.cleanup();
            }
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
}
