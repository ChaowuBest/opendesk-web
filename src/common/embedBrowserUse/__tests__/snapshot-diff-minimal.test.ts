/**
 * Tests for the diff minimal-covering-set fix.
 *
 * Regression scenario (from real-world taobao SKU switch): a deep text change
 * propagates up through subtree content signatures, so every ancestor used to
 * be reported as "changed" AND rendered with collapse=false - duplicating the
 * whole tree several times and making the diff output larger than a full
 * snapshot. The fix keeps only the deepest changed refs (the minimal covering
 * set) for both the reported lists and the rendered YAML.
 */
import { type AriaNode, diffTrees, shouldFallbackToFullDiff } from '../cdp/aria.js';

function n(
    role: string,
    name: string,
    children: Array<AriaNode | string> = [],
    props: Record<string, string> = {},
    ref?: string
): AriaNode {
    const node: AriaNode = { role, name, children, props };
    if (ref) node.ref = ref;
    return node;
}

/** Build a page tree whose deep leaf text can be swapped between captures. */
function buildPage(leafText: string): AriaNode {
    return n('generic', '', [
        n('navigation', '顶部导航', [
            n('link', '首页', [], { url: '/' }, 'e1'),
            n('link', '购物车', [], { url: '/cart' }, 'e2')
        ]),
        n('main', '', [
            n(
                'generic',
                '',
                [
                    n(
                        'generic',
                        '',
                        [
                            n('generic', '', ['平台加补后' + leafText], {}, 'e5'),
                            n('generic', '', ['已享受:'], {}, 'e6')
                        ],
                        {},
                        'e4'
                    )
                ],
                {},
                'e3'
            )
        ])
    ]);
}

describe('diffTrees minimal covering set', () => {
    test('deep text change reports only the deepest changed ref, not its ancestors', () => {
        const before = buildPage('￥291');
        const after = buildPage('￥2425');

        const diff = diffTrees(before, after);

        // Old behavior: e5 (leaf) + e4 + e3 + root chain all marked changed.
        // New behavior: only the actual source of change.
        expect(diff.changed).toEqual(['e5']);
        expect(diff.added).toEqual([]);
        expect(diff.removed).toEqual([]);
    });

    test('yaml renders the changed subtree exactly once without duplicating ancestors', () => {
        const before = buildPage('￥291');
        const after = buildPage('￥2425');

        const diff = diffTrees(before, after);

        // The changed text must appear exactly once (old behavior rendered the
        // leaf, then its parent, then grandparent... each containing the text).
        const occurrences = diff.yaml.split('￥2425').length - 1;
        expect(occurrences).toBe(1);

        // Ancestors must not be rendered as independent blocks.
        expect(diff.yaml).not.toContain('[ref=e3]');
        expect(diff.yaml).not.toContain('[ref=e4]');
        // Unchanged siblings must not leak into the diff either.
        expect(diff.yaml).not.toContain('顶部导航');
        expect(diff.yaml).not.toContain('购物车');
    });

    test('two independent deep changes are both reported and each rendered once', () => {
        const before = n('generic', '', [n('generic', '', ['old-a'], {}, 'e1'), n('generic', '', ['old-b'], {}, 'e2')]);
        const after = n('generic', '', [n('generic', '', ['new-a'], {}, 'e1'), n('generic', '', ['new-b'], {}, 'e2')]);

        const diff = diffTrees(before, after);

        expect(diff.changed).toEqual(['e1', 'e2']);
        expect(diff.yaml.split('new-a').length - 1).toBe(1);
        expect(diff.yaml.split('new-b').length - 1).toBe(1);
    });

    test('newly added subtree reports only its top-level ref (descendants are implied)', () => {
        const before = n('generic', '', [n('link', '首页', [], { url: '/' }, 'e1')]);
        const after = n('generic', '', [
            n('link', '首页', [], { url: '/' }, 'e1'),
            n(
                'list',
                '结果列表',
                [
                    n('listitem', '商品A', [], {}, 'e3'),
                    n('listitem', '商品B', [], {}, 'e4'),
                    n('listitem', '商品C', [], {}, 'e5')
                ],
                {},
                'e2'
            )
        ]);

        const diff = diffTrees(before, after);

        expect(diff.added).toEqual(['e2']);
        expect(diff.removed).toEqual([]);
        expect(diff.changed).toEqual([]);
    });

    test('rendering an added subtree shows its full content once', () => {
        const before = n('generic', '', [n('link', '首页', [], { url: '/' }, 'e1')]);
        const after = n('generic', '', [
            n('link', '首页', [], { url: '/' }, 'e1'),
            n(
                'list',
                '结果列表',
                [n('listitem', '商品A', [], {}, 'e3'), n('listitem', '商品B', [], {}, 'e4')],
                {},
                'e2'
            )
        ]);

        const diff = diffTrees(before, after);

        expect(diff.yaml).toContain('结果列表');
        expect(diff.yaml).toContain('商品A');
        expect(diff.yaml).toContain('商品B');
        expect(diff.yaml.split('商品A').length - 1).toBe(1);
    });

    test('unchanged trees produce an empty diff', () => {
        const tree = buildPage('￥291');
        const diff = diffTrees(tree, buildPage('￥291'));

        expect(diff.added).toEqual([]);
        expect(diff.removed).toEqual([]);
        expect(diff.changed).toEqual([]);
        expect(diff.yaml).toBe('');
    });

    test('shouldFallbackToFullDiff still triggers on massive replacement', () => {
        // Simulate a cross-page navigation: whole tree replaced with different refs.
        const before = n('generic', '', [
            ...Array.from({ length: 100 }, (_, i) => n('link', `old-${i}`, [], {}, `e${i + 1}`))
        ]);
        const after = n('generic', '', [
            ...Array.from({ length: 100 }, (_, i) => n('link', `new-${i}`, [], {}, `x${i + 1}`))
        ]);

        const diff = diffTrees(before, after);
        // With minimal-set semantics, removed refs (100) alone exceed the threshold.
        expect(shouldFallbackToFullDiff(diff)).toBe(true);
    });

    test('minimal-set semantics keep small SPA updates far below the fallback threshold', () => {
        // A list of product cards where every card (ref) carries a price text.
        // Old semantics counted every ancestor of every changed card; new
        // semantics counts only the cards themselves.
        const makeTree = (priceOf: (i: number) => string): AriaNode =>
            n('generic', '', [
                n('main', '', [
                    n('list', 'items', [
                        ...Array.from({ length: 30 }, (_, i) =>
                            n('listitem', `item-${i}`, [n('generic', '', [priceOf(i)], {})], {}, `e${i + 2}`)
                        )
                    ])
                ])
            ]);

        const before = makeTree(() => '¥10');
        const after = makeTree((i) => (i % 2 === 0 ? '¥20' : '¥10'));

        const diff = diffTrees(before, after);
        expect(diff.changed).toHaveLength(15);
        expect(shouldFallbackToFullDiff(diff)).toBe(false);
    });
});
