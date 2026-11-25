import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createIndexedSearchContext,
    splitIndexedSearchQuery,
    toIndexedFileSearchResult,
    FILEMGR_SEARCH_MAX_PATHS,
    InvalidFilemgrSearchScopeError,
    filemgrSearchScopePaths,
    filterIndexedResults,
    groupIndexedChunksByFile,
    isCoveredByActiveEntries,
    isExactPathSameOrDescendant,
    isPathInFilemgrSearchScope,
    mergeSearchRoutes,
    normalizeFilemgrSearchScope,
    normalizeSearchTopK,
    rankSearchResults,
    resolveFilemgrSearchScopeForEntries
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
            keywordTerms: ['plan'],
            topK: 5,
            routes: {
                keyword: true,
                bm25: false,
                nameSemantic: true,
                contentSemantic: false,
                needsSemantic: true
            },
            scope: { type: 'path', path: '/workspace' }
        }
    );
    assert.deepEqual(createIndexedSearchContext('plan', { routes: [] }).routes, {
        keyword: false,
        bm25: false,
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
    const files = groupIndexedChunksByFile(
        [
            { chunk: { id: 'low', text: 'low' }, score: 0.2, source: { path: '/a.md', filename: 'a.md' } },
            { chunk: { id: 'best', text: 'best' }, score: 0.9, source: { path: '/a.md', filename: 'a.md' } },
            { chunk: { id: 'other', text: 'other' }, score: 0.8, source: { path: '/b.md', filename: 'b.md' } }
        ],
        1
    );
    assert.equal(files.length, 1);
    assert.equal(files[0].path, '/a.md');
    assert.equal(files[0].snippet, 'best');
    assert.equal(files[0].semanticScore, 0.9);
    assert.deepEqual(
        files[0].snippets.map((snippet) => snippet.chunkId),
        ['best', 'low']
    );
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

test('normalizeFilemgrSearchScope normalizes, deduplicates, and collapses path unions exactly', () => {
    assert.equal(FILEMGR_SEARCH_MAX_PATHS, 64);
    assert.deepEqual(
        normalizeFilemgrSearchScope({
            type: 'paths',
            paths: ['/docs/sub', '/docs/', '/docs', '/selected/A', '/selected/a', '/selected/x\\y', '/selected/x/y']
        }),
        {
            type: 'paths',
            paths: ['/docs', '/selected/A', '/selected/a', '/selected/x/y', '/selected/x\\y']
        }
    );
    assert.deepEqual(normalizeFilemgrSearchScope({ type: 'path', path: 'C:/Users/Stella/' }), {
        type: 'path',
        path: 'C:/Users/Stella'
    });
    assert.deepEqual(normalizeFilemgrSearchScope({ type: 'path', path: 'C:\\Users\\Stella\\' }), {
        type: 'path',
        path: 'C:/Users/Stella'
    });
});

test('normalizeFilemgrSearchScope rejects every fail-closed multi-path shape', () => {
    const invalidScopes = [
        { type: 'paths', paths: [] },
        { type: 'paths', paths: Array.from({ length: 65 }, () => '/docs') },
        { type: 'paths', paths: ['/docs', ''] },
        { type: 'paths', paths: ['/docs', 42] },
        { type: 'paths', paths: ['/docs', 'relative/path'] },
        { type: 'paths', paths: ['/docs', '/outside/../escape'] },
        { type: 'paths', paths: ['/docs', '/inside//double'] },
        { type: 'paths', paths: ['/docs', '///'] },
        { type: 'paths', paths: ['/docs', 'C:////'] },
        { type: 'paths', paths: ['/docs', '/bad\0path'] },
        { type: 'paths', paths: '/docs' },
        { type: 'path', path: ['/docs'] }
    ];
    for (const scope of invalidScopes) {
        assert.throws(() => normalizeFilemgrSearchScope(scope), InvalidFilemgrSearchScopeError);
    }
});

test('exact scope identity preserves case and POSIX backslashes', () => {
    assert.equal(isExactPathSameOrDescendant('/selected/A', '/selected/A/file.md'), true);
    assert.equal(isExactPathSameOrDescendant('/selected/A', '/selected/a/file.md'), false);
    assert.equal(isExactPathSameOrDescendant('/selected/x\\y', '/selected/x\\y/file.md'), true);
    assert.equal(isExactPathSameOrDescendant('/selected/x\\y', '/selected/x/y/file.md'), false);
    assert.equal(isExactPathSameOrDescendant('/a/project', '/a/project-next/file.md'), false);
    assert.equal(isExactPathSameOrDescendant('C:/', 'C:/folder/file.md'), true);
});

test('resolveFilemgrSearchScopeForEntries keeps subsets and optimizes only complete configured coverage', () => {
    const entries = [{ root: '/source/a' }, { root: '/source/b' }];
    const subset = normalizeFilemgrSearchScope({ type: 'paths', paths: ['/source/a'] });
    assert.deepEqual(resolveFilemgrSearchScopeForEntries(subset, { entries }), {
        requestedScope: subset,
        effectiveScope: subset,
        coversAllSources: false
    });

    const all = normalizeFilemgrSearchScope({ type: 'paths', paths: ['/source/b/', '/source/a/'] });
    assert.deepEqual(resolveFilemgrSearchScopeForEntries(all, { entries }), {
        requestedScope: all,
        effectiveScope: undefined,
        coversAllSources: true
    });

    const windowsSubset = normalizeFilemgrSearchScope({
        type: 'paths',
        paths: ['C:/Users/Stella/docs']
    });
    assert.deepEqual(
        resolveFilemgrSearchScopeForEntries(windowsSubset, {
            entries: [{ root: 'C:\\Users\\Stella' }]
        }),
        {
            requestedScope: windowsSubset,
            effectiveScope: windowsSubset,
            coversAllSources: false
        }
    );
});

test('paused entries remain searchable and participate in all-source coverage', () => {
    const entries = [{ root: '/active' }, { root: '/paused' }];
    const activeOnly = normalizeFilemgrSearchScope({ type: 'paths', paths: ['/active'] });
    assert.equal(resolveFilemgrSearchScopeForEntries(activeOnly, { entries }).coversAllSources, false);

    const all = normalizeFilemgrSearchScope({ type: 'paths', paths: ['/active', '/paused'] });
    const resolution = resolveFilemgrSearchScopeForEntries(all, { entries });
    assert.equal(resolution.coversAllSources, true);
    assert.equal(resolution.effectiveScope, undefined);
});

test('unknown and wholly unavailable explicit paths fail closed', () => {
    const entries = [{ root: '/source/a' }, { root: '/source/b' }];
    assert.throws(
        () =>
            resolveFilemgrSearchScopeForEntries(normalizeFilemgrSearchScope({ type: 'paths', paths: ['/unknown'] }), {
                entries
            }),
        InvalidFilemgrSearchScopeError
    );
    assert.throws(
        () =>
            resolveFilemgrSearchScopeForEntries(
                normalizeFilemgrSearchScope({ type: 'paths', paths: ['/source/b/sub'] }),
                { entries, unavailableRoots: { '/source/b': { since: 1 } } }
            ),
        InvalidFilemgrSearchScopeError
    );
    assert.throws(
        () =>
            resolveFilemgrSearchScopeForEntries(normalizeFilemgrSearchScope({ type: 'path', path: '/unknown' }), {
                entries
            }),
        InvalidFilemgrSearchScopeError
    );
    assert.throws(
        () =>
            resolveFilemgrSearchScopeForEntries(normalizeFilemgrSearchScope({ type: 'path', path: '/source/b/sub' }), {
                entries,
                unavailableRoots: { '/source/b': { since: 1 } }
            }),
        InvalidFilemgrSearchScopeError
    );
});

test('requested union predicate excludes sibling prefixes and outside results', () => {
    const scope = normalizeFilemgrSearchScope({ type: 'paths', paths: ['/a/project', '/b/docs'] });
    assert.equal(isPathInFilemgrSearchScope('/a/project/file.md', scope), true);
    assert.equal(isPathInFilemgrSearchScope('/b/docs', scope), true);
    assert.equal(isPathInFilemgrSearchScope('/a/project-next/file.md', scope), false);
    assert.equal(isPathInFilemgrSearchScope('/outside/file.md', scope), false);
    assert.equal(isPathInFilemgrSearchScope('malformed-relative-result.md', scope), false);
    assert.deepEqual(filemgrSearchScopePaths(scope), ['/b/docs', '/a/project']);
});

test('query splitting preserves whole-query routes and applies ordered term rules', () => {
    for (const [query, terms, normalized = query.trim()] of [
        ['鸿蒙　操作系统', ['鸿蒙', '操作系统']],
        ['鸿蒙,操作系统，系统、文件;内容；索引', ['鸿蒙', '操作系统', '系统', '文件', '内容', '索引']],
        ['鸿蒙操作系统', ['鸿蒙操作系统']],
        ['Alpha alpha ALPHA 中文', ['Alpha', '中文']],
        ['a B 1 2 系统', ['a', 'B', '1', '2', '系统']],
        ['a 系统', ['a', '系统']],
        ['中 文 A 1', ['中', '文', 'A', '1']],
        ['Alpha；alpha', ['Alpha']],
        ['1；1', ['1']],
        ['系统；', ['系统']],
        ['系统 System 混合', ['系统', 'System', '混合']],
        ['t0 t1 t2 t3 t4 t5 t6 t7 t8', ['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7']],
        [' ;，、；　 ', undefined, '']
    ]) {
        assert.deepEqual(splitIndexedSearchQuery(query), { query: normalized, keywordTerms: terms });
        const context = createIndexedSearchContext(query);
        assert.equal(context.query, normalized);
        assert.deepEqual(context.keywordTerms, terms);
    }
    assert.equal(createIndexedSearchContext('query').routes.bm25, true);
    assert.equal(createIndexedSearchContext('query', { routes: ['bm25'] }).routes.bm25, true);
    assert.equal(createIndexedSearchContext('query', { routes: ['keyword'] }).routes.bm25, false);
});

test('aggregated search splits only filename terms and keeps complete semantic queries', async () => {
    const calls = [];
    const worker = Object.assign(Object.create(FileManagerWorker.prototype), {
        _getVisibleConfigEntries: () => [{ root: '/docs', exclude_patterns: [] }],
        _getEffectiveUnavailableRoots: () => ({}),
        _statFileForSearch: async () => ({ isFile: () => true }),
        storage: {
            mode: 'full',
            isDeferred: () => false,
            searchIndexedFilesByKeyword: async (query, options) => {
                calls.push(['keyword', query, options]);
                return [item('/docs/文件系统设计.txt'), item('/docs/内存管理.txt')];
            },
            retrieval: {
                searchNames: async (query, options) => {
                    calls.push(['name', query, options]);
                    return { results: [] };
                },
                searchContent: async (query, options) => {
                    calls.push(['content', query, options]);
                    return { results: [] };
                }
            }
        }
    });
    const scope = { type: 'path', path: '/docs/sub' };
    for (const [input, query, terms] of [
        ['  文件系统 内存  ', '文件系统 内存', ['文件系统', '内存']],
        ['a 1', 'a 1', ['a', '1']],
        ['系统；系统', '系统；系统', ['系统']],
        ['100% 报告', '100% 报告', ['100%', '报告']]
    ]) {
        calls.length = 0;
        const result = await worker.searchIndexedFiles(input, { topK: 5, scope });
        assert.equal(result.query, query);
        assert.equal(result.code, undefined);
        assert.deepEqual(calls, [
            ['keyword', query, { limit: 15, scope, terms }],
            ['name', query, { topK: 10, scope }],
            ['content', query, { topK: 15, scope }]
        ]);
    }
    calls.length = 0;
    const empty = await worker.searchIndexedFiles(' ;，、；　 ');
    assert.equal(empty.query, '');
    assert.deepEqual(empty.results, []);
    assert.deepEqual(calls, []);
});

test('WF2 eight boxes and each within-box ordering use BM25 and global vector ranks', () => {
    const keyword = [],
        bm25 = [],
        nameSemantic = [],
        contentSemantic = [];
    const cases = [
        ['one-a', 1, 1, 0.2, 10],
        ['one-b', 1, 2, 0.9, 20],
        ['two-a', 1, 9, null, 30],
        ['two-b', 1, 4, null, 40],
        ['three-a', 1, null, 0.3, 50],
        ['three-b', 1, null, 0.8, 60],
        ['four-a', 1, null, null, 90],
        ['four-b', 1, null, null, 80],
        ['five-a', 0, 3, 0.7, 100],
        ['five-b', 0, 10, 0.95, 110],
        ['six-a', 0, 8, null, 120],
        ['six-b', 0, 5, null, 130],
        ['seven-a', 0, null, 0.6, 140],
        ['seven-b', 0, null, 0.65, 150],
        ['eight-a', 0, null, 0.99, 160],
        ['eight-b', 0, null, 0.1, 170]
    ];
    for (const [id, k, b, v, modified] of cases) {
        const row = item('/docs/' + id, { modified, bm25Rank: b, semanticScore: v });
        if (k) keyword.push(row);
        if (b) bm25.push(row);
        if (v !== null) (id.startsWith('eight') ? nameSemantic : contentSemantic).push(row);
    }
    const merged = mergeSearchRoutes({ keyword, bm25, nameSemantic, contentSemantic });
    assert.equal(merged.find((x) => x.filename === 'one-a').ranks?.bm25, 1);
    const ranked = rankSearchResults(merged);
    assert.deepEqual(
        ranked.map((x) => x.filename),
        [
            'one-b',
            'one-a',
            'two-b',
            'two-a',
            'three-b',
            'three-a',
            'four-a',
            'four-b',
            'five-a',
            'five-b',
            'six-b',
            'six-a',
            'seven-b',
            'seven-a',
            'eight-a',
            'eight-b'
        ]
    );
    // Global vector ranks: eight-a=1, five-b=2, one-b=3, three-b=4, five-a=5 ... one-a=9.
    assert.ok(1 / (60 + 2) + 1 / (60 + 3) > 1 / (60 + 1) + 1 / (60 + 9));
    assert.ok(1 / (60 + 3) + 1 / (60 + 5) > 1 / (60 + 10) + 1 / (60 + 2));
    assert.deepEqual(
        rankSearchResults(mergeSearchRoutes({ keyword, bm25 })).map((x) => x.filename),
        [
            'one-a',
            'one-b',
            'two-b',
            'two-a',
            'three-a',
            'three-b',
            'four-a',
            'four-b',
            'five-a',
            'six-b',
            'six-a',
            'five-b'
        ]
    );
    assert.equal(
        toIndexedFileSearchResult('q', [], 0, undefined, undefined, { fullTextAvailable: true }).fullTextAvailable,
        true
    );
});

test('WF2 vector ranks use the maximum actual semantic score, including negative scores and stable ties', () => {
    const merged = mergeSearchRoutes({
        keyword: [item('/a')],
        bm25: [item('/a', { bm25Rank: 1 })],
        nameSemantic: [item('/a', { semanticScore: -0.8 }), item('/b', { semanticScore: -0.2 })],
        contentSemantic: [item('/a', { semanticScore: -0.5 }), item('/c', { semanticScore: -0.2 })]
    });
    assert.equal(merged[0].semanticScore, -0.5);
    const ranked = rankSearchResults(merged);
    assert.equal(ranked.find((x) => x.path === '/b').ranks.vector, 1);
    assert.equal(ranked.find((x) => x.path === '/c').ranks.vector, 2);
    assert.equal(ranked.find((x) => x.path === '/a').ranks.vector, 3);
});
