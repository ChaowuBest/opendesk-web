import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    FULL_TEXT_INDEXABLE_EXTENSIONS,
    FULL_TEXT_RULE_VERSION,
    classifyFullTextOpenFailure,
    defaultFullTextState,
    fullTextColumns,
    fullTextResetRequired,
    isFullTextIndexable,
    isFullTextReady,
    nextFailureState,
    normalizeFullTextState
} from '../../../../main/applications/filemgr/document-retrieval/common/full-text-state.js';
import { chunkStructured } from '../../../../main/applications/filemgr/parser/chunk.js';
import {
    recordStorageCleanupFailure,
    recordStorageInitializationFailure
} from '../../../../main/services/storage/platform.js';

test('full text format policy follows parser content capability', () => {
    const included = [
        'pdf',
        'doc',
        'docx',
        'odt',
        'ods',
        'txt',
        'md',
        'pptx',
        'odp',
        'js',
        'ts',
        'tsx',
        'css',
        'html',
        'csv',
        'xls',
        'xlsx'
    ];
    for (const ext of included) {
        assert.equal(isFullTextIndexable(`document.${ext}`), true, ext);
        assert.ok(['chunk', 'abstract'].includes(chunkStructured(null, `document.${ext}`).chunk_type!));
    }
    assert.deepEqual([...FULL_TEXT_INDEXABLE_EXTENSIONS].sort(), included.map((ext) => `.${ext}`).sort());
    for (const ext of ['json', 'yaml', 'xml', 'rtf', 'ofd', 'png', '']) {
        assert.equal(isFullTextIndexable(`document.${ext}`), false, ext);
    }
    assert.deepEqual(Object.keys(fullTextColumns()).sort(), ['bm25', 'bm25_generation', 'bm25_modified', 'full_text']);
});

test('full text readiness and failures are isolated by version and generation', () => {
    const row = {
        item_id: '/file.txt',
        item_type: 'file',
        bm25: 1,
        bm25_generation: 4,
        bm25_modified: 100,
        modified: 100
    };
    assert.equal(isFullTextReady(row, 4), true);
    assert.equal(isFullTextReady({ ...row, bm25: 0 }, 4), false);
    assert.equal(isFullTextReady(row, 5), false);
    assert.equal(isFullTextReady({ ...row, modified: 101 }, 4), false);
    assert.equal(nextFailureState({ ...row, bm25: -1 }, 4), -2);
    assert.equal(nextFailureState({ ...row, bm25: -1, modified: 101 }, 4), -1);
    assert.equal(nextFailureState({ ...row, bm25: -1 }, 5), -1);
    assert.equal(nextFailureState(row, 4), -1);
});

test('missing or malformed full text state invalidates only full text generation', () => {
    const valid = { bm25_generation: 4, bm25_rule_version: FULL_TEXT_RULE_VERSION, bm25_reset_pending: false };
    assert.equal(fullTextResetRequired(defaultFullTextState()), true);
    assert.equal(fullTextResetRequired(valid), false);
    assert.equal(fullTextResetRequired({ ...valid, bm25_reset_pending: true }), true);
    assert.equal(fullTextResetRequired({ ...valid, bm25_rule_version: 0 }), true);
    for (const patch of [
        { bm25_generation: undefined },
        { bm25_generation: -1 },
        { bm25_generation: 1.5 },
        { bm25_rule_version: '1' },
        { bm25_reset_pending: undefined },
        { bm25_reset_pending: 'false' }
    ]) {
        const parsed = { ...valid, ...patch, embedding_generation: 7 };
        const state = { ...defaultFullTextState(), embedding_generation: 7 };
        normalizeFullTextState(state, parsed);
        assert.equal(state.bm25_generation, null);
        assert.equal(state.embedding_generation, 7);
        assert.equal(fullTextResetRequired(state), true);
    }
    const state = defaultFullTextState();
    normalizeFullTextState(state, valid);
    assert.deepEqual(state, valid);
});

test('full text failure policy checks ownership before recovery classification', () => {
    for (const indexer of ['BaseIndexer', 'VectorIndexer', 'ChunkIndexer', undefined]) {
        const error = Object.assign(new Error('corrupt'), { code: 'SQLITE_CORRUPT' });
        if (indexer) recordStorageInitializationFailure(error, { indexer, backend: 'native' });
        assert.equal(classifyFullTextOpenFailure(error), 'not_bm25');
    }
    for (const [code, expected] of [
        ['SQLITE_CORRUPT', 'reset'],
        ['bm25_index_version_mismatch', 'reset'],
        ['bm25_invalid_schema', 'reset'],
        ['EACCES', 'fallback']
    ]) {
        const error = Object.assign(new Error(code), { code });
        recordStorageInitializationFailure(error, { indexer: 'BM25Indexer', backend: 'native' });
        assert.equal(classifyFullTextOpenFailure(error), expected);
    }
    for (const operation of ['close', 'delete', 'initialize'] as const) {
        const error = Object.assign(new Error('failed'), { code: 'SQLITE_CORRUPT' });
        recordStorageInitializationFailure(error, { indexer: 'BM25Indexer', backend: 'native', operation });
        if (operation === 'initialize') recordStorageCleanupFailure(error, new Error('close failed'));
        assert.equal(classifyFullTextOpenFailure(error), 'retain');
    }
});
