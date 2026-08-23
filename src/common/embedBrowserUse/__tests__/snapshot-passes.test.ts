import { type AriaNode, renderAriaTreeToYaml, runAriaPass, findNodeByRef, sanitizeUrl } from '../cdp/aria.js';
import { collapseRepeatedSiblingsPass } from '../passes/collapseRepeatedSiblingsPass.js';
import { pruneOffscreenPass } from '../passes/pruneOffscreenPass.js';
import { simplifyTextLeafPass } from '../passes/simplifyTextLeafPass.js';
import { normalizeStringsPass } from '../passes/normalizeStringsPass.js';

function n(role: string, name: string = '', children: Array<AriaNode | string> = [], ref?: string): AriaNode {
    const node: AriaNode = { role, name, children, props: {} };
    if (ref) node.ref = ref;
    return node;
}

function productCard(name: string, ref: string): AriaNode {
    return n('generic', name, [n('img', 'sku'), n('link', 'title', [], ref), n('generic', 'price')]);
}

describe('collapseRepeatedSiblingsPass', () => {
    test('folds a run of 8+ structurally identical siblings into one representative', () => {
        const items = Array.from({ length: 10 }, (_, i) => productCard(`Product ${i}`, `e${i + 1}`));
        const root: AriaNode = { role: 'fragment', name: '', children: items, props: {} };

        const out = collapseRepeatedSiblingsPass(root);

        expect(out.children).toHaveLength(1);
        const rep = out.children[0] as AriaNode;
        expect(rep.repeatCount).toBe(10);
        // The representative keeps the full subtree of the first item, so its
        // inner ref (e1) survives for click/explore targeting.
        expect(findNodeByRef(out, 'e1')).toBeDefined();
    });

    test('keeps folded sibling refs reachable via findNodeByRef (explore support)', () => {
        const items = Array.from({ length: 10 }, (_, i) => productCard(`Product ${i}`, `e${i + 1}`));
        const root: AriaNode = { role: 'fragment', name: '', children: items, props: {} };

        const out = collapseRepeatedSiblingsPass(root);
        const rep = out.children[0] as AriaNode;
        expect(rep.repeatCount).toBe(10);
        // 折叠掉的 9 个兄弟不能被丢弃：explore / snapshot(ref) 依赖按 ref 定位。
        for (let i = 2; i <= 10; i++) {
            expect(findNodeByRef(out, `e${i}`)).toBeDefined();
        }
    });

    test('explore rendering (collapse=false) reveals folded sibling content, compact hides it', () => {
        const items = Array.from({ length: 9 }, (_, i) => productCard(`Product ${i}`, `e${i + 1}`));
        const root: AriaNode = { role: 'fragment', name: '', children: items, props: {} };
        const out = collapseRepeatedSiblingsPass(root);
        const rep = out.children[0] as AriaNode;

        // explore() 以 collapse=false 渲染代表节点，应能看到被折叠的兄弟详情。
        const expanded = renderAriaTreeToYaml({ role: 'fragment', name: '', children: [rep], props: {} }, false);
        expect(expanded).toContain('Product 8');
        expect(expanded).toContain('[ref=e9]');

        // 默认紧凑快照仍应隐藏折叠兄弟，保持体积。
        const compact = renderAriaTreeToYaml({ role: 'fragment', name: '', children: [rep], props: {} }, true);
        expect(compact).not.toContain('Product 1');
    });

    test('keeps runs shorter than the threshold untouched', () => {
        const items = Array.from({ length: 5 }, (_, i) => productCard(`Product ${i}`, `e${i + 1}`));
        const root: AriaNode = { role: 'fragment', name: '', children: items, props: {} };

        const out = collapseRepeatedSiblingsPass(root);
        expect(out.children).toHaveLength(5);
    });

    test('does not fold siblings with different structure', () => {
        const root: AriaNode = {
            role: 'fragment',
            name: '',
            children: [
                productCard('A', 'e1'),
                productCard('B', 'e2'),
                n('listitem', 'X', [n('button', 'click', [], 'e3')])
            ],
            props: {}
        };

        const out = collapseRepeatedSiblingsPass(root);
        expect(out.children).toHaveLength(3);
    });

    test('render marks repeatCount in YAML', () => {
        const rep = productCard('Sample', 'e1');
        rep.repeatCount = 12;
        const root: AriaNode = { role: 'fragment', name: '', children: [rep], props: {} };

        const yaml = renderAriaTreeToYaml(root);
        expect(yaml).toContain('[repeated x12]');
    });
});

describe('pruneOffscreenPass', () => {
    function boxed(node: AriaNode, inViewport: boolean): AriaNode {
        return {
            ...node,
            box: { width: 100, height: 50, visible: true, inViewport }
        };
    }

    test('collapses offscreen nodes even when they contain interactable descendants', () => {
        const offscreen = boxed(n('generic', 'footer text', [n('link', 'about', [], 'e1')]), false);
        const root: AriaNode = { role: 'fragment', name: '', children: [offscreen], props: {} };

        const out = runAriaPass(root, pruneOffscreenPass);

        // viewportOnly semantics: everything offscreen folds, refs included
        // (children are retained so explore() can still expand the region).
        const folded = out.children[0] as AriaNode;
        expect(folded.collapsed).toBe(true);
        expect(
            (folded.children as Array<AriaNode | string>).some(
                (c) => typeof c !== 'string' && (c as AriaNode).ref === 'e1'
            )
        ).toBe(true);
    });

    test('collapses offscreen decoration with no ref tree', () => {
        const offscreen = boxed(n('generic', 'decor', [n('generic', 'text')]), false);
        const root: AriaNode = { role: 'fragment', name: '', children: [offscreen], props: {} };

        const out = runAriaPass(root, pruneOffscreenPass);
        const folded = out.children[0] as AriaNode;
        expect(folded.collapsed).toBe(true);
    });

    test('keeps on-screen nodes expanded', () => {
        const visible = boxed(n('generic', 'main', [n('button', 'go', [], 'e9')]), true);
        const root: AriaNode = { role: 'fragment', name: '', children: [visible], props: {} };

        const out = runAriaPass(root, pruneOffscreenPass);
        expect(out.children[0]).not.toHaveProperty('collapsed');
    });
});

describe('simplifyTextLeafPass', () => {
    test('merges consecutive price fragments into a single text child', () => {
        const root: AriaNode = {
            role: 'fragment',
            name: '',
            children: [
                n('generic', '', [
                    n('generic', '', ['¥']),
                    n('generic', '', ['42']),
                    n('generic', '', ['.']),
                    n('generic', '', ['9'])
                ])
            ],
            props: {}
        };

        const out = runAriaPass(root, simplifyTextLeafPass);
        // Every wrapper is a text leaf, so the whole chain collapses to text.
        expect(out.children).toEqual(['¥42.9']);
    });

    test('merges price fragments but keeps non-leaf siblings (buttons)', () => {
        const card = n('generic', '', [
            n('generic', '', ['¥']),
            n('generic', '', ['42']),
            n('button', '加入购物车', [], 'e1')
        ]);
        const root: AriaNode = { role: 'fragment', name: '', children: [card], props: {} };

        const out = runAriaPass(root, simplifyTextLeafPass);
        const merged = out.children[0] as AriaNode;
        expect(merged.children).toEqual(['¥42', n('button', '加入购物车', [], 'e1')]);
    });

    test('peels deep generic text chains layer by layer (bottom-up)', () => {
        // price wrapper > wrapper > ¥  (chain of single-text generics)
        const deep: AriaNode = n('generic', '', [n('generic', '', [n('generic', '', ['99.9'])])]);
        const root: AriaNode = { role: 'fragment', name: '', children: [deep], props: {} };

        const out = runAriaPass(root, simplifyTextLeafPass);
        expect(out.children).toEqual(['99.9']);
    });

    test('keeps clickable generic (cursor pointer) intact with its ref', () => {
        const clickable = n('generic', '', ['去结算']);
        clickable.ref = 'e9';
        clickable.box = { width: 120, height: 40, visible: true, inViewport: true, cursor: 'pointer' };
        const root: AriaNode = { role: 'fragment', name: '', children: [clickable], props: {} };

        const out = runAriaPass(root, simplifyTextLeafPass);
        const kept = out.children[0] as AriaNode;
        expect(kept).toHaveProperty('ref', 'e9');
        expect(kept.children[0]).toBe('去结算');
    });

    test('does not merge leaf with props (e.g. link url)', () => {
        const withUrl = n('generic', '', ['查看']); // link-like leaf keeps its text leaf? no: use link role directly
        const link = n('link', '', ['查看详情']);
        link.props = { url: '/p/1' };
        link.ref = 'e3';
        const root: AriaNode = { role: 'fragment', name: '', children: [withUrl, link], props: {} };

        const out = runAriaPass(root, simplifyTextLeafPass);
        // withUrl is a text leaf (merged to string); link has props -> kept as node
        expect(out.children).toHaveLength(2);
        expect((out.children[1] as AriaNode).props.url).toBe('/p/1');
    });

    test('does not merge a disabled leaf', () => {
        const disabled = n('generic', '', ['不可用']);
        disabled.disabled = true;
        const root: AriaNode = { role: 'fragment', name: '', children: [disabled], props: {} };

        const out = runAriaPass(root, simplifyTextLeafPass);
        const kept = out.children[0] as AriaNode;
        expect(kept).toHaveProperty('disabled', true);
        expect(kept.children[0]).toBe('不可用');
    });
});

describe('sanitizeUrl', () => {
    // 泛化性：不误删重要参数
    test('keeps business params (id/skuId) and only drops known tracking params', () => {
        const url =
            '//item.taobao.com/item.htm?id=970492648836&skuId=5983054496932&scm=1007.1&pvid=abc&utparam=xyz&utm_source=weibo&mi_id=ggg';
        const clean = sanitizeUrl(url);
        expect(clean).toContain('id=970492648836');
        expect(clean).toContain('skuId=5983054496932');
        expect(clean).not.toContain('scm=');
        expect(clean).not.toContain('pvid=');
        expect(clean).not.toContain('utparam=');
        expect(clean).not.toContain('utm_source=');
        expect(clean).not.toContain('mi_id=');
    });

    test('keeps unknown params from other sites untouched', () => {
        const url = 'https://www.example.com/items?item=42&campaign=summer&ref=nav';
        expect(sanitizeUrl(url)).toBe(url);
    });

    // 泛化性：不同网站都能用
    test('short urls are returned unchanged (no analytics payload)', () => {
        const urls = [
            'https://item.jd.com/100057970603.html',
            'https://www.taobao.com/',
            '//cart.jd.com/cart.action',
            'https://www.amazon.com/dp/B08N5WRWNW'
        ];
        for (const u of urls) expect(sanitizeUrl(u)).toBe(u);
    });

    test('non-navigable urls are never touched', () => {
        const urls = [
            'javascript:void(0);',
            '#',
            '#section-2',
            'data:text/html,hello',
            'mailto:a@b.com',
            '/relative/path?id=1&scm=track'
        ];
        for (const u of urls) expect(sanitizeUrl(u)).toBe(u);
    });

    // 不出 bug：敏感参数保护
    test('skips urls carrying sensitive auth params', () => {
        const urls = [
            'https://api.example.com/data?access_token=abc&scm=track',
            'https://example.com/sso?token=xyz&pvid=t',
            'https://example.com/cb?code=abc&state=xyz&sign=def&utparam=q',
            'https://example.com/key?api_key=k&scm=t'
        ];
        for (const u of urls) expect(sanitizeUrl(u)).toBe(u);
    });

    test('returns original when nothing was removable', () => {
        const url = 'https://example.com/path?only&one=1';
        expect(sanitizeUrl(url)).toBe(url);
    });

    test('drops all params when only tracking params remain', () => {
        // Long enough (>80 chars) to bypass the short-URL guard.
        const url = 'https://example.com/very/long/path/for/testing/the/cleanup/behavior/x?scm=a&pvid=b';
        expect(sanitizeUrl(url)).toBe('https://example.com/very/long/path/for/testing/the/cleanup/behavior/x');
    });
});

describe('normalizeStringsPass name/text dedup', () => {
    test('drops a text child that repeats the accessible name (whitespace-normalized)', () => {
        const link = n('link', '维达纸巾抽纸 ¥ 12.9', ['维达纸巾抽纸¥12.9']);
        const root: AriaNode = { role: 'fragment', name: '', children: [link], props: {} };
        const out = runAriaPass(root, normalizeStringsPass);
        expect((out.children[0] as AriaNode).children).toEqual([]);
    });

    test('keeps a text child that differs from the name', () => {
        const link = n('link', '维达纸巾', ['抽纸 12.9']);
        const root: AriaNode = { role: 'fragment', name: '', children: [link], props: {} };
        const out = runAriaPass(root, normalizeStringsPass);
        expect((out.children[0] as AriaNode).children).toEqual(['抽纸 12.9']);
    });
});

describe('snapshot ref 子树渲染 (snapshot ref mode)', () => {
    test('renders only the subtree rooted at the given ref, including its refs', () => {
        const price = n('generic', '店铺优惠后￥21500', [], 'e683');
        const priceWrapper = n('generic', '', [price], 'e682');
        const root: AriaNode = {
            role: 'fragment',
            name: '',
            children: [n('link', '标题', [], 'e3'), priceWrapper],
            props: {}
        };

        const node = findNodeByRef(root, 'e683')!;
        const yaml = renderAriaTreeToYaml({ role: 'fragment', name: '', children: [node], props: {} }, false);
        expect(yaml).toContain('店铺优惠后￥21500');
        expect(yaml).toContain('[ref=e683]');
        // 子树渲染不应包含无关兄弟节点
        expect(yaml).not.toContain('标题');
        expect(yaml).not.toContain('[ref=e3]');
    });

    test('parent wrapper without own ref keeps child refs intact', () => {
        const inner = n('link', 'inner', [], 'e7');
        const outer = n('generic', '', [inner], 'e5');
        const root: AriaNode = { role: 'fragment', name: '', children: [outer], props: {} };

        const node = findNodeByRef(root, 'e5')!;
        const yaml = renderAriaTreeToYaml({ role: 'fragment', name: '', children: [node], props: {} }, false);
        expect(yaml).toContain('inner');
        expect(yaml).toContain('[ref=e7]');
        expect(yaml).toContain('[ref=e5]');
    });

    test('unknown ref yields no subtree', () => {
        const root: AriaNode = { role: 'fragment', name: '', children: [], props: {} };
        expect(findNodeByRef(root, 'e999')).toBeUndefined();
    });
});
