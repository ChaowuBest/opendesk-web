import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createIndexedSearchContext,
    InvalidFilemgrSearchScopeError,
    filterIndexedResults,
    groupIndexedChunksByFile,
    isCoveredByActiveEntries,
    mergeSearchRoutes,
    normalizeFilemgrSearchScope,
    normalizeSearchTopK,
    rankSearchResults
} from '../../../../main/applications/filemgr/search/indexed.js';
import FileManagerWorker from '../../../../main/applications/filemgr/worker.js';
import { CODES } from '../../../../main/applications/filemgr/storage.js';
import { setRuntimeLocale } from '../../../../locale/index.js';

function item(path, overrides = {}) {
    const filename = path.split(/[\\/]/).pop();
    return {
        path,
        filename,
        modified: 100,
        size: 1,
        snippet: null,
        ref_count: 1,
        ...overrides
    };
}

test('normalizeSearchTopK clamps to supported range', () => {
    assert.equal(normalizeSearchTopK(undefined), 50);
    assert.equal(normalizeSearchTopK(0), 1);
    assert.equal(normalizeSearchTopK(500), 100);
});

test('createIndexedSearchContext normalizes query, routes, topK, and scope', () => {
    assert.deepEqual(
        createIndexedSearchContext('  plan  ', {
            topK: 5,
            routes: ['keyword', 'name', 'unknown'],
            includeContentSemantic: false,
            scope: { type: 'path', path: '/workspace/' }
        }),
        {
            query: 'plan',
            topK: 5,
            routes: {
                keyword: true,
                nameSemantic: true,
                contentSemantic: false,
                needsSemantic: true
            },
            scope: { type: 'path', path: '/workspace' }
        }
    );
    assert.deepEqual(createIndexedSearchContext('plan', { routes: [] }).routes, {
        keyword: false,
        nameSemantic: false,
        contentSemantic: false,
        needsSemantic: false
    });
});

test('normalizeFilemgrSearchScope accepts canonical absolute path forms', () => {
    assert.equal(normalizeFilemgrSearchScope(undefined), undefined);
    assert.deepEqual(normalizeFilemgrSearchScope({ type: 'path', path: '/' }), { type: 'path', path: '/' });
    assert.deepEqual(normalizeFilemgrSearchScope({ type: 'path', path: '/A/%_dir\\name///' }), {
        type: 'path',
        path: '/A/%_dir\\name'
    });
    assert.deepEqual(normalizeFilemgrSearchScope({ type: 'path', path: 'C:/' }), { type: 'path', path: 'C:/' });
    assert.deepEqual(normalizeFilemgrSearchScope({ type: 'path', path: 'C:/Users/Stella/' }), {
        type: 'path',
        path: 'C:/Users/Stella'
    });
    assert.deepEqual(normalizeFilemgrSearchScope({ type: 'path', path: '//server/share/' }), {
        type: 'path',
        path: '//server/share'
    });
});

test('normalizeFilemgrSearchScope rejects malformed present scopes', () => {
    const invalidScopes = [
        null,
        {},
        { type: 'folder', path: '/a' },
        { type: 'path', path: 1 },
        { type: 'path', path: '' },
        { type: 'path', path: '   ' },
        { type: 'path', path: 'relative/path' },
        { type: 'path', path: 'C:relative' },
        { type: 'path', path: '//server' },
        { type: 'path', path: '\\server\\share' },
        { type: 'path', path: '/indexed/../outside' },
        { type: 'path', path: '/indexed/./child' },
        { type: 'path', path: '/indexed//child' },
        { type: 'path', path: 'C://Users/Stella' },
        { type: 'path', path: 'C:/Users/../outside' },
        { type: 'path', path: '//server/share//folder' },
        { type: 'path', path: '//server/share/../outside' }
    ];
    for (const scope of invalidScopes) {
        assert.throws(() => normalizeFilemgrSearchScope(scope), InvalidFilemgrSearchScopeError);
    }
});

test('invalid scope is handled before storage readiness and blank-query returns', async () => {
    setRuntimeLocale('en-US');
    try {
        const worker = Object.create(FileManagerWorker.prototype);
        worker.storage = null;
        const missingStorage = await worker.searchIndexedFiles('query', { scope: { type: 'path', path: 'relative' } });
        assert.equal(missingStorage.code, CODES.INVALID_SCOPE);
        assert.equal(missingStorage.warning, 'The file search scope is invalid. Choose an indexed file or folder.');

        worker.storage = { isDeferred: () => false };
        const blankQuery = await worker.searchIndexedFiles('   ', { scope: { type: 'path', path: '' } });
        assert.equal(blankQuery.code, CODES.INVALID_SCOPE);
    } finally {
        setRuntimeLocale(null);
    }
});

test('non-canonical absolute scope returns INVALID_SCOPE without running a route', async () => {
    let routeCalls = 0;
    const worker = Object.create(FileManagerWorker.prototype);
    worker.storage = {
        isDeferred: () => false,
        searchIndexedFilesByKeyword: async () => {
            routeCalls += 1;
            return [];
        }
    };

    const result = await worker.searchIndexedFiles('query', {
        routes: ['keyword'],
        scope: { type: 'path', path: '/indexed/../outside' }
    });

    assert.equal(result.code, CODES.INVALID_SCOPE);
    assert.equal(routeCalls, 0);
});

test('mergeSearchRoutes deduplicates paths and merges match metadata', () => {
    const [result] = mergeSearchRoutes({
        keyword: [item('/workspace/report.md')],
        contentSemantic: [item('/workspace/report.md', { snippet: 'best chunk', semanticScore: 0.82 })]
    });

    assert.equal(result.path, '/workspace/report.md');
    assert.deepEqual(result.matchTypes, ['keyword', 'content_semantic']);
    assert.equal(result.snippet, 'best chunk');
    assert.equal(result.semanticScore, 0.82);
});

test('mergeSearchRoutes preserves all content snippets', () => {
    const snippets = [
        { chunkId: 'high', text: 'high', score: 0.9 },
        { chunkId: 'low', text: 'low', score: 0.4 }
    ];
    const [result] = mergeSearchRoutes({
        keyword: [item('/workspace/report.md')],
        contentSemantic: [item('/workspace/report.md', { snippet: 'high', snippets, semanticScore: 0.9 })]
    });
    assert.deepEqual(result.snippets, snippets);
});

test('groupIndexedChunksByFile keeps all snippets in vector-score order and limits files', () => {
    const files = groupIndexedChunksByFile([
        { chunk: { id: 'low', text: 'low' }, score: 0.2, source: { path: '/a.md', filename: 'a.md' } },
        { chunk: { id: 'best', text: 'best' }, score: 0.9, source: { path: '/a.md', filename: 'a.md' } },
        { chunk: { id: 'other', text: 'other' }, score: 0.8, source: { path: '/b.md', filename: 'b.md' } }
    ], 1);
    assert.equal(files.length, 1);
    assert.equal(files[0].path, '/a.md');
    assert.equal(files[0].snippet, 'best');
    assert.equal(files[0].semanticScore, 0.9);
    assert.deepEqual(files[0].snippets.map((snippet) => snippet.chunkId), ['best', 'low']);
});

test('rankSearchResults keeps keyword above semantic-only multi-match', () => {
    const ranked = rankSearchResults([
        {
            ...item('/docs/semantic-multi.md'),
            matchTypes: ['name_semantic', 'content_semantic'],
            routeOrder: 0
        },
        {
            ...item('/docs/keyword.md'),
            matchTypes: ['keyword'],
            routeOrder: 1
        }
    ]);

    assert.deepEqual(
        ranked.map((it) => it.path),
        ['/docs/keyword.md', '/docs/semantic-multi.md']
    );
});

test('rankSearchResults keeps input order when semantic score is tied or missing', () => {
    const modifiedRanked = rankSearchResults([
        { ...item('/docs/older.md', { modified: 10 }), matchTypes: ['content_semantic'] },
        { ...item('/docs/newer.md', { modified: 20 }), matchTypes: ['content_semantic'] }
    ]);
    assert.deepEqual(
        modifiedRanked.map((it) => it.path),
        ['/docs/older.md', '/docs/newer.md']
    );

    const filenameRanked = rankSearchResults([
        { ...item('/docs/b.md', { modified: 10 }), matchTypes: ['content_semantic'] },
        { ...item('/docs/a.md', { modified: 10 }), matchTypes: ['content_semantic'] }
    ]);
    assert.deepEqual(
        filenameRanked.map((it) => it.path),
        ['/docs/b.md', '/docs/a.md']
    );
});

test('rankSearchResults sorts by match groups while keeping pure keyword input order', () => {
    const ranked = rankSearchResults(
        [
            {
                ...item('/workspace/weak-multi.md'),
                matchTypes: ['keyword', 'name_semantic'],
                semanticScore: 0.2,
                modified: 999
            },
            {
                ...item('/docs/strong-multi.md'),
                matchTypes: ['keyword', 'content_semantic'],
                semanticScore: 0.9,
                modified: 1
            },
            {
                ...item('/docs/keyword-a.md'),
                matchTypes: ['keyword'],
                modified: 1
            },
            {
                ...item('/workspace/keyword-b.md'),
                matchTypes: ['keyword'],
                modified: 999
            },
            {
                ...item('/docs/name-strong.md'),
                matchTypes: ['name_semantic'],
                semanticScore: 0.8
            },
            {
                ...item('/workspace/name-weak.md'),
                matchTypes: ['name_semantic'],
                semanticScore: 0.1
            },
            {
                ...item('/docs/content-strong.md'),
                matchTypes: ['content_semantic'],
                semanticScore: 0.7
            },
            {
                ...item('/workspace/content-weak.md'),
                matchTypes: ['content_semantic'],
                semanticScore: 0.3
            }
        ],
        { currentWorkspace: '/workspace' }
    );

    assert.deepEqual(
        ranked.map((it) => it.path),
        [
            '/docs/strong-multi.md',
            '/workspace/weak-multi.md',
            '/docs/keyword-a.md',
            '/workspace/keyword-b.md',
            '/docs/content-strong.md',
            '/workspace/content-weak.md',
            '/docs/name-strong.md',
            '/workspace/name-weak.md'
        ]
    );
    assert.equal(ranked[0].score, 0.9);
});

test('isCoveredByActiveEntries honors roots, excludes, and Windows casing', () => {
    assert.equal(
        isCoveredByActiveEntries('/workspace/src/report.md', [{ root: '/workspace', exclude_patterns: ['build/**'] }]),
        true
    );
    assert.equal(
        isCoveredByActiveEntries('/workspace/build/report.md', [
            { root: '/workspace', exclude_patterns: ['build/**'] }
        ]),
        false
    );
    assert.equal(isCoveredByActiveEntries('C:\\Work\\File.txt', [{ root: 'c:\\work', exclude_patterns: [] }]), true);
    assert.equal(isCoveredByActiveEntries('/build/a.md', [{ root: '/', exclude_patterns: ['build/**'] }]), false);
    assert.equal(
        isCoveredByActiveEntries('/workspace/Build/a.md', [{ root: '/workspace', exclude_patterns: ['build/**'] }]),
        false
    );
});

test('filterIndexedResults removes invisible, unavailable, excluded, and missing files', async () => {
    const entries = [
        { root: '/workspace', exclude_patterns: ['tmp/**'] },
        { root: '/docs', exclude_patterns: [] }
    ];
    const filtered = await filterIndexedResults(
        [
            item('/workspace/keep.md'),
            item('/workspace/deleted.md', { ref_count: 0 }),
            item('/docs/offline.md'),
            item('/workspace/tmp/hidden.md'),
            item('/workspace/missing.md')
        ],
        {
            entries,
            unavailableRoots: { '/docs': { since: 1 } },
            statFile: async (filePath) => (filePath.endsWith('missing.md') ? null : { isFile: () => true })
        }
    );

    assert.deepEqual(
        filtered.map((it) => it.path),
        ['/workspace/keep.md']
    );
});
