import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBM25Tokenizer } from '../../../../../main/services/storage/bm25-tokenizer.js';
import {
    BM25IndexDBArkdata,
    ARKDATA_BM25_INDEX_VERSION
} from '../../../../../main/services/storage/bm25-index-db-arkdata.js';
import { arkDataFixture } from './fixtures/arkdata-fixture.js';

test('R06 Harmony default uses Intl NFKC words without acquiring NLP or a desktop provider', async () => {
    const forbidden = () => {
        throw new Error('unexpected non-Intl provider');
    };
    const tokenizer = await createBM25Tokenizer({
        platform: 'openharmony',
        loadNative: forbidden,
        loadDictionary: forbidden,
        loadWasm: forbidden
    });
    assert.equal(tokenizer.backend, 'harmonyos-intl');
    for (const text of [
        '① ＡＢＣ 中文连词 12.5 😀',
        '鸿蒙操作系统与人工智能',
        '',
        '😀！…',
        'abc😀尾 '.repeat(220_000)
    ]) {
        const expected = new Map<string, number>();
        let len = 0;
        for (const part of new Intl.Segmenter('zh-CN', { granularity: 'word' }).segment(
            text.normalize('NFKC').toLowerCase()
        )) {
            if (part.isWordLike && /[\p{L}\p{N}]/u.test(part.segment)) {
                expected.set(part.segment, (expected.get(part.segment) ?? 0) + 1);
                len++;
            }
        }
        const stats = await tokenizer.tokenize(text);
        assert.deepEqual(stats.terms, expected);
        assert.equal(stats.len, len);
    }
});
test('R06 missing Intl fails explicitly and never falls back to NLP', async (t) => {
    const descriptor = Object.getOwnPropertyDescriptor(Intl, 'Segmenter')!;
    Object.defineProperty(Intl, 'Segmenter', { ...descriptor, value: undefined });
    t.after(() => Object.defineProperty(Intl, 'Segmenter', descriptor));
    await assert.rejects(createBM25Tokenizer({ platform: 'openharmony' }), { code: 'bm25_tokenizer_unavailable' });
});
if (!process.env.OPENDESK_ARKDATA_ADAPTER_DIR) {
    test.skip('R06 requires real ArkTS modules for new-index build/query verification', () => {});
} else {
    test('R06 fresh ArkData corpus builds and queries with the same Intl tokenizer and keeps version 2', async (t) => {
        const f = arkDataFixture();
        const a = f.proxy();
        assert.equal('getTextProcessingCapabilities' in a.proxy, false);
        assert.equal(f.bindings.has('ArkData.TextProcessingStart'), false);
        const db = new BM25IndexDBArkdata(f.directory + '/intl.db', a.proxy);
        t.after(async () => {
            await db.close();
            f.cleanup();
        });
        await db.initialize();
        const tokenizer = await createBM25Tokenizer({ platform: 'openharmony' });
        const documents = ['鸿蒙操作系统 ＢＭ２５ ①', '人工智能与开发', '中文数字 123 😀'];
        await db.upsert(
            await Promise.all(
                documents.map(async (text, i) => ({
                    item_id: String(i),
                    field: 'body',
                    subKey: '',
                    ...(await tokenizer.tokenize(text))
                }))
            )
        );
        const terms = [...(await tokenizer.tokenize('bm25 1')).terms.keys()];
        assert.deepEqual(
            (await db.search(terms, { field: 'body', topK: 10 })).map((hit) => hit.item_id),
            ['0']
        );
        assert.equal((await db.getInfo()).indexVersion, 2);
        assert.equal(ARKDATA_BM25_INDEX_VERSION, 2);
        assert.equal(
            f.calls.some((call) => call.operation.startsWith('nlp-')),
            false
        );
    });
}
