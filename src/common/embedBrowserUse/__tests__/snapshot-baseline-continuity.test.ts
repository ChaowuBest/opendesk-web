import { jest } from '@jest/globals';

/**
 * 回归测试（压测发现）：diff 快照的"上一棵树"是共享状态。
 *
 * 并发（或与 explore/导航/切标签交错）时，后到的请求会以别人刚写入的树为
 * 基准，输出被吞掉一部分的 diff，甚至 "(no changes)" —— 同一个瞬间两次
 * diff 结果自相矛盾。修复方式：请求在排队前记下基线世代号，锁内发现基线已
 * 被推进就退回完整快照；切换/关闭标签页、导航也会显式丢弃基线。
 *
 * 这里用 jest.unstable_mockModule 替换 captureSnapshot，直接控制每次抓取
 * 返回的页面内容。
 */

let currentLabel = 'A';
let currentUrl = 'https://example.com/same';

function makeTree(label: string) {
    return {
        role: 'generic',
        name: '',
        props: {},
        children: [{ role: 'button', name: label, props: {}, ref: 'e1', children: [] }]
    };
}

jest.unstable_mockModule('../cdp/snapshot.js', () => ({
    captureSnapshot: async () => ({
        url: currentUrl,
        title: 'T',
        viewport: { width: 800, height: 600 },
        scroll: { x: 0, y: 0 },
        ariaSnapshot: `- full:${currentLabel}`,
        tree: makeTree(currentLabel)
    }),
    resolveTargetCoords: () => ({ x: 0, y: 0 })
}));

const { BrowserController } = await import('../main.js');

function makeCtrl() {
    const win = {
        isDestroyed: () => false,
        focus: jest.fn(),
        webContents: { executeJavaScript: jest.fn(async () => ({ result: null })) }
    };
    const ctrl: any = new BrowserController('t-baseline', win as any, { beforeCallRenderer: [] });
    const session: any = {
        webContentsId: 5,
        webContents: { focus: jest.fn(), isDestroyed: () => false, isLoading: () => false },
        isHealthy: jest.fn(async () => true),
        waitForPageReady: jest.fn(async () => {}),
        waitForDOMStable: jest.fn(async () => {}),
        ensureDialogHandling: jest.fn(async () => {}),
        takeLastDialog: jest.fn(() => null),
        send: jest.fn(async () => ({ result: { value: undefined } }))
    };
    ctrl.requireCDP = jest.fn(async () => session);
    ctrl.getCDPSession = jest.fn(async () => session);
    ctrl.callRendererBrowser = jest.fn(async () => [{ id: 2, title: 'T', url: currentUrl, active: true }]);
    return ctrl;
}

describe('diff 快照基线一致性', () => {
    beforeEach(() => {
        currentLabel = 'A';
        currentUrl = 'https://example.com/same';
    });

    test('串行 diff 正常只返回变化部分', async () => {
        const ctrl = makeCtrl();
        const first = await ctrl.snapshot({ mode: 'diff' });
        expect(first.ariaSnapshot).toBe('- full:A');

        currentLabel = 'B';
        const second = await ctrl.snapshot({ mode: 'diff' });
        expect(second.ariaSnapshot).not.toBe('(no changes)');
        expect(second.ariaSnapshot).toContain('B');
        expect(second.ariaSnapshot).not.toContain('- full:');
    });

    test('并发 diff：后到者不会以别人刚写入的树为基准，退回完整快照', async () => {
        const ctrl = makeCtrl();
        await ctrl.snapshot({ mode: 'full' });
        currentLabel = 'B';

        const [r1, r2] = await Promise.all([ctrl.snapshot({ mode: 'diff' }), ctrl.snapshot({ mode: 'diff' })]);

        // 两个结果都必须能看到新内容：不能出现把变化吞掉的 "(no changes)"
        for (const result of [r1, r2]) {
            expect(result.ariaSnapshot).not.toBe('(no changes)');
            expect(result.ariaSnapshot).toContain('B');
        }
        // 后到者退回完整快照（带 full 标识），信息完整
        expect(r2.ariaSnapshot).toBe('- full:B');
    });

    test('切换标签页后基线作废：diff 不会拿别的标签页的树当基准', async () => {
        const ctrl = makeCtrl();
        await ctrl.snapshot({ mode: 'full' });
        currentLabel = 'B';

        await ctrl.tabs('switch', 2);

        const after = await ctrl.snapshot({ mode: 'diff' });
        expect(after.ariaSnapshot).toBe('- full:B');
        expect(ctrl.getLastUrl()).toBe(currentUrl);
    });

    test('关闭标签页同样作废基线', async () => {
        const ctrl = makeCtrl();
        await ctrl.snapshot({ mode: 'full' });
        currentLabel = 'B';

        await ctrl.tabs('close', 3);

        const after = await ctrl.snapshot({ mode: 'diff' });
        expect(after.ariaSnapshot).toBe('- full:B');
    });

    test('新建标签页同样作废基线', async () => {
        const ctrl = makeCtrl();
        await ctrl.snapshot({ mode: 'full' });
        currentLabel = 'B';

        await ctrl.tabs('new', undefined, 'https://example.com/other');

        const after = await ctrl.snapshot({ mode: 'diff' });
        expect(after.ariaSnapshot).toBe('- full:B');
    });

    test('list 不改变基线（没有切换活动标签）', async () => {
        const ctrl = makeCtrl();
        await ctrl.snapshot({ mode: 'full' });
        await ctrl.tabs('list');

        currentLabel = 'B';
        const after = await ctrl.snapshot({ mode: 'diff' });
        expect(after.ariaSnapshot).toContain('B');
        expect(after.ariaSnapshot).not.toContain('- full:');
    });
});
