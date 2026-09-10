import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setCustomOpendeskDirectory } from '../../../../../main/utils/setting.js';

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-init-cleanup-'));
setCustomOpendeskDirectory(profile);
after(() => fs.rmSync(profile, { recursive: true, force: true }));

const require = createRequire(import.meta.url);
require('better-sqlite3');
const bindingModule = require.cache[require.resolve('better-sqlite3')]!;
const originalDatabase = bindingModule.exports;
let stage = 'load';
let closeFails = false;
let closeCalls = 0;
const originalError = new Error('synthetic initialization failure');
class FakeDatabase {
    loadExtension() {
        if (stage === 'load') throw originalError;
    }
    pragma() {
        if (stage === 'pragma') throw originalError;
    }
    exec() {
        if (stage === 'table') throw originalError;
    }
    close() {
        closeCalls++;
        if (closeFails) throw new Error('synthetic close failure');
    }
}
bindingModule.exports = FakeDatabase;
after(() => {
    bindingModule.exports = originalDatabase;
});

const { BaseStorage } = await import('../../../../../main/services/storage/abstract-storage.js');
const { VectorIndexDB } = await import('../../../../../main/services/storage/vector-index-db.js');
const { ChunkIndexDB } = await import('../../../../../main/services/storage/chunk-index-db.js');
const { SqliteVecLoadError } = await import('../../../../../main/services/storage/platform.js');

for (const Database of [VectorIndexDB, ChunkIndexDB]) {
    for (const failureStage of ['load', 'pragma', 'table']) {
        for (const failingClose of [false, true]) {
            test(`${Database.name}: ${failureStage} failure closes connection; close throws=${failingClose}`, () => {
                stage = failureStage;
                closeFails = failingClose;
                closeCalls = 0;
                assert.throws(
                    () => new Database(path.join(profile, 'index.db'), 2),
                    (error: unknown) =>
                        failureStage === 'load'
                            ? error instanceof SqliteVecLoadError && error.cause === originalError
                            : error === originalError
                );
                assert.equal(closeCalls, 1);
            });
        }
    }
}

const names = ['vectorIndexer', 'baseIndexer', 'bm25Indexer', 'tagIndexer', 'chunkIndexer'];
for (const failingIndex of [0, 2, 4]) {
    test(`BaseStorage cleans all indexers when initialization fails at ${names[failingIndex]}`, async () => {
        const storage = Object.create(BaseStorage.prototype);
        const initialized: string[] = [];
        const closed: string[] = [];
        for (const name of names) {
            storage[name] = {
                async initialize() {
                    initialized.push(name);
                    if (name === names[failingIndex]) throw originalError;
                },
                close() {
                    closed.push(name);
                    if (name === 'tagIndexer') throw new Error('synthetic close failure');
                }
            };
        }
        await assert.rejects(
            () => storage.initialize(),
            (error: unknown) => error === originalError
        );
        assert.deepEqual(initialized, names.slice(0, failingIndex + 1));
        assert.deepEqual([...closed].sort(), [...names].sort());
    });
}

test('successful BaseStorage initialization does not close indexers', async () => {
    const storage = Object.create(BaseStorage.prototype);
    for (const name of names) {
        storage[name] = {
            async initialize() {},
            close() {
                assert.fail('successful initialization must retain resources');
            }
        };
    }
    await storage.initialize();
});
