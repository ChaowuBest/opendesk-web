import { PluginHost } from '../../../main/applications/pluginmgr/runtime/host.js';
import {
    compileHintPattern,
    normalizeHintAddress
} from '../../../main/applications/pluginmgr/runtime/browser-hints.js';
import { actionHint, definePlugin, textHint } from '../../../../packages/plugin-sdk/src/index.js';
import type { BrowserContext } from '../../../../packages/plugin-sdk/src/index.js';

function context(url: string, overrides: Partial<BrowserContext> = {}): BrowserContext {
    const address = url.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
    return {
        url,
        domain: address.split(/[/?#]/)[0] ?? '',
        address,
        title: '',
        dom: async () => '',
        ...overrides
    };
}

describe('normalizeHintAddress', () => {
    test.each([
        ['https://www.bing.com/search', 'www.bing.com/search'],
        ['http://www.bing.com/', 'www.bing.com'],
        ['//www.bing.com', 'www.bing.com'],
        ['www.bing.com/search/', 'www.bing.com/search'],
        ['  https://a.b/c  ', 'a.b/c']
    ])('归一化去掉协议与尾部斜杠：%s', (input, expected) => {
        expect(normalizeHintAddress(input)).toBe(expected);
    });
});

describe('compileHintPattern 前缀模式（字符串不含通配符）', () => {
    test('前缀命中路径、query 与 hash 延伸', () => {
        expect(compileHintPattern('www.bing.com').matches('https://www.bing.com/search?q=x')).toBe(true);
        expect(compileHintPattern('www.bing.com/search').matches('https://www.bing.com/search?q=x')).toBe(true);
        expect(compileHintPattern('www.bing.com/search').matches('https://www.bing.com/search#top')).toBe(true);
        expect(compileHintPattern('https://www.bing.com').matches('https://www.bing.com/search?q=x')).toBe(true);
        expect(compileHintPattern('www.bing.com/search').matches('https://www.bing.com/maps')).toBe(false);
    });

    test('前缀必须结束在段边界，不误命中仿冒域名', () => {
        expect(compileHintPattern('www.bing.com').matches('https://www.bing.com.evil.com/')).toBe(false);
        expect(compileHintPattern('www.bing.com/search').matches('https://www.bing.com/searchx')).toBe(false);
    });

    test('空 pattern 抛错', () => {
        expect(() => compileHintPattern('  ')).toThrow('plugin.browser_hint_url_prefix_invalid');
    });
});

describe('compileHintPattern 通配符模式（字符串含 *）', () => {
    test('* 匹配单段，不跨 /', () => {
        const pattern = compileHintPattern('www.example.com/repo/*/issues');
        expect(pattern.matches('https://www.example.com/repo/123/issues')).toBe(true);
        expect(pattern.matches('https://www.example.com/repo/a/b/issues')).toBe(false);
    });

    test('含通配符时整体锚定路径，不误匹配深路径', () => {
        const pattern = compileHintPattern('www.example.com/repo/*');
        expect(pattern.matches('https://www.example.com/repo/open')).toBe(true);
        expect(pattern.matches('https://www.example.com/repo/open/pulls')).toBe(false);
    });

    test('query 与 hash 不参与通配符匹配', () => {
        const pattern = compileHintPattern('www.example.com/repo/*');
        expect(pattern.matches('https://www.example.com/repo/open?tab=readme')).toBe(true);
        expect(pattern.matches('https://www.example.com/repo/open#readme')).toBe(true);
    });

    test('** 跨任意段，可与 * 组合', () => {
        const pattern = compileHintPattern('*.example.com/docs/**/search/*');
        expect(pattern.matches('https://a.example.com/docs/search/kw')).toBe(true);
        expect(pattern.matches('https://a.example.com/docs/guide/start/search/kw')).toBe(true);
        expect(pattern.matches('https://a.example.com/api/docs/search/kw')).toBe(false);
    });

    test('正则元字符按字面处理', () => {
        const pattern = compileHintPattern('www.example.com/file.php?id=*');
        expect(pattern.matches('https://www.example.com/file.php?id=1')).toBe(true);
        expect(pattern.matches('https://www.example.com/filexphp?id=1')).toBe(false);
    });

    test('display 保留归一化后的 pattern', () => {
        expect(compileHintPattern('https://www.example.com/repo/*/issues/').display).toBe(
            'www.example.com/repo/*/issues'
        );
    });
});

describe('compileHintPattern 正则模式（RegExp 实例）', () => {
    test('对归一化后的完整地址整体匹配', () => {
        const pattern = compileHintPattern(/^www\.example\.com\/(user|org)\/\d+$/);
        expect(pattern.matches('https://www.example.com/user/42')).toBe(true);
        expect(pattern.matches('https://www.example.com/user/abc')).toBe(false);
    });

    test('g/y 标志不产生 lastIndex 残留', () => {
        const pattern = compileHintPattern(/open/g);
        expect(pattern.matches('https://a.com/open')).toBe(true);
        expect(pattern.matches('https://a.com/open')).toBe(true);
        expect(pattern.matches('https://a.com/closed')).toBe(false);
    });

    test('display 为 RegExp 字面量形式', () => {
        expect(compileHintPattern(/^a.+$/gi).display).toBe('/^a.+$/gi');
    });
});

describe('PluginHost browser capability', () => {
    test('注册 hint 生成器并按 urlPrefix 聚合命中结果', async () => {
        const host = new PluginHost();
        const entry = await host.activate(
            definePlugin({
                id: 'bing-helper',
                capabilities: ['browser'],
                setup(ctx) {
                    ctx.browser.hint.register('www.bing.com', () => [textHint('Search in English only.')]);
                    ctx.browser.hint.register('www.xiaohongshu.com', () => [
                        actionHint('Search', 'Search notes', { keyword: 'keyword' }, '(a) => a.keyword')
                    ]);
                }
            }),
            { origin: 'test:bing-helper' }
        );

        expect(entry.status).toBe('active');
        expect(entry.capabilities).toContain('browser');
        expect(host.listBrowserHintPrefixes()).toEqual([
            { pluginId: 'bing-helper', urlPrefix: 'www.bing.com' },
            { pluginId: 'bing-helper', urlPrefix: 'www.xiaohongshu.com' }
        ]);

        expect(await host.getBrowserHints(context('https://www.bing.com/search?q=x'))).toEqual([
            { kind: 'text', content: 'Search in English only.' }
        ]);
        const xhs = await host.getBrowserHints(context('https://www.xiaohongshu.com/explore'));
        expect(xhs).toEqual([
            {
                kind: 'action',
                name: 'Search',
                description: 'Search notes',
                args: { keyword: 'keyword' },
                functionStr: '(a) => a.keyword'
            }
        ]);
        expect(await host.getBrowserHints(context('https://example.com'))).toEqual([]);
    });

    test('未声明 browser capability 时注册失败', async () => {
        const host = new PluginHost();
        const entry = await host.activate(
            definePlugin({
                id: 'no-browser-cap',
                capabilities: ['tool'],
                setup(ctx) {
                    ctx.browser.hint.register('example.com', () => []);
                }
            }),
            { origin: 'test:no-browser-cap' }
        );

        expect(entry.status).toBe('error');
        expect(entry.diagnostics).toContainEqual(
            expect.objectContaining({ code: 'plugin.setup_failed', detail: 'plugin.capability_not_declared:browser' })
        );
        expect(host.listBrowserHintPrefixes()).toEqual([]);
    });

    test.each([
        [
            '空 urlPrefix',
            (ctx: any) => ctx.browser.hint.register('  ', () => []),
            'plugin.browser_hint_url_prefix_invalid'
        ],
        [
            '生成器不是函数',
            (ctx: any) => ctx.browser.hint.register('example.com', 'nope'),
            'plugin.browser_hint_generator_invalid:example.com'
        ]
    ])('启用阶段拒绝无效的 hint 注册：%s', async (_name, register, expectedError) => {
        const host = new PluginHost();
        const entry = await host.activate(
            definePlugin({
                id: 'invalid-hint',
                capabilities: ['browser'],
                setup(ctx) {
                    register(ctx);
                }
            }),
            { origin: 'test:invalid-hint' }
        );

        expect(entry.status).toBe('error');
        expect(entry.diagnostics).toContainEqual(
            expect.objectContaining({ code: 'plugin.setup_failed', detail: expectedError })
        );
    });

    test('支持通配符与 RegExp pattern 注册', async () => {
        const host = new PluginHost();
        const entry = await host.activate(
            definePlugin({
                id: 'pattern-hints',
                capabilities: ['browser'],
                setup(ctx) {
                    ctx.browser.hint.register('www.example.com/repo/*/issues', () => [textHint('issues page')]);
                    ctx.browser.hint.register(/^www\.example\.com\/wiki(\/.*)?$/, () => [textHint('wiki page')]);
                }
            }),
            { origin: 'test:pattern-hints' }
        );

        expect(entry.status).toBe('active');
        expect(host.listBrowserHintPrefixes()).toEqual([
            { pluginId: 'pattern-hints', urlPrefix: 'www.example.com/repo/*/issues' },
            { pluginId: 'pattern-hints', urlPrefix: String(/^www\.example\.com\/wiki(\/.*)?$/) }
        ]);
        expect(await host.getBrowserHints(context('https://www.example.com/repo/9/issues'))).toEqual([
            { kind: 'text', content: 'issues page' }
        ]);
        expect(await host.getBrowserHints(context('https://www.example.com/repo/9/issues?tab=all'))).toEqual([
            { kind: 'text', content: 'issues page' }
        ]);
        expect(await host.getBrowserHints(context('https://www.example.com/repo/9/pulls'))).toEqual([]);
        expect(await host.getBrowserHints(context('https://www.example.com/wiki'))).toEqual([
            { kind: 'text', content: 'wiki page' }
        ]);
        expect(await host.getBrowserHints(context('https://www.example.com/wiki/Start'))).toEqual([
            { kind: 'text', content: 'wiki page' }
        ]);
    });

    test('生成器抛错或返回非法 hint 时记录诊断且不影响其他插件', async () => {
        const host = new PluginHost();
        await host.activate(
            definePlugin({
                id: 'broken-hint',
                capabilities: ['browser'],
                setup(ctx) {
                    ctx.browser.hint.register('example.com', () => {
                        throw new Error('boom');
                    });
                    ctx.browser.hint.register('example.com', () => [{ kind: 'text', content: '  ' } as any]);
                }
            }),
            { origin: 'test:broken-hint' }
        );
        await host.activate(
            definePlugin({
                id: 'good-hint',
                capabilities: ['browser'],
                setup(ctx) {
                    ctx.browser.hint.register('example.com', () => [textHint('still works')]);
                }
            }),
            { origin: 'test:good-hint' }
        );

        expect(await host.getBrowserHints(context('https://example.com/a'))).toEqual([
            { kind: 'text', content: 'still works' }
        ]);
        expect(host.get('broken-hint')?.diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ code: 'plugin.browser_hint_failed', detail: 'boom' }),
                expect.objectContaining({
                    code: 'plugin.browser_hint_failed',
                    detail: 'plugin.browser_hint_text_content_invalid'
                })
            ])
        );
    });

    test('生成器支持异步并可按需读取 DOM', async () => {
        const host = new PluginHost();
        await host.activate(
            definePlugin({
                id: 'async-hint',
                capabilities: ['browser'],
                setup(ctx) {
                    ctx.browser.hint.register('example.com', async (browserContext) => {
                        const dom = await browserContext.dom();
                        return dom.includes('needle') ? [textHint('found')] : [];
                    });
                }
            }),
            { origin: 'test:async-hint' }
        );

        expect(
            await host.getBrowserHints(context('https://example.com', { dom: async () => '<html>needle</html>' }))
        ).toEqual([{ kind: 'text', content: 'found' }]);
        expect(
            await host.getBrowserHints(context('https://example.com', { dom: async () => '<html></html>' }))
        ).toEqual([]);
    });

    test('停用插件后其 hint 不再参与聚合', async () => {
        const host = new PluginHost();
        await host.activate(
            definePlugin({
                id: 'disposable-hint',
                capabilities: ['browser'],
                setup(ctx) {
                    ctx.browser.hint.register('example.com', () => [textHint('temporary')]);
                }
            }),
            { origin: 'test:disposable-hint' }
        );
        expect(await host.getBrowserHints(context('https://example.com'))).toHaveLength(1);

        await host.deactivate('disposable-hint');
        expect(host.listBrowserHintPrefixes()).toEqual([]);
        expect(await host.getBrowserHints(context('https://example.com'))).toEqual([]);
    });
});
