import { type AriaNode, runAriaPass, runAriaPasses } from '../cdp/aria.js';
import { dedupRedundantNamesPass, DEFAULT_ARIA_PASSES } from '../passes/index.js';

function cell(name: string, children: Array<AriaNode | string>): AriaNode {
    return { role: 'cell', name, children, props: {} };
}
function link(
    name: string,
    children: Array<AriaNode | string>,
    props: Record<string, string> = {},
    ref?: string
): AriaNode {
    return { role: 'link', name, children, props, ref };
}
function generic(name: string, children: Array<AriaNode | string>): AriaNode {
    return { role: 'generic', name, children, props: {} };
}

describe('dedupRedundantNamesPass', () => {
    test('collapses a same-named cell>link>generic chain into a single node', () => {
        const tree: AriaNode = {
            role: 'fragment',
            name: '',
            children: [cell('MSG', [link('MSG', [generic('MSG', [])])])],
            props: {}
        };
        const out = runAriaPass(tree, dedupRedundantNamesPass);
        const c = out.children[0] as AriaNode;
        expect(c.role).toBe('cell');
        expect(c.name).toBe('MSG');
        expect(c.children).toHaveLength(0);
    });

    test('merges a redundant child link url into the parent cell', () => {
        const tree: AriaNode = {
            role: 'fragment',
            name: '',
            children: [cell('.husky', [link('.husky', [], { url: '/tree/main/.husky' })])],
            props: {}
        };
        const out = runAriaPass(tree, dedupRedundantNamesPass);
        const c = out.children[0] as AriaNode;
        expect(c.role).toBe('cell');
        expect(c.name).toBe('.husky');
        expect(c.props.url).toBe('/tree/main/.husky');
        expect(c.children).toHaveLength(0);
    });

    test('preserves a nested sub-link while collapsing the redundant wrapper', () => {
        const tree: AriaNode = {
            role: 'fragment',
            name: '',
            children: [
                cell('MSG', [
                    link('MSG', [generic('MSG', [link('!155', [], { url: '/pull/155' }, 'e10'), ' trailing text'])])
                ])
            ],
            props: {}
        };
        const out = runAriaPass(tree, dedupRedundantNamesPass);
        const c = out.children[0] as AriaNode;
        // cell keeps the message name and now directly contains the sub-link + text
        expect(c.children).toHaveLength(2);
        const sub = c.children[0] as AriaNode;
        expect(sub.role).toBe('link');
        expect(sub.name).toBe('!155');
        expect(sub.props.url).toBe('/pull/155');
        expect(c.children[1]).toBe(' trailing text');
    });

    test('keeps a child whose name differs from the parent', () => {
        const tree: AriaNode = {
            role: 'fragment',
            name: '',
            children: [cell('file.ts', [link('file.ts', [generic('different', [])])])],
            props: {}
        };
        const out = runAriaPass(tree, dedupRedundantNamesPass);
        const c = out.children[0] as AriaNode;
        const g = c.children[0] as AriaNode;
        expect(g.role).toBe('generic');
        expect(g.name).toBe('different');
    });

    test('does not dedup when the parent has no name', () => {
        const tree: AriaNode = {
            role: 'fragment',
            name: '',
            children: [generic('', [generic('', [])])],
            props: {}
        };
        const out = runAriaPass(tree, dedupRedundantNamesPass);
        const outer = out.children[0] as AriaNode;
        expect(outer.children).toHaveLength(1);
    });
});

describe('DEFAULT_ARIA_PASSES pipeline', () => {
    test('runs string + generic + dedup passes end to end', () => {
        const tree: AriaNode = {
            role: 'fragment',
            name: '',
            children: [cell('MSG', [link('MSG', [generic('MSG', [])])])],
            props: {}
        };
        const out = runAriaPasses(tree, DEFAULT_ARIA_PASSES);
        const c = out.children[0] as AriaNode;
        expect(c.name).toBe('MSG');
        expect(c.children).toHaveLength(0);
    });
});
