import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { BaseIndexDB } from '../base-index-db.js';

async function testEnsureColumnsAddsMissing() {
    console.log('  testEnsureColumnsAddsMissing...');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensurecols-'));
    const dbPath = path.join(dir, 'b.db');

    const v1 = new BaseIndexDB(dbPath, {
        columns: { item_id: { type: 'TEXT' }, item_type: { type: 'TEXT' } },
        needIndexers: {}
    });
    await v1.insert({ item_id: 'a', item_type: 'file' });
    v1.close?.();

    const v2 = new BaseIndexDB(dbPath, {
        columns: {
            item_id: { type: 'TEXT' },
            item_type: { type: 'TEXT' },
            embedded: { type: 'INTEGER', nullable: false, defaultValue: 0 }
        },
        needIndexers: {}
    });
    const row = await v2.findById('a');
    assert.equal(row.embedded, 0, 'new column with DEFAULT 0 backfills existing rows');

    // idempotent — opening a third time must not throw
    const v3 = new BaseIndexDB(dbPath, {
        columns: {
            item_id: { type: 'TEXT' },
            item_type: { type: 'TEXT' },
            embedded: { type: 'INTEGER', nullable: false, defaultValue: 0 }
        },
        needIndexers: {}
    });
    assert.ok(v3);
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('  ✅ testEnsureColumnsAddsMissing');
}

async function main() {
    await testEnsureColumnsAddsMissing();
    console.log('=== Results: 1 passed ===');
}
main().catch((e) => {
    console.error(e);
    process.exit(1);
});
