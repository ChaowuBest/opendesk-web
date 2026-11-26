import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import { createBM25IndexDB } from '../../../../../../main/services/storage/bm25-index-db-factory.js';
import { BaseStorage } from '../../../../../../main/services/storage/abstract-storage.js';
import { schema, record, item } from './bm25-fixture.js';

const [mode, directory] = process.argv.slice(2);
const pause = new Int32Array(new SharedArrayBuffer(4));
function wait(name: string) {
    const deadline = Date.now() + 20000;
    while (!fs.existsSync(path.join(directory, name))) {
        if (Date.now() > deadline) throw new Error(`BM25 process timeout: ${name}`);
        Atomics.wait(pause, 0, 0, 10);
    }
}
if (mode.startsWith('default')) {
    const loader = Module as unknown as { _load: (...args: any[]) => unknown };
    const original = loader._load;
    loader._load = function (request, ...args) {
        if ((mode === 'default-db-missing' || mode === 'default-db-delayed') && request === 'better-sqlite3') {
            const failure = Object.assign(new Error('Cannot find better_sqlite3.node'), { code: 'MODULE_NOT_FOUND' });
            if (mode === 'default-db-missing') throw failure;
            return class {
                constructor() {
                    throw failure;
                }
            };
        }
        if (mode === 'default-tokenizer-missing' && request === '@node-rs/jieba')
            throw Object.assign(new Error('Cannot find @node-rs/jieba'), { code: 'MODULE_NOT_FOUND' });
        return original.call(this, request, ...args);
    };
    const owner = new BaseStorage('default', schema, directory);
    try {
        await owner.initialize();
        await owner.upsert([item('default', '中文 hello')]);
        if ((await owner.searchBM25('hello', { field: 'text' })).length !== 1) throw new Error('default route failed');
        fs.writeFileSync(
            path.join(directory, 'default-result.json'),
            JSON.stringify((await owner.getStatus()).BM25Indexer)
        );
    } finally {
        await owner.close();
        loader._load = original;
    }
} else {
    if (mode === 'create') wait('go');
    const db = await createBM25IndexDB(
        schema,
        path.join(directory, 'bm25.db'),
        'readwrite',
        () => {
            throw new Error('cleanup');
        },
        { forceWasm: false }
    );
    try {
        if (mode === 'create-populate') db.upsert([record('competing', 'alpha')]);
        fs.writeFileSync(path.join(directory, `${mode}-started`), '');
        if (mode === 'snapshot') {
            wait('ready');
            db.upsert([record('new', 'alpha alpha')]);
            fs.writeFileSync(path.join(directory, 'released'), '');
        } else if (mode === 'busy') {
            db.driver.exec('BEGIN IMMEDIATE');
            fs.writeFileSync(path.join(directory, 'locked'), '');
            wait('unlock');
            db.driver.exec('ROLLBACK');
        }
    } finally {
        db.close();
    }
}
