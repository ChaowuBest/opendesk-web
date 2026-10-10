import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setCustomOpendeskDirectory } from '../../../../../main/utils/setting.js';

const { BaseIndexDB } = await import('../../../../../main/services/storage/base-index-db.js');
const { TagIndexDB } = await import('../../../../../main/services/storage/tag-index-db.js');
const { TagIndexDBWasm } = await import('../../../../../main/services/storage/tag-index-db-wasm.js');
const require = createRequire(import.meta.url);
const Native = require('better-sqlite3'),
    Wasm = require('node-sqlite3-wasm').Database;
const profile = fs.mkdtempSync('/private/tmp/filemgr-constructor-cleanup-');
setCustomOpendeskDirectory(profile);
after(() => fs.rmSync(profile, { recursive: true, force: true }));
const schema = {
    columns: { item_id: { type: 'TEXT', nullable: false }, item_type: { type: 'TEXT', nullable: false } },
    needIndexers: {}
};
for (const [name, Driver, method, construct] of [
    ['native-base', Native, 'exec', (file: string) => new BaseIndexDB(file, schema as any)],
    ['native-tag', Native, 'exec', (file: string) => new TagIndexDB(file)],
    ['wasm-tag', Wasm, 'run', (file: string) => new TagIndexDBWasm(file)]
] as const)
    test(`${name}: table initialization failure releases the newly opened connection`, (t) => {
        let captured: any,
            closes = 0;
        const raw = Driver.prototype[method],
            release = Driver.prototype.close;
        t.mock.method(Driver.prototype, method, function (this: any, sql: string, ...args: any[]) {
            if (sql.includes('CREATE TABLE')) {
                captured = this;
                throw new Error('isolated constructor setup failure');
            }
            return raw.apply(this, [sql, ...args]);
        });
        t.mock.method(Driver.prototype, 'close', function (this: any, ...args: any[]) {
            if (this === captured) closes++;
            return release.apply(this, args);
        });
        try {
            assert.throws(() => construct(path.join(profile, name + '.db')), /isolated constructor setup failure/);
            console.log(JSON.stringify({ name, closes, isOpen: captured?.open }));
            assert.equal(closes, 1, 'The failed factory cannot hand this connection to BaseStorage.close');
        } finally {
            if (captured) {
                try {
                    release.call(captured);
                } catch {}
            }
        }
    });
