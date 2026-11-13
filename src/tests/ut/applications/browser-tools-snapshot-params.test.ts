import { jest } from '@jest/globals';
import { BrowserManager } from '../../../common/embedBrowserUse/main.js';
import {
    BrowserClickTool,
    BrowserGoForwardTool,
    BrowserNavigateTool,
    BrowserReloadTool,
    BrowserTabsTool
} from '../../../main/applications/browser/tools.js';

/**
 * use-browser 压测报告回归测试（工具层）：
 *  - BUG-07：reload/goForward 的 snapshot 参数此前被整体丢弃，现在与 navigate
 *    一致地走 withSnapshot；
 *  - BUG-14：click 打开新标签页时原页面并未变化，Page Changed 与 newTab 语义
 *    冲突，现在有 newTab 时不再输出 Page Changed。
 */

const taskState = { task_id: 'task-tools-params' } as any;
const browserApp = {} as any;

/** 最小 BrowserController 替身 */
function fakeController(options: { url: string; urlBefore?: string; newTab?: Record<string, unknown> | null }) {
    return {
        goForward: jest.fn(async () => ({ url: options.url, title: 'Forwarded' })),
        reload: jest.fn(async () => ({ url: options.url, title: 'Reloaded' })),
        click: jest.fn(async () => ({
            target: 'e1',
            tag: 'a',
            text: 'link',
            newTab: options.newTab ?? null
        })),
        getLastUrl: () => options.urlBefore ?? options.url,
        getPageInfo: jest.fn(async () => ({ url: options.url, title: 'T' })),
        snapshot: jest.fn(async () => ({
            url: options.url,
            title: 'T',
            viewport: { width: 800, height: 600 },
            scroll: { x: 0, y: 0 },
            ariaSnapshot: '- button "Go" [ref=e1]'
        }))
    } as any;
}

function useController(controller: any): () => void {
    const spy = jest.spyOn(BrowserManager, 'getOrCreateController').mockReturnValue(controller);
    return () => spy.mockRestore();
}

async function runTool(
    tool: { execute(args: any, callback: undefined, taskState: unknown): Promise<{ result: string }> },
    args: unknown
): Promise<string> {
    const result = await tool.execute(args, undefined, taskState);
    return result.result;
}

describe('BUG-07: reload/goForward 的 snapshot 参数生效', () => {
    test('reload({ snapshot: true }) 返回快照而不是只有 url/title', async () => {
        const ctrl = fakeController({ url: 'https://example.com/after-reload' });
        const restore = useController(ctrl);

        try {
            const output = await runTool(new BrowserReloadTool(browserApp), { snapshot: true });
            expect(output).toContain('- url: https://example.com/after-reload');
            expect(output).toContain('[Accessibility Snapshot]');
            expect(output).toContain('[ref=e1]');
        } finally {
            restore();
        }
    });

    test('reload({ snapshot: false }) 不追加快照', async () => {
        const ctrl = fakeController({ url: 'https://example.com/after-reload' });
        const restore = useController(ctrl);

        try {
            const output = await runTool(new BrowserReloadTool(browserApp), { snapshot: false });
            expect(output).toContain('- url: https://example.com/after-reload');
            expect(output).not.toContain('[Accessibility Snapshot]');
        } finally {
            restore();
        }
    });

    test('goForward({ snapshot: true }) 返回快照', async () => {
        const ctrl = fakeController({ url: 'https://example.com/forwarded' });
        const restore = useController(ctrl);

        try {
            const output = await runTool(new BrowserGoForwardTool(browserApp), { snapshot: true });
            expect(output).toContain('- url: https://example.com/forwarded');
            expect(output).toContain('[Accessibility Snapshot]');
        } finally {
            restore();
        }
    });
});

describe('BUG-14: newTab 场景不再输出冲突的 Page Changed', () => {
    test('click 打开新标签页时不输出 Page Changed（原页面未变）', async () => {
        const ctrl = fakeController({
            url: 'https://new.example.com/frame-target.html',
            urlBefore: 'https://example.com/index.html',
            newTab: { id: 3, title: 'Frame Target', url: 'https://new.example.com/frame-target.html' }
        });
        const restore = useController(ctrl);

        try {
            const output = await runTool(new BrowserClickTool(browserApp), {
                target: 'e1',
                snapshot: true
            });
            expect(output).toContain('newTab');
            expect(output).not.toContain('Page Changed');
        } finally {
            restore();
        }
    });

    test('同页导航（无 newTab）仍输出 Page Changed', async () => {
        const ctrl = fakeController({
            url: 'https://example.com/after-click',
            urlBefore: 'https://example.com/index.html',
            newTab: null
        });
        const restore = useController(ctrl);

        try {
            const output = await runTool(new BrowserClickTool(browserApp), {
                target: 'e1',
                snapshot: false
            });
            expect(output).toContain(
                'Page Changed: yes (https://example.com/index.html → https://example.com/after-click)'
            );
        } finally {
            restore();
        }
    });
});

describe('tabs 工具的 Page Changed 抑制（压测发现）', () => {
    /** tabs 只切换活动标签页，基线 URL 属于上一个标签，不应报 Page Changed */
    function makeTabsController(before: string, after: string) {
        const ctrl = fakeController({ url: after, urlBefore: before });
        (ctrl as any).tabs = jest.fn(async () => ({
            tabs: [{ id: 2, title: 'T', url: after, active: true }]
        }));
        return ctrl;
    }

    test('tabs list 不输出 Page Changed', async () => {
        const ctrl = makeTabsController('https://example.com/frame1.html', 'https://example.com/index.html');
        const restore = useController(ctrl);

        try {
            const output = await runTool(new BrowserTabsTool(browserApp), { action: 'list', snapshot: false });
            expect(output).toContain('- tabs:');
            expect(output).not.toContain('Page Changed');
        } finally {
            restore();
        }
    });

    test('tabs close 不输出 Page Changed', async () => {
        const ctrl = makeTabsController('https://example.com/index.html', 'about:blank');
        (ctrl as any).tabs = jest.fn(async () => ({ closed: 2 }));
        const restore = useController(ctrl);

        try {
            const output = await runTool(new BrowserTabsTool(browserApp), {
                action: 'close',
                tabId: 2,
                snapshot: false
            });
            expect(output).toContain('- closed: 2');
            expect(output).not.toContain('Page Changed');
        } finally {
            restore();
        }
    });

    test('tabs switch 不输出 Page Changed', async () => {
        const ctrl = makeTabsController('https://example.com/a.html', 'https://example.com/b.html');
        (ctrl as any).tabs = jest.fn(async () => ({ switched: 4 }));
        const restore = useController(ctrl);

        try {
            const output = await runTool(new BrowserTabsTool(browserApp), {
                action: 'switch',
                tabId: 4,
                snapshot: false
            });
            expect(output).toContain('- switched: 4');
            expect(output).not.toContain('Page Changed');
        } finally {
            restore();
        }
    });
});

describe('navigate 的 note 透传（压测发现）', () => {
    test('controller 判定"导航未发生"时把 note 输出给 agent', async () => {
        const ctrl = fakeController({ url: 'https://example.com/current' });
        (ctrl as any).navigate = jest.fn(async () => ({
            url: 'https://example.com/current',
            title: 'T',
            note: '导航未发生：页面仍停留在 https://example.com/current。目标地址可能触发了文件下载…'
        }));
        const restore = useController(ctrl);

        try {
            const output = await runTool(new BrowserNavigateTool(browserApp), {
                url: 'https://example.com/file.zip',
                newTab: false,
                snapshot: false
            });
            expect(output).toContain('- note: 导航未发生');
        } finally {
            restore();
        }
    });

    test('正常导航不带 note', async () => {
        const ctrl = fakeController({ url: 'https://example.com/next' });
        (ctrl as any).navigate = jest.fn(async () => ({
            url: 'https://example.com/next',
            title: 'Next'
        }));
        const restore = useController(ctrl);

        try {
            const output = await runTool(new BrowserNavigateTool(browserApp), {
                url: 'https://example.com/next',
                newTab: false,
                snapshot: false
            });
            expect(output).not.toContain('- note:');
        } finally {
            restore();
        }
    });
});
