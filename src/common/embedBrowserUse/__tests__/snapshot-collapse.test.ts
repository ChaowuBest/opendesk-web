/**
 * Tests for the lossless collapse / explore / diff machinery added to the
 * embedBrowserUse snapshot pipeline.
 *
 * These cover the pure AriaNode transforms in cdp/aria.ts — the injection
 * script (stable refs) is exercised end-to-end by the browser integration
 * tests and manual regression on real shopping sites.
 */
import {
    type AriaNode,
    renderAriaTreeToYaml,
    collapseNoisySubtrees,
    findNodeByRef,
    diffTrees,
    shouldFallbackToFullDiff,
    buildRefMissNote,
    countDescendants,
    mergeFrameTrees
} from '../cdp/aria.js';

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

describe('collapseNoisySubtrees', () => {
    test('collapses a large landmark (contentinfo footer) but keeps its children in the tree', () => {
        const footer = n(
            'contentinfo',
            '',
            [
                n('link', '关于我们', [], { url: '/about' }, 'e1'),
                n('link', '联系我们', [], { url: '/contact' }, 'e2'),
                n('link', '合作招商', [], { url: '/lj' }, 'e3'),
                n('link', '隐私政策', [], { url: '/privacy' }, 'e4'),
                n('link', '友情链接', [], { url: '/links' }, 'e5'),
                n('link', '销售联盟', [], { url: '/union' }, 'e6'),
                n('link', '京东社区', [], { url: '/club' }, 'e7')
            ],
            {},
            'e0'
        );
        const root: AriaNode = { role: 'fragment', name: '', children: [footer], props: {} };

        collapseNoisySubtrees(root);

        expect(footer.collapsed).toBe(true);
        expect(footer.children).toHaveLength(7); // children are preserved (lossless)
        expect(footer.collapsedCount).toBe(7);
    });

    test('never collapses a subtree that contains an interactable (ref) descendant', () => {
        const wrapper = n('generic', '', [n('generic', '', [n('button', '加入购物车', [], {}, 'e9')], {}, 'e8')]);
        const root: AriaNode = { role: 'fragment', name: '', children: [wrapper], props: {} };

        collapseNoisySubtrees(root);

        expect(wrapper.collapsed).toBeFalsy();
        expect((wrapper.children[0] as AriaNode).collapsed).toBeFalsy();
    });

    test('collapses deep generic-only decoration chains with no ref', () => {
        // 10 levels of generic, no ref anywhere
        let deep: AriaNode = n('generic', '');
        for (let i = 0; i < 10; i++) deep = n('generic', '', [deep]);
        const root: AriaNode = { role: 'fragment', name: '', children: [deep], props: {} };

        collapseNoisySubtrees(root, { maxDepth: 3 });

        let cursor: AriaNode = root.children[0] as AriaNode;
        let collapsedSomewhere = false;
        for (let d = 0; d < 10; d++) {
            if (cursor.collapsed) collapsedSomewhere = true;
            const child = cursor.children[0];
            if (typeof child === 'string') break;
            cursor = child;
        }
        expect(collapsedSomewhere).toBe(true);
    });

    test('collapses iframes by default', () => {
        const frame = n('iframe', '', [n('link', 'inner', [], {}, 'e2')], { url: 'https://x.com' }, 'e1');
        const root: AriaNode = { role: 'fragment', name: '', children: [frame], props: {} };

        collapseNoisySubtrees(root);

        expect(frame.collapsed).toBe(true);
        expect(frame.children).toHaveLength(1); // content retained for explore
    });

    test('countDescendants counts element nodes only', () => {
        const tree = n('generic', '', [n('link', 'a', [], {}, 'e1'), 'text', n('link', 'b', [], {}, 'e2')]);
        expect(countDescendants(tree)).toBe(2);
    });
});

describe('mergeFrameTrees', () => {
    test('merges srcdoc and about:blank iframe content even when frameSrc is empty', () => {
        const frame = n('iframe', '', [], {}, 'e1');
        frame.frameSrc = '';
        frame.frameIndex = 0;
        const root: AriaNode = { role: 'fragment', name: '', children: [frame], props: {} };

        mergeFrameTrees(root, {
            child: {
                mainResult: {
                    url: 'about:srcdoc',
                    title: '',
                    viewport: { width: 300, height: 200 },
                    scroll: { x: 0, y: 0 },
                    root: n('fragment', '', [n('button', 'Inside', [], {}, 'e2')]),
                    iframeUrls: []
                },
                frameResults: {}
            }
        });

        expect((frame.children[0] as AriaNode).ref).toBe('e1-e2');
        expect((frame.children[0] as AriaNode).name).toBe('Inside');
    });

    test('matches a child frame by its unique URL when frame result order differs from DOM order', () => {
        const frame = n('iframe', '', [], {}, 'e1');
        frame.frameSrc = 'https://target.example/';
        frame.frameIndex = 0;
        const root: AriaNode = { role: 'fragment', name: '', children: [frame], props: {} };
        const frameResult = (url: string, button: string) => ({
            mainResult: {
                url,
                title: '',
                viewport: { width: 300, height: 200 },
                scroll: { x: 0, y: 0 },
                root: n('fragment', '', [n('button', button, [], {}, 'e2')]),
                iframeUrls: []
            },
            frameResults: {}
        });

        mergeFrameTrees(root, {
            wrong: frameResult('https://wrong.example/', 'Wrong'),
            target: frameResult('https://target.example/', 'Target')
        });

        expect((frame.children[0] as AriaNode).name).toBe('Target');
    });
});

describe('renderAriaTreeToYaml collapse', () => {
    test('collapsed node renders as a single summary line and hides children', () => {
        const footer = n('contentinfo', '', [n('link', '关于我们', [], { url: '/about' }, 'e1')], {}, 'e0');
        footer.collapsed = true;
        footer.collapsedCount = 1;
        const root: AriaNode = { role: 'fragment', name: '', children: [footer], props: {} };

        const out = renderAriaTreeToYaml(root, true);
        expect(out).toContain('[collapsed, 1 descendants');
        expect(out).not.toContain('/about'); // child omitted
    });

    test('collapse=false expands a collapsed subtree fully', () => {
        const footer = n('contentinfo', '', [n('link', '关于我们', [], { url: '/about' }, 'e1')], {}, 'e0');
        footer.collapsed = true;
        footer.collapsedCount = 1;
        const root: AriaNode = { role: 'fragment', name: '', children: [footer], props: {} };

        const out = renderAriaTreeToYaml(root, false);
        expect(out).toContain('/about'); // child revealed
    });
});

describe('findNodeByRef', () => {
    test('finds a flat ref', () => {
        const target = n('button', '买', [], {}, 'e3');
        const root: AriaNode = { role: 'fragment', name: '', children: [n('generic', '', [target])], props: {} };
        expect(findNodeByRef(root, 'e3')).toBe(target);
    });

    test('finds a nested ref by descending through segments', () => {
        const inner = n('link', 'inside-frame', [], {}, 'e5-e3');
        const frame = n('iframe', '', [inner], { url: 'x' }, 'e5');
        const root: AriaNode = { role: 'fragment', name: '', children: [frame], props: {} };
        expect(findNodeByRef(root, 'e5-e3')).toBe(inner);
    });

    test('returns undefined for unknown ref', () => {
        const root: AriaNode = { role: 'fragment', name: '', children: [], props: {} };
        expect(findNodeByRef(root, 'e999')).toBeUndefined();
    });
});

describe('diffTrees', () => {
    test('detects added / removed / changed refs', () => {
        const before: AriaNode = {
            role: 'fragment',
            name: '',
            children: [n('button', 'A', [], {}, 'e1'), n('button', 'B', [], {}, 'e2')],
            props: {}
        };
        const after: AriaNode = {
            role: 'fragment',
            name: '',
            children: [
                n('button', 'A-changed', [], {}, 'e1'), // changed
                n('button', 'C', [], {}, 'e3') // added
                // e2 removed
            ],
            props: {}
        };

        const diff = diffTrees(before, after);
        expect(diff.changed).toContain('e1');
        expect(diff.added).toContain('e3');
        expect(diff.removed).toContain('e2');
        expect(diff.yaml).toContain('A-changed');
    });

    test('reports no changes for identical trees', () => {
        const tree: AriaNode = {
            role: 'fragment',
            name: '',
            children: [n('button', 'A', [], {}, 'e1')],
            props: {}
        };
        const diff = diffTrees(tree, JSON.parse(JSON.stringify(tree)));
        expect(diff.added).toHaveLength(0);
        expect(diff.removed).toHaveLength(0);
        expect(diff.changed).toHaveLength(0);
    });

    test('detects a child text change under the same ref (subtree content fingerprint)', () => {
        const mk = (text: string): AriaNode => ({
            role: 'fragment',
            name: '',
            children: [n('listitem', '', [n('generic', '', [text])], { url: '/p/1' }, 'e1')],
            props: {}
        });
        // 节点自身 role/name/ref/prop 键都相同，仅孙级文本变化——旧签名检测不到。
        const diff = diffTrees(mk('¥42.9'), mk('¥43.9'));
        expect(diff.changed).toContain('e1');
        expect(diff.yaml).toContain('¥43.9');
    });

    test('detects a prop VALUE change under the same ref (not just key names)', () => {
        const mk = (url: string): AriaNode => ({
            role: 'fragment',
            name: '',
            children: [n('link', '商品', [], { url }, 'e1')],
            props: {}
        });
        // prop 键都是 'url'，仅值不同——旧签名检测不到。
        const diff = diffTrees(mk('/old'), mk('/new'));
        expect(diff.changed).toContain('e1');
        expect(diff.yaml).toContain('/new');
    });
});

describe('shouldFallbackToFullDiff', () => {
    test('keeps diff when few refs changed (below threshold)', () => {
        const diff = {
            added: ['e3'],
            removed: ['e2'],
            changed: ['e1'],
            yaml: '- button "A-changed" [ref=e1]'
        };
        expect(shouldFallbackToFullDiff(diff)).toBe(false);
    });

    test('falls back to full snapshot when the tree changed massively (cross-page nav)', () => {
        const diff = {
            added: Array.from({ length: 50 }, (_, i) => `n${i}`),
            removed: Array.from({ length: 40 }, (_, i) => `o${i}`),
            changed: Array.from({ length: 20 }, (_, i) => `c${i}`),
            yaml: 'huge diff yaml'
        };
        // 50 + 40 + 20 = 110 > 80 threshold
        expect(shouldFallbackToFullDiff(diff)).toBe(true);
    });

    test('respects a custom threshold', () => {
        const diff = { added: ['a1', 'a2'], removed: [], changed: [], yaml: '' };
        expect(shouldFallbackToFullDiff(diff, 1)).toBe(true);
        expect(shouldFallbackToFullDiff(diff, 2)).toBe(false);
    });
});

describe('buildRefMissNote', () => {
    test('labels a cross-page navigation when the URL changed', () => {
        const note = buildRefMissNote(
            'e96',
            'https://www.bilibili.com/',
            'https://www.bilibili.com/video/BV16Mbi6yEXe/'
        );
        expect(note).toContain('e96');
        expect(note).toContain('跨页导航');
        expect(note).toContain('https://www.bilibili.com/ → https://www.bilibili.com/video/BV16Mbi6yEXe/');
    });

    test('labels an SPA re-render when the URL stayed the same', () => {
        const note = buildRefMissNote(
            'e96',
            'https://www.bilibili.com/video/BV16Mbi6yEXe/',
            'https://www.bilibili.com/video/BV16Mbi6yEXe/'
        );
        expect(note).toContain('SPA 重渲染');
        expect(note).not.toContain('跨页');
    });

    test('treats a missing previous URL as SPA re-render (first snapshot)', () => {
        const note = buildRefMissNote('e5', undefined, 'https://www.bilibili.com/');
        expect(note).toContain('SPA 重渲染');
        expect(note).not.toContain('跨页');
    });
});
