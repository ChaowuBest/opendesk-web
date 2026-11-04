import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BaseStorage, type ColumnSchema } from '../../../../../main/services/storage/abstract-storage.js';
import { BaseIndexDBWasm } from '../../../../../main/services/storage/base-index-db-wasm.js';

const schema: ColumnSchema = {
    columns: {
        item_id: { type: 'TEXT', nullable: false },
        item_type: { type: 'TEXT', nullable: false },
        filename: { type: 'TEXT', nullable: true }
    },
    needIndexers: {}
};
for (const backend of ['native', 'wasm']) {
    test(`${backend}: public BaseIndexer literal matching preserves wildcards, escapes and LIKE compatibility`, async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'literal-contains-'));
        const storage = new BaseStorage('literal', schema, directory);
        try {
            await storage.initialize();
            if (backend === 'wasm') {
                const base = (storage as any).baseIndexer;
                await base.db.close();
                base.db = new BaseIndexDBWasm(path.join(directory, 'wasm.db'), schema);
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
                '报告_%.txt'
            ];
            await storage.insert(names.map((filename, i) => ({ item_id: String(i), item_type: 'file', filename })));
            const cases: [string, string[]][] = [
                ['%', ['100%.txt', '报告_%.txt']],
                ['_', ['invoice_2026.txt', '报告_%.txt']],
                ['\\', [String.raw`literal\name.txt`]],
                ['100%', ['100%.txt']],
                ['invoice_', ['invoice_2026.txt']],
                ['a1', ['A1.txt']],
                ["x' OR 1=1 --", ["x' OR 1=1 --.txt"]],
                ['_%', ['报告_%.txt']],
                ['absent', []]
            ];
            for (const [value, expected] of cases) {
                const result = await storage.search([
                    { indexer: 'BaseIndexer', field: 'filename', operator: 'contains_literal', value }
                ]);
                assert.deepEqual(result.items.map((row) => row.item.filename).sort(), expected.sort(), value);
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
        } finally {
            await storage.close();
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
}
