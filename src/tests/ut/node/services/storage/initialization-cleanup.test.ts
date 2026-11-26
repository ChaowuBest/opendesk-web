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
let originalError = new Error('synthetic initialization failure');
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
const { SqliteVecLoadError, getStorageInitializationFailure } =
    await import('../../../../../main/services/storage/platform.js');

for (const Database of [VectorIndexDB, ChunkIndexDB]) {
    for (const failureStage of ['load', 'pragma', 'table']) {
        for (const failingClose of [false, true]) {
            test(`${Database.name}: ${failureStage} failure closes connection; close throws=${failingClose}`, () => {
                stage = failureStage;
                originalError = new Error('synthetic initialization failure');
                closeFails = failingClose;
                closeCalls = 0;
                let received: unknown;
                assert.throws(
                    () => new Database(path.join(profile, 'index.db'), 2),
                    (error: unknown) => {
                        received = error;
                        return failureStage === 'load'
                            ? error instanceof SqliteVecLoadError && error.cause === originalError
                            : error === originalError;
                    }
                );
                assert.equal(closeCalls, 1);
                const failure = getStorageInitializationFailure(received)!;
                assert.equal(failure.indexer, Database === VectorIndexDB ? 'VectorIndexer' : 'ChunkIndexer');
                assert.equal(failure.backend, 'native');
                assert.equal(failure.cause, originalError);
                assert.equal(failure.cleanupFailures.length, failingClose ? 1 : 0);
            });
        }
    }
}

const names = ['vectorIndexer', 'baseIndexer', 'bm25Indexer', 'tagIndexer', 'chunkIndexer'];
for (const failingIndex of [0, 2, 4]) {
    test(`BaseStorage cleans all indexers when initialization fails at ${names[failingIndex]}`, async () => {
        originalError = new Error('synthetic initialization failure');
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
        const failure = getStorageInitializationFailure(originalError)!;
        assert.equal(
            failure.indexer,
            ['VectorIndexer', 'BaseIndexer', 'BM25Indexer', 'TagIndexer', 'ChunkIndexer'][failingIndex]
        );
        assert.equal(failure.cause, originalError);
        assert.equal(failure.cleanupFailures.length, 1);
        assert.equal(failure.cleanupFailures[0].indexer, 'TagIndexer');
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
