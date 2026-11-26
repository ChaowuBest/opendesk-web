import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FSStorage } from '../../../../main/applications/filemgr/storage.js';

async function fixture(t: TestContext, count: number, content = '') {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'full-text-batch-'));
    const owner = new FSStorage(directory);
    await owner.initialize({ syncEmbedding: false });
    t.after(async () => {
        await owner.close();
        fs.rmSync(directory, { recursive: true, force: true });
    });
    const files = Array.from({ length: count }, (_, i) => {
        const file = path.join(directory, String(i).padStart(3, '0') + '.txt');
        fs.writeFileSync(file, content);
        const stat = fs.statSync(file);
        return {
            path: file,
            filename: path.basename(file),
            type: 'file',
            modified: Math.floor(stat.mtimeMs),
            size: stat.size
        };
    });
    await owner.saveFiles(files, directory);
    const batches: number[] = [];
    const upsert = owner.storage.upsert.bind(owner.storage);
    t.mock.method(owner.storage, 'upsert', async (items: any[], options: any) => {
        if (options?.indexers?.includes('BM25Indexer')) batches.push(items.length);
        return upsert(items, options);
    });
    const run = (yielding = () => false) => owner.processFullTextQueue(yielding, { activeRoots: [directory] });
    const rows = async () => (await owner.storage.search([])).items.map(({ item }: any) => item);
    return { owner, files, directory, batches, run, rows };
}
for (const count of [0, 1, 49, 50, 51]) {
    test(`R03 BM25 ${count} files use complete batches of at most 50`, async (t) => {
        const f = await fixture(t, count);
        assert.deepEqual(await f.run(), { outcome: 'completed', processed: count });
        assert.deepEqual(f.batches, count ? (count > 50 ? [50, 1] : [count]) : []);
        assert.ok((await f.rows()).every((row: any) => row.bm25 === 1));
    });
}
test('R03 accumulated text above 128 Ki characters does not split a business batch', async (t) => {
    const f = await fixture(t, 2, 'batchtoken '.repeat(8_000));
    assert.equal((await f.run()).processed, 2);
    assert.deepEqual(f.batches, [2]);
    assert.equal((await f.owner.searchFullText('batchtoken')).length, 2);
});
for (const phase of ['prepare', 'write', 'publish']) {
    test(`R03 ordinary pause during ${phase} finishes only the current batch`, async (t) => {
        const f = await fixture(t, 51);
        let pause = false;
        if (phase === 'prepare') {
            const stat = fs.promises.stat;
            t.mock.method(fs.promises, 'stat', async (...args: any[]) => {
                pause = true;
                return (stat as any)(...args);
            });
        } else {
            const method = phase === 'write' ? 'upsert' : 'update';
            const original = f.owner.storage[method].bind(f.owner.storage);
            t.mock.method(f.owner.storage, method, async (...args: any[]) => {
                pause = true;
                return original(...args);
            });
        }
        assert.deepEqual(await f.run(() => pause), { outcome: 'yielded', processed: 50 });
        assert.deepEqual(f.batches, [50]);
        assert.equal((await f.rows()).filter((row: any) => row.bm25 === 1).length, 50);
    });
}
test('R03 pause before batch start performs no extraction or writes', async (t) => {
    const f = await fixture(t, 3);
    assert.deepEqual(await f.run(() => true), { outcome: 'yielded', processed: 0 });
    assert.deepEqual(f.batches, []);
});
test('R03 generation change during BM25 write prevents old Base completion publication', async (t) => {
    const f = await fixture(t, 3, 'stale token');
    const upsert = f.owner.storage.upsert.bind(f.owner.storage);
    t.mock.method(f.owner.storage, 'upsert', async (...args: any[]) => {
        const result = await upsert(...args);
        f.owner.scannerState.bm25_generation++;
        return result;
    });
    assert.deepEqual(await f.run(), { outcome: 'stale', processed: 0 });
    assert.ok((await f.rows()).every((row: any) => row.bm25 === 0));
});
test('R03 changes to an earlier file while preparing the batch are not published', async (t) => {
    const f = await fixture(t, 3, 'original token');
    const stat = fs.promises.stat;
    let changed = false;
    t.mock.method(fs.promises, 'stat', async (...args: any[]) => {
        if (!changed && args[0] === f.files[1].path) {
            changed = true;
            fs.writeFileSync(f.files[0].path, 'a different and longer source');
        }
        return (stat as any)(...args);
    });
    assert.deepEqual(await f.run(), { outcome: 'completed', processed: 2 });
    assert.equal((await f.rows()).find((row: any) => row.item_id === f.files[0].path)!.bm25, 0);
});
test('R03 failed batch writes do not publish completion for any file', async (t) => {
    const f = await fixture(t, 3, 'failure token');
    t.mock.method(f.owner.storage, 'upsert', async () => {
        throw new Error('isolated batch write failure');
    });
    assert.deepEqual(await f.run(), { outcome: 'stopped', processed: 0 });
    assert.ok((await f.rows()).every((row: any) => row.bm25 === 0));
});
test('R03 extracted text above the character budget is written in smaller groups', async (t) => {
    const f = await fixture(t, 3, 'grouptoken '.repeat(27_300));
    assert.deepEqual(await f.run(), { outcome: 'completed', processed: 3 });
    assert.deepEqual(f.batches, [1, 1, 1]);
    assert.equal((await f.owner.searchFullText('grouptoken')).length, 3);
});
test('R03 a file larger than the character budget is written alone', async (t) => {
    const f = await fixture(t, 3, 'small token');
    fs.writeFileSync(f.files[2].path, 'largetoken '.repeat(60_000));
    const stat = fs.statSync(f.files[2].path);
    await f.owner.saveFiles([{ ...f.files[2], modified: Math.floor(stat.mtimeMs), size: stat.size }], f.directory);
    assert.deepEqual(await f.run(), { outcome: 'completed', processed: 3 });
    assert.deepEqual(f.batches, [2, 1]);
});
test('R03 a failed later group keeps earlier groups and leaves the rest pending', async (t) => {
    const f = await fixture(t, 3, 'grouptoken '.repeat(27_300));
    const upsert = f.owner.storage.upsert.bind(f.owner.storage);
    let calls = 0;
    t.mock.method(f.owner.storage, 'upsert', async (items: any[], options: any) => {
        if (options?.indexers?.includes('BM25Indexer') && ++calls === 2) throw new Error('second group failure');
        return upsert(items, options);
    });
    assert.deepEqual(await f.run(), { outcome: 'stopped', processed: 1 });
    const rows = await f.rows();
    assert.deepEqual(
        f.files.map((file) => rows.find((row: any) => row.item_id === file.path)!.bm25),
        [1, 0, 0]
    );
});
