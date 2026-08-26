import { PluginHost } from '../../../main/applications/pluginmgr/runtime/host.js';
import {
    matchesHintUrlPrefix,
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

describe('normalizeHintAddress / matchesHintUrlPrefix', () => {
    test.each([
        ['https://www.bing.com/search', 'www.bing.com/search'],
        ['http://www.bing.com/', 'www.bing.com'],
        ['//www.bing.com', 'www.bing.com'],
        ['www.bing.com/search/', 'www.bing.com/search'],
        ['  https://a.b/c  ', 'a.b/c']
    ])('归一化去掉协议与尾部斜杠：%s', (input, expected) => {
        expect(normalizeHintAddress(input)).toBe(expected);
    });

    test('前缀匹配忽略协议差异', () => {
        expect(matchesHintUrlPrefix('https://www.bing.com/search?q=x', 'www.bing.com/search')).toBe(true);
        expect(matchesHintUrlPrefix('https://www.bing.com/search?q=x', 'https://www.bing.com')).toBe(true);
        expect(matchesHintUrlPrefix('https://www.bing.com/maps', 'www.bing.com/search')).toBe(false);
    });

    test('空前缀不匹配任何页面', () => {
        expect(matchesHintUrlPrefix('https://www.bing.com', '')).toBe(false);
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
