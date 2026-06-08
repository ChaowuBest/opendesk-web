import assert from 'node:assert/strict';
import test from 'node:test';
import {
    filterIndexedResults,
    isCoveredByActiveEntries,
    mergeSearchRoutes,
    normalizeSearchTopK,
    rankSearchResults
} from '../search-indexed.js';

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
