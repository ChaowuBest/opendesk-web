import {
    buildBrowserContext,
    collectBrowserHintSummaries,
    makeActionInvokeExpression,
    renderBrowserHints,
    summarizeBrowserHints
} from '../../../main/applications/browser/hints.js';
import { actionHint, definePlugin, textHint } from '../../../../packages/plugin-sdk/src/index.js';
import { getPluginHost } from '../../../main/applications/pluginmgr/runtime/host.js';

describe('renderBrowserHints', () => {
    test('无 hint 时不产生任何前缀', () => {
        expect(renderBrowserHints([])).toEqual([]);
    });

    test('只有 text hint 时不输出 Action Hints 小节', () => {
        const lines = renderBrowserHints([textHint('Search in English only.')]);
        expect(lines.join('\n')).toBe(
            ['## Browser Hints', '', '### Text Hints', '', '- Search in English only.', ''].join('\n')
        );
    });

    test('只有 action hint 时不输出 Text Hints 小节，并说明须用 trigger 调用', () => {
        const lines = renderBrowserHints([
            actionHint('Search', 'Search notes by keyword', { keyword: '搜索关键词' }, '(a) => a')
        ]);
        expect(lines.join('\n')).toBe(
            [
                '## Browser Hints',
                '',
                '### Action Hints',
                '',
                "Actions are only available in this page and should be invoked by the 'trigger' tool.",
                '',
                '- Search(keyword): Search notes by keyword',
                '  - keyword: 搜索关键词',
                ''
            ].join('\n')
        );
    });

    test('两类 hint 同时存在时按 Text → Action 顺序分类输出', () => {
        const lines = renderBrowserHints([
            actionHint('Search', 'Search notes', { keyword: 'kw' }, '(a) => a'),
            textHint('Only English keywords.')
        ]).join('\n');
        expect(lines.indexOf('### Text Hints')).toBeGreaterThan(-1);
        expect(lines.indexOf('### Text Hints')).toBeLessThan(lines.indexOf('### Action Hints'));
        expect(lines).toContain('- Only English keywords.');
        expect(lines).toContain('- Search(keyword): Search notes');
    });

    test('无参数的 action 渲染为空参数列表', () => {
        expect(renderBrowserHints([actionHint('Refresh', 'Reload feed', {}, '() => 1')]).join('\n')).toContain(
            '- Refresh(): Reload feed'
        );
    });
});

describe('makeActionInvokeExpression', () => {
    test('先 eval 函数源码再以 fn(args) 调用，并做 JSON 往返', () => {
        const expression = makeActionInvokeExpression(
            actionHint('Search', 'Search', { keyword: 'kw' }, '(a) => a.keyword'),
            { keyword: 'OpenHarmony' }
        );
        expect(expression).toContain('const fn = ((a) => a.keyword);');
        expect(expression).toContain('await fn({"keyword":"OpenHarmony"})');
    });

    test('生成的表达式可在真实 JS 环境中求值并拿到返回值', async () => {
        const expression = makeActionInvokeExpression(
            actionHint('Search', 'Search', { keyword: 'kw' }, '(args) => ({ filled: args.keyword, submitted: true })'),
            { keyword: 'OpenDesk' }
        );

        await expect(eval(expression)).resolves.toEqual({ filled: 'OpenDesk', submitted: true });
    });

    test('返回 undefined 时归一化为 null', async () => {
        const expression = makeActionInvokeExpression(actionHint('Noop', 'noop', {}, '() => undefined'), {});

        await expect(eval(expression)).resolves.toBeNull();
    });

    test('参数含引号等特殊字符时不会破坏表达式', async () => {
        const expression = makeActionInvokeExpression(actionHint('Echo', 'echo', { text: 't' }, '(a) => a.text'), {
            text: `it's "quoted" \\ and </script>`
        });

        await expect(eval(expression)).resolves.toBe(`it's "quoted" \\ and </script>`);
    });

    test('页面动作抛错时表达式 reject，便于工具层转成失败结果', async () => {
        const expression = makeActionInvokeExpression(
            actionHint('Broken', 'broken', {}, '() => { throw new Error("no search box"); }'),
            {}
        );

        await expect(eval(expression)).rejects.toThrow('no search box');
    });
});

describe('buildBrowserContext', () => {
    function evaluator(dom = '<html></html>') {
        const calls: string[] = [];
        return {
            calls,
            evaluate: async (expression: string) => {
                calls.push(expression);
                return dom;
            }
        };
    }

    test('从 URL 推导 domain 与去协议的 address', () => {
        const { evaluate } = evaluator();
        const context = buildBrowserContext(evaluate, {
            url: 'https://www.xiaohongshu.com/explore?type=video',
            title: '发现'
        });
        expect(context.url).toBe('https://www.xiaohongshu.com/explore?type=video');
        expect(context.domain).toBe('www.xiaohongshu.com');
        expect(context.address).toBe('www.xiaohongshu.com/explore?type=video');
        expect(context.title).toBe('发现');
    });

    test('不调用 dom() 时不产生任何页面通信', () => {
        const { evaluate, calls } = evaluator();
        buildBrowserContext(evaluate, { url: 'https://example.com' });
        expect(calls).toEqual([]);
    });

    test('dom() 按需拉取且多次调用只求值一次', async () => {
        const { evaluate, calls } = evaluator('<html>needle</html>');
        const context = buildBrowserContext(evaluate, { url: 'https://example.com' });
        await expect(context.dom()).resolves.toBe('<html>needle</html>');
        await expect(context.dom()).resolves.toBe('<html>needle</html>');
        expect(calls).toHaveLength(1);
        expect(calls[0]).toContain('outerHTML');
    });
});

describe('summarizeBrowserHints', () => {
    test('text hint 摘要只保留内容', () => {
        expect(summarizeBrowserHints([textHint('Search in English only.')])).toEqual([
            { kind: 'text', content: 'Search in English only.' }
        ]);
    });

    test('action hint 摘要保留签名、描述与参数，且剥离 functionStr', () => {
        const summaries = summarizeBrowserHints([
            actionHint('Search', 'Fill the keyword and submit', { keyword: 'The keyword' }, '(args) => args')
        ]);
        expect(summaries).toEqual([
            {
                kind: 'action',
                name: 'Search',
                signature: 'Search(keyword)',
                description: 'Fill the keyword and submit',
                args: { keyword: 'The keyword' }
            }
        ]);
        expect(JSON.stringify(summaries)).not.toContain('functionStr');
        expect(JSON.stringify(summaries)).not.toContain('(args) => args');
    });

    test('无参数 action 的签名为空参数列表', () => {
        const summaries = summarizeBrowserHints([actionHint('Refresh', 'Reload feed', {}, '() => 1')]);
        expect(summaries[0]).toMatchObject({ kind: 'action', signature: 'Refresh()' });
    });
});

describe('collectBrowserHintSummaries', () => {
    function evaluator(dom = '<html></html>') {
        const calls: string[] = [];
        return {
            calls,
            evaluate: async (expression: string) => {
                calls.push(expression);
                return dom;
            }
        };
    }

    async function activateSiteHints() {
        await getPluginHost().activate(
            definePlugin({
                id: 'hint-summaries-fixture',
                capabilities: ['browser'],
                setup(ctx) {
                    ctx.browser.hint.register('www.bing.com', () => [
                        textHint('Search in English only.'),
                        actionHint(
                            'Search',
                            'Fill the keyword and submit',
                            { keyword: 'The keyword' },
                            '(args) => ({ filled: args.keyword })'
                        )
                    ]);
                }
            }),
            { origin: 'test:hint-summaries-fixture' }
        );
    }

    beforeEach(async () => {
        await getPluginHost().dispose();
    });

    afterEach(async () => {
        await getPluginHost().dispose();
    });

    test('汇总当前页面命中的 hint 摘要，供地址栏面板展示', async () => {
        await activateSiteHints();
        const { evaluate } = evaluator();
        const summaries = await collectBrowserHintSummaries(evaluate, { url: 'https://www.bing.com/search?q=x' });

        expect(summaries).toEqual([
            { kind: 'text', content: 'Search in English only.' },
            {
                kind: 'action',
                name: 'Search',
                signature: 'Search(keyword)',
                description: 'Fill the keyword and submit',
                args: { keyword: 'The keyword' }
            }
        ]);
    });

    test('依赖 dom() 的生成器通过页面求值器读取真实 DOM', async () => {
        await getPluginHost().activate(
            definePlugin({
                id: 'hint-dom-fixture',
                capabilities: ['browser'],
                setup(ctx) {
                    ctx.browser.hint.register('example.com', async (context) => {
                        const dom = await context.dom();
                        return [textHint(`dom has needle: ${dom.includes('needle')}`)];
                    });
                }
            }),
            { origin: 'test:hint-dom-fixture' }
        );
        const { evaluate, calls } = evaluator('<html>needle</html>');
        const summaries = await collectBrowserHintSummaries(evaluate, { url: 'https://example.com/list' });

        expect(summaries).toEqual([{ kind: 'text', content: 'dom has needle: true' }]);
        expect(calls.some((expression) => expression.includes('outerHTML'))).toBe(true);
    });

    test('页面不匹配任何 hint 时返回空数组', async () => {
        await activateSiteHints();
        const { evaluate } = evaluator();
        await expect(collectBrowserHintSummaries(evaluate, { url: 'https://example.com/other' })).resolves.toEqual([]);
    });

    test('空 URL 直接返回空数组，不做任何页面通信', async () => {
        const { evaluate, calls } = evaluator();
        await expect(collectBrowserHintSummaries(evaluate, { url: '' })).resolves.toEqual([]);
        expect(calls).toEqual([]);
    });
});
