import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    applyClick,
    ascendAndConsolidate,
    carveOut,
    computeVisual,
    effectiveBlockingPattern
} from '../../../../../../main/applications/filemgr/renderer/tree/checkbox.js';
import {
    DEFAULT_EXCLUDE_PATTERNS,
    getHomeRoot,
    getParentPath,
    getRelative,
    hasDescendantRoot,
    hasUserExcludesInSubtree,
    isDefault,
    isSameOrAncestor,
    userPatternMatches
} from '../../../../../../main/applications/filemgr/renderer/tree/utils.js';

const defaults = () => [...DEFAULT_EXCLUDE_PATTERNS];
const entry = (root, excludePatterns = defaults()) => ({ root, exclude_patterns: excludePatterns });
const roots = (entries) => entries.map((item) => item.root);
const excludesFor = (entries, root) => entries.find((item) => item.root === root)?.exclude_patterns;

test('path helpers handle ancestors, relative paths, defaults, user patterns, subtree checks, and home fallback', () => {
    assert.equal(isSameOrAncestor('/proj', '/proj'), true);
    assert.equal(isSameOrAncestor('/proj', '/proj/src/main'), true);
    assert.equal(isSameOrAncestor('/proj/src', '/proj/src-extra'), false);
    assert.equal(getRelative('/proj', '/proj/src/main'), 'src/main');
    assert.equal(getRelative('/proj', '/proj'), '');
    assert.equal(isDefault('**/.git/**'), true);
    assert.equal(isDefault('src/generated/**'), false);
    assert.equal(isDefault('src/Library/**'), false);
    assert.equal(userPatternMatches('src/**', 'src'), true);
    assert.equal(userPatternMatches('src/**', 'src/main'), true);
    assert.equal(userPatternMatches('src/**', 'src-main'), false);
    assert.equal(hasDescendantRoot('/proj', [entry('/proj/src')]), true);
    assert.equal(hasDescendantRoot('/proj/src', [entry('/proj/src')]), false);
    assert.equal(
        hasUserExcludesInSubtree(entry('/proj', [...defaults(), 'src/generated/**']), '/proj', '/proj/src'),
        true
    );
    assert.equal(hasUserExcludesInSubtree(entry('/proj', [...defaults(), 'docs/**']), '/proj', '/proj/src'), false);
    assert.equal(getHomeRoot('/Users/stella/Projects/FillipDesk'), '/Users/stella');
    assert.equal(getParentPath('/Users/stella'), '/Users');
    assert.equal(getParentPath('/Users'), '/');
    assert.equal(getParentPath('/'), '/');
    assert.equal(getParentPath('C:/Users/Stella'), 'C:/Users');
    assert.equal(getParentPath('{DRIVE_ROOT}'), '{DRIVE_ROOT}');
});

test('computeVisual reports checkbox state from roots, excludes, workspace, and availability', () => {
    const cases = [
        {
            name: 'unavailable before any checkbox rule',
            path: '/offline',
            entries: [entry('/offline')],
            context: { sources: [{ root: '/offline', state: 'unavailable' }] },
            expected: { state: 'unavailable', cause: 'unavailable' }
        },
        {
            name: 'default excluded path',
            path: '/proj/node_modules/react',
            entries: [entry('/proj')],
            expected: { state: 'system-skip', cause: 'defaults' }
        },
        {
            name: 'clean self root',
            path: '/proj',
            entries: [entry('/proj')],
            expected: { state: 'checked', cause: 'self_clean', ownerRoot: '/proj' }
        },
        {
            name: 'current workspace uses normal checked rules',
            path: '/proj',
            entries: [entry('/proj')],
            context: { defaultWorkspace: '/proj' },
            expected: { state: 'checked', cause: 'self_clean', ownerRoot: '/proj', disabled: undefined }
        },
        {
            name: 'current workspace can be indeterminate',
            path: '/proj',
            entries: [entry('/proj', [...defaults(), 'src/generated/**'])],
            context: { defaultWorkspace: '/proj' },
            expected: { state: 'indeterminate', cause: 'self_dirty', ownerRoot: '/proj', disabled: undefined }
        },
        {
            name: 'dirty self root',
            path: '/proj',
            entries: [entry('/proj', [...defaults(), 'src/generated/**'])],
            expected: { state: 'indeterminate', cause: 'self_dirty', ownerRoot: '/proj' }
        },
        {
            name: 'clean parent root with child root',
            path: '/proj',
            entries: [entry('/proj'), entry('/proj/src')],
            expected: { state: 'checked', cause: 'self_clean', ownerRoot: '/proj' }
        },
        {
            name: 'child root under clean parent',
            path: '/proj/src',
            entries: [entry('/proj'), entry('/proj/src')],
            expected: { state: 'checked', cause: 'self_clean', ownerRoot: '/proj/src' }
        },
        {
            name: 'clean ancestor coverage',
            path: '/proj/src/main',
            entries: [entry('/proj')],
            expected: { state: 'checked', cause: 'covered_clean', ownerRoot: '/proj' }
        },
        {
            name: 'covered subtree with user exclude',
            path: '/proj/src',
            entries: [entry('/proj', [...defaults(), 'src/generated/**'])],
            expected: { state: 'indeterminate', cause: 'covered_dirty', ownerRoot: '/proj' }
        },
        {
            name: 'dirty self root with child root',
            path: '/proj',
            entries: [entry('/proj', [...defaults(), 'src/generated/**']), entry('/proj/src')],
            expected: { state: 'indeterminate', cause: 'self_dirty', ownerRoot: '/proj' }
        },
        {
            name: 'clean ancestor coverage with descendant root',
            path: '/proj/src',
            entries: [entry('/proj'), entry('/proj/src/main')],
            expected: { state: 'checked', cause: 'covered_clean', ownerRoot: '/proj' }
        },
        {
            name: 'descendant-only coverage',
            path: '/proj',
            entries: [entry('/proj/src')],
            expected: { state: 'indeterminate', cause: 'desc_only' }
        },
        {
            name: 'blocked by coarsest effective pattern',
            path: '/proj/src/main',
            entries: [entry('/proj', [...defaults(), 'src/**', 'src/main/**'])],
            expected: { state: 'empty', cause: 'blocked', ownerRoot: '/proj', blockingPattern: 'src/**' }
        },
        {
            name: 'unrelated path',
            path: '/other',
            entries: [entry('/proj')],
            expected: { state: 'empty', cause: 'none' }
        }
    ];

    for (const testCase of cases) {
        const result = computeVisual(testCase.path, testCase.entries, testCase.context ?? {});
        assert.equal(result.state, testCase.expected.state, testCase.name);
        assert.equal(result.cause, testCase.expected.cause, testCase.name);
        assert.equal(result.ownerEntry?.root, testCase.expected.ownerRoot, testCase.name);
        assert.equal(result.blockingPattern, testCase.expected.blockingPattern, testCase.name);
        if (Object.hasOwn(testCase.expected, 'disabled')) {
            assert.equal(result.disabled, testCase.expected.disabled, testCase.name);
        }
    }
});

test('effectiveBlockingPattern chooses the shortest matching prefix across coexisting patterns', () => {
    const owner = entry('/proj', [...defaults(), 'src/**', 'src/main/**']);
    const result = effectiveBlockingPattern('/proj/src/main', [owner]);

    assert.equal(result.ownerEntry, owner);
    assert.equal(result.blockingPattern, 'src/**');
});

test('effectiveBlockingPattern chooses the coarsest blocker across ancestor entries', () => {
    const parent = entry('/proj', [...defaults(), 'src/**']);
    const child = entry('/proj/src', [...defaults(), 'main/**']);
    const result = effectiveBlockingPattern('/proj/src/main', [parent, child]);

    assert.equal(result.ownerEntry, parent);
    assert.equal(result.blockingPattern, 'src/**');
});

test('applyClick A adds a new root for empty unblocked paths without mutating input', () => {
    const entries = [];
    const result = applyClick('/proj', entries, {});

    assert.equal(result.action, 'commit');
    assert.equal(result.toast, 'info');
    assert.deepEqual(entries, []);
    assert.deepEqual(roots(result.nextEntries), ['/proj']);
    assert.deepEqual(excludesFor(result.nextEntries, '/proj'), defaults());
});

test('applyClick B shows a modal and proposes removing a checked self root', () => {
    const entries = [entry('/proj')];
    const result = applyClick('/proj', entries, {});

    assert.equal(result.action, 'showModal');
    assert.deepEqual(result.nextEntries, []);
    assert.deepEqual(roots(entries), ['/proj']);
});

test('applyClick protects the current workspace root from being removed', () => {
    const entries = [entry('/proj')];
    const result = applyClick('/proj', entries, { defaultWorkspace: '/proj' });

    assert.equal(result.action, 'protectedWorkspace');
    assert.equal(result.message, '当前工作空间不能在这里移除。请回到主页面切换工作空间。');
    assert.deepEqual(result.nextEntries, entries);
    assert.equal(result.toast, undefined);
    assert.deepEqual(roots(entries), ['/proj']);
});

test('applyClick still allows excluding a child of the current workspace', () => {
    const entries = [entry('/proj')];
    const result = applyClick('/proj/src', entries, { defaultWorkspace: '/proj' });

    assert.equal(result.action, 'commit');
    assert.equal(result.toastAction, 'exclude');
    assert.deepEqual(excludesFor(result.nextEntries, '/proj'), [...defaults(), 'src/**']);
});

test('applyClick C excludes a checked covered path from its covering root', () => {
    const entries = [entry('/proj')];
    const result = applyClick('/proj/src', entries, {});

    assert.equal(result.action, 'commit');
    assert.equal(result.toast, 'undo');
    assert.deepEqual(excludesFor(result.nextEntries, '/proj'), [...defaults(), 'src/**']);
    assert.deepEqual(excludesFor(entries, '/proj'), defaults());
});

test('applyClick D removes an exact effective blocking pattern', () => {
    const entries = [entry('/proj', [...defaults(), 'src/**'])];
    const result = applyClick('/proj/src', entries, {});

    assert.equal(result.action, 'commit');
    assert.equal(result.toast, 'info');
    assert.deepEqual(excludesFor(result.nextEntries, '/proj'), defaults());
    assert.deepEqual(excludesFor(entries, '/proj'), [...defaults(), 'src/**']);
});

test('applyClick E carves a strict ancestor blocker using sibling tree data', () => {
    const entries = [entry('/proj', [...defaults(), 'src/**'])];
    const result = applyClick('/proj/src/main', entries, {
        childrenByPath: {
            '/proj/src': ['main', 'test', 'utils']
        }
    });

    assert.equal(result.action, 'commit');
    assert.equal(result.toast, 'info');
    assert.deepEqual(excludesFor(result.nextEntries, '/proj'), [...defaults(), 'src/test/**', 'src/utils/**']);
    assert.equal(computeVisual('/proj/src/main', result.nextEntries, {}).state, 'checked');
});

test('applyClick E handles coexisting exact and ancestor patterns by carving the coarser blocker', () => {
    const entries = [entry('/proj', [...defaults(), 'src/**', 'src/main/**'])];
    const result = applyClick('/proj/src/main', entries, {
        childrenByPath: {
            '/proj/src': ['main', 'test']
        }
    });

    assert.equal(result.action, 'commit');
    assert.equal(result.toast, 'info');
    assert.deepEqual(excludesFor(result.nextEntries, '/proj'), [...defaults(), 'src/test/**']);
    assert.equal(computeVisual('/proj/src/main', result.nextEntries, {}).state, 'checked');
});

test('applyClick E carves the effective parent blocker when a child root has a narrower blocker', () => {
    const entries = [entry('/proj', [...defaults(), 'src/**']), entry('/proj/src', [...defaults(), 'main/**'])];
    const result = applyClick('/proj/src/main', entries, {
        childrenByPath: {
            '/proj/src': ['main', 'test']
        }
    });

    assert.equal(result.action, 'commit');
    assert.equal(result.toast, 'info');
    assert.deepEqual(excludesFor(result.nextEntries, '/proj'), [...defaults(), 'src/test/**']);
    assert.deepEqual(excludesFor(result.nextEntries, '/proj/src'), defaults());
    assert.equal(computeVisual('/proj/src/main', result.nextEntries, {}).state, 'checked');
    assert.deepEqual(excludesFor(entries, '/proj'), [...defaults(), 'src/**']);
    assert.deepEqual(excludesFor(entries, '/proj/src'), [...defaults(), 'main/**']);
});

test('applyClick F consolidates indeterminate covered subtrees', () => {
    const entries = [entry('/proj', [...defaults(), 'src/generated/**'])];
    const result = applyClick('/proj/src', entries, {});

    assert.equal(result.action, 'commit');
    assert.equal(result.toast, 'info');
    assert.deepEqual(excludesFor(result.nextEntries, '/proj'), defaults());
    assert.equal(computeVisual('/proj/src', result.nextEntries, {}).state, 'checked');
});

test('ascendAndConsolidate removes descendant roots and creates a covering root when needed', () => {
    const entries = [entry('/proj/src')];
    const result = ascendAndConsolidate('/proj', entries, {});

    assert.deepEqual(roots(result), ['/proj']);
    assert.deepEqual(excludesFor(result, '/proj'), defaults());
    assert.deepEqual(roots(entries), ['/proj/src']);
});

test('carveOut removes a coarse blocker and excludes siblings outside the restored lineage', () => {
    const owner = entry('/proj', [...defaults(), 'src/**']);
    const result = carveOut(owner, '/proj/src/main/core', 'src/**', {
        childrenByPath: {
            '/proj/src': ['main', 'test'],
            '/proj/src/main': ['core', 'generated']
        }
    });

    assert.deepEqual(result.exclude_patterns, [...defaults(), 'src/test/**', 'src/main/generated/**']);
    assert.deepEqual(owner.exclude_patterns, [...defaults(), 'src/**']);
});
