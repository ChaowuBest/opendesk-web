import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { FSStorage } from '../../../../main/applications/filemgr/storage.js';
import {
    buildFullTextFile,
    truncateFullText
} from '../../../../main/applications/filemgr/document-retrieval/common/full-text-build.js';
import {
    FULL_TEXT_MAX_CHARS,
    isFullTextReady
} from '../../../../main/applications/filemgr/document-retrieval/common/full-text-state.js';
import { logger } from '../../../../main/utils/logger.js';

async function fixture(t: TestContext, extension = 'txt', content = 'wf2contenttoken') {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wf2-build-'));
    const fss = new FSStorage(directory);
    t.after(async () => {
        await fss.close();
        fs.rmSync(directory, { recursive: true, force: true });
    });
    await fss.initialize({ syncEmbedding: false });
    const file = path.join(directory, `document.${extension}`);
    fs.writeFileSync(file, content);
    const save = async () => {
        const stat = fs.statSync(file);
        await fss.saveFiles(
            [
                {
                    path: file,
                    filename: path.basename(file),
                    type: 'file',
                    modified: Math.floor(stat.mtimeMs),
                    size: stat.size,
                    created: Math.floor(stat.birthtimeMs),
                    accessed: Math.floor(stat.atimeMs)
                }
            ],
            directory
        );
    };
    await save();
    const row = async () =>
        (await fss.storage.search([{ indexer: 'BaseIndexer', field: 'item_id', operator: '=', value: file }])).items[0]
            .item;
    const search = (query: string) => fss.storage.searchBM25(query, { field: 'full_text', topK: 10 });
    const build = async () => buildFullTextFile(fss.storage, await row(), fss.scannerState.bm25_generation);
    return { fss, file, directory, save, row, build, search };
}

for (const extension of ['txt', 'md', 'docx']) {
    test(`full text builds ${extension} through the real parser without altering source or embedding fields`, async (t) => {
        const f = await fixture(t, extension);
        if (extension === 'docx') {
            const zip = new AdmZip();
            zip.addFile(
                'word/document.xml',
                Buffer.from(
                    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
                        '<w:body><w:p><w:r><w:t>wf2contenttoken</w:t></w:r></w:p></w:body></w:document>'
                )
            );
            zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types/>'));
            zip.writeZip(f.file);
            await f.save();
        }
        await f.fss.storage.update([{ item_id: f.file, item_type: 'file', embedded: 1, embedding_generation: 8 }], {
            indexers: ['BaseIndexer']
        });
        const before = await f.row();
        assert.equal((await f.build()).kind, 'completed');
        const after = await f.row();
        assert.equal(isFullTextReady(after, f.fss.scannerState.bm25_generation), true);
        for (const field of ['modified', 'size', 'embedded', 'embedding_generation'])
            assert.equal(after[field], before[field]);
        assert.equal(after.full_text, null);
        assert.deepEqual(
            (await f.search('wf2contenttoken')).map((hit) => hit.item_id),
            [f.file]
        );
    });
}

test('non-indexable formats complete without a BM25 record', async (t) => {
    const f = await fixture(t, 'json');
    assert.equal((await f.build()).kind, 'completed');
    assert.equal((await f.row()).bm25, 1);
    assert.deepEqual(await f.search('wf2contenttoken'), []);
});

test('empty text clears the previous record before publishing completion', async (t) => {
    const f = await fixture(t);
    await f.build();
    fs.writeFileSync(f.file, '');
    await f.save();
    assert.equal((await f.build()).kind, 'completed');
    assert.deepEqual(await f.search('wf2contenttoken'), []);
    assert.equal(isFullTextReady(await f.row(), f.fss.scannerState.bm25_generation), true);
});

test('parser null retries once per source version and generation', async (t) => {
    const f = await fixture(t, 'docx', 'invalid zip document');
    assert.equal((await f.build()).kind, 'failed');
    const first = await f.row();
    assert.equal(first.bm25, -1);
    assert.equal(first.bm25_modified, first.modified);
    assert.equal((await f.build()).kind, 'failed');
    assert.equal((await f.row()).bm25, -2);
    await f.fss.storage.update([{ item_id: f.file, item_type: 'file', bm25: -1, bm25_generation: 0 }], {
        indexers: ['BaseIndexer']
    });
    assert.equal((await f.build()).kind, 'failed');
    assert.equal((await f.row()).bm25, -1, 'old generation failure does not count toward this generation');
});

test('full text includes content after the embedding 64 Ki limit', async (t) => {
    const f = await fixture(t, 'txt', 'filler '.repeat(11_000) + ' wf2tailtoken');
    assert.equal((await f.build()).kind, 'completed');
    assert.equal((await f.search('wf2tailtoken')).length, 1);
});

test('full text truncation limits indexed content and does not split a surrogate pair', async (t) => {
    const prefix = 'wf2fronttoken ';
    const content = prefix + ' '.repeat(FULL_TEXT_MAX_CHARS - prefix.length - 1) + '😀 wf2pastlimittoken';
    const messages: string[] = [];
    t.mock.method(logger, 'warn', (message: string) => {
        messages.push(message);
        return logger;
    });
    assert.equal(truncateFullText(content, 'surrogate.txt').length, FULL_TEXT_MAX_CHARS - 1);
    const f = await fixture(t, 'txt', content);
    assert.equal((await f.build()).kind, 'completed');
    assert.equal((await f.search('wf2fronttoken')).length, 1);
    assert.deepEqual(await f.search('wf2pastlimittoken'), []);
    assert.ok(messages.some((message) => message.includes(f.file) && message.includes(String(content.length))));
});

test('missing files and mismatched versions are skipped without writes', async (t) => {
    const f = await fixture(t);
    const before = await f.row();
    assert.equal(
        (await buildFullTextFile(f.fss.storage, { ...before, modified: before.modified - 10 }, 1)).kind,
        'skipped'
    );
    fs.unlinkSync(f.file);
    assert.equal((await f.build()).kind, 'skipped');
    assert.deepEqual(await f.row(), before);
    assert.deepEqual(await f.search('wf2contenttoken'), []);
});

test('changes during extraction do not publish stale content', async (t) => {
    const f = await fixture(t);
    const before = await f.row();
    const read = fs.promises.readFile;
    t.mock.method(fs.promises, 'readFile', async (...args: any[]) => {
        const result = await (read as any)(...args);
        if (args[0] === f.file) fs.writeFileSync(f.file, 'changed content with a different size');
        return result;
    });
    assert.equal((await f.build()).kind, 'skipped');
    assert.deepEqual(await f.row(), before);
    assert.deepEqual(await f.search('wf2contenttoken'), []);
});

for (const step of ['upsert', 'update'] as const) {
    test(`full text ${step} failure leaves the base marker pending and a later build repairs it`, async (t) => {
        const f = await fixture(t);
        const before = await f.row();
        const method = t.mock.method(f.fss.storage, step, async () => {
            throw new Error('isolated storage write failure');
        });
        assert.equal((await f.build()).kind, 'storage_error');
        assert.deepEqual(await f.row(), before);
        method.mock.restore();
        assert.equal((await f.build()).kind, 'completed');
        assert.equal(isFullTextReady(await f.row(), f.fss.scannerState.bm25_generation), true);
    });
}

test('NUL and malformed surrogate input preserve searchable words', async (t) => {
    const f = await fixture(t, 'txt', 'wf2validtoken \u0000 \ud800 othertext');
    assert.equal((await f.build()).kind, 'completed');
    assert.equal((await f.search('wf2validtoken')).length, 1);
});

for (const availability of ['terminal', 'unsupported', 'temporary', undefined, 'ordinary', 'raw-sdk']) {
    for (const operation of ['build', 'query']) {
        test(`runtime tokenizer ${availability} through ${operation} preserves errors and healthy routes`, async (t) => {
            const f = await fixture(t);
            if (operation === 'query') await f.build();
            const before = await f.row();
            const failure = Object.assign(new Error('isolated tokenizer failure'), {
                code:
                    availability === 'ordinary'
                        ? 'EIO'
                        : availability === 'raw-sdk'
                          ? 'nlp_operation_failed'
                          : 'bm25_tokenizer_unavailable',
                details: { availability }
            });
            const stop = availability === 'terminal' || availability === 'unsupported';
            let notices = 0;
            f.fss.onStateChanged = () => notices++;
            const method = t.mock.method(f.fss.storage, operation === 'build' ? 'upsert' : 'searchBM25', async () => {
                throw failure;
            });
            if (operation === 'build') {
                assert.deepEqual(await f.fss.processFullTextQueue(() => false, { activeRoots: [f.directory] }), {
                    outcome: 'stopped',
                    processed: 0
                });
            } else {
                await assert.rejects(f.fss.searchFullText('wf2contenttoken'), (error) => error === failure);
            }
            assert.deepEqual(
                f.fss.getFullTextState(),
                stop ? { available: false, reason: 'tokenizer_unavailable', availability } : { available: true }
            );
            assert.deepEqual(await f.row(), before);
            if (stop) {
                assert.equal(f.fss._fullTextByHolder.get(f.fss.storage).runtimeFailure.error, failure);
                assert.equal(notices, 1);
                assert.deepEqual(await f.fss.searchFullText('wf2contenttoken'), []);
                assert.equal((await f.fss.processFullTextQueue(() => false)).outcome, 'stale');
                assert.equal(method.mock.callCount(), 1);
                assert.equal(notices, 1);
            }
            method.mock.restore();
            if (stop) {
                assert.deepEqual(
                    await f.fss.searchFullText('wf2contenttoken'),
                    [],
                    'backend recovery does not clear the instance latch'
                );
                await f.fss._replaceRetrievalStorage({ dim: 2, mode: 'base-only' });
                assert.deepEqual(f.fss.getFullTextState(), { available: true });
                if (operation === 'query') assert.equal((await f.fss.searchFullText('wf2contenttoken')).length, 1);
                else
                    assert.equal(
                        (await f.fss.processFullTextQueue(() => false, { activeRoots: [f.directory] })).processed,
                        1
                    );
            }
            assert.equal((await f.fss.searchIndexedFilesByKeyword('document')).length, 1);
        });
    }
}

for (const replacement of ['holder', 'generation', 'reset']) {
    test(`late tokenizer failure cannot disable changed ${replacement}`, async (t) => {
        const f = await fixture(t);
        await f.build();
        let reject!: (error: Error) => void;
        const failure = Object.assign(new Error('late tokenizer failure'), {
            code: 'bm25_tokenizer_unavailable',
            details: { availability: 'terminal' }
        });
        t.mock.method(
            f.fss.storage,
            'searchBM25',
            () =>
                new Promise((_resolve, no) => {
                    reject = no;
                })
        );
        const pending = f.fss.searchFullText('wf2contenttoken');
        const holder = f.fss.storage;
        if (replacement === 'holder') {
            f.fss.storage = {} as any;
            f.fss._fullTextByHolder.set(f.fss.storage, { bound: true });
        } else if (replacement === 'generation') f.fss.scannerState.bm25_generation++;
        else f.fss.scannerState.bm25_reset_pending = true;
        reject(failure);
        try {
            await assert.rejects(pending, (error) => error === failure);
            assert.equal(f.fss._fullTextByHolder.get(holder).runtimeFailure, undefined);
        } finally {
            f.fss.storage = holder;
        }
    });
}

test('concurrent tokenizer failures notify once while preserving both original failures', async (t) => {
    const f = await fixture(t);
    const errors = ['terminal', 'unsupported'].map((availability) =>
        Object.assign(new Error(availability), {
            code: 'bm25_tokenizer_unavailable',
            details: { availability }
        })
    );
    const gate = new Promise<void>((resolve) => setImmediate(resolve));
    let calls = 0,
        notices = 0;
    f.fss.onStateChanged = () => notices++;
    t.mock.method(f.fss.storage, 'searchBM25', async () => {
        const error = errors[calls++];
        await gate;
        throw error;
    });
    const results = await Promise.allSettled([f.fss.searchFullText('one'), f.fss.searchFullText('two')]);
    assert.deepEqual(
        results.map((result: any) => result.reason),
        errors
    );
    assert.equal(notices, 1);
    assert.equal(f.fss.getFullTextState().availability, 'terminal');
});
