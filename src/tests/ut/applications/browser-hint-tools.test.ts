import { jest } from '@jest/globals';
import {
    BrowserManager,
    collectSnapshotPrefix,
    renderSnapshotText,
    setSnapshotPrefixProvider
} from '../../../common/embedBrowserUse/main.js';
import { browserHintsSnapshotPrefixProvider } from '../../../main/applications/browser/hints.js';
import { BrowserSnapshotTool, BrowserTriggerTool } from '../../../main/applications/browser/tools.js';
import { getPluginHost } from '../../../main/applications/pluginmgr/runtime/host.js';
import { actionHint, definePlugin, textHint } from '../../../../packages/plugin-sdk/src/index.js';

/** 最小 BrowserController 替身：只实现 hint / trigger 链路真正用到的方法 */
function fakeController(options: {
    url: string;
    ariaSnapshot?: string;
    evaluate?: (expression: string) => unknown;
    /** 与 getPageInfo 返回的当前 URL 不同的"操作前"URL，用于模拟导航后 URL 变化 */
    urlBefore?: string;
}) {
    const evaluated: string[] = [];
    const switched: number[] = [];
    return {
        evaluated,
        switched,
        ctrl: {
            snapshot: async () => ({
                url: options.url,
                title: 'Fake Page',
                viewport: { width: 800, height: 600 },
                scroll: { x: 0, y: 0 },
                ariaSnapshot: options.ariaSnapshot ?? '- button "Go" [ref=e1]'
            }),
            getLastUrl: () => options.urlBefore ?? options.url,
            getPageInfo: async () => ({ url: options.url, title: 'Fake Page' }),
            tabs: async (_action: string, tabId?: number) => {
                if (tabId !== undefined) switched.push(tabId);
                return {};
            },
            evaluate: async (expression: string) => {
                evaluated.push(expression);
                return options.evaluate ? options.evaluate(expression) : null;
            }
        } as any
    };
}

const taskState = { task_id: 'task-hints' } as any;
const browserApp = {} as any;

/** 执行工具并取回其字符串结果（BaseTool.execute 返回 ToolResult 包装） */
async function runTool(
    tool: { execute(args: any, callback: undefined, taskState: unknown): Promise<{ result: string }> },
    args: unknown
): Promise<string> {
    const result = await tool.execute(args, undefined, taskState);
    return result.result;
}

describe('browser hints 接入 snapshot 与 trigger', () => {
    let restoreController: () => void;

    beforeEach(async () => {
        await getPluginHost().dispose();
    });

    afterEach(async () => {
        restoreController?.();
        await getPluginHost().dispose();
    });

    function useController(controller: any) {
        const spy = jest.spyOn(BrowserManager, 'getOrCreateController').mockReturnValue(controller);
        restoreController = () => spy.mockRestore();
    }

    async function activateSiteHints() {
        await getPluginHost().activate(
            definePlugin({
                id: 'site-hints-fixture',
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
            { origin: 'test:site-hints-fixture' }
        );
    }

    test('snapshot 在最前面注入 Browser Hints 段落', async () => {
        await activateSiteHints();
        const { ctrl } = fakeController({ url: 'https://www.bing.com/search?q=x' });
        useController(ctrl);

        const output = await runTool(new BrowserSnapshotTool(browserApp), { mode: 'full', viewportOnly: false });

        expect(output.startsWith('## Browser Hints')).toBe(true);
        expect(output).toContain('### Text Hints');
        expect(output).toContain('- Search in English only.');
        expect(output).toContain('### Action Hints');
        expect(output).toContain("should be invoked by the 'trigger' tool");
        expect(output).toContain('- Search(keyword): Fill the keyword and submit');
        // hint 段落必须位于原有快照信息之前
        expect(output.indexOf('## Browser Hints')).toBeLessThan(output.indexOf('- Page URL:'));
        expect(output).toContain('[Accessibility Snapshot]');
    });

    test('页面不匹配任何 urlPrefix 时快照不含 hint 段落', async () => {
        await activateSiteHints();
        const { ctrl } = fakeController({ url: 'https://example.com/' });
        useController(ctrl);

        const output = await runTool(new BrowserSnapshotTool(browserApp), { mode: 'full', viewportOnly: false });

        expect(output).not.toContain('Browser Hints');
        expect(output.startsWith('- Page URL: https://example.com/')).toBe(true);
    });

    test('trigger 在页面中 eval functionStr 后以 fn(args) 调用', async () => {
        await activateSiteHints();
        const { ctrl, evaluated } = fakeController({
            url: 'https://www.bing.com/',
            evaluate: () => ({ filled: 'OpenHarmony' })
        });
        useController(ctrl);

        const output = await runTool(new BrowserTriggerTool(browserApp), {
            action: 'Search',
            args: { keyword: 'OpenHarmony' },
            snapshot: false
        });

        expect(output).toBe(['- action: Search', '- result: {"filled":"OpenHarmony"}'].join('\n'));
        // eval 的是「函数源码 + fn(args) 调用」，参数经 JSON 序列化传入
        expect(evaluated).toHaveLength(1);
        expect(evaluated[0]).toContain('const fn = ((args) => ({ filled: args.keyword }));');
        expect(evaluated[0]).toContain('await fn({"keyword":"OpenHarmony"})');
    });

    test('trigger 复用 withSnapshot：snapshot=true 时追加快照与 hint', async () => {
        await activateSiteHints();
        const { ctrl } = fakeController({ url: 'https://www.bing.com/', evaluate: () => 'ok' });
        useController(ctrl);

        const output = await runTool(new BrowserTriggerTool(browserApp), {
            action: 'Search',
            args: { keyword: 'x' },
            snapshot: true
        });

        expect(output).toContain('- action: Search');
        expect(output).toContain('## Browser Hints');
        expect(output).toContain('[Accessibility Snapshot]');
    });

    test('snapshot=false 但 URL 发生变化时返回 Page Changed 提示', async () => {
        await activateSiteHints();
        // urlBefore 是操作前的 URL，url 是操作后跳转到的新 URL
        const { ctrl } = fakeController({
            url: 'https://www.bing.com/search?q=hi',
            urlBefore: 'https://www.bing.com/',
            evaluate: () => 'ok'
        });
        useController(ctrl);

        const output = await runTool(new BrowserTriggerTool(browserApp), {
            action: 'Search',
            args: { keyword: 'hi' },
            snapshot: false
        });

        expect(output).toContain('- action: Search');
        expect(output).toContain('Page Changed: yes (https://www.bing.com/ → https://www.bing.com/search?q=hi)');
        // 未请求 snapshot，不应包含 Accessibility Snapshot 段落
        expect(output).not.toContain('[Accessibility Snapshot]');
    });

    test('URL 未变化时不输出 Page Changed', async () => {
        await activateSiteHints();
        const { ctrl } = fakeController({ url: 'https://www.bing.com/', evaluate: () => 'ok' });
        useController(ctrl);

        const output = await runTool(new BrowserTriggerTool(browserApp), {
            action: 'Search',
            args: { keyword: 'x' },
            snapshot: false
        });

        expect(output).toBe(['- action: Search', '- result: ok'].join('\n'));
        expect(output).not.toContain('Page Changed');
    });

    test('trigger 指定 tabId 时先切换标签页再解析动作', async () => {
        await activateSiteHints();
        const { ctrl, switched } = fakeController({ url: 'https://www.bing.com/', evaluate: () => 'ok' });
        useController(ctrl);

        await runTool(new BrowserTriggerTool(browserApp), { action: 'Search', args: {}, tabId: 7, snapshot: false });

        expect(switched).toEqual([7]);
    });

    test('动作在当前页面不可用时返回失败并列出可用动作', async () => {
        await activateSiteHints();
        const { ctrl, evaluated } = fakeController({ url: 'https://www.bing.com/' });
        useController(ctrl);

        const output = await runTool(new BrowserTriggerTool(browserApp), {
            action: 'Unknown',
            args: {},
            snapshot: false
        });

        expect(JSON.parse(output)).toEqual({
            success: false,
            error: '动作 Unknown 在当前页面不可用。可用动作：Search(keyword)'
        });
        expect(evaluated).toEqual([]);
    });

    test('页面没有任何 Action Hint 时给出明确原因', async () => {
        await activateSiteHints();
        const { ctrl } = fakeController({ url: 'https://example.com/' });
        useController(ctrl);

        const output = await runTool(new BrowserTriggerTool(browserApp), {
            action: 'Search',
            args: {},
            snapshot: false
        });

        expect(JSON.parse(output).error).toContain('该页面没有任何 Action Hint');
    });

    test('页面动作执行抛错时 trigger 返回失败结果', async () => {
        await activateSiteHints();
        const { ctrl } = fakeController({
            url: 'https://www.bing.com/',
            evaluate: () => {
                throw new Error('search input not found on this page');
            }
        });
        useController(ctrl);

        const output = await runTool(new BrowserTriggerTool(browserApp), {
            action: 'Search',
            args: { keyword: 'x' },
            snapshot: false
        });

        expect(JSON.parse(output)).toEqual({
            success: false,
            error: 'search input not found on this page'
        });
    });

    test('没有任何插件注册 hint 时快照保持原有格式', async () => {
        const { ctrl } = fakeController({ url: 'https://www.bing.com/' });
        useController(ctrl);

        const output = await runTool(new BrowserSnapshotTool(browserApp), { mode: 'full', viewportOnly: false });

        expect(output).not.toContain('Browser Hints');
        expect(output.startsWith('- Page URL:')).toBe(true);
    });
});

describe('导出 Snapshot 带上 Browser Hints', () => {
    beforeEach(async () => {
        await getPluginHost().dispose();
    });

    afterEach(async () => {
        setSnapshotPrefixProvider(undefined);
        await getPluginHost().dispose();
    });

    /** 最小 CDPSession 替身：导出链路只用 send('Runtime.evaluate') */
    function fakeSession() {
        return { send: async () => ({ result: { value: '<html></html>' } }) } as any;
    }

    function pageSnapshot(url: string) {
        return {
            url,
            title: 'Bing',
            viewport: { width: 1280, height: 800 },
            scroll: { x: 0, y: 0 },
            ariaSnapshot: '- button "Search" [ref=e1]'
        };
    }

    /** 宿主导出链路的 hint 数据源：内联 fixture，与工具测试共用同一组 bing 提示 */
    async function activateHintFixture(origin: string) {
        await getPluginHost().activate(
            definePlugin({
                id: 'export-hint-fixture',
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
            { origin }
        );
    }

    test('注入 provider 后导出文本以 Browser Hints 开头，且与 snapshot 工具同格式', async () => {
        await activateHintFixture('test:export-hints');
        setSnapshotPrefixProvider(browserHintsSnapshotPrefixProvider);

        const snapshot = pageSnapshot('https://www.bing.com/search?q=x');
        const content = renderSnapshotText(snapshot, {
            prefixLines: await collectSnapshotPrefix(snapshot, fakeSession())
        });

        expect(content.startsWith('## Browser Hints')).toBe(true);
        expect(content).toContain('### Text Hints');
        expect(content).toContain('English');
        expect(content).toContain('### Action Hints');
        expect(content).toContain('- Search(keyword):');
        expect(content.indexOf('## Browser Hints')).toBeLessThan(content.indexOf('- Page URL:'));
        expect(content).toContain('[Accessibility Snapshot]');
    });

    test('页面不匹配任何 urlPrefix 时导出文本无 hint 段落', async () => {
        await activateHintFixture('test:export-hints-miss');
        setSnapshotPrefixProvider(browserHintsSnapshotPrefixProvider);

        const snapshot = pageSnapshot('https://example.com/');
        const content = renderSnapshotText(snapshot, {
            prefixLines: await collectSnapshotPrefix(snapshot, fakeSession())
        });

        expect(content).not.toContain('Browser Hints');
        expect(content.startsWith('- Page URL: https://example.com/')).toBe(true);
    });

    test('未注入 provider 时导出文本保持原有格式', async () => {
        await activateHintFixture('test:export-hints-noprovider');

        const snapshot = pageSnapshot('https://www.bing.com/');
        const content = renderSnapshotText(snapshot, {
            prefixLines: await collectSnapshotPrefix(snapshot, fakeSession())
        });

        expect(content).not.toContain('Browser Hints');
    });
});
