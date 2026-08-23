/**
 * Tests for snapshot render-level output trimming:
 *
 * 1. Over-long URLs (ad/tracking blobs of several KB, e.g. cm.bilibili.com or
 *    extdd1.browser.360.cn links observed on real news/video sites) are
 *    truncated in the rendered YAML. The in-memory tree keeps the full URL so
 *    click()/navigate() still work.
 * 2. Collapsed nodes render a short text preview of their subtree so the agent
 *    can decide whether to explore/scroll without a blind guess.
 */
import { type AriaNode, renderAriaTreeToYaml, collapseNoisySubtrees } from '../cdp/aria.js';

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

describe('URL render truncation', () => {
    test('over-long URL is truncated with ellipsis in the rendered snapshot', () => {
        const longUrl = 'https://cm.bilibili.com/cm/api/fees/pc/sync/v2?msg=' + 'A'.repeat(2000);
        const link = n('link', '广告', [], { url: longUrl }, 'e1');
        const yaml = renderAriaTreeToYaml({ role: 'fragment', name: '', children: [link], props: {} }, true);

        const urlLine = yaml.split('\n').find((l) => l.includes('/url:'));
        expect(urlLine).toBeDefined();
        expect(urlLine!.trimEnd().endsWith('...')).toBe(true);
        // Rendered URL value (after "- /url: ") must not exceed the cap.
        const renderedValue = urlLine!.trim().replace(/^- \/url: /, '');
        expect(renderedValue.length).toBeLessThanOrEqual(203); // 200 cap + '...'
    });

    test('short URLs are rendered as-is', () => {
        const link = n('link', '首页', [], { url: 'https://example.com/home' }, 'e1');
        const yaml = renderAriaTreeToYaml({ role: 'fragment', name: '', children: [link], props: {} }, true);

        expect(yaml).toContain('/url: https://example.com/home');
    });

    test('truncation composes with sanitizeUrl (tracking params stripped first)', () => {
        const base = 'https://example.com/item?';
        const url = base + 'spm=a21bo.jianhua&id=42&' + 'B'.repeat(400);
        const link = n('link', '商品', [], { url }, 'e1');
        const yaml = renderAriaTreeToYaml({ role: 'fragment', name: '', children: [link], props: {} }, true);

        const urlLine = yaml.split('\n').find((l) => l.includes('/url:'))!;
        const renderedValue = urlLine.trim().replace(/^- \/url: /, '');
        // spm was stripped by sanitizeUrl, remaining url truncated to cap.
        expect(renderedValue).not.toContain('spm=');
        expect(renderedValue.length).toBeLessThanOrEqual(203);
        expect(renderedValue.endsWith('...')).toBe(true);
    });
});

describe('collapsed subtree text preview', () => {
    test('collapsed landmark renders a preview of its first textual content', () => {
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

        const yaml = renderAriaTreeToYaml(root, true);

        // Original format prefix is preserved for backward compatibility...
        expect(yaml).toContain('[collapsed, 7 descendants');
        // ...and now carries a preview of the folded content.
        expect(yaml).toContain('关于我们');
    });

    test('preview is capped at 40 characters with ellipsis', () => {
        const longText = '这是一段非常长的文章正文内容用来验证折叠预览的截断行为是否正确生效并且超过四十个字符的上限';
        const section = n(
            'contentinfo',
            '',
            Array.from({ length: 8 }, (_, i) => n('generic', '', [i === 0 ? longText : 'x'], {}))
        );
        const root: AriaNode = { role: 'fragment', name: '', children: [section], props: {} };
        collapseNoisySubtrees(root);

        const yaml = renderAriaTreeToYaml(root, true);
        const line = yaml.split('\n').find((l) => l.includes('[collapsed'));
        expect(line).toBeDefined();

        // Extract the preview between the last quote pair on the line.
        const previewMatch = line!.match(/"([^"]*)"\]/);
        expect(previewMatch).not.toBeNull();
        const preview = previewMatch![1];
        expect(preview.length).toBeLessThanOrEqual(43); // 40 cap + '...'
        expect(preview.endsWith('...')).toBe(true);
    });

    test('collapsed subtree without any text renders without a preview (no crash)', () => {
        const section = n(
            'contentinfo',
            '',
            Array.from({ length: 8 }, (_, i) => n('img', '', [], { alt: '' }, `e${i + 1}`))
        );
        const root: AriaNode = { role: 'fragment', name: '', children: [section], props: {} };
        collapseNoisySubtrees(root);

        const yaml = renderAriaTreeToYaml(root, true);
        const line = yaml.split('\n').find((l) => l.includes('[collapsed'));

        expect(line).toBeDefined();
        expect(line).toContain('[collapsed, 8 descendants]');
    });
});
